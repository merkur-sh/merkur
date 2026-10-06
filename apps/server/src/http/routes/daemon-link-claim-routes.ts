import { parseBearerToken } from '@merkur/shared';
import { Effect } from 'effect';
import { Elysia, status } from 'elysia';

import type { Logger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import type { AuthenticatedBrowser } from '../../services/auth-service';
import {
  DaemonLinkClaimError,
  DaemonLinkClaimServiceTag,
} from '../../services/daemon-link-claim-service';
import { DeviceEventsServiceTag } from '../../services/device-events-service';
import { DeviceServiceTag } from '../../services/device-service';
import {
  enforceRateLimit,
  RateLimitedError,
  RateLimitServiceTag,
} from '../../services/rate-limit-service';
import { ApiModels } from '../api-models';
import { authenticatedApiPlugin } from '../authenticated-api';
import { resolveRateLimitSource } from '../client-ip';
import { runRouteEffect } from '../effect-route';

const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_CONFLICT = 409;
const STATUS_GONE = 410;
const STATUS_NO_CONTENT = 204;
const STATUS_TOO_MANY_REQUESTS = 429;
const RATE_LIMIT_WINDOW_MS = 60_000;
const CLAIM_IP_LIMIT = 60;

interface DaemonLinkClaimRoutesOptions {
  readonly runServerProgram: typeof runServerProgram;
  readonly authorizeRequest: (request: Request) => Promise<AuthenticatedBrowser | null>;
  readonly logger: Logger;
  readonly trustedProxyHops: number;
}

export function daemonLinkClaimRoutesPlugin({
  runServerProgram,
  authorizeRequest,
  logger,
  trustedProxyHops,
}: DaemonLinkClaimRoutesOptions) {
  const routes = new Elysia({ name: 'daemon-link-claim-routes', normalize: false })
    .post(
      '/api/daemon-link/claims',
      {
        body: ApiModels.DaemonLinkClaimCreateBody,
        response: {
          200: ApiModels.DaemonLinkClaimCreatedResponse,
          400: ApiModels.ErrorResponse,
          409: ApiModels.ErrorResponse,
          410: ApiModels.ErrorResponse,
          429: ApiModels.ErrorResponse,
        },
      },
      async ({ body, request, server }) => {
        const clientIp = resolveRateLimitSource(request, server, trustedProxyHops);
        return runRouteEffect(
          runServerProgram,
          Effect.gen(function* () {
            const limiter = yield* RateLimitServiceTag;
            yield* enforceRateLimit(limiter, [
              {
                key: `daemon-link:create:ip:${clientIp}`,
                limit: CLAIM_IP_LIMIT,
                windowMs: RATE_LIMIT_WINDOW_MS,
              },
            ]);
            const service = yield* DaemonLinkClaimServiceTag;
            return yield* service.create(body);
          }),
          claimRouteOptions(logger, request),
        );
      },
    )
    .get(
      '/api/daemon-link/claims/:linkClaimId',
      {
        params: ApiModels.DaemonLinkClaimParams,
        response: {
          200: ApiModels.DaemonLinkClaimApprovedResponse,
          401: ApiModels.ErrorResponse,
          409: ApiModels.ErrorResponse,
          410: ApiModels.ErrorResponse,
        },
      },
      async ({ params, request }) => {
        const pollToken = parseBearerToken(request.headers.get('authorization'));
        if (pollToken === null) {
          return status(STATUS_UNAUTHORIZED, { error: 'claim_unauthorized' as const });
        }
        return runRouteEffect(
          runServerProgram,
          Effect.gen(function* () {
            const service = yield* DaemonLinkClaimServiceTag;
            return yield* service.poll(params.linkClaimId, pollToken);
          }),
          claimRouteOptions(logger, request),
        );
      },
    )
    .post(
      '/api/daemon-link/claims/:linkClaimId/complete',
      {
        params: ApiModels.DaemonLinkClaimParams,
        body: ApiModels.DaemonLinkClaimCompleteBody,
        response: {
          204: ApiModels.EmptyResponse,
          401: ApiModels.ErrorResponse,
          409: ApiModels.ErrorResponse,
          410: ApiModels.ErrorResponse,
        },
      },
      async ({ body, params, request }) => {
        const pollToken = parseBearerToken(request.headers.get('authorization'));
        if (pollToken === null) {
          return status(STATUS_UNAUTHORIZED, { error: 'claim_unauthorized' as const });
        }
        const result = await runRouteEffect(
          runServerProgram,
          Effect.gen(function* () {
            const service = yield* DaemonLinkClaimServiceTag;
            const linked = yield* service.complete(params.linkClaimId, pollToken, body.approvalMac);
            // The new row, announced to every open list as an absolute delta. It
            // reads offline until the daemon's own connection publishes its
            // online edge.
            const devices = yield* DeviceServiceTag;
            const device = yield* devices.getDevice(linked.userId, linked.daemonId);
            if (device !== null) {
              const events = yield* DeviceEventsServiceTag;
              yield* events.publishDelta(linked.userId, { kind: 'added', device });
            }
          }),
          claimRouteOptions(logger, request),
        );
        if (result !== undefined) return result;
        return status(STATUS_NO_CONTENT, undefined);
      },
    );

  return routes.group('/api/daemon-link/claims', (claims) =>
    claims
      .use(authenticatedApiPlugin({ authorizeRequest }))
      .post(
        '/:linkClaimId/inspect',
        {
          params: ApiModels.DaemonLinkClaimParams,
          body: ApiModels.DaemonLinkClaimInspectBody,
          response: {
            200: ApiModels.DaemonLinkClaimInspectResponse,
            400: ApiModels.ErrorResponse,
            401: ApiModels.ErrorResponse,
            409: ApiModels.ErrorResponse,
            410: ApiModels.ErrorResponse,
          },
        },
        ({ params, request, userId }) =>
          runRouteEffect(
            runServerProgram,
            Effect.gen(function* () {
              const service = yield* DaemonLinkClaimServiceTag;
              return yield* service.inspect(userId, params.linkClaimId);
            }),
            claimRouteOptions(logger, request),
          ),
      )
      .post(
        '/:linkClaimId/approve',
        {
          params: ApiModels.DaemonLinkClaimParams,
          body: ApiModels.DaemonLinkApproval,
          response: {
            200: ApiModels.LogoutResponse,
            400: ApiModels.ErrorResponse,
            401: ApiModels.ErrorResponse,
            409: ApiModels.ErrorResponse,
            410: ApiModels.ErrorResponse,
          },
        },
        async ({ body, params, request, userId }) => {
          const result = await runRouteEffect(
            runServerProgram,
            Effect.gen(function* () {
              const service = yield* DaemonLinkClaimServiceTag;
              yield* service.approve(userId, params.linkClaimId, body);
            }),
            claimRouteOptions(logger, request),
          );
          if (result !== undefined) return result;
          return { ok: true };
        },
      ),
  );
}

function claimRouteOptions(logger: Logger, request: Request) {
  return {
    logger,
    eventName: 'daemon_link_claim_failed',
    request,
    signal: request.signal,
    mapError(error: unknown) {
      if (error instanceof RateLimitedError) {
        return status(STATUS_TOO_MANY_REQUESTS, { error: 'rate_limited' as const });
      }
      if (error instanceof DaemonLinkClaimError) {
        switch (error.code) {
          case 'claim_unauthorized':
            return status(STATUS_UNAUTHORIZED, { error: error.code });
          case 'claim_expired':
          case 'link_token_expired':
            return status(STATUS_GONE, { error: error.code });
          case 'claim_conflict':
          case 'claim_not_approved':
          case 'link_token_consumed':
          case 'machine_limit_reached':
            return status(STATUS_CONFLICT, { error: error.code });
          case 'claim_invalid':
          case 'link_token_invalid':
            return status(STATUS_BAD_REQUEST, { error: error.code });
        }
      }
      return null;
    },
  } as const;
}
