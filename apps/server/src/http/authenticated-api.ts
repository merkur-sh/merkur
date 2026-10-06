import { Elysia } from 'elysia';
import { deriveAuthorizedBrowser } from '../middleware/authenticated-user';
import type { AuthenticatedBrowser } from '../services/auth-service';

interface AuthenticatedApiPluginOptions {
  readonly authorizeRequest: (request: Request) => Promise<AuthenticatedBrowser | null>;
}

/**
 * The thrown `UnauthorizedRequestError` is turned into `401 {"error":
 * "unauthorized"}` by `apiErrorPlugin`. Throwing rather than returning a status
 * keeps `userId` a plain `string` for every downstream handler instead of a
 * union each one would have to narrow.
 */
export function authenticatedApiPlugin({ authorizeRequest }: AuthenticatedApiPluginOptions) {
  return (
    new Elysia({ name: 'authenticated-api' })
      .decorate({ userId: '', delegationId: '', delegationExpiresAt: 0 })
      // Authenticate before validation. Elysia 2's derive runs after validation;
      // transform fills this request's fields or throws before any handler runs.
      .transform('plugin', async (context) => {
        const browser = await deriveAuthorizedBrowser({
          request: context.request,
          authorizeRequest,
        });
        context.userId = browser.userId;
        context.delegationId = browser.delegationId;
        context.delegationExpiresAt = browser.delegationExpiresAt;
      })
  );
}
