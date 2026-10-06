import { Effect } from 'effect';
import { Elysia, status } from 'elysia';

import type { Logger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import { AuthError, type AuthenticatedBrowser, AuthServiceTag } from '../../services/auth-service';
import { DaemonControlServiceTag } from '../../services/daemon-control-service';
import { ApiModels } from '../api-models';
import { authenticatedApiPlugin } from '../authenticated-api';
import { runRouteEffect } from '../effect-route';

const STATUS_UNAUTHORIZED = 401;

interface BrowserSessionRoutesOptions {
  readonly runServerProgram: typeof runServerProgram;
  readonly authorizeRequest: (request: Request) => Promise<AuthenticatedBrowser | null>;
  readonly logger: Logger;
}

export function browserSessionRoutesPlugin({
  runServerProgram,
  authorizeRequest,
  logger,
}: BrowserSessionRoutesOptions) {
  return new Elysia({ name: 'browser-session-routes' })
    .use(authenticatedApiPlugin({ authorizeRequest }))
    .get(
      '/api/browser-sessions',
      { response: { 200: ApiModels.BrowserSessionListResponse, 401: ApiModels.ErrorResponse } },
      async ({ userId, delegationId, delegationExpiresAt, request }) => {
        return runRouteEffect(
          runServerProgram,
          Effect.gen(function* () {
            const service = yield* AuthServiceTag;
            return yield* service.listBrowserSessions({
              userId,
              delegationId,
              delegationExpiresAt,
            });
          }),
          { logger, eventName: 'browser_sessions_list_failed', request, signal: request.signal },
        );
      },
    )
    .delete(
      '/api/browser-sessions/:delegationId',
      {
        params: ApiModels.BrowserSessionParams,
        body: ApiModels.SignedRevocationBody,
        response: {
          200: ApiModels.LogoutResponse,
          401: ApiModels.ErrorResponse,
        },
      },
      async ({ body, params, userId, delegationId, delegationExpiresAt, request }) => {
        const result = await runRouteEffect(
          runServerProgram,
          Effect.gen(function* () {
            const service = yield* AuthServiceTag;
            yield* service.revokeBrowserSessions(
              { userId, delegationId, delegationExpiresAt },
              body,
              { kind: 'one', delegationId: params.delegationId },
            );
            const control = yield* DaemonControlServiceTag;
            yield* control.flushUserDelegationRevocations(userId);
          }),
          revocationRouteOptions(logger, request),
        );
        if (result !== undefined) return result;
        return { ok: true };
      },
    )
    .post(
      '/api/browser-sessions/revoke-others',
      {
        body: ApiModels.SignedRevocationBody,
        response: {
          200: ApiModels.BrowserSessionsRevokedResponse,
          401: ApiModels.ErrorResponse,
        },
      },
      async ({ body, userId, delegationId, delegationExpiresAt, request }) => {
        const revoked = await runRouteEffect(
          runServerProgram,
          Effect.gen(function* () {
            const service = yield* AuthServiceTag;
            const revoked = yield* service.revokeBrowserSessions(
              { userId, delegationId, delegationExpiresAt },
              body,
              { kind: 'others' },
            );
            const control = yield* DaemonControlServiceTag;
            yield* control.flushUserDelegationRevocations(userId);
            return revoked;
          }),
          revocationRouteOptions(logger, request),
        );
        if (typeof revoked !== 'number') return revoked;
        return { revoked };
      },
    );
}

function revocationRouteOptions(logger: Logger, request: Request) {
  return {
    logger,
    eventName: 'browser_session_revocation_failed',
    request,
    signal: request.signal,
    mapError(error: unknown) {
      return error instanceof AuthError
        ? status(STATUS_UNAUTHORIZED, { error: 'invalid_delegation' as const })
        : null;
    },
  } as const;
}
