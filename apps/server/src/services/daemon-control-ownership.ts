import { Effect, Predicate } from 'effect';
import type { Kysely } from 'kysely';
import { tryDatabaseTransactionPromise, withDatabaseTransaction } from '../db/transaction';
import type { DatabaseSchema } from '../db/types';
import { type InfrastructureError, infrastructureError } from './errors';
import type {
  ClaimDaemonOnlineResult,
  DaemonPresence,
  RealtimeCoordinationService,
} from './realtime-coordination-service';
import type { RedisError, RedisService } from './redis-service';

/** The write lock serializes the Redis claim and its SQL owner with unlinking. */
export const fenceDaemonRegistration = Effect.fnUntraced(function* (
  db: Kysely<DatabaseSchema>,
  coordination: RealtimeCoordinationService,
  input: {
    readonly daemonId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly daemonBindingJson: string;
  },
  acquire: Effect.Effect<ClaimDaemonOnlineResult, RedisError>,
) {
  return yield* withDatabaseTransaction(db, (trx) =>
    Effect.gen(function* () {
      const daemon = yield* tryDatabaseTransactionPromise({
        try: () =>
          trx
            .selectFrom('daemons')
            .innerJoin('users', 'users.id', 'daemons.user_id')
            .select('users.root_epoch')
            .where('daemons.id', '=', input.daemonId)
            .where('daemons.user_id', '=', input.userId)
            .where('daemons.daemon_binding_json', '=', input.daemonBindingJson)
            .executeTakeFirst(),
        catch: infrastructureError('daemon-control', 'fence-registration'),
      });
      if (daemon === undefined)
        return yield* infrastructureError(
          'daemon-control',
          'daemon-unlinked',
        )(new Error('Daemon is no longer linked'));
      const claimed = yield* acquire;
      if (Predicate.isTagged(claimed, 'Superseded')) return claimed;
      const presence = yield* coordination.getDaemonPresence(input.daemonId);
      if (
        presence === null ||
        presence.connectionId !== input.connectionId ||
        presence.userId !== input.userId
      ) {
        return yield* infrastructureError(
          'daemon-control',
          'record-ownership',
        )(new Error('Control claim is no longer owned'));
      }
      const ownership = {
        daemon_id: input.daemonId,
        user_id: input.userId,
        connection_id: presence.connectionId,
        owner_instance_id: presence.ownerInstanceId,
        presence_id: presence.presenceId,
        claim_seq: presence.claimSeq,
        root_epoch: daemon.root_epoch,
      };
      yield* tryDatabaseTransactionPromise({
        try: () =>
          trx
            .insertInto('daemon_control_owners')
            .values(ownership)
            .onConflict((conflict) => conflict.column('daemon_id').doUpdateSet(ownership))
            .execute(),
        catch: infrastructureError('daemon-control', 'record-ownership'),
      });
      return claimed;
    }),
  );
});

export const deliverDaemonUnlinks = Effect.fnUntraced(function* (
  db: Kysely<DatabaseSchema>,
  redis: RedisService,
  retire: (
    presence: DaemonPresence,
    generation: number | null,
  ) => Effect.Effect<boolean, RedisError | InfrastructureError>,
  coordination: Pick<RealtimeCoordinationService, 'getDaemonPresence'>,
  daemonId: string,
) {
  const pending = yield* Effect.tryPromise({
    try: () =>
      db.selectFrom('daemon_unlinks').selectAll().where('daemon_id', '=', daemonId).execute(),
    catch: infrastructureError('daemon-control', 'pending-unlinks'),
  });
  let remaining = false;
  for (const row of pending) {
    let generation: number | null = null;
    // The reset's atomic epoch marker proves its generation has been allocated.
    // The owner sends that generation before closing the old control socket.
    const currentOwner = yield* coordination.getDaemonPresence(row.daemon_id);
    const ownerGone =
      currentOwner === null ||
      currentOwner.userId !== row.user_id ||
      currentOwner.connectionId !== row.connection_id ||
      currentOwner.ownerInstanceId !== row.owner_instance_id ||
      currentOwner.presenceId !== row.presence_id ||
      currentOwner.claimSeq !== row.claim_seq;
    if (row.root_epoch > 0 && !ownerGone) {
      const [applied, current] = yield* redis.useCommands((commands) =>
        Promise.all([
          commands.sendCommand<string | null>([
            'GET',
            `merkur:auth:reset-revocation:${row.user_id}`,
          ]),
          commands.sendCommand<string | null>(['GET', `merkur:auth:revocation:${row.user_id}`]),
        ]),
      );
      if (applied === null || applied === undefined) {
        remaining = true;
        continue;
      }
      if (
        !Number.isSafeInteger(Number(applied)) ||
        current === null ||
        !Number.isSafeInteger(Number(current))
      ) {
        return yield* new RedisError({ cause: null, message: 'Invalid reset revocation state' });
      }
      if (Number(applied) < row.root_epoch) {
        remaining = true;
        continue;
      }
      generation = Number(current);
    }
    const retired = yield* retire(
      {
        daemonId: row.daemon_id,
        userId: row.user_id,
        ownerInstanceId: row.owner_instance_id,
        connectionId: row.connection_id,
        presenceId: row.presence_id,
        claimSeq: row.claim_seq,
        state: 'online',
        updatedAt: 0,
        zone: null,
      },
      generation,
    );
    if (!retired) remaining = true;
    if (retired)
      yield* Effect.tryPromise({
        try: () =>
          db.deleteFrom('daemon_unlinks').where('connection_id', '=', row.connection_id).execute(),
        catch: infrastructureError('daemon-control', 'acknowledge-unlink'),
      });
  }
  return remaining;
});
