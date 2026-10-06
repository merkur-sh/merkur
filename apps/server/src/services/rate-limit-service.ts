import { Context, Data, Effect, Layer } from 'effect';

import { createLogger, errorLogContext, logWithLoggerEffect } from '../logger';
import { parseRedisNonNegativeSafeInteger, parseRedisPositiveSafeInteger } from './redis-reply';
import { defineRedisScript } from './redis-script';
import {
  evalRedisScript,
  preloadRedisScripts,
  type RedisError,
  RedisReplyError,
  RedisServiceTag,
} from './redis-service';

const RATE_LIMIT_KEY_PREFIX = 'rl:';
const logger = createLogger('server');
export const RATE_LIMIT_SLIDING_WINDOW_SCRIPT = defineRedisScript(
  'rate-limit-sliding-window',
  `
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local window_ms = tonumber(ARGV[1])
local window_id = math.floor(now / window_ms)
local current_field = tostring(window_id)
local previous_field = tostring(window_id - 1)
local current = redis.call('HINCRBY', KEYS[1], current_field, 1)
local previous = tonumber(redis.call('HGET', KEYS[1], previous_field)) or 0
local fields = redis.call('HKEYS', KEYS[1])
for _, field in ipairs(fields) do
  if field ~= current_field and field ~= previous_field then
    redis.call('HDEL', KEYS[1], field)
  end
end
redis.call('PEXPIRE', KEYS[1], window_ms * 2)
return { current, previous, now, window_id }
`,
);

/**
 * Releases one reservation made by the sliding-window script, for callers that
 * only want to count outcomes they care about (the login path counts failures,
 * not attempts).
 *
 * Every guard here matters. The window script prunes each field outside its
 * current pair and re-expires the key, so a naive `HINCRBY -1` on a pruned field
 * would recreate it holding `-1`. A later consume reads that as `previous`,
 * where `parseRedisNonNegativeSafeInteger` throws `RedisReplyError` — which on
 * the login path means 503 for every sign-in and, because reply-compatibility
 * health is sticky, a server that never returns to ready. So: decrement only a
 * field that already exists and is positive, and never create a key or touch its
 * expiry.
 */
export const RATE_LIMIT_REFUND_SCRIPT = defineRedisScript(
  'rate-limit-refund',
  `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then
  return 0
end
local value = tonumber(redis.call('HGET', KEYS[1], ARGV[1])) or 0
if value <= 0 then
  return 0
end
redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
return 1
`,
);

export class RateLimitedError extends Data.TaggedError('RateLimitedError')<{
  readonly key: string;
  readonly retryAfterMs: number;
}> {}

export interface RateLimitCheck {
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * `windowId` identifies the counter slot this call incremented, so a later
 * refund targets the same slot even if the window rolls in between. It is
 * optional because it comes from Redis server time and test doubles have no
 * reason to model it.
 */
export type RateLimitDecision =
  | { readonly allowed: true; readonly windowId?: number }
  | { readonly allowed: false; readonly retryAfterMs: number };

/** A consumed slot that can be handed back to {@link RateLimitService.refund}. */
export interface RateLimitReservation {
  readonly key: string;
  readonly windowId: number;
}

export interface RateLimitService {
  consume(check: RateLimitCheck): Effect.Effect<RateLimitDecision, RedisError>;
  /**
   * Optional so existing test doubles keep compiling, matching the
   * `RedisService.loadScripts?` convention. Absent means refunds are a no-op,
   * which degrades to counting attempts rather than failures — safe, just
   * stricter.
   */
  refund?(reservation: RateLimitReservation): Effect.Effect<void, RedisError>;
}

export class RateLimitServiceTag extends Context.Service<RateLimitServiceTag, RateLimitService>()(
  'RateLimitService',
) {}

/**
 * Sliding-window limiter using the two-fixed-window approximation: the
 * previous window's count is weighted by how much of it still overlaps the
 * sliding window. Denied requests keep counting, so hammering a limited key
 * does not let it recover early.
 */
export const RateLimitServiceLive = Layer.effect(
  RateLimitServiceTag,
  Effect.gen(function* () {
    const redis = yield* RedisServiceTag;
    yield* preloadRedisScripts(redis, [RATE_LIMIT_SLIDING_WINDOW_SCRIPT, RATE_LIMIT_REFUND_SCRIPT]);

    return {
      consume(check: RateLimitCheck): Effect.Effect<RateLimitDecision, RedisError> {
        return redis.useCommands(async (commands) => {
          const snapshot = parseRateLimitSnapshot(
            await evalRedisScript(
              commands,
              RATE_LIMIT_SLIDING_WINDOW_SCRIPT,
              [`${RATE_LIMIT_KEY_PREFIX}${check.key}`],
              [String(check.windowMs)],
            ),
          );
          const weightedCount = slidingWindowWeightedCount(
            snapshot.currentCount,
            snapshot.previousCount,
            snapshot.nowMs,
            check.windowMs,
          );
          if (weightedCount <= check.limit) {
            return { allowed: true, windowId: snapshot.windowId } as const;
          }

          return {
            allowed: false,
            retryAfterMs: check.windowMs - (snapshot.nowMs % check.windowMs),
          } as const;
        });
      },

      refund(reservation: RateLimitReservation): Effect.Effect<void, RedisError> {
        return redis.useCommands(async (commands) => {
          await evalRedisScript(
            commands,
            RATE_LIMIT_REFUND_SCRIPT,
            [`${RATE_LIMIT_KEY_PREFIX}${reservation.key}`],
            [String(reservation.windowId)],
          );
        });
      },
    } satisfies RateLimitService;
  }),
);

function parseRateLimitSnapshot(value: unknown): {
  readonly currentCount: number;
  readonly previousCount: number;
  readonly nowMs: number;
  readonly windowId: number;
} {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new RedisReplyError(
      'rate-limit sliding-window transition',
      'must contain current count, previous count, Redis time, and window id',
    );
  }
  return {
    currentCount: parseRedisPositiveSafeInteger(value[0], 'rate-limit current counter'),
    previousCount: parseRedisNonNegativeSafeInteger(value[1], 'rate-limit previous counter'),
    nowMs: parseRedisNonNegativeSafeInteger(value[2], 'rate-limit Redis time'),
    windowId: parseRedisNonNegativeSafeInteger(value[3], 'rate-limit window id'),
  };
}

/**
 * Requests counted against the sliding window ending at `nowMs`: the current
 * window's count plus the previous window's count scaled by its remaining
 * overlap with the sliding window.
 */
export function slidingWindowWeightedCount(
  currentCount: number,
  previousCount: number,
  nowMs: number,
  windowMs: number,
): number {
  const elapsedRatio = (nowMs % windowMs) / windowMs;
  return currentCount + Math.floor(previousCount * (1 - elapsedRatio));
}

/**
 * Runs the checks in order and fails with RateLimitedError on the first denial.
 * Redis failures are logged and treated as allowed (fail open): rate limiting
 * is protection, not authentication, and a Redis blip must not lock out login.
 */
export function enforceRateLimit(
  service: RateLimitService,
  checks: ReadonlyArray<RateLimitCheck>,
): Effect.Effect<void, RateLimitedError> {
  return Effect.gen(function* () {
    for (const check of checks) {
      const decision = yield* service.consume(check).pipe(
        Effect.catch((error: RedisError) =>
          logWithLoggerEffect(logger, 'error', 'rate_limit_redis_error', {
            key: check.key,
            ...errorLogContext(error),
          }).pipe(Effect.as({ allowed: true } as const)),
        ),
      );
      if (!decision.allowed) {
        return yield* new RateLimitedError({
          key: check.key,
          retryAfterMs: decision.retryAfterMs,
        });
      }
    }
  });
}

/**
 * Fail-closed counterpart for password verification. Everywhere else a Redis
 * blip may pass traffic through unlimited, but on the login path the limiter is
 * the only ceiling on guessing, so an attacker who can disrupt Redis must not be
 * able to remove it: the RedisError stays on the error channel and the route
 * answers 503 instead of verifying the password.
 *
 * The failure is logged here rather than left to `runRouteEffect`, which only
 * logs errors its `mapError` does not handle — mapping RedisError to 503 would
 * otherwise make Redis outages on this path invisible.
 */
export function enforceRateLimitFailClosed(
  service: RateLimitService,
  checks: ReadonlyArray<RateLimitCheck>,
): Effect.Effect<ReadonlyArray<RateLimitReservation>, RateLimitedError | RedisError> {
  return Effect.gen(function* () {
    const reservations: RateLimitReservation[] = [];
    for (const check of checks) {
      const decision = yield* service.consume(check).pipe(
        Effect.tapError((error: RedisError) =>
          logWithLoggerEffect(logger, 'error', 'rate_limit_redis_error', {
            key: check.key,
            ...errorLogContext(error),
          }),
        ),
      );
      if (!decision.allowed) {
        return yield* new RateLimitedError({
          key: check.key,
          retryAfterMs: decision.retryAfterMs,
        });
      }
      if (decision.windowId !== undefined) {
        reservations.push({ key: check.key, windowId: decision.windowId });
      }
    }
    return reservations;
  });
}

/**
 * Hands back reservations whose outcome turned out not to be worth counting.
 *
 * Always fail-open: by the time this runs the caller has already committed the
 * work it was guarding (on the login path, the session is issued and the
 * refresh-token row is written), so a Redis problem here must cost the counter,
 * never the request. A service double without `refund` simply keeps the count,
 * which is the stricter direction.
 */
export function refundRateLimit(
  service: RateLimitService,
  reservations: ReadonlyArray<RateLimitReservation>,
): Effect.Effect<void> {
  const refund = service.refund;
  if (refund === undefined) {
    return Effect.void;
  }

  return Effect.forEach(
    reservations,
    (reservation) =>
      refund.call(service, reservation).pipe(
        Effect.catch((error: RedisError) =>
          logWithLoggerEffect(logger, 'error', 'rate_limit_refund_failed', {
            key: reservation.key,
            ...errorLogContext(error),
          }),
        ),
      ),
    { discard: true },
  );
}
