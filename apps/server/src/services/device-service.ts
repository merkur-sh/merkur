import { createLinkToken, hashToken, verifyDaemonProof } from '@merkur/auth';
import {
  type DaemonIdentitySealBackend,
  type Device,
  escapeForDoubleQuotedShell,
  isDaemonIdentitySealBackend,
  presenceStateToDeviceStatus,
} from '@merkur/shared';
import { Clock, Context, Effect, Layer, Redacted } from 'effect';
import type { InferResult, Kysely } from 'kysely';
import { ServerConfigService } from '../config';
import { DatabaseService } from '../db/client';
import { tryDatabaseTransactionPromise, withDatabaseTransaction } from '../db/transaction';
import type { DatabaseSchema } from '../db/types';
import { type InfrastructureError, infrastructureError } from './errors';
import { enqueueDeviceResync, NotificationOutboxServiceTag } from './notification-outbox-service';
import type { DaemonPresenceState } from './realtime-coordination-service';

const TOUCH_DAEMON_MIN_INTERVAL_MS = 15 * 1_000;
const TOUCH_DAEMON_THROTTLE_CAPACITY = 4_096;

export interface RenameDeviceInput {
  readonly userId: string;
  readonly deviceId: string;
  readonly name: string;
}

export interface VerifyDaemonResult {
  readonly daemonId: string;
  readonly userId: string;
  /** The box this daemon runs in, recorded from its link token; `null` when it is not a box. */
  readonly boxId: string | null;
}

/**
 * The box behind a device, or why none can be acted on. `ambiguousBoxId` is set
 * when more than one of the account's devices carries that box: a stale row from
 * an out-of-band deletion and a live box can share it, and acting on the wrong
 * one once destroyed a running container.
 */
export interface DeviceBox {
  readonly boxId: string | null;
  readonly ambiguousBoxId: string | null;
}

/**
 * The boxes an account's devices name, split by whether erasing the account may
 * destroy them. A box another account's device also names is `contested`: the
 * row here is stale (its box was deleted out of band and the name reused), and
 * the container now holds someone else's files.
 */
export interface AccountBoxes {
  readonly owned: readonly string[];
  readonly contested: readonly string[];
}

/** Reads {@link AccountBoxes}; a transaction reads them as of its own writes. */
export async function readAccountBoxes(
  db: Kysely<DatabaseSchema>,
  userId: string,
): Promise<AccountBoxes> {
  const rows = await db
    .selectFrom('daemons as own')
    .select((expression) => [
      'own.box_id',
      expression
        .exists(
          expression
            .selectFrom('daemons as other')
            .select('other.id')
            .whereRef('other.box_id', '=', 'own.box_id')
            .where('other.user_id', '!=', userId),
        )
        .as('contested'),
    ])
    .distinct()
    .where('own.user_id', '=', userId)
    .where('own.box_id', 'is not', null)
    .execute();
  const owned: string[] = [];
  const contested: string[] = [];
  for (const row of rows) {
    if (row.box_id === null) continue;
    // SQLite answers EXISTS with 0 or 1.
    (Number(row.contested) === 0 ? owned : contested).push(row.box_id);
  }
  return { owned, contested };
}

export interface LinkTokenResult {
  readonly token: string;
  readonly command: string;
  readonly expiresAt: number;
}

export interface DeviceServiceConfig {
  readonly tokenHmacSecret: string;
  readonly publicOrigin: string;
}

export interface CreateDeviceServiceOptions {
  /**
   * Override only for deterministic capacity tests. Production intentionally
   * uses a fixed bound so arbitrary historical daemon IDs cannot grow the
   * process for its entire lifetime.
   */
  readonly touchThrottleCapacity?: number;
}

export interface DeviceService {
  /**
   * `daemonPresenceStates` carries the lease disposition for every daemon with a
   * live control claim. A daemon absent from the map has no claim at all, which
   * is the third case the two-value presence enum cannot express.
   */
  listDevices(
    userId: string,
    daemonPresenceStates: ReadonlyMap<string, DaemonPresenceState>,
  ): Effect.Effect<Device[], InfrastructureError>;
  /** One row, read without a presence lookup: always reported `offline`. */
  getDevice(userId: string, daemonId: string): Effect.Effect<Device | null, InfrastructureError>;
  /** `boxId` names the box the token is minted for, or `null` for any other machine. */
  createLinkToken(
    userId: string,
    boxId: string | null,
  ): Effect.Effect<LinkTokenResult, InfrastructureError>;
  resolveBox(userId: string, deviceId: string): Effect.Effect<DeviceBox, InfrastructureError>;
  /** Every box the account's devices record, once each; `NULL` rows are not boxes. */
  listAccountBoxes(userId: string): Effect.Effect<AccountBoxes, InfrastructureError>;
  getDaemonSessionIdentity(
    userId: string,
    daemonId: string,
  ): Effect.Effect<
    {
      readonly daemonIdentityPublicKey: string;
      readonly daemonIdentityP256PublicKey: string;
      readonly daemonBindingJson: string;
    } | null,
    InfrastructureError
  >;
  renameDevice(input: RenameDeviceInput): Effect.Effect<void, InfrastructureError>;
  deleteDevice(userId: string, deviceId: string): Effect.Effect<void, InfrastructureError>;
  authenticateDaemonProof(
    daemonId: string,
    transcript: Uint8Array,
    signature: string,
    purpose: 'http' | 'control',
    p256Signature: string,
  ): Effect.Effect<VerifyDaemonResult | null, InfrastructureError>;
  touchDaemon(daemonId: string, version: string | null): Effect.Effect<void, InfrastructureError>;
  /**
   * Records that these daemons were proven alive just now, in one statement.
   *
   * `last_seen` used to be written once per registration, so a machine that had
   * been up for weeks and went down a minute ago reported a last-seen weeks in
   * the past — the one fact the device list has to fall back on when it can no
   * longer say a machine is reachable.
   */
  touchDaemonsSeen(daemonIds: readonly string[]): Effect.Effect<void, InfrastructureError>;
}

export class DeviceServiceTag extends Context.Service<DeviceServiceTag, DeviceService>()(
  'DeviceService',
) {}

export const DeviceServiceLive = Layer.effect(
  DeviceServiceTag,
  Effect.gen(function* () {
    const config = yield* ServerConfigService;
    const db = yield* DatabaseService;
    const serviceConfig: DeviceServiceConfig = {
      tokenHmacSecret: Redacted.value(config.tokenHmacSecret),
      publicOrigin: config.publicOrigin,
    };

    return createDeviceService(db, serviceConfig, (yield* NotificationOutboxServiceTag).wake);
  }),
);

interface DaemonTouchThrottleState {
  readonly touchedAt: number;
  readonly version: string | null;
}

export function createDeviceService(
  db: Kysely<DatabaseSchema>,
  config: DeviceServiceConfig,
  wakeNotifications: Effect.Effect<void>,
  options: CreateDeviceServiceOptions = {},
): DeviceService {
  const touchThrottleCapacity = options.touchThrottleCapacity ?? TOUCH_DAEMON_THROTTLE_CAPACITY;
  if (!Number.isSafeInteger(touchThrottleCapacity) || touchThrottleCapacity < 1) {
    throw new RangeError('touchThrottleCapacity must be a positive safe integer');
  }
  const touchThrottleByDaemonId = new Map<string, DaemonTouchThrottleState>();

  const readTouchThrottle = (daemonId: string): DaemonTouchThrottleState | undefined => {
    const state = touchThrottleByDaemonId.get(daemonId);
    if (state === undefined) return undefined;

    // Map insertion order gives an O(1) LRU without a cleanup timer. Keeping a
    // hot daemon resident avoids extra database writes under high churn.
    touchThrottleByDaemonId.delete(daemonId);
    touchThrottleByDaemonId.set(daemonId, state);
    return state;
  };

  const rememberTouch = (daemonId: string, state: DaemonTouchThrottleState): void => {
    if (!touchThrottleByDaemonId.has(daemonId)) {
      if (touchThrottleByDaemonId.size >= touchThrottleCapacity) {
        const oldestDaemonId = touchThrottleByDaemonId.keys().next().value;
        if (oldestDaemonId !== undefined) {
          touchThrottleByDaemonId.delete(oldestDaemonId);
        }
      }
    } else {
      touchThrottleByDaemonId.delete(daemonId);
    }
    touchThrottleByDaemonId.set(daemonId, state);
  };

  const daemonProofQuery = db
    .selectFrom('daemons')
    .select([
      'id',
      'user_id',
      'daemon_identity_public_key',
      'daemon_identity_p256_public_key',
      'box_id',
    ])
    .where('id', '=', '');
  const daemonProofLookup = daemonProofQuery.compile();
  type DaemonProofRow = InferResult<typeof daemonProofQuery>[number];
  const daemonSessionIdentityQuery = db
    .selectFrom('daemons as daemon')
    .leftJoin('delegation_revocation_outbox as revocation', (join) =>
      join
        .onRef('revocation.daemon_id', '=', 'daemon.id')
        .on('revocation.acknowledged_at', 'is', null),
    )
    .select([
      'daemon.daemon_identity_public_key',
      'daemon.daemon_identity_p256_public_key',
      'daemon.daemon_binding_json',
      'revocation.command_id as pending_revocation_command_id',
    ])
    .where('daemon.id', '=', '')
    .where('daemon.user_id', '=', '');
  const daemonSessionIdentityLookup = daemonSessionIdentityQuery.compile();
  type DaemonSessionIdentityRow = InferResult<typeof daemonSessionIdentityQuery>[number];

  return {
    listDevices(
      userId: string,
      daemonPresenceStates: ReadonlyMap<string, DaemonPresenceState>,
    ): Effect.Effect<Device[], InfrastructureError> {
      return Effect.tryPromise({
        try: async () => {
          const rows = await db
            .selectFrom('daemons')
            .select([
              'id',
              'user_id',
              'name',
              'platform',
              'last_seen',
              'version',
              'identity_seal_backend',
            ])
            .where('user_id', '=', userId)
            .execute();

          return rows
            .filter((row): row is typeof row & { id: string } => row.id !== null)
            .map(
              (row): Device => ({
                id: row.id,
                userId: row.user_id,
                name: row.name,
                platform: row.platform,
                lastSeen: row.last_seen,
                version: row.version,
                status: presenceStateToDeviceStatus(daemonPresenceStates.get(row.id)),
                identitySealBackend: requireIdentitySealBackend(row.identity_seal_backend),
              }),
            );
        },
        catch: infrastructureError('device', 'list-devices'),
      });
    },

    getDevice(userId, daemonId): Effect.Effect<Device | null, InfrastructureError> {
      return Effect.tryPromise({
        try: async () => {
          const row = await db
            .selectFrom('daemons')
            .select([
              'id',
              'user_id',
              'name',
              'platform',
              'last_seen',
              'version',
              'identity_seal_backend',
            ])
            .where('user_id', '=', userId)
            .where('id', '=', daemonId)
            .executeTakeFirst();
          if (row === undefined || row.id === null) return null;
          return {
            id: row.id,
            userId: row.user_id,
            name: row.name,
            platform: row.platform,
            lastSeen: row.last_seen,
            version: row.version,
            // Read at link time, before the daemon has connected; its claim
            // publishes the online edge once it does.
            status: presenceStateToDeviceStatus(undefined),
            identitySealBackend: requireIdentitySealBackend(row.identity_seal_backend),
          };
        },
        catch: infrastructureError('device', 'get-device'),
      });
    },

    createLinkToken(
      userId: string,
      boxId: string | null,
    ): Effect.Effect<LinkTokenResult, InfrastructureError> {
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const issuedToken = createLinkToken(now);
        const tokenHash = hashToken(issuedToken.token, config.tokenHmacSecret, 'device-link');

        return yield* Effect.tryPromise({
          try: async () => {
            await db
              .insertInto('link_tokens')
              .values({
                token_hash: tokenHash,
                user_id: userId,
                expires_at: issuedToken.expiresAt,
                used_at: null,
                box_id: boxId,
              })
              .execute();

            const command = buildLinkCommand(config.publicOrigin, issuedToken.token);

            return {
              token: issuedToken.token,
              command,
              expiresAt: issuedToken.expiresAt,
            };
          },
          catch: infrastructureError('device', 'create-link-token'),
        });
      });
    },

    resolveBox(userId: string, deviceId: string): Effect.Effect<DeviceBox, InfrastructureError> {
      return Effect.tryPromise({
        try: async () => {
          const row = await db
            .selectFrom('daemons')
            .select('box_id')
            .where('user_id', '=', userId)
            .where('id', '=', deviceId)
            .executeTakeFirst();
          const boxId = row?.box_id ?? null;
          if (boxId === null) return { boxId: null, ambiguousBoxId: null };
          const sharing = await db
            .selectFrom('daemons')
            .select((expression) => expression.fn.countAll<number>().as('count'))
            .where('user_id', '=', userId)
            .where('box_id', '=', boxId)
            .executeTakeFirstOrThrow();
          return Number(sharing.count) === 1
            ? { boxId, ambiguousBoxId: null }
            : { boxId: null, ambiguousBoxId: boxId };
        },
        catch: infrastructureError('device', 'resolve-box'),
      });
    },

    listAccountBoxes(userId: string): Effect.Effect<AccountBoxes, InfrastructureError> {
      return Effect.tryPromise({
        try: () => readAccountBoxes(db, userId),
        catch: infrastructureError('device', 'list-account-boxes'),
      });
    },

    getDaemonSessionIdentity(
      userId: string,
      daemonId: string,
    ): Effect.Effect<
      {
        readonly daemonIdentityPublicKey: string;
        readonly daemonIdentityP256PublicKey: string;
        readonly daemonBindingJson: string;
      } | null,
      InfrastructureError
    > {
      return Effect.tryPromise({
        try: async () => {
          const { rows } = await db.executeQuery<DaemonSessionIdentityRow>({
            ...daemonSessionIdentityLookup,
            parameters: [daemonId, userId],
          });
          const row = rows[0];
          return row === undefined || row.pending_revocation_command_id !== null
            ? null
            : {
                daemonIdentityPublicKey: row.daemon_identity_public_key,
                daemonIdentityP256PublicKey: row.daemon_identity_p256_public_key,
                daemonBindingJson: row.daemon_binding_json,
              };
        },
        catch: infrastructureError('device', 'get-daemon-session-identity'),
      });
    },

    deleteDevice: Effect.fnUntraced(function* (userId: string, deviceId: string) {
      const deleted = yield* withDatabaseTransaction(db, (trx) =>
        tryDatabaseTransactionPromise({
          try: async () => {
            const result = await trx
              .deleteFrom('daemons')
              .where('id', '=', deviceId)
              .where('user_id', '=', userId)
              .executeTakeFirst();
            if (result.numDeletedRows === 0n) return false;
            await enqueueDeviceResync(trx, userId);
            return true;
          },
          catch: infrastructureError('device', 'delete-device'),
        }),
      );
      if (deleted) {
        touchThrottleByDaemonId.delete(deviceId);
        yield* wakeNotifications;
      }
    }),

    renameDevice: Effect.fnUntraced(function* (input: RenameDeviceInput) {
      const renamed = yield* withDatabaseTransaction(db, (trx) =>
        tryDatabaseTransactionPromise({
          try: async () => {
            const result = await trx
              .updateTable('daemons')
              .set({ name: input.name })
              .where('id', '=', input.deviceId)
              .where('user_id', '=', input.userId)
              .executeTakeFirst();
            if (result.numUpdatedRows === 0n) return false;
            await enqueueDeviceResync(trx, input.userId);
            return true;
          },
          catch: infrastructureError('device', 'rename-device'),
        }),
      );
      if (renamed) yield* wakeNotifications;
    }),

    authenticateDaemonProof(
      daemonId: string,
      transcript: Uint8Array,
      signature: string,
      purpose: 'http' | 'control',
      p256Signature: string,
    ): Effect.Effect<VerifyDaemonResult | null, InfrastructureError> {
      return Effect.tryPromise({
        try: async () => {
          const { rows } = await db.executeQuery<DaemonProofRow>({
            ...daemonProofLookup,
            parameters: [daemonId],
          });
          const row = rows[0];

          if (row === undefined) {
            return null;
          }

          if (
            !verifyDaemonProof(
              row.daemon_identity_public_key,
              row.daemon_identity_p256_public_key,
              purpose,
              transcript,
              signature,
              p256Signature,
            )
          ) {
            return null;
          }

          // id is the primary key — null would indicate schema corruption
          if (row.id === null) {
            return null;
          }

          return {
            daemonId: row.id,
            userId: row.user_id,
            boxId: row.box_id,
          };
        },
        catch: infrastructureError('device', 'authenticate-daemon-proof'),
      });
    },

    touchDaemonsSeen(daemonIds: readonly string[]): Effect.Effect<void, InfrastructureError> {
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        // The same throttle registration writes through, so a daemon that
        // registered seconds ago is not rewritten by the renewal that follows.
        const due = daemonIds.filter((daemonId) => {
          const throttle = readTouchThrottle(daemonId);
          return throttle === undefined || now - throttle.touchedAt >= TOUCH_DAEMON_MIN_INTERVAL_MS;
        });
        if (due.length === 0) return;

        yield* Effect.tryPromise({
          try: () =>
            db.updateTable('daemons').set({ last_seen: now }).where('id', 'in', due).execute(),
          catch: infrastructureError('device', 'touch-daemons-seen'),
        });
        const touchedAt = yield* Clock.currentTimeMillis;
        for (const daemonId of due) {
          // The version is this daemon's, not this call's: proving liveness
          // says nothing about the build, and dropping it here would make the
          // next registration bypass the throttle for no reason.
          rememberTouch(daemonId, {
            touchedAt,
            version: readTouchThrottle(daemonId)?.version ?? null,
          });
        }
      });
    },

    touchDaemon(
      daemonId: string,
      version: string | null,
    ): Effect.Effect<void, InfrastructureError> {
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const throttle = readTouchThrottle(daemonId);
        // Bypass the throttle when the reported version changes so a
        // daemon restarting right after an update never loses the write.
        const reportedVersion = version !== null && version !== throttle?.version ? version : null;
        if (
          reportedVersion === null &&
          throttle !== undefined &&
          now - throttle.touchedAt < TOUCH_DAEMON_MIN_INTERVAL_MS
        ) {
          return;
        }

        if (reportedVersion === null) {
          yield* Effect.tryPromise({
            try: () =>
              db
                .updateTable('daemons')
                .set({ last_seen: now })
                .where('id', '=', daemonId)
                .execute(),
            catch: infrastructureError('device', 'touch-daemon'),
          });
        } else {
          // A build the row does not hold yet is a device-list change, like a
          // rename: no delta carries a version, so the resync is what makes open
          // lists and cached cursors reload the row instead of showing the build
          // the daemon was last listed with.
          const changed = yield* withDatabaseTransaction(db, (trx) =>
            tryDatabaseTransactionPromise({
              try: async () => {
                const stored = await trx
                  .selectFrom('daemons')
                  .select(['user_id', 'version'])
                  .where('id', '=', daemonId)
                  .executeTakeFirst();
                if (stored === undefined) return false;
                await trx
                  .updateTable('daemons')
                  .set({ last_seen: now, version: reportedVersion })
                  .where('id', '=', daemonId)
                  .execute();
                if (stored.version === reportedVersion) return false;
                await enqueueDeviceResync(trx, stored.user_id);
                return true;
              },
              catch: infrastructureError('device', 'touch-daemon'),
            }),
          );
          if (changed) yield* wakeNotifications;
        }
        // A failed write must remain immediately retryable. Publishing the
        // throttle state before the await silently dropped the retry for the
        // entire interval and could leave a restarted daemon's version stale.
        const touchedAt = yield* Clock.currentTimeMillis;
        rememberTouch(daemonId, {
          touchedAt,
          version: version ?? throttle?.version ?? null,
        });
      });
    },
  };
}

/**
 * The whole link, as one command: install (or reinstall) the daemon and link it.
 *
 * The token rides in the installer's environment, not its argv, so it never
 * appears in `ps` for the length of the approval wait. It does land in shell
 * history; it is one-use, expires in minutes, and on its own only opens a
 * pending claim that still needs the account password in the browser.
 */
function buildLinkCommand(publicOrigin: string, token: string): string {
  return `curl -fsSL "${escapeForDoubleQuotedShell(publicOrigin)}/install" | MERKUR_LINK_TOKEN=${token} sh`;
}

function requireIdentitySealBackend(value: string): DaemonIdentitySealBackend {
  if (!isDaemonIdentitySealBackend(value))
    throw new Error('Invalid stored daemon identity backend');
  return value;
}
