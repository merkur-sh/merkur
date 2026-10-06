import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Deferred, Effect, Fiber, Result } from 'effect';
import { type RedisCommandClient, RedisError, type RedisService } from './redis-service';
import { parseStoredSessionIssuance } from './session-issuance-codec';
import {
  type SessionIssuanceCallbacks,
  SessionIssuanceCancelledError,
  SessionIssuanceConflictError,
  SessionIssuanceExpiredError,
  type SessionIssuanceInput,
  type SessionIssuanceResponse,
  SessionIssuanceStateError,
} from './session-issuance-contract';
import {
  createSessionIssuanceService,
  type SessionIssuanceError,
} from './session-issuance-service';

const VALID_CERT_HASH = Buffer.alloc(32, 1).toString('base64');
const DAEMON_IDENTITY_PUBLIC_KEY = Buffer.alloc(2_592, 2).toString('base64url');
const CLIENT_NONCE = Buffer.alloc(32, 3).toString('base64url');
const ENCAPSULATION_KEY = Buffer.alloc(1_568, 4).toString('base64url');
const DAEMON_IDENTITY_KEY_COMMITMENT = Buffer.alloc(64, 5).toString('base64url');
const SESSION_REQUEST_COMMITMENT = Buffer.alloc(64, 6).toString('base64url');
const SUCCESSOR_SESSION_REQUEST_COMMITMENT = Buffer.alloc(64, 7).toString('base64url');
const ROOT_KEY_COMMITMENT = Buffer.alloc(64, 8).toString('base64url');
const DAEMON_BINDING_SIGNATURE = Buffer.alloc(4_627, 9).toString('base64url');

interface PromiseLatch<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function promiseLatch<T>(): PromiseLatch<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function response(sessionId: string, expiresAtMs = 100_000): SessionIssuanceResponse {
  return {
    daemonId: 'daemon-1',
    daemonIdentityPublicKey: DAEMON_IDENTITY_PUBLIC_KEY,
    daemonIdentityP256PublicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 2)]).toString(
      'base64url',
    ),
    daemonBinding: {
      userId: 'user-1',
      rootKeyCommitment: ROOT_KEY_COMMITMENT,
      daemonId: 'daemon-1',
      daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
      serverOrigin: 'https://merkur.example',
      linkClaimId: 'link-claim-1',
      issuedAt: 1,
      signature: DAEMON_BINDING_SIGNATURE,
    },
    controlPresence: {
      daemonId: 'daemon-1',
      userId: 'user-1',
      ownerInstanceId: 'instance-1',
      connectionId: 'connection-1',
      presenceId: 'presence-1',
      claimSeq: 1,
      state: 'online',
      updatedAt: 1,
      zone: null,
    },
    sessionToken: `token-${sessionId}`,
    sessionTokenExpiresAtMs: expiresAtMs,
    sessionId,
    edgeWtUrl: 'https://edge.example/',
    edgeCertHashes: [VALID_CERT_HASH],
    edgeAttachTicket: Buffer.alloc(26, 1).toString('base64url'),
    clientNonce: CLIENT_NONCE,
    encapsulationKey: ENCAPSULATION_KEY,
  };
}

const input = {
  issuanceId: 'issuance-1',
  userId: 'user-1',
  delegationId: 'delegation-1',
  daemonId: 'daemon-1',
  browserNodeId: 'browser-1',
  daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
  sessionRequestCommitment: SESSION_REQUEST_COMMITMENT,
} as const;

const supersession = {
  userId: input.userId,
  delegationId: input.delegationId,
  predecessorIssuanceId: input.issuanceId,
  successorIssuanceId: 'issuance-2',
  daemonId: input.daemonId,
  browserNodeId: input.browserNodeId,
  daemonIdentityKeyCommitment: input.daemonIdentityKeyCommitment,
  sessionRequestCommitment: SUCCESSOR_SESSION_REQUEST_COMMITMENT,
} as const;

describe('SessionIssuanceService', () => {
  test('decodes every durable state while rejecting malformed lineage and successor fields', () => {
    for (const state of [
      'allocating',
      'prepared',
      'committed',
      'cancelled',
      'expired',
      'superseded',
      'superseded_missing',
    ]) {
      const record: Record<string, unknown> = { ...input, state, sessionId: 'session-1' };
      if (state === 'prepared' || state === 'committed') {
        record.response = response('session-1');
        record.expiresAtMs = 100_000;
      }
      if (state === 'superseded' || state === 'superseded_missing') {
        record.successorIssuanceId = supersession.successorIssuanceId;
        record.successorSessionRequestCommitment = supersession.sessionRequestCommitment;
      }
      if (state === 'superseded_missing') {
        delete record.sessionId;
        delete record.sessionRequestCommitment;
      }
      const decoded: unknown = parseStoredSessionIssuance(JSON.stringify(record));
      expect(decoded).toEqual(record);
      expect(parseStoredSessionIssuance(JSON.stringify({ ...record, extra: true }))).toBeNull();
      for (const key of Object.keys(record)) {
        const incomplete = { ...record };
        delete incomplete[key];
        expect(parseStoredSessionIssuance(JSON.stringify(incomplete))).toBeNull();
      }
      for (const key of [
        'issuanceId',
        'userId',
        'delegationId',
        'daemonId',
        'browserNodeId',
        'daemonIdentityKeyCommitment',
        ...(state === 'superseded' || state === 'superseded_missing'
          ? ['successorIssuanceId', 'successorSessionRequestCommitment']
          : []),
      ]) {
        for (const value of ['', null, 42]) {
          expect(
            parseStoredSessionIssuance(JSON.stringify({ ...record, [key]: value })),
          ).toBeNull();
        }
      }
    }
  });

  test('refuses preparation outside the durable daemon and account identity', async () => {
    for (const mismatch of ['daemon', 'account', 'binding'] as const) {
      const redis = new FakeRedis();
      const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
      let deliveries = 0;
      let compensations = 0;
      const result = await Effect.runPromise(
        Effect.result(
          service.issue(input, {
            prepare: (sessionId) => {
              const prepared = response(sessionId);
              return Effect.succeed({
                expiresAtMs: 100_000,
                response: {
                  ...prepared,
                  ...(mismatch === 'daemon'
                    ? {
                        daemonId: 'other-daemon',
                        controlPresence: { ...prepared.controlPresence, daemonId: 'other-daemon' },
                        daemonBinding: { ...prepared.daemonBinding, daemonId: 'other-daemon' },
                      }
                    : mismatch === 'account'
                      ? {
                          controlPresence: { ...prepared.controlPresence, userId: 'other-user' },
                          daemonBinding: { ...prepared.daemonBinding, userId: 'other-user' },
                        }
                      : {
                          daemonBinding: {
                            ...prepared.daemonBinding,
                            daemonIdentityKeyCommitment: Buffer.alloc(64, 99).toString('base64url'),
                          },
                        }),
                },
              });
            },
            deliver: () =>
              Effect.sync(() => {
                deliveries += 1;
              }),
            compensate: () =>
              Effect.sync(() => {
                compensations += 1;
              }),
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toBeInstanceOf(SessionIssuanceStateError);
      expect(deliveries).toBe(0);
      expect(compensations).toBe(1);
      expect(redis.activeLeaseCount()).toBe(0);
    }
  });

  test('refuses cached responses outside the durable daemon and account identity', async () => {
    for (const mismatch of ['daemon', 'account', 'binding'] as const) {
      const redis = new FakeRedis();
      const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
      const prepared = await Effect.runPromise(service.issue(input, immediateCallbacks()));
      redis.addIssuanceRecordField('response', {
        ...prepared,
        ...(mismatch === 'daemon'
          ? {
              daemonId: 'other-daemon',
              controlPresence: { ...prepared.controlPresence, daemonId: 'other-daemon' },
              daemonBinding: { ...prepared.daemonBinding, daemonId: 'other-daemon' },
            }
          : mismatch === 'account'
            ? {
                controlPresence: { ...prepared.controlPresence, userId: 'other-user' },
                daemonBinding: { ...prepared.daemonBinding, userId: 'other-user' },
              }
            : {
                daemonBinding: {
                  ...prepared.daemonBinding,
                  daemonIdentityKeyCommitment: Buffer.alloc(64, 99).toString('base64url'),
                },
              }),
      });
      const result = await Effect.runPromise(
        Effect.result(
          service.issue(input, {
            prepare: () => Effect.die(new Error('corrupt replay must not prepare')),
            deliver: () => Effect.die(new Error('corrupt replay must not deliver')),
            compensate: () => Effect.die(new Error('corrupt replay must not compensate')),
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toBeInstanceOf(SessionIssuanceStateError);
    }
  });

  test('initializes and leases a fresh issuance in one fenced Redis command', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);

    await Effect.runPromise(service.issue(input, immediateCallbacks()));

    expect(redis.commandNames).toEqual(['EVAL', 'EVAL', 'EVAL']);
  });

  test('fails closed on malformed initialization-and-lease replies before preparation', async () => {
    for (const reply of [null, false, [], [1], [1, null], [2, ''], [1, 42], [0, '', 'surplus']]) {
      const redis = new FakeRedis();
      redis.setNextInitializeReply(reply);
      const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
      let prepares = 0;
      const callbacks = immediateCallbacks();
      const result = await Effect.runPromise(
        Effect.result(
          service.issue(input, {
            ...callbacks,
            prepare: (sessionId) => {
              prepares += 1;
              return callbacks.prepare(sessionId);
            },
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(RedisError);
      expect(prepares).toBe(0);
    }
  });

  test('releases the initial lease when the allocated identity fails validation', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    const result = await Effect.runPromise(
      Effect.result(
        service.issue(
          { ...input, sessionRequestCommitment: 'malformed' },
          {
            ...immediateCallbacks(),
            prepare: () => Effect.die(new Error('Invalid identity cannot prepare')),
          },
        ),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(SessionIssuanceStateError);
    expect(redis.activeLeaseCount()).toBe(0);
    expect(redis.commandNames).toEqual(['EVAL', 'EVAL', 'EVAL']);
  });

  test('concurrent duplicates share one prepared response and one daemon delivery', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    const deliveryStarted = promiseLatch<void>();
    const releaseDelivery = promiseLatch<void>();
    let prepares = 0;
    let deliveries = 0;
    const callbacks: SessionIssuanceCallbacks = {
      prepare: (sessionId) =>
        Effect.sync(() => {
          prepares += 1;
          return { response: response(sessionId), expiresAtMs: 100_000 };
        }),
      deliver: () =>
        Effect.promise(async () => {
          deliveries += 1;
          deliveryStarted.resolve(undefined);
          await releaseDelivery.promise;
        }),
      compensate: () => Effect.void,
    };

    const first = Effect.runPromise(service.issue(input, callbacks));
    await deliveryStarted.promise;
    const duplicate = Effect.runPromise(service.issue(input, callbacks));
    await waitUntil(() => redis.subscribeCalls === 1);
    releaseDelivery.resolve(undefined);

    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(duplicateResult).toEqual(firstResult);
    expect(prepares).toBe(1);
    expect(deliveries).toBe(1);
    expect(redis.subscribeCalls).toBe(1);
  });

  test('takeover waits only for the current lease remainder plus grace', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    const firstDeliveryStarted = promiseLatch<void>();
    const releaseFirstDelivery = promiseLatch<void>();
    let deliveries = 0;
    const callbacks: SessionIssuanceCallbacks = {
      prepare: (sessionId) =>
        Effect.succeed({
          response: response(sessionId),
          expiresAtMs: 100_000,
        }),
      deliver: () =>
        Effect.promise(async () => {
          deliveries += 1;
          if (deliveries === 1) {
            firstDeliveryStarted.resolve(undefined);
            await releaseFirstDelivery.promise;
          }
        }),
      compensate: () => Effect.void,
    };

    const staleOwner = Effect.runPromise(service.issue(input, callbacks));
    await firstDeliveryStarted.promise;
    redis.nowMs = 9_999;
    setTimeout(() => {
      redis.nowMs = 10_001;
    }, 5);
    const startedAt = performance.now();
    const takeover = await Effect.runPromise(service.issue(input, callbacks));
    const takeoverMs = performance.now() - startedAt;
    releaseFirstDelivery.resolve(undefined);
    expect(await staleOwner).toEqual(takeover);

    expect(takeoverMs).toBeLessThan(1_000);
    expect(deliveries).toBe(2);
  });

  test('fails closed on malformed Redis lease TTL replies', async () => {
    for (const reply of [null, false, '', [], [1], ' 1', '01', -2]) {
      const redis = new FakeRedis();
      const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
      const deliveryStarted = promiseLatch<void>();
      const releaseDelivery = promiseLatch<void>();
      const callbacks: SessionIssuanceCallbacks = {
        prepare: (sessionId) =>
          Effect.succeed({
            response: response(sessionId),
            expiresAtMs: 100_000,
          }),
        deliver: () =>
          Effect.promise(async () => {
            deliveryStarted.resolve(undefined);
            await releaseDelivery.promise;
          }),
        compensate: () => Effect.void,
      };

      const owner = Effect.runPromise(service.issue(input, callbacks));
      await deliveryStarted.promise;
      redis.setNextLeaseTtlReply(reply);
      const duplicate = await Effect.runPromise(Effect.result(service.issue(input, callbacks)));
      releaseDelivery.resolve(undefined);
      await owner;

      expect(Result.isFailure(duplicate)).toBe(true);
      if (Result.isFailure(duplicate)) {
        expect(duplicate.failure).toBeInstanceOf(SessionIssuanceStateError);
      }
    }
  });

  test('fails closed on malformed atomic lease-and-snapshot replies', async () => {
    for (const reply of [
      null,
      false,
      [],
      [1],
      [1, null],
      [2, ''],
      [0, 'unexpected'],
      [1, 42],
      [0, '', 'surplus'],
    ]) {
      const redis = new FakeRedis();
      redis.seedAllocatingIssuance(input, 'seeded-session');
      redis.setNextAcquireLeaseReply(reply);
      const service = createSessionIssuanceService(redis.service, () => redis.nowMs);

      const result = await Effect.runPromise(
        Effect.result(service.issue(input, immediateCallbacks())),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(RedisError);
    }
  });

  test('a duplicate after a lost HTTP response returns the exact commit without signalling again', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    let prepares = 0;
    let deliveries = 0;
    const callbacks: SessionIssuanceCallbacks = {
      prepare: (sessionId) =>
        Effect.sync(() => {
          prepares += 1;
          return { response: response(sessionId), expiresAtMs: 100_000 };
        }),
      deliver: () =>
        Effect.sync(() => {
          deliveries += 1;
        }),
      compensate: () => Effect.void,
    };

    const committed = await Effect.runPromise(service.issue(input, callbacks));
    const recovered = await Effect.runPromise(service.issue(input, callbacks));

    expect(recovered).toEqual(committed);
    expect(prepares).toBe(1);
    expect(deliveries).toBe(1);
  });

  test('issue preserves callback failure types and excludes compensated failures', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    const issuance: Effect.Effect<
      SessionIssuanceResponse,
      SessionIssuanceError | 'preparation_failure' | 'delivery_failure'
    > = service.issue(input, {
      prepare: () => Effect.fail('preparation_failure' as const),
      deliver: () => Effect.fail('delivery_failure' as const),
      compensate: () => Effect.fail('compensation_failure' as const),
    });
    const result = await Effect.runPromise(Effect.result(issuance));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toBe('preparation_failure');
    expect(redis.activeLeaseCount()).toBe(0);
  });

  test('interruption during preparation releases the lease and retries the same durable session', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    const started = Deferred.makeUnsafe<void>();
    let allocatedSessionId = '';
    const owner = Effect.runFork(
      service.issue(input, {
        prepare: (sessionId) =>
          Effect.gen(function* () {
            allocatedSessionId = sessionId;
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
        deliver: () => Effect.die('Preparation must not deliver'),
        compensate: () => Effect.die('Interruption must preserve the durable session identity'),
      }),
    );
    await Effect.runPromise(Deferred.await(started));
    expect(redis.activeLeaseCount()).toBe(1);
    await Effect.runPromise(Fiber.interrupt(owner));
    expect(redis.activeLeaseCount()).toBe(0);
    const recovered = await Effect.runPromise(service.issue(input, immediateCallbacks()));
    expect(recovered.sessionId).toBe(allocatedSessionId);
    expect(redis.subscribeCalls).toBe(0);
  });

  test('interruption during delivery retains the exact prepared response for immediate replay', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    const started = Deferred.makeUnsafe<void>();
    let delivered: SessionIssuanceResponse | undefined;
    const owner = Effect.runFork(
      service.issue(input, {
        ...immediateCallbacks(),
        deliver: (prepared) =>
          Effect.gen(function* () {
            delivered = prepared;
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
        compensate: () => Effect.die('Ambiguous delivery must retain its claim'),
      }),
    );
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(owner));
    expect(redis.activeLeaseCount()).toBe(0);
    const expected = required(delivered, 'The first delivery must have started');
    const recovered = await Effect.runPromise(
      service.issue(input, {
        prepare: () => Effect.die('Replay must use the durable prepared response'),
        deliver: (prepared) => Effect.sync(() => expect(prepared).toEqual(expected)),
        compensate: () => Effect.die('Replay must not compensate'),
      }),
    );
    expect(recovered).toEqual(expected);
    expect(redis.subscribeCalls).toBe(0);
  });

  test('an ambiguous delivery failure retains the prepared identity for request-driven redelivery', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    let prepares = 0;
    let deliveries = 0;
    const deliveredSessionIds: string[] = [];
    const callbacks: SessionIssuanceCallbacks<never, Error> = {
      prepare: (sessionId) =>
        Effect.sync(() => {
          prepares += 1;
          return { response: response(sessionId), expiresAtMs: 100_000 };
        }),
      deliver: (prepared) =>
        Effect.suspend(() => {
          deliveries += 1;
          deliveredSessionIds.push(prepared.sessionId);
          return deliveries === 1
            ? Effect.fail(new Error('receipt lost after enqueue'))
            : Effect.void;
        }),
      compensate: () => Effect.die(new Error('ambiguous delivery must not compensate')),
    };

    const first = await Effect.runPromise(Effect.result(service.issue(input, callbacks)));
    const recovered = await Effect.runPromise(service.issue(input, callbacks));

    expect(Result.isFailure(first)).toBe(true);
    expect(recovered.sessionId).toBe(required(deliveredSessionIds[0], 'first delivery missing'));
    expect(deliveredSessionIds).toEqual([recovered.sessionId, recovered.sessionId]);
    expect(prepares).toBe(1);
    expect(deliveries).toBe(2);
  });

  test('lease expiry during a successful delivery commits without redelivering', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    let deliveries = 0;
    const callbacks: SessionIssuanceCallbacks = {
      prepare: (sessionId) =>
        Effect.succeed({
          response: response(sessionId),
          expiresAtMs: 100_000,
        }),
      deliver: () =>
        Effect.sync(() => {
          deliveries += 1;
          redis.nowMs = 11_000;
        }),
      compensate: () => Effect.void,
    };

    const committed = await Effect.runPromise(service.issue(input, callbacks));
    const duplicate = await Effect.runPromise(service.issue(input, callbacks));

    expect(duplicate).toEqual(committed);
    expect(deliveries).toBe(1);
  });

  test('lease expiry during a failed delivery remains request-driven', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    let deliveries = 0;
    const callbacks: SessionIssuanceCallbacks<never, Error> = {
      prepare: (sessionId) =>
        Effect.succeed({
          response: response(sessionId),
          expiresAtMs: 100_000,
        }),
      deliver: () =>
        Effect.suspend(() => {
          deliveries += 1;
          if (deliveries === 1) {
            redis.nowMs = 11_000;
            return Effect.fail(new Error('receipt lost after lease expiry'));
          }
          return Effect.void;
        }),
      compensate: () => Effect.die(new Error('ambiguous delivery must not compensate')),
    };

    const first = await Effect.runPromise(Effect.result(service.issue(input, callbacks)));
    expect(Result.isFailure(first)).toBe(true);
    expect(deliveries).toBe(1);

    await Effect.runPromise(service.issue(input, callbacks));
    expect(deliveries).toBe(2);
  });

  test('the same issuance id cannot be rebound to another daemon or browser', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    const callbacks = immediateCallbacks();
    await Effect.runPromise(service.issue(input, callbacks));

    const result = await Effect.runPromise(
      Effect.result(
        service.issue({ ...input, daemonId: 'daemon-2', browserNodeId: 'browser-2' }, callbacks),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(SessionIssuanceConflictError);
    }
  });

  test('rejects and compensates preparation that violates the durable identity', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    let deliveries = 0;
    const compensated: string[] = [];
    const result = await Effect.runPromise(
      Effect.result(
        service.issue(input, {
          prepare: () =>
            Effect.succeed({
              response: response('different-session'),
              expiresAtMs: 99_999,
            }),
          deliver: () =>
            Effect.sync(() => {
              deliveries += 1;
            }),
          compensate: (sessionId) =>
            Effect.sync(() => {
              compensated.push(sessionId);
            }),
        }),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(deliveries).toBe(0);
    expect(compensated).toHaveLength(1);
    expect(compensated[0]).not.toBe('different-session');
  });

  test('rejects and compensates a preparation response with surplus fields', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    let deliveries = 0;
    let compensations = 0;
    const result = await Effect.runPromise(
      Effect.result(
        service.issue(input, {
          prepare: (sessionId) => {
            const responseWithSurplusField = {
              ...response(sessionId),
              edgeCertHash: VALID_CERT_HASH,
            };
            return Effect.succeed({
              response: responseWithSurplusField,
              expiresAtMs: 100_000,
            });
          },
          deliver: () =>
            Effect.sync(() => {
              deliveries += 1;
            }),
          compensate: () =>
            Effect.sync(() => {
              compensations += 1;
            }),
        }),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(SessionIssuanceStateError);
    }
    expect(deliveries).toBe(0);
    expect(compensations).toBe(1);
  });

  test('rejects and compensates a preparation with a malformed certificate pin', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    let compensations = 0;
    const result = await Effect.runPromise(
      Effect.result(
        service.issue(input, {
          prepare: (sessionId) =>
            Effect.succeed({
              response: {
                ...response(sessionId),
                edgeCertHashes: ['not-a-certificate-pin'],
              },
              expiresAtMs: 100_000,
            }),
          deliver: () => Effect.die(new Error('malformed preparation cannot deliver')),
          compensate: () =>
            Effect.sync(() => {
              compensations += 1;
            }),
        }),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(SessionIssuanceStateError);
    }
    expect(compensations).toBe(1);
  });

  test('rejects a stored issuance record with surplus fields', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    await Effect.runPromise(service.issue(input, immediateCallbacks()));
    redis.addIssuanceRecordField('edgeCertHash', VALID_CERT_HASH);

    const result = await Effect.runPromise(
      Effect.result(service.issue(input, immediateCallbacks())),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(SessionIssuanceStateError);
    }
  });

  test('an expired committed token is never replayed', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    let compensations = 0;
    const callbacks: SessionIssuanceCallbacks = {
      prepare: (sessionId) =>
        Effect.succeed({
          response: response(sessionId, 5_000),
          expiresAtMs: 5_000,
        }),
      deliver: () => Effect.void,
      compensate: () =>
        Effect.sync(() => {
          compensations += 1;
        }),
    };
    await Effect.runPromise(service.issue(input, callbacks));
    redis.nowMs = 4_000;

    const result = await Effect.runPromise(Effect.result(service.issue(input, callbacks)));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(SessionIssuanceExpiredError);
    }
    expect(compensations).toBe(0);
  });

  test('committed cancellation identity outlives the short preparation TTL', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    const committed = await Effect.runPromise(service.issue(input, immediateCallbacks()));
    redis.nowMs = 301_000;

    const cancellation = await Effect.runPromise(service.cancel(input.userId, input.issuanceId));

    expect(cancellation).toMatchObject({
      _tag: 'Cancelled',
      sessionId: committed.sessionId,
      daemonId: input.daemonId,
      browserNodeId: input.browserNodeId,
    });
  });

  test('atomically retires a predecessor only for a fresh bootstrap in the same lineage', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    const committed = await Effect.runPromise(service.issue(input, immediateCallbacks()));

    const cancellation = await Effect.runPromise(service.supersede(supersession));

    expect(cancellation).toEqual({
      _tag: 'Cancelled',
      sessionId: committed.sessionId,
      daemonId: input.daemonId,
      browserNodeId: input.browserNodeId,
      sessionRequestCommitment: input.sessionRequestCommitment,
    });
    expect(await Effect.runPromise(service.supersede(supersession))).toEqual(cancellation);
    const successor = await Effect.runPromise(
      service.issue(
        {
          ...input,
          issuanceId: supersession.successorIssuanceId,
          sessionRequestCommitment: supersession.sessionRequestCommitment,
        },
        immediateCallbacks(),
      ),
    );
    expect(successor.sessionId).not.toBe(committed.sessionId);
    const competing = await Effect.runPromise(
      Effect.result(
        service.supersede({
          ...supersession,
          successorIssuanceId: 'issuance-3',
          sessionRequestCommitment: Buffer.alloc(64, 13).toString('base64url'),
        }),
      ),
    );
    expect(Result.isFailure(competing)).toBe(true);
    if (Result.isFailure(competing)) {
      expect(competing.failure).toBeInstanceOf(SessionIssuanceConflictError);
    }
    const replay = await Effect.runPromise(
      Effect.result(service.issue(input, immediateCallbacks())),
    );
    expect(Result.isFailure(replay)).toBe(true);
    if (Result.isFailure(replay)) {
      expect(replay.failure).toBeInstanceOf(SessionIssuanceCancelledError);
    }
  });

  test('atomically tombstones a missing predecessor while reserving its successor', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);

    expect(await Effect.runPromise(service.supersede(supersession))).toEqual({ _tag: 'Missing' });
    expect(await Effect.runPromise(service.supersede(supersession))).toEqual({ _tag: 'Missing' });
    expect(await Effect.runPromise(service.cancel(input.userId, input.issuanceId))).toEqual({
      _tag: 'Missing',
    });

    let prepares = 0;
    let deliveries = 0;
    let compensations = 0;
    const latePredecessor = await Effect.runPromise(
      Effect.result(
        service.issue(input, {
          prepare: () =>
            Effect.sync(() => {
              prepares += 1;
              throw new Error('tombstoned predecessor must not prepare');
            }),
          deliver: () =>
            Effect.sync(() => {
              deliveries += 1;
            }),
          compensate: () =>
            Effect.sync(() => {
              compensations += 1;
            }),
        }),
      ),
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

    const successor = await Effect.runPromise(
      service.issue(
        {
          ...input,
          issuanceId: supersession.successorIssuanceId,
          sessionRequestCommitment: supersession.sessionRequestCommitment,
        },
        immediateCallbacks(),
      ),
    );
    expect(successor.sessionId).toBeTruthy();

    const competing = await Effect.runPromise(
      Effect.result(
        service.supersede({
          ...supersession,
          successorIssuanceId: 'issuance-3',
          sessionRequestCommitment: Buffer.alloc(64, 13).toString('base64url'),
        }),
      ),
    );
    expect(Result.isFailure(competing)).toBe(true);
    if (Result.isFailure(competing)) {
      expect(competing.failure).toBeInstanceOf(SessionIssuanceConflictError);
    }
  });

  test('retries normal supersession when predecessor initialization wins the missing-record CAS', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    const racedSessionId = 'raced-predecessor-session';
    redis.beforeNextSupersedeEval(() => {
      redis.seedAllocatingIssuance(input, racedSessionId);
    });

    const cancellation = await Effect.runPromise(service.supersede(supersession));

    expect(cancellation).toEqual({
      _tag: 'Cancelled',
      sessionId: racedSessionId,
      daemonId: input.daemonId,
      browserNodeId: input.browserNodeId,
      sessionRequestCommitment: input.sessionRequestCommitment,
    });
    const latePredecessor = await Effect.runPromise(
      Effect.result(service.issue(input, immediateCallbacks())),
    );
    expect(Result.isFailure(latePredecessor)).toBe(true);
    if (Result.isFailure(latePredecessor)) {
      expect(latePredecessor.failure).toBeInstanceOf(SessionIssuanceCancelledError);
    }
    const successor = await Effect.runPromise(
      service.issue(
        {
          ...input,
          issuanceId: supersession.successorIssuanceId,
          sessionRequestCommitment: supersession.sessionRequestCommitment,
        },
        immediateCallbacks(),
      ),
    );
    expect(successor.sessionId).not.toBe(racedSessionId);
  });

  test('invalid supersession leaves the committed predecessor usable', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    const committed = await Effect.runPromise(service.issue(input, immediateCallbacks()));
    const invalidSuccessors = [
      { ...supersession, successorIssuanceId: supersession.predecessorIssuanceId },
      { ...supersession, sessionRequestCommitment: input.sessionRequestCommitment },
      { ...supersession, daemonId: 'daemon-other' },
      { ...supersession, browserNodeId: 'browser-other' },
      {
        ...supersession,
        daemonIdentityKeyCommitment: Buffer.alloc(64, 8).toString('base64url'),
      },
    ];

    for (const invalid of invalidSuccessors) {
      const result = await Effect.runPromise(Effect.result(service.supersede(invalid)));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(SessionIssuanceConflictError);
      }
      expect(await Effect.runPromise(service.issue(input, immediateCallbacks()))).toEqual(
        committed,
      );
    }
  });

  test('a pre-existing successor cannot retire a predecessor even when its binding matches', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    const committed = await Effect.runPromise(service.issue(input, immediateCallbacks()));
    const successorInput = {
      ...input,
      issuanceId: supersession.successorIssuanceId,
      sessionRequestCommitment: supersession.sessionRequestCommitment,
    };
    await Effect.runPromise(service.issue(successorInput, immediateCallbacks()));

    const result = await Effect.runPromise(Effect.result(service.supersede(supersession)));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(SessionIssuanceConflictError);
    }
    expect(await Effect.runPromise(service.issue(input, immediateCallbacks()))).toEqual(committed);
  });

  test('lease expiry during preparation reuses the prepared result without retrying', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    let prepares = 0;
    let deliveries = 0;
    const callbacks: SessionIssuanceCallbacks = {
      prepare: (sessionId) =>
        Effect.sync(() => {
          prepares += 1;
          redis.nowMs = 11_000;
          return { response: response(sessionId), expiresAtMs: 100_000 };
        }),
      deliver: () =>
        Effect.sync(() => {
          deliveries += 1;
        }),
      compensate: () => Effect.void,
    };

    await Effect.runPromise(service.issue(input, callbacks));

    expect(prepares).toBe(1);
    expect(deliveries).toBe(1);
  });

  test('lease expiry during failed preparation returns without retrying the callback', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    let prepares = 0;
    let compensations = 0;
    const preparationError = new Error('edge lookup failed after lease expiry');
    const result = await Effect.runPromise(
      Effect.result(
        service.issue(input, {
          prepare: () =>
            Effect.suspend(() => {
              prepares += 1;
              redis.nowMs = 11_000;
              return Effect.fail(preparationError);
            }),
          deliver: () => Effect.die(new Error('failed preparation cannot deliver')),
          compensate: () =>
            Effect.sync(() => {
              compensations += 1;
            }),
        }),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toBe(preparationError);
    expect(prepares).toBe(1);
    expect(compensations).toBe(1);
  });

  test('lease expiry during a slow prepare lets one takeover commit without deleting its claim', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    const firstPrepareStarted = promiseLatch<void>();
    const releaseFirstPrepare = promiseLatch<void>();
    let prepares = 0;
    let deliveries = 0;
    let compensations = 0;
    const callbacks: SessionIssuanceCallbacks = {
      prepare: (sessionId) =>
        Effect.promise(async () => {
          prepares += 1;
          if (prepares === 1) {
            firstPrepareStarted.resolve(undefined);
            await releaseFirstPrepare.promise;
          }
          return { response: response(sessionId), expiresAtMs: 100_000 };
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

    const slowOwner = Effect.runPromise(service.issue(input, callbacks));
    await firstPrepareStarted.promise;
    redis.nowMs = 11_000;
    const takeover = await Effect.runPromise(service.issue(input, callbacks));
    releaseFirstPrepare.resolve(undefined);
    const staleOwner = await slowOwner;

    expect(staleOwner).toEqual(takeover);
    expect(prepares).toBe(2);
    expect(deliveries).toBe(1);
    expect(compensations).toBe(0);
  });

  test('cancellation wins durable ownership even when an old delivery completes late', async () => {
    const redis = new FakeRedis();
    const service = createSessionIssuanceService(redis.service, () => redis.nowMs);
    const deliveryStarted = promiseLatch<void>();
    const releaseDelivery = promiseLatch<void>();
    let deliveredSessionId = '';
    const callbacks: SessionIssuanceCallbacks = {
      prepare: (sessionId) =>
        Effect.succeed({
          response: response(sessionId),
          expiresAtMs: 100_000,
        }),
      deliver: (prepared) =>
        Effect.promise(async () => {
          deliveredSessionId = prepared.sessionId;
          deliveryStarted.resolve(undefined);
          await releaseDelivery.promise;
        }),
      compensate: () => Effect.void,
    };

    const oldIssue = Effect.runPromise(Effect.result(service.issue(input, callbacks)));
    await deliveryStarted.promise;
    const cancellation = await Effect.runPromise(service.cancel(input.userId, input.issuanceId));
    releaseDelivery.resolve(undefined);
    const oldResult = await oldIssue;

    expect(cancellation).toMatchObject({
      _tag: 'Cancelled',
      sessionId: deliveredSessionId,
    });
    expect(Result.isFailure(oldResult)).toBe(true);
    if (Result.isFailure(oldResult)) {
      expect(oldResult.failure).toBeInstanceOf(SessionIssuanceCancelledError);
    }
  });
});

function immediateCallbacks(): SessionIssuanceCallbacks {
  return {
    prepare: (sessionId) =>
      Effect.succeed({
        response: response(sessionId),
        expiresAtMs: 100_000,
      }),
    deliver: () => Effect.void,
    compensate: () => Effect.void,
  };
}

interface StoredValue {
  readonly value: string;
  expiresAtMs: number | null;
}

class FakeRedis {
  nowMs = 0;
  subscribeCalls = 0;
  readonly commandNames: string[] = [];
  private readonly strings = new Map<string, StoredValue>();
  private readonly listeners = new Map<string, Set<(message: string) => void>>();
  private nextLeaseTtlReply: { readonly value: unknown } | null = null;
  private nextInitializeReply: { readonly value: unknown } | null = null;
  private nextAcquireLeaseReply: { readonly value: unknown } | null = null;
  private beforeSupersedeEval: (() => void) | null = null;

  activeLeaseCount(): number {
    let count = 0;
    for (const key of this.strings.keys()) {
      if (key.startsWith('merkur:sessions:issuance-lock:') && this.get(key) !== null) count += 1;
    }
    return count;
  }

  setNextInitializeReply(value: unknown): void {
    this.nextInitializeReply = { value };
  }

  setNextLeaseTtlReply(value: unknown): void {
    this.nextLeaseTtlReply = { value };
  }

  setNextAcquireLeaseReply(value: unknown): void {
    this.nextAcquireLeaseReply = { value };
  }

  beforeNextSupersedeEval(callback: () => void): void {
    this.beforeSupersedeEval = callback;
  }

  seedAllocatingIssuance(issuance: SessionIssuanceInput, sessionId: string): void {
    const digest = createHash('sha256')
      .update(issuance.userId)
      .update('\0')
      .update(issuance.issuanceId)
      .digest('base64url');
    this.strings.set(`merkur:sessions:issuance:${digest}`, {
      value: JSON.stringify({
        state: 'allocating',
        ...issuance,
        sessionId,
      }),
      expiresAtMs: this.nowMs + 300_000,
    });
  }

  addIssuanceRecordField(name: string, value: unknown): void {
    for (const [key, stored] of this.strings) {
      if (!key.startsWith('merkur:sessions:issuance:')) continue;
      const parsed: unknown = JSON.parse(stored.value);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('stored issuance record is not an object');
      }
      Object.defineProperty(parsed, name, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
      this.strings.set(key, {
        value: JSON.stringify(parsed),
        expiresAtMs: stored.expiresAtMs,
      });
      return;
    }
    throw new Error('stored issuance record is missing');
  }

  readonly service: RedisService = {
    useCommands: <T>(use: (client: RedisCommandClient) => T | PromiseLike<T>) =>
      Effect.tryPromise({
        try: async () => await use({ sendCommand: (args) => this.sendCommand(args) }),
        catch: (cause) =>
          new RedisError({
            cause,
            message: 'Fake Redis command failed',
          }),
      }),
    publish: (channel, message) =>
      Effect.sync(() => {
        this.publish(channel, message);
      }),
    subscribe: (channel, handler) =>
      Effect.sync(() => {
        this.subscribeCalls += 1;
        this.getListeners(channel).add(handler);
      }),
    unsubscribe: (channel, handler) =>
      Effect.sync(() => {
        if (handler === undefined) {
          this.listeners.delete(channel);
          return;
        }
        const listeners = this.listeners.get(channel);
        listeners?.delete(handler);
        if (listeners?.size === 0) this.listeners.delete(channel);
      }),
    healthSnapshot: () =>
      Effect.succeed({
        commandsReady: true,
        publisherReady: true,
        subscriberReady: true,
      }),
  };

  private async sendCommand<T = unknown>(args: string[]): Promise<T> {
    const command = required(args[0], 'command').toUpperCase();
    this.commandNames.push(command);
    if (command === 'GET') {
      return (this.get(required(args[1], 'GET key')) ?? null) as T;
    }
    if (command === 'DEL') {
      let removed = 0;
      for (const key of args.slice(1)) {
        if (this.strings.delete(key)) removed += 1;
      }
      return removed as T;
    }
    if (command === 'SET') {
      return this.set(args) as T;
    }
    if (command === 'EVAL') {
      return this.eval(args) as T;
    }
    throw new Error(`unsupported fake Redis command: ${command}`);
  }

  private set(args: string[]): string | null {
    const key = required(args[1], 'SET key');
    const value = required(args[2], 'SET value');
    const nx = args.includes('NX');
    if (nx && this.get(key) !== null) return null;
    const pxIndex = args.indexOf('PX');
    const ttl = pxIndex < 0 ? null : Number(required(args[pxIndex + 1], 'SET PX milliseconds'));
    this.strings.set(key, {
      value,
      expiresAtMs: ttl === null ? null : this.nowMs + ttl,
    });
    return 'OK';
  }

  private initializeLeaseAndRead(keys: string[], argv: string[]): unknown {
    if (this.nextInitializeReply !== null) {
      const reply = this.nextInitializeReply.value;
      this.nextInitializeReply = null;
      return reply;
    }
    const recordKey = required(keys[0], 'initialize record key');
    const created = this.set([
      'SET',
      recordKey,
      required(argv[0], 'initialize record'),
      'NX',
      'PX',
      required(argv[1], 'initialize TTL'),
    ]);
    const acquired =
      created === null
        ? null
        : this.set([
            'SET',
            required(keys[1], 'initialize lock key'),
            required(argv[2], 'initialize owner'),
            'NX',
            'PX',
            required(argv[3], 'initialize lease TTL'),
          ]);
    return [acquired === null ? 0 : 1, this.get(recordKey)];
  }

  private eval(args: string[]): unknown {
    const script = required(args[1], 'EVAL script');
    const keyCount = Number(required(args[2], 'EVAL key count'));
    const keys = args.slice(3, 3 + keyCount);
    const argv = args.slice(3 + keyCount);
    if (keyCount === 2 && script.includes('local created =')) {
      return this.initializeLeaseAndRead(keys, argv);
    }
    if (keyCount === 2) {
      if (script.includes('return { 1, snapshot }')) {
        if (this.nextAcquireLeaseReply !== null) {
          const reply = this.nextAcquireLeaseReply.value;
          this.nextAcquireLeaseReply = null;
          return reply;
        }
        const lockKey = required(keys[0], 'acquire lock key');
        const recordKey = required(keys[1], 'acquire snapshot key');
        const acquired = this.set([
          'SET',
          lockKey,
          required(argv[0], 'acquire owner'),
          'NX',
          'PX',
          required(argv[1], 'acquire lease TTL'),
        ]);
        return acquired === null ? [0, ''] : [1, this.get(recordKey) ?? ''];
      }
      if (script.includes("redis.call('PTTL'")) {
        if (this.nextLeaseTtlReply !== null) {
          const reply = this.nextLeaseTtlReply.value;
          this.nextLeaseTtlReply = null;
          return reply;
        }
        const recordKey = required(keys[0], 'lease snapshot key');
        const lockKey = required(keys[1], 'lease lock key');
        if (this.get(recordKey) !== required(argv[0], 'lease expected snapshot')) return -3;
        const lock = this.strings.get(lockKey);
        if (lock === undefined || this.get(lockKey) === null) return 0;
        if (lock.expiresAtMs === null) {
          const fallbackTtl = Number(required(argv[1], 'lease fallback TTL'));
          lock.expiresAtMs = this.nowMs + fallbackTtl;
          return fallbackTtl;
        }
        return Math.max(0, lock.expiresAtMs - this.nowMs);
      }
      const lockKey = required(keys[0], 'release lock key');
      const channel = required(keys[1], 'release channel');
      if (this.get(lockKey) !== required(argv[0], 'release owner')) return 0;
      this.strings.delete(lockKey);
      this.publish(channel, 'changed');
      return 1;
    }
    if (keyCount === 4 && script.includes('local successor =')) {
      const predecessorKey = required(keys[0], 'supersede predecessor key');
      const predecessorLockKey = required(keys[1], 'supersede predecessor lock key');
      const predecessorChannel = required(keys[2], 'supersede predecessor channel');
      const successorKey = required(keys[3], 'supersede successor key');
      const beforeSupersedeEval = this.beforeSupersedeEval;
      this.beforeSupersedeEval = null;
      beforeSupersedeEval?.();
      const predecessor = this.get(predecessorKey);
      const expectsMissing = required(argv[5], 'supersede missing-mode flag') === '1';
      if (
        (expectsMissing && predecessor !== null) ||
        (!expectsMissing && predecessor !== required(argv[0], 'supersede expected predecessor'))
      ) {
        return 0;
      }
      if (this.get(successorKey) !== null) return 0;
      const successor = required(argv[1], 'supersede successor snapshot');
      const ttl = Number(required(argv[2], 'supersede TTL'));
      this.strings.set(successorKey, {
        value: successor,
        expiresAtMs: this.nowMs + ttl,
      });
      if (argv[3] === '1') {
        this.strings.set(predecessorKey, {
          value: required(argv[4], 'superseded predecessor'),
          expiresAtMs: this.nowMs + ttl,
        });
        this.strings.delete(predecessorLockKey);
        this.publish(predecessorChannel, 'changed');
      }
      return 1;
    }
    const recordKey = required(keys[0], 'record key');
    const lockKey = required(keys[1], 'lock key');
    const channel = required(keys[2], 'channel');

    if (script.includes("ARGV[3], 'PX', ARGV[4]")) {
      const expected = required(argv[0], 'store expected');
      const owner = required(argv[1], 'store owner');
      if (this.get(lockKey) !== owner || this.get(recordKey) !== expected) return 0;
      const replacement = required(argv[2], 'store replacement');
      const ttl = Number(required(argv[3], 'store TTL'));
      this.strings.set(recordKey, {
        value: replacement,
        expiresAtMs: this.nowMs + ttl,
      });
      if (argv[4] === '1') {
        this.strings.delete(lockKey);
      } else {
        const lock = this.strings.get(lockKey);
        if (lock !== undefined) {
          lock.expiresAtMs = this.nowMs + Number(required(argv[6], 'lease TTL'));
        }
      }
      if (argv[5] === '1') this.publish(channel, 'changed');
      return 1;
    }

    if (script.includes('== ARGV[4]')) {
      const expected = required(argv[0], 'store-current expected');
      if (this.get(recordKey) !== expected) return 0;
      this.strings.set(recordKey, {
        value: required(argv[1], 'store-current value'),
        expiresAtMs: this.nowMs + Number(required(argv[2], 'store-current TTL')),
      });
      if (this.get(lockKey) === required(argv[3], 'store-current owner')) {
        this.strings.delete(lockKey);
      }
      this.publish(channel, 'changed');
      return 1;
    }

    if (script.includes("ARGV[2], 'PX', ARGV[3]")) {
      const expected = required(argv[0], 'replace expected');
      if (this.get(recordKey) !== expected) return 0;
      this.strings.set(recordKey, {
        value: required(argv[1], 'replace value'),
        expiresAtMs: this.nowMs + Number(required(argv[2], 'replace TTL')),
      });
      this.strings.delete(lockKey);
      this.publish(channel, 'changed');
      return 1;
    }

    const expected = required(argv[0], 'delete expected');
    const owner = required(argv[1], 'delete owner');
    if (this.get(lockKey) !== owner || this.get(recordKey) !== expected) return 0;
    this.strings.delete(recordKey);
    this.strings.delete(lockKey);
    this.publish(channel, 'changed');
    return 1;
  }

  private get(key: string): string | null {
    const stored = this.strings.get(key);
    if (stored === undefined) return null;
    if (stored.expiresAtMs !== null && stored.expiresAtMs <= this.nowMs) {
      this.strings.delete(key);
      return null;
    }
    return stored.value;
  }

  private getListeners(channel: string): Set<(message: string) => void> {
    const existing = this.listeners.get(channel);
    if (existing !== undefined) return existing;
    const listeners = new Set<(message: string) => void>();
    this.listeners.set(channel, listeners);
    return listeners;
  }

  private publish(channel: string, message: string): void {
    const listeners = this.listeners.get(channel);
    if (listeners === undefined) return;
    for (const listener of listeners) listener(message);
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition did not settle');
}
