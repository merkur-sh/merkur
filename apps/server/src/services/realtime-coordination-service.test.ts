import { describe, expect, jest, test } from 'bun:test';
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Result,
  Scope,
} from 'effect';

import {
  type ClaimDaemonOnlineResult,
  type DeviceEventSignal,
  type RealtimeCoordinationService,
  RealtimeCoordinationServiceLive,
  RealtimeCoordinationServiceTag,
} from './realtime-coordination-service';
import {
  type RedisCommandClient,
  RedisError,
  RedisReplyError,
  type RedisService,
  RedisServiceTag,
} from './redis-service';

const ONLINE_EDGE = { kind: 'presence', daemonId: 'daemon-1', status: 'online' } as const;
const TEST_DELTA = { kind: 'rename', deviceId: 'daemon-1', name: 'renamed' } as const;

describe('RealtimeCoordinationService', () => {
  test('surfaces an unexpected presence-expiry scheduler defect through health', async () => {
    const redis: RedisService = {
      ...createFakeRedisService(),
      useCommands: () => Effect.die(new Error('injected presence scheduler defect')),
    };

    const observed = await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        const criticalFailure = yield* Effect.forkChild(coordination.awaitCriticalFailure);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const current = yield* coordination.healthSnapshot();
          if (!current.presenceExpirySchedulerHealthy) {
            return {
              snapshot: current,
              criticalExit: yield* Fiber.await(criticalFailure),
            };
          }
          yield* Effect.yieldNow;
        }
        return {
          snapshot: yield* coordination.healthSnapshot(),
          criticalExit: yield* Fiber.await(criticalFailure),
        };
      }),
    );

    expect(observed.snapshot.presenceExpirySchedulerHealthy).toBe(false);
    expect(observed.criticalExit._tag).toBe('Failure');
  });

  test('treats an incompatible Redis reply as a critical expiry-worker failure', async () => {
    const redis: RedisService = {
      ...createFakeRedisService(),
      useCommands: () =>
        Effect.fail(new RedisReplyError('presence expiry schedule', 'injected incompatible reply')),
    };

    const observed = await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        const criticalFailure = yield* Effect.forkChild(coordination.awaitCriticalFailure);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const current = yield* coordination.healthSnapshot();
          if (!current.presenceExpirySchedulerHealthy) {
            return {
              snapshot: current,
              criticalExit: yield* Fiber.await(criticalFailure),
            };
          }
          yield* Effect.yieldNow;
        }
        return {
          snapshot: yield* coordination.healthSnapshot(),
          criticalExit: yield* Fiber.await(criticalFailure),
        };
      }),
    );

    expect(observed.snapshot.presenceExpirySchedulerHealthy).toBe(false);
    expect(observed.criticalExit._tag).toBe('Failure');
  });

  test('claim stores presence and lease renewal refreshes it', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        const input = {
          daemonId: 'daemon-1',
          userId: 'user-1',
          connectionId: 'connection-1',
          presenceId: 'presence-1',
          zone: null,
        };

        const claim = yield* coordination.claimDaemonOnline(input);
        const claimSeq = expectClaimed(claim);
        const [heartbeat = { presence: 'invalid' as const }] =
          yield* coordination.renewDaemonLeases([
            {
              daemonId: input.daemonId,
              userId: input.userId,
              presenceId: input.presenceId,
              claimSeq,
            },
          ]);
        const presence = yield* coordination.getDaemonPresence(input.daemonId);
        const userPresence = yield* coordination.getUserDaemonPresence(input.userId);

        expect(claim._tag).toBe('Claimed');
        expect(heartbeat).toMatchObject({ presence: 'refreshed', revocationGeneration: 0 });
        expect(presence).toMatchObject({
          daemonId: input.daemonId,
          userId: input.userId,
          connectionId: input.connectionId,
          ownerInstanceId: coordination.instanceId,
        });
        expect(userPresence).toHaveLength(1);
        expect(userPresence[0]?.daemonId).toBe(input.daemonId);
      }),
    );
  });

  test('scoped claim cleanup runs when post-write settlement fails', async () => {
    const baseRedis = createFakeRedisService();
    let failSettlement = true;
    const redis: RedisService = {
      ...baseRedis,
      useCommands: (use) =>
        baseRedis.useCommands((commands) =>
          use({
            sendCommand<T = unknown>(args: string[]): Promise<T> {
              if (
                failSettlement &&
                args[0]?.toUpperCase() === 'ZRANGE' &&
                args[1] === 'merkur:control:daemon-claims:daemon-1' &&
                args[2] === '0' &&
                args[3] === '-1'
              ) {
                failSettlement = false;
                return Promise.reject(new Error('injected post-write settlement failure'));
              }
              return commands.sendCommand<T>(args);
            },
          }),
        ),
    };

    const claimResult = await runWithCoordination(redis, (coordination) =>
      Effect.result(
        coordination.claimDaemonOnline({
          daemonId: 'daemon-1',
          userId: 'user-1',
          connectionId: 'connection-1',
          presenceId: 'presence-1',
          zone: null,
        }),
      ),
    );
    expect(Result.isFailure(claimResult)).toBe(true);

    const storedClaim = await Effect.runPromise(
      baseRedis.useCommands((commands) =>
        commands.sendCommand(['GET', 'merkur:control:daemon-claim:daemon-1:presence-1']),
      ),
    );
    expect(storedClaim).toBeNull();
  });

  test('scoped claim cleanup owns an interrupted atomic write with an unknown outcome', async () => {
    const baseRedis = createFakeRedisService();
    let storeExecuted: Deferred.Deferred<void> | null = null;
    let holdStoreReply = true;
    const redis: RedisService = {
      ...baseRedis,
      useCommands: (use) =>
        baseRedis.useCommands((commands) =>
          use({
            sendCommand<T = unknown>(args: string[]): Promise<T> {
              if (
                holdStoreReply &&
                args[0]?.toUpperCase() === 'EVAL' &&
                args[1]?.includes('merkur:store-daemon-claim-with-deadline')
              ) {
                holdStoreReply = false;
                return commands.sendCommand<T>(args).then(() => {
                  if (storeExecuted !== null) {
                    Deferred.doneUnsafe(storeExecuted, Effect.void);
                  }
                  return new Promise<T>(() => {});
                });
              }
              return commands.sendCommand<T>(args);
            },
          }),
        ),
    };

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        storeExecuted = yield* Deferred.make<void>();
        const claimFiber = yield* coordination
          .claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-1',
            presenceId: 'presence-unknown-outcome',
            zone: null,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(storeExecuted);
        yield* Fiber.interrupt(claimFiber);
      }),
    );

    const storedClaim = await Effect.runPromise(
      baseRedis.useCommands((commands) =>
        commands.sendCommand([
          'GET',
          'merkur:control:daemon-claim:daemon-1:presence-unknown-outcome',
        ]),
      ),
    );
    expect(storedClaim).toBeNull();
  });

  test('new claim supersedes old claim and moves user set', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-old',
            connectionId: 'connection-old',
            presenceId: 'presence-old',
            zone: null,
          }),
        );
        expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-new',
            connectionId: 'connection-new',
            presenceId: 'presence-new',
            zone: null,
          }),
        );

        const oldUserPresence = yield* coordination.getUserDaemonPresence('user-old');
        const newUserPresence = yield* coordination.getUserDaemonPresence('user-new');

        expect(oldUserPresence).toEqual([]);
        expect(newUserPresence).toHaveLength(1);
        expect(newUserPresence[0]?.connectionId).toBe('connection-new');
      }),
    );
  });

  test('stale connection cannot unmark current daemon presence', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        const oldClaim = yield* coordination.claimDaemonOnline({
          daemonId: 'daemon-1',
          userId: 'user-1',
          connectionId: 'connection-old',
          presenceId: 'presence-old',
          zone: null,
        });
        const currentClaim = yield* coordination.claimDaemonOnline({
          daemonId: 'daemon-1',
          userId: 'user-1',
          connectionId: 'connection-current',
          presenceId: 'presence-current',
          zone: null,
        });

        const staleRemoved = yield* coordination.unmarkDaemonOnline({
          daemonId: 'daemon-1',
          userId: 'user-1',
          presenceId: 'presence-old',
          claimSeq: expectClaimed(oldClaim),
          connectionId: 'connection-old',
        });
        const currentPresence = yield* coordination.getDaemonPresence('daemon-1');
        const currentRemoved = yield* coordination.unmarkDaemonOnline({
          daemonId: 'daemon-1',
          userId: 'user-1',
          presenceId: 'presence-current',
          claimSeq: expectClaimed(currentClaim),
          connectionId: 'connection-current',
        });

        expect(staleRemoved).toBe(false);
        expect(currentPresence?.connectionId).toBe('connection-current');
        expect(currentRemoved).toBe(true);
        expect(yield* coordination.getDaemonPresence('daemon-1')).toBeNull();
      }),
    );
  });

  test('lease renewal with wrong presenceId returns not-owner', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        const claim = yield* coordination.claimDaemonOnline({
          daemonId: 'daemon-1',
          userId: 'user-1',
          connectionId: 'connection-current',
          presenceId: 'presence-current',
          zone: null,
        });

        const [heartbeat = { presence: 'invalid' as const }] =
          yield* coordination.renewDaemonLeases([
            {
              daemonId: 'daemon-1',
              userId: 'user-1',
              presenceId: 'presence-stale',
              claimSeq: expectClaimed(claim),
            },
          ]);
        const presence = yield* coordination.getDaemonPresence('daemon-1');

        expect(heartbeat.presence).toBe('not-owner');
        expect(presence?.connectionId).toBe('connection-current');
      }),
    );
  });

  test('session is created only when daemon presence matches user', async () => {
    const redis = createFakeRedisService();

    await runWithCoordinationOnVirtualTime(redis, (coordination) =>
      Effect.gen(function* () {
        expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-1',
            presenceId: 'presence-1',
            zone: null,
          }),
        );

        // The other user has no presence on this daemon, so the refusal comes
        // after the bounded wait.
        const { value: denied } = yield* elapse(
          coordination.createSessionForDaemonPresence({
            sessionId: 'session-denied',
            userId: 'user-2',
            daemonId: 'daemon-1',
            browserNodeId: 'browser-1',
          }),
        );
        const created = yield* coordination.createSessionForDaemonPresence({
          sessionId: 'session-allowed',
          userId: 'user-1',
          daemonId: 'daemon-1',
          browserNodeId: 'browser-1',
        });
        const active = yield* readActiveSession(redis, 'session-allowed');

        expect(denied).toBeNull();
        expect(created).toMatchObject({
          daemonId: 'daemon-1',
          userId: 'user-1',
          ownerInstanceId: coordination.instanceId,
          connectionId: 'connection-1',
          presenceId: 'presence-1',
        });
        expect(active).toMatchObject({
          daemonId: 'daemon-1',
          browserNodeId: 'browser-1',
        });
      }),
    );
  });

  /**
   * The 503 this closes was 13.7 % of production session requests over 30 days,
   * and its cause was a race rather than an outage: the daemon's control link
   * reconnects from the same network event that sends the browser here, so its
   * presence is missing for a moment. Refusing there pushed the browser onto a
   * multi-second backoff ladder for a condition that clears in hundreds of
   * milliseconds.
   */
  test('session waiters reuse an existing device subscription and leave its owner active', async () => {
    const redis = createFakeRedisHarness();
    await runWithCoordination(redis.service, (coordination) =>
      Effect.gen(function* () {
        const received: DeviceEventSignal[] = [];
        const cleanup = yield* coordination.subscribeDeviceEvents('user-1', (signal) => {
          received.push(signal);
        });
        const subscribed = redis.subscribeCalls;
        expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-1',
            presenceId: 'presence-1',
            zone: null,
          }),
        );
        yield* Effect.forEach(
          ['session-shared-1', 'session-shared-2'],
          (sessionId) =>
            coordination.createSessionForDaemonPresence({
              sessionId,
              userId: 'user-1',
              daemonId: 'daemon-1',
              browserNodeId: 'browser-1',
            }),
          { concurrency: 'unbounded' },
        );
        expect(redis.subscribeCalls).toBe(subscribed);
        yield* redis.service.publish('merkur:device-events:{user:user-1}', 'resync');
        expect(received).toEqual([{ _tag: 'resync' }]);
        yield* cleanup;
      }),
    );
    expect(redis.activeSubscriptionCount).toBe(0);
  });

  test('a daemon that registers moments late still gets its session', async () => {
    const redis = createFakeRedisService();

    await runWithCoordinationOnVirtualTime(redis, (coordination) =>
      Effect.gen(function* () {
        // Nothing is registered yet, so the claim finds no presence and waits.
        const pending = yield* Effect.forkChild(
          coordination.createSessionForDaemonPresence({
            sessionId: 'session-late',
            userId: 'user-1',
            daemonId: 'daemon-1',
            browserNodeId: 'browser-1',
          }),
        );

        yield* elapse(Effect.sleep('20 millis'));
        expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-1',
            presenceId: 'presence-1',
            zone: null,
          }),
        );

        const { value: created } = yield* elapse(Fiber.join(pending));
        expect(
          created,
          'a registration inside the wait must be picked up, not answered 503',
        ).toMatchObject({ daemonId: 'daemon-1', userId: 'user-1', presenceId: 'presence-1' });
        expect(yield* readActiveSession(redis, 'session-late')).toMatchObject({
          daemonId: 'daemon-1',
          browserNodeId: 'browser-1',
        });
      }),
    );
  });

  /** A daemon that never appears is still reported promptly, not held open. */
  test('an absent daemon is reported once the bounded wait elapses', async () => {
    const redis = createFakeRedisService();

    await runWithCoordinationOnVirtualTime(redis, (coordination) =>
      Effect.gen(function* () {
        const { value: created, elapsedMs } = yield* elapse(
          coordination.createSessionForDaemonPresence({
            sessionId: 'session-absent',
            userId: 'user-1',
            daemonId: 'daemon-missing',
            browserNodeId: 'browser-1',
          }),
        );
        expect(created).toBeNull();
        expect(
          elapsedMs,
          'the daemon is given its one-second moment before the refusal',
        ).toBeGreaterThanOrEqual(1_000);
        expect(
          elapsedMs,
          'the wait is bounded, so a genuinely absent daemon still answers quickly',
        ).toBeLessThan(3_000);
      }),
    );
  });

  test('session creation uses two presence reads and one exact-key atomic write stage', async () => {
    const redis = createFakeRedisHarness();

    await runWithCoordination(redis.service, (coordination) =>
      Effect.gen(function* () {
        const claimSeq = expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-1',
            presenceId: 'presence-1',
            zone: null,
          }),
        );
        const callsBeforeCreate = redis.commandCalls.length;

        expect(
          yield* coordination.createSessionForDaemonPresence({
            sessionId: 'session-1',
            userId: 'user-1',
            daemonId: 'daemon-1',
            browserNodeId: 'browser-1',
          }),
        ).not.toBeNull();

        const createCalls = redis.commandCalls.slice(callsBeforeCreate).filter((args) => {
          const command = args[0]?.toUpperCase();
          return (
            (command === 'ZREVRANGE' && args[1] === 'merkur:control:daemon-claims:daemon-1') ||
            (command === 'MGET' &&
              args
                .slice(1)
                .some((key) => key.startsWith('merkur:control:daemon-claim:daemon-1:'))) ||
            (command === 'EVAL' && args[1]?.includes('merkur:create-session-for-daemon-claim'))
          );
        });

        // One ordering read, one batched payload fetch, one atomic write. These
        // cannot be fused into a single script: a script may only touch keys
        // declared in KEYS, and the claim keys are not known until the ordering
        // read returns them. Dragonfly enforces that, and the enforcement is
        // what keeps these key shapes safe to shard.
        expect(createCalls.map((args) => args[0])).toEqual(['ZREVRANGE', 'MGET', 'EVAL']);
        const atomicWrite = createCalls[2];
        expect(atomicWrite?.slice(2, 7)).toEqual([
          '4',
          'merkur:control:daemon-claim:daemon-1:presence-1',
          'merkur:control:daemon-claims:daemon-1',
          'merkur:sessions:active:session-1',
          `merkur:sessions:claim:daemon-1:${claimSeq}:presence-1`,
        ]);
      }),
    );
  });

  test('presence supersession at the atomic session-write boundary creates no stale session', async () => {
    const redis = createFakeRedisHarness();

    await runWithCoordination(redis.service, (coordination) =>
      Effect.gen(function* () {
        const claimSeq = expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-old',
            presenceId: 'presence-old',
            zone: null,
          }),
        );
        redis.supersedePresenceOnNextSessionCreate('daemon-1', 'presence-new', claimSeq + 1);

        const created = yield* coordination.createSessionForDaemonPresence({
          sessionId: 'session-stale',
          userId: 'user-1',
          daemonId: 'daemon-1',
          browserNodeId: 'browser-1',
        });
        const stored = yield* redis.service.useCommands((commands) =>
          commands.sendCommand(['GET', 'merkur:sessions:active:session-stale']),
        );

        expect(created).toBeNull();
        expect(stored).toBeNull();
      }),
    );
  });

  test('suspending a presence keeps its identity and its session claims', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-1',
            presenceId: 'presence-1',
            zone: null,
          }),
        );
        yield* coordination.createSessionForDaemonPresence({
          sessionId: 'session-1',
          userId: 'user-1',
          daemonId: 'daemon-1',
          browserNodeId: 'browser-1',
        });
        const online = yield* coordination.getDaemonPresence('daemon-1');

        expect(
          yield* coordination.suspendDaemonPresence({
            daemonId: 'daemon-1',
            userId: 'user-1',
            presenceId: 'presence-1',
            claimSeq: online?.claimSeq ?? 0,
          }),
        ).toBe(true);

        const suspended = yield* coordination.getDaemonPresence('daemon-1');
        expect(suspended?.state).toBe('suspended');
        // Identity is what a resume inherits; the session fenced by it must
        // still resolve, which is the whole point of holding the lease.
        expect(suspended?.presenceId).toBe('presence-1');
        expect(suspended?.claimSeq).toBe(online?.claimSeq);
        expect(yield* readActiveSession(redis, 'session-1')).not.toBeNull();

        // Suspending is a compare-and-swap against the online claim, so a second
        // attempt finds suspended bytes and reports that it changed nothing.
        expect(
          yield* coordination.suspendDaemonPresence({
            daemonId: 'daemon-1',
            userId: 'user-1',
            presenceId: 'presence-1',
            claimSeq: online?.claimSeq ?? 0,
          }),
        ).toBe(false);
      }),
    );
  });

  test('a suspended lease outlives the scope that claimed it', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        // `claimDaemonOnline` installs a fenced release finalizer in the ambient
        // scope, and in production that scope is the daemon connection's. Scopes
        // close last-registered-first, so this inner scope reproduces the real
        // ordering: the lease is suspended, and only then does the claim
        // finalizer run.
        yield* Effect.scoped(
          Effect.gen(function* () {
            expectClaimed(
              yield* coordination.claimDaemonOnline({
                daemonId: 'daemon-1',
                userId: 'user-1',
                connectionId: 'connection-1',
                presenceId: 'presence-1',
                zone: null,
              }),
            );
            yield* coordination.createSessionForDaemonPresence({
              sessionId: 'session-1',
              userId: 'user-1',
              daemonId: 'daemon-1',
              browserNodeId: 'browser-1',
            });
            const online = yield* coordination.getDaemonPresence('daemon-1');
            expect(
              yield* coordination.suspendDaemonPresence({
                daemonId: 'daemon-1',
                userId: 'user-1',
                presenceId: 'presence-1',
                claimSeq: online?.claimSeq ?? 0,
              }),
            ).toBe(true);
          }),
        );

        // The carrier is gone, but the lease was deliberately held for the
        // resume window. A finalizer that removed it here would delete the very
        // session claims suspension exists to preserve, and the reconnecting
        // daemon would find nothing to resume.
        const afterScopeClose = yield* coordination.getDaemonPresence('daemon-1');
        expect(afterScopeClose?.state).toBe('suspended');
        expect(afterScopeClose?.presenceId).toBe('presence-1');
        expect(yield* readActiveSession(redis, 'session-1')).not.toBeNull();
      }),
    );
  });

  test('suspending a lease publishes the degraded edge to every instance; resuming publishes none', async () => {
    const redis = createFakeRedisHarness();

    await runWithTwoCoordinations(redis.service, (first, second) =>
      Effect.gen(function* () {
        const firstEvents = yield* Queue.unbounded<void>();
        const secondEvents = yield* Queue.unbounded<void>();
        yield* first.subscribeDeviceEvents('user-1', () => {
          Queue.offerUnsafe(firstEvents, undefined);
        });
        yield* second.subscribeDeviceEvents('user-1', () => {
          Queue.offerUnsafe(secondEvents, undefined);
        });

        let claimSeq = 0;
        yield* Effect.scoped(
          Effect.gen(function* () {
            claimSeq = expectClaimed(
              yield* first.claimDaemonOnline({
                daemonId: 'daemon-1',
                userId: 'user-1',
                connectionId: 'connection-1',
                presenceId: 'presence-1',
                zone: null,
              }),
            );
            // A claim publishes nothing of its own; the control service announces
            // the daemon online once it is session-ready.
            yield* first.publishDeviceDelta('user-1', ONLINE_EDGE);
            yield* Queue.take(firstEvents);
            yield* Queue.take(secondEvents);
            expect(
              yield* first.suspendDaemonPresence({
                daemonId: 'daemon-1',
                userId: 'user-1',
                presenceId: 'presence-1',
                claimSeq,
              }),
            ).toBe(true);
            // The degraded edge is sequenced inside the suspend transition and
            // reaches every instance through the channel alone.
            yield* Queue.take(firstEvents);
            yield* Queue.take(secondEvents);
          }),
        );

        expect(
          yield* first.resumeDaemonPresence({
            daemonId: 'daemon-1',
            userId: 'user-1',
            presenceId: 'presence-1',
            connectionId: 'connection-2',
            zone: null,
          }),
        ).toBe(claimSeq);

        // Resuming announces nothing: like a fresh claim, the resumed daemon is
        // published online by the control service only once session-ready, so
        // a browser can never be told to connect into a daemon that cannot yet
        // admit the session.
        yield* Effect.yieldNow;
        expect(Option.isNone(yield* Queue.poll(firstEvents))).toBe(true);
        expect(Option.isNone(yield* Queue.poll(secondEvents))).toBe(true);
      }),
    );
  });

  test('a departing carrier cannot retire the lease its replacement resumed', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const claimSeq = expectClaimed(
          yield* Scope.provide(
            coordination.claimDaemonOnline({
              daemonId: 'daemon-1',
              userId: 'user-1',
              connectionId: 'connection-1',
              presenceId: 'presence-1',
              zone: null,
            }),
            scope,
          ),
        );
        yield* coordination.createSessionForDaemonPresence({
          sessionId: 'session-1',
          userId: 'user-1',
          daemonId: 'daemon-1',
          browserNodeId: 'browser-1',
        });
        expect(
          yield* coordination.suspendDaemonPresence({
            daemonId: 'daemon-1',
            userId: 'user-1',
            presenceId: 'presence-1',
            claimSeq,
          }),
        ).toBe(true);

        // The daemon reattaches before the departing connection's scope has
        // finished closing. Resume restores the lease to `online` under a new
        // carrier, which puts every field the old finalizer fences on back to
        // matching — identity, owner and state alike.
        expect(
          yield* coordination.resumeDaemonPresence({
            daemonId: 'daemon-1',
            userId: 'user-1',
            presenceId: 'presence-1',
            connectionId: 'connection-2',
            zone: null,
          }),
        ).toBe(claimSeq);

        yield* Scope.close(scope, Exit.void);

        // Only the carrier recorded in the claim may retire it. Otherwise the
        // old connection's finalizer deletes a lease that is actively serving a
        // reconnected daemon, and takes its session claims with it.
        const afterOldFinalizer = yield* coordination.getDaemonPresence('daemon-1');
        expect(afterOldFinalizer?.state).toBe('online');
        expect(afterOldFinalizer?.connectionId).toBe('connection-2');
        expect(yield* readActiveSession(redis, 'session-1')).not.toBeNull();
      }),
    );
  });

  test('session cleanup removes only a claim owned by the requesting user', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-1',
            presenceId: 'presence-1',
            zone: null,
          }),
        );
        yield* coordination.createSessionForDaemonPresence({
          sessionId: 'session-1',
          userId: 'user-1',
          daemonId: 'daemon-1',
          browserNodeId: 'browser-1',
        });

        yield* coordination.removeSessionForUser({ sessionId: 'session-1', userId: 'user-2' });
        expect(yield* readActiveSession(redis, 'session-1')).not.toBeNull();

        yield* coordination.removeSessionForUser({ sessionId: 'session-1', userId: 'user-1' });
        expect(yield* readActiveSession(redis, 'session-1')).toBeNull();
      }),
    );
  });

  test('new claim invalidates sessions from previous claim', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-old',
            presenceId: 'presence-old',
            zone: null,
          }),
        );
        yield* coordination.createSessionForDaemonPresence({
          sessionId: 'session-old',
          userId: 'user-1',
          daemonId: 'daemon-1',
          browserNodeId: 'browser-old',
        });

        expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-new',
            presenceId: 'presence-new',
            zone: null,
          }),
        );

        expect(yield* readActiveSession(redis, 'session-old')).toBeNull();
      }),
    );
  });

  test('removeDaemonSessions only removes sessions for its own claim', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        const basePresence = {
          daemonId: 'daemon-1',
          userId: 'user-1',
          connectionId: 'connection-1',
        };

        const oldClaim = yield* coordination.claimDaemonOnline({
          ...basePresence,
          presenceId: 'presence-old',
          zone: null,
        });
        yield* coordination.createSessionForDaemonPresence({
          sessionId: 'session-old',
          userId: 'user-1',
          daemonId: 'daemon-1',
          browserNodeId: 'browser-old',
        });
        yield* coordination.unmarkDaemonOnline({
          daemonId: 'daemon-1',
          userId: 'user-1',
          presenceId: 'presence-old',
          claimSeq: expectClaimed(oldClaim),
          connectionId: basePresence.connectionId,
        });

        const newClaim = yield* coordination.claimDaemonOnline({
          ...basePresence,
          presenceId: 'presence-new',
          zone: null,
        });
        yield* coordination.createSessionForDaemonPresence({
          sessionId: 'session-new',
          userId: 'user-1',
          daemonId: 'daemon-1',
          browserNodeId: 'browser-new',
        });

        // Stale disconnect cleanup should NOT remove the new claim's sessions
        yield* coordination.removeDaemonSessions({
          daemonId: 'daemon-1',
          userId: 'user-1',
          presenceId: 'presence-old',
          claimSeq: expectClaimed(oldClaim),
        });

        expectClaimed(newClaim);

        expect(yield* readActiveSession(redis, 'session-old')).toBeNull();
        expect(yield* readActiveSession(redis, 'session-new')).toMatchObject({
          browserNodeId: 'browser-new',
        });
      }),
    );
  });

  test('stale claim cleanup cannot delete a replacement written under the same session id', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        const basePresence = {
          daemonId: 'daemon-1',
          userId: 'user-1',
          connectionId: 'connection-1',
        };
        const oldClaim = yield* coordination.claimDaemonOnline({
          ...basePresence,
          presenceId: 'presence-old',
          zone: null,
        });
        yield* coordination.createSessionForDaemonPresence({
          sessionId: 'shared-session',
          userId: 'user-1',
          daemonId: 'daemon-1',
          browserNodeId: 'browser-old',
        });

        const replacementClaim = yield* coordination.claimDaemonOnline({
          ...basePresence,
          connectionId: 'connection-new',
          presenceId: 'presence-new',
          zone: null,
        });
        yield* coordination.createSessionForDaemonPresence({
          sessionId: 'shared-session',
          userId: 'user-1',
          daemonId: 'daemon-1',
          browserNodeId: 'browser-new',
        });
        // Recreate the stale index membership left by an old verifier that is
        // about to clean up. The active value now belongs to the replacement.
        yield* redis.useCommands((commands) =>
          commands.sendCommand([
            'SADD',
            `merkur:sessions:claim:daemon-1:${expectClaimed(oldClaim)}:presence-old`,
            'shared-session',
          ]),
        );

        yield* coordination.removeDaemonSessions({
          daemonId: 'daemon-1',
          userId: 'user-1',
          presenceId: 'presence-old',
          claimSeq: expectClaimed(oldClaim),
        });

        expectClaimed(replacementClaim);
        expect(yield* readActiveSession(redis, 'shared-session')).toMatchObject({
          browserNodeId: 'browser-new',
          presenceId: 'presence-new',
        });
      }),
    );
  });

  test('silence is a state swap that preserves the lease, publishes, and still suspends', async () => {
    const redis = createFakeRedisService();
    let notifications = 0;

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        yield* coordination.subscribeDeviceEvents('user-1', () => {
          notifications += 1;
        });
        const claim = yield* coordination.claimDaemonOnline({
          daemonId: 'daemon-1',
          userId: 'user-1',
          connectionId: 'connection-1',
          presenceId: 'presence-1',
          zone: null,
        });
        const identity = {
          daemonId: 'daemon-1',
          userId: 'user-1',
          presenceId: 'presence-1',
          claimSeq: expectClaimed(claim),
          connectionId: 'connection-1',
        };
        const notificationsAfterClaim = notifications;

        expect(yield* coordination.markDaemonSilent(identity)).toBe('changed');
        expect(notifications).toBe(notificationsAfterClaim + 1);
        expect(yield* coordination.markDaemonSilent(identity)).toBe('already');
        expect((yield* coordination.getDaemonPresence('daemon-1'))?.state).toBe('silent');
        expect(yield* coordination.clearDaemonSilent(identity)).toBe('changed');
        expect((yield* coordination.getDaemonPresence('daemon-1'))?.state).toBe('online');
        // Only the current carrier may describe its own silence.
        expect(
          yield* coordination.markDaemonSilent({ ...identity, connectionId: 'connection-other' }),
        ).toBe('not-current');

        // A silent lease suspends like an online one, and a dropped carrier has
        // nothing further to say about silence.
        expect(yield* coordination.markDaemonSilent(identity)).toBe('changed');
        expect(yield* coordination.suspendDaemonPresence(identity)).toBe(true);
        expect((yield* coordination.getDaemonPresence('daemon-1'))?.state).toBe('suspended');
        expect(yield* coordination.clearDaemonSilent(identity)).toBe('not-current');
      }),
    );
  });

  test('a silent lease can still be retired by its carrier', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        const claim = yield* coordination.claimDaemonOnline({
          daemonId: 'daemon-1',
          userId: 'user-1',
          connectionId: 'connection-1',
          presenceId: 'presence-1',
          zone: null,
        });
        const identity = {
          daemonId: 'daemon-1',
          userId: 'user-1',
          presenceId: 'presence-1',
          claimSeq: expectClaimed(claim),
          connectionId: 'connection-1',
        };
        expect(yield* coordination.markDaemonSilent(identity)).toBe('changed');
        expect(yield* coordination.unmarkDaemonOnline(identity)).toBe(true);
        expect(yield* coordination.getDaemonPresence('daemon-1')).toBeNull();
      }),
    );
  });

  test('lease renewal leaves session leases owned by create/cancel edges', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        const claim = yield* coordination.claimDaemonOnline({
          daemonId: 'daemon-1',
          userId: 'user-1',
          connectionId: 'connection-1',
          presenceId: 'presence-1',
          zone: null,
        });
        yield* coordination.createSessionForDaemonPresence({
          sessionId: 'session-1',
          userId: 'user-1',
          daemonId: 'daemon-1',
          browserNodeId: 'browser-1',
        });
        // Shorten only the session lease. A daemon heartbeat must remain O(1)
        // and must not turn abandoned browser state into an immortal claim.
        yield* redis.useCommands((commands) =>
          commands.sendCommand(['PEXPIRE', 'merkur:sessions:active:session-1', '1234']),
        );

        const [heartbeat = { presence: 'invalid' as const }] =
          yield* coordination.renewDaemonLeases([
            {
              daemonId: 'daemon-1',
              userId: 'user-1',
              presenceId: 'presence-1',
              claimSeq: expectClaimed(claim),
            },
          ]);
        const ttlAfterHeartbeat = yield* redis.useCommands((commands) =>
          commands.sendCommand<number>(['PTTL', 'merkur:sessions:active:session-1']),
        );
        const active = yield* readActiveSession(redis, 'session-1');

        expect(heartbeat.presence).toBe('refreshed');
        expect(ttlAfterHeartbeat).toBeGreaterThan(0);
        expect(ttlAfterHeartbeat).toBeLessThanOrEqual(1234);
        expect(active).not.toBeNull();
      }),
    );
  });

  test('presence resolution skips a stale claim ahead of the valid one and prunes it', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        const input = {
          daemonId: 'daemon-1',
          userId: 'user-1',
          connectionId: 'connection-1',
          presenceId: 'presence-1',
          zone: null,
        };
        expectClaimed(yield* coordination.claimDaemonOnline(input));

        // Simulate an expired newer claim: zset entry present, payload gone.
        yield* redis.useCommands((commands) =>
          commands.sendCommand(['ZADD', 'merkur:control:daemon-claims:daemon-1', '999', 'ghost']),
        );

        const presence = yield* coordination.getDaemonPresence('daemon-1');
        expect(presence?.presenceId).toBe('presence-1');

        // The stale claim id was removed from the sorted set.
        const remaining = yield* redis.useCommands((commands) =>
          commands.sendCommand<string[]>([
            'ZREVRANGE',
            'merkur:control:daemon-claims:daemon-1',
            '0',
            '-1',
          ]),
        );
        expect(remaining).toEqual(['presence-1']);
      }),
    );
  });

  test('user presence resolves multiple daemons and drops daemons without claims', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        for (const daemonId of ['daemon-1', 'daemon-2']) {
          expectClaimed(
            yield* coordination.claimDaemonOnline({
              daemonId,
              userId: 'user-1',
              connectionId: `connection-${daemonId}`,
              presenceId: `presence-${daemonId}`,
              zone: null,
            }),
          );
        }
        // A daemon listed in the user set with no surviving claim is stale.
        yield* redis.useCommands((commands) =>
          commands.sendCommand([
            'SADD',
            'merkur:control:user-online-daemons:user-1',
            'daemon-gone',
          ]),
        );

        const presence = yield* coordination.getUserDaemonPresence('user-1');
        expect(presence.map((entry) => entry.daemonId).sort()).toEqual(['daemon-1', 'daemon-2']);

        // The stale daemon id was removed from the user set.
        const members = yield* redis.useCommands((commands) =>
          commands.sendCommand<string[]>(['SMEMBERS', 'merkur:control:user-online-daemons:user-1']),
        );
        expect([...members].sort()).toEqual(['daemon-1', 'daemon-2']);
      }),
    );
  });

  test('publishDeviceDelta delivers once, through the channel echo alone', async () => {
    const redis = createFakeRedisService();
    let notifyCount = 0;

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        yield* coordination.subscribeDeviceEvents('user-1', () => {
          notifyCount += 1;
        });
        yield* coordination.publishDeviceDelta('user-1', TEST_DELTA);
        expect(notifyCount).toBe(1);
      }),
    );
  });

  test('the cursor is minted once and shared by reads and publishes', async () => {
    const redis = createFakeRedisService();

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        // An account with no transitions yet still has to name a cursor, so
        // the first read is what mints it.
        const opened = yield* coordination.readDeviceEventsCursor('user-1');
        expect(opened.seq).toBe(0);
        expect(opened.epoch).toMatch(/^[0-9a-f]{16}$/);

        yield* coordination.publishDeviceDelta('user-1', TEST_DELTA);
        const advanced = yield* coordination.readDeviceEventsCursor('user-1');
        // A publish carries its own candidate epoch, and must not spend it on a
        // counter that already has one — a cursor that changed under a browser
        // holding it would cost a snapshot on every single reconnect.
        expect(advanced).toEqual({ epoch: opened.epoch, seq: 1 });

        // Another account's counter is its own.
        const other = yield* coordination.readDeviceEventsCursor('user-2');
        expect(other.seq).toBe(0);
        expect(other.epoch).not.toBe(opened.epoch);
      }),
    );
  });

  test('device events published by another instance still reach local subscribers', async () => {
    const redis = createFakeRedisHarness();
    let notifyCount = 0;

    await runWithCoordination(redis.service, (coordination) =>
      Effect.gen(function* () {
        yield* coordination.subscribeDeviceEvents('user-1', () => {
          notifyCount += 1;
        });
        yield* Effect.sync(() =>
          redis.deliverToSubscribers(
            JSON.stringify({ userId: 'user-1', kind: 'remove', deviceId: 'daemon-9', seq: 1 }),
          ),
        );
        // A frame for another user, or one that is not a delta, is dropped.
        yield* Effect.sync(() =>
          redis.deliverToSubscribers(
            JSON.stringify({ userId: 'user-2', kind: 'remove', deviceId: 'daemon-9', seq: 2 }),
          ),
        );
        yield* Effect.sync(() => redis.deliverToSubscribers('changed'));
        expect(notifyCount).toBe(1);
      }),
    );
  });

  test('a claim publishes no device edge of its own', async () => {
    const redis = createFakeRedisService();
    let notifyCount = 0;

    await runWithCoordination(redis, (coordination) =>
      Effect.gen(function* () {
        yield* coordination.subscribeDeviceEvents('user-1', () => {
          notifyCount += 1;
        });
        expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-1',
            presenceId: 'presence-1',
            zone: null,
          }),
        );
        // The online edge belongs to the control service, after session-ready;
        // a claim that published it would invite a session_start into a daemon
        // that cannot admit one yet.
        expect(notifyCount).toBe(0);
      }),
    );
  });

  test('silent claim TTL expiry publishes one offline edge to every live instance', async () => {
    const redis = createFakeRedisHarness();
    let firstNotifications = 0;
    let secondNotifications = 0;

    await runWithTwoCoordinations(redis.service, (first, second) =>
      Effect.gen(function* () {
        const firstEvents = yield* Queue.unbounded<void>();
        const secondEvents = yield* Queue.unbounded<void>();
        yield* first.subscribeDeviceEvents('user-1', () => {
          firstNotifications += 1;
          Queue.offerUnsafe(firstEvents, undefined);
        });
        yield* second.subscribeDeviceEvents('user-1', () => {
          secondNotifications += 1;
          Queue.offerUnsafe(secondEvents, undefined);
        });

        const claimSeq = expectClaimed(
          yield* first.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-1',
            presenceId: 'presence-1',
            zone: null,
          }),
        );
        yield* first.publishDeviceDelta('user-1', ONLINE_EDGE);
        yield* Queue.take(firstEvents);
        yield* Queue.take(secondEvents);

        yield* forcePresenceDeadlineDue(redis.service, 'daemon-1', 'presence-1');
        yield* Queue.take(firstEvents);
        yield* Queue.take(secondEvents);
        expect(
          yield* first.unmarkDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            presenceId: 'presence-1',
            claimSeq: claimSeq,
            connectionId: 'connection-1',
          }),
        ).toBe(false);

        // Extra wakeups and competing schedulers cannot republish the edge
        // after the atomic transition removed its fenced deadline member.
        yield* redis.service.useCommands((commands) =>
          commands.sendCommand([
            'PUBLISH',
            'merkur:control:daemon-presence-deadline-events',
            'changed',
          ]),
        );
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        expect(firstNotifications).toBe(2);
        expect(secondNotifications).toBe(2);
        expect(yield* first.getDaemonPresence('daemon-1')).toBeNull();
        expect(yield* second.getUserDaemonPresence('user-1')).toEqual([]);
      }),
    );
  });

  test('an empty scheduler reconciles a durable deadline committed during a lost wake', async () => {
    const redis = createFakeRedisHarness();

    await runWithCoordinationOnVirtualTime(redis.service, (coordination) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<void>();
        yield* coordination.subscribeDeviceEvents('user-1', () => {
          Queue.offerUnsafe(events, undefined);
        });

        // The layer seeds one local wake after startup. Wait through both its
        // initial read and that queued wake so the scheduler is demonstrably
        // parked on the empty-set reconciliation deadline before insertion.
        for (let turn = 0; turn < 50 && redis.deadlineReadCount < 2; turn += 1) {
          yield* Effect.yieldNow;
        }
        expect(redis.deadlineReadCount).toBeGreaterThanOrEqual(2);
        const readsBeforeLostWake = redis.deadlineReadCount;

        const presence = {
          daemonId: 'daemon-1',
          userId: 'user-1',
          connectionId: 'connection-1',
          presenceId: 'presence-1',
          claimSeq: 1,
          ownerInstanceId: 'crashed-instance',
          updatedAt: Date.now(),
        };
        const deadlineMember = JSON.stringify({
          daemonId: presence.daemonId,
          userId: presence.userId,
          presenceId: presence.presenceId,
          claimSeq: presence.claimSeq,
        });

        // Simulate another process committing after this scheduler observed an
        // empty ZSET, then dying before its local wake while this subscriber
        // missed pub/sub during reconnect.
        yield* redis.service.useCommands(async (commands) => {
          await commands.sendCommand([
            'SET',
            'merkur:control:daemon-claim:daemon-1:presence-1',
            JSON.stringify(presence),
            'PX',
            '1',
          ]);
          await commands.sendCommand([
            'ZADD',
            'merkur:control:daemon-claims:daemon-1',
            '1',
            'presence-1',
          ]);
          await commands.sendCommand([
            'SADD',
            'merkur:control:user-online-daemons:user-1',
            'daemon-1',
          ]);
          await commands.sendCommand([
            'ZADD',
            'merkur:control:daemon-presence-deadlines',
            '0',
            deadlineMember,
          ]);
        });

        const { value: reconciled } = yield* elapse(
          Effect.race(
            Queue.take(events).pipe(Effect.as(true)),
            Effect.sleep('2 seconds').pipe(Effect.as(false)),
          ),
        );
        expect(reconciled).toBe(true);
        expect(redis.deadlineReadCount).toBeGreaterThan(readsBeforeLostWake);
        expect(yield* coordination.getDaemonPresence('daemon-1')).toBeNull();
      }),
    );
  });

  test('explicit unmark wins atomically over a stale due worker', async () => {
    const redis = createFakeRedisHarness();
    let notifications = 0;

    await runWithCoordination(redis.service, (coordination) =>
      Effect.gen(function* () {
        const expiryEvaluations = yield* Queue.unbounded<void>();
        redis.setExpiryEvaluationListener(() => {
          Queue.offerUnsafe(expiryEvaluations, undefined);
        });
        yield* coordination.subscribeDeviceEvents('user-1', () => {
          notifications += 1;
        });
        const claimSeq = expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-1',
            presenceId: 'presence-1',
            zone: null,
          }),
        );
        const staleMember = yield* findPresenceDeadlineMember(
          redis.service,
          'daemon-1',
          'presence-1',
        );

        expect(
          yield* coordination.unmarkDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            presenceId: 'presence-1',
            claimSeq: claimSeq,
            connectionId: 'connection-1',
          }),
        ).toBe(true);
        // The offline edge is sequenced inside the retirement; nothing else
        // publishes for an explicit disconnect.

        yield* redis.service.useCommands(async (commands) => {
          await commands.sendCommand([
            'ZADD',
            'merkur:control:daemon-presence-deadlines',
            '0',
            staleMember,
          ]);
          await commands.sendCommand([
            'PUBLISH',
            'merkur:control:daemon-presence-deadline-events',
            'changed',
          ]);
        });
        yield* Queue.take(expiryEvaluations);

        expect(notifications).toBe(1);
        expect(
          yield* redis.service.useCommands((commands) =>
            commands.sendCommand([
              'ZSCORE',
              'merkur:control:daemon-presence-deadlines',
              staleMember,
            ]),
          ),
        ).toBeNull();
      }),
    );
  });

  test('lease renewal atomically reschedules a due presence deadline', async () => {
    const redis = createFakeRedisHarness();
    let notifications = 0;

    await runWithCoordination(redis.service, (coordination) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<void>();
        yield* coordination.subscribeDeviceEvents('user-1', () => {
          notifications += 1;
          Queue.offerUnsafe(events, undefined);
        });
        const claim = yield* coordination.claimDaemonOnline({
          daemonId: 'daemon-1',
          userId: 'user-1',
          connectionId: 'connection-1',
          presenceId: 'presence-1',
          zone: null,
        });
        yield* coordination.publishDeviceDelta('user-1', ONLINE_EDGE);
        yield* Queue.take(events);

        const member = yield* findPresenceDeadlineMember(redis.service, 'daemon-1', 'presence-1');
        yield* redis.service.useCommands((commands) =>
          commands.sendCommand(['ZADD', 'merkur:control:daemon-presence-deadlines', '0', member]),
        );
        const [heartbeat = { presence: 'invalid' as const }] =
          yield* coordination.renewDaemonLeases([
            {
              daemonId: 'daemon-1',
              userId: 'user-1',
              presenceId: 'presence-1',
              claimSeq: expectClaimed(claim),
            },
          ]);
        expect(heartbeat.presence).toBe('refreshed');

        const score = yield* redis.service.useCommands((commands) =>
          commands.sendCommand<number>([
            'ZSCORE',
            'merkur:control:daemon-presence-deadlines',
            member,
          ]),
        );
        expect(score).toBeGreaterThan(Date.now());
        expect(notifications).toBe(1);
        expect(yield* coordination.getDaemonPresence('daemon-1')).not.toBeNull();
      }),
    );
  });

  test('due worker repairs a persistent claim TTL without a one-millisecond hot loop', async () => {
    const redis = createFakeRedisHarness();
    let notifications = 0;

    await runWithCoordination(redis.service, (coordination) =>
      Effect.gen(function* () {
        const expiryEvaluations = yield* Queue.unbounded<void>();
        redis.setExpiryEvaluationListener(() => {
          Queue.offerUnsafe(expiryEvaluations, undefined);
        });
        yield* coordination.subscribeDeviceEvents('user-1', () => {
          notifications += 1;
        });
        expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-1',
            presenceId: 'presence-1',
            zone: null,
          }),
        );
        yield* coordination.publishDeviceDelta('user-1', ONLINE_EDGE);

        const member = yield* findPresenceDeadlineMember(redis.service, 'daemon-1', 'presence-1');
        yield* redis.service.useCommands(async (commands) => {
          const claimKey = 'merkur:control:daemon-claim:daemon-1:presence-1';
          const rawClaim = yieldRedisString(await commands.sendCommand(['GET', claimKey]));
          // Redis SET without KEEPTTL deliberately simulates a malformed
          // persistent claim left by manual repair or old code.
          await commands.sendCommand(['SET', claimKey, rawClaim]);
          await commands.sendCommand([
            'ZADD',
            'merkur:control:daemon-presence-deadlines',
            '0',
            member,
          ]);
          await commands.sendCommand([
            'PUBLISH',
            'merkur:control:daemon-presence-deadline-events',
            'changed',
          ]);
        });
        yield* Queue.take(expiryEvaluations);

        const [ttl, score] = yield* redis.service.useCommands((commands) =>
          Promise.all([
            commands.sendCommand<number>([
              'PTTL',
              'merkur:control:daemon-claim:daemon-1:presence-1',
            ]),
            commands.sendCommand<number>([
              'ZSCORE',
              'merkur:control:daemon-presence-deadlines',
              member,
            ]),
          ]),
        );
        expect(ttl).toBeGreaterThan(1_000);
        expect(score).toBeGreaterThan(Date.now() + 1_000);
        expect(notifications).toBe(1);
      }),
    );
  });

  test('superseded claim deadline is a fenced no-op', async () => {
    const redis = createFakeRedisHarness();
    let notifications = 0;

    await runWithCoordination(redis.service, (coordination) =>
      Effect.gen(function* () {
        const expiryEvaluations = yield* Queue.unbounded<void>();
        redis.setExpiryEvaluationListener(() => {
          Queue.offerUnsafe(expiryEvaluations, undefined);
        });
        yield* coordination.subscribeDeviceEvents('user-1', () => {
          notifications += 1;
        });
        expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-old',
            presenceId: 'presence-old',
            zone: null,
          }),
        );
        yield* coordination.publishDeviceDelta('user-1', ONLINE_EDGE);
        const staleMember = yield* findPresenceDeadlineMember(
          redis.service,
          'daemon-1',
          'presence-old',
        );
        expectClaimed(
          yield* coordination.claimDaemonOnline({
            daemonId: 'daemon-1',
            userId: 'user-1',
            connectionId: 'connection-new',
            presenceId: 'presence-new',
            zone: null,
          }),
        );
        yield* coordination.publishDeviceDelta('user-1', ONLINE_EDGE);

        yield* redis.service.useCommands(async (commands) => {
          await commands.sendCommand([
            'ZADD',
            'merkur:control:daemon-presence-deadlines',
            '0',
            staleMember,
          ]);
          await commands.sendCommand([
            'PUBLISH',
            'merkur:control:daemon-presence-deadline-events',
            'changed',
          ]);
        });
        yield* Queue.take(expiryEvaluations);

        expect(notifications).toBe(2);
        expect(yield* coordination.getDaemonPresence('daemon-1')).toMatchObject({
          presenceId: 'presence-new',
          connectionId: 'connection-new',
        });
        expect(
          yield* redis.service.useCommands((commands) =>
            commands.sendCommand([
              'ZSCORE',
              'merkur:control:daemon-presence-deadlines',
              staleMember,
            ]),
          ),
        ).toBeNull();
      }),
    );
  });

  test('scope cleanup unsubscribes entries created after service acquisition', async () => {
    const redis = createFakeRedisHarness();

    await runWithCoordination(redis.service, (coordination) =>
      Effect.gen(function* () {
        yield* coordination.subscribeDeviceEvents('user-1', () => {});
        expect(redis.subscribeCalls).toBe(2);
        expect(redis.activeSubscriptionCount).toBe(2);
      }),
    );

    expect(redis.unsubscribeCalls).toBe(2);
    expect(redis.activeSubscriptionCount).toBe(0);
  });

  test('subscription cleanup is idempotent and cannot detach a newer subscription', async () => {
    const redis = createFakeRedisHarness();
    let notifyCount = 0;
    const listener = () => {
      notifyCount += 1;
    };

    await runWithCoordination(redis.service, (coordination) =>
      Effect.gen(function* () {
        const staleCleanup = yield* coordination.subscribeDeviceEvents('user-1', listener);
        yield* staleCleanup;
        expect(redis.unsubscribeCalls).toBe(1);

        const currentCleanup = yield* coordination.subscribeDeviceEvents('user-1', listener);
        yield* staleCleanup;
        yield* coordination.publishDeviceDelta('user-1', TEST_DELTA);
        expect(notifyCount).toBe(1);
        expect(redis.activeSubscriptionCount).toBe(2);

        yield* currentCleanup;
        expect(redis.unsubscribeCalls).toBe(2);
      }),
    );
  });

  test('duplicate listener registrations remain active until every handle is cleaned up', async () => {
    const redis = createFakeRedisHarness();
    let notifyCount = 0;
    const listener = () => {
      notifyCount += 1;
    };

    await runWithCoordination(redis.service, (coordination) =>
      Effect.gen(function* () {
        const firstCleanup = yield* coordination.subscribeDeviceEvents('user-1', listener);
        const secondCleanup = yield* coordination.subscribeDeviceEvents('user-1', listener);

        yield* coordination.publishDeviceDelta('user-1', TEST_DELTA);
        expect(notifyCount).toBe(1);
        yield* firstCleanup;
        expect(redis.unsubscribeCalls).toBe(0);

        yield* coordination.publishDeviceDelta('user-1', TEST_DELTA);
        expect(notifyCount).toBe(2);
        yield* secondCleanup;
        expect(redis.unsubscribeCalls).toBe(1);
      }),
    );
  });

  test('concurrent subscription initialization shares one successful Redis subscribe', async () => {
    const redis = createFakeRedisHarness();
    let firstNotifications = 0;
    let secondNotifications = 0;

    await runWithCoordination(redis.service, (coordination) =>
      Effect.gen(function* () {
        const subscribeStarted = yield* Deferred.make<void>();
        const releaseSubscribe = yield* Deferred.make<void>();
        redis.setSubscribeBehavior(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(subscribeStarted, undefined);
            yield* Deferred.await(releaseSubscribe);
          }),
        );

        const firstFiber = yield* coordination
          .subscribeDeviceEvents('user-1', () => {
            firstNotifications += 1;
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(subscribeStarted);

        const secondStarted = yield* Deferred.make<void>();
        const secondFiber = yield* Effect.gen(function* () {
          yield* Deferred.succeed(secondStarted, undefined);
          return yield* coordination.subscribeDeviceEvents('user-1', () => {
            secondNotifications += 1;
          });
        }).pipe(Effect.forkChild);
        yield* Deferred.await(secondStarted);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseSubscribe, undefined);

        const firstCleanup = yield* Fiber.join(firstFiber);
        const secondCleanup = yield* Fiber.join(secondFiber);
        expect(redis.subscribeCalls).toBe(2);

        yield* coordination.publishDeviceDelta('user-1', TEST_DELTA);
        expect(firstNotifications).toBe(1);
        expect(secondNotifications).toBe(1);

        yield* firstCleanup;
        expect(redis.unsubscribeCalls).toBe(0);
        yield* secondCleanup;
        expect(redis.unsubscribeCalls).toBe(1);
      }),
    );
  });

  test('concurrent subscription initialization propagates the same failure to every caller', async () => {
    const redis = createFakeRedisHarness();
    const subscriptionError = new RedisError({
      cause: new Error('synthetic subscription failure'),
      message: 'Synthetic subscription failure',
    });

    await runWithCoordination(redis.service, (coordination) =>
      Effect.gen(function* () {
        const subscribeStarted = yield* Deferred.make<void>();
        const releaseSubscribe = yield* Deferred.make<void>();
        redis.setSubscribeBehavior(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(subscribeStarted, undefined);
            yield* Deferred.await(releaseSubscribe);
            return yield* subscriptionError;
          }),
        );

        const firstFiber = yield* Effect.result(
          coordination.subscribeDeviceEvents('user-1', () => {}),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(subscribeStarted);

        const secondStarted = yield* Deferred.make<void>();
        const secondFiber = yield* Effect.gen(function* () {
          yield* Deferred.succeed(secondStarted, undefined);
          return yield* Effect.result(coordination.subscribeDeviceEvents('user-1', () => {}));
        }).pipe(Effect.forkChild);
        yield* Deferred.await(secondStarted);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseSubscribe, undefined);

        const firstResult = yield* Fiber.join(firstFiber);
        const secondResult = yield* Fiber.join(secondFiber);
        expect(redis.subscribeCalls).toBe(2);
        expect(Result.isFailure(firstResult)).toBe(true);
        expect(Result.isFailure(secondResult)).toBe(true);
        if (Result.isFailure(firstResult) && Result.isFailure(secondResult)) {
          expect(firstResult.failure).toBe(subscriptionError);
          expect(secondResult.failure).toBe(subscriptionError);
        }

        redis.setSubscribeBehavior(null);
        const cleanup = yield* coordination.subscribeDeviceEvents('user-1', () => {});
        expect(redis.subscribeCalls).toBe(3);
        yield* cleanup;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function runWithCoordination<A>(
  redis: RedisService,
  fn: (coordination: RealtimeCoordinationService) => Effect.Effect<A, RedisError, Scope.Scope>,
): Promise<A> {
  const redisLayer = Layer.succeed(RedisServiceTag, redis);
  const coordinationLayer = RealtimeCoordinationServiceLive.pipe(Layer.provide(redisLayer));
  const program = Effect.gen(function* () {
    const coordination = yield* RealtimeCoordinationServiceTag;
    return yield* fn(coordination);
  });
  return Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(coordinationLayer))));
}

/**
 * `runWithCoordination` on virtual time. Bun's fake timers own `setTimeout` and `Date.now`,
 * the clocks behind `Effect.sleep` and the fake Redis, so the service's bounded waits and the
 * fake's deadlines read one clock; Effect's scheduler turns on `setImmediate`, which stays real.
 */
async function runWithCoordinationOnVirtualTime<A>(
  redis: RedisService,
  fn: (coordination: RealtimeCoordinationService) => Effect.Effect<A, RedisError, Scope.Scope>,
): Promise<A> {
  jest.useFakeTimers();
  try {
    return await runWithCoordination(redis, fn);
  } finally {
    jest.useRealTimers();
  }
}

/** Virtual time one `elapse` may spend; a wait that never ends fails here, not at a timeout. */
const ELAPSE_LIMIT_MS = 10_000;

/**
 * Run `effect` to its end under `runWithCoordinationOnVirtualTime`, advancing one virtual
 * millisecond for each scheduler turn that leaves it unsettled, and report how many passed.
 */
function elapse<A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<{ readonly value: A; readonly elapsedMs: number }, E> {
  return Effect.gen(function* () {
    const startedAt = Date.now();
    const fiber = yield* Effect.forkChild(effect);
    while (fiber.pollUnsafe() === undefined) {
      if (Date.now() - startedAt >= ELAPSE_LIMIT_MS) {
        return yield* Effect.die(new Error(`still waiting after ${ELAPSE_LIMIT_MS} virtual ms`));
      }
      jest.advanceTimersByTime(1);
      yield* Effect.yieldNow;
    }
    return { value: yield* Fiber.join(fiber), elapsedMs: Date.now() - startedAt };
  });
}

function readActiveSession(
  redis: RedisService,
  sessionId: string,
): Effect.Effect<Record<string, unknown> | null, RedisError> {
  return redis.useCommands(async (commands) => {
    const raw = await commands.sendCommand(['GET', `merkur:sessions:active:${sessionId}`]);
    return typeof raw === 'string' ? parseJsonRecord(raw) : null;
  });
}

function runWithTwoCoordinations<A>(
  redis: RedisService,
  fn: (
    first: RealtimeCoordinationService,
    second: RealtimeCoordinationService,
  ) => Effect.Effect<A, RedisError, Scope.Scope>,
): Promise<A> {
  const redisLayer = Layer.succeed(RedisServiceTag, redis);
  const coordinationLayer = RealtimeCoordinationServiceLive.pipe(Layer.provide(redisLayer));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const firstContext = yield* Layer.build(Layer.fresh(coordinationLayer));
        const secondContext = yield* Layer.build(Layer.fresh(coordinationLayer));
        return yield* fn(
          Context.get(firstContext, RealtimeCoordinationServiceTag),
          Context.get(secondContext, RealtimeCoordinationServiceTag),
        );
      }),
    ),
  );
}

function findPresenceDeadlineMember(
  redis: RedisService,
  daemonId: string,
  presenceId: string,
): Effect.Effect<string, RedisError> {
  return Effect.gen(function* () {
    const members = yield* redis.useCommands((commands) =>
      commands.sendCommand<string[]>([
        'ZRANGE',
        'merkur:control:daemon-presence-deadlines',
        '0',
        '-1',
      ]),
    );
    for (const member of members) {
      const identity = parseJsonRecord(member);
      if (identity?.daemonId === daemonId && identity.presenceId === presenceId) {
        return member;
      }
    }
    return yield* new RedisError({
      cause: null,
      message: `Missing presence deadline for ${daemonId}/${presenceId}`,
    });
  });
}

function forcePresenceDeadlineDue(
  redis: RedisService,
  daemonId: string,
  presenceId: string,
): Effect.Effect<void, RedisError> {
  return Effect.gen(function* () {
    const member = yield* findPresenceDeadlineMember(redis, daemonId, presenceId);
    yield* redis.useCommands(async (commands) => {
      await commands.sendCommand(['DEL', `merkur:control:daemon-claim:${daemonId}:${presenceId}`]);
      await commands.sendCommand(['ZADD', 'merkur:control:daemon-presence-deadlines', '0', member]);
      await commands.sendCommand([
        'PUBLISH',
        'merkur:control:daemon-presence-deadline-events',
        'changed',
      ]);
    });
  });
}

function createFakeRedisService(): RedisService {
  return createFakeRedisHarness().service;
}

type SubscribeBehavior = (
  channel: string,
  handler: (message: string) => void,
) => Effect.Effect<void, RedisError>;

interface FakeRedisHarness {
  readonly service: RedisService;
  readonly subscribeCalls: number;
  readonly unsubscribeCalls: number;
  readonly activeSubscriptionCount: number;
  readonly deadlineReadCount: number;
  readonly commandCalls: readonly string[][];
  deliverToSubscribers(message: string): void;
  setExpiryEvaluationListener(listener: (() => void) | null): void;
  setSubscribeBehavior(behavior: SubscribeBehavior | null): void;
  supersedePresenceOnNextSessionCreate(
    daemonId: string,
    presenceId: string,
    claimSeq: number,
  ): void;
}

function createFakeRedisHarness(): FakeRedisHarness {
  const handlersByChannel = new Map<string, Set<(message: string) => void>>();
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  let subscribeBehavior: SubscribeBehavior | null = null;

  function deliver(channel: string, message: string): void {
    const handlers = handlersByChannel.get(channel);
    if (handlers === undefined) return;
    for (const handler of handlers) {
      handler(message);
    }
  }

  const commands = new FakeRedisCommandClient(deliver);
  const service: RedisService = {
    useCommands<T>(fn: (client: RedisCommandClient) => T | PromiseLike<T>) {
      return Effect.tryPromise({
        try: async () => await fn(commands),
        catch: (cause) =>
          new RedisError({
            cause,
            message: 'Fake Redis command failed',
          }),
      });
    },
    publish: (channel, message) =>
      Effect.sync(() => {
        deliver(channel, message);
      }),
    subscribe: (channel, handler) => {
      const configuredBehavior = subscribeBehavior;
      return Effect.sync(() => {
        subscribeCalls++;
      }).pipe(
        Effect.andThen(
          configuredBehavior === null ? Effect.void : configuredBehavior(channel, handler),
        ),
        Effect.andThen(
          Effect.sync(() => {
            getOrCreate(handlersByChannel, channel, () => new Set<(message: string) => void>()).add(
              handler,
            );
          }),
        ),
      );
    },
    unsubscribe: (channel, handler) =>
      Effect.sync(() => {
        unsubscribeCalls++;
        const handlers = handlersByChannel.get(channel);
        if (handlers === undefined) return;
        if (handler === undefined) {
          handlersByChannel.delete(channel);
          return;
        }
        handlers.delete(handler);
        if (handlers.size === 0) {
          handlersByChannel.delete(channel);
        }
      }),
    healthSnapshot: () =>
      Effect.succeed({
        commandsReady: true,
        publisherReady: true,
        subscriberReady: true,
      }),
  };

  return {
    service,
    deliverToSubscribers(message): void {
      for (const handlers of handlersByChannel.values()) {
        for (const handler of handlers) {
          handler(message);
        }
      }
    },
    setSubscribeBehavior(behavior): void {
      subscribeBehavior = behavior;
    },
    setExpiryEvaluationListener(listener): void {
      commands.setExpiryEvaluationListener(listener);
    },
    supersedePresenceOnNextSessionCreate(daemonId, presenceId, claimSeq): void {
      commands.setBeforeSessionCreateEvaluation(() => {
        commands.installCompetingPresence(daemonId, presenceId, claimSeq);
      });
    },
    get subscribeCalls() {
      return subscribeCalls;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    get activeSubscriptionCount() {
      let count = 0;
      for (const handlers of handlersByChannel.values()) {
        count += handlers.size;
      }
      return count;
    },
    get deadlineReadCount() {
      return commands.getDeadlineReadCount();
    },
    get commandCalls() {
      return commands.commandCalls;
    },
  };
}

class FakeRedisCommandClient implements RedisCommandClient {
  readonly commandCalls: string[][] = [];
  private readonly expirationByStringKey = new Map<string, number>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly strings = new Map<string, string>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly zsets = new Map<string, Map<string, number>>();
  private expiryEvaluationListener: (() => void) | null = null;
  private beforeSessionCreateEvaluation: (() => void) | null = null;
  private deadlineReadCount = 0;

  constructor(private readonly publish: (channel: string, message: string) => void = () => {}) {}

  async sendCommand<T = unknown>(args: string[]): Promise<T> {
    this.commandCalls.push([...args]);
    return this.execute(args) as T;
  }

  setExpiryEvaluationListener(listener: (() => void) | null): void {
    this.expiryEvaluationListener = listener;
  }

  getDeadlineReadCount(): number {
    return this.deadlineReadCount;
  }

  setBeforeSessionCreateEvaluation(listener: (() => void) | null): void {
    this.beforeSessionCreateEvaluation = listener;
  }

  installCompetingPresence(daemonId: string, presenceId: string, claimSeq: number): void {
    this.zadd(`merkur:control:daemon-claims:${daemonId}`, [String(claimSeq), presenceId]);
  }

  private execute(args: string[]): unknown {
    const command = readArg(args, 0).toUpperCase();
    switch (command) {
      case 'DEL':
        return this.deleteKeys(args.slice(1));
      case 'EVAL':
        return this.eval(args);
      case 'GET':
        return this.getString(readArg(args, 1));
      case 'MGET':
        return args.slice(1).map((key) => this.getString(key));
      case 'INCR':
        return this.incr(readArg(args, 1));
      case 'PEXPIRE':
        return this.pexpire(readArg(args, 1), Number(readArg(args, 2)));
      case 'PTTL':
        return this.pttl(readArg(args, 1));
      case 'PUBLISH':
        this.publish(readArg(args, 1), readArg(args, 2));
        return 0;
      case 'SADD':
        return this.sadd(readArg(args, 1), args.slice(2));
      case 'SET':
        this.setString(args);
        return 'OK';
      case 'SMEMBERS':
        return Array.from(this.sets.get(readArg(args, 1)) ?? []);
      case 'SREM':
        return this.srem(readArg(args, 1), args.slice(2));
      case 'ZADD':
        return this.zadd(readArg(args, 1), args.slice(2));
      case 'ZRANGE':
        return this.zrange(readArg(args, 1), args.slice(2), false);
      case 'ZREVRANGE':
        return this.zrange(readArg(args, 1), args.slice(2), true);
      case 'ZREM':
        return this.zrem(readArg(args, 1), args.slice(2));
      case 'ZREMRANGEBYSCORE':
        return this.zremrangebyscore(readArg(args, 1), args.slice(2));
      case 'ZSCORE':
        return this.zsets.get(readArg(args, 1))?.get(readArg(args, 2)) ?? null;
      case 'TIME': {
        const now = Date.now();
        return [String(Math.floor(now / 1_000)), String((now % 1_000) * 1_000)];
      }
      default:
        throw new Error(`Unsupported fake Redis command: ${command}`);
    }
  }

  /**
   * Mirrors the Lua: advance the user's counter, mint the epoch if this call is
   * the one that created it, then append the sequence to the prefix.
   *
   * The epoch and the counter share one key here for the same reason they do in
   * Redis — a counter that came back without its epoch, or with one that
   * outlived it, is precisely the state a browser cannot tell from a counter
   * that never moved.
   */
  private publishDelta(cursorKey: string, channel: string, prefix: string, epoch: string): number {
    const seq = this.hincrby(cursorKey, 'seq', 1);
    this.hsetnx(cursorKey, 'epoch', epoch);
    this.publish(channel, `${prefix},"seq":${seq}}`);
    return seq;
  }

  /** Still the raw command: the revocation generation is a plain counter. */
  private incr(key: string): number {
    const value = Number(this.strings.get(key) ?? '0') + 1;
    this.strings.set(key, String(value));
    return value;
  }

  private hash(key: string): Map<string, string> {
    const existing = this.hashes.get(key);
    if (existing !== undefined) return existing;
    const created = new Map<string, string>();
    this.hashes.set(key, created);
    return created;
  }

  private hincrby(key: string, field: string, by: number): number {
    const hash = this.hash(key);
    const value = Number(hash.get(field) ?? '0') + by;
    hash.set(field, String(value));
    return value;
  }

  private hsetnx(key: string, field: string, value: string): boolean {
    const hash = this.hash(key);
    if (hash.has(field)) return false;
    hash.set(field, value);
    return true;
  }

  private eval(args: string[]): unknown {
    const script = readArg(args, 1);
    const keyCount = Number(readArg(args, 2));
    const keys = args.slice(3, 3 + keyCount);
    const argv = args.slice(3 + keyCount);

    if (script.includes('merkur:store-daemon-claim-with-deadline')) {
      const deadline = Date.now() + Number(readArg(argv, 3));
      this.strings.set(readArg(keys, 0), readArg(argv, 0));
      this.expirationByStringKey.set(readArg(keys, 0), deadline);
      this.zadd(readArg(keys, 1), [readArg(argv, 1), readArg(argv, 2)]);
      this.sadd(readArg(keys, 2), [readArg(argv, 5)]);
      this.zadd(readArg(keys, 3), [String(deadline), readArg(argv, 6)]);
      this.publish(readArg(argv, 7), 'changed');
      return deadline;
    }

    if (script.includes('merkur:refresh-daemon-claim-with-deadline')) {
      if (this.getString(readArg(keys, 0)) === null) return [0, 0];
      const presenceId = readArg(argv, 0);
      const claimSeq = Number(readArg(argv, 1));
      const top = this.zrangeMembers(readArg(keys, 1), ['0', '0'], true);
      if (top.length === 0) {
        this.zadd(readArg(keys, 1), [String(claimSeq), presenceId]);
      } else if (top[0] !== presenceId) {
        return [0, 0];
      }
      if (this.zsets.get(readArg(keys, 1))?.get(presenceId) !== claimSeq) {
        return [0, 0];
      }
      const deadline = Date.now() + Number(readArg(argv, 2));
      const deadlineMember = readArg(argv, 4);
      const deadlineWasMissing = this.zsets.get(readArg(keys, 3))?.has(deadlineMember) !== true;
      this.expirationByStringKey.set(readArg(keys, 0), deadline);
      this.zadd(readArg(keys, 3), [String(deadline), deadlineMember]);
      if (deadlineWasMissing) this.publish(readArg(argv, 5), 'changed');
      return [1, deadline, deadlineWasMissing ? 1 : 0];
    }

    if (script.includes('merkur:unmark-daemon-claim-if-current')) {
      const raw = this.getString(readArg(keys, 0));
      if (raw === null) return 0;
      const claim = parseJsonRecord(raw);
      if (
        claim === null ||
        claim.userId !== readArg(argv, 0) ||
        claim.presenceId !== readArg(argv, 1) ||
        claim.claimSeq !== Number(readArg(argv, 2)) ||
        claim.ownerInstanceId !== readArg(argv, 3) ||
        (claim.state !== 'online' && claim.state !== 'silent') ||
        claim.connectionId !== readArg(argv, 6)
      ) {
        return 0;
      }
      const presenceId = readArg(argv, 1);
      const claimSeq = Number(readArg(argv, 2));
      const top = this.zrangeMembers(readArg(keys, 1), ['0', '0'], true);
      if (top[0] !== presenceId || this.zsets.get(readArg(keys, 1))?.get(presenceId) !== claimSeq) {
        return 0;
      }
      this.strings.delete(readArg(keys, 0));
      this.expirationByStringKey.delete(readArg(keys, 0));
      this.zrem(readArg(keys, 1), [presenceId]);
      this.srem(readArg(keys, 2), [readArg(argv, 4)]);
      this.zrem(readArg(keys, 3), [readArg(argv, 5)]);
      this.publishDelta(readArg(keys, 4), readArg(argv, 7), readArg(argv, 8), readArg(argv, 9));
      return 1;
    }

    if (script.includes('merkur:expire-daemon-claim-if-due')) {
      this.expiryEvaluationListener?.();
      const member = readArg(argv, 0);
      const deadlineScore = this.zsets.get(readArg(keys, 3))?.get(member);
      if (deadlineScore === undefined) return [0, 0];
      const now = Date.now();
      if (deadlineScore > now) return [0, deadlineScore];

      const presenceId = readArg(argv, 1);
      const claimSeq = Number(readArg(argv, 2));
      const top = this.zrangeMembers(readArg(keys, 1), ['0', '0'], true);
      if (top[0] !== presenceId || this.zsets.get(readArg(keys, 1))?.get(presenceId) !== claimSeq) {
        this.zrem(readArg(keys, 3), [member]);
        return [0, 0];
      }
      if (this.getString(readArg(keys, 0)) !== null) {
        let ttl = this.pttl(readArg(keys, 0));
        if (ttl < 0) {
          ttl = Number(readArg(argv, 6));
          this.expirationByStringKey.set(readArg(keys, 0), now + ttl);
        }
        const nextDeadline = now + Math.max(ttl, 1);
        this.zadd(readArg(keys, 3), [String(nextDeadline), member]);
        return [0, nextDeadline];
      }

      this.zrem(readArg(keys, 3), [member]);
      this.zrem(readArg(keys, 1), [presenceId]);
      this.srem(readArg(keys, 2), [readArg(argv, 3)]);
      this.publishDelta(readArg(keys, 4), readArg(argv, 4), readArg(argv, 5), readArg(argv, 7));
      return [1, 0];
    }

    if (script.includes('merkur:create-session-for-daemon-claim')) {
      const beforeEvaluation = this.beforeSessionCreateEvaluation;
      this.beforeSessionCreateEvaluation = null;
      beforeEvaluation?.();

      if (this.getString(readArg(keys, 0)) !== readArg(argv, 0)) return 0;
      const presenceId = readArg(argv, 1);
      const claimSeq = Number(readArg(argv, 2));
      const top = this.zrangeMembers(readArg(keys, 1), ['0', '0'], true);
      if (top[0] !== presenceId || this.zsets.get(readArg(keys, 1))?.get(presenceId) !== claimSeq) {
        return 0;
      }
      const activeSessionKey = readArg(keys, 2);
      this.strings.set(activeSessionKey, readArg(argv, 3));
      this.expirationByStringKey.set(activeSessionKey, Date.now() + Number(readArg(argv, 5)));
      this.sadd(readArg(keys, 3), [readArg(argv, 4)]);
      return 1;
    }

    if (script.includes('merkur:suspend-daemon-claim-if-current')) {
      const claimKey = readArg(keys, 0);
      const claimsKey = readArg(keys, 1);
      const deadlinesKey = readArg(keys, 2);
      const expectedRaw = readArg(argv, 0);
      const suspendedRaw = readArg(argv, 1);
      const presenceId = readArg(argv, 2);
      const claimSeq = Number(readArg(argv, 3));
      const graceMs = Number(readArg(argv, 4));
      if (this.getString(claimKey) !== expectedRaw) return 0;
      const top = this.zrangeMembers(claimsKey, ['0', '0'], true);
      if (top[0] !== presenceId || this.zsets.get(claimsKey)?.get(presenceId) !== claimSeq) {
        return 0;
      }
      this.strings.set(claimKey, suspendedRaw);
      this.expirationByStringKey.set(claimKey, Date.now() + graceMs);
      this.zadd(deadlinesKey, [String(Date.now() + graceMs), readArg(argv, 5)]);
      this.publishDelta(readArg(keys, 3), readArg(argv, 7), readArg(argv, 8), readArg(argv, 9));
      return 1;
    }

    if (script.includes('merkur:swap-daemon-claim-state-if-current')) {
      const claimKey = readArg(keys, 0);
      const claimsKey = readArg(keys, 1);
      const expectedRaw = readArg(argv, 0);
      const nextRaw = readArg(argv, 1);
      const presenceId = readArg(argv, 2);
      const claimSeq = Number(readArg(argv, 3));
      if (this.getString(claimKey) !== expectedRaw) return 0;
      const top = this.zrangeMembers(claimsKey, ['0', '0'], true);
      if (top[0] !== presenceId || this.zsets.get(claimsKey)?.get(presenceId) !== claimSeq) {
        return 0;
      }
      // The value changes; its expiry does not.
      this.strings.set(claimKey, nextRaw);
      this.publishDelta(readArg(keys, 2), readArg(argv, 4), readArg(argv, 5), readArg(argv, 6));
      return 1;
    }

    if (script.includes('merkur:resume-daemon-claim-if-suspended')) {
      const claimKey = readArg(keys, 0);
      const claimsKey = readArg(keys, 1);
      const userSetKey = readArg(keys, 2);
      const deadlinesKey = readArg(keys, 3);
      const expectedRaw = readArg(argv, 0);
      const resumedRaw = readArg(argv, 1);
      const presenceId = readArg(argv, 2);
      const claimSeq = Number(readArg(argv, 3));
      const onlineTtlMs = Number(readArg(argv, 4));
      if (this.getString(claimKey) !== expectedRaw) return 0;
      const top = this.zrangeMembers(claimsKey, ['0', '0'], true);
      if (top[0] !== presenceId || this.zsets.get(claimsKey)?.get(presenceId) !== claimSeq) {
        return 0;
      }
      this.strings.set(claimKey, resumedRaw);
      this.expirationByStringKey.set(claimKey, Date.now() + onlineTtlMs);
      this.sadd(userSetKey, [readArg(argv, 6)]);
      this.zadd(deadlinesKey, [String(Date.now() + onlineTtlMs), readArg(argv, 7)]);
      this.publish(readArg(argv, 8), 'changed');
      return 1;
    }

    if (script.includes('merkur:publish-device-delta')) {
      return this.publishDelta(
        readArg(keys, 0),
        readArg(argv, 0),
        readArg(argv, 1),
        readArg(argv, 2),
      );
    }

    if (script.includes('merkur:read-device-events-cursor')) {
      const cursorKey = readArg(keys, 0);
      this.hsetnx(cursorKey, 'epoch', readArg(argv, 0));
      const hash = this.hash(cursorKey);
      return [hash.get('epoch') ?? null, hash.get('seq') ?? '0'];
    }

    if (!script.includes('merkur:remove-session-claim-if-current')) {
      // Without this guard an unrecognised script would fall through to the
      // session-removal branch below and return a plausible 0/1, so a new
      // script would appear to work while silently deleting session claims.
      throw new Error(`fake redis: unhandled script\n${script}`);
    }
    const activeKey = readArg(keys, 0);
    const claimSetKey = readArg(keys, 1);
    const expected = readArg(argv, 0);
    const sessionId = readArg(argv, 1);
    if (this.getString(activeKey) !== expected) return 0;
    this.strings.delete(activeKey);
    this.expirationByStringKey.delete(activeKey);
    this.srem(claimSetKey, [sessionId]);
    return 1;
  }

  private sadd(key: string, members: string[]): number {
    const set = getOrCreate(this.sets, key, () => new Set<string>());
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) added += 1;
      set.add(member);
    }
    return added;
  }

  private srem(key: string, members: string[]): number {
    const set = this.sets.get(key);
    if (set === undefined) return 0;
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed += 1;
    }
    return removed;
  }

  private zadd(key: string, scoreMembers: string[]): number {
    const zset = getOrCreate(this.zsets, key, () => new Map<string, number>());
    let added = 0;
    for (let i = 0; i + 1 < scoreMembers.length; i += 2) {
      const score = Number(scoreMembers[i]);
      const member = readArg(scoreMembers, i + 1);
      if (!zset.has(member)) added += 1;
      zset.set(member, Number.isFinite(score) ? score : 0);
    }
    return added;
  }

  private zrange(key: string, rangeArgs: string[], reverse: boolean): unknown {
    if (key === 'merkur:control:daemon-presence-deadlines') {
      this.deadlineReadCount += 1;
    }
    const selected = this.sortedEntries(key, rangeArgs, reverse);
    if (rangeArgs.some((arg) => arg.toUpperCase() === 'WITHSCORES')) {
      return selected.map(([member, score]) => [member, score]);
    }
    return selected.map(([member]) => member);
  }

  private zrangeMembers(key: string, rangeArgs: string[], reverse: boolean): string[] {
    return this.sortedEntries(key, rangeArgs, reverse).map(([member]) => member);
  }

  private sortedEntries(
    key: string,
    rangeArgs: string[],
    reverse: boolean,
  ): Array<[string, number]> {
    const zset = this.zsets.get(key);
    if (zset === undefined) return [];
    const start = Number(rangeArgs[0] ?? '0');
    const stop = Number(rangeArgs[1] ?? '-1');
    const entries = Array.from(zset.entries()).sort((left, right) => {
      const scoreOrder = reverse ? right[1] - left[1] : left[1] - right[1];
      if (scoreOrder !== 0) return scoreOrder;
      return reverse ? right[0].localeCompare(left[0]) : left[0].localeCompare(right[0]);
    });
    const normalizedStop = stop < 0 ? entries.length + stop : stop;
    return entries.slice(start, normalizedStop + 1);
  }

  private zrem(key: string, members: string[]): number {
    const zset = this.zsets.get(key);
    if (zset === undefined) return 0;
    let removed = 0;
    for (const member of members) {
      if (zset.delete(member)) removed += 1;
    }
    return removed;
  }

  private zremrangebyscore(key: string, scoreRange: string[]): number {
    const zset = this.zsets.get(key);
    if (zset === undefined) return 0;
    const min = Number(scoreRange[0] ?? '-Infinity');
    const max = Number(scoreRange[1] ?? 'Infinity');
    let removed = 0;
    for (const [member, score] of zset) {
      if (score >= min && score <= max) {
        zset.delete(member);
        removed += 1;
      }
    }
    return removed;
  }

  private deleteKeys(keys: string[]): number {
    let removed = 0;
    for (const key of keys) {
      if (this.sets.delete(key)) removed += 1;
      if (this.strings.delete(key)) removed += 1;
      if (this.hashes.delete(key)) removed += 1;
      this.expirationByStringKey.delete(key);
      if (this.zsets.delete(key)) removed += 1;
    }
    return removed;
  }

  private hasKey(key: string): boolean {
    return this.sets.has(key) || this.getString(key) !== null || this.zsets.has(key);
  }

  private getString(key: string): string | null {
    const expiration = this.expirationByStringKey.get(key);
    if (expiration !== undefined && expiration <= Date.now()) {
      this.expirationByStringKey.delete(key);
      this.strings.delete(key);
      return null;
    }
    return this.strings.get(key) ?? null;
  }

  private pexpire(key: string, ttlMs: number): number {
    if (!this.hasKey(key)) return 0;
    if (this.strings.has(key)) {
      this.expirationByStringKey.set(key, Date.now() + ttlMs);
    }
    return 1;
  }

  private pttl(key: string): number {
    if (this.getString(key) === null) return -2;
    const expiration = this.expirationByStringKey.get(key);
    return expiration === undefined ? -1 : Math.max(0, expiration - Date.now());
  }

  private setString(args: string[]): void {
    const key = readArg(args, 1);
    this.strings.set(key, readArg(args, 2));
    const pxIndex = args.findIndex((arg) => arg.toUpperCase() === 'PX');
    if (pxIndex >= 0) {
      this.expirationByStringKey.set(key, Date.now() + Number(readArg(args, pxIndex + 1)));
      return;
    }
    this.expirationByStringKey.delete(key);
  }
}

function expectClaimed(result: ClaimDaemonOnlineResult): number {
  expect(result._tag).toBe('Claimed');
  if (result._tag !== 'Claimed') throw new Error('Expected daemon claim to succeed');
  return result.claimSeq;
}

function readArg(args: string[], index: number): string {
  const value = args[index];
  if (value === undefined) {
    throw new Error(`Missing fake Redis command argument at index ${index}`);
  }
  return value;
}

function yieldRedisString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected a Redis string');
  }
  return value;
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const value = create();
  map.set(key, value);
  return value;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : null;
  } catch {
    return null;
  }
}
