import {
  buildSessionDelegationProofTranscript,
  createDelegationRevocationStatement,
  createUserDelegationCertificate,
  type DelegationRevocationStatement,
  type DelegationRevocationTarget,
  decodeUserAuthorizationBytes,
  deriveSessionDelegationAuthorizationDigest,
  deriveUserAuthorizationSigningKey,
  deriveUserRootKeyCommitment,
  encodeUserAuthorizationBytes,
  equalBytes,
  parseUserDelegationCertificate,
  signSessionDelegationProof,
  USER_AUTHORIZATION_NONCE_BYTES,
  USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
  USER_AUTHORIZATION_SEED_BYTES,
  type UserDelegationCertificate,
  verifyUserDelegationCertificate,
} from '@merkur/shared/user-authorization';

export interface CreatedBrowserDelegation {
  readonly certificate: UserDelegationCertificate;
  /** Caller owns this seed and must wipe it after handing it to the vault. */
  readonly delegateSeed: Uint8Array;
}

export interface BrowserSessionDelegationProof {
  readonly certificate: UserDelegationCertificate;
  readonly signature: string;
  readonly authorizationDigest: Uint8Array;
}

export function createBrowserDelegation(
  rootSeed: Uint8Array,
  input: {
    readonly userId: string;
    readonly serverOrigin: string;
    readonly rootEpoch: number;
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly delegationId?: string;
  },
): CreatedBrowserDelegation {
  requireSeed(rootSeed, 'user-root seed');
  const rootKey = deriveUserAuthorizationSigningKey(rootSeed);
  const delegateSeed = crypto.getRandomValues(new Uint8Array(USER_AUTHORIZATION_SEED_BYTES));
  const delegateKey = deriveUserAuthorizationSigningKey(delegateSeed);
  const rootPublicKey = rootKey.publicKey;
  const delegatePublicKey = delegateKey.publicKey;
  const entropy = crypto.getRandomValues(new Uint8Array(USER_AUTHORIZATION_SEED_BYTES));
  try {
    const certificate = createUserDelegationCertificate(
      {
        userId: input.userId,
        rootKeyCommitment: deriveUserRootKeyCommitment(rootPublicKey),
        delegationId: input.delegationId ?? crypto.randomUUID(),
        delegatePublicKey: encodeUserAuthorizationBytes(delegatePublicKey),
        scopes: ['terminal-session', 'session-revoke'],
        serverOrigin: input.serverOrigin,
        rootEpoch: input.rootEpoch,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
      },
      rootKey,
      entropy,
    );
    return { certificate, delegateSeed };
  } catch (error) {
    delegateSeed.fill(0);
    throw error;
  } finally {
    rootKey.free();
    delegateKey.free();
    rootPublicKey.fill(0);
    delegatePublicKey.fill(0);
    entropy.fill(0);
  }
}

export function validateStoredBrowserDelegation(
  certificateValue: unknown,
  rootPublicKey: Uint8Array,
  expectedUserId: string,
  verificationTimeMs?: number,
): UserDelegationCertificate {
  const certificate = parseUserDelegationCertificate(certificateValue);
  const verified = verifyUserDelegationCertificate(certificate, rootPublicKey, {
    userId: expectedUserId,
    rootKeyCommitment: deriveUserRootKeyCommitment(rootPublicKey),
    delegationId: certificate.delegationId,
    serverOrigin: globalThis.location.origin,
    rootEpoch: certificate.rootEpoch,
    // A borrowed phone's wall clock is not an authorization authority. When no
    // server-derived time is available, verify the signed shape at its own
    // issuance instant; refresh/session issuance and the daemon enforce expiry.
    nowMs: verificationTimeMs ?? certificate.issuedAt,
  });
  if (verified === null) throw new Error('Browser delegation is invalid or expired');
  return verified;
}

export function createBrowserSessionProof(
  requestTranscript: Uint8Array,
  certificateValue: unknown,
  delegateSeed: Uint8Array,
): BrowserSessionDelegationProof {
  requireSeed(delegateSeed, 'browser delegate seed');
  const certificate = parseUserDelegationCertificate(certificateValue);
  const delegateKey = deriveUserAuthorizationSigningKey(delegateSeed);
  const delegatePublicKey = delegateKey.publicKey;
  const expectedPublicKey = decodeUserAuthorizationBytes(
    certificate.delegatePublicKey,
    USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
    'delegate public key',
  );
  const entropy = crypto.getRandomValues(new Uint8Array(USER_AUTHORIZATION_SEED_BYTES));
  let proofTranscript: Uint8Array | null = null;
  let signature: Uint8Array | null = null;
  try {
    if (!equalBytes(delegatePublicKey, expectedPublicKey)) {
      throw new Error('Browser delegate seed does not match its certificate');
    }
    proofTranscript = buildSessionDelegationProofTranscript(requestTranscript, certificate);
    signature = signSessionDelegationProof(proofTranscript, delegateKey, entropy);
    return {
      certificate,
      signature: encodeUserAuthorizationBytes(signature),
      authorizationDigest: deriveSessionDelegationAuthorizationDigest(proofTranscript, signature),
    };
  } finally {
    delegateKey.free();
    delegatePublicKey.fill(0);
    expectedPublicKey.fill(0);
    entropy.fill(0);
    proofTranscript?.fill(0);
    signature?.fill(0);
  }
}

export function createBrowserRevocation(
  credential: {
    readonly certificate: UserDelegationCertificate;
    readonly delegateSeed: Uint8Array;
  },
  targets: readonly DelegationRevocationTarget[],
  issuedAt: number,
): DelegationRevocationStatement {
  requireSeed(credential.delegateSeed, 'browser delegate seed');
  const certificate = parseUserDelegationCertificate(credential.certificate);
  const sortedTargets = [...targets].sort((left, right) =>
    left.delegationId < right.delegationId ? -1 : left.delegationId > right.delegationId ? 1 : 0,
  );
  const key = deriveUserAuthorizationSigningKey(credential.delegateSeed);
  const nonce = crypto.getRandomValues(new Uint8Array(USER_AUTHORIZATION_NONCE_BYTES));
  const entropy = crypto.getRandomValues(new Uint8Array(USER_AUTHORIZATION_SEED_BYTES));
  try {
    return createDelegationRevocationStatement(
      {
        userId: certificate.userId,
        rootKeyCommitment: certificate.rootKeyCommitment,
        actorDelegationId: certificate.delegationId,
        targets: sortedTargets,
        issuedAt,
        nonce: encodeUserAuthorizationBytes(nonce),
      },
      key,
      entropy,
    );
  } finally {
    key.free();
    nonce.fill(0);
    entropy.fill(0);
  }
}

function requireSeed(value: Uint8Array, label: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== USER_AUTHORIZATION_SEED_BYTES) {
    throw new Error(`${label} must be exactly ${USER_AUTHORIZATION_SEED_BYTES} bytes`);
  }
}
