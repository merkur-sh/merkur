import { hasExactKeys, isRecord } from '@merkur/shared';
import {
  parseDelegationRevocationStatement,
  parseUserDelegationCertificate,
} from '@merkur/shared/user-authorization';

import { logoutAccountSession, type RevocationAuthorization } from './account-api';

const LOGOUT_TOMBSTONE_KEY = 'merkur:pending-browser-logout';

export type LogoutRetryResult = 'none' | 'delivered' | 'pending';

export function storeLogoutTombstone(authorization: RevocationAuthorization): void {
  const canonical = parseAuthorization(authorization);
  localStorage.setItem(LOGOUT_TOMBSTONE_KEY, JSON.stringify(canonical));
}

export function clearLogoutTombstone(): void {
  localStorage.removeItem(LOGOUT_TOMBSTONE_KEY);
}

export async function retryPendingLogout(signal?: AbortSignal): Promise<LogoutRetryResult> {
  const pending = loadLogoutTombstone();
  if (pending === null) return 'none';
  try {
    await logoutAccountSession(pending, signal);
    clearLogoutTombstone();
    return 'delivered';
  } catch {
    return 'pending';
  }
}

function loadLogoutTombstone(): RevocationAuthorization | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LOGOUT_TOMBSTONE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    return parseAuthorization(JSON.parse(raw));
  } catch {
    clearLogoutTombstone();
    return null;
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
