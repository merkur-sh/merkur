import { normalizeEdgeWebTransportUrl } from '@merkur/shared';
import { Clock, Effect } from 'effect';
import { Elysia, status, t } from 'elysia';

import { ServerConfigService } from '../../config';
import type { Logger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import {
  EdgeRegistrationConflictError,
  EdgeRegistrationReplayError,
  EdgeRegistrationValidationError,
  EdgeRegistryServiceTag,
  isCanonicalEdgeCertificateHash,
} from '../../services/edge-registry-service';
import {
  enforceRateLimit,
  RateLimitedError,
  RateLimitServiceTag,
} from '../../services/rate-limit-service';
import { resolveRateLimitSource } from '../client-ip';
import {
  authenticateEdgeRegistration,
  EDGE_AUTH_HEADER,
  EDGE_ID_HEADER,
  EDGE_NONCE_HEADER,
  EDGE_TIMESTAMP_HEADER,
  EdgeRegistrationAuthenticationError,
} from '../edge-registration-auth';
import { runRouteEffect } from '../effect-route';

const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_CONFLICT = 409;
const STATUS_TOO_MANY_REQUESTS = 429;
// Edges re-register on a 30s heartbeat, so this only trims bulk abuse of an
// endpoint that is reachable before request authentication is checked.
const REGISTER_RATE_LIMIT_WINDOW_MS = 60_000;
const REGISTER_IP_LIMIT = 60;

const EDGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const EdgeRegisterBody = t.Object({
  certHash: t.String({ minLength: 1 }),
  certHashes: t.Array(t.String({ minLength: 1 }), { minItems: 1, maxItems: 2 }),
  edgeId: t.String({ minLength: 1, maxLength: 64 }),
  edgeRegion: t.String({ minLength: 1, maxLength: 64 }),
  edgeWtUrl: t.String({ minLength: 1 }),
});

const EdgeRegisterResponse = t.Object({
  ok: t.Boolean(),
});

const ErrorResponse = t.Object({ error: t.String() });

class EdgeCertHashInvalidError {
  readonly _tag = 'EdgeCertHashInvalidError';
}

class EdgeRegistrationInvalidError {
  readonly _tag = 'EdgeRegistrationInvalidError';
}

interface EdgeRoutesOptions {
  readonly runServerProgram: typeof runServerProgram;
  readonly logger: Logger;
  readonly trustedProxyHops: number;
}

export function edgeRoutesPlugin({
  runServerProgram,
  logger,
  trustedProxyHops,
}: EdgeRoutesOptions) {
  return new Elysia({ name: 'edge-routes' }).group('/api/edge', (api) =>
    api.post(
      '/register',
      {
        body: EdgeRegisterBody,
        response: {
          200: EdgeRegisterResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          409: ErrorResponse,
          429: ErrorResponse,
        },
      },
      async ({ body, request, server }) => {
        const clientIp = resolveRateLimitSource(request, server, trustedProxyHops);
        const requestUrl = new URL(request.url);

        const program = Effect.gen(function* () {
          const config = yield* ServerConfigService;
          const edgeRegistry = yield* EdgeRegistryServiceTag;
          const rateLimitService = yield* RateLimitServiceTag;

          yield* enforceRateLimit(rateLimitService, [
            {
              key: `edge-register:ip:${clientIp}`,
              limit: REGISTER_IP_LIMIT,
              windowMs: REGISTER_RATE_LIMIT_WINDOW_MS,
            },
          ]);

          const authenticated = yield* authenticateEdgeRegistration({
            method: request.method,
            path: `${requestUrl.pathname}${requestUrl.search}`,
            edgeId: request.headers.get(EDGE_ID_HEADER),
            timestamp: request.headers.get(EDGE_TIMESTAMP_HEADER),
            nonce: request.headers.get(EDGE_NONCE_HEADER),
            authentication: request.headers.get(EDGE_AUTH_HEADER),
            payload: body,
            keys: config.edgeRegistrationKeys,
          });
          yield* edgeRegistry.claimRegistrationNonce(authenticated.edgeId, authenticated.nonce);
          if (!isCanonicalEdgeCertificateHash(body.certHash)) {
            return yield* Effect.fail(new EdgeCertHashInvalidError());
          }

          const canonicalEdgeUrl = normalizeEdgeWebTransportUrl(body.edgeWtUrl);
          if (
            !EDGE_ID_PATTERN.test(body.edgeId) ||
            !EDGE_ID_PATTERN.test(body.edgeRegion) ||
            canonicalEdgeUrl === null ||
            canonicalEdgeUrl !== body.edgeWtUrl ||
            !body.certHashes.includes(body.certHash) ||
            new Set(body.certHashes).size !== body.certHashes.length ||
            !body.certHashes.every(isCanonicalEdgeCertificateHash)
          ) {
            return yield* Effect.fail(new EdgeRegistrationInvalidError());
          }
          yield* edgeRegistry.registerEdge({
            edgeId: body.edgeId,
            edgeRegion: body.edgeRegion,
            edgeWtUrl: canonicalEdgeUrl,
            activeCertHash: body.certHash,
            certHashes: body.certHashes,
            updatedAt: yield* Clock.currentTimeMillis,
          });
          return { ok: true as const };
        });

        return runRouteEffect(runServerProgram, program, {
          logger,
          eventName: 'edge_register_failed',
          request,
          signal: request.signal,
          mapError: mapEdgeRegisterError,
        });
      },
    ),
  );
}

function mapEdgeRegisterError(error: unknown) {
  if (error instanceof RateLimitedError) {
    return status(STATUS_TOO_MANY_REQUESTS, { error: 'rate_limited' as const });
  }
  if (
    error instanceof EdgeRegistrationAuthenticationError ||
    error instanceof EdgeRegistrationReplayError
  ) {
    return status(STATUS_UNAUTHORIZED, { error: 'invalid edge registration authentication' });
  }
  if (error instanceof EdgeCertHashInvalidError) {
    return status(STATUS_BAD_REQUEST, { error: 'certHash must be base64 of 32 bytes' as const });
  }
  if (error instanceof EdgeRegistrationInvalidError) {
    return status(STATUS_BAD_REQUEST, { error: 'invalid edge registration' as const });
  }
  if (error instanceof EdgeRegistrationValidationError) {
    return status(STATUS_BAD_REQUEST, { error: 'invalid edge registration' as const });
  }
  if (error instanceof EdgeRegistrationConflictError) {
    return status(STATUS_CONFLICT, {
      error: 'edge id or URL is already owned by another live replica' as const,
    });
  }
  return null;
}
