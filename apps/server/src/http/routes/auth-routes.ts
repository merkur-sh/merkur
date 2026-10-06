import { Clock, Effect } from 'effect';
import { Elysia, status } from 'elysia';
import type { AuthIdentity } from '../../config';
import { errorLogContext, type Logger, logWithLoggerEffect } from '../../logger';
import { rejectCrossSiteCookieRequest } from '../../middleware/cookie-origin';
import type { runServerProgram } from '../../runtime';
import { normalizeAccountIdentifier } from '../../services/account-identifier';
import {
  AuthError,
  type AuthenticatedBrowser,
  AuthServiceTag,
  type AuthSessionResult,
} from '../../services/auth-service';
import { DaemonControlServiceTag } from '../../services/daemon-control-service';
import { PushNotificationServiceTag } from '../../services/push-notification-service';
import {
  enforceRateLimitFailClosed,
  RateLimitedError,
  type RateLimitReservation,
  RateLimitServiceTag,
  refundRateLimit,
} from '../../services/rate-limit-service';
import { RedisError } from '../../services/redis-service';
import { SessionServiceTag } from '../../services/session-service';
import { ApiModels } from '../api-models';
import { authenticatedApiPlugin } from '../authenticated-api';
import { parseBrowserClient } from '../browser-client';
import { type RequestIpSource, resolveClientIp, resolveRateLimitSource } from '../client-ip';
import { runRouteEffect } from '../effect-route';

const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_FORBIDDEN = 403;
const STATUS_CONFLICT = 409;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_SERVICE_UNAVAILABLE = 503;
const SET_COOKIE_HEADER = 'set-cookie';
const RETRY_AFTER_HEADER = 'retry-after';
const RATE_LIMIT_WINDOW_MS = 60_000;
const AUTH_IP_LIMIT = 60;
const AUTH_USERNAME_LIMIT = 10;
const REFRESH_IP_LIMIT = 120;
/**
 * Accounts one address may create per hour. Sign-up is open, and an account is
 * what a box waitlist entry, a device list and a stored password record hang
 * off, so creating them in bulk is the abuse this bounds. Only a finish that
 * actually creates an account spends a slot; see the registration route.
 */
const REGISTER_IP_LIMIT = 5;
const REGISTER_WINDOW_MS = 3_600_000;
/**
 * Codes one source address may request per hour, and codes one mailbox may be
 * sent per hour. The second is what stops the form being used to flood a
 * stranger's inbox: every request mails whoever owns the address typed, and
 * the start route alone would allow ten flows a minute for one name.
 */
const EMAIL_CODE_IP_LIMIT = 20;
const EMAIL_CODE_ADDRESS_LIMIT = 5;
const EMAIL_CODE_WINDOW_MS = 3_600_000;
/**
 * Wrong password-reset codes one account absorbs per day, across every flow
 * opened for it. A flow already dies after five guesses, but a new flow costs
 * only a mailed code, so per-flow counting alone would allow twenty-five
 * guesses an hour at a six-digit code. Counted per account, continuous
 * guessing succeeds less than once in five hundred years, and every day of it
 * mails the owner. The price is that someone can keep one account's reset form
 * locked; signing in with the password is untouched.
 */
const RESET_GUESS_LIMIT = 5;
const RESET_GUESS_WINDOW_MS = 86_400_000;

interface AuthRoutesOptions {
  readonly authorizeRequest: (request: Request) => Promise<AuthenticatedBrowser | null>;
  readonly runServerProgram: typeof runServerProgram;
  readonly logger: Logger;
  readonly publicOrigin: string;
  readonly trustedProxyHops: number;
  readonly identity: AuthIdentity;
  readonly allowRegistration: boolean;
}

export function authRoutesPlugin({
  authorizeRequest,
  runServerProgram,
  logger,
  publicOrigin,
  trustedProxyHops,
  identity,
  allowRegistration,
}: AuthRoutesOptions) {
  function rejectInvalidCookieRequest(request: Request) {
    return rejectCrossSiteCookieRequest(request, publicOrigin);
  }

  function rateLimit(
    request: Request,
    server: RequestIpSource | null,
    operation: string,
    username?: string,
  ) {
    const clientIp = resolveRateLimitSource(request, server, trustedProxyHops);
    const limits = [
      {
        key: `auth:${operation}:ip:${clientIp}`,
        limit: operation === 'refresh' ? REFRESH_IP_LIMIT : AUTH_IP_LIMIT,
        windowMs: RATE_LIMIT_WINDOW_MS,
      },
    ];
    // Keyed on the spelling the service stores, so two spellings of one
    // address share a budget. A name that does not normalize is refused by the
    // service right after; the per-address limit still applies to it.
    const account = username === undefined ? null : normalizeAccountIdentifier(identity, username);
    if (account !== null) {
      limits.push({
        key: `auth:${operation}:user:${account}`,
        limit: AUTH_USERNAME_LIMIT,
        windowMs: RATE_LIMIT_WINDOW_MS,
      });
    }
    return Effect.gen(function* () {
      const service = yield* RateLimitServiceTag;
      return yield* enforceRateLimitFailClosed(service, limits);
    });
  }

  function registrationLimit(request: Request, server: RequestIpSource | null) {
    const clientIp = resolveRateLimitSource(request, server, trustedProxyHops);
    return Effect.gen(function* () {
      const service = yield* RateLimitServiceTag;
      return yield* enforceRateLimitFailClosed(service, [
        {
          key: `auth:register:ip:${clientIp}`,
          limit: REGISTER_IP_LIMIT,
          windowMs: REGISTER_WINDOW_MS,
        },
      ]);
    });
  }

  /**
   * Hand back slots consumed by an attempt that turned out to be legitimate.
   *
   * Only the password-verifying path does this. `start` succeeds for any known
   * username without proving anything, and register/refresh guard account
   * creation and token reuse rather than guessing, so those keep counting
   * attempts — the stricter direction.
   */
  function refundRateLimitReservations(reservations: ReadonlyArray<RateLimitReservation>) {
    return Effect.gen(function* () {
      const service = yield* RateLimitServiceTag;
      yield* refundRateLimit(service, reservations);
    });
  }

  function emailCodeIpLimit(request: Request, server: RequestIpSource | null) {
    const clientIp = resolveRateLimitSource(request, server, trustedProxyHops);
    return Effect.gen(function* () {
      const service = yield* RateLimitServiceTag;
      return yield* enforceRateLimitFailClosed(service, [
        {
          key: `auth:code:ip:${clientIp}`,
          limit: EMAIL_CODE_IP_LIMIT,
          windowMs: EMAIL_CODE_WINDOW_MS,
        },
      ]);
    });
  }

  function emailCodeAddressLimit(recipient: string) {
    return Effect.gen(function* () {
      const service = yield* RateLimitServiceTag;
      return yield* enforceRateLimitFailClosed(service, [
        {
          key: `auth:code:addr:${recipient}`,
          limit: EMAIL_CODE_ADDRESS_LIMIT,
          windowMs: EMAIL_CODE_WINDOW_MS,
        },
      ]);
    });
  }

  /**
   * Password reset exists under email identity only, and the mailbox is its
   * whole authority, so every step is budgeted: code mail spends the sign-up
   * form's per-source and per-mailbox limits, and guesses at a code are counted
   * here, per account.
   */
  function resetGuessLimit(userId: string) {
    return Effect.gen(function* () {
      const service = yield* RateLimitServiceTag;
      return yield* enforceRateLimitFailClosed(service, [
        {
          key: `auth:reset:guess:${userId}`,
          limit: RESET_GUESS_LIMIT,
          windowMs: RESET_GUESS_WINDOW_MS,
        },
      ]);
    });
  }

  // The same for every caller and every account, so it names nothing: the
  // form reads it once to know whether to ask for a username or an address.
  const policy = { identity, registration: allowRegistration } as const;

  return new Elysia({ name: 'auth-routes' })
    .get('/api/auth/policy', { response: { 200: ApiModels.AuthPolicyResponse } }, () => policy)
    .post(
      '/api/auth/register/code',
      {
        body: ApiModels.AuthEmailCodeBody,
        response: {
          200: ApiModels.AuthEmailCodeResponse,
          400: ApiModels.ErrorResponse,
          403: ApiModels.ErrorResponse,
          429: ApiModels.ErrorResponse,
          503: ApiModels.ErrorResponse,
        },
      },
      async ({ body, request, server, set }) => {
        const rejected = rejectInvalidCookieRequest(request);
        if (rejected !== null) return rejected;
        const program = Effect.gen(function* () {
          yield* emailCodeIpLimit(request, server);
          const service = yield* AuthServiceTag;
          yield* service.requestEmailCode(body.flowId, emailCodeAddressLimit);
          return { sent: true } as const;
        });
        return runRouteEffect(runServerProgram, program, routeOptions(logger, set, request));
      },
    )
    .post(
      '/api/auth/reset/code',
      {
        body: ApiModels.AuthResetCodeBody,
        response: {
          200: ApiModels.AuthResetCodeResponse,
          400: ApiModels.ErrorResponse,
          403: ApiModels.ErrorResponse,
          429: ApiModels.ErrorResponse,
          503: ApiModels.ErrorResponse,
        },
      },
      async ({ body, request, server, set }) => {
        const rejected = rejectInvalidCookieRequest(request);
        if (rejected !== null) return rejected;
        const program = Effect.gen(function* () {
          yield* emailCodeIpLimit(request, server);
          yield* rateLimit(request, server, 'reset', body.username);
          const service = yield* AuthServiceTag;
          const flowId = yield* service.requestPasswordResetCode(
            body.username,
            emailCodeAddressLimit,
          );
          return { flowId };
        });
        return runRouteEffect(runServerProgram, program, routeOptions(logger, set, request));
      },
    )
    .post(
      '/api/auth/reset/verify',
      {
        body: ApiModels.AuthResetVerifyBody,
        response: {
          200: ApiModels.AuthResetVerifyResponse,
          400: ApiModels.ErrorResponse,
          403: ApiModels.ErrorResponse,
          429: ApiModels.ErrorResponse,
          503: ApiModels.ErrorResponse,
        },
      },
      async ({ body, request, server, set }) => {
        const rejected = rejectInvalidCookieRequest(request);
        if (rejected !== null) return rejected;
        const program = Effect.gen(function* () {
          yield* rateLimit(request, server, 'reset-verify');
          const service = yield* AuthServiceTag;
          const verified = yield* service.verifyPasswordResetCode(
            body.flowId,
            body.emailCode,
            resetGuessLimit,
          );
          // A correct code was no guess, so it does not spend the account's budget.
          yield* refundRateLimitReservations(verified.admitted);
          return { flowId: verified.flowId, devices: [...verified.devices] };
        });
        return runRouteEffect(runServerProgram, program, routeOptions(logger, set, request));
      },
    )
    .post(
      '/api/auth/reset/start',
      {
        body: ApiModels.AuthResetStartBody,
        response: {
          200: ApiModels.AuthResetStartResponse,
          400: ApiModels.ErrorResponse,
          403: ApiModels.ErrorResponse,
          429: ApiModels.ErrorResponse,
          503: ApiModels.ErrorResponse,
        },
      },
      async ({ body, request, server, set }) => {
        const rejected = rejectInvalidCookieRequest(request);
        if (rejected !== null) return rejected;
        const program = Effect.gen(function* () {
          yield* rateLimit(request, server, 'reset-start');
          const service = yield* AuthServiceTag;
          return yield* service.startPasswordReset(body.flowId, body.registrationRequest);
        });
        return runRouteEffect(runServerProgram, program, routeOptions(logger, set, request));
      },
    )
    .post(
      '/api/auth/reset/finish',
      {
        body: ApiModels.AuthResetFinishBody,
        response: {
          200: ApiModels.AuthSessionResponse,
          400: ApiModels.ErrorResponse,
          401: ApiModels.ErrorResponse,
          403: ApiModels.ErrorResponse,
          429: ApiModels.ErrorResponse,
          503: ApiModels.ErrorResponse,
        },
      },
      async ({ body, request, server, set }) => {
        const rejected = rejectInvalidCookieRequest(request);
        if (rejected !== null) return rejected;
        const program = Effect.gen(function* () {
          yield* rateLimit(request, server, 'reset-finish');
          const service = yield* AuthServiceTag;
          const session = yield* service.finishPasswordReset({
            ...body,
            client: parseBrowserClient(request.headers, body.installed),
          });
          // The delegations are gone from the database, so no new session can be
          // issued for them; this is what makes the daemons drop the live ones
          // now. The reset has committed either way, so a failure here is
          // reported, not returned.
          const sessions = yield* SessionServiceTag;
          yield* sessions.revokeAll(session.userId).pipe(
            Effect.catch((error) =>
              logWithLoggerEffect(logger, 'error', 'password_reset_session_revocation_failed', {
                userId: session.userId,
                ...errorLogContext(error),
              }),
            ),
          );
          return session;
        });
        const result = await runRouteEffect(
          runServerProgram,
          program,
          routeOptions(logger, set, request),
        );
        return respondWithAuthSession(result, set);
      },
    )
    .post(
      '/api/auth/start',
      {
        body: ApiModels.AuthStartBody,
        response: {
          200: ApiModels.AuthStartResponse,
          400: ApiModels.ErrorResponse,
          403: ApiModels.ErrorResponse,
          429: ApiModels.ErrorResponse,
          503: ApiModels.ErrorResponse,
        },
      },
      async ({ body, request, server, set }) => {
        const rejected = rejectInvalidCookieRequest(request);
        if (rejected !== null) return rejected;
        const program = Effect.gen(function* () {
          yield* rateLimit(request, server, 'start', body.username);
          const service = yield* AuthServiceTag;
          return yield* service.startAuth(
            body.username,
            body.startLoginRequest,
            body.registrationRequest,
          );
        });
        return runRouteEffect(runServerProgram, program, routeOptions(logger, set, request));
      },
    )
    .post(
      '/api/auth/register/finish',
      {
        body: ApiModels.AuthRegisterFinishBody,
        response: {
          200: ApiModels.AuthSessionResponse,
          400: ApiModels.ErrorResponse,
          401: ApiModels.ErrorResponse,
          403: ApiModels.ErrorResponse,
          409: ApiModels.ErrorResponse,
          429: ApiModels.ErrorResponse,
          503: ApiModels.ErrorResponse,
        },
      },
      async ({ body, request, server, set }) => {
        const rejected = rejectInvalidCookieRequest(request);
        if (rejected !== null) return rejected;
        const program = Effect.gen(function* () {
          yield* rateLimit(request, server, 'finish');
          // The browser also lands here after a wrong password on an existing
          // account, so the creation slot is handed back on any failure: only a
          // finish that creates an account counts against the hourly limit.
          const creation = yield* registrationLimit(request, server);
          const service = yield* AuthServiceTag;
          return yield* service
            .finishRegistration({
              ...body,
              client: parseBrowserClient(request.headers, body.installed),
            })
            .pipe(Effect.tapError(() => refundRateLimitReservations(creation)));
        });
        const result = await runRouteEffect(
          runServerProgram,
          program,
          routeOptions(logger, set, request),
        );
        return respondWithAuthSession(result, set);
      },
    )
    .post(
      '/api/auth/login/finish',
      {
        body: ApiModels.AuthLoginFinishBody,
        response: {
          200: ApiModels.AuthSessionResponse,
          400: ApiModels.ErrorResponse,
          401: ApiModels.ErrorResponse,
          403: ApiModels.ErrorResponse,
          409: ApiModels.ErrorResponse,
          429: ApiModels.ErrorResponse,
          503: ApiModels.ErrorResponse,
        },
      },
      async ({ body, request, server, set }) => {
        const rejected = rejectInvalidCookieRequest(request);
        if (rejected !== null) return rejected;
        const program = Effect.gen(function* () {
          const reservations = yield* rateLimit(request, server, 'finish');
          const service = yield* AuthServiceTag;
          const session = yield* service.finishLogin({
            ...body,
            client: parseBrowserClient(request.headers, body.installed),
          });
          // The session is issued and the refresh-token row is written, so this
          // attempt was legitimate and must not spend the guessing budget. The
          // refund never fails the request; a Redis problem just keeps the count.
          yield* refundRateLimitReservations(reservations);
          return session;
        }).pipe(
          Effect.tapError((error) => {
            if (
              !(error instanceof AuthError) ||
              error.code !== 'invalid_credentials' ||
              error.userId === undefined
            )
              return Effect.void;
            const userId = error.userId;
            return Effect.gen(function* () {
              const service = yield* PushNotificationServiceTag;
              const occurredAt = yield* Clock.currentTimeMillis;
              yield* service.notifyFailedSignIn({
                userId,
                occurredAt,
                clientIp: resolveClientIp(request, server, trustedProxyHops),
              });
            }).pipe(
              Effect.catch((notificationError) =>
                logWithLoggerEffect(logger, 'warn', 'failed_sign_in_notification_failed', {
                  userId,
                  ...errorLogContext(notificationError),
                }),
              ),
            );
          }),
        );
        const result = await runRouteEffect(
          runServerProgram,
          program,
          routeOptions(logger, set, request),
        );
        return respondWithAuthSession(result, set);
      },
    )
    .post(
      '/api/auth/refresh',
      {
        response: {
          200: ApiModels.AuthSessionResponse,
          401: ApiModels.ErrorResponse,
          403: ApiModels.ErrorResponse,
          429: ApiModels.ErrorResponse,
          503: ApiModels.ErrorResponse,
        },
      },
      async ({ request, server, set }) => {
        const rejected = rejectInvalidCookieRequest(request);
        if (rejected !== null) return rejected;
        const program = Effect.gen(function* () {
          yield* rateLimit(request, server, 'refresh');
          const service = yield* AuthServiceTag;
          return yield* service.refresh(request.headers.get('cookie'));
        });
        const result = await runRouteEffect(
          runServerProgram,
          program,
          routeOptions(logger, set, request),
        );
        if (result === null) {
          return status(STATUS_UNAUTHORIZED, { error: 'invalid_refresh_token' as const });
        }
        return respondWithAuthSession(result, set);
      },
    )
    .post(
      '/api/auth/logout',
      {
        body: ApiModels.SignedRevocationBody,
        response: {
          200: ApiModels.LogoutResponse,
          400: ApiModels.ErrorResponse,
          401: ApiModels.ErrorResponse,
          403: ApiModels.ErrorResponse,
          503: ApiModels.ErrorResponse,
        },
      },
      async ({ body, request, set }) => {
        const rejected = rejectInvalidCookieRequest(request);
        if (rejected !== null) return rejected;
        const clearCookieHeader = await runRouteEffect(
          runServerProgram,
          Effect.gen(function* () {
            const service = yield* AuthServiceTag;
            const clearCookieHeader = yield* service.logout(request.headers.get('cookie'), body);
            const control = yield* DaemonControlServiceTag;
            yield* control.flushUserDelegationRevocations(body.actorCertificate.userId);
            return clearCookieHeader;
          }),
          routeOptions(logger, set, request),
        );
        if (typeof clearCookieHeader !== 'string') return clearCookieHeader;
        set.headers[SET_COOKIE_HEADER] = clearCookieHeader;
        return { ok: true };
      },
    )
    .group('/api/auth', (api) =>
      api.use(authenticatedApiPlugin({ authorizeRequest })).post(
        '/password',
        {
          body: ApiModels.AuthPasswordChangeBody,
          response: {
            200: ApiModels.AuthSessionResponse,
            400: ApiModels.ErrorResponse,
            401: ApiModels.ErrorResponse,
            403: ApiModels.ErrorResponse,
            429: ApiModels.ErrorResponse,
            503: ApiModels.ErrorResponse,
          },
        },
        async ({ body, request, server, set, userId, delegationId, delegationExpiresAt }) => {
          const rejected = rejectInvalidCookieRequest(request);
          if (rejected !== null) return rejected;
          const result = await runRouteEffect(
            runServerProgram,
            Effect.gen(function* () {
              const reservations = yield* rateLimit(request, server, 'finish');
              const service = yield* AuthServiceTag;
              const session = yield* service.changePassword(
                { userId, delegationId, delegationExpiresAt },
                body,
              );
              yield* refundRateLimitReservations(reservations);
              const control = yield* DaemonControlServiceTag;
              yield* control.flushUserDelegationRevocations(userId);
              return session;
            }),
            routeOptions(logger, set, request),
          );
          return respondWithAuthSession(result, set);
        },
      ),
    );
}

function routeOptions(logger: Logger, set: { headers: Record<string, unknown> }, request: Request) {
  return {
    logger,
    eventName: 'auth_request_failed',
    request,
    signal: request.signal,
    mapError(error: unknown) {
      if (error instanceof RateLimitedError) {
        set.headers[RETRY_AFTER_HEADER] = String(Math.ceil(error.retryAfterMs / 1_000));
        return status(STATUS_TOO_MANY_REQUESTS, { error: 'rate_limited' as const });
      }
      if (error instanceof RedisError) {
        return status(STATUS_SERVICE_UNAVAILABLE, { error: 'unavailable' as const });
      }
      if (error instanceof AuthError) {
        switch (error.code) {
          case 'invalid_credentials':
          case 'invalid_delegation':
            return status(STATUS_UNAUTHORIZED, { error: 'authentication_failed' as const });
          case 'delegation_limit':
            return status(STATUS_CONFLICT, { error: 'authentication_failed' as const });
          case 'invalid_flow':
          case 'invalid_request':
            return status(STATUS_BAD_REQUEST, { error: 'authentication_failed' as const });
          case 'invalid_email_code':
            return status(STATUS_BAD_REQUEST, { error: 'invalid_email_code' as const });
          case 'registration_closed':
            return status(STATUS_FORBIDDEN, { error: 'registration_closed' as const });
          case 'email_not_accepted':
            return status(STATUS_FORBIDDEN, { error: 'email_not_accepted' as const });
        }
      }
      return null;
    },
  } as const;
}

function respondWithAuthSession<T>(
  value: T,
  set: { headers: Record<string, unknown> },
):
  | T
  | {
      readonly accessToken: string;
      readonly userId: string;
      readonly delegationId: string;
      readonly delegationExpiresAt: number;
      readonly serverTimeMs: number;
      readonly deletionCancelled: boolean;
    } {
  if (!isAuthSessionResult(value)) return value;
  set.headers[SET_COOKIE_HEADER] = value.refreshCookieHeader;
  return {
    accessToken: value.accessToken,
    userId: value.userId,
    delegationId: value.delegationId,
    delegationExpiresAt: value.delegationExpiresAt,
    serverTimeMs: value.serverTimeMs,
    deletionCancelled: value.deletionCancelled,
  };
}

function isAuthSessionResult(value: unknown): value is AuthSessionResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'accessToken' in value &&
    typeof value.accessToken === 'string' &&
    'userId' in value &&
    typeof value.userId === 'string' &&
    'delegationId' in value &&
    typeof value.delegationId === 'string' &&
    'delegationExpiresAt' in value &&
    typeof value.delegationExpiresAt === 'number' &&
    'serverTimeMs' in value &&
    typeof value.serverTimeMs === 'number' &&
    'refreshCookieHeader' in value &&
    typeof value.refreshCookieHeader === 'string' &&
    'deletionCancelled' in value &&
    typeof value.deletionCancelled === 'boolean'
  );
}
