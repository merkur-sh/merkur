import {
  decodeUserAuthorizationBytes,
  encodeUserAuthorizationBytes,
  equalBytes,
  USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
  USER_ROOT_INITIAL_EPOCH,
  type UserDelegationCertificate,
} from '@merkur/shared/user-authorization';

import { isApiError, markAccountSessionEstablished } from '../api';
import { loadE2eWasmModule } from '../lib/e2e-wasm-module';
import {
  type AccountSessionResponse,
  type AuthenticationStartResponse,
  type AuthPolicy,
  finishLoginRequest,
  finishRegistrationRequest,
  requestEmailCode,
  startAuthenticationRequest,
} from './account-api';
import {
  finishAccountLogin,
  finishAccountRegistration,
  startAccountLogin,
  startAccountRegistration,
} from './account-opaque';
import { createBrowserDelegation, validateStoredBrowserDelegation } from './browser-delegation';
import {
  clearBrowserDelegation,
  loadBrowserDelegation,
  saveBrowserDelegation,
  type UnlockedBrowserDelegation,
} from './delegation-vault';
import { requireValidAccountPassword } from './password-policy';
import {
  decryptUserRootSeed,
  deriveUserRootPublicKey,
  encryptUserRootSeed,
  generateUserRootSeed,
  type UserRootEnvelope,
} from './user-root';

export interface ActiveBrowserAccount {
  readonly username: string;
  readonly session: AccountSessionResponse;
  readonly certificate: UserDelegationCertificate;
  readonly rootPublicKey: string;
  readonly serverTimeReceiptMonotonicMs: number;
}

/**
 * A registration on an email-identity server, stopped until the code mailed to
 * `address` is entered. It holds the new account's delegate secret and root
 * public key; the password-derived export key and the root seed are already
 * wiped, because the root envelope was sealed before the code was requested.
 */
export interface PendingEmailRegistration {
  readonly kind: 'email-code';
  readonly address: string;
  /**
   * Finishes the registration. A wrong code rejects with the server's
   * `invalid_email_code` and leaves this pending for another try; any other
   * failure ends it, and the secrets it held are wiped.
   */
  submit(code: string, signal?: AbortSignal): Promise<ActiveBrowserAccount>;
  resend(signal?: AbortSignal): Promise<void>;
  /** Wipes what this holds. Idempotent. */
  cancel(): void;
}

export type BrowserAccountAuthentication =
  | { readonly kind: 'signed-in'; readonly account: ActiveBrowserAccount }
  | PendingEmailRegistration;

export async function authenticateBrowserAccount(
  username: string,
  password: string,
  identity: AuthPolicy['identity'],
  signal?: AbortSignal,
): Promise<BrowserAccountAuthentication> {
  requireValidAccountPassword(password);
  try {
    return await authenticateBrowserAccountAttempt(
      username,
      password,
      identity,
      signal,
      true,
      true,
    );
  } catch (error) {
    if (!(error instanceof RejectedReusableDelegationError)) throw error;
    // The OPAQUE login flow is one-use, so a server-rejected stored
    // certificate needs one fresh flow. Reuse a concurrently installed
    // replacement; otherwise mint a new certificate from the recovered root.
    return await authenticateBrowserAccountAttempt(
      username,
      password,
      identity,
      signal,
      !error.vaultEntryCleared,
      false,
    );
  }
}

async function authenticateBrowserAccountAttempt(
  username: string,
  password: string,
  identity: AuthPolicy['identity'],
  signal: AbortSignal | undefined,
  allowStoredDelegation: boolean,
  recoverRejectedStoredDelegation: boolean,
): Promise<BrowserAccountAuthentication> {
  const started = await startAuthenticationExchange(username, password, signal);
  const loginFinish = await finishAccountLogin(
    password,
    started.login.clientLoginState,
    started.server.login.loginResponse,
    started.server.login.userId,
    globalThis.location.origin,
    signal,
  );
  if (loginFinish === null) {
    return finishBrowserAccountRegistration(
      username,
      password,
      identity,
      started.registration.clientRegistrationState,
      started.server.registration,
      signal,
    );
  }
  return {
    kind: 'signed-in',
    account: await finishBrowserAccountLogin(
      username,
      started.server.login,
      loginFinish,
      signal,
      allowStoredDelegation,
      recoverRejectedStoredDelegation,
    ),
  };
}

async function startAuthenticationExchange(
  username: string,
  password: string,
  signal?: AbortSignal,
): Promise<{
  readonly login: Awaited<ReturnType<typeof startAccountLogin>>;
  readonly registration: Awaited<ReturnType<typeof startAccountRegistration>>;
  readonly server: AuthenticationStartResponse;
}> {
  const [login, registration] = await Promise.all([
    startAccountLogin(password),
    startAccountRegistration(password),
    // Every path through here derives, signs or checks a user-root credential.
    loadE2eWasmModule(),
  ]);
  const server = await startAuthenticationRequest(
    username,
    login.startLoginRequest,
    registration.registrationRequest,
    signal,
  );
  return { login, registration, server };
}

async function finishBrowserAccountRegistration(
  username: string,
  password: string,
  identity: AuthPolicy['identity'],
  clientRegistrationState: string,
  serverStart: AuthenticationStartResponse['registration'],
  signal?: AbortSignal,
): Promise<BrowserAccountAuthentication> {
  const opaqueFinish = await finishAccountRegistration(
    password,
    clientRegistrationState,
    serverStart.registrationResponse,
    serverStart.userId,
    globalThis.location.origin,
    signal,
  );
  // Sealed into the envelope before the code is requested: neither the export
  // key nor the root seed is needed again, however long the code takes to arrive.
  const root = await sealNewAccountRoot(opaqueFinish.exportKey, {
    userId: serverStart.userId,
    rootEpoch: USER_ROOT_INITIAL_EPOCH,
    issuedAt: serverStart.delegationIssuedAt,
    expiresAt: serverStart.delegationExpiresAt,
  });
  const wipe = () => root.wipe();

  const complete = async (
    emailCode: string | null,
    finishSignal: AbortSignal | undefined,
  ): Promise<ActiveBrowserAccount> => {
    const session = await finishRegistrationRequest(
      {
        flowId: serverStart.flowId,
        emailCode,
        registrationRecord: opaqueFinish.registrationRecord,
        rootPublicKey: root.rootPublicKeyEncoded,
        rootEnvelope: root.rootEnvelope,
        delegationCertificate: root.delegation.certificate,
      },
      finishSignal,
    );
    return adoptNewAccountRoot(username, session, root);
  };

  if (identity === 'username') {
    try {
      return { kind: 'signed-in', account: await complete(null, signal) };
    } finally {
      wipe();
    }
  }

  try {
    await requestEmailCode(serverStart.flowId, signal);
  } catch (error) {
    wipe();
    throw error;
  }
  let settled = false;
  return {
    kind: 'email-code',
    address: username,
    async submit(code, submitSignal) {
      if (settled) throw new Error('Email registration is no longer pending');
      try {
        const account = await complete(code, submitSignal);
        settled = true;
        wipe();
        return account;
      } catch (error) {
        // Only a wrong code leaves the server's flow alive for another try.
        if (!(isApiError(error) && error.code === 'invalid_email_code')) {
          settled = true;
          wipe();
        }
        throw error;
      }
    },
    async resend(resendSignal) {
      if (settled) throw new Error('Email registration is no longer pending');
      await requestEmailCode(serverStart.flowId, resendSignal);
    },
    cancel() {
      if (settled) return;
      settled = true;
      wipe();
    },
  };
}

/**
 * A freshly generated user root, sealed under an OPAQUE export key, with the
 * first delegation it signs. What is held here is public, except the delegate
 * seed, which `wipe` clears with the rest.
 */
export interface SealedAccountRoot {
  readonly rootPublicKey: Uint8Array;
  readonly rootPublicKeyEncoded: string;
  readonly rootEnvelope: UserRootEnvelope;
  readonly delegation: ReturnType<typeof createBrowserDelegation>;
  /** Idempotent. */
  wipe(): void;
}

/**
 * Generates a user root, signs this browser's delegation with it at `rootEpoch`
 * and seals the seed under `exportKey`. Both the export key and the seed are
 * wiped before this returns, on every path.
 */
export async function sealNewAccountRoot(
  exportKey: Uint8Array,
  delegation: {
    readonly userId: string;
    readonly rootEpoch: number;
    readonly issuedAt: number;
    readonly expiresAt: number;
  },
): Promise<SealedAccountRoot> {
  let rootSeed: Uint8Array | null = null;
  let rootPublicKey: Uint8Array | null = null;
  let created: ReturnType<typeof createBrowserDelegation> | null = null;
  try {
    rootSeed = generateUserRootSeed();
    rootPublicKey = deriveUserRootPublicKey(rootSeed);
    created = createBrowserDelegation(rootSeed, {
      userId: delegation.userId,
      serverOrigin: globalThis.location.origin,
      rootEpoch: delegation.rootEpoch,
      issuedAt: delegation.issuedAt,
      expiresAt: delegation.expiresAt,
    });
    const rootEnvelope = await encryptUserRootSeed(
      rootSeed,
      exportKey,
      delegation.userId,
      rootPublicKey,
    );
    const publicKey = rootPublicKey;
    const delegateSeed = created.delegateSeed;
    return {
      rootPublicKey: publicKey,
      rootPublicKeyEncoded: encodeUserAuthorizationBytes(publicKey),
      rootEnvelope,
      delegation: created,
      wipe() {
        publicKey.fill(0);
        delegateSeed.fill(0);
      },
    };
  } catch (error) {
    rootPublicKey?.fill(0);
    created?.delegateSeed.fill(0);
    throw error;
  } finally {
    exportKey.fill(0);
    rootSeed?.fill(0);
  }
}

/**
 * Installs the session a new root's first delegation was issued, storing the
 * delegation in this profile's vault in place of whatever it held.
 */
export async function adoptNewAccountRoot(
  username: string,
  session: AccountSessionResponse,
  root: SealedAccountRoot,
): Promise<ActiveBrowserAccount> {
  const { certificate, delegateSeed } = root.delegation;
  assertSessionMatchesCertificate(session, certificate);
  try {
    await saveBrowserDelegation(username, root.rootPublicKey, certificate, delegateSeed);
  } catch (error) {
    await clearBrowserDelegation({
      userId: certificate.userId,
      delegationId: certificate.delegationId,
    }).catch(() => undefined);
    throw error;
  }
  markAccountSessionEstablished();
  return {
    username,
    session,
    certificate,
    rootPublicKey: root.rootPublicKeyEncoded,
    serverTimeReceiptMonotonicMs: performance.now(),
  };
}

async function finishBrowserAccountLogin(
  username: string,
  serverStart: AuthenticationStartResponse['login'],
  opaqueFinish: Exclude<Awaited<ReturnType<typeof finishAccountLogin>>, null>,
  signal: AbortSignal | undefined,
  allowStoredDelegation: boolean,
  recoverRejectedStoredDelegation: boolean,
): Promise<ActiveBrowserAccount> {
  let rootPublicKey: Uint8Array | null = null;
  let rootSeed: Uint8Array | null = null;
  let ownedDelegation: UnlockedBrowserDelegation | null = null;
  let delegateSeed: Uint8Array | null = null;
  let certificate: UserDelegationCertificate | null = null;
  let vaultWritten = false;
  try {
    rootPublicKey = decodeUserAuthorizationBytes(
      serverStart.rootPublicKey,
      USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
      'user-root public key',
    );
    ownedDelegation = allowStoredDelegation
      ? await loadReusableBrowserDelegation(
          serverStart.userId,
          rootPublicKey,
          serverStart.rootEpoch,
          serverStart.delegationIssuedAt,
        )
      : null;
    if (ownedDelegation === null) {
      try {
        rootSeed = await decryptUserRootSeed(
          serverStart.rootEnvelope,
          opaqueFinish.exportKey,
          serverStart.userId,
          rootPublicKey,
        );
      } finally {
        opaqueFinish.exportKey.fill(0);
      }
      try {
        const createdDelegation = createBrowserDelegation(rootSeed, {
          userId: serverStart.userId,
          serverOrigin: globalThis.location.origin,
          rootEpoch: serverStart.rootEpoch,
          issuedAt: serverStart.delegationIssuedAt,
          expiresAt: serverStart.delegationExpiresAt,
        });
        certificate = createdDelegation.certificate;
        delegateSeed = createdDelegation.delegateSeed;
      } finally {
        rootSeed.fill(0);
      }
      await saveBrowserDelegation(username, rootPublicKey, certificate, delegateSeed);
      vaultWritten = true;
    } else {
      opaqueFinish.exportKey.fill(0);
      certificate = ownedDelegation.certificate;
    }
    const session = await finishLoginRequest(
      serverStart.flowId,
      opaqueFinish.finishLoginRequest,
      certificate,
      signal,
    );
    assertSessionMatchesCertificate(session, certificate);
    markAccountSessionEstablished();
    return {
      username,
      session,
      certificate,
      rootPublicKey: serverStart.rootPublicKey,
      serverTimeReceiptMonotonicMs: performance.now(),
    };
  } catch (error) {
    if (
      ownedDelegation !== null &&
      isApiError(error) &&
      error.status === 401 &&
      error.code === 'authentication_failed'
    ) {
      const vaultEntryCleared = await clearBrowserDelegation({
        userId: ownedDelegation.certificate.userId,
        delegationId: ownedDelegation.certificate.delegationId,
      });
      if (recoverRejectedStoredDelegation) {
        throw new RejectedReusableDelegationError(vaultEntryCleared);
      }
    } else if (vaultWritten && certificate !== null) {
      await clearBrowserDelegation({
        userId: serverStart.userId,
        delegationId: certificate.delegationId,
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    opaqueFinish.exportKey.fill(0);
    rootPublicKey?.fill(0);
    rootSeed?.fill(0);
    delegateSeed?.fill(0);
    ownedDelegation?.delegateSeed.fill(0);
    ownedDelegation?.rootPublicKey.fill(0);
  }
}

class RejectedReusableDelegationError extends Error {
  constructor(readonly vaultEntryCleared: boolean) {
    super('Stored browser delegation was rejected by the server');
    this.name = 'RejectedReusableDelegationError';
  }
}

export async function resumeBrowserAccount(
  session: AccountSessionResponse,
): Promise<ActiveBrowserAccount | null> {
  let unlocked: UnlockedBrowserDelegation | null;
  try {
    unlocked = await loadBrowserDelegation(session.userId);
  } catch {
    return null;
  }
  if (unlocked === null) return null;
  try {
    assertSessionMatchesCertificate(session, unlocked.certificate);
    return {
      username: unlocked.username,
      session,
      certificate: unlocked.certificate,
      rootPublicKey: encodeUserAuthorizationBytes(unlocked.rootPublicKey),
      serverTimeReceiptMonotonicMs: performance.now(),
    };
  } catch {
    return null;
  } finally {
    unlocked.delegateSeed.fill(0);
    unlocked.rootPublicKey.fill(0);
  }
}

export async function unlockActiveBrowserDelegation(
  account: ActiveBrowserAccount,
): Promise<UnlockedBrowserDelegation> {
  const unlocked = await loadBrowserDelegation(account.session.userId);
  if (unlocked === null) throw new Error('Browser delegation is unavailable');
  try {
    assertSessionMatchesCertificate(account.session, unlocked.certificate);
    return unlocked;
  } catch (error) {
    unlocked.delegateSeed.fill(0);
    unlocked.rootPublicKey.fill(0);
    throw error;
  }
}

export async function unlockUserRootForAccount(
  account: ActiveBrowserAccount,
  password: string,
  signal?: AbortSignal,
): Promise<{
  readonly rootSeed: Uint8Array;
  readonly rootPublicKey: Uint8Array;
  readonly rootEpoch: number;
}> {
  const started = await startAuthenticationExchange(account.username, password, signal);
  const serverStart = started.server.login;
  const opaqueFinish = await finishAccountLogin(
    password,
    started.login.clientLoginState,
    serverStart.loginResponse,
    serverStart.userId,
    globalThis.location.origin,
    signal,
  );
  if (opaqueFinish === null) throw new Error('Account authentication failed');
  let rootPublicKey: Uint8Array | null = null;
  let rootSeed: Uint8Array | null = null;
  try {
    rootPublicKey = decodeUserAuthorizationBytes(
      serverStart.rootPublicKey,
      USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
      'user-root public key',
    );
    assertRootUnlockMatchesAccount(
      account,
      serverStart.userId,
      serverStart.rootPublicKey,
      serverStart.rootEpoch,
    );
    rootSeed = await decryptUserRootSeed(
      serverStart.rootEnvelope,
      opaqueFinish.exportKey,
      serverStart.userId,
      rootPublicKey,
    );
    return { rootSeed, rootPublicKey, rootEpoch: serverStart.rootEpoch };
  } catch (error) {
    rootSeed?.fill(0);
    rootPublicKey?.fill(0);
    throw error;
  } finally {
    opaqueFinish.exportKey.fill(0);
  }
}

export function estimateAccountServerTime(account: ActiveBrowserAccount): number {
  const elapsedMs = performance.now() - account.serverTimeReceiptMonotonicMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error('Account server-time estimate is unavailable');
  }
  return Math.round(account.session.serverTimeMs + elapsedMs);
}

function assertRootUnlockMatchesAccount(
  account: ActiveBrowserAccount,
  userId: string,
  rootPublicKey: string,
  rootEpoch: number,
): void {
  if (
    userId !== account.session.userId ||
    rootPublicKey !== account.rootPublicKey ||
    rootEpoch !== account.certificate.rootEpoch
  ) {
    throw new Error('Password unlock returned a different user root');
  }
}

export function assertSessionMatchesCertificate(
  session: AccountSessionResponse,
  certificate: UserDelegationCertificate,
): void {
  if (
    session.userId !== certificate.userId ||
    session.delegationId !== certificate.delegationId ||
    session.delegationExpiresAt !== certificate.expiresAt ||
    certificate.serverOrigin !== globalThis.location.origin
  ) {
    throw new Error('Account session does not match the local browser delegation');
  }
}

async function loadReusableBrowserDelegation(
  userId: string,
  expectedRootPublicKey: Uint8Array,
  rootEpoch: number,
  serverTimeMs: number,
): Promise<UnlockedBrowserDelegation | null> {
  let unlocked: UnlockedBrowserDelegation | null;
  try {
    unlocked = await loadBrowserDelegation(userId);
  } catch {
    return null;
  }
  if (unlocked === null) return null;
  try {
    if (
      !equalBytes(unlocked.rootPublicKey, expectedRootPublicKey) ||
      unlocked.certificate.rootEpoch !== rootEpoch
    ) {
      throw new Error('Stored browser delegation belongs to a different user root');
    }
    validateStoredBrowserDelegation(
      unlocked.certificate,
      expectedRootPublicKey,
      userId,
      serverTimeMs,
    );
    return unlocked;
  } catch {
    unlocked.delegateSeed.fill(0);
    unlocked.rootPublicKey.fill(0);
    await clearBrowserDelegation({
      userId: unlocked.certificate.userId,
      delegationId: unlocked.certificate.delegationId,
    }).catch(() => undefined);
    return null;
  }
}
