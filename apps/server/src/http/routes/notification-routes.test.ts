import { describe, expect, test } from 'bun:test';
import { PushVapidPublicKeyResponse } from '@merkur/shared/api-schema';
import { Effect, Layer } from 'effect';
import { Value } from 'typebox/value';

import { createLogger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import {
  type PushNotificationService,
  PushNotificationServiceTag,
} from '../../services/push-notification-service';
import { notificationRoutesPlugin } from './notification-routes';

/** The bytes of an uncompressed P-256 point, as server configuration requires of the key. */
const VAPID_PUBLIC_KEY = Buffer.alloc(65, 4).toString('base64url');

describe('notification routes', () => {
  test('answers the VAPID key as exactly the response the browser checks it against', async () => {
    const response = await routes(VAPID_PUBLIC_KEY).handle(
      new Request('https://merkur.test/api/push/vapid-public-key'),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ publicKey: VAPID_PUBLIC_KEY });
    expect(Value.Check(PushVapidPublicKeyResponse, body)).toBe(true);
  });

  test('a server without web push says so instead of answering a key', async () => {
    const response = await routes(null).handle(
      new Request('https://merkur.test/api/push/vapid-public-key'),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'web-push-not-configured' });
  });
});

function routes(publicKey: string | null) {
  const push: PushNotificationService = {
    getVapidPublicKey: () => publicKey,
    upsertSubscription: () => Effect.die('unexpected subscription'),
    deleteSubscription: () => Effect.die('unexpected unsubscription'),
    notifyTerminalBell: () => Effect.die('unexpected bell'),
    notifyFailedSignIn: () => Effect.die('unexpected sign-in notice'),
  };

  // SAFETY: the key route's program asks for the push service and nothing else,
  // and the layer provides it; the full server runtime is not needed.
  const run = ((program) =>
    Effect.runPromise(
      Effect.provide(
        program as Effect.Effect<unknown, unknown, never>,
        Layer.succeed(PushNotificationServiceTag, push),
      ),
    )) as typeof runServerProgram;

  return notificationRoutesPlugin({
    runServerProgram: run,
    authorizeRequest: async () => ({
      userId: 'user-1',
      delegationId: 'delegation-1',
      delegationExpiresAt: Date.now() + 60_000,
    }),
    logger: createLogger('notification-routes-test'),
  });
}
