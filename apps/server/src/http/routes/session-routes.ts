import { isIpAddress } from '@merkur/shared';
import { Effect } from 'effect';
import { Elysia, status, t } from 'elysia';
import type { Logger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import type { AuthenticatedBrowser } from '../../services/auth-service';
import {
  type SessionCancellationError,
  type SessionRenewalError,
  type SessionRequestDiagnostics,
  type SessionRequestError,
  SessionServiceTag,
} from '../../services/session-service';
import { authenticatedApiPlugin } from '../authenticated-api';
import { type RequestIpSource, resolveClientIp } from '../client-ip';
import { runRouteEffect } from '../effect-route';

const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_CONFLICT = 409;
const STATUS_SERVICE_UNAVAILABLE = 503;
const SERVER_TIMING_HEADER = 'server-timing';

const SessionRequestBody = t.Object({
  daemonId: t.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }),
  browserNodeId: t.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }),
  delegationId: t.String({ minLength: 1, maxLength: 128 }),
  clientNonce: t.String({
    minLength: 43,
    maxLength: 43,
    pattern: '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$',
  }),
  encapsulationKey: t.String({
    minLength: 2_091,
    maxLength: 2_091,
    pattern: '^[A-Za-z0-9_-]{2090}[AEIMQUYcgkosw048]$',
  }),
  issuanceId: t.String({ minLength: 1, maxLength: 128 }),
  supersedesIssuanceId: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
});

const SessionRequestCancelBody = t.Object({
  issuanceId: t.String({ minLength: 1, maxLength: 128 }),
});

// The /sessions/request 200 body carries the exact edge relay coordinates;
// daemonId is the Noise prologue identity label.
const SessionRequestWithEdgeResponse = t.Object({
  daemonId: t.String({ minLength: 1 }),
  daemonIdentityPublicKey: t.String({
    minLength: 3_456,
    maxLength: 3_456,
    pattern: '^[A-Za-z0-9_-]{3456}$',
  }),
  daemonIdentityP256PublicKey: t.String({
    minLength: 87,
    maxLength: 87,
    pattern: '^[A-Za-z0-9_-]+$',
  }),
  daemonBinding: t.Any(),
  sessionToken: t.String({ minLength: 1 }),
  sessionTokenExpiresAtMs: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  sessionTokenExpiresInMs: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  sessionId: t.String({ minLength: 1 }),
  edgeWtUrl: t.String({ minLength: 1 }),
  edgeCertHashes: t.Array(t.String({ minLength: 1 }), { minItems: 1, maxItems: 2 }),
  edgeAttachTicket: t.String({ minLength: 35, maxLength: 35, pattern: '^[A-Za-z0-9_-]+$' }),
});

interface SessionRoutesOptions {
  readonly runServerProgram: typeof runServerProgram;
  readonly authorizeRequest: (request: Request) => Promise<AuthenticatedBrowser | null>;
  readonly logger: Logger;
  readonly trustedProxyHops: number;
}

function formatSessionRequestServerTiming(
  totalMs: number,
  timings: SessionRequestDiagnostics,
): string {
  const metrics = [`session;dur=${formatDuration(totalMs)}`];
  const append = (name: string, duration: number | undefined): void => {
    if (duration !== undefined) metrics.push(`${name};dur=${formatDuration(duration)}`);
  };
  append('issuance', timings.issuanceMs);
  append('prepare', timings.prepareMs);
  append('presence', timings.presenceMs);
  append('edge', timings.edgeLookupMs);
  append('delivery', timings.deliveryMs);
  return metrics.join(', ');
}

function formatDuration(durationMs: number): string {
  return Math.max(0, durationMs).toFixed(2);
}

/**
 * The browser's address as edge selection reads it: the same trusted-proxy
 * resolution as the rate-limit keys rather than the client-controlled end of
 * `X-Forwarded-For`.
 */
function extractBrowserIp(
  request: Request,
  server: RequestIpSource | null,
  trustedProxyHops: number,
): string | null {
  const resolved = resolveClientIp(request, server, trustedProxyHops);
  return isIpAddress(resolved) ? resolved : null;
}

export function sessionRoutesPlugin({
  runServerProgram,
  authorizeRequest,
  logger,
  trustedProxyHops,
}: SessionRoutesOptions) {
  return new Elysia({ name: 'session-routes' }).group('/api', (api) =>
    api
      .use(authenticatedApiPlugin({ authorizeRequest }))
      .post(
        '/sessions/renew',
        {
          body: t.Object({
            daemonId: t.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }),
            browserNodeId: t.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }),
            sessionId: t.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }),
            delegationId: t.String({ minLength: 1, maxLength: 128 }),
            commitment: t.String({
              minLength: 86,
              maxLength: 86,
              pattern: '^[A-Za-z0-9_-]{85}[AQgw]$',
            }),
            edgeWtUrl: t.String({ minLength: 1, maxLength: 2_048 }),
          }),
          response: {
            200: t.Object({
              sessionToken: t.String({ minLength: 1 }),
              sessionTokenExpiresInMs: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
              edgeCertHashes: t.Union([
                t.Array(t.String({ minLength: 1 }), { minItems: 1, maxItems: 2 }),
                t.Null(),
              ]),
            }),
            400: t.Object({ error: t.String() }),
            401: t.Object({ error: t.String() }),
            503: t.Object({ error: t.String() }),
          },
        },
        async ({ body, userId, delegationId, request }) => {
          // This capability grants no session by itself: the daemon also verifies
          // the live lineage MAC and the browser's delegated signature. No
          // issuance, session_start, cancellation, or edge allocation happens
          // here; the named edge's registration is only read for its hashes.
          const program = Effect.flatMap(SessionServiceTag, (sessions) =>
            sessions.renew({ userId, delegationId }, body),
          );
          return runRouteEffect(runServerProgram, program, {
            logger,
            eventName: 'session_renewal_failed',
            request,
            signal: request.signal,
            mapError: mapSessionRenewalError,
          });
        },
      )
      .post(
        '/sessions/request',
        {
          body: SessionRequestBody,
          response: {
            200: SessionRequestWithEdgeResponse,
            400: t.Object({ error: t.String() }),
            401: t.Object({ error: t.String() }),
            409: t.Object({ error: t.String() }),
            503: t.Object({ error: t.String() }),
          },
        },
        async ({ body, set, userId, delegationId, request, server }) => {
          const routeStartedAt = performance.now();
          const stageTimings: SessionRequestDiagnostics = {};
          const browserIp = extractBrowserIp(request, server, trustedProxyHops);

          const program = Effect.flatMap(SessionServiceTag, (sessions) =>
            sessions.request({ userId, delegationId }, body, browserIp, stageTimings),
          );

          const result = await runRouteEffect(runServerProgram, program, {
            logger,
            eventName: 'session_request_failed',
            request,
            signal: request.signal,
            mapError: mapSessionRequestError,
          });
          set.headers[SERVER_TIMING_HEADER] = formatSessionRequestServerTiming(
            performance.now() - routeStartedAt,
            stageTimings.requestSucceeded || stageTimings.sameUserPresenceEstablished
              ? stageTimings
              : {},
          );
          return result;
        },
      )
      .post(
        '/sessions/request/cancel',
        {
          body: SessionRequestCancelBody,
          response: {
            200: t.Object({ ok: t.Boolean() }),
            409: t.Object({ error: t.String() }),
            503: t.Object({ error: t.String() }),
          },
        },
        async ({ body, request, userId }) => {
          const program = Effect.flatMap(SessionServiceTag, (sessions) =>
            sessions.cancel(userId, body.issuanceId).pipe(Effect.as({ ok: true as const })),
          );

          return runRouteEffect(runServerProgram, program, {
            logger,
            eventName: 'session_request_cancel_failed',
            request,
            signal: request.signal,
            mapError: mapSessionCancelError,
          });
        },
      )
      .post(
        '/sessions/revoke-all',
        {
          response: {
            200: t.Object({ ok: t.Boolean() }),
          },
        },
        async ({ request, userId }) => {
          const program = Effect.flatMap(SessionServiceTag, (sessions) =>
            sessions.revokeAll(userId).pipe(Effect.as({ ok: true as const })),
          );

          // No mapper: every failure here is unexpected, so it is logged and
          // rethrown for `apiErrorPlugin` to answer as a 500.
          return runRouteEffect(runServerProgram, program, {
            logger,
            eventName: 'session_revoke_all_failed',
            request,
            signal: request.signal,
          });
        },
      ),
  );
}

function mapSessionRenewalError(error: SessionRenewalError) {
  switch (error._tag) {
    case 'DelegationMismatchError':
      return status(STATUS_UNAUTHORIZED, { error: 'delegation_mismatch' as const });
    case 'DaemonNotConnectedError':
      return status(STATUS_BAD_REQUEST, { error: 'daemon not connected' as const });
    case 'RedisError':
      return mapSessionCancelError(error);
    case 'InfrastructureError':
    case 'SessionIdentityStateError':
      return null;
    default:
      return assertUnreachable(error);
  }
}

function mapSessionRequestError(error: SessionRequestError) {
  switch (error._tag) {
    case 'DelegationMismatchError':
    case 'DaemonNotConnectedError':
    case 'InfrastructureError':
    case 'SessionIdentityStateError':
      return mapSessionRenewalError(error);
    case 'EdgeTemporarilyUnavailableError':
      return status(STATUS_SERVICE_UNAVAILABLE, { error: 'edge temporarily unavailable' as const });
    case 'SessionIssuanceConflictError':
      return status(STATUS_CONFLICT, { error: 'session_issuance_conflict' as const });
    case 'SessionIssuanceCancelledError':
      return status(STATUS_CONFLICT, { error: 'session_issuance_cancelled' as const });
    case 'SessionIssuanceExpiredError':
      return status(STATUS_CONFLICT, { error: 'session_issuance_expired' as const });
    case 'DaemonUnavailable':
    case 'StaleDaemonPresence':
    case 'ControlDeliveryTimeout':
    case 'ControlBackpressure':
    case 'ControlCommandRejected':
    case 'RedisError':
    case 'SessionIssuanceStateError':
      return mapSessionCancelError(error);
    default:
      return assertUnreachable(error);
  }
}

function mapSessionCancelError(error: SessionCancellationError) {
  switch (error._tag) {
    case 'DaemonUnavailable':
    case 'StaleDaemonPresence':
    case 'ControlDeliveryTimeout':
    case 'ControlBackpressure':
    case 'ControlCommandRejected':
      return status(STATUS_SERVICE_UNAVAILABLE, {
        error: 'failed to deliver session to daemon' as const,
      });
    case 'RedisError':
      return status(STATUS_SERVICE_UNAVAILABLE, {
        error: 'session coordination unavailable' as const,
      });
    case 'SessionIssuanceStateError':
      return null;
    default:
      return assertUnreachable(error);
  }
}

function assertUnreachable(error: never): never {
  throw error;
}
