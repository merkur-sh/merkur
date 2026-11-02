import { localValue } from '@merkur/browser-storage';
import { hasExactKeys, isRecord } from '@merkur/shared';
import {
  parseDelegationRevocationStatement,
  parseUserDelegationCertificate,
} from '@merkur/shared/user-authorization';

import { logoutAccountSession, type RevocationAuthorization } from './account-api';

export type LogoutRetryResult = 'none' | 'delivered' | 'pending';

const logoutTombstone = localValue('merkur:pending-browser-logout', (value) => {
  try {
    return parseAuthorization(value);
  } catch {
    return null;
  }
});

/**
 * Throws when the tombstone cannot be stored: a logout whose revocation could
 * be lost must not be reported as queued.
 */
export function storeLogoutTombstone(authorization: RevocationAuthorization): void {
  if (!logoutTombstone.write(parseAuthorization(authorization))) {
    throw new Error('Unable to store the pending logout');
  }
}

export function clearLogoutTombstone(): void {
  logoutTombstone.remove();
}

export async function retryPendingLogout(signal?: AbortSignal): Promise<LogoutRetryResult> {
  const pending = logoutTombstone.read();
  if (pending === null) return 'none';
  try {
    await logoutAccountSession(pending, signal);
    clearLogoutTombstone();
    return 'delivered';
  } catch {
    return 'pending';
  }
}

function parseAuthorization(value: unknown): RevocationAuthorization {
  if (!isRecord(value) || !hasExactKeys(value, ['actorCertificate', 'revocation'])) {
    throw new Error('Stored logout tombstone is malformed');
  }
  const actorCertificate = parseUserDelegationCertificate(value.actorCertificate);
  const revocation = parseDelegationRevocationStatement(value.revocation);
  if (
    revocation.userId !== actorCertificate.userId ||
    revocation.rootKeyCommitment !== actorCertificate.rootKeyCommitment ||
    revocation.actorDelegationId !== actorCertificate.delegationId
  ) {
    throw new Error('Stored logout tombstone actor mismatch');
  }
  return { actorCertificate, revocation };
}
