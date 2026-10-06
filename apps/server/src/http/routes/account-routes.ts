import { Effect } from 'effect';
import { Elysia } from 'elysia';

import type { Logger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import { type AuthenticatedBrowser, AuthServiceTag } from '../../services/auth-service';
import { DaemonControlServiceTag } from '../../services/daemon-control-service';
import { ApiModels } from '../api-models';
import { authenticatedApiPlugin } from '../authenticated-api';
import { runRouteEffect } from '../effect-route';

interface AccountRoutesOptions {
  readonly runServerProgram: typeof runServerProgram;
  readonly authorizeRequest: (request: Request) => Promise<AuthenticatedBrowser | null>;
  readonly logger: Logger;
}

/**
 * Erasing an account, on the account holder's own authority.
 *
 * No operator stands in the way: the request carries a statement signed by the
 * user root key, which only the password unwraps, so an access token — stolen
 * or otherwise — is not enough to destroy an account.
 *
 * It is a POST rather than a DELETE because nothing is deleted here. The
 * account goes dormant and the purge falls due after a grace period, so what
 * this creates is a cancellable request; signing in during the grace period
 * calls it off.
 */
export function accountRoutesPlugin({
  runServerProgram,
  authorizeRequest,
  logger,
}: AccountRoutesOptions) {
  return new Elysia({ name: 'account-routes', normalize: false }).group('/api', (api) =>
    api.use(authenticatedApiPlugin({ authorizeRequest })).post(
      '/account/deletion',
      {
        body: ApiModels.AccountDeletionBody,
        response: {
          200: ApiModels.AccountDeletionResponse,
          400: ApiModels.ErrorResponse,
          401: ApiModels.ErrorResponse,
          503: ApiModels.ErrorResponse,
        },
      },
      async ({ body, request, userId, delegationId, delegationExpiresAt }) =>
        runRouteEffect(
          runServerProgram,
          Effect.gen(function* () {
            const service = yield* AuthServiceTag;
            const scheduledFor = yield* service.scheduleAccountDeletion(
              { userId, delegationId, delegationExpiresAt },
              body.statement,
              { actorCertificate: body.actorCertificate, revocation: body.revocation },
            );
            // Scheduling recorded a signed revocation of every delegation. Tell
            // the daemons now, so they stop serving this account for the whole
            // grace period rather than until a capability happens to expire.
            const control = yield* DaemonControlServiceTag;
            yield* control.flushUserDelegationRevocations(userId);
            return { scheduledFor };
          }),
          { logger, eventName: 'account_deletion_failed', request, signal: request.signal },
        ),
    ),
  );
}
