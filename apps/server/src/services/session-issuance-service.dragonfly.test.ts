import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { deriveSessionAuthorizationKeyPair } from '@merkur/auth';
import { RedisClient } from 'bun';
import { Deferred, Effect, Fiber, Layer, Redacted, Ref, Result } from 'effect';

import { provideLayerAroundScopedProgram } from '../../scripts/benchmark-effect-scope';
import { type ServerConfig, ServerConfigService } from '../config';
import type { RedisScript } from './redis-script';
import { type RedisService, RedisServiceLive, RedisServiceTag } from './redis-service';
import {
  type SessionIssuanceCallbacks,
  SessionIssuanceCancelledError,
  SessionIssuanceConflictError,
  type SessionIssuanceInput,
  type SessionIssuanceResponse,
  SessionIssuanceStateError,
} from './session-issuance-contract';
import { SessionIssuanceServiceLive, SessionIssuanceServiceTag } from './session-issuance-service';

const dragonflyUrl = process.env.DRAGONFLY_TEST_URL;
const CONCURRENT_ISSUES = 32;
const COMMITTED_ISSUANCE_TTL_MS = 86_400_000;
const ISSUANCE_RECORD_PREFIX = 'merkur:sessions:issuance:';
const ISSUANCE_LOCK_PREFIX = 'merkur:sessions:issuance-lock:';
const ISSUANCE_CHANNEL_PREFIX = 'merkur:sessions:issuance-events:';
const VALID_CERT_HASH = Buffer.alloc(32, 7).toString('base64');
const DAEMON_IDENTITY_PUBLIC_KEY = Buffer.alloc(2_592, 8).toString('base64url');
const CLIENT_NONCE = Buffer.alloc(32, 9).toString('base64url');
const ENCAPSULATION_KEY = Buffer.alloc(1_568, 10).toString('base64url');
const DAEMON_IDENTITY_KEY_COMMITMENT = Buffer.alloc(64, 11).toString('base64url');
const SESSION_REQUEST_COMMITMENT = Buffer.alloc(64, 12).toString('base64url');
const SUCCESSOR_SESSION_REQUEST_COMMITMENT = Buffer.alloc(64, 13).toString('base64url');
const ROOT_KEY_COMMITMENT = Buffer.alloc(64, 14).toString('base64url');
const DAEMON_BINDING_SIGNATURE = Buffer.alloc(4_627, 15).toString('base64url');
const OPAQUE_SERVER_SETUP =
  'vyR7ewWtDdnfxU9MRNWEe8h5iNJ34K03Ebhh8kCjtN7gBCOX9zs6n9SHAFRwXcd4juUL6EWRm0IRF40gSSEc8Y6PwsHNbCpj5V94McaEgFt_ptz-wy2cZCUgVpJrSusGml8FeZBo9aSfBUDVW8bW5I5XwafKzgMQ4lMiFeZ8BCs';
const OPAQUE_SERVER_PUBLIC_KEY = '_lV018BV4Yes2R8Lq3TmVchsl3XYbxFxC3aHCOGyy1E';

if (dragonflyUrl === undefined) {
  test.skip('deduplicates concurrent session issuance through live Dragonfly', () => {});
} else {
  describe('SessionIssuanceService Dragonfly integration', () => {
    test('rejects prepared and cached identities that disagree with their durable owner', async () => {
      const suffix = randomUUID();
      const input: SessionIssuanceInput = {
        issuanceId: `dragonfly-owner-${suffix}`,
        userId: `dragonfly-user-${suffix}`,
        delegationId: `dragonfly-delegation-${suffix}`,
        daemonId: `dragonfly-daemon-${suffix}`,
        browserNodeId: `dragonfly-browser-${suffix}`,
        daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
        sessionRequestCommitment: SESSION_REQUEST_COMMITMENT,
      };
      const keys = issuanceKeys(input.userId, input.issuanceId);
      const program = Effect.gen(function* () {
        const issuance = yield* SessionIssuanceServiceTag;
        const redis = yield* RedisServiceTag;
        let deliveries = 0;
        let compensations = 0;
        const callbacks = callbacksFor(input, {
          prepared: () => {},
          delivered: () => {
            deliveries += 1;
          },
          compensated: () => {
            compensations += 1;
          },
        });
        const invalidPreparation = yield* Effect.result(
          issuance.issue(input, {
            ...callbacks,
            prepare: (sessionId) =>
              callbacks.prepare(sessionId).pipe(
                Effect.map((prepared) => ({
                  ...prepared,
                  response: {
                    ...prepared.response,
                    daemonBinding: {
                      ...prepared.response.daemonBinding,
                      daemonIdentityKeyCommitment: Buffer.alloc(64, 99).toString('base64url'),
                    },
                  },
                })),
              ),
          }),
        );
        expect(Result.isFailure(invalidPreparation)).toBe(true);
        if (Result.isFailure(invalidPreparation)) {
          expect(invalidPreparation.failure).toBeInstanceOf(SessionIssuanceStateError);
        }
        expect(deliveries).toBe(0);
        expect(compensations).toBe(1);
        const prepared = yield* issuance.issue(input, callbacks);
        const corrupted = {
          ...input,
          state: 'committed',
          sessionId: prepared.sessionId,
          expiresAtMs: prepared.sessionTokenExpiresAtMs,
          response: {
            ...prepared,
            controlPresence: { ...prepared.controlPresence, userId: 'other-account' },
            daemonBinding: { ...prepared.daemonBinding, userId: 'other-account' },
          },
        };
        yield* redis.useCommands((commands) =>
          commands.sendCommand([
            'SET',
            keys.record,
            JSON.stringify(corrupted),
            'PX',
            String(COMMITTED_ISSUANCE_TTL_MS),
          ]),
        );
        const invalidReplay = yield* Effect.result(issuance.issue(input, callbacks));
        expect(Result.isFailure(invalidReplay)).toBe(true);
        if (Result.isFailure(invalidReplay)) {
          expect(invalidReplay.failure).toBeInstanceOf(SessionIssuanceStateError);
        }
        expect(deliveries).toBe(1);
      });
      await Effect.runPromise(
        provideLayerAroundScopedProgram(
          program.pipe(
            Effect.ensuring(
              Effect.flatMap(RedisServiceTag, (redis) =>
                redis
                  .useCommands((commands) => commands.sendCommand(['DEL', keys.record, keys.lock]))
                  .pipe(Effect.ignore),
              ),
            ),
          ),
          createIssuanceLayer(dragonflyUrl),
        ),
      );
    });

    test('fresh issuance commits through three fenced Redis transitions', async () => {
      const suffix = randomUUID();
      const input: SessionIssuanceInput = {
        issuanceId: `dragonfly-fresh-${suffix}`,
        userId: `dragonfly-user-${suffix}`,
        delegationId: `dragonfly-delegation-${suffix}`,
        daemonId: `dragonfly-daemon-${suffix}`,
        browserNodeId: `dragonfly-browser-${suffix}`,
        daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
        sessionRequestCommitment: SESSION_REQUEST_COMMITMENT,
      };
      const tracker = new IssuanceSubscriptionTracker(0);
      const program = Effect.gen(function* () {
        const issuance = yield* SessionIssuanceServiceTag;
        const redis = yield* RedisServiceTag;
        const result = yield* issuance.issue(
          input,
          callbacksFor(input, {
            prepared: () => {},
            delivered: () => {},
            compensated: () => {},
          }),
        );
        expect(tracker.commandScripts).toEqual([
          'session-issuance-initialize-lease-and-read',
          'session-issuance-store-if-owner',
          'session-issuance-store-if-owner',
        ]);
        const keys = issuanceKeys(input.userId, input.issuanceId);
        yield* redis.useCommands((commands) =>
          commands.sendCommand(['DEL', keys.record, keys.lock]),
        );
        return result;
      });
      const result = await Effect.runPromise(
        provideLayerAroundScopedProgram(program, createIssuanceLayer(dragonflyUrl, tracker)),
      );
      expect(result.daemonId).toBe(input.daemonId);
      expect(tracker.count).toBe(0);
    });

    for (const phase of ['preparation', 'delivery'] as const) {
      test(`interrupted ${phase} releases the live lease without changing the session identity`, async () => {
        const suffix = randomUUID();
        const input: SessionIssuanceInput = {
          issuanceId: `dragonfly-interrupt-${suffix}`,
          userId: `dragonfly-user-${suffix}`,
          delegationId: `dragonfly-delegation-${suffix}`,
          daemonId: `dragonfly-daemon-${suffix}`,
          browserNodeId: `dragonfly-browser-${suffix}`,
          daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
          sessionRequestCommitment: SESSION_REQUEST_COMMITMENT,
        };
        const keys = issuanceKeys(input.userId, input.issuanceId);
        const tracker = new IssuanceSubscriptionTracker(0);
        const program = Effect.gen(function* () {
          const issuance = yield* SessionIssuanceServiceTag;
          const redis = yield* RedisServiceTag;
          const started = yield* Deferred.make<void>();
          let durableSessionId = '';
          let delivered: SessionIssuanceResponse | undefined;
          const callbacks = callbacksFor(input, {
            prepared: () => {},
            delivered: () => {},
            compensated: () => {},
          });
          const owner = yield* issuance
            .issue(input, {
              prepare: (sessionId) =>
                Effect.gen(function* () {
                  durableSessionId = sessionId;
                  if (phase === 'preparation') {
                    yield* Deferred.succeed(started, undefined);
                    return yield* Effect.never;
                  }
                  return yield* callbacks.prepare(sessionId);
                }),
              deliver: (response) =>
                Effect.gen(function* () {
                  delivered = response;
                  yield* Deferred.succeed(started, undefined);
                  return yield* Effect.never;
                }),
              compensate: () => Effect.die('Interruption must preserve durable ownership'),
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(started);
          yield* Fiber.interrupt(owner);
          const lock = yield* redis.useCommands((commands) =>
            commands.sendCommand(['GET', keys.lock]),
          );
          expect(lock).toBeNull();
          const recovered = yield* issuance.issue(input, {
            ...callbacks,
            prepare: (sessionId) =>
              phase === 'delivery'
                ? Effect.die('Delivery replay must use the exact durable response')
                : callbacks.prepare(sessionId),
          });
          expect(recovered.sessionId).toBe(durableSessionId);
          if (phase === 'delivery') {
            if (delivered === undefined)
              return yield* Effect.die('The first delivery must have started');
            expect(recovered).toEqual(delivered);
          }
          expect(tracker.count).toBe(0);
        }).pipe(
          Effect.ensuring(
            Effect.flatMap(RedisServiceTag, (redis) =>
              redis
                .useCommands((commands) => commands.sendCommand(['DEL', keys.record, keys.lock]))
                .pipe(Effect.ignore),
            ),
          ),
        );
        await Effect.runPromise(
          provideLayerAroundScopedProgram(program, createIssuanceLayer(dragonflyUrl, tracker)).pipe(
            Effect.timeout('10 seconds'),
          ),
        );
      });
    }

    test('deduplicates 32 concurrent issues into one preparation and delivery', async () => {
      const suffix = randomUUID();
      const input: SessionIssuanceInput = {
        issuanceId: `dragonfly-issuance-${suffix}`,
        userId: `dragonfly-user-${suffix}`,
        delegationId: `dragonfly-delegation-${suffix}`,
        daemonId: `dragonfly-daemon-${suffix}`,
        browserNodeId: `dragonfly-browser-${suffix}`,
        daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
        sessionRequestCommitment: SESSION_REQUEST_COMMITMENT,
      };
      const keys = issuanceKeys(input.userId, input.issuanceId);
      const tracker = new IssuanceSubscriptionTracker(CONCURRENT_ISSUES - 1);
      const probe = new RedisClient(dragonflyUrl);
      await probe.connect();

      try {
        const program = Effect.gen(function* () {
          const issuance = yield* SessionIssuanceServiceTag;
          const allReady = yield* Deferred.make<void>();
          const start = yield* Deferred.make<void>();
          const preparationStarted = yield* Deferred.make<void>();
          const releasePreparation = yield* Deferred.make<void>();
          const readyCount = yield* Ref.make(0);
          let prepares = 0;
          let deliveries = 0;
          let compensations = 0;
          const callbacks: SessionIssuanceCallbacks = {
            prepare: (sessionId) =>
              Effect.gen(function* () {
                prepares += 1;
                yield* Deferred.succeed(preparationStarted, undefined);
                yield* Deferred.await(releasePreparation);
                const expiresAtMs = Date.now() + 3_600_000;
                return {
                  response: response(input, sessionId, expiresAtMs),
                  expiresAtMs,
                };
              }),
            deliver: () =>
              Effect.sync(() => {
                deliveries += 1;
              }),
            compensate: () =>
              Effect.sync(() => {
                compensations += 1;
              }),
          };

          const issues = yield* Effect.forEach(
            Array.from({ length: CONCURRENT_ISSUES }),
            () =>
              Effect.gen(function* () {
                const ready = yield* Ref.updateAndGet(readyCount, (count) => count + 1);
                if (ready === CONCURRENT_ISSUES) {
                  yield* Deferred.succeed(allReady, undefined);
                }
                yield* Deferred.await(start);
                return yield* issuance.issue(input, callbacks);
              }),
            { concurrency: 'unbounded' },
          ).pipe(Effect.forkChild({ startImmediately: true }));

          yield* Deferred.await(allReady);
          yield* Deferred.succeed(start, undefined);
          yield* Deferred.await(preparationStarted);
          yield* Effect.promise(() => tracker.reachedTarget);
          yield* Deferred.succeed(releasePreparation, undefined);
          const results = yield* Fiber.join(issues);

          const first = results[0];
          if (first === undefined) {
            return yield* Effect.die(new Error('Concurrent issuance returned no results'));
          }
          expect(results).toHaveLength(CONCURRENT_ISSUES);
          for (const result of results) expect(result).toEqual(first);
          expect(prepares).toBe(1);
          expect(deliveries).toBe(1);
          expect(compensations).toBe(0);
          expect(tracker.count).toBe(CONCURRENT_ISSUES - 1);
        });
        const layer = createIssuanceLayer(dragonflyUrl, tracker);

        await Effect.runPromise(
          provideLayerAroundScopedProgram(program, layer).pipe(Effect.timeout('10 seconds')),
        );

        const [rawRecord, recordTtlMs, lockExists] = await Promise.all([
          probe.get(keys.record),
          probe.pttl(keys.record),
          probe.exists(keys.lock),
        ]);
        if (rawRecord === null) throw new Error('Expected committed session issuance record');
        const storedRecord: unknown = JSON.parse(rawRecord);
        expect(storedRecord).toMatchObject({
          state: 'committed',
          issuanceId: input.issuanceId,
          userId: input.userId,
          daemonId: input.daemonId,
          browserNodeId: input.browserNodeId,
        });
        expect(recordTtlMs).toBeGreaterThan(0);
        expect(recordTtlMs).toBeLessThanOrEqual(COMMITTED_ISSUANCE_TTL_MS);
        expect(lockExists).toBe(false);
      } finally {
        try {
          await cleanupIssuance(probe, keys);
        } finally {
          probe.close();
        }
      }
    }, 15_000);

    test('rejects the losing identity when initialization races on one issuance key', async () => {
      const suffix = randomUUID();
      const common = {
        issuanceId: `dragonfly-conflict-issuance-${suffix}`,
        userId: `dragonfly-conflict-user-${suffix}`,
        delegationId: `dragonfly-conflict-delegation-${suffix}`,
      } as const;
      const inputs: readonly [SessionIssuanceInput, SessionIssuanceInput] = [
        {
          ...common,
          daemonId: `dragonfly-conflict-daemon-a-${suffix}`,
          browserNodeId: `dragonfly-conflict-browser-a-${suffix}`,
          daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
          sessionRequestCommitment: SESSION_REQUEST_COMMITMENT,
        },
        {
          ...common,
          daemonId: `dragonfly-conflict-daemon-b-${suffix}`,
          browserNodeId: `dragonfly-conflict-browser-b-${suffix}`,
          daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
          sessionRequestCommitment: SESSION_REQUEST_COMMITMENT,
        },
      ];
      const keys = issuanceKeys(common.userId, common.issuanceId);
      const probe = new RedisClient(dragonflyUrl);
      await probe.connect();

      try {
        const program = Effect.gen(function* () {
          const issuance = yield* SessionIssuanceServiceTag;
          const allReady = yield* Deferred.make<void>();
          const start = yield* Deferred.make<void>();
          const readyCount = yield* Ref.make(0);
          let prepares = 0;
          let deliveries = 0;
          let compensations = 0;
          const issue = (input: SessionIssuanceInput) =>
            Effect.gen(function* () {
              const ready = yield* Ref.updateAndGet(readyCount, (count) => count + 1);
              if (ready === inputs.length) yield* Deferred.succeed(allReady, undefined);
              yield* Deferred.await(start);
              return yield* Effect.result(
                issuance.issue(
                  input,
                  callbacksFor(input, {
                    prepared: () => {
                      prepares += 1;
                    },
                    delivered: () => {
                      deliveries += 1;
                    },
                    compensated: () => {
                      compensations += 1;
                    },
                  }),
                ),
              );
            });
          const racingIssues = yield* Effect.forEach(inputs, issue, {
            concurrency: 'unbounded',
          }).pipe(Effect.forkChild({ startImmediately: true }));

          yield* Deferred.await(allReady);
          yield* Deferred.succeed(start, undefined);
          const results = yield* Fiber.join(racingIssues);
          const successes = results.filter(Result.isSuccess);
          const failures = results.filter(Result.isFailure);

          expect(successes).toHaveLength(1);
          expect(failures).toHaveLength(1);
          expect(failures[0]?.failure).toBeInstanceOf(SessionIssuanceConflictError);
          expect(prepares).toBe(1);
          expect(deliveries).toBe(1);
          expect(compensations).toBe(0);
        });
        const layer = createIssuanceLayer(dragonflyUrl);

        await Effect.runPromise(
          provideLayerAroundScopedProgram(program, layer).pipe(Effect.timeout('10 seconds')),
        );

        const [rawRecord, recordTtlMs, lockExists] = await Promise.all([
          probe.get(keys.record),
          probe.pttl(keys.record),
          probe.exists(keys.lock),
        ]);
        if (rawRecord === null) throw new Error('Expected winning session issuance record');
        const storedRecord: unknown = JSON.parse(rawRecord);
        expect(storedRecord).toMatchObject({
          state: 'committed',
          issuanceId: common.issuanceId,
          userId: common.userId,
        });
        expect(recordTtlMs).toBeGreaterThan(0);
        expect(recordTtlMs).toBeLessThanOrEqual(COMMITTED_ISSUANCE_TTL_MS);
        expect(lockExists).toBe(false);
      } finally {
        try {
          await cleanupIssuance(probe, keys);
        } finally {
          probe.close();
        }
      }
    }, 15_000);

    test('reserves a successor and tombstones a predecessor that has not initialized yet', async () => {
      const suffix = randomUUID();
      const predecessor: SessionIssuanceInput = {
        issuanceId: `dragonfly-missing-predecessor-${suffix}`,
        userId: `dragonfly-missing-user-${suffix}`,
        delegationId: `dragonfly-missing-delegation-${suffix}`,
        daemonId: `dragonfly-missing-daemon-${suffix}`,
        browserNodeId: `dragonfly-missing-browser-${suffix}`,
        daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
        sessionRequestCommitment: SESSION_REQUEST_COMMITMENT,
      };
      const successor: SessionIssuanceInput = {
        ...predecessor,
        issuanceId: `dragonfly-missing-successor-${suffix}`,
        sessionRequestCommitment: SUCCESSOR_SESSION_REQUEST_COMMITMENT,
      };
      const supersession = {
        userId: predecessor.userId,
        delegationId: predecessor.delegationId,
        predecessorIssuanceId: predecessor.issuanceId,
        successorIssuanceId: successor.issuanceId,
        daemonId: predecessor.daemonId,
        browserNodeId: predecessor.browserNodeId,
        daemonIdentityKeyCommitment: predecessor.daemonIdentityKeyCommitment,
        sessionRequestCommitment: successor.sessionRequestCommitment,
      } as const;
      const predecessorKeys = issuanceKeys(predecessor.userId, predecessor.issuanceId);
      const successorKeys = issuanceKeys(successor.userId, successor.issuanceId);
      const probe = new RedisClient(dragonflyUrl);
      await probe.connect();

      try {
        const program = Effect.gen(function* () {
          const issuance = yield* SessionIssuanceServiceTag;
          let prepares = 0;
          let deliveries = 0;
          let compensations = 0;
          const counters: CallbackCounters = {
            prepared: () => {
              prepares += 1;
            },
            delivered: () => {
              deliveries += 1;
            },
            compensated: () => {
              compensations += 1;
            },
          };

          expect(yield* issuance.supersede(supersession)).toEqual({ _tag: 'Missing' });
          expect(yield* issuance.supersede(supersession)).toEqual({ _tag: 'Missing' });
          expect(yield* issuance.cancel(predecessor.userId, predecessor.issuanceId)).toEqual({
            _tag: 'Missing',
          });

          const latePredecessor = yield* Effect.result(
            issuance.issue(predecessor, callbacksFor(predecessor, counters)),
          );
          expect(Result.isFailure(latePredecessor)).toBe(true);
          if (Result.isFailure(latePredecessor)) {
            expect(latePredecessor.failure).toBeInstanceOf(SessionIssuanceCancelledError);
          }
          expect({ prepares, deliveries, compensations }).toEqual({
            prepares: 0,
            deliveries: 0,
            compensations: 0,
          });

          yield* issuance.issue(successor, callbacksFor(successor, counters));
          expect({ prepares, deliveries, compensations }).toEqual({
            prepares: 1,
            deliveries: 1,
            compensations: 0,
          });
        });
        await Effect.runPromise(
          provideLayerAroundScopedProgram(program, createIssuanceLayer(dragonflyUrl)).pipe(
            Effect.timeout('10 seconds'),
          ),
        );

        const [predecessorRaw, successorRaw] = await Promise.all([
          probe.get(predecessorKeys.record),
          probe.get(successorKeys.record),
        ]);
        if (predecessorRaw === null || successorRaw === null) {
          throw new Error('Expected missing-predecessor tombstone and reserved successor');
        }
        expect(JSON.parse(predecessorRaw)).toMatchObject({
          state: 'superseded_missing',
          issuanceId: predecessor.issuanceId,
          successorIssuanceId: successor.issuanceId,
          successorSessionRequestCommitment: successor.sessionRequestCommitment,
        });
        expect(JSON.parse(successorRaw)).toMatchObject({
          state: 'committed',
          issuanceId: successor.issuanceId,
        });
      } finally {
        try {
          await cleanupIssuance(probe, predecessorKeys);
          await cleanupIssuance(probe, successorKeys);
        } finally {
          probe.close();
        }
      }
    }, 15_000);
  });
}

interface IssuanceKeys {
  readonly record: string;
  readonly lock: string;
}

interface CallbackCounters {
  readonly prepared: () => void;
  readonly delivered: () => void;
  readonly compensated: () => void;
}

class IssuanceSubscriptionTracker {
  count = 0;
  readonly commandScripts: string[] = [];
  readonly reachedTarget: Promise<void>;
  private resolveTarget: () => void = () => {};

  constructor(private readonly target: number) {
    this.reachedTarget = new Promise<void>((resolve) => {
      this.resolveTarget = resolve;
    });
  }

  record(channel: string): void {
    if (!channel.startsWith(ISSUANCE_CHANNEL_PREFIX)) return;
    this.count += 1;
    if (this.count === this.target) this.resolveTarget();
  }
}

function createIssuanceLayer(redisUrl: string, tracker?: IssuanceSubscriptionTracker) {
  const configLayer = Layer.succeed(ServerConfigService, testConfig(redisUrl));
  const redisLayer = RedisServiceLive.pipe(Layer.provide(configLayer));
  if (tracker === undefined) {
    return SessionIssuanceServiceLive.pipe(Layer.provideMerge(redisLayer));
  }
  const trackedRedisLayer = Layer.effect(
    RedisServiceTag,
    Effect.gen(function* () {
      return trackSubscriptions(yield* RedisServiceTag, tracker);
    }),
  ).pipe(Layer.provide(redisLayer));
  return SessionIssuanceServiceLive.pipe(Layer.provideMerge(trackedRedisLayer));
}

function trackSubscriptions(
  delegate: RedisService,
  tracker: IssuanceSubscriptionTracker,
): RedisService {
  return {
    useCommands: (use) =>
      delegate.useCommands((client) =>
        use({
          sendCommand: (args) => client.sendCommand(args),
          ...(client.evalScript === undefined
            ? {}
            : {
                evalScript: <T = unknown>(
                  script: RedisScript,
                  keys: readonly string[],
                  args: readonly string[],
                ) => {
                  tracker.commandScripts.push(script.name);
                  const evaluate = client.evalScript;
                  if (evaluate === undefined)
                    throw new Error('Live Redis script evaluator disappeared');
                  return evaluate<T>(script, keys, args);
                },
              }),
        }),
      ),
    publish: (channel, message) => delegate.publish(channel, message),
    subscribe: (channel, handler) =>
      delegate.subscribe(channel, handler).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            tracker.record(channel);
          }),
        ),
      ),
    unsubscribe: (channel, handler) => delegate.unsubscribe(channel, handler),
    loadScripts: (scripts) => delegate.loadScripts?.(scripts) ?? Effect.void,
    healthSnapshot: () => delegate.healthSnapshot(),
  };
}

function callbacksFor(
  input: SessionIssuanceInput,
  counters: CallbackCounters,
): SessionIssuanceCallbacks {
  return {
    prepare: (sessionId) =>
      Effect.sync(() => {
        counters.prepared();
        const expiresAtMs = Date.now() + 3_600_000;
        return {
          response: response(input, sessionId, expiresAtMs),
          expiresAtMs,
        };
      }),
    deliver: () =>
      Effect.sync(() => {
        counters.delivered();
      }),
    compensate: () =>
      Effect.sync(() => {
        counters.compensated();
      }),
  };
}

function response(
  input: SessionIssuanceInput,
  sessionId: string,
  expiresAtMs: number,
): SessionIssuanceResponse {
  return {
    daemonId: input.daemonId,
    daemonIdentityPublicKey: DAEMON_IDENTITY_PUBLIC_KEY,
    daemonIdentityP256PublicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 2)]).toString(
      'base64url',
    ),
    daemonBinding: {
      userId: input.userId,
      rootKeyCommitment: ROOT_KEY_COMMITMENT,
      daemonId: input.daemonId,
      daemonIdentityKeyCommitment: input.daemonIdentityKeyCommitment,
      serverOrigin: 'https://merkur.example',
      linkClaimId: 'dragonfly-link-claim',
      issuedAt: 1,
      signature: DAEMON_BINDING_SIGNATURE,
    },
    controlPresence: {
      daemonId: input.daemonId,
      userId: input.userId,
      ownerInstanceId: 'dragonfly-test-instance',
      connectionId: 'dragonfly-test-connection',
      presenceId: 'dragonfly-test-presence',
      claimSeq: 1,
      state: 'online',
      updatedAt: Date.now(),
      zone: null,
    },
    sessionToken: `dragonfly-test-token-${sessionId}`,
    sessionTokenExpiresAtMs: expiresAtMs,
    sessionId,
    edgeWtUrl: 'https://edge.example/',
    edgeCertHashes: [VALID_CERT_HASH],
    edgeAttachTicket: Buffer.alloc(26, 1).toString('base64url'),
    clientNonce: CLIENT_NONCE,
    encapsulationKey: ENCAPSULATION_KEY,
  };
}

function issuanceKeys(userId: string, issuanceId: string): IssuanceKeys {
  const digest = createHash('sha256')
    .update(userId)
    .update('\0')
    .update(issuanceId)
    .digest('base64url');
  return {
    record: `${ISSUANCE_RECORD_PREFIX}${digest}`,
    lock: `${ISSUANCE_LOCK_PREFIX}${digest}`,
  };
}

async function cleanupIssuance(
  probe: { del(...keys: string[]): Promise<unknown> },
  keys: IssuanceKeys,
): Promise<void> {
  await probe.del(keys.record, keys.lock);
}

function testConfig(redisUrl: string): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 3000,
    dbUrl: ':memory:',
    dbAuthToken: undefined,
    redisUrl: Redacted.make(redisUrl),
    publicOrigin: 'https://localhost:3000',
    website: undefined,
    accessTokenHmacKey: new Uint8Array(64),
    jwtIssuer: 'merkur',
    jwtAudience: 'merkur-clients',
    tokenHmacSecret: Redacted.make('test'),
    authAllowRegistration: false,
    authIdentity: 'username',
    emailDelivery: undefined,
    opaqueServerSetup: Redacted.make(OPAQUE_SERVER_SETUP),
    opaqueServerPublicKey: OPAQUE_SERVER_PUBLIC_KEY,
    trustedProxyHops: 0,
    sessionTokenSigningKey: deriveSessionAuthorizationKeyPair(new Uint8Array(32)).signingKey,
    sessionTokenVerifyKeyB64: 'A'.repeat(3_456),
    sessionTokenTtlMs: 60_000,
    webPush: undefined,
    edgeRegistrationKeys: new Map(),
    telemetry: undefined,
    traceLevel: 'Info',
    traceSampleRatio: 1,
    traceSlowThresholdMs: 1_000,
    boxHost: undefined,
    stunTicketKey: new Uint8Array(64),
    edgeAttachTicketKey: new Uint8Array(64).fill(11),
    stunServers: ['stun.test:3478', 'stun.test:3479'],
    boxHostStunObservers: [],
  };
}
