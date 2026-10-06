import { Deferred, Effect, Result } from 'effect';
import {
  parseRedisFlag,
  parseRedisOptionalString,
  parseRedisSafeInteger,
  parseRedisSetNxResult,
} from './redis-reply';
import { defineRedisScript, type RedisScript } from './redis-script';
import {
  evalRedisScript,
  type RedisCommandClient,
  type RedisError,
  RedisReplyError,
  type RedisService,
} from './redis-service';
import {
  type AllocatingSessionIssuance,
  parseStoredSessionIssuance,
  type StoredSessionIssuance,
} from './session-issuance-codec';
import { SessionIssuanceStateError } from './session-issuance-contract';

const ISSUANCE_TTL_MS = 300_000;
export const COMMITTED_ISSUANCE_TTL_MS = 86_400_000;
const ISSUANCE_LEASE_MS = 10_000;
const ISSUANCE_WAIT_GRACE_MS = 250;
const ISSUANCE_KEY_PREFIX = 'merkur:sessions:issuance:';
const ISSUANCE_LOCK_KEY_PREFIX = 'merkur:sessions:issuance-lock:';
const ISSUANCE_CHANNEL_PREFIX = 'merkur:sessions:issuance-events:';
const INITIALIZE_LEASE_AND_READ_SCRIPT = defineRedisScript(
  'session-issuance-initialize-lease-and-read',
  `
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])
local acquired = 0
if created and redis.call('SET', KEYS[2], ARGV[3], 'NX', 'PX', ARGV[4]) then
  acquired = 1
end
return { acquired, redis.call('GET', KEYS[1]) }
`,
);

const ACQUIRE_LEASE_AND_READ_SCRIPT = defineRedisScript(
  'session-issuance-acquire-lease-and-read',
  `
local acquired = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])
if not acquired then
  return { 0, '' }
end
local snapshot = redis.call('GET', KEYS[2])
if not snapshot then
  return { 1, '' }
end
return { 1, snapshot }
`,
);

const STORE_IF_OWNER_SCRIPT = defineRedisScript(
  'session-issuance-store-if-owner',
  `
if redis.call('GET', KEYS[2]) ~= ARGV[2] then
  return 0
end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])
if ARGV[5] == '1' then
  redis.call('DEL', KEYS[2])
else
  redis.call('PEXPIRE', KEYS[2], ARGV[7])
end
if ARGV[6] == '1' then
  redis.call('PUBLISH', KEYS[3], 'changed')
end
return 1
`,
);

const DELETE_IF_OWNER_SCRIPT = defineRedisScript(
  'session-issuance-delete-if-owner',
  `
if redis.call('GET', KEYS[2]) ~= ARGV[2] then
  return 0
end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
redis.call('PUBLISH', KEYS[3], 'changed')
return 1
`,
);

const STORE_IF_CURRENT_SCRIPT = defineRedisScript(
  'session-issuance-store-if-current',
  `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
if redis.call('GET', KEYS[2]) == ARGV[4] then
  redis.call('DEL', KEYS[2])
end
redis.call('PUBLISH', KEYS[3], 'changed')
return 1
`,
);

const CANCEL_IF_CURRENT_SCRIPT = defineRedisScript(
  'session-issuance-cancel-if-current',
  `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
redis.call('DEL', KEYS[2])
redis.call('PUBLISH', KEYS[3], 'changed')
return 1
`,
);

const SUPERSEDE_AND_RESERVE_SCRIPT = defineRedisScript(
  'session-issuance-supersede-and-reserve',
  `
local predecessor = redis.call('GET', KEYS[1])
if ARGV[6] == '1' then
  if predecessor then
    return 0
  end
elseif predecessor ~= ARGV[1] then
  return 0
end
local successor = redis.call('GET', KEYS[4])
if successor then
  return 0
end
redis.call('SET', KEYS[4], ARGV[2], 'PX', ARGV[3])
if ARGV[4] == '1' then
  redis.call('SET', KEYS[1], ARGV[5], 'PX', ARGV[3])
  redis.call('DEL', KEYS[2])
  redis.call('PUBLISH', KEYS[3], 'changed')
end
return 1
`,
);

const RELEASE_IF_OWNER_SCRIPT = defineRedisScript(
  'session-issuance-release-if-owner',
  `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('PUBLISH', KEYS[2], 'changed')
return 1
`,
);

const EXPECTED_SNAPSHOT_LEASE_TTL_SCRIPT = defineRedisScript(
  'session-issuance-expected-snapshot-lease-ttl',
  `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return -3
end
local ttl = redis.call('PTTL', KEYS[2])
if ttl == -1 then
  redis.call('PEXPIRE', KEYS[2], ARGV[2])
  return tonumber(ARGV[2])
end
if ttl < 0 then
  return 0
end
return ttl
`,
);
export const SESSION_ISSUANCE_SCRIPTS = [
  INITIALIZE_LEASE_AND_READ_SCRIPT,
  ACQUIRE_LEASE_AND_READ_SCRIPT,
  STORE_IF_OWNER_SCRIPT,
  DELETE_IF_OWNER_SCRIPT,
  STORE_IF_CURRENT_SCRIPT,
  CANCEL_IF_CURRENT_SCRIPT,
  SUPERSEDE_AND_RESERVE_SCRIPT,
  RELEASE_IF_OWNER_SCRIPT,
  EXPECTED_SNAPSHOT_LEASE_TTL_SCRIPT,
] as const;

export interface StoredSnapshot {
  readonly raw: string;
  readonly record: StoredSessionIssuance;
}

export interface IssuanceKeys {
  readonly record: string;
  readonly lock: string;
  readonly channel: string;
}

export function issuanceKeys(userId: string, issuanceId: string): IssuanceKeys {
  const digest = new Bun.CryptoHasher('sha256')
    .update(userId)
    .update('\0')
    .update(issuanceId)
    .digest('base64url');
  return {
    record: `${ISSUANCE_KEY_PREFIX}${digest}`,
    lock: `${ISSUANCE_LOCK_KEY_PREFIX}${digest}`,
    channel: `${ISSUANCE_CHANNEL_PREFIX}${digest}`,
  };
}

interface InitializedSnapshot {
  readonly snapshot: StoredSnapshot;
  readonly lease: Effect.Effect<LeaseAndSnapshotResult, RedisError | SessionIssuanceStateError>;
}

export function initializeLeaseAndReadSnapshot(
  redis: RedisService,
  keys: IssuanceKeys,
  record: AllocatingSessionIssuance,
  owner: string,
  issuanceId: string,
): Effect.Effect<InitializedSnapshot, RedisError | SessionIssuanceStateError> {
  return Effect.gen(function* () {
    const initialRaw = JSON.stringify(record);
    const initialized = yield* Effect.result(
      redis.useCommands(async (commands) => {
        const reply: unknown = await evalRedisScript(
          commands,
          INITIALIZE_LEASE_AND_READ_SCRIPT,
          [keys.record, keys.lock],
          [initialRaw, String(ISSUANCE_TTL_MS), owner, String(ISSUANCE_LEASE_MS)],
        );
        if (!Array.isArray(reply) || reply.length !== 2 || typeof reply[1] !== 'string') {
          throw new RedisReplyError(
            'session issuance initialize-lease-and-read result',
            'must be an exact [0|1, string] tuple',
            reply,
          );
        }
        return {
          acquired: parseRedisFlag(reply[0], 'session issuance initial lease acquired flag'),
          raw: reply[1],
        };
      }),
    );
    if (Result.isFailure(initialized)) {
      // A lost or malformed reply can follow successful atomic allocation.
      // Release only this request's lease before propagating the boundary error.
      yield* releaseIfOwner(redis, keys, owner).pipe(Effect.ignore);
      return yield* Effect.fail(initialized.failure);
    }
    const { acquired, raw } = initialized.success;
    // Only a record created by this invocation can carry its initial lease.
    // Fail closed, and release that lease, if Redis reports a different record
    // or decoding rejects the caller's newly allocated identity.
    if (acquired && raw !== initialRaw) {
      yield* releaseIfOwner(redis, keys, owner);
      return yield* new SessionIssuanceStateError({
        issuanceId,
        message: 'Initial session issuance lease is bound to a different record',
      });
    }
    const decoded = yield* Effect.result(decodeStoredSnapshot(raw, issuanceId));
    if (Result.isFailure(decoded)) {
      if (acquired) yield* releaseIfOwner(redis, keys, owner);
      return yield* Effect.fail(decoded.failure);
    }
    const snapshot = decoded.success;
    return {
      snapshot,
      lease: acquired
        ? Effect.succeed({ acquired: true as const, snapshot })
        : acquireLeaseAndReadSnapshot(redis, keys, owner, issuanceId),
    };
  });
}

export function readSnapshot(
  redis: RedisService,
  keys: IssuanceKeys,
  issuanceId: string,
): Effect.Effect<StoredSnapshot | null, RedisError | SessionIssuanceStateError> {
  return redis
    .useCommands(async (commands) =>
      parseRedisOptionalString(
        await commands.sendCommand(['GET', keys.record]),
        'session issuance snapshot',
      ),
    )
    .pipe(
      Effect.flatMap((raw) => {
        if (typeof raw !== 'string') return Effect.succeed(null);
        return decodeStoredSnapshot(raw, issuanceId);
      }),
    );
}

function decodeStoredSnapshot(
  raw: string,
  issuanceId: string,
): Effect.Effect<StoredSnapshot, SessionIssuanceStateError> {
  const record = parseStoredSessionIssuance(raw);
  return record === null
    ? Effect.fail(
        new SessionIssuanceStateError({
          issuanceId,
          message: 'Stored session issuance is malformed',
        }),
      )
    : Effect.succeed({ raw, record });
}

function acquireLease(
  redis: RedisService,
  lockKey: string,
  owner: string,
): Effect.Effect<boolean, RedisError> {
  return redis.useCommands(async (commands) =>
    parseRedisSetNxResult(
      await commands.sendCommand(['SET', lockKey, owner, 'NX', 'PX', String(ISSUANCE_LEASE_MS)]),
      'session issuance lease result',
    ),
  );
}

type LeaseAndSnapshotResult =
  | { readonly acquired: false }
  | { readonly acquired: true; readonly snapshot: StoredSnapshot | null };

export function acquireLeaseAndReadSnapshot(
  redis: RedisService,
  keys: IssuanceKeys,
  owner: string,
  issuanceId: string,
): Effect.Effect<LeaseAndSnapshotResult, RedisError | SessionIssuanceStateError> {
  return Effect.gen(function* () {
    const { acquired, raw } = yield* redis.useCommands(
      async (commands): Promise<{ readonly acquired: boolean; readonly raw: string }> => {
        const reply: unknown = await evalRedisScript(
          commands,
          ACQUIRE_LEASE_AND_READ_SCRIPT,
          [keys.lock, keys.record],
          [owner, String(ISSUANCE_LEASE_MS)],
        );
        if (!Array.isArray(reply) || reply.length !== 2 || typeof reply[1] !== 'string') {
          throw new RedisReplyError(
            'session issuance acquire-lease-and-read result',
            'must be an exact [0|1, string] tuple',
            reply,
          );
        }
        const acquired = parseRedisFlag(
          reply[0],
          'session issuance acquire-lease-and-read acquired flag',
        );
        if (!acquired && reply[1] !== '') {
          throw new RedisReplyError(
            'session issuance acquire-lease-and-read result',
            'contended leases must carry an empty snapshot sentinel',
            reply,
          );
        }
        return { acquired, raw: reply[1] };
      },
    );
    if (!acquired) return { acquired: false } as const;
    if (raw.length === 0) return { acquired: true, snapshot: null } as const;
    return { acquired: true, snapshot: yield* decodeStoredSnapshot(raw, issuanceId) } as const;
  });
}

export function storeIfOwner(
  redis: RedisService,
  keys: IssuanceKeys,
  owner: string,
  expectedRaw: string,
  replacementRaw: string,
  releaseLease: boolean,
  publish: boolean,
  ttlMs = ISSUANCE_TTL_MS,
): Effect.Effect<boolean, RedisError> {
  return evalBoolean(
    redis,
    STORE_IF_OWNER_SCRIPT,
    [keys.record, keys.lock, keys.channel],
    [
      expectedRaw,
      owner,
      replacementRaw,
      String(ttlMs),
      releaseLease ? '1' : '0',
      publish ? '1' : '0',
      String(ISSUANCE_LEASE_MS),
    ],
  );
}

export function deleteIfOwner(
  redis: RedisService,
  keys: IssuanceKeys,
  owner: string,
  expectedRaw: string,
): Effect.Effect<boolean, RedisError> {
  return evalBoolean(
    redis,
    DELETE_IF_OWNER_SCRIPT,
    [keys.record, keys.lock, keys.channel],
    [expectedRaw, owner],
  );
}

export function reclaimAndAbandon<CompensationError>(
  redis: RedisService,
  keys: IssuanceKeys,
  owner: string,
  expectedRaw: string,
  sessionId: string,
  compensate: (sessionId: string) => Effect.Effect<void, CompensationError>,
): Effect.Effect<void, RedisError> {
  return Effect.gen(function* () {
    const reclaimed = yield* acquireLease(redis, keys.lock, owner);
    if (!reclaimed) return;
    const abandoned = yield* deleteIfOwner(redis, keys, owner, expectedRaw);
    if (abandoned) {
      yield* compensate(sessionId).pipe(Effect.ignore);
      return;
    }
    yield* releaseIfOwner(redis, keys, owner);
  });
}

export function storeIfCurrent(
  redis: RedisService,
  keys: IssuanceKeys,
  owner: string,
  expectedRaw: string,
  replacementRaw: string,
  ttlMs: number,
): Effect.Effect<boolean, RedisError> {
  return evalBoolean(
    redis,
    STORE_IF_CURRENT_SCRIPT,
    [keys.record, keys.lock, keys.channel],
    [expectedRaw, replacementRaw, String(ttlMs), owner],
  );
}

export function replaceIfCurrent(
  redis: RedisService,
  keys: IssuanceKeys,
  expectedRaw: string,
  cancelledRaw: string,
): Effect.Effect<boolean, RedisError> {
  return evalBoolean(
    redis,
    CANCEL_IF_CURRENT_SCRIPT,
    [keys.record, keys.lock, keys.channel],
    [expectedRaw, cancelledRaw, String(ISSUANCE_TTL_MS)],
  );
}

export function supersedeAndReserve(
  redis: RedisService,
  predecessorKeys: IssuanceKeys,
  successorKeys: IssuanceKeys,
  expectedPredecessorRaw: string | null,
  successorRaw: string,
  supersededPredecessorRaw: string | null,
): Effect.Effect<boolean, RedisError> {
  return evalBoolean(
    redis,
    SUPERSEDE_AND_RESERVE_SCRIPT,
    [predecessorKeys.record, predecessorKeys.lock, predecessorKeys.channel, successorKeys.record],
    [
      expectedPredecessorRaw ?? '',
      successorRaw,
      String(ISSUANCE_TTL_MS),
      supersededPredecessorRaw === null ? '0' : '1',
      supersededPredecessorRaw ?? expectedPredecessorRaw ?? '',
      expectedPredecessorRaw === null ? '1' : '0',
    ],
  );
}

function evalBoolean(
  redis: RedisService,
  script: RedisScript,
  keys: readonly string[],
  args: readonly string[],
): Effect.Effect<boolean, RedisError> {
  return redis.useCommands(async (commands: RedisCommandClient) =>
    parseRedisFlag(
      await evalRedisScript(commands, script, keys, args),
      'session issuance mutation result',
    ),
  );
}

export function releaseIfOwner(
  redis: RedisService,
  keys: IssuanceKeys,
  owner: string,
): Effect.Effect<boolean, RedisError> {
  return evalBoolean(redis, RELEASE_IF_OWNER_SCRIPT, [keys.lock, keys.channel], [owner]);
}

export function waitForSnapshotChange(
  redis: RedisService,
  keys: IssuanceKeys,
  expectedRaw: string,
  issuanceId: string,
): Effect.Effect<void, RedisError | SessionIssuanceStateError> {
  return Effect.gen(function* () {
    const changed = yield* Deferred.make<void>();
    const handler = (): void => {
      Deferred.doneUnsafe(changed, Effect.void);
    };

    yield* Effect.acquireUseRelease(
      redis.subscribe(keys.channel, handler),
      () =>
        Effect.gen(function* () {
          // Subscribe before re-reading. A commit between the caller's GET and
          // SUBSCRIBE is therefore observed here, closing the pub/sub lost-wake
          // race without polling.
          const remainingLeaseMs = yield* readExpectedSnapshotLeaseTtl(
            redis,
            keys,
            expectedRaw,
            issuanceId,
          );
          if (remainingLeaseMs === null) return;
          yield* Effect.raceFirst(
            Deferred.await(changed),
            Effect.sleep(`${remainingLeaseMs + ISSUANCE_WAIT_GRACE_MS} millis`),
          );
        }),
      () => redis.unsubscribe(keys.channel, handler).pipe(Effect.ignore),
    );
  });
}

function readExpectedSnapshotLeaseTtl(
  redis: RedisService,
  keys: IssuanceKeys,
  expectedRaw: string,
  issuanceId: string,
): Effect.Effect<number | null, RedisError | SessionIssuanceStateError> {
  return redis
    .useCommands((commands) =>
      evalRedisScript(
        commands,
        EXPECTED_SNAPSHOT_LEASE_TTL_SCRIPT,
        [keys.record, keys.lock],
        [expectedRaw, String(ISSUANCE_LEASE_MS)],
      ),
    )
    .pipe(
      Effect.flatMap((result) => {
        let ttl: number;
        try {
          ttl = parseRedisSafeInteger(result, 'issuance lease TTL');
        } catch {
          return Effect.fail(
            new SessionIssuanceStateError({
              issuanceId,
              message: 'Redis returned an invalid issuance lease TTL',
            }),
          );
        }
        if (ttl === -3) return Effect.succeed(null);
        if (ttl < 0) {
          return Effect.fail(
            new SessionIssuanceStateError({
              issuanceId,
              message: 'Redis returned an invalid issuance lease TTL',
            }),
          );
        }
        return Effect.succeed(ttl);
      }),
    );
}
