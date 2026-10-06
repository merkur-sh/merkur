import { describe, expect, spyOn, test } from 'bun:test';
import * as merkurLogger from '@merkur/logger';
import { Effect, Layer } from 'effect';

import {
  enforceRateLimit,
  enforceRateLimitFailClosed,
  type RateLimitService,
  RateLimitServiceLive,
  RateLimitServiceTag,
  refundRateLimit,
  slidingWindowWeightedCount,
} from './rate-limit-service';
import { type RedisCommandClient, RedisError, RedisServiceTag } from './redis-service';

interface FakeRedisState {
  readonly counters: Map<string, number>;
  readonly commands: string[];
  readonly ttls: Map<string, number>;
  failNext: boolean;
  failAfterNext: boolean;
  nowMs: number;
}

function createFakeRedisCommandClient(state: FakeRedisState): RedisCommandClient {
  return {
    async sendCommand<T = unknown>(args: string[]): Promise<T> {
      if (state.failNext) {
        state.failNext = false;
        throw new Error('redis unavailable');
      }
      const [command, source, keyCount, key, rawArgument] = args;
      state.commands.push(command ?? '');
      if (
        command === 'EVAL' &&
        keyCount === '1' &&
        key !== undefined &&
        source?.includes('HEXISTS')
      ) {
        // Refund script: decrement only an existing positive field, and never
        // create the key or its field.
        const field = `${key}:${rawArgument}`;
        const value = state.counters.get(field);
        if (value === undefined || value <= 0) {
          return 0 as T;
        }
        state.counters.set(field, value - 1);
        return 1 as T;
      }
      const rawWindowMs = rawArgument;
      if (
        command === 'EVAL' &&
        keyCount === '1' &&
        key !== undefined &&
        rawWindowMs !== undefined
      ) {
        const windowMs = Number.parseInt(rawWindowMs, 10);
        const windowId = Math.floor(state.nowMs / windowMs);
        const currentKey = `${key}:${windowId}`;
        const previousKey = `${key}:${windowId - 1}`;
        const next = (state.counters.get(currentKey) ?? 0) + 1;
        state.counters.set(currentKey, next);
        for (const storedKey of state.counters.keys()) {
          if (
            storedKey.startsWith(`${key}:`) &&
            storedKey !== currentKey &&
            storedKey !== previousKey
          ) {
            state.counters.delete(storedKey);
          }
        }
        state.ttls.set(key, windowMs * 2);
        if (state.failAfterNext) {
          state.failAfterNext = false;
          throw new Error('redis reply lost after transition');
        }
        return [next, state.counters.get(previousKey) ?? 0, state.nowMs, windowId] as T;
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  };
}

function createService(state: FakeRedisState): Promise<RateLimitService> {
  const redisLayer = Layer.succeed(RedisServiceTag, {
    useCommands<T>(fn: (client: RedisCommandClient) => T | PromiseLike<T>) {
      return Effect.tryPromise({
        try: async () => await fn(createFakeRedisCommandClient(state)),
        catch: (error) => new RedisError({ cause: error, message: 'fake redis error' }),
      });
    },
    publish: () => Effect.void,
    subscribe: () => Effect.void,
    unsubscribe: () => Effect.void,
    healthSnapshot: () =>
      Effect.succeed({
        commandsReady: true,
        publisherReady: true,
        subscriberReady: true,
      }),
  });

  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* RateLimitServiceTag;
    }).pipe(Effect.provide(RateLimitServiceLive.pipe(Layer.provide(redisLayer)))) as Effect.Effect<
      RateLimitService,
      never,
      never
    >,
  );
}

function freshState(): FakeRedisState {
  return {
    counters: new Map(),
    commands: [],
    ttls: new Map(),
    failNext: false,
    failAfterNext: false,
    nowMs: WINDOW_MS * 100 + Math.floor(WINDOW_MS / 4),
  };
}

// Wide window so a test never straddles a window boundary mid-run.
const WINDOW_MS = 60 * 60 * 1_000;

function currentWindowKey(state: FakeRedisState, key: string): string {
  return `rl:${key}:${Math.floor(state.nowMs / WINDOW_MS)}`;
}

describe('slidingWindowWeightedCount', () => {
  test('weights the previous window by its remaining overlap', () => {
    // 25% into the current window → 75% of the previous window still counts.
    expect(slidingWindowWeightedCount(2, 8, 1_250, 1_000)).toBe(2 + 6);
    // At the window start the previous window counts fully.
    expect(slidingWindowWeightedCount(1, 8, 1_000, 1_000)).toBe(9);
    // At the window end the previous window no longer counts.
    expect(slidingWindowWeightedCount(1, 8, 1_999, 1_000)).toBe(1);
  });
});

describe('RateLimitService', () => {
  test('allows requests under the limit', async () => {
    const state = freshState();
    const service = await createService(state);
    for (let i = 0; i < 3; i += 1) {
      const decision = await Effect.runPromise(
        service.consume({ key: 'k', limit: 3, windowMs: WINDOW_MS }),
      );
      expect(decision.allowed).toBe(true);
    }
  });

  test('denies requests over the limit with a retry hint inside the window', async () => {
    const state = freshState();
    const service = await createService(state);
    for (let i = 0; i < 2; i += 1) {
      await Effect.runPromise(service.consume({ key: 'k', limit: 2, windowMs: WINDOW_MS }));
    }
    const decision = await Effect.runPromise(
      service.consume({ key: 'k', limit: 2, windowMs: WINDOW_MS }),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.retryAfterMs).toBeGreaterThan(0);
      expect(decision.retryAfterMs).toBeLessThanOrEqual(WINDOW_MS);
    }
  });

  test('increments and refreshes expiry in one Lua transition', async () => {
    const state = freshState();
    const service = await createService(state);
    await Effect.runPromise(service.consume({ key: 'k', limit: 5, windowMs: WINDOW_MS }));
    expect(state.ttls.get('rl:k')).toBe(WINDOW_MS * 2);
    expect(state.commands).toEqual(['EVAL']);

    state.ttls.clear();
    await Effect.runPromise(service.consume({ key: 'k', limit: 5, windowMs: WINDOW_MS }));
    expect(state.ttls.get('rl:k')).toBe(WINDOW_MS * 2);
    expect(state.commands).toEqual(['EVAL', 'EVAL']);
  });

  test('installs expiry even when the atomic transition reply is lost', async () => {
    const state = freshState();
    const service = await createService(state);
    state.failAfterNext = true;

    await Effect.runPromise(
      service.consume({ key: 'k', limit: 5, windowMs: WINDOW_MS }).pipe(Effect.flip),
    );

    expect(state.counters.get(currentWindowKey(state, 'k'))).toBe(1);
    expect(state.ttls.get('rl:k')).toBe(WINDOW_MS * 2);
  });

  test('counts denied requests so a hammered key stays limited', async () => {
    const state = freshState();
    const service = await createService(state);
    state.counters.set(currentWindowKey(state, 'k'), 100);

    await Effect.runPromise(service.consume({ key: 'k', limit: 2, windowMs: WINDOW_MS }));
    expect(state.counters.get(currentWindowKey(state, 'k'))).toBe(101);
  });

  test('reports the window slot it incremented so a refund can target it', async () => {
    const state = freshState();
    const service = await createService(state);

    const decision = await Effect.runPromise(
      service.consume({ key: 'k', limit: 5, windowMs: WINDOW_MS }),
    );
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.windowId).toBe(Math.floor(state.nowMs / WINDOW_MS));
    }
  });

  test('refund releases exactly one reservation', async () => {
    const state = freshState();
    const service = await createService(state);
    const windowId = Math.floor(state.nowMs / WINDOW_MS);

    await Effect.runPromise(service.consume({ key: 'k', limit: 5, windowMs: WINDOW_MS }));
    await Effect.runPromise(service.consume({ key: 'k', limit: 5, windowMs: WINDOW_MS }));
    expect(state.counters.get(currentWindowKey(state, 'k'))).toBe(2);

    await Effect.runPromise(service.refund?.({ key: 'k', windowId }) ?? Effect.void);
    expect(state.counters.get(currentWindowKey(state, 'k'))).toBe(1);
  });

  test('refund never resurrects a pruned slot or drives a counter negative', async () => {
    // This is the guard on the worst failure mode in this file. The window
    // script prunes fields outside its current pair, so an unclamped refund
    // would recreate one holding -1; a later consume reads that as `previous`,
    // fails non-negative parsing, and the resulting reply error is sticky —
    // every subsequent sign-in 503s and the server never returns to ready.
    const state = freshState();
    const service = await createService(state);
    const windowId = Math.floor(state.nowMs / WINDOW_MS);

    // Never consumed: the slot does not exist.
    await Effect.runPromise(service.refund?.({ key: 'k', windowId }) ?? Effect.void);
    expect(state.counters.has(currentWindowKey(state, 'k'))).toBe(false);

    // Consumed once, refunded twice: the second refund must be a no-op.
    await Effect.runPromise(service.consume({ key: 'k', limit: 5, windowMs: WINDOW_MS }));
    await Effect.runPromise(service.refund?.({ key: 'k', windowId }) ?? Effect.void);
    await Effect.runPromise(service.refund?.({ key: 'k', windowId }) ?? Effect.void);
    expect(state.counters.get(currentWindowKey(state, 'k'))).toBe(0);

    // A stale slot from an already-rolled window must stay absent.
    await Effect.runPromise(service.refund?.({ key: 'k', windowId: windowId - 5 }) ?? Effect.void);
    expect(state.counters.has(`rl:k:${windowId - 5}`)).toBe(false);
  });

  test('refund does not refresh the key expiry', async () => {
    const state = freshState();
    const service = await createService(state);
    const windowId = Math.floor(state.nowMs / WINDOW_MS);

    await Effect.runPromise(service.consume({ key: 'k', limit: 5, windowMs: WINDOW_MS }));
    state.ttls.clear();

    await Effect.runPromise(service.refund?.({ key: 'k', windowId }) ?? Effect.void);
    expect(state.ttls.has('rl:k')).toBe(false);
  });
});

describe('refundRateLimit', () => {
  test('is a no-op for a service that does not implement refund', async () => {
    const service: RateLimitService = {
      consume: () => Effect.succeed({ allowed: true }),
    };

    await Effect.runPromise(refundRateLimit(service, [{ key: 'k', windowId: 1 }]));
  });

  test('swallows a Redis failure so a committed request still succeeds', async () => {
    const service: RateLimitService = {
      consume: () => Effect.succeed({ allowed: true }),
      refund: () => Effect.fail(new RedisError({ cause: null, message: 'refund unavailable' })),
    };

    await Effect.runPromise(refundRateLimit(service, [{ key: 'k', windowId: 1 }]));
  });
});

describe('enforceRateLimit', () => {
  test('fails with RateLimitedError on the first denied check', async () => {
    const state = freshState();
    const service = await createService(state);
    state.counters.set(currentWindowKey(state, 'first'), 100);

    const exit = await Effect.runPromise(
      Effect.exit(
        enforceRateLimit(service, [
          { key: 'first', limit: 1, windowMs: WINDOW_MS },
          { key: 'second', limit: 1, windowMs: WINDOW_MS },
        ]),
      ),
    );
    expect(exit._tag).toBe('Failure');
    // The second check must not run once the first denies.
    expect(state.counters.has(currentWindowKey(state, 'second'))).toBe(false);
  });

  test('carries retryAfterMs on the error', async () => {
    const state = freshState();
    const service = await createService(state);
    state.counters.set(currentWindowKey(state, 'k'), 100);

    const result = await Effect.runPromise(
      enforceRateLimit(service, [{ key: 'k', limit: 1, windowMs: WINDOW_MS }]).pipe(Effect.flip),
    );
    expect(result._tag).toBe('RateLimitedError');
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test('fails open when Redis errors', async () => {
    const state = freshState();
    const service = await createService(state);
    state.failNext = true;

    await Effect.runPromise(
      enforceRateLimit(service, [{ key: 'k', limit: 1, windowMs: WINDOW_MS }]),
    );
  });
});

describe('enforceRateLimitFailClosed', () => {
  test('propagates the RedisError instead of allowing the request through', async () => {
    const state = freshState();
    const service = await createService(state);
    state.failNext = true;

    const error = await Effect.runPromise(
      enforceRateLimitFailClosed(service, [{ key: 'k', limit: 1, windowMs: WINDOW_MS }]).pipe(
        Effect.flip,
      ),
    );
    expect(error._tag).toBe('RedisError');
  });

  test('fails with RateLimitedError on the first denied check', async () => {
    const state = freshState();
    const service = await createService(state);
    state.counters.set(currentWindowKey(state, 'first'), 100);

    const result = await Effect.runPromise(
      enforceRateLimitFailClosed(service, [
        { key: 'first', limit: 1, windowMs: WINDOW_MS },
        { key: 'second', limit: 1, windowMs: WINDOW_MS },
      ]).pipe(Effect.flip),
    );
    expect(result._tag).toBe('RateLimitedError');
    expect(state.counters.has(currentWindowKey(state, 'second'))).toBe(false);
  });

  test('allows requests under every limit', async () => {
    const state = freshState();
    const service = await createService(state);

    await Effect.runPromise(
      enforceRateLimitFailClosed(service, [
        { key: 'first', limit: 5, windowMs: WINDOW_MS },
        { key: 'second', limit: 5, windowMs: WINDOW_MS },
      ]),
    );
    expect(state.counters.get(currentWindowKey(state, 'first'))).toBe(1);
    expect(state.counters.get(currentWindowKey(state, 'second'))).toBe(1);
  });
});

describe('logger', () => {
  test('is built once per module, never per rate-limit call', async () => {
    const createLogger = spyOn(merkurLogger, 'createLogger');
    const service: RateLimitService = {
      consume: () => Effect.succeed({ allowed: true }),
      refund: () => Effect.void,
    };
    const checks = [{ key: 'k', limit: 1, windowMs: WINDOW_MS }];
    try {
      await Effect.runPromise(enforceRateLimit(service, checks));
      await Effect.runPromise(enforceRateLimitFailClosed(service, checks));
      await Effect.runPromise(refundRateLimit(service, [{ key: 'k', windowId: 1 }]));
      expect(createLogger).not.toHaveBeenCalled();
    } finally {
      createLogger.mockRestore();
    }
  });
});
