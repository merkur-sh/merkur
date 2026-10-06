import { describe, expect, test } from 'bun:test';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';

import {
  createRedisCommandClient,
  createRedisSubscriptionClient,
  type RedisError,
  RedisReplyError,
  RedisTimeoutError,
  RedisTransportError,
  useRedisClient,
} from './redis-service';

describe('Redis operation boundary', () => {
  test('classifies rejected commands as transport errors without retrying them', async () => {
    let calls = 0;
    const cause = new Error('connection closed');

    const error = await Effect.runPromise(
      useRedisClient(
        {},
        () => {
          calls += 1;
          return Promise.reject(cause);
        },
        'Redis.commands',
      ).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(RedisTransportError);
    expect(error.cause).toBe(cause);
    expect(calls).toBe(1);
  });

  test('preserves typed malformed-reply errors', async () => {
    const replyError = new RedisReplyError('TEST', 'must be exact');
    const error = await Effect.runPromise(
      useRedisClient({}, () => Promise.reject(replyError), 'Redis.commands').pipe(Effect.flip),
    );

    expect(error).toBe(replyError);
  });

  test('publishes operation success and degradation to readiness tracking', async () => {
    const observations: Array<null | RedisError> = [];
    const replyError = new RedisReplyError('TEST', 'must be exact');

    await Effect.runPromise(
      useRedisClient(
        {},
        () => Promise.resolve('PONG'),
        'Redis.commands',
        (error) => {
          observations.push(error);
        },
      ),
    );
    await Effect.runPromise(
      useRedisClient(
        {},
        () => Promise.reject(replyError),
        'Redis.commands',
        (error) => {
          observations.push(error);
        },
      ).pipe(Effect.ignore),
    );

    expect(observations).toEqual([null, replyError]);
  });

  test('fails a hung command at the bounded deadline with unknown outcome', async () => {
    let calls = 0;
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* useRedisClient(
          {},
          () => {
            calls += 1;
            return new Promise<never>(() => undefined);
          },
          'Redis.subscribe',
        ).pipe(Effect.flip, Effect.forkChild);

        yield* TestClock.adjust('5 seconds');
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(error).toBeInstanceOf(RedisTimeoutError);
    if (!(error instanceof RedisTimeoutError)) {
      throw new Error('expected RedisTimeoutError');
    }
    expect(error.outcome).toBe('unknown');
    expect(error.operation).toBe('Redis.subscribe');
    expect(calls).toBe(1);
  });
});

describe('Native Redis command boundary', () => {
  test('passes raw arguments and replies through without command transforms', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const reply = ['value', 1, null];
    const client = createRedisCommandClient({
      send: async (command, args) => {
        calls.push({ command, args });
        return reply;
      },
    });
    expect(await client.sendCommand<typeof reply>(['EVAL', 'return ARGV', '0', 'value'])).toBe(
      reply,
    );
    expect(calls).toEqual([{ command: 'EVAL', args: ['return ARGV', '0', 'value'] }]);
    await expect(client.sendCommand([])).rejects.toBeInstanceOf(RedisReplyError);
    expect(calls).toHaveLength(1);
  });

  test('bounds pending commands and releases capacity when replies settle', async () => {
    const reply = Promise.withResolvers<string>();
    let sends = 0;
    const client = createRedisCommandClient({
      send: () => {
        sends += 1;
        return reply.promise;
      },
    });
    const pending = Array.from({ length: 1_000 }, () => client.sendCommand(['PING']));
    await expect(client.sendCommand(['INCR', 'must-not-run'])).rejects.toBeInstanceOf(
      RedisTransportError,
    );
    expect(sends).toBe(1_000);
    reply.resolve('PONG');
    await Promise.all(pending);
    expect(await client.sendCommand<string>(['PING'])).toBe('PONG');
    expect(sends).toBe(1_001);
  });
});
describe('Native Redis subscription ownership', () => {
  test('retires timed-out listeners and isolates late success from a replacement', async () => {
    const native = subscriptionFixture();
    const subscriptions = createRedisSubscriptionClient(native);
    const received: string[] = [];
    const handler = (message: string) => received.push(message);
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const pending = yield* subscriptions
          .subscribe('events', handler)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust('5 seconds');
        return yield* Fiber.join(pending);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(error).toBeInstanceOf(RedisTimeoutError);
    expect([...subscriptions.channels()]).toEqual([]);
    const stale = native.registration(0);
    stale.handler('before-late-success');

    await Effect.runPromise(
      Effect.gen(function* () {
        const replacement = yield* subscriptions
          .subscribe('events', handler)
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        native.registration(1).reply.resolve(1);
        yield* Fiber.join(replacement);
      }),
    );
    const lateCleanup = native.waitForRemoval(stale.handler);
    stale.reply.resolve(1);
    await lateCleanup;
    stale.handler('after-late-success');
    native.emit('current');
    expect(received).toEqual(['current']);
    expect(native.listeners.size).toBe(1);
    expect(native.registrations).toHaveLength(2);
    expect([...subscriptions.channels()]).toEqual(['events']);
    await Effect.runPromise(subscriptions.unsubscribe('events', handler));
    expect(native.listeners.size).toBe(0);
  });

  test('interruption disables pending delivery and cleans a late native success', async () => {
    const native = subscriptionFixture();
    const subscriptions = createRedisSubscriptionClient(native);
    const received: string[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const pending = yield* subscriptions
          .subscribe('events', (message) => received.push(message))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(pending);
      }),
    );
    const stale = native.registration(0);
    stale.handler('during-cancellation');
    const lateCleanup = native.waitForRemoval(stale.handler);
    stale.reply.resolve(1);
    await lateCleanup;
    native.emit('after-cancellation');
    expect(received).toEqual([]);
    expect(native.listeners.size).toBe(0);
    expect([...subscriptions.channels()]).toEqual([]);
  });

  test('one cancelled duplicate acquisition preserves the remaining owner', async () => {
    const native = subscriptionFixture();
    const subscriptions = createRedisSubscriptionClient(native);
    const received: string[] = [];
    const handler = (message: string) => received.push(message);
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* subscriptions.subscribe('events', handler).pipe(Effect.forkChild);
        const second = yield* subscriptions.subscribe('events', handler).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(first);
        native.registration(0).reply.resolve(1);
        yield* Fiber.join(second);
      }),
    );
    native.emit('once');
    expect(received).toEqual(['once']);
    expect(native.registrations).toHaveLength(1);
    expect(native.listeners.size).toBe(1);
    await Effect.runPromise(subscriptions.unsubscribe('events', handler));
    expect(native.listeners.size).toBe(0);
  });

  test('unsubscribe during acquisition cannot resurrect delivery or remove its successor', async () => {
    const native = subscriptionFixture();
    const subscriptions = createRedisSubscriptionClient(native);
    const received: string[] = [];
    const handler = (message: string) => received.push(message);
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* subscriptions
          .subscribe('events', handler)
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* subscriptions.unsubscribe('events');
        const second = yield* subscriptions.subscribe('events', handler).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        native.registration(1).reply.resolve(1);
        yield* Fiber.join(second);
        const lateCleanup = native.waitForRemoval(native.registration(0).handler);
        native.registration(0).reply.resolve(1);
        yield* Effect.promise(() => lateCleanup);
        return yield* Fiber.join(first);
      }),
    );
    expect(error).toBeInstanceOf(RedisTransportError);
    native.emit('successor');
    expect(received).toEqual(['successor']);
    expect(native.listeners.size).toBe(1);
    await Effect.runPromise(subscriptions.unsubscribe('events'));
    expect(native.listeners.size).toBe(0);
  });
});

function subscriptionFixture() {
  type Handler = (message: string) => void;
  const listeners = new Set<Handler>();
  const removals = new Map<Handler, () => void>();
  const registrations: Array<{
    handler: Handler;
    reply: ReturnType<typeof Promise.withResolvers<number>>;
  }> = [];
  return {
    listeners,
    registrations,
    subscribe: (_channel: string, handler: Handler): Promise<number> => {
      const reply = Promise.withResolvers<number>();
      listeners.add(handler);
      registrations.push({ handler, reply });
      // Model native completion reattaching a listener after an earlier unsubscribe.
      return reply.promise.then((count) => {
        listeners.add(handler);
        return count;
      });
    },
    unsubscribe: async (_channel: string, handler?: Handler): Promise<void> => {
      if (handler === undefined) listeners.clear();
      else {
        listeners.delete(handler);
        removals.get(handler)?.();
        removals.delete(handler);
      }
    },
    waitForRemoval: (handler: Handler): Promise<void> => {
      const removed = Promise.withResolvers<void>();
      removals.set(handler, () => removed.resolve());
      return removed.promise;
    },
    registration: (index: number) => {
      const registration = registrations[index];
      if (registration === undefined) throw new Error(`Missing subscription ${index}`);
      return registration;
    },
    emit: (message: string) => {
      for (const handler of listeners) handler(message);
    },
  };
}
