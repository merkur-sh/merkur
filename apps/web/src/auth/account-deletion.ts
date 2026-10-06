import {
  createAccountDeletionStatement,
  deriveUserAuthorizationSigningKey,
  deriveUserRootKeyCommitment,
  encodeUserAuthorizationBytes,
  USER_AUTHORIZATION_NONCE_BYTES,
} from '@merkur/shared/user-authorization';

import {
  listBrowserSessions,
  type RevocationAuthorization,
  scheduleAccountDeletionRequest,
} from './account-api';
import {
  type ActiveBrowserAccount,
  estimateAccountServerTime,
  unlockActiveBrowserDelegation,
  unlockUserRootForAccount,
} from './account-workflow';
import { createBrowserRevocation } from './browser-delegation';

/**
 * Asks for this account to be erased, on the owner's own authority.
 *
 * The password is not sent anywhere: it unwraps the user root key here, which
 * signs the request. An access token alone cannot do this, so a stolen session
 * cannot destroy the account.
 *
 * Returns the instant the purge falls due. Until then the account is dormant
 * rather than gone, and signing in calls the whole thing off.
 */
export async function requestAccountDeletion(
  account: ActiveBrowserAccount,
  password: string,
  signal?: AbortSignal,
): Promise<number> {
  let rootSeed: Uint8Array | null = null;
  let rootPublicKey: Uint8Array | null = null;
  try {
    const unlocked = await unlockUserRootForAccount(account, password, signal);
    rootSeed = unlocked.rootSeed;
    rootPublicKey = unlocked.rootPublicKey;
    const rootKey = deriveUserAuthorizationSigningKey(rootSeed);
    const rootKeyPublicKey = rootKey.publicKey;
    const nonce = crypto.getRandomValues(new Uint8Array(USER_AUTHORIZATION_NONCE_BYTES));
    try {
      const rootKeyCommitment = deriveUserRootKeyCommitment(rootKeyPublicKey);
      // The unlocked root must be this account's: signing with a root that
      // belongs to someone else would produce a statement the server refuses,
      // and failing here says why instead of reporting a wrong password.
      if (
        encodeUserAuthorizationBytes(rootKeyPublicKey) !== account.rootPublicKey ||
        rootKeyCommitment !== account.certificate.rootKeyCommitment
      ) {
        throw new Error('Unlocked user root does not match the active account');
      }
      // The server checks both statements against its own clock, and
      // unwrapping the root costs most of a second of Argon2 work, so date them
      // from the server's time rather than this tab's.
      const issuedAt = estimateAccountServerTime(account);
      const statement = createAccountDeletionStatement(
        {
          userId: account.session.userId,
          rootKeyCommitment,
          rootEpoch: unlocked.rootEpoch,
          issuedAt,
          nonce: encodeUserAuthorizationBytes(nonce),
        },
        rootKey,
      );
      const revocation = await revokeEveryDelegation(account, issuedAt, signal);
      return await scheduleAccountDeletionRequest(
        account.session.accessToken,
        statement,
        revocation,
        signal,
      );
    } finally {
      rootKey.free();
      rootKeyPublicKey.fill(0);
      nonce.fill(0);
    }
  } finally {
    rootSeed?.fill(0);
    rootPublicKey?.fill(0);
  }
}

/**
 * A revocation of every active delegation, this browser's own included, signed
 * by this browser's delegation. Daemons verify delegations themselves, so this
 * statement, not the server's own record, is what stops them serving the
 * account while the deletion waits out its grace period.
 */
async function revokeEveryDelegation(
  account: ActiveBrowserAccount,
  issuedAt: number,
  signal: AbortSignal | undefined,
): Promise<RevocationAuthorization> {
  const listed = await listBrowserSessions(account.session.accessToken, signal);
  const targets = listed.sessions
    .filter((session) => session.revokedAt === null && session.expiresAt > listed.serverTimeMs)
    .map((session) => ({ delegationId: session.delegationId, expiresAt: session.expiresAt }));
  const delegation = await unlockActiveBrowserDelegation(account);
  try {
    return {
      actorCertificate: delegation.certificate,
      revocation: createBrowserRevocation(
        { certificate: delegation.certificate, delegateSeed: delegation.delegateSeed },
        targets,
        issuedAt,
      ),
    };
  } finally {
    delegation.delegateSeed.fill(0);
    delegation.rootPublicKey.fill(0);
  }
}
