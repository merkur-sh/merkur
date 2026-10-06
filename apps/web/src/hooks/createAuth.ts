import { createLogger } from '@merkur/logger';
import { createSignal } from 'solid-js';
import { isApiError, refreshAccessToken, retireAccountRefreshCredential } from '../api';
import {
  type AccountSessionResponse,
  type AuthPolicy,
  fetchAuthPolicy,
  logoutAccountSession,
  type RevocationAuthorization,
} from '../auth/account-api';
import {
  type ActiveBrowserAccount,
  authenticateBrowserAccount,
  estimateAccountServerTime,
  type PendingEmailRegistration,
  resumeBrowserAccount,
  unlockActiveBrowserDelegation,
} from '../auth/account-workflow';
import { createBrowserRevocation } from '../auth/browser-delegation';
import {
  type BrowserDelegationIdentity,
  clearBrowserDelegation,
  hasBrowserDelegation,
  type UnlockedBrowserDelegation,
} from '../auth/delegation-vault';
import { accountPasswordPolicyError } from '../auth/password-policy';
import { beginPasswordReset, type PasswordReset } from '../auth/password-reset';
import {
  clearLogoutTombstone,
  retryPendingLogout,
  storeLogoutTombstone,
} from '../auth/revocation-outbox';

// The server gives one answer for a new name and for a wrong password on an
// existing one, so each text has to fit both readings.
const AUTH_FEEDBACK = {
  username: 'Unable to continue. Check your username and password, then try again.',
  email: 'Unable to continue. Check your email and password, then try again.',
} as const;
const REGISTRATION_CLOSED_FEEDBACK = {
  username:
    'Unable to continue. Check your username and password; this server is not accepting new accounts.',
  email:
    'Unable to continue. Check your email and password; this server is not accepting new accounts.',
} as const;
const EMAIL_NOT_ACCEPTED_FEEDBACK =
  'Merkur cannot create an account with this email address. Use a different address.';
const EMAIL_CODE_FEEDBACK = 'That code is not right. Check the latest email, then try again.';
const EMAIL_CODE_EXPIRED_FEEDBACK = 'That code has expired. Start again to get a new one.';
const RESET_ADDRESS_FEEDBACK = 'Enter the email address of your account, then try again.';
const RESET_EXPIRED_FEEDBACK = 'This password reset has expired. Start again to get a new code.';
const RESET_RATE_LIMITED_FEEDBACK = 'Too many attempts. Try again later.';
const RESET_REFUSED_FEEDBACK = 'This account’s password cannot be reset.';
const NETWORK_FEEDBACK = 'Unable to reach Merkur. Check your connection, then try again.';
const RATE_LIMITED_FEEDBACK = 'Too many attempts. Wait a moment, then try again.';
const UNAVAILABLE_FEEDBACK = 'Authentication is temporarily unavailable. Try again shortly.';
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_SERVICE_UNAVAILABLE = 503;

const logger = createLogger('web');

interface CreateAuthOptions {
  /**
   * Show the login screen. Pending state is carried by `authPending`. Resolves
   * once whatever was showing has left the screen.
   */
  enterAuth(): Promise<void>;
  /**
   * The signed-in state is over and its screen is gone: drop what the shell
   * was showing. Runs after `enterAuth` has resolved, never before, so the
   * shell leaves whole.
   */
  endSignedInState(): void;
  setAccessToken(next: string | null): void;
  setAccount(next: ActiveBrowserAccount | null): void;
  getAccount(): ActiveBrowserAccount | null;
  loadDevices(token: string, userId: string): Promise<void>;
  readonly browserDelegationStore?: BrowserDelegationStore;
}

interface BrowserDelegationStore {
  /** Whether a complete delegation record is stored, for any account. */
  has(): Promise<boolean>;
  unlock(account: ActiveBrowserAccount): Promise<UnlockedBrowserDelegation>;
  clear(expected?: BrowserDelegationIdentity): Promise<unknown>;
}

export function createAuth(options: CreateAuthOptions): {
  authError: () => string;
  authPending: () => boolean;
  /** What the form asks for; `null` until the server has said. */
  authIdentity: () => AuthPolicy['identity'] | null;
  /** The address a sign-up code was mailed to, while the form waits for it. */
  authCodeAddress: () => string | null;
  /** The password reset in progress and the step it is on; `null` when there is none. */
  authReset: () => PasswordReset | null;
  attemptSessionRefresh(): Promise<void>;
  /** Reads the policy the form needs, once; the sign-in screen calls it when shown. */
  loadAuthPolicy(): Promise<void>;
  onAuthSubmit(event: SubmitEvent): Promise<void>;
  onAuthCodeSubmit(event: SubmitEvent): Promise<void>;
  onAuthCodeResend(): Promise<void>;
  onAuthCodeCancel(): void;
  /** Starts a password reset for the address typed into the sign-in form. */
  onAuthResetStart(address: string): Promise<void>;
  onAuthResetCodeSubmit(event: SubmitEvent): Promise<void>;
  onAuthResetCodeResend(): Promise<void>;
  onAuthResetConfirm(event: SubmitEvent): Promise<void>;
  onAuthResetCancel(): void;
  onLogout(): Promise<void>;
  onSessionRejected(): void;
} {
  const [authError, setAuthError] = createSignal('');
  const [authPending, setAuthPending] = createSignal(false);
  const [policy, setPolicy] = createSignal<AuthPolicy | null>(null);
  const [pendingRegistration, setPendingRegistration] =
    createSignal<PendingEmailRegistration | null>(null);
  const [reset, setReset] = createSignal<PasswordReset | null>(null);
  const identity = () => policy()?.identity ?? 'username';
  const browserDelegationStore = options.browserDelegationStore ?? {
    has: hasBrowserDelegation,
    unlock: unlockActiveBrowserDelegation,
    clear: clearBrowserDelegation,
  };

  /** The account a rejection is already ending; see `onSessionRejected`. */
  let rejecting: ActiveBrowserAccount | null = null;

  let policyRequest: Promise<void> | null = null;

  /**
   * The policy decides which field the form shows, so the sign-in screen reads
   * it when it is shown, and a session that resumes never asks. A failed read
   * leaves the form showing only its button, which reads it again.
   */
  function loadPolicy(): Promise<void> {
    if (policy() !== null) return Promise.resolve();
    policyRequest ??= readPolicy().finally(() => {
      policyRequest = null;
    });
    return policyRequest;
  }

  async function readPolicy(): Promise<void> {
    setAuthPending(true);
    try {
      setPolicy(await fetchAuthPolicy(AbortSignal.timeout(8_000)));
      setAuthError('');
    } catch {
      setAuthError(NETWORK_FEEDBACK);
    } finally {
      setAuthPending(false);
    }
  }

  function endPendingRegistration(): void {
    pendingRegistration()?.cancel();
    setPendingRegistration(null);
  }

  function clearLocalAccount(): void {
    options.setAccount(null);
    options.setAccessToken(null);
  }

  function installAccount(account: ActiveBrowserAccount): void {
    rejecting = null;
    options.setAccount(account);
    options.setAccessToken(account.session.accessToken);
  }

  async function attemptSessionRefresh(): Promise<void> {
    const logoutRetry = await retryPendingLogout(AbortSignal.timeout(4_000));
    if (logoutRetry !== 'none') {
      await browserDelegationStore.clear().catch(() => undefined);
      retireAccountRefreshCredential();
      clearLocalAccount();
      options.enterAuth();
      return;
    }
    // The HttpOnly refresh cookie is invisible to script, but the delegation it
    // pairs with is not: a refreshed session is resumed only against the record
    // this profile stores, and `resumeBrowserAccount` discards it otherwise. So
    // an empty vault is the exact fact that no refresh can succeed here, and a
    // signed-out visitor never posts to `/api/auth/refresh` to be told 401.
    // An unreadable vault ends the same way a refresh it could not resume would.
    if (!(await browserDelegationStore.has().catch(() => false))) {
      clearLocalAccount();
      options.enterAuth();
      return;
    }
    const accountBeforeRefresh = options.getAccount();
    let definitivelyUnauthorized = false;
    const session = await refreshAccessToken().catch((error: unknown) => {
      if (isApiError(error) && error.status === STATUS_UNAUTHORIZED) {
        definitivelyUnauthorized = true;
        return null;
      }
      setAuthError(NETWORK_FEEDBACK);
      return null;
    });
    if (session === null) {
      if (definitivelyUnauthorized) {
        await browserDelegationStore
          .clear(
            accountBeforeRefresh === null
              ? undefined
              : {
                  userId: accountBeforeRefresh.session.userId,
                  delegationId: accountBeforeRefresh.session.delegationId,
                },
          )
          .catch(() => undefined);
      }
      clearLocalAccount();
      options.enterAuth();
      return;
    }

    const account = await resumeBrowserAccount(session);
    if (account === null) {
      // The HttpOnly account credential is insufficient by itself. A missing,
      // expired, corrupted, or wrong-account delegation ends the local session.
      retireAccountRefreshCredential();
      clearLocalAccount();
      options.enterAuth();
      return;
    }

    installAccount(account);
    await loadDevicesAfterAuth(account.session, 'refresh');
  }

  async function onAuthSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const currentPolicy = policy();
    if (currentPolicy === null) {
      await loadPolicy();
      return;
    }
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const username = (data.get('username') as string | null)?.trim() || null;
    const passwordValue = data.get('password');
    const password = typeof passwordValue === 'string' ? passwordValue : null;
    if (!username || !password) return;
    const policyError = accountPasswordPolicyError(password);
    if (policyError !== null) {
      setAuthError(policyError);
      options.enterAuth();
      return;
    }

    setAuthPending(true);
    setAuthError('');
    options.enterAuth();

    try {
      if ((await retryPendingLogout(AbortSignal.timeout(4_000))) === 'pending') {
        throw new Error('Pending logout could not be delivered');
      }
      const result = await authenticateBrowserAccount(username, password, currentPolicy.identity);
      form.reset();
      if (result.kind === 'email-code') {
        setPendingRegistration(result);
        return;
      }
      installAccount(result.account);
      await loadDevicesAfterAuth(result.account.session, 'authentication');
    } catch (error) {
      setAuthError(authErrorFeedback(error, identity()));
      clearLocalAccount();
      options.enterAuth();
    } finally {
      setAuthPending(false);
    }
  }

  async function onAuthCodeSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const pending = pendingRegistration();
    if (pending === null) return;
    const form = event.currentTarget as HTMLFormElement;
    const codeValue = new FormData(form).get('code');
    const code = typeof codeValue === 'string' ? codeValue.trim() : '';
    if (!/^\d{6}$/.test(code)) {
      setAuthError(EMAIL_CODE_FEEDBACK);
      return;
    }
    setAuthPending(true);
    setAuthError('');
    try {
      const account = await pending.submit(code);
      setPendingRegistration(null);
      installAccount(account);
      await loadDevicesAfterAuth(account.session, 'authentication');
    } catch (error) {
      if (isApiError(error) && error.code === 'invalid_email_code') {
        setAuthError(EMAIL_CODE_FEEDBACK);
        return;
      }
      // Anything else ended the server's flow; the sign-up starts over.
      setPendingRegistration(null);
      setAuthError(
        isApiError(error) && error.status === STATUS_BAD_REQUEST
          ? EMAIL_CODE_EXPIRED_FEEDBACK
          : authErrorFeedback(error, identity()),
      );
      clearLocalAccount();
    } finally {
      setAuthPending(false);
    }
  }

  async function onAuthCodeResend(): Promise<void> {
    const pending = pendingRegistration();
    if (pending === null) return;
    setAuthPending(true);
    setAuthError('');
    try {
      await pending.resend();
    } catch (error) {
      if (isApiError(error) && error.status === STATUS_BAD_REQUEST) {
        endPendingRegistration();
        setAuthError(EMAIL_CODE_EXPIRED_FEEDBACK);
        return;
      }
      setAuthError(authErrorFeedback(error, identity()));
    } finally {
      setAuthPending(false);
    }
  }

  function onAuthCodeCancel(): void {
    endPendingRegistration();
    setAuthError('');
  }

  async function onAuthResetStart(address: string): Promise<void> {
    // A username server proves no mailbox; its form never offers this.
    if (policy()?.identity !== 'email' || address.length === 0) return;
    endPendingRegistration();
    setAuthPending(true);
    setAuthError('');
    try {
      setReset(await beginPasswordReset(address));
    } catch (error) {
      setAuthError(
        isApiError(error) && error.status === STATUS_BAD_REQUEST
          ? RESET_ADDRESS_FEEDBACK
          : resetErrorFeedback(error),
      );
    } finally {
      setAuthPending(false);
    }
  }

  async function onAuthResetCodeSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const current = reset();
    if (current?.step !== 'code') return;
    const codeValue = new FormData(event.currentTarget as HTMLFormElement).get('code');
    const code = typeof codeValue === 'string' ? codeValue.trim() : '';
    if (!/^\d{6}$/.test(code)) {
      setAuthError(EMAIL_CODE_FEEDBACK);
      return;
    }
    setAuthPending(true);
    setAuthError('');
    try {
      setReset(await current.submitCode(code));
    } catch (error) {
      if (isApiError(error) && error.code === 'invalid_email_code') {
        setAuthError(EMAIL_CODE_FEEDBACK);
      } else if (isApiError(error) && error.status === STATUS_BAD_REQUEST) {
        // The server's flow is gone: its code ran out of time or of guesses.
        setReset(null);
        setAuthError(RESET_EXPIRED_FEEDBACK);
      } else {
        // The flow is untouched; the same code can be tried again.
        setAuthError(resetErrorFeedback(error));
      }
    } finally {
      setAuthPending(false);
    }
  }

  async function onAuthResetCodeResend(): Promise<void> {
    const current = reset();
    if (current?.step !== 'code') return;
    setAuthPending(true);
    setAuthError('');
    try {
      setReset(await current.resend());
    } catch (error) {
      setAuthError(resetErrorFeedback(error));
    } finally {
      setAuthPending(false);
    }
  }

  async function onAuthResetConfirm(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const current = reset();
    if (current?.step !== 'confirm') return;
    const form = event.currentTarget as HTMLFormElement;
    const passwordValue = new FormData(form).get('password');
    const password = typeof passwordValue === 'string' ? passwordValue : '';
    const policyError = accountPasswordPolicyError(password);
    if (policyError !== null) {
      setAuthError(policyError);
      return;
    }
    setAuthPending(true);
    setAuthError('');
    try {
      const account = await current.complete(password);
      form.reset();
      setReset(null);
      installAccount(account);
      await loadDevicesAfterAuth(account.session, 'authentication');
    } catch (error) {
      if (
        isApiError(error) &&
        error.status !== STATUS_TOO_MANY_REQUESTS &&
        error.status !== STATUS_SERVICE_UNAVAILABLE
      ) {
        // The server answered the reset itself: it is spent, expired or
        // refused, and only a new code starts another.
        setReset(null);
        setAuthError(
          error.status === STATUS_BAD_REQUEST ? RESET_EXPIRED_FEEDBACK : RESET_REFUSED_FEEDBACK,
        );
        clearLocalAccount();
        return;
      }
      setAuthError(resetErrorFeedback(error));
    } finally {
      setAuthPending(false);
    }
  }

  function onAuthResetCancel(): void {
    setReset(null);
    setAuthError('');
  }

  function onSessionRejected(): void {
    const account = options.getAccount();
    // The account stays readable until the shell has left, so a second
    // rejection in that window is recognised by identity, not by absence.
    if (account === null || account === rejecting) return;
    rejecting = account;
    // Leave the shell synchronously; IndexedDB cleanup must not hold the UI open.
    // The identity check keeps a late deletion from clearing a later login.
    retireAccountRefreshCredential();
    void options.enterAuth().then(() => {
      clearLocalAccount();
      options.endSignedInState();
    });
    void browserDelegationStore
      .clear({
        userId: account.session.userId,
        delegationId: account.session.delegationId,
      })
      .catch((error: unknown) => {
        logger.warn('browser_session_vault_clear_failed', { error: String(error) });
      });
  }

  async function onLogout(): Promise<void> {
    const account = options.getAccount();
    let authorization: RevocationAuthorization | null = null;
    try {
      if (account !== null) {
        const unlocked = await browserDelegationStore.unlock(account);
        try {
          const revocation = createBrowserRevocation(
            {
              certificate: unlocked.certificate,
              delegateSeed: unlocked.delegateSeed,
            },
            [
              {
                delegationId: unlocked.certificate.delegationId,
                expiresAt: unlocked.certificate.expiresAt,
              },
            ],
            estimateAccountServerTime(account),
          );
          authorization = {
            actorCertificate: unlocked.certificate,
            revocation,
          };
          try {
            storeLogoutTombstone(authorization);
          } catch (error) {
            logger.warn('browser_logout_tombstone_store_failed', { error: String(error) });
          }
        } finally {
          unlocked.delegateSeed.fill(0);
          unlocked.rootPublicKey.fill(0);
        }
      }
    } catch (error) {
      logger.warn('browser_logout_signing_failed', { error: String(error) });
    }

    // Delete the usable secret before touching the network. Only the public,
    // signed tombstone may survive an offline logout.
    await browserDelegationStore
      .clear(
        account === null
          ? undefined
          : {
              userId: account.session.userId,
              delegationId: account.session.delegationId,
            },
      )
      .catch((error: unknown) => {
        logger.warn('browser_logout_vault_clear_failed', { error: String(error) });
      });
    retireAccountRefreshCredential();
    // The phase flips now; the account, and with it everything the shell was
    // showing, is dropped only once the shell has left the screen. A frame
    // earlier and the list empties and the link command blanks while the
    // shell is still up — and the sign-out transition's old snapshot carries
    // that instead of the screen the user was looking at.
    await options.enterAuth();
    clearLocalAccount();
    options.endSignedInState();

    if (authorization === null) return;
    try {
      await logoutAccountSession(authorization, AbortSignal.timeout(4_000));
      clearLogoutTombstone();
    } catch (error) {
      logger.warn('browser_logout_revocation_failed', { error: String(error) });
    }
  }

  async function loadDevicesAfterAuth(
    session: AccountSessionResponse,
    source: 'authentication' | 'refresh',
  ): Promise<void> {
    await options.loadDevices(session.accessToken, session.userId).catch((error: unknown) => {
      logger.warn(`device_list_load_failed_after_${source}`, { error: String(error) });
    });
  }

  return {
    authError,
    authPending,
    authIdentity: () => policy()?.identity ?? null,
    authCodeAddress: () => pendingRegistration()?.address ?? null,
    authReset: reset,
    attemptSessionRefresh,
    loadAuthPolicy: loadPolicy,
    onAuthSubmit,
    onAuthCodeSubmit,
    onAuthCodeResend,
    onAuthCodeCancel,
    onAuthResetStart,
    onAuthResetCodeSubmit,
    onAuthResetCodeResend,
    onAuthResetConfirm,
    onAuthResetCancel,
    onLogout,
    onSessionRejected,
  };
}

/** A reset step that failed without the server ending the reset. */
function resetErrorFeedback(error: unknown): string {
  if (!isApiError(error)) return NETWORK_FEEDBACK;
  if (error.status === STATUS_TOO_MANY_REQUESTS) return RESET_RATE_LIMITED_FEEDBACK;
  if (error.status === STATUS_SERVICE_UNAVAILABLE) return UNAVAILABLE_FEEDBACK;
  return NETWORK_FEEDBACK;
}

function authErrorFeedback(error: unknown, identity: AuthPolicy['identity']): string {
  if (!isApiError(error))
    return error instanceof Error && error.message.includes('authentication')
      ? AUTH_FEEDBACK[identity]
      : NETWORK_FEEDBACK;
  if (error.code === 'registration_closed') return REGISTRATION_CLOSED_FEEDBACK[identity];
  if (error.code === 'email_not_accepted') return EMAIL_NOT_ACCEPTED_FEEDBACK;
  if (error.code === 'authentication_failed') return AUTH_FEEDBACK[identity];
  if (error.status === STATUS_UNAUTHORIZED) return AUTH_FEEDBACK[identity];
  if (error.status === STATUS_BAD_REQUEST) return error.details ?? AUTH_FEEDBACK[identity];
  if (error.status === STATUS_TOO_MANY_REQUESTS) return RATE_LIMITED_FEEDBACK;
  if (error.status === STATUS_SERVICE_UNAVAILABLE) return UNAVAILABLE_FEEDBACK;
  return NETWORK_FEEDBACK;
}
