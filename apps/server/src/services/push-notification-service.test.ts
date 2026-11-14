import { describe, expect, spyOn, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  createDelegationRevocationStatement,
  encodeUserAuthorizationBytes,
} from '@merkur/shared/user-authorization';
import { Deferred, Effect, Fiber, Layer, Queue, Result } from 'effect';
import { dual } from 'effect/Function';
import { TestClock } from 'effect/testing';
import { DatabaseService } from '../db/client';
import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import { notificationRoutesPlugin } from '../http/routes/notification-routes';
import { createLogger } from '../logger';
import type { runServerProgram } from '../runtime';
import {
  service as auth,
  db as authDb,
  loginWithNewDelegation,
  OLD_PASSWORD,
  ROOT_KEY_COMMITMENT,
  registerAccount,
  useAuthServiceFixture,
} from './auth-service-fixture';
import { InfrastructureError } from './errors';
import type { KeyService } from './key-service';
import { keydCredentials, startTestKeyService } from './keyd-test-support';
import {
  createPushNotificationService,
  createVapidSigner,
  PushDelegationEnded,
  PushNotificationServiceTag,
  readPushErrorStatusCode,
  sendPushNotificationEffect,
  type VapidSigner,
} from './push-notification-service';
import { cleanupExpiredTokensEffect } from './token-cleanup';

describe('VAPID authorization', () => {
  test('keyd signs one JWT per push service and the header reuses it', async () => {
    const credentials = await keydCredentials();
    const keyd = await startTestKeyService(credentials);
    try {
      const requested: string[] = [];
      const counting: KeyService = {
        ...keyd.service,
        vapidJwt: (audience, subject) => {
          requested.push(audience);
          return keyd.service.vapidJwt(audience, subject);
        },
      };
      const publicKey = keyd.service.publicKeys.vapid;
      if (publicKey === null) throw new Error('generated keys hold a VAPID key');
      const signer = createVapidSigner(counting, publicKey, 'mailto:push@merkur.test');
      const first = await Effect.runPromise(signer.authorization('https://push.merkur.test'));
      const again = await Effect.runPromise(signer.authorization('https://push.merkur.test'));
      await Effect.runPromise(signer.authorization('https://other.push.test'));
      expect(again).toBe(first);
      expect(first).toMatch(new RegExp(`^vapid t=[^.]+\\.[^.]+\\.[^.]+, k=${publicKey}$`));
      expect(requested).toEqual(['https://push.merkur.test', 'https://other.push.test']);
    } finally {
      await keyd.stop();
      await rm(path.dirname(credentials), { recursive: true, force: true });
    }
  });
});

describe('push notification error classification', () => {
  test('unwraps an expired-subscription status from InfrastructureError.cause', () => {
    const wrapped = new InfrastructureError({
      service: 'push-notification',
      operation: 'send-terminal-bell-push',
      message: 'Gone',
      cause: { statusCode: 410, body: 'expired' },
    });

    expect(readPushErrorStatusCode(wrapped)).toBe(410);
  });

  test('bounds cyclic cause traversal', () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(readPushErrorStatusCode(cyclic)).toBeNull();
  });
});

describe('push operation ownership', () => {
  test('rejects untrusted push destinations at registration and delivery', async () => {
    const input = await pushMaterial();
    input.subscription.endpoint = 'https://attacker.example/push';
    const db = await pushDatabase(input);
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
      fetchReplacement(async () => new Response('accepted')),
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* createPushNotificationService(
              db,
              input.vapid,
              createLogger('push-test'),
            );
            const registered = yield* Effect.result(
              service.upsertSubscription('push-owner', 'push-delegation', input.subscription),
            );
            expect(registered._tag).toBe('Failure');
            yield* service.notifyTerminalBell({
              userId: 'push-owner',
              daemonId: 'bell-daemon',
              occurredAt: 1,
            });
          }),
        ),
      );
      await expect(
        Effect.runPromise(sendPushNotificationEffect(input.vapid, input.subscription, '{}')),
      ).rejects.toMatchObject({ operation: 'send-terminal-bell-push' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
      await db.destroy();
    }
  });

  test('rejects untrusted push destinations reached through redirects', async () => {
    const input = await pushMaterial();
    input.subscription.endpoint = 'https://fcm.googleapis.com/push';
    let internalRequests = 0;
    const listener = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === '/redirect') {
          return new Response(null, { status: 307, headers: { location: '/internal' } });
        }
        internalRequests += 1;
        return new Response('internal');
      },
    });
    const nativeFetch = globalThis.fetch;
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
      fetchReplacement((_url, init) => nativeFetch(new URL('/redirect', listener.url), init)),
    );
    try {
      const delivered = await Effect.runPromise(
        Effect.result(sendPushNotificationEffect(input.vapid, input.subscription, '{}')),
      );
      expect(internalRequests).toBe(0);
      expect(delivered._tag).toBe('Failure');
      expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('error');
    } finally {
      fetchMock.mockRestore();
      await listener.stop(true);
    }
  });

  test('interruption during queue admission cannot strand account coalescing', async () => {
    const input = await pushMaterial();
    const db = await pushDatabase(input);
    const entered = Promise.withResolvers<void>();
    const release = Deferred.makeUnsafe<void>();
    const originalOffer = Queue.offer;
    let admitted = 0;
    const gatedOffer: typeof Queue.offer = dual(2, <A, E>(queue: Queue.Enqueue<A, E>, message: A) =>
      Effect.gen(function* () {
        entered.resolve();
        yield* Deferred.await(release);
        const accepted = yield* originalOffer(queue, message);
        if (accepted) admitted += 1;
        return accepted;
      }),
    );
    const offerMock = spyOn(Queue, 'offer').mockImplementation(gatedOffer);
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
      fetchReplacement(async () => new Response('accepted')),
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* createPushNotificationService(
              db,
              input.vapid,
              createLogger('push-test'),
            );
            const admission = yield* service
              .notifyFailedSignIn({
                userId: 'push-owner',
                clientIp: '127.0.0.1',
                occurredAt: 1,
              })
              .pipe(Effect.forkChild);
            yield* Effect.promise(() => entered.promise);
            // Request interruption exactly after installing the account in the
            // coalescing set and before its queue offer can complete.
            yield* Effect.sync(() => admission.interruptUnsafe());
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.await(admission);
            expect(admitted).toBe(1);
          }),
        ),
      );
    } finally {
      offerMock.mockRestore();
      fetchMock.mockRestore();
      await db.destroy();
    }
  });

  test('failed sign-in admission completes independently and its worker stops with the service', async () => {
    const input = await pushMaterial();
    const db = await pushDatabase(input);
    const started = Promise.withResolvers<void>();
    let signal: AbortSignal | null | undefined;
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
      fetchReplacement((_url, init) => {
        signal = init?.signal;
        started.resolve();
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('service stopped')), {
            once: true,
          }),
        );
      }),
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* createPushNotificationService(
              db,
              input.vapid,
              createLogger('push-test'),
            );
            yield* service.notifyFailedSignIn({
              userId: 'push-owner',
              clientIp: '127.0.0.1',
              occurredAt: 1,
            });
            // Admission has returned even while delivery is waiting for its fetch.
            yield* Effect.promise(() => started.promise);
          }),
        ),
      );
      expect(signal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      await db.destroy();
    }
  });

  test('404 and 410 delivery rejections remove the expired subscription', async () => {
    const input = await pushMaterial();
    const db = await pushDatabase(input);
    const payloads: unknown[] = [];
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    const encryptMock = spyOn(crypto.subtle, 'encrypt').mockImplementation(
      (algorithm, key, data) => {
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        // RFC 8188's last-record delimiter follows the JSON and precedes padding.
        payloads.push(JSON.parse(new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(2)))));
        return encrypt(algorithm, key, data);
      },
    );
    const fetchMock = spyOn(globalThis, 'fetch');
    try {
      for (const status of [404, 410]) {
        fetchMock.mockImplementation(
          fetchReplacement(async () => new Response('expired', { status })),
        );
        await db
          .insertInto('push_subscriptions')
          .values({
            id: `expired-${status}`,
            user_id: 'push-owner',
            delegation_id: 'push-delegation',
            ...input.subscription,
          })
          .onConflict((conflict) => conflict.column('endpoint').doNothing())
          .execute();
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const service = yield* createPushNotificationService(
                db,
                input.vapid,
                createLogger('push-test'),
              );
              yield* service.notifyTerminalBell({
                userId: 'push-owner',
                daemonId: 'bell-daemon',
                occurredAt: 1,
              });
            }),
          ),
        );
        expect(await db.selectFrom('push_subscriptions').selectAll().execute()).toEqual([]);
        expect(payloads.at(-1)).toMatchObject({
          kind: 'terminal_bell',
          url: '/#machine=bell-daemon',
          daemonId: 'bell-daemon',
        });
      }
    } finally {
      encryptMock.mockRestore();
      fetchMock.mockRestore();
      await db.destroy();
    }
  });

  test('interrupting delivery aborts its native fetch', async () => {
    const input = await pushMaterial();
    const started = Promise.withResolvers<void>();
    let requestSignal: AbortSignal | null | undefined;
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
      fetchReplacement((_url, init) => {
        requestSignal = init?.signal;
        started.resolve();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }),
    );
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* sendPushNotificationEffect(
            input.vapid,
            input.subscription,
            '{}',
          ).pipe(Effect.forkChild);
          yield* Effect.promise(() => started.promise);
          yield* Fiber.interrupt(fiber);
        }),
      );
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('the Effect deadline includes response-body consumption and aborts it', async () => {
    const input = await pushMaterial();
    const started = Promise.withResolvers<void>();
    let requestSignal: AbortSignal | null | undefined;
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
      fetchReplacement(async (_url, init) => {
        requestSignal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new Error('aborted body')),
              { once: true },
            );
          },
        });
        started.resolve();
        return new Response(body);
      }),
    );
    try {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* sendPushNotificationEffect(
            input.vapid,
            input.subscription,
            '{}',
          ).pipe(Effect.flip, Effect.forkChild);
          yield* Effect.promise(() => started.promise);
          yield* TestClock.adjust('5 seconds');
          return yield* Fiber.join(fiber);
        }).pipe(Effect.provide(TestClock.layer())),
      );
      expect(failure).toBeInstanceOf(InfrastructureError);
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('push delegation ownership', () => {
  useAuthServiceFixture();
  test('revoked delegation receives no bell while the live browser still does', async () => {
    const first = await registerAccount(OLD_PASSWORD, 0x41, 'push-first');
    const second = await loginWithNewDelegation(OLD_PASSWORD, 0x42, 'push-second');
    const material = await pushMaterial();
    await authDb
      .insertInto('daemons')
      .values({
        id: 'owned-bell',
        user_id: first.userId,
        name: 'Bell',
        platform: 'test',
        daemon_identity_public_key: 'identity',
        daemon_identity_p256_public_key: 'p256',
        identity_seal_backend: 'software',
        daemon_identity_key_commitment: 'commitment',
        daemon_binding_json: '{}',
        last_seen: null,
        version: null,
      })
      .execute();
    const sent: string[] = [];
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
      fetchReplacement(async (url) => {
        sent.push(String(url));
        return new Response('accepted');
      }),
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* TestClock.setTime(second.certificate.issuedAt);
            const push = yield* createPushNotificationService(
              authDb,
              material.vapid,
              createLogger('push-test'),
            );
            yield* push.upsertSubscription(first.userId, first.certificate.delegationId, {
              ...material.subscription,
              endpoint: 'https://fcm.googleapis.com/first',
            });
            yield* push.upsertSubscription(first.userId, second.certificate.delegationId, {
              ...material.subscription,
              endpoint: 'https://fcm.googleapis.com/second',
            });
            yield* auth.logout({
              actorCertificate: first.certificate,
              revocation: createDelegationRevocationStatement(
                {
                  userId: first.userId,
                  rootKeyCommitment: ROOT_KEY_COMMITMENT,
                  actorDelegationId: first.certificate.delegationId,
                  targets: [
                    {
                      delegationId: first.certificate.delegationId,
                      expiresAt: first.certificate.expiresAt,
                    },
                  ],
                  issuedAt: second.certificate.issuedAt,
                  nonce: encodeUserAuthorizationBytes(new Uint8Array(32).fill(0x43)),
                },
                first.delegate,
              ),
            });
            yield* push.deleteSubscription(
              first.userId,
              first.certificate.delegationId,
              'https://fcm.googleapis.com/second',
            );
            yield* push.notifyTerminalBell({
              userId: first.userId,
              daemonId: 'owned-bell',
              occurredAt: second.certificate.issuedAt,
            });
            expect(sent.sort()).toEqual(['https://fcm.googleapis.com/second']);
            expect(
              yield* Effect.promise(() =>
                authDb.selectFrom('push_subscriptions').select('delegation_id').execute(),
              ),
            ).toEqual([{ delegation_id: second.certificate.delegationId }]);
            const layer = Layer.succeed(PushNotificationServiceTag, push);
            // SAFETY: subscription routes ask only for the push service supplied here.
            const run = ((program) =>
              Effect.runPromise(
                Effect.provide(program as Effect.Effect<unknown, unknown, never>, layer),
              )) as typeof runServerProgram;
            const routes = notificationRoutesPlugin({
              runServerProgram: run,
              authorizeRequest: async () => ({
                userId: first.userId,
                delegationId: first.certificate.delegationId,
                delegationExpiresAt: first.certificate.expiresAt,
              }),
              logger: createLogger('push-route-test'),
            });
            const subscribe = (endpoint: string) =>
              routes.handle(
                new Request('https://merkur.test/api/push/subscriptions', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    endpoint,
                    keys: {
                      p256dh: material.subscription.p256dh,
                      auth: material.subscription.auth,
                    },
                  }),
                }),
              );
            expect(
              (yield* Effect.promise(() => subscribe('https://fcm.googleapis.com/first'))).status,
            ).toBe(401);
            expect(
              (yield* Effect.promise(() => subscribe('https://attacker.example/first'))).status,
            ).toBe(400);
            yield* TestClock.setTime(second.certificate.expiresAt + 1);
            yield* push.notifyTerminalBell({
              userId: first.userId,
              daemonId: 'owned-bell',
              occurredAt: second.certificate.expiresAt + 1,
            });
            expect(sent).toEqual(['https://fcm.googleapis.com/second']);
            const expired = yield* Effect.result(
              push.upsertSubscription(
                first.userId,
                second.certificate.delegationId,
                material.subscription,
              ),
            );
            expect(expired._tag).toBe('Failure');
            if (Result.isFailure(expired))
              expect(expired.failure).toBeInstanceOf(PushDelegationEnded);
            yield* cleanupExpiredTokensEffect(createLogger('push-cleanup-test')).pipe(
              Effect.provideService(DatabaseService, authDb),
            );
            expect(
              yield* Effect.promise(() =>
                authDb.selectFrom('push_subscriptions').selectAll().execute(),
              ),
            ).toEqual([]);
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});

async function pushMaterial() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString(
    'base64url',
  );
  // These tests are about admission, delivery and expiry; keyd's VAPID JWTs are pinned in
  // key-service.keyd.test.ts and the cache in its own test below.
  const vapid: VapidSigner = {
    publicKey,
    authorization: () => Effect.succeed(`vapid t=test, k=${publicKey}`),
  };
  return {
    vapid,
    subscription: {
      endpoint: 'https://fcm.googleapis.com/message',
      p256dh: publicKey,
      auth: Buffer.alloc(16, 1).toString('base64url'),
    },
  };
}

async function pushDatabase(input: Awaited<ReturnType<typeof pushMaterial>>) {
  const db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
  await db
    .insertInto('users')
    .values({
      id: 'push-owner',
      username: 'push-owner',
      opaque_registration_record: 'record',
      root_public_key: 'root',
      root_key_commitment: 'root',
      root_epoch: 1,
      root_envelope_nonce: 'nonce',
      root_envelope_ciphertext: 'ciphertext',
      created_at: 0,
    })
    .execute();
  await db
    .insertInto('browser_delegations')
    .values({
      id: 'push-delegation',
      user_id: 'push-owner',
      root_epoch: 1,
      delegate_public_key: 'delegate',
      certificate_json: '{}',
      issued_at: 0,
      expires_at: 9e15,
      revoked_at: null,
    })
    .execute();
  await db
    .insertInto('push_subscriptions')
    .values({
      id: 'push-subscription',
      user_id: 'push-owner',
      delegation_id: 'push-delegation',
      ...input.subscription,
    })
    .execute();
  await db
    .insertInto('daemons')
    .values({
      id: 'bell-daemon',
      user_id: 'push-owner',
      name: 'Bell',
      platform: 'test',
      daemon_identity_public_key: '',
      daemon_identity_p256_public_key: '',
      identity_seal_backend: 'software',
      daemon_identity_key_commitment: '',
      daemon_binding_json: '{}',
      box_id: null,
      last_seen: null,
      version: null,
    })
    .execute();
  return db;
}

function fetchReplacement(
  fn: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>,
): typeof fetch {
  return Object.assign(fn, { preconnect: globalThis.fetch.preconnect });
}
