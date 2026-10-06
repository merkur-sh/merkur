import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { RedisClient } from 'bun';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';

import {
  type BrowserPresenceSignal,
  createBrowserPresenceService,
  publishBrowserSessionChange,
} from './browser-session-presence';
import { createRedisCommandClient, RedisError, type RedisService } from './redis-service';

const url = process.env.DRAGONFLY_TEST_URL;

if (url === undefined) {
  test.skip('browser presence uses shared replica leases', () => {});
} else {
  test('the integration backend enforces Dragonfly key declarations', async () => {
    const io = await connect(url);
    try {
      await expect(
        io.probe.send('EVAL', [
          "return redis.call('EXISTS', 'browser:presence:undeclared-probe')",
          '0',
        ]),
      ).rejects.toThrow('undeclared key');
    } finally {
      await io.close();
    }
  });

  test('cross-replica presence keeps other tabs active, isolates accounts, and releases exactly once', async () => {
    const io = await connect(url);
    const userId = randomUUID();
    const seen: BrowserPresenceSignal[] = [];
    const browser = { userId, delegationId: 'one', delegationExpiresAt: Date.now() + 60_000 };
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const first = yield* createBrowserPresenceService(io.redis);
            const second = yield* createBrowserPresenceService(io.redis);
            const closeFirst = yield* first.open(browser, (frame) => seen.push(frame));
            const closeSameBrowser = yield* second.open(browser, () => {});
            const closeOther = yield* second.open({ ...browser, delegationId: 'two' }, () => {});
            const closeOtherAccount = yield* second.open(
              { ...browser, userId: randomUUID() },
              () => {},
            );
            yield* Effect.promise(() => until(() => active(seen).includes('two')));
            expect(active(seen).sort()).toEqual(['one', 'two']);
            yield* closeSameBrowser;
            expect(active(seen).sort()).toEqual(['one', 'two']);
            yield* closeOther;
            yield* closeOther;
            yield* Effect.promise(() => until(() => active(seen).length === 1));
            expect(active(seen)).toEqual(['one']);
            yield* closeOtherAccount;
            yield* closeFirst;
            expect(
              yield* io.redis.useCommands((client) =>
                client.sendCommand(['HLEN', `browser:presence:user:${userId}`]),
              ),
            ).toBe(0);
          }),
        ),
      );
    } finally {
      await io.close();
    }
  });

  test('revocation closes matching tabs across replicas and tells the surviving session', async () => {
    const io = await connect(url);
    const userId = randomUUID();
    const seen: BrowserPresenceSignal[][] = [[], [], [], []];
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const first = yield* createBrowserPresenceService(io.redis);
            const second = yield* createBrowserPresenceService(io.redis);
            const releases: Effect.Effect<void>[] = [];
            for (const [index, frames] of seen.entries()) {
              releases.push(
                yield* (index === 0 ? first : second).open(
                  {
                    userId: index === 3 ? randomUUID() : userId,
                    delegationId: index === 2 ? 'survivor' : 'revoked',
                    delegationExpiresAt: Date.now() + 60_000,
                  },
                  (frame) => frames.push(frame),
                ),
              );
            }
            yield* publishBrowserSessionChange(io.redis, userId, {
              issuedDelegationIds: [],
              revokedDelegationIds: ['revoked'],
            });
            yield* Effect.promise(() =>
              until(
                () =>
                  seen
                    .slice(0, 2)
                    .every((frames) => frames.some((frame) => frame._tag === 'session-ended')) &&
                  seen[2]?.some((frame) => frame._tag === 'sessions-changed') === true,
              ),
            );
            expect(
              seen.map((frames) => frames.filter((frame) => frame._tag === 'session-ended').length),
            ).toEqual([1, 1, 0, 0]);
            expect(
              seen.map(
                (frames) => frames.filter((frame) => frame._tag === 'sessions-changed').length,
              ),
            ).toEqual([0, 0, 1, 0]);
            yield* Effect.all(releases, { discard: true });
          }),
        ),
      );
    } finally {
      await io.close();
    }
  });

  test('idle Redis work is two commands per replica with 512 connected tabs and no presence broadcasts', async () => {
    const io = await connect(url);
    const userId = randomUUID();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const presence = yield* createBrowserPresenceService(io.redis);
            const releases: Effect.Effect<void>[] = [];
            for (let i = 0; i < 512; i += 1) {
              releases.push(
                yield* presence.open(
                  { userId, delegationId: 'shared', delegationExpiresAt: Date.now() + 60_000 },
                  () => {},
                ),
              );
            }
            yield* Effect.promise(() =>
              until(() => io.operations.filter((op) => op === 'sweep').length > 0),
            );
            const before = io.operations.length;
            const sequence = yield* io.redis.useCommands((client) =>
              client.sendCommand(['GET', `browser:presence:seq:${userId}`]),
            );
            yield* TestClock.adjust('15 seconds');
            yield* Effect.promise(() => until(() => io.operations.length >= before + 2));
            expect(io.operations.slice(before)).toEqual(['renew', 'sweep']);
            expect(sequence).toBe('1');
            expect(
              yield* io.redis.useCommands((client) =>
                client.sendCommand(['GET', `browser:presence:seq:${userId}`]),
              ),
            ).toBe('1');
            yield* Effect.all(releases, { concurrency: 16, discard: true });
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      await io.close();
    }
  }, 15_000);

  test('a lost replica is swept in bounded batches without removing a surviving replica’s tab', async () => {
    const io = await connect(url);
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const seen: BrowserPresenceSignal[] = [];
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lost = yield* createBrowserPresenceService(io.redis);
            const lostId = io.instances.at(-1);
            if (lostId === undefined) throw new Error('missing instance');
            const survivor = yield* createBrowserPresenceService(io.redis);
            const releases: Effect.Effect<void>[] = [];
            for (let i = 0; i < 260; i += 1) {
              releases.push(
                yield* lost.open(
                  { userId, delegationId: 'lost', delegationExpiresAt: Date.now() + 60_000 },
                  () => {},
                ),
              );
            }
            releases.push(
              yield* lost.open(
                { userId, delegationId: 'gone', delegationExpiresAt: Date.now() + 60_000 },
                () => {},
              ),
            );
            releases.push(
              yield* lost.open(
                {
                  userId: otherUserId,
                  delegationId: 'gone',
                  delegationExpiresAt: Date.now() + 60_000,
                },
                () => {},
              ),
            );
            const closeShared = yield* survivor.open(
              { userId, delegationId: 'lost', delegationExpiresAt: Date.now() + 60_000 },
              (frame) => seen.push(frame),
            );
            const closeObserver = yield* survivor.open(
              { userId, delegationId: 'observer', delegationExpiresAt: Date.now() + 60_000 },
              () => {},
            );
            yield* io.redis.useCommands((client) =>
              client.sendCommand(['ZADD', 'browser:presence:instances', '0', lostId]),
            );
            // A new replica runs the same production sweep immediately at startup.
            yield* createBrowserPresenceService(io.redis);
            yield* Effect.promise(() =>
              until(
                async () =>
                  Number(await io.probe.send('SCARD', [`browser:presence:members:${lostId}`])) ===
                  0,
              ),
            );
            expect(active(seen)).toContain('lost');
            yield* Effect.promise(() => until(() => !active(seen).includes('gone')));
            expect(
              yield* io.redis.useCommands((client) =>
                client.sendCommand(['HLEN', `browser:presence:user:${otherUserId}`]),
              ),
            ).toBe(0);
            // Late finalizers cannot subtract records the crash sweep already retired.
            yield* Effect.all(releases, { concurrency: 16, discard: true });
            yield* closeShared;
            yield* closeObserver;
            expect(
              yield* io.redis.useCommands((client) =>
                client.sendCommand(['HLEN', `browser:presence:user:${userId}`]),
              ),
            ).toBe(0);
          }),
        ),
      );
    } finally {
      await io.close();
    }
  }, 15_000);
}

function active(signals: readonly BrowserPresenceSignal[]): string[] {
  for (let i = signals.length - 1; i >= 0; i -= 1) {
    const signal = signals[i];
    if (signal?._tag === 'presence') return [...signal.frame.activeDelegationIds];
  }
  return [];
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error('presence did not converge');
    await Bun.sleep(2);
  }
}

async function connect(redisUrl: string) {
  const probe = new RedisClient(redisUrl);
  const subscriber = new RedisClient(redisUrl);
  await Promise.all([probe.connect(), subscriber.connect()]);
  const commands = createRedisCommandClient(probe);
  const operations: string[] = [];
  const instances: string[] = [];
  const failure = (cause: unknown) => new RedisError({ cause, message: String(cause) });
  const redis: RedisService = {
    useCommands: (fn) =>
      Effect.tryPromise({
        try: async () =>
          await fn({
            sendCommand: <T = unknown>(args: string[]): Promise<T> => {
              if (args[0] === 'EVAL') {
                const offset = 3 + Number(args[2]);
                const op = args[offset];
                if (op !== undefined) operations.push(op);
                const instance = args[offset + 1];
                if (op === 'init' && instance !== undefined) instances.push(instance);
              }
              return commands.sendCommand<T>(args);
            },
          }),
        catch: failure,
      }),
    publish: (channel, message) =>
      Effect.tryPromise({
        try: async () => {
          await probe.publish(channel, message);
        },
        catch: failure,
      }),
    subscribe: (channel, listener) =>
      Effect.tryPromise({
        try: async () => {
          await subscriber.subscribe(channel, listener);
        },
        catch: failure,
      }),
    unsubscribe: (channel, listener) =>
      Effect.tryPromise({
        try: () =>
          listener === undefined
            ? subscriber.unsubscribe(channel)
            : subscriber.unsubscribe(channel, listener),
        catch: failure,
      }),
    healthSnapshot: () =>
      Effect.succeed({ commandsReady: true, publisherReady: true, subscriberReady: true }),
  };
  return {
    redis,
    probe,
    operations,
    instances,
    close: () => {
      probe.close();
      subscriber.close();
    },
  };
}
