import { randomUUID } from 'node:crypto';
import { type BrowserPresenceFrame, isBrowserPresenceFrame } from '@merkur/shared';
import { Context, Effect, Layer, Schedule } from 'effect';

import type { AuthenticatedBrowser } from './auth-service';
import { defineRedisScript } from './redis-script';
import {
  evalRedisScript,
  RedisError,
  RedisReplyError,
  type RedisService,
  RedisServiceTag,
} from './redis-service';

export type BrowserPresenceSignal =
  | { readonly _tag: 'presence'; readonly frame: BrowserPresenceFrame }
  | { readonly _tag: 'resync' }
  | { readonly _tag: 'session-ended' }
  /** The account's set of browser sessions changed; this one is still in it. */
  | { readonly _tag: 'sessions-changed' };

export interface BrowserPresenceService {
  open(
    browser: AuthenticatedBrowser,
    listener: (signal: BrowserPresenceSignal) => void,
  ): Effect.Effect<Effect.Effect<void>, RedisError>;
}

export class BrowserPresenceServiceTag extends Context.Service<
  BrowserPresenceServiceTag,
  BrowserPresenceService
>()('BrowserPresenceService') {}

/** A committed change to one account's browser sessions, by exact delegation id. */
export interface BrowserSessionChange {
  readonly issuedDelegationIds: readonly string[];
  readonly revokedDelegationIds: readonly string[];
}

function isBrowserSessionChange(value: unknown): value is BrowserSessionChange {
  return (
    typeof value === 'object' &&
    value !== null &&
    'issuedDelegationIds' in value &&
    'revokedDelegationIds' in value &&
    Array.isArray(value.issuedDelegationIds) &&
    value.issuedDelegationIds.every((id) => typeof id === 'string') &&
    Array.isArray(value.revokedDelegationIds) &&
    value.revokedDelegationIds.every((id) => typeof id === 'string')
  );
}

/**
 * Announce a committed session change to every replica. Streams belonging to
 * a revocation target are closed; every other stream of the account is told
 * its session list is stale.
 */
export const publishBrowserSessionChange = Effect.fn('browserPresence.change')(function* (
  redis: RedisService,
  userId: string,
  change: BrowserSessionChange,
) {
  if (change.issuedDelegationIds.length === 0 && change.revokedDelegationIds.length === 0) return;
  yield* redis.publish(`browser:presence:events:${userId}`, JSON.stringify(change));
});

// A lease belongs to a SERVER INSTANCE, never a browser. Idle work is constant
// per replica: two small commands every 15 seconds, independent of client count.
// Connect/disconnect writes are idempotent; only first/last-tab transitions publish.
// Crash cleanup is bounded to 128 connections per script invocation.
// Every accessed key is declared: Dragonfly uses this set for shard locking.
const PRESENCE_SCRIPT = defineRedisScript(
  'browser-presence',
  `
local prefix = 'browser:presence:'
local deadlines = prefix .. 'instances'
local op, instance, member = ARGV[1], ARGV[2], ARGV[3]
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local members = prefix .. 'members:' .. instance
local function snapshot(user)
  local ids = redis.call('HKEYS', prefix .. 'user:' .. user)
  local encoded = {}
  for i, id in ipairs(ids) do encoded[i] = cjson.encode(id) end
  local seq = redis.call('GET', prefix .. 'seq:' .. user) or '0'
  return '{"seq":' .. seq .. ',"activeDelegationIds":[' .. table.concat(encoded, ',') .. ']}'
end
local changed = {}
local function remove(record)
  local parts = cjson.decode(record)
  local key = prefix .. 'user:' .. parts[1]
  local count = redis.call('HINCRBY', key, parts[2], -1)
  if count <= 0 then
    redis.call('HDEL', key, parts[2])
    changed[parts[1]] = true
  end
end
local function publish()
  for user, _ in pairs(changed) do
    redis.call('INCR', prefix .. 'seq:' .. user)
    redis.call('PUBLISH', prefix .. 'events:' .. user, snapshot(user))
  end
end
if op == 'init' then
  return redis.call('ZADD', deadlines, 'NX', now + 45000, instance)
elseif op == 'renew' then
  local deadline = tonumber(redis.call('ZSCORE', deadlines, instance) or '0')
  if deadline <= now then return 0 end
  redis.call('ZADD', deadlines, 'XX', now + 45000, instance)
  return 1
elseif op == 'open' then
  local deadline = tonumber(redis.call('ZSCORE', deadlines, instance) or '0')
  if deadline <= now then return false end
  local parts = cjson.decode(member)
  local key = prefix .. 'user:' .. parts[1]
  if redis.call('SADD', members, member) == 1 then
    if redis.call('HINCRBY', key, parts[2], 1) == 1 then changed[parts[1]] = true end
  end
  publish()
  return snapshot(parts[1])
elseif op == 'close' then
  if redis.call('SREM', members, member) == 1 then remove(member) end
  publish()
  return 1
elseif op == 'retire' then
  if redis.call('ZSCORE', deadlines, instance) then redis.call('ZADD', deadlines, 'XX', now, instance) end
  return 1
elseif op == 'sweep' then
  local expired = redis.call('ZRANGEBYSCORE', deadlines, '-inf', now, 'LIMIT', 0, 1)
  return expired[1] or false
elseif op == 'batch' then
  local deadline = tonumber(redis.call('ZSCORE', deadlines, instance) or '0')
  if deadline > now then return {} end
  return redis.call('SRANDMEMBER', members, 128)
elseif op == 'prune' then
  local deadline = tonumber(redis.call('ZSCORE', deadlines, instance) or '0')
  if deadline > now then return 0 end
  local records = cjson.decode(member)
  for _, record in ipairs(records) do
    if redis.call('SREM', members, record) == 1 then remove(record) end
  end
  if redis.call('SCARD', members) == 0 then
    redis.call('DEL', members)
    redis.call('ZREM', deadlines, instance)
  end
  publish()
  return 1
end
return redis.error_reply('invalid browser presence operation')
`,
);

export const BrowserPresenceServiceLive = Layer.effect(
  BrowserPresenceServiceTag,
  Effect.gen(function* () {
    return yield* createBrowserPresenceService(yield* RedisServiceTag);
  }),
);

export const createBrowserPresenceService = Effect.fn('browserPresence.create')(function* (
  redis: RedisService,
) {
  let instanceId: string | null = null;
  const listeners = new Set<(signal: BrowserPresenceSignal) => void>();

  const command = (op: string, instance: string, member = '', users: readonly string[] = []) => {
    const keys = ['browser:presence:instances'];
    if (op === 'open' || op === 'close' || op === 'batch' || op === 'prune') {
      keys.push(`browser:presence:members:${instance}`);
    }
    for (const user of users) {
      keys.push(`browser:presence:user:${user}`, `browser:presence:seq:${user}`);
    }
    return redis.useCommands((client) =>
      evalRedisScript<unknown>(client, PRESENCE_SCRIPT, keys, [op, instance, member]),
    );
  };

  function invalidate(): void {
    instanceId = null;
    for (const listener of [...listeners]) listener({ _tag: 'resync' });
  }

  const initialize = Effect.fnUntraced(function* () {
    const next = randomUUID();
    const result = yield* command('init', next);
    if (result !== 1) return yield* new RedisReplyError('browser presence init', 'expected 1');
    instanceId = next;
  });

  const sweep = Effect.fnUntraced(function* () {
    while (true) {
      const result = yield* command('sweep', '');
      if (result === null) return;
      if (typeof result !== 'string')
        return yield* new RedisReplyError('browser presence sweep', 'expected instance or null');
      // Peek before declaring the account keys for the atomic removal. The
      // records stay durable until prune, so a failed sweep cannot lose them.
      // SREM fences racing sweeps and late close callbacks against double removal.
      const records = yield* command('batch', result);
      if (!Array.isArray(records) || records.length > 128) {
        return yield* new RedisReplyError('browser presence batch', 'expected at most 128 records');
      }
      const users = new Set<string>();
      for (const record of records) {
        const parts: unknown = yield* Effect.try({
          try: () => (typeof record === 'string' ? JSON.parse(record) : null),
          catch: () => new RedisReplyError('browser presence batch', 'invalid member JSON'),
        });
        if (
          !Array.isArray(parts) ||
          parts.length !== 3 ||
          typeof parts[0] !== 'string' ||
          typeof parts[1] !== 'string' ||
          typeof parts[2] !== 'string'
        ) {
          return yield* new RedisReplyError('browser presence batch', 'invalid member');
        }
        users.add(parts[0]);
      }
      yield* command('prune', result, JSON.stringify(records), [...users]);
      yield* Effect.yieldNow;
    }
  });

  yield* initialize();
  if (redis.onSubscriberReconnected !== undefined) {
    yield* Effect.acquireRelease(redis.onSubscriberReconnected(invalidate), (release) => release);
  }
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const instance = instanceId;
      invalidate();
      if (instance !== null) yield* command('retire', instance);
    }).pipe(Effect.catch(() => Effect.void)),
  );
  yield* Effect.gen(function* () {
    if (instanceId === null) {
      yield* initialize();
    } else {
      const result = yield* command('renew', instanceId);
      if (result !== 1) {
        invalidate();
        yield* initialize();
      }
    }
    yield* sweep();
  }).pipe(
    Effect.catch(() => Effect.sync(invalidate)),
    Effect.repeat(Schedule.spaced('15 seconds')),
    Effect.forkScoped,
  );

  const open = Effect.fn('browserPresence.open')(function* (
    browser: AuthenticatedBrowser,
    listener: (signal: BrowserPresenceSignal) => void,
  ) {
    const instance = instanceId;
    if (instance === null) {
      return yield* new RedisError({ cause: null, message: 'Browser presence is reconnecting' });
    }
    const member = JSON.stringify([browser.userId, browser.delegationId, randomUUID()]);
    const channel = `browser:presence:events:${browser.userId}`;
    let sequence = -1;
    let released = false;
    const notify = (signal: BrowserPresenceSignal): void => {
      if (!released) listener(signal);
    };
    const onMessage = (raw: string): void => {
      try {
        const value: unknown = JSON.parse(raw);
        if (isBrowserSessionChange(value)) {
          notify(
            value.revokedDelegationIds.includes(browser.delegationId)
              ? { _tag: 'session-ended' }
              : { _tag: 'sessions-changed' },
          );
          return;
        }
        if (
          typeof value !== 'object' ||
          value === null ||
          !('seq' in value) ||
          !('activeDelegationIds' in value)
        ) {
          notify({ _tag: 'resync' });
          return;
        }
        const frame = { activeDelegationIds: value.activeDelegationIds };
        if (
          typeof value.seq !== 'number' ||
          !Number.isSafeInteger(value.seq) ||
          value.seq < 0 ||
          !isBrowserPresenceFrame(frame)
        ) {
          notify({ _tag: 'resync' });
          return;
        }
        if (value.seq <= sequence) return;
        sequence = value.seq;
        notify({ _tag: 'presence', frame });
      } catch {
        notify({ _tag: 'resync' });
      }
    };
    const release = Effect.gen(function* () {
      if (released) return;
      released = true;
      listeners.delete(notify);
      yield* Effect.all(
        [
          command('close', instance, member, [browser.userId]).pipe(
            Effect.catch(() => Effect.sync(invalidate)),
          ),
          redis.unsubscribe(channel, onMessage).pipe(Effect.catch(() => Effect.sync(invalidate))),
        ],
        { concurrency: 'unbounded', discard: true },
      );
    });
    listeners.add(notify);
    yield* Effect.gen(function* () {
      yield* redis.subscribe(channel, onMessage);
      const raw = yield* command('open', instance, member, [browser.userId]);
      if (typeof raw !== 'string' || instanceId !== instance) {
        return yield* new RedisReplyError('browser presence open', 'instance lease was lost');
      }
      onMessage(raw);
    }).pipe(Effect.onError(() => release));
    return release;
  });

  return { open } satisfies BrowserPresenceService;
});
