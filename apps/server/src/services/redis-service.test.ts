import { fullGC, heapStats } from 'bun:jsc';
import { describe, expect, spyOn, test } from 'bun:test';
import { RedisClient } from 'bun';
import { Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';

import { defineRedisScript } from './redis-script';
import {
  createRedisCommandClient,
  createRedisServiceEffect,
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

describe('Redis transport generations', () => {
  test('blackholed_transport_recovers_without_replaying_commands', async () => {
    const native = commandTransportFixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const redis = yield* createRedisServiceEffect('redis://localhost:1', { error() {} });
            native.stallNext = true;
            const mutation = yield* redis
              .useCommands((client) => client.sendCommand(['INCR', 'once']))
              .pipe(Effect.flip, Effect.forkChild);
            yield* TestClock.adjust('5 seconds');
            expect(yield* Fiber.join(mutation)).toBeInstanceOf(RedisTimeoutError);
            const ping = yield* redis
              .useCommands((client) => client.sendCommand(['PING']))
              .pipe(Effect.exit, Effect.forkChild);
            yield* TestClock.adjust('5 seconds');
            const result = yield* Fiber.join(ping);
            const metrics = {
              connections: native.states.length,
              pending: native.pending(),
              mutations: native.count('INCR'),
              pingSucceeded: Exit.isSuccess(result),
            };
            process.stdout.write(`blackholed_transport ${JSON.stringify(metrics)}\n`);
            expect(metrics).toEqual({
              connections: 4,
              pending: 0,
              mutations: 1,
              pingSucceeded: true,
            });
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      );
      expect(native.states.every((state) => state.closed)).toBe(true);
    } finally {
      native.restore();
    }
  });

  test('blackholed_transport_preserves_other_callers_and_fences_abandoned_callbacks', async () => {
    const native = commandTransportFixture();
    const resume = Promise.withResolvers<void>();
    const continued = Promise.withResolvers<unknown>();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const redis = yield* createRedisServiceEffect('redis://localhost:1', { error() {} });
            native.stallNext = true;
            const first = yield* redis
              .useCommands((client) => client.sendCommand(['INCR', 'once']))
              .pipe(Effect.flip, Effect.forkChild);
            yield* TestClock.adjust('1 second');
            const second = yield* redis
              .useCommands((client) => client.sendCommand(['GET', 'later']))
              .pipe(Effect.forkChild);
            const abandoned = yield* redis
              .useCommands(async (client) => {
                await resume.promise;
                try {
                  continued.resolve(await client.sendCommand(['INCR', 'must-not-run']));
                } catch (error) {
                  continued.resolve(error);
                }
              })
              .pipe(Effect.flip, Effect.forkChild);
            yield* TestClock.adjust('4 seconds');
            expect(yield* Fiber.join(first)).toBeInstanceOf(RedisTimeoutError);
            const old = native.states.find((state) => state.stalled);
            if (old === undefined) throw new Error('missing stalled generation');
            expect(old.closed).toBe(false);
            expect(native.pending()).toBe(2);
            old.release(1, 'value');
            expect(yield* Fiber.join(second)).toBe('value');
            expect(old.closed).toBe(false);
            yield* TestClock.adjust('1 second');
            expect(yield* Fiber.join(abandoned)).toBeInstanceOf(RedisTimeoutError);
            resume.resolve();
            yield* TestClock.adjust('0 millis');
            expect(native.count('INCR')).toBe(1);
            expect(yield* Effect.promise(() => continued.promise)).toBeInstanceOf(
              RedisTransportError,
            );
            expect(old.closed).toBe(true);
            expect(native.pending()).toBe(0);
            expect(native.count('INCR')).toBe(1);
            expect(yield* redis.useCommands((client) => client.sendCommand(['PING']))).toBe('PONG');
            expect((yield* redis.healthSnapshot()).commandsReady).toBe(true);
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      resume.resolve();
      native.restore();
    }
  });

  test('blackholed_transport_releases_every_retired_generation_and_recovers_the_publisher', async () => {
    const native = commandTransportFixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const redis = yield* createRedisServiceEffect('redis://localhost:1', { error() {} });
            for (let cycle = 0; cycle < 5; cycle += 1) {
              native.stallNext = true;
              const stalled = yield* redis
                .publish('events', String(cycle))
                .pipe(Effect.flip, Effect.forkChild);
              yield* TestClock.adjust('5 seconds');
              expect(yield* Fiber.join(stalled)).toBeInstanceOf(RedisTimeoutError);
              expect(native.pending()).toBe(0);
              expect(native.states.filter((state) => !state.closed)).toHaveLength(3);
              yield* redis.publish('events', 'next');
              expect((yield* redis.healthSnapshot()).publisherReady).toBe(true);
            }
            expect(native.count('PUBLISH')).toBe(10);
            expect(native.states).toHaveLength(8);
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      );
      expect(native.states.filter((state) => !state.closed)).toHaveLength(0);
    } finally {
      native.restore();
    }
  });

  test('blackholed_transport_ignores_a_retired_callers_late_reply_error', async () => {
    const native = commandTransportFixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const redis = yield* createRedisServiceEffect('redis://localhost:1', { error() {} });
            native.stallNext = true;
            const first = yield* redis
              .useCommands((client) => client.sendCommand(['INCR', 'once']))
              .pipe(Effect.flip, Effect.forkChild);
            yield* TestClock.adjust('1 second');
            const lateError = new RedisReplyError('old-generation', 'malformed');
            const second = yield* redis
              .useCommands(async (client) => {
                await client.sendCommand(['GET', 'later']);
                throw lateError;
              })
              .pipe(Effect.flip, Effect.forkChild);
            yield* TestClock.adjust('4 seconds');
            expect(yield* Fiber.join(first)).toBeInstanceOf(RedisTimeoutError);
            expect(yield* redis.useCommands((client) => client.sendCommand(['PING']))).toBe('PONG');
            const old = native.states.find((state) => state.stalled);
            if (old === undefined) throw new Error('missing stalled generation');
            old.release(1, 'value');
            expect(yield* Fiber.join(second)).toBe(lateError);
            expect((yield* redis.healthSnapshot()).commandsReady).toBe(true);
            expect(native.pending()).toBe(0);
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      native.restore();
    }
  });

  test('ended leases reject further commands after native promises settle', async () => {
    const native = commandTransportFixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const redis = yield* createRedisServiceEffect('redis://localhost:1', { error() {} });
            const retained = yield* redis.useCommands((client) => client);
            const settled = Promise.withResolvers<void>();
            native.stallNext = true;
            const stalled = yield* redis
              .useCommands((client) => {
                const sent = client.sendCommand(['INCR', 'once']);
                void sent.then(
                  () => settled.resolve(),
                  () => settled.resolve(),
                );
                return sent;
              })
              .pipe(Effect.flip, Effect.forkChild);
            yield* TestClock.adjust('5 seconds');
            expect(yield* Fiber.join(stalled)).toBeInstanceOf(RedisTimeoutError);
            yield* Effect.promise(() => settled.promise);
            expect(native.states.filter((state) => state.closed)).toHaveLength(1);
            expect(native.pending()).toBe(0);
            yield* Effect.promise(async () => {
              await expect(retained.sendCommand(['INCR', 'must-not-run'])).rejects.toBeInstanceOf(
                RedisTransportError,
              );
            });
            expect(native.count('INCR')).toBe(1);
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      native.restore();
    }
  });

  test('healthy transport callbacks preserve detached command methods', async () => {
    const native = commandTransportFixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const redis = yield* createRedisServiceEffect('redis://localhost:1', { error() {} });
            const script = defineRedisScript('detached-commands', 'return ARGV[1]');
            expect(
              yield* redis.useCommands(async ({ sendCommand, evalScript }) => {
                expect(await sendCommand(['PING'])).toBe('PONG');
                if (evalScript === undefined) throw new Error('missing script command');
                return evalScript(script, [], ['value']);
              }),
            ).toBe('value');
          }),
        ),
      );
    } finally {
      native.restore();
    }
  });

  test('interrupted operations fence retained clients and retire pending native commands', async () => {
    const native = commandTransportFixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const redis = yield* createRedisServiceEffect('redis://localhost:1', { error() {} });
            const retained = yield* redis.useCommands((client) => client);
            yield* Effect.promise(async () => {
              await expect(retained.sendCommand(['INCR', 'must-not-run'])).rejects.toBeInstanceOf(
                RedisTransportError,
              );
            });
            native.stallNext = true;
            const interrupted = yield* redis
              .useCommands((client) => client.sendCommand(['INCR', 'once']))
              .pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            yield* Fiber.interrupt(interrupted);
            yield* TestClock.adjust('0 millis');
            expect(native.pending()).toBe(0);
            expect(native.count('INCR')).toBe(1);
            expect(yield* redis.useCommands((client) => client.sendCommand(['PING']))).toBe('PONG');
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      native.restore();
    }
  });

  test.skipIf(process.env.REDIS_PROFILE !== '1')(
    'profiles_healthy_transport_workloads',
    async () => {
      const native = commandTransportFixture();
      const script = defineRedisScript('transport-profile', 'return ARGV[1]');
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const redis = yield* createRedisServiceEffect('redis://localhost:1', { error() {} });
              const subscriptions = createRedisSubscriptionClient({
                subscribe: async (channel) => {
                  native.calls.push({ command: 'SUBSCRIBE', args: [channel] });
                  return 1;
                },
                unsubscribe: async (channel) => {
                  native.calls.push({ command: 'UNSUBSCRIBE', args: [channel] });
                },
              });
              const handler = () => {};
              const replyError = new RedisReplyError('TEST', 'must be exact');
              const workloads = {
                single: () => redis.useCommands((client) => client.sendCommand(['GET', 'key'])),
                sequential: () =>
                  redis.useCommands(async (client) => {
                    await client.sendCommand(['GET', 'key']);
                    return client.sendCommand(['SET', 'key', 'value']);
                  }),
                batch: () =>
                  redis.useCommands((client) =>
                    Promise.all([
                      client.sendCommand(['GET', 'key']),
                      client.sendCommand(['GET', 'other']),
                    ]),
                  ),
                batch64: () =>
                  redis.useCommands((client) =>
                    Promise.all(
                      Array.from({ length: 64 }, (_, index) =>
                        client.sendCommand(['GET', String(index)]),
                      ),
                    ),
                  ),
                batch1000: () =>
                  redis.useCommands((client) =>
                    Promise.all(
                      Array.from({ length: 1_000 }, (_, index) =>
                        client.sendCommand(['GET', String(index)]),
                      ),
                    ),
                  ),
                script: () =>
                  redis.useCommands((client) => client.evalScript?.(script, [], ['value'])),
                scriptMiss: () => {
                  native.scripts.clear();
                  return redis.useCommands((client) => client.evalScript?.(script, [], ['value']));
                },
                scriptLoad: () =>
                  redis.loadScripts?.([script]) ?? Effect.die('missing script loader'),
                publish: () => redis.publish('events', 'value'),
                subscription: () =>
                  subscriptions
                    .subscribe('events', handler)
                    .pipe(Effect.andThen(() => subscriptions.unsubscribe('events', handler))),
                transportError: () =>
                  redis
                    .useCommands((client) => client.sendCommand(['FAIL']))
                    .pipe(
                      Effect.flip,
                      Effect.map((error) => error.message),
                    ),
                replyError: () =>
                  redis
                    .useCommands(() => Promise.reject(replyError))
                    .pipe(
                      Effect.flip,
                      Effect.map((error) => error.message),
                    ),
              };
              yield* Effect.promise(async () => {
                const expected = {
                  single: 'value',
                  sequential: 'value',
                  batch: ['value', 'value'],
                  batch64: Array.from({ length: 64 }, () => 'value'),
                  batch1000: Array.from({ length: 1_000 }, () => 'value'),
                  script: 'value',
                  scriptMiss: 'value',
                  scriptLoad: undefined,
                  publish: undefined,
                  subscription: undefined,
                  transportError: 'Redis transport failed during `Redis.commands`',
                  replyError: 'Invalid TEST reply: must be exact',
                };
                for (const [name, run] of Object.entries(workloads)) {
                  if (
                    process.env.REDIS_PROFILE_WORKLOAD !== undefined &&
                    process.env.REDIS_PROFILE_WORKLOAD !== name
                  )
                    continue;
                  const wide = name === 'batch64' || name === 'batch1000';
                  const warmup = wide ? 100 : 10_000;
                  const allocationOps = wide ? 1 : 50;
                  const timingOps = wide ? 20 : 500;
                  for (let index = 0; index < warmup; index += 1) await Effect.runPromise(run());
                  native.calls.length = 0;
                  const value = await Effect.runPromise(run());
                  // SAFETY: Both objects declare the same workload keys, and name comes from Object.entries(workloads).
                  expect(value).toEqual(expected[name as keyof typeof expected]);
                  const fingerprint = new Bun.CryptoHasher('sha256')
                    .update(JSON.stringify({ calls: native.calls, value }))
                    .digest('hex');
                  const samples: number[] = [];
                  const cells: number[] = [];
                  const sends = native.calls.length;
                  for (let sample = 0; sample < 9; sample += 1) {
                    fullGC();
                    const survivors = heapStats().objectCount;
                    const before = cellTotal();
                    for (let index = 0; index < allocationOps; index += 1)
                      await Effect.runPromise(run());
                    const after = cellTotal();
                    if (heapStats().objectCount !== survivors)
                      throw new Error('Collection interrupted allocation measurement');
                    cells.push((after - before) / allocationOps);
                    native.clearHistory();
                    const started = Bun.nanoseconds();
                    for (let index = 0; index < timingOps; index += 1)
                      await Effect.runPromise(run());
                    samples.push((Bun.nanoseconds() - started) / timingOps);
                    native.clearHistory();
                  }
                  cells.sort((a, b) => a - b);
                  samples.sort((a, b) => a - b);
                  process.stdout.write(
                    `${name} ${JSON.stringify({ fingerprint, cells: cells[4], ns: samples[4], commands: (native.calls.length - sends) / (9 * (allocationOps + timingOps)) })}\n`,
                  );
                }
              });
            }),
          ),
        );
      } finally {
        native.restore();
      }
    },
    30_000,
  );
});

function cellTotal(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

function commandTransportFixture() {
  type Reply = string | number;
  interface Pending {
    resolve: (value: Reply) => void;
    reject: (error: Error) => void;
  }
  const states: Array<{
    client: RedisClient;
    closed: boolean;
    stalled: boolean;
    pending: Map<number, Pending>;
    release: (index: number, value: Reply) => void;
  }> = [];
  const calls: Array<{ command: string; args: string[] }> = [];
  const scripts = new Set<string>();
  const fixture = {
    scripts,
    states,
    calls,
    stallNext: false,
    count: (command: string) => calls.filter((call) => call.command === command).length,
    pending: () => states.reduce((sum, state) => sum + state.pending.size, 0),
    clearHistory: () => {
      connect.mockClear();
      send.mockClear();
      close.mockClear();
    },
    restore: () => {
      connect.mockRestore();
      send.mockRestore();
      close.mockRestore();
    },
  };
  const connect = spyOn(RedisClient.prototype, 'connect').mockImplementation(async function (
    this: RedisClient,
  ) {
    const pending = new Map<number, Pending>();
    states.push({
      client: this,
      closed: false,
      stalled: false,
      pending,
      release: (index, value) => {
        const reply = pending.get(index);
        if (reply === undefined) throw new Error(`missing native reply ${index}`);
        pending.delete(index);
        reply.resolve(value);
      },
    });
    Object.defineProperty(this, 'connected', {
      get(this: RedisClient) {
        return states.some((state) => state.client === this && !state.closed);
      },
    });
    this.onconnect?.call(this);
  });
  const send = spyOn(RedisClient.prototype, 'send').mockImplementation(function (
    this: RedisClient,
    command: string,
    args: string[],
  ) {
    const state = states.find((state) => state.client === this && !state.closed);
    if (state === undefined) return Promise.reject(new Error('connection closed'));
    calls.push({ command, args });
    if (fixture.stallNext) {
      fixture.stallNext = false;
      state.stalled = true;
    }
    if (state.stalled) {
      const reply = Promise.withResolvers<Reply>();
      state.pending.set(state.pending.size, reply);
      return reply.promise;
    }
    if (command === 'FAIL') return Promise.reject(new Error('connection closed'));
    if (command === 'SCRIPT' && args[0] === 'LOAD') {
      const sha = new Bun.CryptoHasher('sha1').update(args[1] ?? '').digest('hex');
      scripts.add(sha);
      return Promise.resolve(sha);
    }
    if (command === 'EVALSHA' && !scripts.has(args[0] ?? '')) {
      return Promise.reject(new Error('NOSCRIPT No matching script'));
    }
    return Promise.resolve(
      command === 'PING' ? 'PONG' : command === 'INCR' || command === 'PUBLISH' ? 1 : 'value',
    );
  });
  const close = spyOn(RedisClient.prototype, 'close').mockImplementation(function (
    this: RedisClient,
  ) {
    const state = states.find((state) => state.client === this && !state.closed);
    if (state === undefined) return;
    state.closed = true;
    for (const reply of state.pending.values()) reply.reject(new Error('connection closed'));
    state.pending.clear();
    this.onclose?.call(this, new Error('connection closed'));
  });
  return fixture;
}
