import {
  DEVICE_EVENTS_KEEPALIVE_MS,
  DEVICE_EVENTS_SINCE_HEADER,
  parseDeviceEventsCursor,
  spanAttributes,
} from '@merkur/shared';
import { Clock, Effect } from 'effect';
import { Elysia, status, t } from 'elysia';
import { DatabaseService } from '../../db/client';
import { errorLogContext, type Logger, logWithLoggerEffect } from '../../logger';
import type { runServerProgram } from '../../runtime';
import { type AuthenticatedBrowser, AuthServiceTag } from '../../services/auth-service';
import { BoxAccessServiceTag } from '../../services/box-access-service';
import {
  BoxHostError,
  BoxHostServiceTag,
  BoxHostUnconfiguredError,
} from '../../services/box-host-service';
import { BoxRemovalPendingError, requireNoPendingBoxRemoval } from '../../services/box-removal';
import { BrowserPresenceServiceTag } from '../../services/browser-session-presence';
import { DeviceEventsServiceTag } from '../../services/device-events-service';
import { DeviceServiceTag } from '../../services/device-service';
import { infrastructureError } from '../../services/errors';
import { readMachineUsage } from '../../services/machine-usage';
import { RealtimeCoordinationServiceTag } from '../../services/realtime-coordination-service';
import { ApiModels } from '../api-models';
import { authenticatedApiPlugin } from '../authenticated-api';
import { loggedEffect, runRouteEffect } from '../effect-route';
import {
  createDeviceEventsSseResponse,
  type DeviceEventsSseLifetime,
  openDeviceEventsStreams,
} from '../sse';
import { mapBoxAccessError } from './box-access-routes';

const STATUS_NO_CONTENT = 204;
const STATUS_CONFLICT = 409;
/** For callers that only need device names and must not pay for a presence lookup. */

interface DeviceRoutesOptions {
  readonly deviceEventsLifetime: DeviceEventsSseLifetime;
  readonly runServerProgram: typeof runServerProgram;
  readonly authorizeRequest: (request: Request) => Promise<AuthenticatedBrowser | null>;
  readonly logger: Logger;
  readonly trustedProxyHops: number;
}

export function deviceRoutesPlugin({
  deviceEventsLifetime,
  runServerProgram,
  authorizeRequest,
  logger,
}: DeviceRoutesOptions) {
  return new Elysia({ name: 'device-routes', normalize: false }).group('/api', (api) =>
    api
      .use(authenticatedApiPlugin({ authorizeRequest }))
      .get('/devices/events', ({ request, server, userId, delegationId, delegationExpiresAt }) => {
        // SSE can be quiet longer than Bun's socket idle timeout. Its lifetime
        // belongs to request cancellation and the authenticated presence scope.
        server?.timeout(request, 0);
        return createDeviceEventsSseResponse({
          lifetime: deviceEventsLifetime,
          run: runServerProgram,
          request,
          userId,
          keepAliveMs: DEVICE_EVENTS_KEEPALIVE_MS,
          since: parseDeviceEventsCursor(request.headers.get(DEVICE_EVENTS_SINCE_HEADER)),
          subscribePresence: (listener) =>
            loggedEffect(
              Effect.gen(function* () {
                const presence = yield* BrowserPresenceServiceTag;
                const release = yield* presence.open(
                  { userId, delegationId, delegationExpiresAt },
                  listener,
                );
                // Subscribe before checking again: revocation may have committed
                // between request authorization and installing the listener.
                const auth = yield* AuthServiceTag;
                const active = yield* auth
                  .requireActiveDelegation(userId, delegationId)
                  .pipe(Effect.onError(() => release));
                if (active === null) listener({ _tag: 'session-ended' });
                return release;
              }),
              {
                logger,
                eventName: 'browser_presence_subscribe_failed',
                request,
              },
            ),
          subscribe: (listener) =>
            loggedEffect(
              Effect.gen(function* () {
                // Recorded where a stream begins, because the count only means
                // something against the open that observed it: several at once
                // for one account is a browser whose earlier streams outlived
                // it, which is invisible from the outside and is what a request
                // that never reaches this process looks like from in here.
                yield* Effect.annotateCurrentSpan(
                  spanAttributes({
                    'merkur.device_events_streams_open': openDeviceEventsStreams(userId),
                  }),
                );
                const deviceEvents = yield* DeviceEventsServiceTag;
                return yield* deviceEvents.subscribe(userId, listener);
              }),
              {
                logger,
                eventName: 'device_events_subscribe_failed',
                request,
              },
            ),
          readCursor: loggedEffect(
            Effect.gen(function* () {
              const deviceEvents = yield* DeviceEventsServiceTag;
              return yield* deviceEvents.readCursor(userId);
            }),
            {
              logger,
              eventName: 'device_events_cursor_failed',
              request,
            },
          ),
          loadSnapshot: loggedEffect(
            Effect.gen(function* () {
              const coordination = yield* RealtimeCoordinationServiceTag;
              const deviceService = yield* DeviceServiceTag;
              const daemonPresence = yield* coordination.getUserDaemonPresence(userId);
              const daemonPresenceStates = new Map(
                daemonPresence.map((presence) => [presence.daemonId, presence.state] as const),
              );
              return yield* deviceService.listDevices(userId, daemonPresenceStates);
            }),
            {
              logger,
              eventName: 'device_events_snapshot_failed',
              request,
            },
          ),
          onError(error) {
            logger.warn('device_events_stream_failed', {
              ...errorLogContext(error),
              userId,
            });
          },
          onClosed(reason, openForUser, ageMs) {
            logger.info('device_events_stream_closed', { reason, openForUser, ageMs, userId });
          },
        });
      })
      .post(
        '/boxes',
        {
          // Matches Incus instance naming, so a bad name is refused here rather
          // than surfacing as an opaque failure from the box host.
          body: t.Object({
            boxId: t.String({ minLength: 1, maxLength: 63, pattern: '^[a-z][a-z0-9-]*$' }),
          }),
          response: {
            200: ApiModels.BoxCreatedResponse,
            401: ApiModels.ErrorResponse,
            403: ApiModels.ErrorResponse,
            409: ApiModels.ErrorResponse,
          },
        },
        async ({ body, request, userId }) =>
          runRouteEffect(
            runServerProgram,
            Effect.gen(function* () {
              // Checked before a link token exists, so a refused account costs
              // the box host nothing.
              const boxAccess = yield* BoxAccessServiceTag;
              yield* boxAccess.requireApproved(userId);
              yield* requireNoPendingBoxRemoval(body.boxId);
              const deviceService = yield* DeviceServiceTag;
              const boxHost = yield* BoxHostServiceTag;
              // The box's daemon links itself with this token, then waits for
              // the browser to approve the code below with the account
              // password — nothing here can approve it.
              const token = yield* deviceService.createLinkToken(userId, body.boxId);
              return yield* boxHost.createLinked(body.boxId, token.token);
            }),
            {
              logger,
              eventName: 'box_create_failed',
              request,
              signal: request.signal,
              mapError: (error: unknown) =>
                error instanceof BoxRemovalPendingError
                  ? status(STATUS_CONFLICT, { error: 'box_removal_pending' })
                  : mapBoxAccessError(error),
            },
          ),
      )
      // Revives a box the TTL reaper stopped. Without this a reaped box is an
      // offline device with no way back, since the device row is the only
      // handle the user has on it.
      .post('/devices/:id/start', async ({ params, request, userId }) =>
        runRouteEffect(
          runServerProgram,
          Effect.gen(function* () {
            const deviceService = yield* DeviceServiceTag;
            const { boxId, ambiguousBoxId } = yield* deviceService.resolveBox(userId, params.id);
            if (boxId === null) {
              if (ambiguousBoxId !== null) {
                // Effect-native rather than the synchronous surface: this runs inside the
                // route's fiber, so the record inherits the route span and is pivotable
                // from the trace. The sync surface runs the record on a fresh fiber with
                // no current span, which is why it exports with no trace id.
                yield* logWithLoggerEffect(logger, 'warn', 'box_start_ambiguous', {
                  deviceId: params.id,
                  boxId: ambiguousBoxId,
                });
              }
              // Not a box, or not safely identifiable. Reporting success would
              // imply something is coming back that never will.
              return { started: false };
            }
            const boxHost = yield* BoxHostServiceTag;
            yield* boxHost.start(boxId);
            return { started: true };
          }),
          { logger, eventName: 'box_start_failed', request, signal: request.signal },
        ),
      )
      .delete(
        '/devices/:id',
        {
          params: ApiModels.DeleteDeviceParams,
          response: {
            204: ApiModels.EmptyResponse,
            401: ApiModels.ErrorResponse,
            503: ApiModels.ErrorResponse,
          },
        },
        async ({ params, request, userId }) => {
          const result = await runRouteEffect(
            runServerProgram,
            Effect.gen(function* () {
              const deviceService = yield* DeviceServiceTag;
              // Resolve the box before the record that names it is gone.
              const { boxId, ambiguousBoxId } = yield* deviceService.resolveBox(userId, params.id);
              if (ambiguousBoxId !== null) {
                yield* logWithLoggerEffect(logger, 'warn', 'box_delete_ambiguous', {
                  deviceId: params.id,
                  boxId: ambiguousBoxId,
                });
              }

              if (boxId !== null) {
                // Preserve the SQL handle until deletion is confirmed.
                const boxHost = yield* BoxHostServiceTag;
                yield* boxHost.remove(boxId);
              }

              yield* deviceService.deleteDevice(userId, params.id);
            }),
            {
              logger,
              eventName: 'device_delete_failed',
              request,
              signal: request.signal,
              mapError: (error: unknown) =>
                error instanceof BoxHostError || error instanceof BoxHostUnconfiguredError
                  ? status(503, { error: 'box_host_unavailable' })
                  : null,
            },
          );
          return result ?? status(STATUS_NO_CONTENT, undefined);
        },
      )
      .patch(
        '/devices/:id',
        {
          body: ApiModels.RenameDeviceBody,
          params: ApiModels.DeleteDeviceParams,
          response: {
            204: ApiModels.EmptyResponse,
            401: ApiModels.ErrorResponse,
          },
        },
        async ({ body, params, request, userId }) => {
          await runRouteEffect(
            runServerProgram,
            Effect.gen(function* () {
              const deviceService = yield* DeviceServiceTag;
              yield* deviceService.renameDevice({
                userId,
                deviceId: params.id,
                name: body.name,
              });
            }),
            {
              logger,
              eventName: 'device_rename_failed',
              request,
              signal: request.signal,
            },
          );
          return status(STATUS_NO_CONTENT, undefined);
        },
      )
      .post(
        '/link-token',
        {
          body: ApiModels.LinkTokenCreateBody,
          response: {
            200: ApiModels.LinkTokenResponse,
            400: ApiModels.ErrorResponse,
            401: ApiModels.ErrorResponse,
          },
        },
        async ({ request, userId }) => {
          const result = await runRouteEffect(
            runServerProgram,
            Effect.gen(function* () {
              const deviceService = yield* DeviceServiceTag;
              const db = yield* DatabaseService;
              const now = yield* Clock.currentTimeMillis;
              const { machineUsage, reservationExpiresAt } = yield* Effect.tryPromise({
                try: () => readMachineUsage(db, userId, now),
                catch: infrastructureError('device', 'machine-usage'),
              });
              if (machineUsage.limit !== null && machineUsage.used >= machineUsage.limit) {
                return { command: null, expiresAt: reservationExpiresAt, machineUsage };
              }
              const token = yield* deviceService.createLinkToken(userId, null);
              return { command: token.command, expiresAt: token.expiresAt, machineUsage };
            }),
            {
              logger,
              eventName: 'link_token_create_failed',
              request,
              signal: request.signal,
            },
          );
          // The token travels only inside the command: one thing to copy.
          return {
            command: result.command,
            expiresAt: result.expiresAt,
            machineUsage: result.machineUsage,
          };
        },
      ),
  );
}
