import { changePasswordSession } from '../api';
import { listBrowserSessions, startAuthenticationRequest } from './account-api';
import {
  finishAccountLogin,
  finishAccountRegistration,
  startAccountLogin,
  startAccountRegistration,
} from './account-opaque';
import {
  type ActiveBrowserAccount,
  assertSessionMatchesCertificate,
  unlockActiveBrowserDelegation,
} from './account-workflow';
import { createBrowserRevocation } from './browser-delegation';
import { requireValidAccountPassword } from './password-policy';
import { decryptUserRootSeed, encryptUserRootSeed } from './user-root';

export async function changeBrowserAccountPassword(
  account: ActiveBrowserAccount,
  currentPassword: string,
  newPassword: string,
  signal?: AbortSignal,
): Promise<ActiveBrowserAccount> {
  requireValidAccountPassword(newPassword);
  if (currentPassword === newPassword) throw new Error('Choose a different new password.');
  const [login, registration] = await Promise.all([
    startAccountLogin(currentPassword),
    startAccountRegistration(newPassword),
  ]);
  const started = await startAuthenticationRequest(
    account.username,
    login.startLoginRequest,
    registration.registrationRequest,
    signal,
  );
  if (
    started.login.userId !== account.session.userId ||
    started.login.rootPublicKey !== account.rootPublicKey ||
    started.login.rootEpoch !== account.certificate.rootEpoch
  ) {
    throw new Error('Account authentication failed.');
  }
  const oldLogin = await finishAccountLogin(
    currentPassword,
    login.clientLoginState,
    started.login.loginResponse,
    account.session.userId,
    globalThis.location.origin,
    signal,
  );
  if (oldLogin === null) throw new Error('The current password is incorrect.');
  let unlocked: Awaited<ReturnType<typeof unlockActiveBrowserDelegation>> | null = null;
  let rootSeed: Uint8Array | null = null;
  let newExportKey: Uint8Array | null = null;
  try {
    unlocked = await unlockActiveBrowserDelegation(account);
    const replacement = await finishAccountRegistration(
      newPassword,
      registration.clientRegistrationState,
      started.registration.registrationResponse,
      account.session.userId,
      globalThis.location.origin,
      signal,
    );
    newExportKey = replacement.exportKey;
    rootSeed = await decryptUserRootSeed(
      started.login.rootEnvelope,
      oldLogin.exportKey,
      account.session.userId,
      unlocked.rootPublicKey,
    );
    oldLogin.exportKey.fill(0);
    const rootEnvelope = await encryptUserRootSeed(
      rootSeed,
      newExportKey,
      account.session.userId,
      unlocked.rootPublicKey,
    );
    rootSeed.fill(0);
    newExportKey.fill(0);
    const sessions = await listBrowserSessions(account.session.accessToken, signal);
    const targets = sessions.sessions.filter(
      (session) => !session.current && session.revokedAt === null,
    );
    const revocation =
      targets.length === 0
        ? null
        : createBrowserRevocation(
            unlocked,
            targets.map(({ delegationId, expiresAt }) => ({ delegationId, expiresAt })),
            sessions.serverTimeMs,
          );
    const session = await changePasswordSession(
      account.session.accessToken,
      {
        flowId: started.login.flowId,
        finishLoginRequest: oldLogin.finishLoginRequest,
        registrationRecord: replacement.registrationRecord,
        rootEnvelope,
        delegationCertificate: account.certificate,
        revocation,
      },
      signal,
    );
    assertSessionMatchesCertificate(session, account.certificate);
    return { ...account, session, serverTimeReceiptMonotonicMs: performance.now() };
  } finally {
    oldLogin.exportKey.fill(0);
    rootSeed?.fill(0);
    newExportKey?.fill(0);
    unlocked?.delegateSeed.fill(0);
    unlocked?.rootPublicKey.fill(0);
  }
}
