// Every signature, digest and MAC below runs in the `merkur-e2e` WebAssembly
// build, the same code the daemon links. The realm must have instantiated it:
// Bun processes import `@merkur/shared/e2e-wasm-bun`, each browser realm awaits
// `loadE2eWasmModule()` (apps/web/src/lib/e2e-wasm-module.ts) first.
import type { MlDsa87SigningKey } from '../../e2e-wasm/pkg/e2e_wasm.js';
import { type DaemonIdentitySealBackend, isDaemonIdentitySealBackend } from './domain';
import { e2eWasm } from './e2e-wasm-runtime';

export type { MlDsa87SigningKey };

const TEXT_ENCODER = new TextEncoder();
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const PROTOCOL_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

export const USER_AUTHORIZATION_SEED_BYTES = 32;
export const USER_AUTHORIZATION_PUBLIC_KEY_BYTES = 2_592;
export const USER_AUTHORIZATION_SIGNATURE_BYTES = 4_627;
export const USER_AUTHORIZATION_HASH_BYTES = 64;
export const USER_AUTHORIZATION_NONCE_BYTES = 32;
export const USER_DELEGATION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
export const USER_ROOT_INITIAL_EPOCH = 1;

export const USER_DELEGATION_CONTEXT = TEXT_ENCODER.encode('merkur-browser-delegation');
export const SESSION_DELEGATION_CONTEXT = TEXT_ENCODER.encode('merkur-session-delegation');
export const DAEMON_BINDING_CONTEXT = TEXT_ENCODER.encode('merkur-daemon-binding');
export const DELEGATION_REVOCATION_CONTEXT = TEXT_ENCODER.encode('merkur-delegation-revocation');
const ACCOUNT_DELETION_CONTEXT = TEXT_ENCODER.encode('merkur-account-deletion');

const ROOT_KEY_COMMITMENT_DOMAIN = TEXT_ENCODER.encode('merkur-user-root-key\0');
const DAEMON_LINK_CLAIM_DOMAIN = TEXT_ENCODER.encode('merkur-link-claim\0');
const DAEMON_LINK_APPROVAL_DOMAIN = TEXT_ENCODER.encode('merkur-link-approval\0');
const FIXED_DELEGATION_SCOPES = ['terminal-session', 'session-revoke'] as const;
const MAX_ID_BYTES = 128;
const MAX_ORIGIN_BYTES = 2_048;
const CLOCK_SKEW_MS = 30_000;

export interface UserDelegationPayload {
  readonly userId: string;
  readonly rootKeyCommitment: string;
  readonly delegationId: string;
  readonly delegatePublicKey: string;
  readonly scopes: readonly ['terminal-session', 'session-revoke'];
  readonly serverOrigin: string;
  readonly rootEpoch: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface UserDelegationCertificate extends UserDelegationPayload {
  readonly signature: string;
}

export interface DaemonBindingPayload {
  readonly userId: string;
  readonly rootKeyCommitment: string;
  readonly daemonId: string;
  readonly daemonIdentityKeyCommitment: string;
  readonly serverOrigin: string;
  readonly linkClaimId: string;
  readonly issuedAt: number;
}

export interface DaemonBinding extends DaemonBindingPayload {
  readonly signature: string;
}

export interface DelegationRevocationTarget {
  readonly delegationId: string;
  readonly expiresAt: number;
}

export interface DelegationRevocationPayload {
  readonly userId: string;
  readonly rootKeyCommitment: string;
  readonly actorDelegationId: string;
  readonly targets: readonly DelegationRevocationTarget[];
  readonly issuedAt: number;
  readonly nonce: string;
}

export interface DelegationRevocationStatement extends DelegationRevocationPayload {
  readonly signature: string;
}

/**
 * A request to erase an account, signed by the user root key.
 *
 * An access token is not enough authority to destroy an account: a stolen one
 * would be able to, and the server cannot tell it from the owner. The root key
 * can only be unwrapped with the password, so signing with it proves the
 * request came from someone who knows the password, and the server verifies it
 * against the root public key it already stores.
 *
 * `rootEpoch` is part of the signed bytes so a statement cannot outlive a root
 * rotation: after the epoch moves, a statement signed under the old one no
 * longer matches the account and is refused.
 */
export interface AccountDeletionPayload {
  readonly userId: string;
  readonly rootKeyCommitment: string;
  readonly rootEpoch: number;
  readonly issuedAt: number;
  readonly nonce: string;
}

export interface AccountDeletionStatement extends AccountDeletionPayload {
  readonly signature: string;
}

export interface DaemonLinkPublicClaimPayload {
  readonly linkClaimId: string;
  readonly daemonId: string;
  readonly daemonIdentityPublicKey: string;
  readonly daemonIdentityP256PublicKey: string;
  readonly daemonIdentityKeyCommitment: string;
  readonly name: string;
  readonly platform: string;
  readonly identitySealBackend: DaemonIdentitySealBackend;
}

export interface DaemonLinkPublicClaim extends DaemonLinkPublicClaimPayload {
  readonly claimCommitment: string;
}

export interface DaemonLinkApprovalPayload {
  readonly linkClaimId: string;
  readonly claimCommitment: string;
  readonly userRootPublicKey: string;
  readonly rootEpoch: number;
  readonly daemonBinding: DaemonBinding;
}

export interface DaemonLinkApproval extends DaemonLinkApprovalPayload {
  readonly approvalMac: string;
}

export interface VerifyDelegationOptions {
  readonly userId: string;
  readonly rootKeyCommitment: string;
  readonly delegationId?: string;
  readonly serverOrigin: string;
  readonly rootEpoch: number;
  readonly nowMs: number;
}

/**
 * Expand a 32-byte seed into an ML-DSA-87 signing key held in WebAssembly
 * memory. The secret half never becomes a JavaScript value; the caller must
 * `free()` the key, which wipes it, in a `finally`.
 */
export function deriveUserAuthorizationSigningKey(seed: Uint8Array): MlDsa87SigningKey {
  requireLength(seed, USER_AUTHORIZATION_SEED_BYTES, 'ML-DSA-87 seed');
  return e2eWasm().MlDsa87SigningKey.fromSeed(seed);
}

export function deriveUserAuthorizationPublicKey(seed: Uint8Array): Uint8Array {
  const key = deriveUserAuthorizationSigningKey(seed);
  try {
    const publicKey = key.publicKey;
    requireLength(publicKey, USER_AUTHORIZATION_PUBLIC_KEY_BYTES, 'ML-DSA-87 public key');
    return publicKey;
  } finally {
    key.free();
  }
}

export function deriveUserRootKeyCommitment(publicKey: Uint8Array): string {
  requireLength(publicKey, USER_AUTHORIZATION_PUBLIC_KEY_BYTES, 'user root public key');
  return encodeBase64Url(e2eWasm().sha512(concatBytes(ROOT_KEY_COMMITMENT_DOMAIN, publicKey)));
}

export function deriveDaemonIdentityKeyCommitment(
  publicKey: Uint8Array,
  p256PublicKey: Uint8Array,
): string {
  requireLength(publicKey, USER_AUTHORIZATION_PUBLIC_KEY_BYTES, 'daemon identity public key');
  requireLength(p256PublicKey, 65, 'daemon P-256 public key');
  return encodeBase64Url(e2eWasm().computeDaemonIdentityKeyHash(publicKey, p256PublicKey));
}

export function createUserDelegationCertificate(
  payload: UserDelegationPayload,
  rootKey: MlDsa87SigningKey,
  signingEntropy?: Uint8Array,
): UserDelegationCertificate {
  const canonical = validateDelegationPayload(payload);
  const signature = signBytes(
    TEXT_ENCODER.encode(JSON.stringify(canonical)),
    rootKey,
    USER_DELEGATION_CONTEXT,
    signingEntropy,
  );
  return { ...canonical, signature: encodeBase64Url(signature) };
}

export function parseUserDelegationCertificate(value: unknown): UserDelegationCertificate {
  const record = requireRecord(value, 'delegation certificate');
  requireExactKeys(record, [
    'userId',
    'rootKeyCommitment',
    'delegationId',
    'delegatePublicKey',
    'scopes',
    'serverOrigin',
    'rootEpoch',
    'issuedAt',
    'expiresAt',
    'signature',
  ]);
  const payload = validateDelegationPayload({
    userId: record.userId,
    rootKeyCommitment: record.rootKeyCommitment,
    delegationId: record.delegationId,
    delegatePublicKey: record.delegatePublicKey,
    scopes: record.scopes,
    serverOrigin: record.serverOrigin,
    rootEpoch: record.rootEpoch,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  });
  const signature = requireBase64Url(
    record.signature,
    USER_AUTHORIZATION_SIGNATURE_BYTES,
    'delegation signature',
  );
  return { ...payload, signature: encodeBase64Url(signature) };
}

export function serializeUserDelegationCertificate(certificate: UserDelegationCertificate): string {
  return JSON.stringify(parseUserDelegationCertificate(certificate));
}

export function verifyUserDelegationCertificate(
  certificateValue: unknown,
  rootPublicKey: Uint8Array,
  options: VerifyDelegationOptions,
): UserDelegationCertificate | null {
  try {
    requireLength(rootPublicKey, USER_AUTHORIZATION_PUBLIC_KEY_BYTES, 'user root public key');
    const certificate = parseUserDelegationCertificate(certificateValue);
    if (
      certificate.userId !== options.userId ||
      certificate.rootKeyCommitment !== options.rootKeyCommitment ||
      (options.delegationId !== undefined && certificate.delegationId !== options.delegationId) ||
      certificate.serverOrigin !== options.serverOrigin ||
      certificate.rootEpoch !== options.rootEpoch ||
      options.nowMs < certificate.issuedAt - CLOCK_SKEW_MS ||
      options.nowMs >= certificate.expiresAt
    ) {
      return null;
    }
    const payload = delegationPayloadOf(certificate);
    const signature = requireBase64Url(
      certificate.signature,
      USER_AUTHORIZATION_SIGNATURE_BYTES,
      'delegation signature',
    );
    return e2eWasm().mlDsa87Verify(
      rootPublicKey,
      USER_DELEGATION_CONTEXT,
      TEXT_ENCODER.encode(JSON.stringify(payload)),
      signature,
    )
      ? certificate
      : null;
  } catch {
    return null;
  }
}

/**
 * Build the browser delegate's exact per-session proof. The existing request
 * transcript already contains the complete server capability, session and
 * one-use ML-KEM request; the certificate digest binds its authorization key.
 */
export function buildSessionDelegationProofTranscript(
  requestTranscript: Uint8Array,
  certificate: UserDelegationCertificate,
): Uint8Array {
  return e2eWasm().buildSessionDelegationProofTranscript(
    requestTranscript,
    TEXT_ENCODER.encode(serializeUserDelegationCertificate(certificate)),
  );
}

export function signSessionDelegationProof(
  proofTranscript: Uint8Array,
  delegateKey: MlDsa87SigningKey,
  signingEntropy?: Uint8Array,
): Uint8Array {
  return signBytes(proofTranscript, delegateKey, SESSION_DELEGATION_CONTEXT, signingEntropy);
}

export function verifySessionDelegationProof(
  proofTranscript: Uint8Array,
  signature: Uint8Array,
  delegatePublicKey: Uint8Array,
): boolean {
  try {
    requireLength(signature, USER_AUTHORIZATION_SIGNATURE_BYTES, 'session delegation signature');
    requireLength(delegatePublicKey, USER_AUTHORIZATION_PUBLIC_KEY_BYTES, 'delegate public key');
    return e2eWasm().mlDsa87Verify(
      delegatePublicKey,
      SESSION_DELEGATION_CONTEXT,
      proofTranscript,
      signature,
    );
  } catch {
    return false;
  }
}

/** Digest included in the daemon response transcript and therefore its KDF salt. */
export function deriveSessionDelegationAuthorizationDigest(
  proofTranscript: Uint8Array,
  delegateSignature: Uint8Array,
): Uint8Array {
  requireLength(
    delegateSignature,
    USER_AUTHORIZATION_SIGNATURE_BYTES,
    'session delegation signature',
  );
  return e2eWasm().computeSessionDelegationAuthorizationDigest(proofTranscript, delegateSignature);
}

export function createDaemonBinding(
  payload: DaemonBindingPayload,
  rootKey: MlDsa87SigningKey,
  signingEntropy?: Uint8Array,
): DaemonBinding {
  const canonical = validateDaemonBindingPayload(payload);
  const signature = signBytes(
    TEXT_ENCODER.encode(JSON.stringify(canonical)),
    rootKey,
    DAEMON_BINDING_CONTEXT,
    signingEntropy,
  );
  return { ...canonical, signature: encodeBase64Url(signature) };
}

export function parseDaemonBinding(value: unknown): DaemonBinding {
  const record = requireRecord(value, 'daemon binding');
  requireExactKeys(record, [
    'userId',
    'rootKeyCommitment',
    'daemonId',
    'daemonIdentityKeyCommitment',
    'serverOrigin',
    'linkClaimId',
    'issuedAt',
    'signature',
  ]);
  const payload = validateDaemonBindingPayload({
    userId: record.userId,
    rootKeyCommitment: record.rootKeyCommitment,
    daemonId: record.daemonId,
    daemonIdentityKeyCommitment: record.daemonIdentityKeyCommitment,
    serverOrigin: record.serverOrigin,
    linkClaimId: record.linkClaimId,
    issuedAt: record.issuedAt,
  });
  const signature = record.signature;
  if (typeof signature !== 'string') {
    throw new Error('daemon binding signature is not canonical unpadded base64url');
  }
  requireBase64Url(signature, USER_AUTHORIZATION_SIGNATURE_BYTES, 'daemon binding signature');
  // Validation already round-trips the encoding; retain that canonical string.
  return { ...payload, signature };
}

export function verifyDaemonBinding(
  bindingValue: unknown,
  rootPublicKey: Uint8Array,
  expected: DaemonBindingPayload,
): DaemonBinding | null {
  try {
    requireLength(rootPublicKey, USER_AUTHORIZATION_PUBLIC_KEY_BYTES, 'user root public key');
    const binding = parseDaemonBinding(bindingValue);
    const payload = validateDaemonBindingPayload(expected);
    if (JSON.stringify(daemonBindingPayloadOf(binding)) !== JSON.stringify(payload)) return null;
    const signature = requireBase64Url(
      binding.signature,
      USER_AUTHORIZATION_SIGNATURE_BYTES,
      'daemon binding signature',
    );
    return e2eWasm().mlDsa87Verify(
      rootPublicKey,
      DAEMON_BINDING_CONTEXT,
      TEXT_ENCODER.encode(JSON.stringify(payload)),
      signature,
    )
      ? binding
      : null;
  } catch {
    return null;
  }
}

export function createDelegationRevocationStatement(
  payload: DelegationRevocationPayload,
  actorKey: MlDsa87SigningKey,
  signingEntropy?: Uint8Array,
): DelegationRevocationStatement {
  const canonical = validateRevocationPayload(payload);
  const signature = signBytes(
    TEXT_ENCODER.encode(JSON.stringify(canonical)),
    actorKey,
    DELEGATION_REVOCATION_CONTEXT,
    signingEntropy,
  );
  return { ...canonical, signature: encodeBase64Url(signature) };
}

export function parseDelegationRevocationStatement(value: unknown): DelegationRevocationStatement {
  const record = requireRecord(value, 'delegation revocation');
  requireExactKeys(record, [
    'userId',
    'rootKeyCommitment',
    'actorDelegationId',
    'targets',
    'issuedAt',
    'nonce',
    'signature',
  ]);
  const payload = validateRevocationPayload({
    userId: record.userId,
    rootKeyCommitment: record.rootKeyCommitment,
    actorDelegationId: record.actorDelegationId,
    targets: record.targets,
    issuedAt: record.issuedAt,
    nonce: record.nonce,
  });
  const signature = requireBase64Url(
    record.signature,
    USER_AUTHORIZATION_SIGNATURE_BYTES,
    'delegation revocation signature',
  );
  return { ...payload, signature: encodeBase64Url(signature) };
}

export function verifyDelegationRevocationStatement(
  statementValue: unknown,
  actorPublicKey: Uint8Array,
): DelegationRevocationStatement | null {
  try {
    requireLength(actorPublicKey, USER_AUTHORIZATION_PUBLIC_KEY_BYTES, 'delegate public key');
    const statement = parseDelegationRevocationStatement(statementValue);
    const payload = revocationPayloadOf(statement);
    const signature = requireBase64Url(
      statement.signature,
      USER_AUTHORIZATION_SIGNATURE_BYTES,
      'delegation revocation signature',
    );
    return e2eWasm().mlDsa87Verify(
      actorPublicKey,
      DELEGATION_REVOCATION_CONTEXT,
      TEXT_ENCODER.encode(JSON.stringify(payload)),
      signature,
    )
      ? statement
      : null;
  } catch {
    return null;
  }
}

export function createAccountDeletionStatement(
  payload: AccountDeletionPayload,
  rootKey: MlDsa87SigningKey,
  signingEntropy?: Uint8Array,
): AccountDeletionStatement {
  const canonical = validateAccountDeletionPayload(payload);
  const signature = signBytes(
    TEXT_ENCODER.encode(JSON.stringify(canonical)),
    rootKey,
    ACCOUNT_DELETION_CONTEXT,
    signingEntropy,
  );
  return { ...canonical, signature: encodeBase64Url(signature) };
}

export function parseAccountDeletionStatement(value: unknown): AccountDeletionStatement {
  const record = requireRecord(value, 'account deletion');
  requireExactKeys(record, [
    'userId',
    'rootKeyCommitment',
    'rootEpoch',
    'issuedAt',
    'nonce',
    'signature',
  ]);
  const payload = validateAccountDeletionPayload({
    userId: record.userId,
    rootKeyCommitment: record.rootKeyCommitment,
    rootEpoch: record.rootEpoch,
    issuedAt: record.issuedAt,
    nonce: record.nonce,
  });
  const signature = requireBase64Url(
    record.signature,
    USER_AUTHORIZATION_SIGNATURE_BYTES,
    'account deletion signature',
  );
  return { ...payload, signature: encodeBase64Url(signature) };
}

export function verifyAccountDeletionStatement(
  statementValue: unknown,
  rootPublicKey: Uint8Array,
): AccountDeletionStatement | null {
  try {
    requireLength(rootPublicKey, USER_AUTHORIZATION_PUBLIC_KEY_BYTES, 'user root public key');
    const statement = parseAccountDeletionStatement(statementValue);
    const payload = accountDeletionPayloadOf(statement);
    const signature = requireBase64Url(
      statement.signature,
      USER_AUTHORIZATION_SIGNATURE_BYTES,
      'account deletion signature',
    );
    return e2eWasm().mlDsa87Verify(
      rootPublicKey,
      ACCOUNT_DELETION_CONTEXT,
      TEXT_ENCODER.encode(JSON.stringify(payload)),
      signature,
    )
      ? statement
      : null;
  } catch {
    return null;
  }
}

/**
 * Commit to the complete daemon claim authenticated by the high-entropy code.
 * If identity fields were omitted, a malicious coordinator could trick the
 * browser root into signing a substituted permanent daemon identity.
 */
export function deriveDaemonLinkClaimCommitment(
  claimValue: DaemonLinkPublicClaimPayload,
  linkSecret: Uint8Array,
): string {
  requireLength(linkSecret, USER_AUTHORIZATION_SEED_BYTES, 'daemon link secret');
  const claim = validateDaemonLinkPublicClaimPayload(claimValue);
  const claimBytes = TEXT_ENCODER.encode(JSON.stringify(claim));
  return encodeBase64Url(
    e2eWasm().sha512(
      concatBytes(
        DAEMON_LINK_CLAIM_DOMAIN,
        encodeU64(claimBytes.byteLength),
        claimBytes,
        linkSecret,
      ),
    ),
  );
}

export function parseDaemonLinkPublicClaim(value: unknown): DaemonLinkPublicClaim {
  const record = requireRecord(value, 'daemon link claim');
  requireExactKeys(record, [
    'linkClaimId',
    'daemonId',
    'daemonIdentityPublicKey',
    'daemonIdentityP256PublicKey',
    'daemonIdentityKeyCommitment',
    'name',
    'platform',
    'identitySealBackend',
    'claimCommitment',
  ]);
  const payload = validateDaemonLinkPublicClaimPayload({
    linkClaimId: record.linkClaimId,
    daemonId: record.daemonId,
    daemonIdentityPublicKey: record.daemonIdentityPublicKey,
    daemonIdentityP256PublicKey: record.daemonIdentityP256PublicKey,
    daemonIdentityKeyCommitment: record.daemonIdentityKeyCommitment,
    name: record.name,
    platform: record.platform,
    identitySealBackend: record.identitySealBackend,
  });
  return {
    ...payload,
    claimCommitment: encodeBase64Url(
      requireBase64Url(
        record.claimCommitment,
        USER_AUTHORIZATION_HASH_BYTES,
        'daemon link claim commitment',
      ),
    ),
  };
}

export function formatDaemonLinkCode(linkClaimId: string, linkSecret: Uint8Array): string {
  requireId(linkClaimId, 'link claim id');
  requireLength(linkSecret, USER_AUTHORIZATION_SEED_BYTES, 'daemon link secret');
  return `${linkClaimId}.${encodeBase64Url(linkSecret)}`;
}

export function parseDaemonLinkCode(value: string): {
  readonly linkClaimId: string;
  readonly linkSecret: Uint8Array;
} {
  const segments = value.split('.');
  if (segments.length !== 2) throw new Error('daemon link code is invalid');
  const [linkClaimId, encodedSecret] = segments;
  return {
    linkClaimId: requireId(linkClaimId, 'link claim id'),
    linkSecret: requireBase64Url(
      encodedSecret,
      USER_AUTHORIZATION_SEED_BYTES,
      'daemon link secret',
    ),
  };
}

export function createDaemonLinkApproval(
  payloadValue: DaemonLinkApprovalPayload,
  serverNonce: Uint8Array,
  linkSecret: Uint8Array,
): DaemonLinkApproval {
  requireLength(serverNonce, USER_AUTHORIZATION_NONCE_BYTES, 'daemon link server nonce');
  requireLength(linkSecret, USER_AUTHORIZATION_SEED_BYTES, 'daemon link secret');
  const payload = validateDaemonLinkApprovalPayload(payloadValue);
  const payloadDigest = e2eWasm().sha512(TEXT_ENCODER.encode(JSON.stringify(payload)));
  const approvalMac = e2eWasm().hmacSha512(
    linkSecret,
    concatBytes(DAEMON_LINK_APPROVAL_DOMAIN, serverNonce, payloadDigest),
  );
  return { ...payload, approvalMac: encodeBase64Url(approvalMac) };
}

export function parseDaemonLinkApproval(value: unknown): DaemonLinkApproval {
  const record = requireRecord(value, 'daemon link approval');
  requireExactKeys(record, [
    'linkClaimId',
    'claimCommitment',
    'userRootPublicKey',
    'rootEpoch',
    'daemonBinding',
    'approvalMac',
  ]);
  const payload = validateDaemonLinkApprovalPayload({
    linkClaimId: record.linkClaimId,
    claimCommitment: record.claimCommitment,
    userRootPublicKey: record.userRootPublicKey,
    rootEpoch: record.rootEpoch,
    daemonBinding: record.daemonBinding,
  });
  return {
    ...payload,
    approvalMac: encodeBase64Url(
      requireBase64Url(
        record.approvalMac,
        USER_AUTHORIZATION_HASH_BYTES,
        'daemon link approval MAC',
      ),
    ),
  };
}

export function verifyDaemonLinkApproval(
  approvalValue: unknown,
  serverNonce: Uint8Array,
  linkSecret: Uint8Array,
): DaemonLinkApproval | null {
  try {
    const approval = parseDaemonLinkApproval(approvalValue);
    const expected = createDaemonLinkApproval(
      daemonLinkApprovalPayloadOf(approval),
      serverNonce,
      linkSecret,
    );
    const actualMac = requireBase64Url(
      approval.approvalMac,
      USER_AUTHORIZATION_HASH_BYTES,
      'daemon link approval MAC',
    );
    const expectedMac = requireBase64Url(
      expected.approvalMac,
      USER_AUTHORIZATION_HASH_BYTES,
      'expected daemon link approval MAC',
    );
    return equalBytes(actualMac, expectedMac) ? approval : null;
  } catch {
    return null;
  }
}

export function encodeUserAuthorizationBytes(value: Uint8Array): string {
  return encodeBase64Url(value);
}

export function decodeUserAuthorizationBytes(
  value: string,
  expectedLength: number,
  label = 'authorization bytes',
): Uint8Array {
  return requireBase64Url(value, expectedLength, label);
}

function validateDelegationPayload(value: unknown): UserDelegationPayload {
  const record = requireRecord(value, 'delegation payload');
  requireExactKeys(record, [
    'userId',
    'rootKeyCommitment',
    'delegationId',
    'delegatePublicKey',
    'scopes',
    'serverOrigin',
    'rootEpoch',
    'issuedAt',
    'expiresAt',
  ]);
  const userId = requireId(record.userId, 'user id');
  const rootKeyCommitment = encodeBase64Url(
    requireBase64Url(
      record.rootKeyCommitment,
      USER_AUTHORIZATION_HASH_BYTES,
      'root key commitment',
    ),
  );
  const delegationId = requireId(record.delegationId, 'delegation id');
  const delegatePublicKey = encodeBase64Url(
    requireBase64Url(
      record.delegatePublicKey,
      USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
      'delegate public key',
    ),
  );
  if (
    !Array.isArray(record.scopes) ||
    record.scopes.length !== 2 ||
    record.scopes[0] !== FIXED_DELEGATION_SCOPES[0] ||
    record.scopes[1] !== FIXED_DELEGATION_SCOPES[1]
  ) {
    throw new Error('delegation scopes are not the fixed canonical scopes');
  }
  const serverOrigin = requireOrigin(record.serverOrigin);
  const rootEpoch = requirePositiveInteger(record.rootEpoch, 'root epoch');
  const issuedAt = requireTimestamp(record.issuedAt, 'delegation issued-at');
  const expiresAt = requireTimestamp(record.expiresAt, 'delegation expiry');
  if (expiresAt - issuedAt !== USER_DELEGATION_LIFETIME_MS) {
    throw new Error('delegation lifetime must be exactly 30 days');
  }
  return {
    userId,
    rootKeyCommitment,
    delegationId,
    delegatePublicKey,
    scopes: FIXED_DELEGATION_SCOPES,
    serverOrigin,
    rootEpoch,
    issuedAt,
    expiresAt,
  };
}

function validateDaemonBindingPayload(value: unknown): DaemonBindingPayload {
  const record = requireRecord(value, 'daemon binding payload');
  requireExactKeys(record, [
    'userId',
    'rootKeyCommitment',
    'daemonId',
    'daemonIdentityKeyCommitment',
    'serverOrigin',
    'linkClaimId',
    'issuedAt',
  ]);
  return {
    userId: requireId(record.userId, 'user id'),
    rootKeyCommitment: encodeBase64Url(
      requireBase64Url(
        record.rootKeyCommitment,
        USER_AUTHORIZATION_HASH_BYTES,
        'root key commitment',
      ),
    ),
    daemonId: requireId(record.daemonId, 'daemon id'),
    daemonIdentityKeyCommitment: encodeBase64Url(
      requireBase64Url(
        record.daemonIdentityKeyCommitment,
        USER_AUTHORIZATION_HASH_BYTES,
        'daemon identity key commitment',
      ),
    ),
    serverOrigin: requireOrigin(record.serverOrigin),
    linkClaimId: requireId(record.linkClaimId, 'link claim id'),
    issuedAt: requireTimestamp(record.issuedAt, 'daemon binding issued-at'),
  };
}

function validateRevocationPayload(value: unknown): DelegationRevocationPayload {
  const record = requireRecord(value, 'delegation revocation payload');
  requireExactKeys(record, [
    'userId',
    'rootKeyCommitment',
    'actorDelegationId',
    'targets',
    'issuedAt',
    'nonce',
  ]);
  if (!Array.isArray(record.targets) || record.targets.length === 0 || record.targets.length > 32) {
    throw new Error('delegation revocation targets must contain 1 to 32 entries');
  }
  const targets = record.targets.map((target): DelegationRevocationTarget => {
    const item = requireRecord(target, 'delegation revocation target');
    requireExactKeys(item, ['delegationId', 'expiresAt']);
    return {
      delegationId: requireId(item.delegationId, 'target delegation id'),
      expiresAt: requireTimestamp(item.expiresAt, 'target delegation expiry'),
    };
  });
  const sorted = [...targets].sort((left, right) =>
    left.delegationId < right.delegationId ? -1 : left.delegationId > right.delegationId ? 1 : 0,
  );
  if (targets.some((target, index) => target.delegationId !== sorted[index]?.delegationId)) {
    throw new Error('delegation revocation targets must be sorted');
  }
  if (new Set(targets.map((target) => target.delegationId)).size !== targets.length) {
    throw new Error('delegation revocation targets must be unique');
  }
  return {
    userId: requireId(record.userId, 'user id'),
    rootKeyCommitment: encodeBase64Url(
      requireBase64Url(
        record.rootKeyCommitment,
        USER_AUTHORIZATION_HASH_BYTES,
        'root key commitment',
      ),
    ),
    actorDelegationId: requireId(record.actorDelegationId, 'actor delegation id'),
    targets,
    issuedAt: requireTimestamp(record.issuedAt, 'revocation issued-at'),
    nonce: encodeBase64Url(
      requireBase64Url(record.nonce, USER_AUTHORIZATION_NONCE_BYTES, 'revocation nonce'),
    ),
  };
}

function validateAccountDeletionPayload(value: unknown): AccountDeletionPayload {
  const record = requireRecord(value, 'account deletion payload');
  requireExactKeys(record, ['userId', 'rootKeyCommitment', 'rootEpoch', 'issuedAt', 'nonce']);
  return {
    userId: requireId(record.userId, 'user id'),
    rootKeyCommitment: encodeBase64Url(
      requireBase64Url(
        record.rootKeyCommitment,
        USER_AUTHORIZATION_HASH_BYTES,
        'root key commitment',
      ),
    ),
    rootEpoch: requirePositiveInteger(record.rootEpoch, 'root epoch'),
    issuedAt: requireTimestamp(record.issuedAt, 'account deletion issued-at'),
    nonce: encodeBase64Url(
      requireBase64Url(record.nonce, USER_AUTHORIZATION_NONCE_BYTES, 'account deletion nonce'),
    ),
  };
}

function validateDaemonLinkPublicClaimPayload(value: unknown): DaemonLinkPublicClaimPayload {
  const record = requireRecord(value, 'daemon link public claim payload');
  requireExactKeys(record, [
    'linkClaimId',
    'daemonId',
    'daemonIdentityPublicKey',
    'daemonIdentityP256PublicKey',
    'daemonIdentityKeyCommitment',
    'name',
    'platform',
    'identitySealBackend',
  ]);
  const daemonIdentityPublicKeyBytes = requireBase64Url(
    record.daemonIdentityPublicKey,
    USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
    'daemon identity public key',
  );
  const daemonIdentityP256PublicKeyBytes = requireBase64Url(
    record.daemonIdentityP256PublicKey,
    65,
    'daemon P-256 public key',
  );
  const daemonIdentityP256PublicKey = encodeBase64Url(daemonIdentityP256PublicKeyBytes);
  if (!isDaemonIdentitySealBackend(record.identitySealBackend))
    throw new Error('Invalid identity seal backend');
  const daemonIdentityPublicKey = encodeBase64Url(daemonIdentityPublicKeyBytes);
  const daemonIdentityKeyCommitment = encodeBase64Url(
    requireBase64Url(
      record.daemonIdentityKeyCommitment,
      USER_AUTHORIZATION_HASH_BYTES,
      'daemon identity key commitment',
    ),
  );
  if (
    deriveDaemonIdentityKeyCommitment(
      daemonIdentityPublicKeyBytes,
      daemonIdentityP256PublicKeyBytes,
    ) !== daemonIdentityKeyCommitment
  ) {
    throw new Error('daemon identity key commitment does not match its public key');
  }
  return {
    linkClaimId: requireId(record.linkClaimId, 'link claim id'),
    daemonId: requireId(record.daemonId, 'daemon id'),
    daemonIdentityPublicKey,
    daemonIdentityP256PublicKey,
    daemonIdentityKeyCommitment,
    name: requireDisplayField(record.name, 'daemon name', 128),
    platform: requireDisplayField(record.platform, 'daemon platform', 64),
    identitySealBackend: record.identitySealBackend,
  };
}

function validateDaemonLinkApprovalPayload(value: unknown): DaemonLinkApprovalPayload {
  const record = requireRecord(value, 'daemon link approval payload');
  requireExactKeys(record, [
    'linkClaimId',
    'claimCommitment',
    'userRootPublicKey',
    'rootEpoch',
    'daemonBinding',
  ]);
  return {
    linkClaimId: requireId(record.linkClaimId, 'link claim id'),
    claimCommitment: encodeBase64Url(
      requireBase64Url(
        record.claimCommitment,
        USER_AUTHORIZATION_HASH_BYTES,
        'daemon link claim commitment',
      ),
    ),
    userRootPublicKey: encodeBase64Url(
      requireBase64Url(
        record.userRootPublicKey,
        USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
        'user root public key',
      ),
    ),
    rootEpoch: requirePositiveInteger(record.rootEpoch, 'root epoch'),
    daemonBinding: parseDaemonBinding(record.daemonBinding),
  };
}

function delegationPayloadOf(certificate: UserDelegationCertificate): UserDelegationPayload {
  return {
    userId: certificate.userId,
    rootKeyCommitment: certificate.rootKeyCommitment,
    delegationId: certificate.delegationId,
    delegatePublicKey: certificate.delegatePublicKey,
    scopes: FIXED_DELEGATION_SCOPES,
    serverOrigin: certificate.serverOrigin,
    rootEpoch: certificate.rootEpoch,
    issuedAt: certificate.issuedAt,
    expiresAt: certificate.expiresAt,
  };
}

function daemonBindingPayloadOf(binding: DaemonBinding): DaemonBindingPayload {
  return {
    userId: binding.userId,
    rootKeyCommitment: binding.rootKeyCommitment,
    daemonId: binding.daemonId,
    daemonIdentityKeyCommitment: binding.daemonIdentityKeyCommitment,
    serverOrigin: binding.serverOrigin,
    linkClaimId: binding.linkClaimId,
    issuedAt: binding.issuedAt,
  };
}

function revocationPayloadOf(
  statement: DelegationRevocationStatement,
): DelegationRevocationPayload {
  return {
    userId: statement.userId,
    rootKeyCommitment: statement.rootKeyCommitment,
    actorDelegationId: statement.actorDelegationId,
    targets: statement.targets,
    issuedAt: statement.issuedAt,
    nonce: statement.nonce,
  };
}

function accountDeletionPayloadOf(statement: AccountDeletionStatement): AccountDeletionPayload {
  return {
    userId: statement.userId,
    rootKeyCommitment: statement.rootKeyCommitment,
    rootEpoch: statement.rootEpoch,
    issuedAt: statement.issuedAt,
    nonce: statement.nonce,
  };
}

function daemonLinkApprovalPayloadOf(approval: DaemonLinkApproval): DaemonLinkApprovalPayload {
  return {
    linkClaimId: approval.linkClaimId,
    claimCommitment: approval.claimCommitment,
    userRootPublicKey: approval.userRootPublicKey,
    rootEpoch: approval.rootEpoch,
    daemonBinding: approval.daemonBinding,
  };
}

function signBytes(
  message: Uint8Array,
  key: MlDsa87SigningKey,
  context: Uint8Array,
  signingEntropy?: Uint8Array,
): Uint8Array {
  const entropy = signingEntropy ?? randomSigningEntropy();
  requireLength(entropy, USER_AUTHORIZATION_SEED_BYTES, 'ML-DSA-87 signing entropy');
  try {
    const signature = key.sign(context, message, entropy);
    requireLength(signature, USER_AUTHORIZATION_SIGNATURE_BYTES, 'ML-DSA-87 signature');
    return signature;
  } finally {
    if (signingEntropy === undefined) entropy.fill(0);
  }
}

function randomSigningEntropy(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(USER_AUTHORIZATION_SEED_BYTES));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`object must contain exact canonical fields: ${expected.join(',')}`);
  }
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !PROTOCOL_ID_PATTERN.test(value)) {
    throw new Error(`${label} must use the canonical protocol id alphabet`);
  }
  if (TEXT_ENCODER.encode(value).byteLength > MAX_ID_BYTES) throw new Error(`${label} is too long`);
  return value;
}

function requireOrigin(value: unknown): string {
  if (typeof value !== 'string' || TEXT_ENCODER.encode(value).byteLength > MAX_ORIGIN_BYTES) {
    throw new Error('server origin is invalid');
  }
  const url = new URL(value);
  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.origin !== value || (url.protocol !== 'https:' && !isLoopback)) {
    throw new Error('server origin must be a canonical secure origin');
  }
  return value;
}

function requireDisplayField(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    TEXT_ENCODER.encode(value).byteLength > maxBytes
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireLength(value: Uint8Array, expected: number, label: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== expected) {
    throw new Error(`${label} must be exactly ${expected} bytes`);
  }
}

function requireBase64Url(value: unknown, expectedLength: number, label: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || !BASE64URL_PATTERN.test(value)) {
    throw new Error(`${label} is not canonical unpadded base64url`);
  }
  const decoded = decodeBase64Url(value);
  if (decoded.byteLength !== expectedLength || encodeBase64Url(decoded) !== value) {
    throw new Error(`${label} is not canonical unpadded base64url of ${expectedLength} bytes`);
  }
  return decoded;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat(
    (4 - (value.length % 4)) % 4,
  )}`;
  const binary = atob(padded);
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    decoded[index] = binary.charCodeAt(index);
  }
  return decoded;
}

function encodeU64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('length is invalid');
  const encoded = new Uint8Array(8);
  new DataView(encoded.buffer).setBigUint64(0, BigInt(value), false);
  return encoded;
}

function concatBytes(...values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

/** Compares in time that depends on the length alone, never on where the bytes differ. */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
