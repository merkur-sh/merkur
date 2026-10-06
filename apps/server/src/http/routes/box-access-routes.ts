import { Effect } from 'effect';
import { Elysia, status } from 'elysia';

import type { Logger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import type { AuthenticatedBrowser } from '../../services/auth-service';
import { BoxAccessError, BoxAccessServiceTag } from '../../services/box-access-service';
import type { InfrastructureError } from '../../services/errors';
import {
  enforceRateLimit,
  RateLimitedError,
  RateLimitServiceTag,
} from '../../services/rate-limit-service';
import { ApiModels } from '../api-models';
import { authenticatedApiPlugin } from '../authenticated-api';
import { resolveRateLimitSource } from '../client-ip';
import { runRouteEffect } from '../effect-route';

const STATUS_FORBIDDEN = 403;
const STATUS_TOO_MANY_REQUESTS = 429;
/**
 * Joins one source address may send in ten minutes, across every account it
 * signs in as: the website form's budget, for the same list.
 */
const JOIN_IP_LIMIT = 5;
const JOIN_WINDOW_MS = 600_000;

interface BoxAccessRoutesOptions {
  readonly runServerProgram: typeof runServerProgram;
  readonly authorizeRequest: (request: Request) => Promise<AuthenticatedBrowser | null>;
  readonly logger: Logger;
  readonly trustedProxyHops: number;
}

/**
 * The hosted-box waitlist: an account's own standing, and joining. Approval is
 * not an API; an operator decides in the database.
 */
export function boxAccessRoutesPlugin({
  runServerProgram,
  authorizeRequest,
  logger,
  trustedProxyHops,
}: BoxAccessRoutesOptions) {
  return new Elysia({ name: 'box-access-routes', normalize: false }).group('/api', (api) =>
    api
      .use(authenticatedApiPlugin({ authorizeRequest }))
      .get(
        '/boxes/access',
        { response: { 200: ApiModels.BoxAccessResponse, 401: ApiModels.ErrorResponse } },
        async ({ request, userId }) =>
          runRouteEffect(
            runServerProgram,
            Effect.gen(function* () {
              const boxAccess = yield* BoxAccessServiceTag;
              return yield* boxAccess.access(userId);
            }),
            routeOptions(logger, request, 'box_access_read_failed'),
          ),
      )
      .post(
        '/boxes/waitlist',
        {
          response: {
            200: ApiModels.BoxAccessResponse,
            401: ApiModels.ErrorResponse,
            429: ApiModels.ErrorResponse,
          },
        },
        async ({ request, server, userId }) => {
          const source = resolveRateLimitSource(request, server, trustedProxyHops);
          return runRouteEffect(
            runServerProgram,
            Effect.gen(function* () {
              const limiter = yield* RateLimitServiceTag;
              yield* enforceRateLimit(limiter, [
                {
                  key: `box-waitlist:join:ip:${source}`,
                  limit: JOIN_IP_LIMIT,
                  windowMs: JOIN_WINDOW_MS,
                },
              ]);
              const boxAccess = yield* BoxAccessServiceTag;
              return yield* boxAccess.join(userId);
            }),
            {
              logger,
              eventName: 'box_waitlist_join_failed',
              request,
              signal: request.signal,
              mapError: mapJoinError,
            },
          );
        },
      ),
  );
}

/** A join is refused only when its source address is over budget. */
function mapJoinError(error: RateLimitedError | InfrastructureError) {
  return error instanceof RateLimitedError
    ? status(STATUS_TOO_MANY_REQUESTS, { error: 'rate_limited' as const })
    : null;
}

/**
 * Maps a refused box-access decision to its HTTP answer. Shared with the box
 * creation route, which is where `box_access_required` is actually raised.
 */
export function mapBoxAccessError(error: unknown) {
  if (!(error instanceof BoxAccessError)) return null;
  return status(STATUS_FORBIDDEN, { error: error.code });
}

function routeOptions(logger: Logger, request: Request, eventName: string) {
  return { logger, eventName, request, signal: request.signal, mapError: mapBoxAccessError };
}
