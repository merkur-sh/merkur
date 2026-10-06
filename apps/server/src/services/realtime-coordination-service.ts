import { randomBytes } from 'node:crypto';
import {
  DAEMON_CONTROL_RESUME_GRACE_MS,
  DAEMON_ONLINE_TTL_MS,
  type DeviceDeltaFrame,
  type DeviceEventDelta,
  type DeviceEventsCursor,
  hasExactKeys,
  isDeviceDeltaFrame,
  isDeviceEventsEpoch,
  presenceStateToDeviceStatus,
} from '@merkur/shared';
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Metric,
  Queue,
  Result,
  type Scope,
} from 'effect';
import { createLogger, errorLogContext, type Logger, logWithLoggerEffect } from '../logger';
import { backgroundWorkerFailureFrequency } from '../observability/metrics';
import { IP_ZONES, type IpZone } from './ip-region';
import {
  parseRedisFlag,
  parseRedisNonNegativeSafeInteger,
  parseRedisNullableStringArray,
  parseRedisOptionalString,
  parseRedisPositiveSafeInteger,
  parseRedisSortedSetHead,
  parseRedisStringArray,
  parseRedisTimeMilliseconds,
} from './redis-reply';
import { defineRedisScript } from './redis-script';
import {
  evalRedisScript,
  preloadRedisScripts,
  type RedisCommandClient,
  RedisError,
  RedisReplyError,
  type RedisService,
  RedisServiceTag,
} from './redis-service';

const SESSION_TTL_MS = 300_000;
/** 64 bits of epoch: compared, never interpreted, and never colliding. */
const DEVICE_EVENTS_EPOCH_BYTES = 8;

/**
 * How long session issuance waits for a daemon's presence to appear before
 * reporting it disconnected.
 *
 * A daemon whose control link is reconnecting has no presence in Redis for a
 * moment, and that moment lines up exactly with the browser reconnecting after
 * the same network event — which is why `POST /api/sessions/request` answered
 * 503 for 13.7 % of requests over 30 days in production. The browser then
 * backed off on a ladder measured in seconds for a condition that clears in
 * hundreds of milliseconds.
 *
 * Waiting is bounded and event-driven rather than polled: the daemon's
 * registration publishes a device delta on the user's channel, so this is one
 * subscription and one re-read. It sits far inside both the browser's issuance
 * timeout and the daemon-command acknowledgement budget, so a genuinely absent
 * daemon is still reported promptly.
 */
const DAEMON_PRESENCE_WAIT_MS = 1_000;
const INDEX_TTL_MS = DAEMON_ONLINE_TTL_MS * 10; // Index keys (sorted set, user set) use generous TTL
const DAEMON_CLAIM_SEQUENCE_KEY = 'merkur:control:daemon-claim-seq';
const DAEMON_CLAIMS_KEY_PREFIX = 'merkur:control:daemon-claims:';
const DAEMON_CLAIM_KEY_PREFIX = 'merkur:control:daemon-claim:';
const DAEMON_PRESENCE_DEADLINES_KEY = 'merkur:control:daemon-presence-deadlines';
const DAEMON_PRESENCE_DEADLINE_EVENTS_CHANNEL = 'merkur:control:daemon-presence-deadline-events';
const USER_ONLINE_DAEMONS_KEY_PREFIX = 'merkur:control:user-online-daemons:';
const DEVICE_EVENTS_CHANNEL_PREFIX = 'merkur:device-events:';
// A hash of `{ epoch, seq }`, not a bare counter: the two have to be created
// and destroyed together, or a browser could be told "nothing changed" against
// a counter that restarted. Renamed with the shape — an old string key under
// the previous name is abandoned, never read, and cannot collide by type.
const DEVICE_EVENTS_CURSOR_KEY_PREFIX = 'merkur:device-events-cursor:';
const REVOCATION_KEY_PREFIX = 'merkur:auth:revocation:';
const ACTIVE_SESSION_KEY_PREFIX = 'merkur:sessions:active:';
const CLAIM_SESSIONS_KEY_PREFIX = 'merkur:sessions:claim:';
const EXPIRY_RECOVERY_DELAY_MS = 1_000;
const DAEMON_PRESENCE_FIELDS = [
  'daemonId',
  'userId',
  'ownerInstanceId',
  'connectionId',
  'presenceId',
  'claimSeq',
  'state',
  'updatedAt',
  'zone',
] as const;
const DAEMON_PRESENCE_STATES = ['online', 'silent', 'suspended'] as const;
const SESSION_CLAIM_FIELDS = [
  'daemonId',
  'userId',
  'browserNodeId',
  'presenceId',
  'claimSeq',
] as const;
const PRESENCE_DEADLINE_FIELDS = ['daemonId', 'userId', 'presenceId', 'claimSeq'] as const;
// Pub/sub is the zero-latency wake path, but Redis pub/sub is intentionally
// lossy across subscriber reconnects. When the durable ZSET is empty, perform
// one bounded reconciliation so a commit made during that gap cannot remain
// stranded forever. This watchdog is inactive whenever any deadline exists.
const EMPTY_EXPIRY_RECONCILE_MS = 1_000;
const STORE_DAEMON_CLAIM_SCRIPT = defineRedisScript(
  'store-daemon-claim-with-deadline',
  `
-- merkur:store-daemon-claim-with-deadline
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local deadline = now + tonumber(ARGV[4])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[5])
redis.call('SADD', KEYS[3], ARGV[6])
redis.call('PEXPIRE', KEYS[3], ARGV[5])
redis.call('ZADD', KEYS[4], deadline, ARGV[7])
redis.call('PUBLISH', ARGV[8], 'changed')
return deadline
`,
);
const REFRESH_DAEMON_CLAIM_SCRIPT = defineRedisScript(
  'refresh-daemon-claim-with-deadline',
  `
-- merkur:refresh-daemon-claim-with-deadline
if not redis.call('GET', KEYS[1]) then
  return { 0, 0 }
end
local top = redis.call('ZREVRANGE', KEYS[2], 0, 0)
if #top == 0 then
  redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
elseif top[1] ~= ARGV[1] then
  return { 0, 0 }
end
local claimScore = redis.call('ZSCORE', KEYS[2], ARGV[1])
if not claimScore or tonumber(claimScore) ~= tonumber(ARGV[2]) then
  return { 0, 0 }
end
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local deadline = now + tonumber(ARGV[3])
local deadlineWasMissing = not redis.call('ZSCORE', KEYS[4], ARGV[5])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
redis.call('PEXPIRE', KEYS[3], ARGV[4])
redis.call('ZADD', KEYS[4], deadline, ARGV[5])
if deadlineWasMissing then
  redis.call('PUBLISH', ARGV[6], 'changed')
end
return { 1, deadline, deadlineWasMissing and 1 or 0 }
`,
);
const UNMARK_DAEMON_CLAIM_IF_CURRENT_SCRIPT = defineRedisScript(
  'unmark-daemon-claim-if-current',
  `
-- merkur:unmark-daemon-claim-if-current
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local claim = cjson.decode(raw)
-- Fence on the whole claim this call wrote, not just its identity. Suspension
-- rewrites the state and resume rewrites the state plus connectionId, while
-- leaving userId/presenceId/claimSeq and the claim ordering set untouched. A
-- fence that ignored those two fields would let a departing connection's scoped
-- release finalizer delete a lease that was deliberately held for its resume
-- window, or one that a reconnect had already resumed onto a new carrier —
-- destroying every session claim fenced by it in both cases.
if claim.userId ~= ARGV[1]
  or claim.presenceId ~= ARGV[2]
  or tonumber(claim.claimSeq) ~= tonumber(ARGV[3])
  or claim.ownerInstanceId ~= ARGV[4]
  or (claim.state ~= 'online' and claim.state ~= 'silent')
  or claim.connectionId ~= ARGV[7] then
  return 0
end
local top = redis.call('ZREVRANGE', KEYS[2], 0, 0)
local claimScore = redis.call('ZSCORE', KEYS[2], ARGV[2])
if #top == 0
  or top[1] ~= ARGV[2]
  or not claimScore
  or tonumber(claimScore) ~= tonumber(ARGV[3]) then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('SREM', KEYS[3], ARGV[5])
redis.call('ZREM', KEYS[4], ARGV[6])
-- The offline edge, sequenced atomically with the retirement.
local seq = redis.call('HINCRBY', KEYS[5], 'seq', 1)
redis.call('HSETNX', KEYS[5], 'epoch', ARGV[10])
redis.call('PUBLISH', ARGV[8], ARGV[9] .. ',"seq":' .. seq .. '}')
return 1
`,
);
const EXPIRE_DAEMON_CLAIM_IF_DUE_SCRIPT = defineRedisScript(
  'expire-daemon-claim-if-due',
  `
-- merkur:expire-daemon-claim-if-due
local deadlineScore = redis.call('ZSCORE', KEYS[4], ARGV[1])
if not deadlineScore then
  return { 0, 0 }
end
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
if tonumber(deadlineScore) > now then
  return { 0, deadlineScore }
end
local claimScore = redis.call('ZSCORE', KEYS[2], ARGV[2])
local top = redis.call('ZREVRANGE', KEYS[2], 0, 0)
if not claimScore
  or tonumber(claimScore) ~= tonumber(ARGV[3])
  or #top == 0
  or top[1] ~= ARGV[2] then
  redis.call('ZREM', KEYS[4], ARGV[1])
  return { 0, 0 }
end
if redis.call('GET', KEYS[1]) then
  local ttl = tonumber(redis.call('PTTL', KEYS[1]))
  if ttl < 0 then
    ttl = tonumber(ARGV[7])
    redis.call('PEXPIRE', KEYS[1], ARGV[7])
  end
  local nextDeadline = now + math.max(tonumber(ttl), 1)
  redis.call('ZADD', KEYS[4], nextDeadline, ARGV[1])
  return { 0, nextDeadline }
end
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('SREM', KEYS[3], ARGV[4])
local seq = redis.call('HINCRBY', KEYS[5], 'seq', 1)
redis.call('HSETNX', KEYS[5], 'epoch', ARGV[8])
redis.call('PUBLISH', ARGV[5], ARGV[6] .. ',"seq":' .. seq .. '}')
return { 1, 0 }
`,
);
// Holds a lease through its resume grace window instead of retiring it.
//
// Compare-and-swap on the exact raw claim string, and take the replacement
// whole from the caller. No script here may `cjson.encode` a claim: encoding
// does not preserve key order and formats numbers with `%.14g`, which would put
// a second, divergent serializer beside `JSON.stringify` in TypeScript and break
// every later CAS against the stored bytes.
const SUSPEND_DAEMON_CLAIM_IF_CURRENT_SCRIPT = defineRedisScript(
  'suspend-daemon-claim-if-current',
  `
-- merkur:suspend-daemon-claim-if-current
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
local top = redis.call('ZREVRANGE', KEYS[2], 0, 0)
local claimScore = redis.call('ZSCORE', KEYS[2], ARGV[3])
if #top == 0
  or top[1] ~= ARGV[3]
  or not claimScore
  or tonumber(claimScore) ~= tonumber(ARGV[4]) then
  return 0
end
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
-- PX the claim to the grace window too, so the lease self-retires on the exact
-- same schedule even if every replica dies before the scheduler fires.
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[5])
redis.call('ZADD', KEYS[3], now + tonumber(ARGV[5]), ARGV[6])
redis.call('PUBLISH', ARGV[7], 'changed')
-- The degraded edge, sequenced atomically with the suspension.
local seq = redis.call('HINCRBY', KEYS[4], 'seq', 1)
redis.call('HSETNX', KEYS[4], 'epoch', ARGV[10])
redis.call('PUBLISH', ARGV[8], ARGV[9] .. ',"seq":' .. seq .. '}')
return 1
`,
);
// Records observed silence — and its recovery — on a lease whose carrier is
// still up. A CAS-on-exact-bytes swap of `state` alone: the TTL is preserved
// because lease renewal owns it, and the device edge is published from inside
// the transition so no browser can observe the state without the edge.
const SWAP_DAEMON_CLAIM_STATE_IF_CURRENT_SCRIPT = defineRedisScript(
  'swap-daemon-claim-state-if-current',
  `
-- merkur:swap-daemon-claim-state-if-current
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
local top = redis.call('ZREVRANGE', KEYS[2], 0, 0)
local claimScore = redis.call('ZSCORE', KEYS[2], ARGV[3])
if #top == 0
  or top[1] ~= ARGV[3]
  or not claimScore
  or tonumber(claimScore) ~= tonumber(ARGV[4]) then
  return 0
end
local ttl = tonumber(redis.call('PTTL', KEYS[1]))
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
else
  redis.call('SET', KEYS[1], ARGV[2])
end
local seq = redis.call('HINCRBY', KEYS[3], 'seq', 1)
redis.call('HSETNX', KEYS[3], 'epoch', ARGV[7])
redis.call('PUBLISH', ARGV[5], ARGV[6] .. ',"seq":' .. seq .. '}')
return 1
`,
);
// Sequences and publishes a delta that no claim transition produces: the online
// edge (published after the connection is session-ready, never from the claim
// itself), renames, removals, and newly linked devices.
const PUBLISH_DEVICE_DELTA_SCRIPT = defineRedisScript(
  'publish-device-delta',
  `
-- merkur:publish-device-delta
local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
redis.call('HSETNX', KEYS[1], 'epoch', ARGV[3])
redis.call('PUBLISH', ARGV[1], ARGV[2] .. ',"seq":' .. seq .. '}')
return seq
`,
);
// Reads the cursor a stream opens against, minting the epoch when the counter
// does not exist yet.
//
// A read that creates something looks odd until you ask what the alternative
// is: a browser that opened before this account's first device transition would
// hold a seq with no epoch to pin it to, and would have to be answered with a
// snapshot on every reconnect for as long as nothing ever changed. Minting here
// makes the cursor total — every stream has one, from the first open — and
// `HSETNX` makes it the same value a concurrent publisher would have minted.
const READ_DEVICE_EVENTS_CURSOR_SCRIPT = defineRedisScript(
  'read-device-events-cursor',
  `
-- merkur:read-device-events-cursor
redis.call('HSETNX', KEYS[1], 'epoch', ARGV[1])
local cursor = redis.call('HMGET', KEYS[1], 'epoch', 'seq')
return { cursor[1], cursor[2] or '0' }
`,
);
// Reverse of the suspend swap: takes a suspended lease back to `online` under a
// new carrier and owner, restoring the full lease TTL. Same CAS-on-exact-bytes
// discipline — both strings are authored by `serializeDaemonPresence`.
const RESUME_DAEMON_CLAIM_IF_SUSPENDED_SCRIPT = defineRedisScript(
  'resume-daemon-claim-if-suspended',
  `
-- merkur:resume-daemon-claim-if-suspended
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
local top = redis.call('ZREVRANGE', KEYS[2], 0, 0)
local claimScore = redis.call('ZSCORE', KEYS[2], ARGV[3])
if #top == 0
  or top[1] ~= ARGV[3]
  or not claimScore
  or tonumber(claimScore) ~= tonumber(ARGV[4]) then
  return 0
end
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[5])
redis.call('PEXPIRE', KEYS[2], ARGV[6])
redis.call('SADD', KEYS[3], ARGV[7])
redis.call('PEXPIRE', KEYS[3], ARGV[6])
redis.call('ZADD', KEYS[4], now + tonumber(ARGV[5]), ARGV[8])
redis.call('PUBLISH', ARGV[9], 'changed')
return 1
`,
);
const REMOVE_SESSION_CLAIM_IF_CURRENT_SCRIPT = defineRedisScript(
  'remove-session-claim-if-current',
  `
-- merkur:remove-session-claim-if-current
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[2])
return 1
`,
);
const CREATE_SESSION_FOR_DAEMON_CLAIM_SCRIPT = defineRedisScript(
  'create-session-for-daemon-claim',
  `
-- merkur:create-session-for-daemon-claim
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
local top = redis.call('ZREVRANGE', KEYS[2], '0', '0')
local claimScore = redis.call('ZSCORE', KEYS[2], ARGV[2])
if #top == 0
  or top[1] ~= ARGV[2]
  or not claimScore
  or tonumber(claimScore) ~= tonumber(ARGV[3]) then
  return 0
end
redis.call('SET', KEYS[3], ARGV[4], 'PX', ARGV[6])
redis.call('SADD', KEYS[4], ARGV[5])
redis.call('PEXPIRE', KEYS[4], ARGV[6])
return 1
`,
);
const REALTIME_COORDINATION_SCRIPTS = [
  STORE_DAEMON_CLAIM_SCRIPT,
  REFRESH_DAEMON_CLAIM_SCRIPT,
  UNMARK_DAEMON_CLAIM_IF_CURRENT_SCRIPT,
  SUSPEND_DAEMON_CLAIM_IF_CURRENT_SCRIPT,
  SWAP_DAEMON_CLAIM_STATE_IF_CURRENT_SCRIPT,
  PUBLISH_DEVICE_DELTA_SCRIPT,
  READ_DEVICE_EVENTS_CURSOR_SCRIPT,
  RESUME_DAEMON_CLAIM_IF_SUSPENDED_SCRIPT,
  EXPIRE_DAEMON_CLAIM_IF_DUE_SCRIPT,
  REMOVE_SESSION_CLAIM_IF_CURRENT_SCRIPT,
  CREATE_SESSION_FOR_DAEMON_CLAIM_SCRIPT,
] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * What a device-events subscriber receives: a sequenced delta, or the signal
 * that the pub/sub carrier was lost and anything streamed on it must resync.
 */
export type DeviceEventSignal =
  | { readonly _tag: 'delta'; readonly frame: DeviceDeltaFrame }
  | { readonly _tag: 'resync' };

export type DeviceEventListener = (signal: DeviceEventSignal) => void;

/**
 * Lease disposition.
 *
 * - `online` — the carrier is up and pinging.
 * - `silent` — the carrier is up but pings have stopped; nothing about the
 *   lease changes, only what the browser is told. It clears on the next ping.
 * - `suspended` — the carrier dropped and the claim is being held through its
 *   resume grace window, so the presence — and every session claim fenced by
 *   it — survives a reattach.
 *
 * Deliberately a different vocabulary from the wire-facing `DeviceStatus`:
 * `silent` and `suspended` both read as `degraded` there, and the remaining
 * case (no presence entry at all ⇒ offline) is resolved in `listDevices`.
 */
export type DaemonPresenceState = (typeof DAEMON_PRESENCE_STATES)[number];

export interface DaemonPresence {
  readonly daemonId: string;
  readonly userId: string;
  readonly ownerInstanceId: string;
  readonly connectionId: string;
  readonly presenceId: string;
  readonly claimSeq: number;
  readonly state: DaemonPresenceState;
  readonly updatedAt: number;
  /**
   * Coarse geographic zone of the address this daemon connected from, resolved
   * once at the control upgrade.
   *
   * `null` when the address could not be placed — a private or reserved source,
   * or a registry block with no delegation. Edge selection treats that as "no
   * opinion" and falls back to its deterministic hash.
   *
   * The zone is stored; the address is not. Session issuance reads this record
   * on the critical path already, so nearest-edge selection costs no extra I/O,
   * and keeping only the zone means no new PII lands in Redis.
   */
  readonly zone: IpZone | null;
}

export type ClaimDaemonOnlineResult =
  | { readonly _tag: 'Claimed'; readonly claimSeq: number }
  | { readonly _tag: 'Superseded'; readonly claimSeq: number };

export interface DaemonLeaseIdentity {
  readonly daemonId: string;
  readonly userId: string;
  readonly presenceId: string;
  readonly claimSeq: number;
}

export interface DaemonCarrierIdentity extends DaemonLeaseIdentity {
  /** Fenced against the stored claim: only the current carrier may describe it. */
  readonly connectionId: string;
}

/**
 * One item of a batched renewal. `invalid` means Redis answered for this claim
 * with something this code cannot read; it retires that one lease rather than
 * failing the batch.
 */
export type DaemonLeaseRenewal =
  | {
      readonly presence: 'refreshed' | 'not-owner';
      readonly revocationGeneration: number;
    }
  | { readonly presence: 'invalid' };

/** `not-current`: this lease is no longer this carrier's to describe. */
export type DaemonSilenceTransition = 'changed' | 'already' | 'not-current';

export type CreatedSessionPresence = DaemonPresence;

export interface RealtimeCoordinationService {
  readonly instanceId: string;
  readonly healthSnapshot: () => Effect.Effect<RealtimeCoordinationHealthSnapshot>;
  readonly awaitCriticalFailure: Effect.Effect<never>;
  claimDaemonOnline(
    input: DaemonPresenceInput,
  ): Effect.Effect<ClaimDaemonOnlineResult, RedisError, Scope.Scope>;
  /**
   * Renews every lease in one pipelined round trip: one TTL refresh per claim
   * plus one revocation-generation read per distinct user. Results are
   * positional. Fails as a whole only on transport errors.
   */
  renewDaemonLeases(
    inputs: readonly DaemonLeaseIdentity[],
  ): Effect.Effect<readonly DaemonLeaseRenewal[], RedisError>;
  /**
   * Records that this carrier's pings have stopped, or resumed. A swap of the
   * stored state only — TTL, deadline and sessions are untouched — published
   * as a device edge from inside the transition.
   */
  markDaemonSilent(
    input: DaemonCarrierIdentity,
  ): Effect.Effect<DaemonSilenceTransition, RedisError>;
  clearDaemonSilent(
    input: DaemonCarrierIdentity,
  ): Effect.Effect<DaemonSilenceTransition, RedisError>;
  unmarkDaemonOnline(input: {
    readonly daemonId: string;
    readonly userId: string;
    readonly presenceId: string;
    readonly claimSeq: number;
    /** Fenced against the stored claim: only the current carrier may retire it. */
    readonly connectionId: string;
  }): Effect.Effect<boolean, RedisError>;
  /**
   * Marks a lease `suspended` and shortens its expiry to the resume grace
   * window, rather than retiring it. The daemon keeps its `presenceId` and
   * `claimSeq` — and therefore every session claim fenced by them — if it
   * reattaches in time. Returns false when this presence is no longer current,
   * in which case nothing was written.
   */
  suspendDaemonPresence(input: {
    readonly daemonId: string;
    readonly userId: string;
    readonly presenceId: string;
    readonly claimSeq: number;
  }): Effect.Effect<boolean, RedisError>;
  /**
   * Reclaims a suspended lease for a daemon that came back inside its grace
   * window, keeping `presenceId` and `claimSeq` — and therefore every session
   * claim fenced by them — and taking over ownership on this instance.
   *
   * Returns the reclaimed `claimSeq`, or null when there is nothing to reclaim:
   * the lease expired, was superseded, or is still online elsewhere. Callers
   * fall back to a fresh claim, which is a new lease, not a retry.
   */
  resumeDaemonPresence(input: {
    readonly daemonId: string;
    readonly userId: string;
    readonly presenceId: string;
    readonly connectionId: string;
    readonly zone: IpZone | null;
  }): Effect.Effect<number | null, RedisError>;
  getDaemonPresence(daemonId: string): Effect.Effect<DaemonPresence | null, RedisError>;
  getUserDaemonPresence(userId: string): Effect.Effect<DaemonPresence[], RedisError>;
  /**
   * Publishes one absolute device delta under the user's next sequence number.
   * Loss edges are published from inside their own Lua transitions; this is for
   * everything else — the online edge, renames, removals, newly linked devices.
   */
  publishDeviceDelta(userId: string, delta: DeviceEventDelta): Effect.Effect<void, RedisError>;
  /** The user's current device-events sequence; `0` before any delta. */
  /**
   * The cursor a new stream opens against, minting the epoch if this account
   * has no counter yet.
   */
  readDeviceEventsCursor(userId: string): Effect.Effect<DeviceEventsCursor, RedisError>;
  subscribeDeviceEvents(
    userId: string,
    listener: DeviceEventListener,
  ): Effect.Effect<Effect.Effect<void>, RedisError>;
  incrementRevocationGeneration(userId: string): Effect.Effect<number, RedisError>;
  createSessionForDaemonPresence(input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly daemonId: string;
    readonly browserNodeId: string;
  }): Effect.Effect<CreatedSessionPresence | null, RedisError>;
  removeSessionForUser(input: {
    readonly sessionId: string;
    readonly userId: string;
  }): Effect.Effect<void, RedisError>;
  removeDaemonSessions(input: {
    readonly daemonId: string;
    readonly userId: string;
    readonly presenceId: string;
    readonly claimSeq: number;
  }): Effect.Effect<void, RedisError>;
}

export interface RealtimeCoordinationHealthSnapshot {
  readonly presenceExpirySchedulerHealthy: boolean;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface DaemonPresenceInput {
  readonly daemonId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly presenceId: string;
  readonly zone: IpZone | null;
}

interface SessionClaim {
  readonly daemonId: string;
  readonly userId: string;
  readonly browserNodeId: string;
  readonly presenceId: string;
  readonly claimSeq: number;
}

interface ResolvedDaemonPresence {
  readonly presence: DaemonPresence;
  readonly raw: string;
}

interface ClaimIdentity {
  readonly daemonId: string;
  readonly presenceId: string;
  readonly claimSeq: number;
}

interface PresenceDeadlineIdentity extends ClaimIdentity {
  readonly userId: string;
}

interface PresenceDeadlineSnapshot {
  readonly identity: PresenceDeadlineIdentity;
  readonly member: string;
  readonly delayMs: number;
}

// ---------------------------------------------------------------------------
// Service tag and live layer
// ---------------------------------------------------------------------------

export class RealtimeCoordinationServiceTag extends Context.Service<
  RealtimeCoordinationServiceTag,
  RealtimeCoordinationService
>()('RealtimeCoordinationService') {}

export const RealtimeCoordinationServiceLive = Layer.effect(
  RealtimeCoordinationServiceTag,
  Effect.gen(function* () {
    const redis = yield* RedisServiceTag;
    yield* preloadRedisScripts(redis, REALTIME_COORDINATION_SCRIPTS);
    const logger = createLogger('server');
    const expiryWakeQueue = yield* Queue.sliding<void>(1);
    const wakeExpiryScheduler = (): void => {
      Queue.offerUnsafe(expiryWakeQueue, undefined);
    };
    const criticalFailure = yield* Deferred.make<never>();
    const service = createRealtimeCoordinationService(
      redis,
      logger,
      wakeExpiryScheduler,
      criticalFailure,
    );

    yield* Effect.addFinalizer(() => service.cleanup);
    yield* Effect.acquireRelease(
      redis.subscribe(DAEMON_PRESENCE_DEADLINE_EVENTS_CHANNEL, wakeExpiryScheduler),
      () =>
        redis
          .unsubscribe(DAEMON_PRESENCE_DEADLINE_EVENTS_CHANNEL, wakeExpiryScheduler)
          .pipe(Effect.ignore),
    );
    // Deltas published while the subscriber was down are gone. Every stream
    // fed by it is told to resync rather than silently run on with a gap.
    yield* Effect.acquireRelease(
      redis.onSubscriberReconnected?.(service.signalDeviceEventResync) ??
        Effect.succeed(Effect.void),
      (unregister) => unregister,
    );
    yield* runPresenceExpiryScheduler(redis, expiryWakeQueue, logger).pipe(
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
        const cause = Exit.isFailure(exit)
          ? exit.cause
          : Cause.die(new Error('presence expiry scheduler completed unexpectedly'));
        return service.reportPresenceExpirySchedulerFailure(cause);
      }),
      Effect.forkScoped,
    );
    wakeExpiryScheduler();
    return service;
  }),
);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface RealtimeCoordinationRuntime extends RealtimeCoordinationService {
  readonly cleanup: Effect.Effect<void>;
  readonly reportPresenceExpirySchedulerFailure: (
    cause: Cause.Cause<unknown>,
  ) => Effect.Effect<void>;
  /** Tells every device-events listener that its carrier was lost. */
  readonly signalDeviceEventResync: () => void;
}

type LoggerLike = Logger;

interface DeviceEventSubscriptionBase {
  readonly channel: string;
  readonly listeners: Set<DeviceEventListener>;
  readonly listenerReferenceCounts: Map<DeviceEventListener, number>;
  readonly handler: (payload: string) => void;
}

interface InitializingDeviceEventSubscription extends DeviceEventSubscriptionBase {
  readonly _tag: 'Initializing';
  readonly ready: Deferred.Deferred<void, RedisError>;
}

interface ActiveDeviceEventSubscription extends DeviceEventSubscriptionBase {
  readonly _tag: 'Active';
}

type DeviceEventSubscription = InitializingDeviceEventSubscription | ActiveDeviceEventSubscription;

function createRealtimeCoordinationService(
  redis: RedisService,
  logger: LoggerLike,
  wakeExpiryScheduler: () => void,
  criticalFailure: Deferred.Deferred<never>,
): RealtimeCoordinationRuntime {
  const instanceId = crypto.randomUUID();
  const deviceEventSubscriptionsByUserId = new Map<string, DeviceEventSubscription>();
  let presenceExpirySchedulerHealthy = true;
  let closed = false;

  function removeDeviceEventListener(
    userId: string,
    expectedListeners: Set<DeviceEventListener>,
    listener: DeviceEventListener,
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      const subscription = deviceEventSubscriptionsByUserId.get(userId);
      if (subscription === undefined || subscription.listeners !== expectedListeners) {
        return Effect.void;
      }
      const referenceCount = subscription.listenerReferenceCounts.get(listener);
      if (referenceCount === undefined) return Effect.void;
      if (referenceCount > 1) {
        subscription.listenerReferenceCounts.set(listener, referenceCount - 1);
        return Effect.void;
      }
      subscription.listenerReferenceCounts.delete(listener);
      subscription.listeners.delete(listener);
      if (subscription.listeners.size > 0) return Effect.void;
      deviceEventSubscriptionsByUserId.delete(userId);
      return unsubscribeDeviceEventSubscription(subscription);
    });
  }

  function addDeviceEventListener(
    userId: string,
    subscription: DeviceEventSubscription,
    listener: DeviceEventListener,
  ): Effect.Effect<void> {
    subscription.listeners.add(listener);
    subscription.listenerReferenceCounts.set(
      listener,
      (subscription.listenerReferenceCounts.get(listener) ?? 0) + 1,
    );
    let removed = false;
    return Effect.suspend(() => {
      if (removed) return Effect.void;
      removed = true;
      return removeDeviceEventListener(userId, subscription.listeners, listener);
    });
  }

  function unsubscribeDeviceEventSubscription(
    subscription: DeviceEventSubscription,
  ): Effect.Effect<void> {
    const unsubscribe = redis
      .unsubscribe(subscription.channel, subscription.handler)
      .pipe(Effect.ignore);
    if (subscription._tag === 'Active') {
      return unsubscribe;
    }
    return Effect.flatMap(Effect.exit(Deferred.await(subscription.ready)), (exit) =>
      Exit.isSuccess(exit) ? unsubscribe : Effect.void,
    );
  }

  function releaseStoredDaemonClaim(presence: DaemonPresence): Effect.Effect<void> {
    const deadlineIdentity: PresenceDeadlineIdentity = presence;
    return redis
      .useCommands(async (commands) => {
        const removed = parseRedisFlag(
          await evalRedisScript(
            commands,
            UNMARK_DAEMON_CLAIM_IF_CURRENT_SCRIPT,
            [
              daemonClaimKey(presence.daemonId, presence.presenceId),
              daemonClaimsKey(presence.daemonId),
              userOnlineDaemonsKey(presence.userId),
              DAEMON_PRESENCE_DEADLINES_KEY,
              deviceEventsCursorKey(presence.userId),
            ],
            [
              presence.userId,
              presence.presenceId,
              String(presence.claimSeq),
              instanceId,
              presence.daemonId,
              presenceDeadlineMember(deadlineIdentity),
              presence.connectionId,
              deviceEventsChannel(presence.userId),
              createDeviceDeltaPrefix(presence.userId, {
                kind: 'presence',
                daemonId: presence.daemonId,
                status: presenceStateToDeviceStatus(undefined),
              }),
              newDeviceEventsEpoch(),
            ],
          ),
          'scoped daemon claim release',
        );
        return removed;
      })
      .pipe(
        Effect.tap((removed) =>
          Effect.sync(() => {
            if (removed) wakeExpiryScheduler();
          }),
        ),
        Effect.tap((removed) =>
          removed
            ? redis.useCommands((commands) => removeClaimSessions(commands, presence))
            : Effect.void,
        ),
        Effect.catch((error) =>
          logWithLoggerEffect(logger, 'error', 'coordination_scoped_presence_release_failed', {
            daemonId: presence.daemonId,
            presenceId: presence.presenceId,
            claimSeq: presence.claimSeq,
            ...errorLogContext(error),
          }),
        ),
        Effect.asVoid,
      );
  }

  const service: RealtimeCoordinationRuntime = {
    instanceId,
    healthSnapshot: () =>
      Effect.sync(() => ({
        presenceExpirySchedulerHealthy,
      })),
    awaitCriticalFailure: Deferred.await(criticalFailure),
    reportPresenceExpirySchedulerFailure: (cause) => {
      const defect =
        cause.reasons.find(Cause.isDieReason)?.defect ??
        new Error('presence expiry scheduler failed unexpectedly');
      return Effect.sync(() => {
        presenceExpirySchedulerHealthy = false;
      }).pipe(
        Effect.andThen(
          logWithLoggerEffect(logger, 'error', 'coordination_presence_expiry_scheduler_failed', {
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.andThen(
          Metric.update(backgroundWorkerFailureFrequency, 'realtime-coordination:presence-expiry'),
        ),
        Effect.andThen(Deferred.die(criticalFailure, defect)),
        Effect.asVoid,
      );
    },
    signalDeviceEventResync: () => {
      for (const subscription of deviceEventSubscriptionsByUserId.values()) {
        notifyDeviceEventListeners(subscription.listeners, logger, { _tag: 'resync' });
      }
    },
    cleanup: Effect.suspend(() => {
      closed = true;
      const subscriptions = Array.from(deviceEventSubscriptionsByUserId.values());
      deviceEventSubscriptionsByUserId.clear();
      for (const subscription of subscriptions) {
        subscription.listeners.clear();
        subscription.listenerReferenceCounts.clear();
      }
      return Effect.all(subscriptions.map(unsubscribeDeviceEventSubscription), {
        discard: true,
        mode: 'result',
      }).pipe(Effect.ignore);
    }),

    // ------------------------------------------------------------------
    // Claim: establish ownership of a daemon (cold path, once per connect)
    // ------------------------------------------------------------------
    claimDaemonOnline(input): Effect.Effect<ClaimDaemonOnlineResult, RedisError, Scope.Scope> {
      return Effect.gen(function* () {
        const updatedAt = yield* Clock.currentTimeMillis;
        // Resolve the sequence independently. If this command has an unknown
        // timeout outcome, no claim write is chained inside its Promise
        // continuation, so the only possible orphan is a harmless skipped
        // sequence number.
        const claimSeq = yield* redis.useCommands(async (commands) =>
          parseRedisPositiveSafeInteger(
            await commands.sendCommand(['INCR', DAEMON_CLAIM_SEQUENCE_KEY]),
            'daemon claim sequence',
          ),
        );
        const presence = buildDaemonPresence(input, {
          claimSeq,
          ownerInstanceId: instanceId,
          state: 'online',
          updatedAt,
        });

        // Install the fenced release before issuing the atomic write. Redis
        // command ordering guarantees that, even if the write times out locally
        // but later executes, cleanup submitted by this finalizer follows it.
        // This closes both interruption and unknown-outcome timeout windows.
        yield* Effect.acquireRelease(Effect.succeed(presence), releaseStoredDaemonClaim);
        yield* redis.useCommands((commands) => storeDaemonClaim(commands, presence));
        wakeExpiryScheduler();

        return yield* redis.useCommands<ClaimDaemonOnlineResult>(async (commands) => {
          await cleanupSupersededClaims(commands, presence);

          // Verify we won the claim race (highest seq in the sorted set)
          const winner = await getCurrentDaemonPresence(commands, input.daemonId);
          if (
            winner !== null &&
            winner.presenceId === presence.presenceId &&
            winner.claimSeq === presence.claimSeq
          ) {
            // No device edge here. The control service announces the daemon
            // online only once its connection is session-ready; publishing
            // from the claim would invite a `session_start` into a daemon that
            // cannot admit one yet, and on the losing branch below there would
            // be no corrective edge.
            return { _tag: 'Claimed', claimSeq: presence.claimSeq };
          }

          // We lost — clean up our claim. The scoped finalizer remains as an
          // idempotent fallback and observes that this exact claim is gone.
          await removeDaemonClaim(commands, presence);
          if (winner === null || winner.userId !== presence.userId) {
            await commands.sendCommand([
              'SREM',
              userOnlineDaemonsKey(presence.userId),
              presence.daemonId,
            ]);
          }
          return { _tag: 'Superseded', claimSeq: presence.claimSeq };
        });
      });
    },

    // ------------------------------------------------------------------
    // Lease renewal: batched TTL refresh, every ~20s per daemon
    // ------------------------------------------------------------------
    renewDaemonLeases(inputs): Effect.Effect<readonly DaemonLeaseRenewal[], RedisError> {
      if (inputs.length === 0) return Effect.succeed([]);
      return redis.useCommands(async (commands) => {
        const userIds = Array.from(new Set(inputs.map((input) => input.userId)));
        // Every command is issued before any reply is awaited, so the batch is
        // one pipelined round trip: N renewals plus one revocation read per
        // distinct user, never one per daemon. Within each renewal, ownership
        // verification, claim TTL renewal, and durable deadline rescheduling
        // are one Redis transition, so an expiry worker can never observe a
        // renewed claim paired with its old due time (or vice versa).
        const [rawRefreshes, rawRevocations] = await Promise.all([
          Promise.all(
            inputs.map((input) =>
              evalRedisScript(
                commands,
                REFRESH_DAEMON_CLAIM_SCRIPT,
                [
                  daemonClaimKey(input.daemonId, input.presenceId),
                  daemonClaimsKey(input.daemonId),
                  userOnlineDaemonsKey(input.userId),
                  DAEMON_PRESENCE_DEADLINES_KEY,
                ],
                [
                  input.presenceId,
                  String(input.claimSeq),
                  String(DAEMON_ONLINE_TTL_MS),
                  String(INDEX_TTL_MS),
                  presenceDeadlineMember(input),
                  DAEMON_PRESENCE_DEADLINE_EVENTS_CHANNEL,
                ],
              ),
            ),
          ),
          Promise.all(
            userIds.map((userId) => commands.sendCommand(['GET', revocationKey(userId)])),
          ),
        ]);

        const generationByUserId = new Map<string, number | null>();
        userIds.forEach((userId, index) => {
          generationByUserId.set(userId, parseRevocationGeneration(rawRevocations[index]));
        });

        // Session claims are owned by the create/cancel edges and retain their
        // five-minute crash-fallback lease. Never enumerate or renew the claim
        // index from a renewal: doing so made abandoned browser sessions
        // immortal and turned one O(1) liveness edge into an unbounded Redis
        // fan-out every period.
        return inputs.map((input, index): DaemonLeaseRenewal => {
          const revocationGeneration = generationByUserId.get(input.userId) ?? null;
          if (revocationGeneration === null) return { presence: 'invalid' };
          // A malformed reply retires this one claim, not the whole batch —
          // and, under the batched ticker, not the whole instance.
          let refreshed: boolean;
          try {
            refreshed = parseDaemonClaimRefreshResult(rawRefreshes[index]);
          } catch {
            return { presence: 'invalid' };
          }
          return { presence: refreshed ? 'refreshed' : 'not-owner', revocationGeneration };
        });
      });
    },

    markDaemonSilent(input): Effect.Effect<DaemonSilenceTransition, RedisError> {
      return swapDaemonSilence(redis, instanceId, input, 'silent');
    },

    clearDaemonSilent(input): Effect.Effect<DaemonSilenceTransition, RedisError> {
      return swapDaemonSilence(redis, instanceId, input, 'online');
    },

    // ------------------------------------------------------------------
    // Disconnect: relinquish ownership if we still hold it
    // ------------------------------------------------------------------
    unmarkDaemonOnline(input): Effect.Effect<boolean, RedisError> {
      return redis.useCommands(async (commands) => {
        const deadlineIdentity: PresenceDeadlineIdentity = {
          daemonId: input.daemonId,
          userId: input.userId,
          presenceId: input.presenceId,
          claimSeq: input.claimSeq,
        };
        const removed = parseRedisFlag(
          await evalRedisScript(
            commands,
            UNMARK_DAEMON_CLAIM_IF_CURRENT_SCRIPT,
            [
              daemonClaimKey(input.daemonId, input.presenceId),
              daemonClaimsKey(input.daemonId),
              userOnlineDaemonsKey(input.userId),
              DAEMON_PRESENCE_DEADLINES_KEY,
              deviceEventsCursorKey(input.userId),
            ],
            [
              input.userId,
              input.presenceId,
              String(input.claimSeq),
              instanceId,
              input.daemonId,
              presenceDeadlineMember(deadlineIdentity),
              input.connectionId,
              deviceEventsChannel(input.userId),
              createDeviceDeltaPrefix(input.userId, {
                kind: 'presence',
                daemonId: input.daemonId,
                status: presenceStateToDeviceStatus(undefined),
              }),
              newDeviceEventsEpoch(),
            ],
          ),
          'daemon unmark result',
        );
        if (removed) wakeExpiryScheduler();
        return removed;
      });
    },

    suspendDaemonPresence(input): Effect.Effect<boolean, RedisError> {
      return redis.useCommands(async (commands) => {
        // A silence transition already on the wire can land between the read
        // and the swap. It is not a competing owner — identity, owner and
        // carrier are untouched by it — so a miss is re-read and retried,
        // bounded. Treating it as a loss would fall through to a full release
        // and destroy the sessions this suspend exists to preserve.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await getCurrentDaemonPresence(commands, input.daemonId);
          if (
            current === null ||
            current.userId !== input.userId ||
            current.presenceId !== input.presenceId ||
            current.claimSeq !== input.claimSeq ||
            current.ownerInstanceId !== instanceId ||
            current.state === 'suspended'
          ) {
            return false;
          }
          // Both sides of the swap are authored here, by the one serializer
          // that writes claims. The script only compares and stores bytes.
          const expectedRaw = serializeDaemonPresence(current);
          const suspendedRaw = serializeDaemonPresence({ ...current, state: 'suspended' });
          const suspended = parseRedisFlag(
            await evalRedisScript(
              commands,
              SUSPEND_DAEMON_CLAIM_IF_CURRENT_SCRIPT,
              [
                daemonClaimKey(input.daemonId, input.presenceId),
                daemonClaimsKey(input.daemonId),
                DAEMON_PRESENCE_DEADLINES_KEY,
                deviceEventsCursorKey(input.userId),
              ],
              [
                expectedRaw,
                suspendedRaw,
                input.presenceId,
                String(input.claimSeq),
                String(DAEMON_CONTROL_RESUME_GRACE_MS),
                presenceDeadlineMember({
                  daemonId: input.daemonId,
                  userId: input.userId,
                  presenceId: input.presenceId,
                  claimSeq: input.claimSeq,
                }),
                DAEMON_PRESENCE_DEADLINE_EVENTS_CHANNEL,
                deviceEventsChannel(input.userId),
                createDeviceDeltaPrefix(input.userId, {
                  kind: 'presence',
                  daemonId: input.daemonId,
                  status: presenceStateToDeviceStatus('suspended'),
                }),
                newDeviceEventsEpoch(),
              ],
            ),
            'daemon suspend result',
          );
          if (suspended) {
            wakeExpiryScheduler();
            return true;
          }
        }
        return false;
      });
    },

    resumeDaemonPresence(input): Effect.Effect<number | null, RedisError> {
      return redis.useCommands(async (commands) => {
        const current = await getCurrentDaemonPresence(commands, input.daemonId);
        if (
          current === null ||
          current.userId !== input.userId ||
          current.presenceId !== input.presenceId ||
          current.state !== 'suspended'
        ) {
          return null;
        }
        const expectedRaw = serializeDaemonPresence(current);
        const resumedRaw = serializeDaemonPresence({
          ...current,
          // Ownership and carrier move to whoever accepted the reconnect; the
          // lease identity a session claim is fenced by does not.
          ownerInstanceId: instanceId,
          connectionId: input.connectionId,
          state: 'online',
          // The reconnect observed a fresh address. A daemon that moved
          // networks while suspended is exactly the case where the stored zone
          // is stale, and it is also the case where getting it right matters.
          zone: input.zone,
        });
        const resumed = parseRedisFlag(
          await evalRedisScript(
            commands,
            RESUME_DAEMON_CLAIM_IF_SUSPENDED_SCRIPT,
            [
              daemonClaimKey(input.daemonId, input.presenceId),
              daemonClaimsKey(input.daemonId),
              userOnlineDaemonsKey(input.userId),
              DAEMON_PRESENCE_DEADLINES_KEY,
            ],
            [
              expectedRaw,
              resumedRaw,
              input.presenceId,
              String(current.claimSeq),
              String(DAEMON_ONLINE_TTL_MS),
              String(INDEX_TTL_MS),
              input.daemonId,
              presenceDeadlineMember({
                daemonId: input.daemonId,
                userId: input.userId,
                presenceId: input.presenceId,
                claimSeq: current.claimSeq,
              }),
              DAEMON_PRESENCE_DEADLINE_EVENTS_CHANNEL,
            ],
          ),
          'daemon resume result',
        );
        if (!resumed) return null;
        wakeExpiryScheduler();
        // No device edge here: a resumed lease is announced online by the
        // control service once the connection is session-ready, exactly like a
        // fresh claim, so a browser never connects into a not-yet-ready daemon.
        return current.claimSeq;
      });
    },

    // ------------------------------------------------------------------
    // Queries
    // ------------------------------------------------------------------
    getDaemonPresence(daemonId: string): Effect.Effect<DaemonPresence | null, RedisError> {
      return redis.useCommands((commands) => getCurrentDaemonPresence(commands, daemonId));
    },

    getUserDaemonPresence(userId: string): Effect.Effect<DaemonPresence[], RedisError> {
      return redis.useCommands(async (commands) => {
        const key = userOnlineDaemonsKey(userId);
        const daemonIds = parseRedisStringArray(
          await commands.sendCommand(['SMEMBERS', key]),
          'online daemon identity set',
        );
        const presence: DaemonPresence[] = [];
        const staleDaemonIds: string[] = [];

        // Resolve every daemon's claim concurrently (the client pipelines
        // in-flight commands) instead of one sequential round-trip per daemon.
        const resolved = await Promise.all(
          daemonIds.map(async (daemonId) => ({
            daemonId,
            current: await getCurrentDaemonPresence(commands, daemonId),
          })),
        );
        for (const { daemonId, current } of resolved) {
          if (current !== null && current.userId === userId) {
            presence.push(current);
          } else {
            staleDaemonIds.push(daemonId);
          }
        }

        if (staleDaemonIds.length > 0) {
          await commands.sendCommand(['SREM', key, ...staleDaemonIds]);
        }
        return presence;
      });
    },

    // ------------------------------------------------------------------
    // Pub/sub
    // ------------------------------------------------------------------
    publishDeviceDelta(userId, delta): Effect.Effect<void, RedisError> {
      // Delivered to local listeners through the subscriber echo like every
      // other delta, so sequence order on the channel is the only order.
      return redis.useCommands(async (commands) => {
        await evalRedisScript(
          commands,
          PUBLISH_DEVICE_DELTA_SCRIPT,
          [deviceEventsCursorKey(userId)],
          [
            deviceEventsChannel(userId),
            createDeviceDeltaPrefix(userId, delta),
            newDeviceEventsEpoch(),
          ],
        );
      });
    },

    readDeviceEventsCursor(userId): Effect.Effect<DeviceEventsCursor, RedisError> {
      return redis.useCommands(async (commands) => {
        const raw = await evalRedisScript(
          commands,
          READ_DEVICE_EVENTS_CURSOR_SCRIPT,
          [deviceEventsCursorKey(userId)],
          [newDeviceEventsEpoch()],
        );
        const [epoch, seq] = parseRedisNullableStringArray(raw, 2, 'device events cursor');
        return {
          epoch: parseDeviceEventsEpoch(epoch),
          seq: parseRedisNonNegativeSafeInteger(seq, 'device events sequence'),
        };
      });
    },

    subscribeDeviceEvents(
      userId: string,
      listener: DeviceEventListener,
    ): Effect.Effect<Effect.Effect<void>, RedisError> {
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (closed) {
            return yield* new RedisError({
              cause: null,
              message: 'Realtime coordination service is closed',
            });
          }

          const existing = deviceEventSubscriptionsByUserId.get(userId);
          if (existing !== undefined) {
            const cleanup = addDeviceEventListener(userId, existing, listener);
            if (existing._tag === 'Initializing') {
              yield* restore(Deferred.await(existing.ready)).pipe(
                Effect.onInterrupt(() => cleanup),
              );
            }
            return cleanup;
          }

          const candidateReady = yield* Deferred.make<void, RedisError>();
          const channel = deviceEventsChannel(userId);
          const listeners = new Set<DeviceEventListener>();
          const listenerReferenceCounts = new Map<DeviceEventListener, number>();
          const handler = (payload: string): void => {
            if (payload === 'resync') {
              notifyDeviceEventListeners(listeners, logger, { _tag: 'resync' });
              return;
            }
            const frame = parseDeviceDeltaPayload(payload, userId);
            if (frame === null) {
              logger.warn('coordination_device_event_invalid');
              return;
            }
            notifyDeviceEventListeners(listeners, logger, { _tag: 'delta', frame });
          };
          const initializing: InitializingDeviceEventSubscription = {
            _tag: 'Initializing',
            channel,
            listeners,
            listenerReferenceCounts,
            handler,
            ready: candidateReady,
          };
          const cleanup = addDeviceEventListener(userId, initializing, listener);
          deviceEventSubscriptionsByUserId.set(userId, initializing);

          // Native subscribe is not cancelable. Finish the one shared
          // acquisition before publishing its result to every waiter.
          const subscriptionExit = yield* Effect.exit(redis.subscribe(channel, handler));
          if (deviceEventSubscriptionsByUserId.get(userId) === initializing) {
            if (Exit.isSuccess(subscriptionExit)) {
              deviceEventSubscriptionsByUserId.set(userId, {
                _tag: 'Active',
                channel,
                listeners,
                listenerReferenceCounts,
                handler,
              });
            } else {
              deviceEventSubscriptionsByUserId.delete(userId);
              listeners.clear();
              listenerReferenceCounts.clear();
            }
          }
          yield* Deferred.done(candidateReady, subscriptionExit);
          yield* restore(Deferred.await(candidateReady)).pipe(Effect.onInterrupt(() => cleanup));

          return cleanup;
        }),
      );
    },

    incrementRevocationGeneration(userId: string): Effect.Effect<number, RedisError> {
      return redis.useCommands(async (commands) =>
        parseRedisPositiveSafeInteger(
          await commands.sendCommand(['INCR', revocationKey(userId)]),
          'revocation generation',
        ),
      );
    },

    // ------------------------------------------------------------------
    // Sessions
    // ------------------------------------------------------------------
    createSessionForDaemonPresence(
      input,
    ): Effect.Effect<CreatedSessionPresence | null, RedisError> {
      // `absent` and `raced` are both "no session", but only one is worth
      // waiting on. Absent means the daemon has no presence yet — the case the
      // wait exists for. Raced means presence was there and the claim lost a
      // supersession; a newer presence already superseded this one, so waiting
      // would delay an answer that is already final.
      const claimOnce: Effect.Effect<CreatedSessionPresence | 'absent' | 'raced', RedisError> =
        redis.useCommands(async (commands) => {
          const resolved = await resolveCurrentDaemonPresence(commands, input.daemonId);
          if (resolved === null || resolved.presence.userId !== input.userId) return 'absent';
          const current = resolved.presence;

          const session = buildSessionClaim(input, current);
          const stored = await storeSessionClaimIfCurrent(
            commands,
            input.sessionId,
            session,
            resolved.raw,
          );
          if (!stored) {
            return 'raced';
          }

          return current;
        });

      return Effect.gen(function* () {
        // Subscribe before the first attempt, not after it: a registration
        // landing between a failed read and the subscription would otherwise be
        // missed, and the wait would run its full length for a daemon that was
        // already there.
        const appeared = yield* Deferred.make<void>();
        const handler: DeviceEventListener = (signal): void => {
          if (
            signal._tag === 'resync' ||
            (signal.frame.kind === 'presence' && signal.frame.daemonId === input.daemonId)
          ) {
            Deferred.doneUnsafe(appeared, Effect.void);
          }
        };

        return yield* Effect.acquireUseRelease(
          service.subscribeDeviceEvents(input.userId, handler),
          () =>
            Effect.gen(function* () {
              const first = yield* claimOnce;
              if (first !== 'absent') return first === 'raced' ? null : first;
              // No presence yet. The daemon's control link is most likely
              // reconnecting from the same network event that sent the browser
              // here, so give it a bounded moment rather than answering 503 and
              // pushing the browser onto a multi-second backoff ladder.
              yield* Effect.raceFirst(
                Deferred.await(appeared),
                Effect.sleep(`${DAEMON_PRESENCE_WAIT_MS} millis`),
              );
              const second = yield* claimOnce;
              return typeof second === 'string' ? null : second;
            }),
          (unsubscribe) => unsubscribe,
        );
      });
    },

    removeSessionForUser(input): Effect.Effect<void, RedisError> {
      return redis.useCommands(async (commands) => {
        const raw = parseRedisOptionalString(
          await commands.sendCommand(['GET', activeSessionKey(input.sessionId)]),
          'active session claim',
        );
        if (raw === null) return;
        const session = parseSessionClaim(raw);
        if (session === null || session.userId !== input.userId) return;
        await removeSessionClaim(commands, input.sessionId, session);
      });
    },

    removeDaemonSessions(input): Effect.Effect<void, RedisError> {
      return redis.useCommands((commands) => removeClaimSessions(commands, input));
    },
  };
  return service;
}

// ---------------------------------------------------------------------------
// Presence expiry scheduler
// ---------------------------------------------------------------------------

function runPresenceExpiryScheduler(
  redis: RedisService,
  wakeQueue: Queue.Queue<void>,
  logger: LoggerLike,
): Effect.Effect<never> {
  return Effect.gen(function* () {
    while (true) {
      const snapshotResult = yield* Effect.result(readNextPresenceDeadline(redis));
      if (Result.isFailure(snapshotResult)) {
        if (snapshotResult.failure instanceof RedisReplyError) {
          return yield* Effect.die(snapshotResult.failure);
        }
        yield* logWithLoggerEffect(
          logger,
          'error',
          'coordination_presence_expiry_schedule_failed',
          errorLogContext(snapshotResult.failure),
        );
        yield* waitForExpiryWakeOrRecovery(wakeQueue);
        continue;
      }

      const snapshot = snapshotResult.success;
      if (snapshot === null) {
        yield* Effect.race(Queue.take(wakeQueue), Effect.sleep(EMPTY_EXPIRY_RECONCILE_MS)).pipe(
          Effect.asVoid,
        );
        continue;
      }

      if (snapshot.delayMs > 0) {
        const wakeReason = yield* Effect.race(
          Queue.take(wakeQueue).pipe(Effect.as('schedule-changed' as const)),
          Effect.sleep(snapshot.delayMs).pipe(Effect.as('deadline-reached' as const)),
        );
        if (wakeReason === 'schedule-changed') continue;
      }

      const expiryResult = yield* Effect.result(expirePresenceDeadline(redis, snapshot));
      if (Result.isFailure(expiryResult)) {
        if (expiryResult.failure instanceof RedisReplyError) {
          return yield* Effect.die(expiryResult.failure);
        }
        yield* logWithLoggerEffect(
          logger,
          'error',
          'coordination_presence_expiry_transition_failed',
          errorLogContext(expiryResult.failure),
        );
        yield* waitForExpiryWakeOrRecovery(wakeQueue);
        continue;
      }
      if (!expiryResult.success) continue;

      // The offline edge is already atomically published. Session cleanup is
      // best-effort bookkeeping; current-presence verification prevents stale
      // sessions from being resumed even if this cleanup is interrupted.
      yield* redis
        .useCommands((commands) => removeClaimSessions(commands, snapshot.identity))
        .pipe(
          Effect.catch((error) =>
            error instanceof RedisReplyError
              ? Effect.die(error)
              : logWithLoggerEffect(
                  logger,
                  'error',
                  'coordination_expired_presence_session_cleanup_failed',
                  errorLogContext(error),
                ),
          ),
        );
    }
  });
}

function waitForExpiryWakeOrRecovery(wakeQueue: Queue.Queue<void>): Effect.Effect<void> {
  return Effect.race(Queue.take(wakeQueue), Effect.sleep(EXPIRY_RECOVERY_DELAY_MS)).pipe(
    Effect.asVoid,
  );
}

function readNextPresenceDeadline(
  redis: RedisService,
): Effect.Effect<PresenceDeadlineSnapshot | null, RedisError> {
  return redis.useCommands(async (commands) => {
    while (true) {
      const [rawDeadline, rawTime] = await Promise.all([
        commands.sendCommand(['ZRANGE', DAEMON_PRESENCE_DEADLINES_KEY, '0', '0', 'WITHSCORES']),
        commands.sendCommand(['TIME']),
      ]);
      const deadline = parseRedisSortedSetHead(rawDeadline);
      if (deadline === null) return null;

      const identity = parsePresenceDeadlineMember(deadline.member);
      if (identity === null) {
        // A malformed durable member must not permanently pin the scheduler's
        // head. It cannot have been produced by this service, so discard only
        // that exact malformed member. Invalid Redis reply metadata fails the
        // read instead of deleting otherwise-valid durable state.
        await commands.sendCommand(['ZREM', DAEMON_PRESENCE_DEADLINES_KEY, deadline.member]);
        continue;
      }

      const redisNow = parseRedisTimeMilliseconds(rawTime);
      return {
        identity,
        member: deadline.member,
        delayMs: Math.max(0, deadline.score - redisNow),
      };
    }
  });
}

function expirePresenceDeadline(
  redis: RedisService,
  snapshot: PresenceDeadlineSnapshot,
): Effect.Effect<boolean, RedisError> {
  const { identity } = snapshot;
  return redis.useCommands(async (commands) => {
    const rawResult = await evalRedisScript(
      commands,
      EXPIRE_DAEMON_CLAIM_IF_DUE_SCRIPT,
      [
        daemonClaimKey(identity.daemonId, identity.presenceId),
        daemonClaimsKey(identity.daemonId),
        userOnlineDaemonsKey(identity.userId),
        DAEMON_PRESENCE_DEADLINES_KEY,
        deviceEventsCursorKey(identity.userId),
      ],
      [
        snapshot.member,
        identity.presenceId,
        String(identity.claimSeq),
        identity.daemonId,
        deviceEventsChannel(identity.userId),
        createDeviceDeltaPrefix(identity.userId, {
          kind: 'presence',
          daemonId: identity.daemonId,
          status: presenceStateToDeviceStatus(undefined),
        }),
        String(DAEMON_ONLINE_TTL_MS),
        newDeviceEventsEpoch(),
      ],
    );
    return parsePresenceExpiryResult(rawResult);
  });
}

// ---------------------------------------------------------------------------
// Claim storage
// ---------------------------------------------------------------------------

async function storeDaemonClaim(
  commands: RedisCommandClient,
  presence: DaemonPresence,
): Promise<void> {
  const claimKey = daemonClaimKey(presence.daemonId, presence.presenceId);
  const claimsKey = daemonClaimsKey(presence.daemonId);
  const userSetKey = userOnlineDaemonsKey(presence.userId);
  parseRedisPositiveSafeInteger(
    await evalRedisScript(
      commands,
      STORE_DAEMON_CLAIM_SCRIPT,
      [claimKey, claimsKey, userSetKey, DAEMON_PRESENCE_DEADLINES_KEY],
      [
        serializeDaemonPresence(presence),
        String(presence.claimSeq),
        presence.presenceId,
        String(DAEMON_ONLINE_TTL_MS),
        String(INDEX_TTL_MS),
        presence.daemonId,
        presenceDeadlineMember(presence),
        DAEMON_PRESENCE_DEADLINE_EVENTS_CHANNEL,
      ],
    ),
    'daemon claim deadline',
  );
}

async function removeDaemonClaim(
  commands: RedisCommandClient,
  presence: DaemonPresence,
): Promise<void> {
  await Promise.all([
    commands.sendCommand(['DEL', daemonClaimKey(presence.daemonId, presence.presenceId)]),
    commands.sendCommand(['ZREM', daemonClaimsKey(presence.daemonId), presence.presenceId]),
    commands.sendCommand(['ZREM', DAEMON_PRESENCE_DEADLINES_KEY, presenceDeadlineMember(presence)]),
  ]);
}

// ---------------------------------------------------------------------------
// Claim resolution
// ---------------------------------------------------------------------------

async function getCurrentDaemonPresence(
  commands: RedisCommandClient,
  daemonId: string,
): Promise<DaemonPresence | null> {
  return (await resolveCurrentDaemonPresence(commands, daemonId))?.presence ?? null;
}

/**
 * Swaps a current, owned, carrier-matched claim between `online` and `silent`.
 *
 * Bounded re-read-and-retry, like suspend: the only writer that can race this
 * is the opposite transition from the same carrier, and that is an ordering
 * question, not an ownership one. `suspended` is never swapped — a dropped
 * carrier has nothing to say about its own silence.
 */
function swapDaemonSilence(
  redis: RedisService,
  instanceId: string,
  input: DaemonCarrierIdentity,
  target: 'online' | 'silent',
): Effect.Effect<DaemonSilenceTransition, RedisError> {
  return redis.useCommands(async (commands) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await getCurrentDaemonPresence(commands, input.daemonId);
      if (
        current === null ||
        current.userId !== input.userId ||
        current.presenceId !== input.presenceId ||
        current.claimSeq !== input.claimSeq ||
        current.ownerInstanceId !== instanceId ||
        current.connectionId !== input.connectionId ||
        current.state === 'suspended'
      ) {
        return 'not-current';
      }
      if (current.state === target) return 'already';
      const swapped = parseRedisFlag(
        await evalRedisScript(
          commands,
          SWAP_DAEMON_CLAIM_STATE_IF_CURRENT_SCRIPT,
          [
            daemonClaimKey(input.daemonId, input.presenceId),
            daemonClaimsKey(input.daemonId),
            deviceEventsCursorKey(input.userId),
          ],
          [
            serializeDaemonPresence(current),
            serializeDaemonPresence({ ...current, state: target }),
            input.presenceId,
            String(input.claimSeq),
            deviceEventsChannel(input.userId),
            createDeviceDeltaPrefix(input.userId, {
              kind: 'presence',
              daemonId: input.daemonId,
              status: presenceStateToDeviceStatus(target),
            }),
            newDeviceEventsEpoch(),
          ],
        ),
        'daemon silence swap result',
      );
      if (swapped) return 'changed';
    }
    return 'not-current';
  });
}

/**
 * Resolve the daemon's current presence: ordering read, one batched payload
 * fetch, then a stale-claim trim.
 *
 * These three steps are causally dependent, so they cannot be pipelined — and
 * folding them into one Lua script does not work either. A script may only
 * touch keys declared in `KEYS`, but the claim keys are not known until the
 * ordering read returns them, and they carry no hash tag tying them to the
 * ordering key's slot. Dragonfly enforces that (`script tried accessing
 * undeclared key`), and it is the enforcement that makes these key shapes safe
 * to shard; suppressing it with script flags would trade that for two round
 * trips.
 *
 * The remaining cost is per-command latency, not command count: the measured
 * p50 of 6.6 ms for a co-located Dragonfly is itself the anomaly worth chasing,
 * and shaving trips does not address it.
 */
async function resolveCurrentDaemonPresence(
  commands: RedisCommandClient,
  daemonId: string,
): Promise<ResolvedDaemonPresence | null> {
  const claimIds = parseRedisStringArray(
    await commands.sendCommand(['ZREVRANGE', daemonClaimsKey(daemonId), '0', '-1']),
    'daemon claim ordering',
  );
  if (claimIds.length === 0) {
    return null;
  }
  // One MGET for all claim payloads instead of a sequential GET per claim —
  // stale claims would otherwise cost a round-trip each.
  const values = parseRedisNullableStringArray(
    await commands.sendCommand([
      'MGET',
      ...claimIds.map((claimId) => daemonClaimKey(daemonId, claimId)),
    ]),
    claimIds.length,
    'daemon claim values',
  );
  const staleClaimIds: string[] = [];
  let winner: ResolvedDaemonPresence | null = null;

  for (let index = 0; index < claimIds.length; index += 1) {
    const claimId = claimIds[index];
    if (claimId === undefined) continue;
    const raw = values[index];
    if (typeof raw === 'string') {
      const presence = parseDaemonPresence(raw);
      if (presence !== null && presence.daemonId === daemonId && presence.presenceId === claimId) {
        winner = { presence, raw };
        break;
      }
    }
    staleClaimIds.push(claimId);
  }

  if (staleClaimIds.length > 0) {
    await commands.sendCommand(['ZREM', daemonClaimsKey(daemonId), ...staleClaimIds]);
  }
  return winner;
}

async function cleanupSupersededClaims(
  commands: RedisCommandClient,
  winner: DaemonPresence,
): Promise<void> {
  const claimIds = parseRedisStringArray(
    await commands.sendCommand(['ZRANGE', daemonClaimsKey(winner.daemonId), '0', '-1']),
    'superseded daemon claim ordering',
  );

  for (const claimId of claimIds) {
    if (claimId === winner.presenceId) continue;
    const raw = parseRedisOptionalString(
      await commands.sendCommand(['GET', daemonClaimKey(winner.daemonId, claimId)]),
      'superseded daemon claim',
    );
    const presence = raw === null ? null : parseDaemonPresence(raw);
    if (presence === null || presence.claimSeq < winner.claimSeq) {
      if (presence !== null) {
        await removeClaimSessions(commands, presence);
        if (presence.userId !== winner.userId) {
          await commands.sendCommand([
            'SREM',
            userOnlineDaemonsKey(presence.userId),
            presence.daemonId,
          ]);
        }
      }
      await Promise.all([
        commands.sendCommand(['DEL', daemonClaimKey(winner.daemonId, claimId)]),
        commands.sendCommand(['ZREM', daemonClaimsKey(winner.daemonId), claimId]),
        ...(presence === null
          ? []
          : [
              commands.sendCommand([
                'ZREM',
                DAEMON_PRESENCE_DEADLINES_KEY,
                presenceDeadlineMember(presence),
              ]),
            ]),
      ]);
    }
  }
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

async function storeSessionClaimIfCurrent(
  commands: RedisCommandClient,
  sessionId: string,
  session: SessionClaim,
  expectedPresenceRaw: string,
): Promise<boolean> {
  const value = JSON.stringify(session);
  const stored = await evalRedisScript(
    commands,
    CREATE_SESSION_FOR_DAEMON_CLAIM_SCRIPT,
    [
      daemonClaimKey(session.daemonId, session.presenceId),
      daemonClaimsKey(session.daemonId),
      activeSessionKey(sessionId),
      claimSessionsKey(session),
    ],
    [
      expectedPresenceRaw,
      session.presenceId,
      String(session.claimSeq),
      value,
      sessionId,
      String(SESSION_TTL_MS),
    ],
  );
  return parseRedisFlag(stored, 'session claim store result');
}

async function removeSessionClaim(
  commands: RedisCommandClient,
  sessionId: string,
  claim: SessionClaim,
): Promise<void> {
  parseRedisFlag(
    await evalRedisScript(
      commands,
      REMOVE_SESSION_CLAIM_IF_CURRENT_SCRIPT,
      [activeSessionKey(sessionId), claimSessionsKey(claim)],
      [JSON.stringify(claim), sessionId],
    ),
    'session claim removal result',
  );
}

async function removeClaimSessions(
  commands: RedisCommandClient,
  claim: ClaimIdentity,
): Promise<void> {
  const key = claimSessionsKey(claim);
  const sessionIds = parseRedisStringArray(
    await commands.sendCommand(['SMEMBERS', key]),
    'claim session identity set',
  );
  if (sessionIds.length === 0) return;

  const values = parseRedisNullableStringArray(
    await commands.sendCommand(['MGET', ...sessionIds.map(activeSessionKey)]),
    sessionIds.length,
    'claim session values',
  );
  await Promise.all(
    sessionIds.map(async (sessionId, index) => {
      const raw = values[index];
      if (typeof raw !== 'string') {
        await commands.sendCommand(['SREM', key, sessionId]);
        return;
      }
      const session = parseSessionClaim(raw);
      if (session === null || !isSameSessionClaimIdentity(session, claim)) {
        await commands.sendCommand(['SREM', key, sessionId]);
        return;
      }
      await removeSessionClaim(commands, sessionId, session);
    }),
  );
}

// ---------------------------------------------------------------------------
// Pub/sub helpers
// ---------------------------------------------------------------------------

function notifyDeviceEventListeners(
  listeners: ReadonlySet<DeviceEventListener>,
  logger: LoggerLike,
  signal: DeviceEventSignal,
): void {
  for (const listener of listeners) {
    try {
      listener(signal);
    } catch (error) {
      logger.error('coordination_device_event_listener_failed', errorLogContext(error));
    }
  }
}

/**
 * The delta as published, minus its closing brace. The Lua transition that
 * assigns the sequence appends `,"seq":N}` — string concatenation of scalars,
 * never `cjson.encode`, so the wire shape is authored in exactly one place and
 * the claim-serializer discipline (see the suspend script) is not disturbed.
 */
function createDeviceDeltaPrefix(userId: string, delta: DeviceEventDelta): string {
  return JSON.stringify({ userId, ...delta }).slice(0, -1);
}

function parseDeviceDeltaPayload(value: string, userId: string): DeviceDeltaFrame | null {
  const parsed = parseJsonRecord(value);
  if (parsed === null || readRecordString(parsed, 'userId') !== userId) return null;
  const { userId: _userId, ...frame } = parsed;
  return isDeviceDeltaFrame(frame) ? frame : null;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * The one serializer for a stored claim.
 *
 * Every compare-and-swap in the Lua above matches on these exact bytes, so a
 * presence that was parsed out of Redis and re-encoded must produce a
 * byte-identical string. Field order is therefore part of the format: writing
 * `JSON.stringify(presence)` at a call site would silently depend on whichever
 * order that particular object literal happened to use, and
 * `parseDaemonPresence` does not rebuild them in the same order as
 * `buildDaemonPresence`. Route every encode through here.
 */
function serializeDaemonPresence(presence: DaemonPresence): string {
  return JSON.stringify({
    daemonId: presence.daemonId,
    userId: presence.userId,
    ownerInstanceId: presence.ownerInstanceId,
    connectionId: presence.connectionId,
    presenceId: presence.presenceId,
    claimSeq: presence.claimSeq,
    state: presence.state,
    updatedAt: presence.updatedAt,
    zone: presence.zone,
  } satisfies Record<(typeof DAEMON_PRESENCE_FIELDS)[number], unknown>);
}

function buildDaemonPresence(
  input: DaemonPresenceInput,
  metadata: {
    readonly claimSeq: number;
    readonly ownerInstanceId: string;
    readonly state: DaemonPresenceState;
    readonly updatedAt: number;
  },
): DaemonPresence {
  return {
    daemonId: input.daemonId,
    userId: input.userId,
    ownerInstanceId: metadata.ownerInstanceId,
    connectionId: input.connectionId,
    presenceId: input.presenceId,
    claimSeq: metadata.claimSeq,
    state: metadata.state,
    updatedAt: metadata.updatedAt,
    zone: input.zone,
  };
}

function buildSessionClaim(
  input: { readonly userId: string; readonly daemonId: string; readonly browserNodeId: string },
  presence: DaemonPresence,
): SessionClaim {
  return {
    daemonId: input.daemonId,
    userId: input.userId,
    browserNodeId: input.browserNodeId,
    presenceId: presence.presenceId,
    claimSeq: presence.claimSeq,
  };
}

function presenceDeadlineMember(identity: PresenceDeadlineIdentity): string {
  return JSON.stringify({
    daemonId: identity.daemonId,
    userId: identity.userId,
    presenceId: identity.presenceId,
    claimSeq: identity.claimSeq,
  });
}

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

function isSameSessionClaimIdentity(left: SessionClaim, right: ClaimIdentity): boolean {
  return (
    left.daemonId === right.daemonId &&
    left.presenceId === right.presenceId &&
    left.claimSeq === right.claimSeq
  );
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseDaemonPresence(value: string): DaemonPresence | null {
  const parsed = parseJsonRecord(value);
  if (parsed === null || !hasExactKeys(parsed, DAEMON_PRESENCE_FIELDS)) return null;

  const daemonId = readRecordString(parsed, 'daemonId');
  const userId = readRecordString(parsed, 'userId');
  const connectionId = readRecordString(parsed, 'connectionId');
  const ownerInstanceId = readRecordString(parsed, 'ownerInstanceId');
  const presenceId = readRecordString(parsed, 'presenceId');
  const claimSeq = readRecordPositiveSafeInteger(parsed, 'claimSeq');
  const state = readRecordDaemonPresenceState(parsed);
  const updatedAt = readRecordPositiveSafeInteger(parsed, 'updatedAt');
  // Absence is a real value here, so this validates rather than defaults: an
  // unrecognised zone string means the record was written by something that is
  // not this code, and reading it as `null` would hide that.
  const rawZone = parsed.zone;
  if (rawZone !== null && !IP_ZONES.some((zone) => zone === rawZone)) return null;
  const zone = rawZone === null ? null : (rawZone as IpZone);

  if (
    daemonId === null ||
    userId === null ||
    connectionId === null ||
    ownerInstanceId === null ||
    presenceId === null ||
    claimSeq === null ||
    state === null ||
    updatedAt === null
  ) {
    return null;
  }

  return {
    daemonId,
    userId,
    connectionId,
    ownerInstanceId,
    presenceId,
    claimSeq,
    state,
    updatedAt,
    zone,
  };
}

function readRecordDaemonPresenceState(
  parsed: Record<string, unknown>,
): DaemonPresenceState | null {
  const raw = parsed.state;
  return DAEMON_PRESENCE_STATES.find((state) => state === raw) ?? null;
}

function parseSessionClaim(value: string): SessionClaim | null {
  const parsed = parseJsonRecord(value);
  if (parsed === null || !hasExactKeys(parsed, SESSION_CLAIM_FIELDS)) return null;

  const daemonId = readRecordString(parsed, 'daemonId');
  const userId = readRecordString(parsed, 'userId');
  const browserNodeId = readRecordString(parsed, 'browserNodeId');
  const presenceId = readRecordString(parsed, 'presenceId');
  const claimSeq = readRecordPositiveSafeInteger(parsed, 'claimSeq');

  if (
    daemonId === null ||
    userId === null ||
    browserNodeId === null ||
    presenceId === null ||
    claimSeq === null
  ) {
    return null;
  }

  return { daemonId, userId, browserNodeId, presenceId, claimSeq };
}

function parsePresenceDeadlineMember(value: string): PresenceDeadlineIdentity | null {
  const parsed = parseJsonRecord(value);
  if (parsed === null || !hasExactKeys(parsed, PRESENCE_DEADLINE_FIELDS)) return null;

  const daemonId = readRecordString(parsed, 'daemonId');
  const userId = readRecordString(parsed, 'userId');
  const presenceId = readRecordString(parsed, 'presenceId');
  const claimSeq = readRecordPositiveSafeInteger(parsed, 'claimSeq');
  if (daemonId === null || userId === null || presenceId === null || claimSeq === null) {
    return null;
  }

  return { daemonId, userId, presenceId, claimSeq };
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseDaemonClaimRefreshResult(value: unknown): boolean {
  if (!Array.isArray(value)) {
    throw new Error('daemon claim refresh reply must be an array');
  }
  const refreshed = parseRedisFlag(value[0], 'daemon claim refresh result');
  if (!refreshed) {
    if (
      value.length !== 2 ||
      parseRedisNonNegativeSafeInteger(value[1], 'daemon claim refresh deadline') !== 0
    ) {
      throw new Error('an unowned daemon claim refresh must return exactly [0, 0]');
    }
    return false;
  }
  if (value.length !== 3) {
    throw new Error('an owned daemon claim refresh must return exactly three values');
  }
  parseRedisPositiveSafeInteger(value[1], 'daemon claim refresh deadline');
  parseRedisFlag(value[2], 'daemon claim refresh schedule result');
  return true;
}

function parsePresenceExpiryResult(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('presence expiry reply must contain exactly a result and deadline');
  }
  const expired = parseRedisFlag(value[0], 'presence expiry result');
  const deadline = parseRedisNonNegativeSafeInteger(value[1], 'presence expiry deadline');
  if (expired && deadline !== 0) {
    throw new Error('an expired presence transition must return a zero deadline');
  }
  return expired;
}

function parseRevocationGeneration(value: unknown): number | null {
  if (value === null) return 0;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readRecordString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRecordPositiveSafeInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

function daemonClaimsKey(daemonId: string): string {
  return `${DAEMON_CLAIMS_KEY_PREFIX}${daemonId}`;
}

function daemonClaimKey(daemonId: string, presenceId: string): string {
  return `${DAEMON_CLAIM_KEY_PREFIX}${daemonId}:${presenceId}`;
}

function userOnlineDaemonsKey(userId: string): string {
  return `${USER_ONLINE_DAEMONS_KEY_PREFIX}${userId}`;
}

function revocationKey(userId: string): string {
  return `${REVOCATION_KEY_PREFIX}${userId}`;
}

function activeSessionKey(sessionId: string): string {
  return `${ACTIVE_SESSION_KEY_PREFIX}${sessionId}`;
}

function claimSessionsKey(claim: ClaimIdentity): string {
  return `${CLAIM_SESSIONS_KEY_PREFIX}${claim.daemonId}:${claim.claimSeq}:${claim.presenceId}`;
}

function deviceEventsChannel(userId: string): string {
  return `${DEVICE_EVENTS_CHANNEL_PREFIX}{user:${userId}}`;
}

function deviceEventsCursorKey(userId: string): string {
  return `${DEVICE_EVENTS_CURSOR_KEY_PREFIX}${userId}`;
}

/**
 * A candidate epoch for whichever call first finds the cursor missing.
 *
 * Minted per call rather than per process: a process that reused one would hand
 * the same epoch to the counter it created before a Redis restart and to the
 * one it creates after, which is precisely the confusion the epoch exists to
 * prevent.
 */
/**
 * An epoch is compared, never interpreted, so the only thing worth checking is
 * that it is the alphabet both ends agreed on — anything else would travel to
 * the browser inside a cursor and come back in a header this server parses.
 */
function parseDeviceEventsEpoch(value: string | null | undefined): string {
  if (!isDeviceEventsEpoch(value)) {
    throw new RedisReplyError('device events epoch', 'must be lowercase hex');
  }
  return value;
}

function newDeviceEventsEpoch(): string {
  return randomBytes(DEVICE_EVENTS_EPOCH_BYTES).toString('hex');
}
