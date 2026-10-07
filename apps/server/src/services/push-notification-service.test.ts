import { describe, expect, spyOn, test } from 'bun:test';

import { Deferred, Effect, Fiber, Queue, Redacted } from 'effect';
import { dual } from 'effect/Function';
import { TestClock } from 'effect/testing';
import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import { createLogger } from '../logger';

import { InfrastructureError } from './errors';
import {
  createPushNotificationService,
  readPushErrorStatusCode,
  sendPushNotificationEffect,
} from './push-notification-service';

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
              {
                webPush: {
                  publicKey: input.vapid.publicKey,
                  privateKey: Redacted.make(input.vapid.privateKey),
                  contact: input.vapid.subject,
                },
              },
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
              {
                webPush: {
                  publicKey: input.vapid.publicKey,
                  privateKey: Redacted.make(input.vapid.privateKey),
                  contact: input.vapid.subject,
                },
              },
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
            ...input.subscription,
          })
          .onConflict((conflict) => conflict.column('endpoint').doNothing())
          .execute();
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const service = yield* createPushNotificationService(
                db,
                {
                  webPush: {
                    publicKey: input.vapid.publicKey,
                    privateKey: Redacted.make(input.vapid.privateKey),
                    contact: input.vapid.subject,
                  },
                },
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
      }
    } finally {
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

async function pushMaterial() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString(
    'base64url',
  );
  const secret = await crypto.subtle.exportKey('jwk', keys.privateKey);
  if (secret.d === undefined) throw new Error('Missing private scalar');
  return {
    vapid: { publicKey, privateKey: secret.d, subject: 'mailto:push@merkur.test' },
    subscription: {
      endpoint: 'https://push.merkur.test/message',
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
    .insertInto('push_subscriptions')
    .values({ id: 'push-subscription', user_id: 'push-owner', ...input.subscription })
    .execute();
  return db;
}

function fetchReplacement(
  fn: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>,
): typeof fetch {
  return Object.assign(fn, { preconnect: globalThis.fetch.preconnect });
}
