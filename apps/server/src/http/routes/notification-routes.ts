import { Effect } from 'effect';
import { Elysia, status } from 'elysia';
import { errorLogContext, type Logger, logWithLoggerEffect } from '../../logger';
import type { runServerProgram } from '../../runtime';
import type { AuthenticatedBrowser } from '../../services/auth-service';
import { PushNotificationServiceTag } from '../../services/push-notification-service';
import { ApiModels } from '../api-models';
import { authenticatedApiPlugin } from '../authenticated-api';
import { authorizeDaemonRequest, parseDaemonJsonBody } from '../daemon-request-auth';
import { runLoggedEffect, runRouteEffect } from '../effect-route';

type RunServerProgram = typeof runServerProgram;

const STATUS_NO_CONTENT = 204;
const STATUS_SERVICE_UNAVAILABLE = 503;
const STATUS_UNAUTHORIZED = 401;

interface NotificationRoutesOptions {
  readonly runServerProgram: RunServerProgram;
  readonly authorizeRequest: (request: Request) => Promise<AuthenticatedBrowser | null>;
  readonly logger: Logger;
}

export function notificationRoutesPlugin({
  runServerProgram,
  authorizeRequest,
  logger,
}: NotificationRoutesOptions) {
  return new Elysia({ name: 'notification-routes' })
    .group('/api/push', (api) =>
      api
        .use(authenticatedApiPlugin({ authorizeRequest }))
        .get(
          '/vapid-public-key',
          {
            response: {
              200: ApiModels.PushVapidPublicKeyResponse,
              401: ApiModels.ErrorResponse,
              503: ApiModels.ErrorResponse,
            },
          },
          async ({ request }) => {
            const publicKey = await runRouteEffect(
              runServerProgram,
              Effect.gen(function* () {
                const pushNotifications = yield* PushNotificationServiceTag;
                return pushNotifications.getVapidPublicKey();
              }),
              {
                logger,
                eventName: 'push_vapid_public_key_failed',
                request,
                signal: request.signal,
              },
            );
            if (publicKey === null) {
              return status(STATUS_SERVICE_UNAVAILABLE, {
                error: 'web-push-not-configured' as const,
              });
            }

            return { publicKey };
          },
        )
        .post(
          '/subscriptions',
          {
            body: ApiModels.PushSubscriptionBody,
            response: {
              204: ApiModels.EmptyResponse,
              401: ApiModels.ErrorResponse,
            },
          },
          async ({ body, request, userId }) => {
            await runRouteEffect(
              runServerProgram,
              Effect.gen(function* () {
                const pushNotifications = yield* PushNotificationServiceTag;
                yield* pushNotifications.upsertSubscription(userId, {
                  endpoint: body.endpoint,
                  p256dh: body.keys.p256dh,
                  auth: body.keys.auth,
                });
              }),
              {
                logger,
                eventName: 'push_subscription_upsert_failed',
                request,
                signal: request.signal,
              },
            );
            return status(STATUS_NO_CONTENT, undefined);
          },
        )
        .delete(
          '/subscriptions',
          {
            body: ApiModels.PushSubscriptionDeleteBody,
            response: {
              204: ApiModels.EmptyResponse,
              401: ApiModels.ErrorResponse,
            },
          },
          async ({ body, request, userId }) => {
            await runRouteEffect(
              runServerProgram,
              Effect.gen(function* () {
                const pushNotifications = yield* PushNotificationServiceTag;
                yield* pushNotifications.deleteSubscription(userId, body.endpoint);
              }),
              {
                logger,
                eventName: 'push_subscription_delete_failed',
                request,
                signal: request.signal,
              },
            );
            return status(STATUS_NO_CONTENT, undefined);
          },
        ),
    )
    .post(
      '/api/daemon/terminal-bell',
      {
        parse: parseDaemonJsonBody,
        body: ApiModels.DaemonTerminalBellBody,
        response: {
          204: ApiModels.EmptyResponse,
          401: ApiModels.ErrorResponse,
        },
      },
      async ({ body, request }) => {
        const daemonIdentity = await authorizeDaemonRequest(runServerProgram, request, logger);
        if (daemonIdentity === null) {
          return status(STATUS_UNAUTHORIZED, { error: 'unauthorized' as const });
        }

        await runLoggedEffect(
          runServerProgram,
          Effect.gen(function* () {
            const pushNotifications = yield* PushNotificationServiceTag;
            yield* pushNotifications.notifyTerminalBell({
              userId: daemonIdentity.userId,
              daemonId: daemonIdentity.daemonId,
              occurredAt: body.occurredAt,
            });
          }),
          {
            logger,
            eventName: 'terminal_bell_notification_failed',
            request,
            signal: request.signal,
            recover: (error) =>
              logWithLoggerEffect(logger, 'warn', 'terminal_bell_notification_failed', {
                daemonId: daemonIdentity.daemonId,
                ...errorLogContext(error),
              }),
          },
        );

        return status(STATUS_NO_CONTENT, undefined);
      },
    );
}
