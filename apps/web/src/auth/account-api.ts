import { isRecord, traceparentHeader } from '@merkur/shared';
import {
  AccountDeletionResponse,
  AuthEmailCodeResponse,
  AuthPolicyResponse,
  AuthResetCodeResponse,
  AuthResetStartResponse,
  AuthResetVerifyResponse,
  AuthSessionResponse,
  AuthStartResponse,
  BrowserSessionListResponse,
  BrowserSessionsRevokedResponse,
  DaemonLinkClaimInspectResponse,
  OkResponse,
} from '@merkur/shared/api-schema';
import { compileRequire } from '@merkur/shared/schema-check';
import type {
  AccountDeletionStatement,
  DaemonLinkApproval,
  DelegationRevocationStatement,
  UserDelegationCertificate,
} from '@merkur/shared/user-authorization';
import {
  parseDaemonLinkPublicClaim,
  USER_DELEGATION_LIFETIME_MS,
} from '@merkur/shared/user-authorization';

import { ApiError } from '../lib/api-error';
import type { UserRootEnvelope } from './user-root';

// The response types are the server's own schemas, under the names this app
// calls them by. Each response is checked against that schema where it is read.
export type {
  BrowserSessionRecord,
  PasswordResetDevice,
} from '@merkur/shared/api-schema';
export type AccountSessionResponse = AuthSessionResponse;
export type AuthenticationStartResponse = AuthStartResponse;
export type BrowserSessionsResponse = BrowserSessionListResponse;
export type DaemonLinkInspectResponse = DaemonLinkClaimInspectResponse;
export type PasswordResetProof = AuthResetVerifyResponse;
export type PasswordResetStartResponse = AuthResetStartResponse;
export type AuthPolicy = AuthPolicyResponse;

export interface RevocationAuthorization {
  readonly actorCertificate: UserDelegationCertificate;
  readonly revocation: DelegationRevocationStatement;
}

// Each reader returns the response as its schema's type, or throws its label
// with the first place the response is not what the schema says.
const asAuthPolicy = compileRequire(AuthPolicyResponse, 'Invalid authentication policy response');

const asEmailCodeSent = compileRequire(AuthEmailCodeResponse, 'Invalid email code response');

const asPasswordResetCode = compileRequire(
  AuthResetCodeResponse,
  'Invalid password reset code response',
);

const asPasswordResetProof = compileRequire(
  AuthResetVerifyResponse,
  'Invalid password reset verification response',
);

const asPasswordResetStart = compileRequire(
  AuthResetStartResponse,
  'Invalid password reset start response',
);

const asAccountSession = compileRequire(AuthSessionResponse, 'Invalid account session response');

const asAuthenticationStart = compileRequire(
  AuthStartResponse,
  'Invalid account authentication start response',
);

const asBrowserSessions = compileRequire(
  BrowserSessionListResponse,
  'Invalid browser sessions response',
);

const asBrowserSessionsRevoked = compileRequire(
  BrowserSessionsRevokedResponse,
  'Invalid browser-session revocation response',
);

const asAccountDeletion = compileRequire(
  AccountDeletionResponse,
  'Invalid account deletion response',
);

const asDaemonLinkInspection = compileRequire(
  DaemonLinkClaimInspectResponse,
  'Invalid daemon-link inspection response',
);

const asOk = compileRequire(OkResponse, 'Invalid mutation response');

export async function fetchAuthPolicy(signal?: AbortSignal): Promise<AuthPolicy> {
  return asAuthPolicy(await requestJson('/api/auth/policy', { method: 'GET', signal }));
}

/** Asks the server to mail the code a registration finish in this flow must carry. */
export async function requestEmailCode(flowId: string, signal?: AbortSignal): Promise<void> {
  const value = await requestJson('/api/auth/register/code', {
    method: 'POST',
    body: { flowId },
    signal,
  });

  asEmailCodeSent(value);
}

/**
 * Asks the server to mail `username` a password-reset code. The answer is a
 * flow id whether or not the address has an account.
 */
export async function requestPasswordResetCode(
  username: string,
  signal?: AbortSignal,
): Promise<string> {
  const value = await requestJson('/api/auth/reset/code', {
    method: 'POST',
    body: { username },
    signal,
  });

  return asPasswordResetCode(value).flowId;
}

/** Spends one guess at the mailed code; a match returns the proven reset. */
export async function verifyPasswordResetCode(
  flowId: string,
  emailCode: string,
  signal?: AbortSignal,
): Promise<PasswordResetProof> {
  const value = await requestJson('/api/auth/reset/verify', {
    method: 'POST',
    body: { flowId, emailCode },
    signal,
  });

  return asPasswordResetProof(value);
}

export async function startPasswordResetRequest(
  flowId: string,
  registrationRequest: string,
  signal?: AbortSignal,
): Promise<PasswordResetStartResponse> {
  const value = await requestJson('/api/auth/reset/start', {
    method: 'POST',
    body: { flowId, registrationRequest },
    signal,
  });
  const start = asPasswordResetStart(value);

  if (!hasDelegationLifetime(start)) throw new Error('Invalid password reset start response');

  return start;
}

export async function finishPasswordResetRequest(
  body: {
    readonly flowId: string;
    readonly registrationRecord: string;
    readonly rootPublicKey: string;
    readonly rootEnvelope: UserRootEnvelope;
    readonly delegationCertificate: UserDelegationCertificate;
  },
  signal?: AbortSignal,
): Promise<AccountSessionResponse> {
  return asAccountSession(
    await requestJson('/api/auth/reset/finish', {
      method: 'POST',
      body: { ...body, installed: isInstalledApp() },
      signal,
    }),
  );
}

export async function startAuthenticationRequest(
  username: string,
  startLoginRequestValue: string,
  registrationRequest: string,
  signal?: AbortSignal,
): Promise<AuthenticationStartResponse> {
  return requireOneFlow(
    asAuthenticationStart(
      await requestJson('/api/auth/start', {
        method: 'POST',
        body: {
          username,
          startLoginRequest: startLoginRequestValue,
          registrationRequest,
        },
        signal,
      }),
    ),
  );
}

export async function finishRegistrationRequest(
  body: {
    readonly flowId: string;
    /** The mailed code on an email-identity server; `null` on a username one. */
    readonly emailCode: string | null;
    readonly registrationRecord: string;
    readonly rootPublicKey: string;
    readonly rootEnvelope: UserRootEnvelope;
    readonly delegationCertificate: UserDelegationCertificate;
  },
  signal?: AbortSignal,
): Promise<AccountSessionResponse> {
  return asAccountSession(
    await requestJson('/api/auth/register/finish', {
      method: 'POST',
      body: { ...body, installed: isInstalledApp() },
      signal,
    }),
  );
}

export async function finishLoginRequest(
  flowId: string,
  finishLoginRequestValue: string,
  delegationCertificate: UserDelegationCertificate,
  signal?: AbortSignal,
): Promise<AccountSessionResponse> {
  return asAccountSession(
    await requestJson('/api/auth/login/finish', {
      method: 'POST',
      body: {
        flowId,
        finishLoginRequest: finishLoginRequestValue,
        delegationCertificate,
        installed: isInstalledApp(),
      },
      signal,
    }),
  );
}

/**
 * Whether this delegation is being issued to an installed app rather than a
 * tab. The one thing the sessions list shows that the server cannot derive:
 * display mode reaches no `User-Agent` on any engine.
 *
 * Reported once, at issuance, and never corrected afterwards — a session that
 * could rename itself later could rename one it does not own.
 */
function isInstalledApp(): boolean {
  return (
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(display-mode: standalone)').matches
  );
}

export async function refreshAccountSession(signal?: AbortSignal): Promise<AccountSessionResponse> {
  return asAccountSession(await requestJson('/api/auth/refresh', { method: 'POST', signal }));
}

export async function logoutAccountSession(
  authorization: RevocationAuthorization,
  signal?: AbortSignal,
): Promise<void> {
  asOk(
    await requestJson('/api/auth/logout', {
      method: 'POST',
      body: authorization,
      signal,
    }),
  );
}

export async function listBrowserSessions(
  accessToken: string,
  signal?: AbortSignal,
): Promise<BrowserSessionsResponse> {
  const value = await requestJson('/api/browser-sessions', {
    method: 'GET',
    accessToken,
    signal,
  });

  return asBrowserSessions(value);
}

export async function revokeBrowserSession(
  accessToken: string,
  delegationId: string,
  authorization: RevocationAuthorization,
  signal?: AbortSignal,
): Promise<void> {
  asOk(
    await requestJson(`/api/browser-sessions/${encodeURIComponent(delegationId)}`, {
      method: 'DELETE',
      accessToken,
      body: authorization,
      signal,
    }),
  );
}

export async function revokeOtherBrowserSessions(
  accessToken: string,
  authorization: RevocationAuthorization,
  signal?: AbortSignal,
): Promise<number> {
  const value = await requestJson('/api/browser-sessions/revoke-others', {
    method: 'POST',
    accessToken,
    body: authorization,
    signal,
  });

  return asBrowserSessionsRevoked(value).revoked;
}

/**
 * Asks for this account to be erased.
 *
 * `statement` is signed by the user root key, so the server can tell the owner
 * from anyone holding an access token. `revocation` names every active browser
 * delegation, this one included, signed by this delegation: it is what tells
 * the daemons to stop serving the account. Nothing is deleted yet: the reply is
 * the instant the purge falls due, and signing in before then calls it off.
 */
export async function scheduleAccountDeletionRequest(
  accessToken: string,
  statement: AccountDeletionStatement,
  revocation: RevocationAuthorization,
  signal?: AbortSignal,
): Promise<number> {
  const value = await requestJson('/api/account/deletion', {
    method: 'POST',
    accessToken,
    body: { statement, ...revocation },
    signal,
  });

  return asAccountDeletion(value).scheduledFor;
}

export async function inspectDaemonLinkClaim(
  accessToken: string,
  linkClaimId: string,
  signal?: AbortSignal,
): Promise<DaemonLinkInspectResponse> {
  const value = await requestJson(
    `/api/daemon-link/claims/${encodeURIComponent(linkClaimId)}/inspect`,
    {
      method: 'POST',
      accessToken,
      body: {},
      signal,
    },
  );
  // The schema settles every field, the nonce's encoding included. That the
  // claim's commitment matches its keys is checked as the claim they form.
  const { serverNonce, serverTimeMs, ...claim } = asDaemonLinkInspection(value);

  return { ...parseDaemonLinkPublicClaim(claim), serverNonce, serverTimeMs };
}

export async function approveDaemonLinkClaim(
  accessToken: string,
  linkClaimId: string,
  approval: DaemonLinkApproval,
  signal?: AbortSignal,
): Promise<void> {
  asOk(
    await requestJson(`/api/daemon-link/claims/${encodeURIComponent(linkClaimId)}/approve`, {
      method: 'POST',
      accessToken,
      body: approval,
      signal,
    }),
  );
}

interface RequestJsonOptions {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly body?: unknown;
  readonly accessToken?: string;
  readonly signal?: AbortSignal;
}

export async function changeAccountPasswordRequest(
  accessToken: string,
  body: {
    readonly flowId: string;
    readonly finishLoginRequest: string;
    readonly registrationRecord: string;
    readonly rootEnvelope: { readonly nonce: string; readonly ciphertext: string };
    readonly delegationCertificate: UserDelegationCertificate;
    readonly revocation: RevocationAuthorization['revocation'] | null;
  },
  signal?: AbortSignal,
): Promise<AccountSessionResponse> {
  return asAccountSession(
    await requestJson('/api/auth/password', {
      method: 'POST',
      accessToken,
      body,
      signal,
    }),
  );
}

async function requestJson(path: string, options: RequestJsonOptions): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(path, globalThis.location.origin), {
      method: options.method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...traceparentHeader(),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.accessToken === undefined
          ? {}
          : { Authorization: `Bearer ${options.accessToken}` }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const errorCode =
      isRecord(value) && typeof value.error === 'string' ? value.error : 'request_failed';
    const details =
      isRecord(value) && typeof value.details === 'string' ? value.details : undefined;
    throw new ApiError(response.status, errorCode, details);
  }
  return value;
}

/**
 * The schema settles each branch, the root key and its envelope included. What
 * it cannot say is checked here: that each branch offers a delegation of the
 * one lifetime, and that both branches belong to the same one-use flow.
 */
function requireOneFlow(start: AuthenticationStartResponse): AuthenticationStartResponse {
  const { login, registration } = start;

  if (!hasDelegationLifetime(login)) throw new Error('Invalid account login response');

  if (!hasDelegationLifetime(registration)) {
    throw new Error('Invalid account registration response');
  }

  if (
    login.flowId !== registration.flowId ||
    login.userId !== registration.userId ||
    login.delegationIssuedAt !== registration.delegationIssuedAt ||
    login.delegationExpiresAt !== registration.delegationExpiresAt
  ) {
    throw new Error('Invalid account authentication start response');
  }

  return start;
}

/** A delegation the server offers runs for exactly the one lifetime the daemons accept. */
function hasDelegationLifetime(offer: {
  readonly delegationIssuedAt: number;
  readonly delegationExpiresAt: number;
}): boolean {
  return offer.delegationExpiresAt - offer.delegationIssuedAt === USER_DELEGATION_LIFETIME_MS;
}
