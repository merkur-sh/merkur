import { encryptNotification } from '@block65/webcrypto-web-push';
import { createEntityId } from '@merkur/auth';
import { Cause, Clock, Context, Data, Effect, Layer, Queue } from 'effect';
import type { Kysely } from 'kysely';
import { ServerConfigService } from '../config';
import { DatabaseService } from '../db/client';
import { tryDatabaseTransactionPromise, withDatabaseTransaction } from '../db/transaction';
import type { DatabaseSchema } from '../db/types';
import { createLogger, errorLogContext, type Logger, logWithLoggerEffect } from '../logger';
import { type InfrastructureError, infrastructureError } from './errors';
import { type KeyService, KeyServiceTag } from './key-service';

const TERMINAL_BELL_RATE_LIMIT_MS = 5_000;
// Hard cap for the insertion-ordered in-memory rate-limit map.
const TERMINAL_BELL_RATE_LIMIT_MAP_MAX = 1_000;
// A brute-force run is one event, not one per guess. Bells are throttled at
// five seconds because each one is a distinct thing the user did; failed
// sign-ins arrive in bursts, so this is deliberately minutes-scale.
const FAILED_SIGN_IN_RATE_LIMIT_MS = 15 * 60_000;
const PUSH_TTL_SECONDS = 60;
const PUSH_SEND_TIMEOUT_MS = 5_000;
const PUSH_SEND_CONCURRENCY = 8;
const FAILED_SIGN_IN_QUEUE_CAPACITY = 1_000;
// Resource bound on cached VAPID authorizations, one per push-service origin.
const VAPID_HEADER_CACHE_MAX = 1_000;
// keyd's JWTs live 12 hours; one is replaced an hour before it would lapse in flight.
const VAPID_REFRESH_MARGIN_SECONDS = 3_600;

interface FailedSignInNotification {
  readonly userId: string;
  readonly clientIp: string;
  readonly occurredAt: number;
}
const EXPIRED_PUSH_STATUS_CODES = new Set([404, 410]);

export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export class UntrustedPushDestination extends Data.TaggedError('UntrustedPushDestination') {}
export class PushDelegationEnded extends Data.TaggedError('PushDelegationEnded') {}

function isTrustedPushDestination(endpoint: string): boolean {
  const url = URL.parse(endpoint);
  if (
    url === null ||
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  )
    return false;
  const host = url.hostname;
  return (
    host === 'fcm.googleapis.com' ||
    host === 'updates.push.services.mozilla.com' ||
    host.endsWith('.push.services.mozilla.com') ||
    host.endsWith('.push.apple.com') ||
    host.endsWith('.notify.windows.com')
  );
}

export interface PushNotificationService {
  getVapidPublicKey(): string | null;
  upsertSubscription(
    userId: string,
    delegationId: string,
    subscription: PushSubscriptionInput,
  ): Effect.Effect<void, InfrastructureError | UntrustedPushDestination | PushDelegationEnded>;
  deleteSubscription(
    userId: string,
    delegationId: string,
    endpoint: string,
  ): Effect.Effect<void, InfrastructureError>;
  notifyTerminalBell(input: {
    readonly userId: string;
    readonly daemonId: string;
    readonly occurredAt: number;
  }): Effect.Effect<void, InfrastructureError>;
  /**
   * Tells the account owner that someone is failing to sign in as them. Callers
   * enqueue only; a scoped service worker performs all database and external
   * push work. Admission never waits for delivery, preserving account privacy.
   */
  notifyFailedSignIn(input: {
    readonly userId: string;
    readonly clientIp: string;
    readonly occurredAt: number;
  }): Effect.Effect<void, InfrastructureError>;
}

export class PushNotificationServiceTag extends Context.Service<
  PushNotificationServiceTag,
  PushNotificationService
>()('PushNotificationService') {}

export const PushNotificationServiceLive = Layer.effect(
  PushNotificationServiceTag,
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const config = yield* ServerConfigService;
    const keys = yield* KeyServiceTag;
    // KeyServiceLive refuses to start with a contact and no VAPID key, or the reverse.
    const vapid =
      keys.publicKeys.vapid === null || config.webPushContact === undefined
        ? null
        : createVapidSigner(keys, keys.publicKeys.vapid, config.webPushContact);
    return yield* createPushNotificationService(db, vapid, createLogger('server'));
  }),
);

/** What a push request needs of VAPID: the public key and an `Authorization` per push service. */
export interface VapidSigner {
  readonly publicKey: string;
  authorization(audience: string): Effect.Effect<string, InfrastructureError>;
}

/**
 * keyd signs one RFC 8292 JWT per push-service origin, reused until an hour before it expires,
 * so a burst of notifications costs one keyd request per push service.
 */
export function createVapidSigner(
  keys: KeyService,
  publicKey: string,
  contact: string,
): VapidSigner {
  const headers = new Map<string, { readonly header: string; readonly refreshAt: number }>();
  return {
    publicKey,
    authorization: (audience) =>
      Effect.gen(function* () {
        const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const cached = headers.get(audience);
        if (cached !== undefined && cached.refreshAt > nowSeconds) return cached.header;
        const { jwt, expiresAt } = yield* keys
          .vapidJwt(audience, contact)
          .pipe(Effect.mapError(infrastructureError('keyd', 'vapid-jwt')));
        const header = `vapid t=${jwt}, k=${publicKey}`;
        // Resource bound, though the trusted push services are few: evict the oldest at the
        // bound, as the rate-limit maps do.
        headers.delete(audience);
        if (headers.size >= VAPID_HEADER_CACHE_MAX) {
          const oldest = headers.keys().next().value;
          if (oldest !== undefined) headers.delete(oldest);
        }
        headers.set(audience, { header, refreshAt: expiresAt - VAPID_REFRESH_MARGIN_SECONDS });
        return header;
      }),
  };
}

export const createPushNotificationService = Effect.fnUntraced(function* (
  db: Kysely<DatabaseSchema>,
  vapid: VapidSigner | null,
  logger: Logger,
) {
  const lastTerminalBellPushAt = new Map<string, number>();
  const lastFailedSignInPushAt = new Map<string, number>();

  const failedSignIns = yield* Queue.make<FailedSignInNotification>({
    capacity: FAILED_SIGN_IN_QUEUE_CAPACITY,
    strategy: 'dropping',
  });
  const pendingUsers = new Set<string>();
  yield* Effect.addFinalizer(() => Queue.shutdown(failedSignIns));

  const service: PushNotificationService = {
    getVapidPublicKey(): string | null {
      return vapid?.publicKey ?? null;
    },

    upsertSubscription: Effect.fnUntraced(function* (
      userId: string,
      delegationId: string,
      subscription: PushSubscriptionInput,
    ) {
      if (!isTrustedPushDestination(subscription.endpoint))
        return yield* new UntrustedPushDestination();
      const now = yield* Clock.currentTimeMillis;
      yield* withDatabaseTransaction(db, (trx) =>
        tryDatabaseTransactionPromise({
          try: async () => {
            const live = await trx
              .selectFrom('browser_delegations')
              .select('id')
              .where('id', '=', delegationId)
              .where('user_id', '=', userId)
              .where('revoked_at', 'is', null)
              .where('expires_at', '>', now)
              .executeTakeFirst();
            if (live === undefined) throw new PushDelegationEnded();
            await trx
              .insertInto('push_subscriptions')
              .values({
                id: createEntityId(),
                user_id: userId,
                delegation_id: delegationId,
                endpoint: subscription.endpoint,
                p256dh: subscription.p256dh,
                auth: subscription.auth,
              })
              .onConflict((conflict) =>
                conflict.column('endpoint').doUpdateSet({
                  user_id: userId,
                  delegation_id: delegationId,
                  p256dh: subscription.p256dh,
                  auth: subscription.auth,
                }),
              )
              .execute();
          },
          catch: (cause) =>
            cause instanceof PushDelegationEnded
              ? cause
              : infrastructureError('push-notification', 'upsert-subscription')(cause),
        }),
      );
    }),

    deleteSubscription(userId, delegationId, endpoint): Effect.Effect<void, InfrastructureError> {
      return Effect.tryPromise({
        try: async () => {
          await db
            .deleteFrom('push_subscriptions')
            .where('user_id', '=', userId)
            .where('endpoint', '=', endpoint)
            .where('delegation_id', '=', delegationId)
            .execute();
        },
        catch: infrastructureError('push-notification', 'delete-subscription'),
      });
    },

    notifyTerminalBell(input): Effect.Effect<void, InfrastructureError> {
      return Effect.gen(function* () {
        if (vapid === null) {
          yield* logWithLoggerEffect(logger, 'warn', 'terminal_bell_push_not_configured', {
            daemonId: input.daemonId,
            userId: input.userId,
          });
          return;
        }

        const rateLimitKey = `${input.userId}:${input.daemonId}`;
        const now = yield* Clock.currentTimeMillis;
        const lastPushAt = lastTerminalBellPushAt.get(rateLimitKey) ?? 0;
        if (now - lastPushAt < TERMINAL_BELL_RATE_LIMIT_MS) {
          return;
        }
        // Refresh insertion order for an expired existing key, then evict one
        // oldest entry in O(1). A sweep-only cap could grow without bound when
        // many fresh daemon ids arrived inside one five-second window.
        lastTerminalBellPushAt.delete(rateLimitKey);
        if (lastTerminalBellPushAt.size >= TERMINAL_BELL_RATE_LIMIT_MAP_MAX) {
          const oldestKey = lastTerminalBellPushAt.keys().next().value;
          if (oldestKey !== undefined) lastTerminalBellPushAt.delete(oldestKey);
        }
        lastTerminalBellPushAt.set(rateLimitKey, now);

        const [daemon, subscriptions] = yield* Effect.all(
          [
            Effect.tryPromise({
              try: () =>
                db
                  .selectFrom('daemons')
                  .select(['name'])
                  .where('id', '=', input.daemonId)
                  .where('user_id', '=', input.userId)
                  .executeTakeFirst(),
              catch: infrastructureError('push-notification', 'load-daemon-for-bell'),
            }),
            Effect.tryPromise({
              try: () => liveSubscriptions(input.userId, now),
              catch: infrastructureError('push-notification', 'load-push-subscriptions'),
            }),
          ],
          { concurrency: 'unbounded' },
        );

        if (daemon === undefined || subscriptions.length === 0) {
          return;
        }

        const payload = JSON.stringify({
          kind: 'terminal_bell',
          title: 'Terminal bell',
          body: `${daemon.name} needs attention`,
          url: `/#machine=${encodeURIComponent(input.daemonId)}`,
          tag: `terminal-bell:${input.daemonId}`,
          daemonId: input.daemonId,
          occurredAt: input.occurredAt,
        });

        yield* Effect.forEach(
          subscriptions,
          (subscription) =>
            sendPushNotificationEffect(vapid, subscription, payload).pipe(
              Effect.catch((error: InfrastructureError) =>
                handlePushSendErrorEffect(input.userId, subscription.endpoint, error),
              ),
            ),
          { concurrency: PUSH_SEND_CONCURRENCY, discard: true },
        );
      });
    },

    notifyFailedSignIn: Effect.fnUntraced(function* (input: FailedSignInNotification) {
      if (vapid === null || pendingUsers.has(input.userId)) return;
      pendingUsers.add(input.userId);
      if (!(yield* Queue.offer(failedSignIns, input))) pendingUsers.delete(input.userId);
    }, Effect.uninterruptible),
  };

  const sendFailedSignIn = Effect.fnUntraced(function* (input: FailedSignInNotification) {
    if (vapid === null) {
      return;
    }

    const now = yield* Clock.currentTimeMillis;
    const lastPushAt = lastFailedSignInPushAt.get(input.userId) ?? 0;
    if (now - lastPushAt < FAILED_SIGN_IN_RATE_LIMIT_MS) {
      return;
    }
    lastFailedSignInPushAt.delete(input.userId);
    if (lastFailedSignInPushAt.size >= TERMINAL_BELL_RATE_LIMIT_MAP_MAX) {
      const oldestKey = lastFailedSignInPushAt.keys().next().value;
      if (oldestKey !== undefined) lastFailedSignInPushAt.delete(oldestKey);
    }
    lastFailedSignInPushAt.set(input.userId, now);

    const subscriptions = yield* Effect.tryPromise({
      try: () => liveSubscriptions(input.userId, now),
      catch: infrastructureError('push-notification', 'load-push-subscriptions'),
    });

    if (subscriptions.length === 0) {
      return;
    }

    const payload = JSON.stringify({
      kind: 'failed_sign_in',
      title: 'Failed sign-in attempt',
      body: `Someone tried to sign in from ${input.clientIp}. Ignore this if it was you.`,
      url: '/',
      // One tag for the whole subject, so a later burst replaces the old
      // notification instead of stacking up.
      tag: 'failed-sign-in',
      occurredAt: input.occurredAt,
    });

    yield* Effect.forEach(
      subscriptions,
      (subscription) =>
        sendPushNotificationEffect(vapid, subscription, payload).pipe(
          Effect.catch((error: InfrastructureError) =>
            handlePushSendErrorEffect(input.userId, subscription.endpoint, error),
          ),
        ),
      { concurrency: PUSH_SEND_CONCURRENCY, discard: true },
    );
  });
  yield* Effect.forever(
    Effect.gen(function* () {
      const input = yield* Queue.take(failedSignIns);
      pendingUsers.delete(input.userId);
      yield* sendFailedSignIn(input).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          return logWithLoggerEffect(logger, 'warn', 'failed_sign_in_notification_failed', {
            userId: input.userId,
            ...errorLogContext(Cause.squash(cause)),
          });
        }),
      );
    }),
  ).pipe(Effect.forkScoped);
  return service;

  function liveSubscriptions(userId: string, now: number) {
    return db
      .selectFrom('push_subscriptions')
      .innerJoin(
        'browser_delegations',
        'browser_delegations.id',
        'push_subscriptions.delegation_id',
      )
      .select(['endpoint', 'p256dh', 'auth'])
      .where('push_subscriptions.user_id', '=', userId)
      .where('browser_delegations.user_id', '=', userId)
      .where('browser_delegations.revoked_at', 'is', null)
      .where('browser_delegations.expires_at', '>', now)
      .execute();
  }

  function handlePushSendErrorEffect(
    userId: string,
    endpoint: string,
    error: InfrastructureError,
  ): Effect.Effect<void, InfrastructureError> {
    const statusCode = readPushErrorStatusCode(error);
    if (statusCode !== null && EXPIRED_PUSH_STATUS_CODES.has(statusCode)) {
      return Effect.tryPromise({
        try: async () => {
          await db
            .deleteFrom('push_subscriptions')
            .where('user_id', '=', userId)
            .where('endpoint', '=', endpoint)
            .execute();
        },
        catch: infrastructureError('push-notification', 'handle-push-send-error'),
      });
    }

    return logWithLoggerEffect(logger, 'warn', 'terminal_bell_push_send_failed', {
      statusCode,
      body: readStringProperty(error, 'body'),
      headers: readUnknownProperty(error, 'headers'),
      ...errorLogContext(error),
    });
  }
});

/** RFC 8291 `aes128gcm` to the subscription's keys, under keyd's VAPID authorization. */
async function sendPushNotification(
  authorization: string,
  subscription: { readonly endpoint: string; readonly p256dh: string; readonly auth: string },
  payload: string,
  signal: AbortSignal,
): Promise<void> {
  if (!isTrustedPushDestination(subscription.endpoint)) throw new UntrustedPushDestination();
  const body = await encryptNotification(
    {
      endpoint: subscription.endpoint,
      expirationTime: null,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    new TextEncoder().encode(payload),
  );
  const response = await fetch(subscription.endpoint, {
    redirect: 'error',
    method: 'POST',
    headers: {
      authorization,
      ttl: String(PUSH_TTL_SECONDS),
      urgency: 'high',
      'content-encoding': 'aes128gcm',
      'content-length': String(body.byteLength),
      'content-type': 'application/octet-stream',
    },
    body,
    signal,
  });
  const answer = await response.text();
  if (!response.ok) {
    throw new PushServiceRejection(response.status, answer, Object.fromEntries(response.headers));
  }
}

export function sendPushNotificationEffect(
  vapid: VapidSigner,
  subscription: { readonly endpoint: string; readonly p256dh: string; readonly auth: string },
  payload: string,
): Effect.Effect<void, InfrastructureError> {
  return Effect.gen(function* () {
    const endpoint = yield* Effect.try({
      try: () => new URL(subscription.endpoint),
      catch: infrastructureError('push-notification', 'send-terminal-bell-push'),
    });
    // Checked before keyd signs anything for it, and again where the request is sent.
    if (!isTrustedPushDestination(subscription.endpoint)) {
      return yield* infrastructureError(
        'push-notification',
        'send-terminal-bell-push',
      )(new UntrustedPushDestination());
    }
    const authorization = yield* vapid.authorization(endpoint.origin);
    yield* Effect.tryPromise({
      try: (signal) => sendPushNotification(authorization, subscription, payload, signal),
      catch: infrastructureError('push-notification', 'send-terminal-bell-push'),
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: PUSH_SEND_TIMEOUT_MS,
      orElse: () =>
        infrastructureError(
          'push-notification',
          'send-terminal-bell-push',
        )(new Error('Push delivery timed out')),
    }),
  );
}

/** A push service answered with a non-2xx status; 404 and 410 mean the subscription is gone. */
class PushServiceRejection extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: string,
    readonly headers: Readonly<Record<string, string>>,
  ) {
    super(`Push service responded ${statusCode}`);
    this.name = 'PushServiceRejection';
  }
}

export function readPushErrorStatusCode(error: unknown): number | null {
  const statusCode = readNestedErrorProperty(error, 'statusCode');
  return typeof statusCode === 'number' ? statusCode : null;
}

function readStringProperty(error: unknown, property: string): string | null {
  const value = readNestedErrorProperty(error, property);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readUnknownProperty(error: unknown, property: string): unknown {
  return readNestedErrorProperty(error, property);
}

function readNestedErrorProperty(error: unknown, property: string): unknown {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      return null;
    }
    seen.add(current);
    if (property in current) {
      return (current as Record<string, unknown>)[property];
    }
    if (!('cause' in current)) {
      return null;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return null;
}
