import { parseBearerToken } from '@merkur/shared';
import { Data, Effect } from 'effect';

import {
  type AuthenticatedBrowser,
  AuthServiceTag as AuthService,
  type AuthServiceTag,
} from '../services/auth-service';
import type { InfrastructureError } from '../services/errors';

class UnauthorizedError extends Data.TaggedError('UnauthorizedError')<{
  readonly message: string;
}> {}

export class UnauthorizedRequestError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'UnauthorizedRequestError';
  }
}

type RunServerProgram = <A, E>(
  program: Effect.Effect<A, E, AuthServiceTag>,
  options?: Effect.RunOptions,
) => Promise<A>;

function requireAuthorizedUser(
  request: Request,
): Effect.Effect<AuthenticatedBrowser, UnauthorizedError | InfrastructureError, AuthServiceTag> {
  return Effect.gen(function* () {
    const authService = yield* AuthService;
    const accessToken = parseBearerToken(request.headers.get('authorization'));
    if (accessToken === null) {
      return yield* new UnauthorizedError({
        message: 'Missing access token',
      });
    }

    const verified = yield* authService.verifyBearerToken(accessToken);
    if (verified === null) {
      return yield* new UnauthorizedError({
        message: 'Invalid access token',
      });
    }

    return verified;
  });
}

export function createAuthorizeRequest(
  runServerProgram: RunServerProgram,
): (request: Request) => Promise<AuthenticatedBrowser | null> {
  return async function authorizeRequest(request: Request): Promise<AuthenticatedBrowser | null> {
    try {
      return await runServerProgram(requireAuthorizedUser(request), {
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return null;
      }
      throw error;
    }
  };
}

interface AuthorizeRequestFn {
  readonly authorizeRequest: (request: Request) => Promise<AuthenticatedBrowser | null>;
}

export async function deriveAuthorizedBrowser({
  request,
  authorizeRequest,
}: AuthorizeRequestFn & { readonly request: Request }): Promise<AuthenticatedBrowser> {
  const browser = await authorizeRequest(request);
  if (browser === null) {
    throw new UnauthorizedRequestError();
  }
  return browser;
}
