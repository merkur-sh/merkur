import { Cause, Effect, Exit } from 'effect';
import type { ControlledTransaction, Kysely } from 'kysely';

import { InfrastructureError, infrastructureError } from '../services/errors';
import type { DatabaseSchema } from './types';

type DbTransaction = ControlledTransaction<DatabaseSchema, []>;

export class DatabaseTransactionBeginError extends InfrastructureError {
  readonly transactionPhase = 'begin' as const;

  constructor(cause: unknown) {
    const error = infrastructureError('database', 'start-transaction')(cause);
    super(error);
  }
}

export class DatabaseTransactionCommitError extends InfrastructureError {
  readonly transactionPhase = 'commit' as const;

  constructor(cause: unknown) {
    const error = infrastructureError('database', 'commit-transaction')(cause);
    super(error);
  }
}

export class DatabaseTransactionRollbackError extends InfrastructureError {
  readonly transactionPhase = 'rollback' as const;

  constructor(cause: unknown) {
    const error = infrastructureError('database', 'rollback-transaction')(cause);
    super(error);
  }
}

export type DatabaseTransactionError =
  | DatabaseTransactionBeginError
  | DatabaseTransactionCommitError
  | DatabaseTransactionRollbackError;

/**
 * Transaction coroutines cannot be aborted by libSQL. Interruption waits for
 * their native work to settle before the transaction owner can roll back.
 */
export function tryDatabaseTransactionPromise<A, E>(options: {
  readonly try: () => PromiseLike<A>;
  readonly catch: (cause: unknown) => E;
}): Effect.Effect<A, E> {
  return Effect.callback<A, E>((resume) => {
    let pending: Promise<A>;
    try {
      pending = Promise.resolve(options.try());
    } catch (cause) {
      resume(Effect.fail(options.catch(cause)));
      return;
    }
    const settled = pending.then(
      (value) => resume(Effect.succeed(value)),
      (cause: unknown) => resume(Effect.fail(options.catch(cause))),
    );
    return Effect.promise(() => settled);
  });
}

export function withDatabaseTransaction<A, E>(
  db: Kysely<DatabaseSchema>,
  use: (trx: DbTransaction) => Effect.Effect<A, E>,
): Effect.Effect<A, E | DatabaseTransactionError> {
  return withTransactionResource(
    Effect.tryPromise({
      try: () => db.startTransaction().execute(),
      catch: (cause) => new DatabaseTransactionBeginError(cause),
    }),
    use,
    (trx) =>
      Effect.tryPromise({
        try: () => trx.commit().execute(),
        catch: (cause) => new DatabaseTransactionCommitError(cause),
      }),
    (trx) =>
      Effect.tryPromise({
        try: () => trx.rollback().execute(),
        catch: (cause) => new DatabaseTransactionRollbackError(cause),
      }),
  );
}

export function withTransactionResource<A, E, Transaction, BeginError, CommitError, RollbackError>(
  acquire: Effect.Effect<Transaction, BeginError>,
  use: (transaction: Transaction) => Effect.Effect<A, E>,
  commit: (transaction: Transaction) => Effect.Effect<void, CommitError>,
  rollback: (transaction: Transaction) => Effect.Effect<void, RollbackError>,
): Effect.Effect<A, E | BeginError | CommitError | RollbackError> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      // Kysely's BEGIN promise is not abortable. Keep acquisition masked so an
      // interrupt that arrives while it is pending cannot escape before a
      // later successful BEGIN is paired with rollback.
      const transaction = yield* acquire;

      const result = yield* Effect.exit(restore(Effect.suspend(() => use(transaction))));
      if (Exit.isSuccess(result)) {
        const committed = yield* Effect.exit(Effect.suspend(() => commit(transaction)));
        if (Exit.isSuccess(committed)) return result.value;

        // A rejected COMMIT leaves the transaction state unknown. Best-effort
        // rollback is still required to release a connection/lock when the
        // driver can prove the commit did not finish.
        const rolledBack = yield* Effect.exit(Effect.suspend(() => rollback(transaction)));
        if (Exit.isFailure(rolledBack)) {
          return yield* Effect.failCause(Cause.combine(committed.cause, rolledBack.cause));
        }
        return yield* Effect.failCause(committed.cause);
      }

      const rolledBack = yield* Effect.exit(Effect.suspend(() => rollback(transaction)));
      if (Exit.isFailure(rolledBack)) {
        return yield* Effect.failCause(Cause.combine(result.cause, rolledBack.cause));
      }

      return yield* Effect.failCause(result.cause);
    }),
  );
}
