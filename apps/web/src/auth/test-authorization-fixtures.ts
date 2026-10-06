import type { DaemonBinding, UserDelegationCertificate } from '@merkur/shared/user-authorization';

const HASH = Buffer.alloc(64, 4).toString('base64url');

export const TEST_DAEMON_BINDING: DaemonBinding = {
  userId: 'user-1',
  rootKeyCommitment: HASH,
  daemonId: 'daemon-1',
  daemonIdentityKeyCommitment: HASH,
  serverOrigin: 'https://merkur.example',
  linkClaimId: 'claim-1',
  issuedAt: 1,
  signature: Buffer.alloc(4_627, 5).toString('base64url'),
};

export const TEST_DELEGATION_CERTIFICATE: UserDelegationCertificate = {
  userId: 'user-1',
  rootKeyCommitment: HASH,
  delegationId: 'delegation-1',
  delegatePublicKey: Buffer.alloc(2_592, 6).toString('base64url'),
  scopes: ['terminal-session', 'session-revoke'],
  serverOrigin: 'https://merkur.example',
  rootEpoch: 1,
  issuedAt: 1,
  expiresAt: 2_592_000_001,
  signature: Buffer.alloc(4_627, 7).toString('base64url'),
};

export const TEST_DAEMON_P256_PUBLIC_KEY =
  'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU';
