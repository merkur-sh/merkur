import { randomBytes } from 'node:crypto';
import { e2eWasm } from '@merkur/shared/e2e-wasm-runtime';
import type { MlDsa87SigningKey } from '../../e2e-wasm/pkg/e2e_wasm.js';

export type { MlDsa87SigningKey };

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const PROTOCOL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

/** FIPS 204 context shared verbatim with the daemon verifier. */
export const SESSION_AUTHORIZATION_CONTEXT = TEXT_ENCODER.encode('merkur-session-authorization');
export const SESSION_AUTHORIZATION_SEED_BYTES = 32;
export const SESSION_AUTHORIZATION_PUBLIC_KEY_BYTES = 2_592;
export const SESSION_AUTHORIZATION_SIGNATURE_BYTES = 4_627;
export const SESSION_AUTHORIZATION_MAX_LIFETIME_MS = 300_000;
export const DAEMON_IDENTITY_PUBLIC_KEY_BYTES = SESSION_AUTHORIZATION_PUBLIC_KEY_BYTES;
export const DAEMON_IDENTITY_P256_PUBLIC_KEY_BYTES = 65;
export const SESSION_REQUEST_CLIENT_NONCE_BYTES = 32;
export const SESSION_REQUEST_ENCAPSULATION_KEY_BYTES = 1_568;
export const SESSION_AUTHORIZATION_COMMITMENT_BYTES = 64;

const MAX_ID_BYTES = 128;

export interface SessionAuthorizationKeyPair {
  /** Expanded key in WebAssembly memory, held for the server's lifetime. */
  readonly signingKey: MlDsa87SigningKey;
  readonly verifyKey: Uint8Array;
}

export interface SessionAuthorizationPayload {
  readonly u: string;
  readonly g: string;
  readonly b: string;
  readonly d: string;
  readonly s: string;
  readonly k: string;
  readonly q: string;
  readonly iat: number;
  readonly e: number;
}

export interface CreateSessionAuthorizationTokenInput {
  readonly userId: string;
  readonly delegationId: string;
  readonly browserNodeId: string;
  readonly daemonId: string;
  readonly sessionId: string;
  readonly daemonIdentityKeyCommitment: string;
  readonly sessionRequestCommitment: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly signingKey: MlDsa87SigningKey;
}

/** Bind a session capability to the exact linked daemon ML-DSA-87 identity key. */
export function deriveDaemonIdentityKeyCommitment(
  publicKey: Uint8Array,
  p256PublicKey: Uint8Array,
): string {
  requireExactBytes(publicKey, DAEMON_IDENTITY_PUBLIC_KEY_BYTES, 'daemon identity public key');
  requireExactBytes(
    p256PublicKey,
    DAEMON_IDENTITY_P256_PUBLIC_KEY_BYTES,
    'daemon P-256 public key',
  );
  return encodeBase64Url(e2eWasm().computeDaemonIdentityKeyHash(publicKey, p256PublicKey));
}

/**
 * Bind a session capability to the browser's one-use ML-KEM-1024 bootstrap.
 * Both inputs have fixed lengths, so the concatenation is unambiguous without
 * adding variable-length framing to the daemon verifier.
 */
export function deriveSessionRequestCommitment(
  clientNonce: Uint8Array,
  encapsulationKey: Uint8Array,
): string {
  requireExactBytes(clientNonce, SESSION_REQUEST_CLIENT_NONCE_BYTES, 'session client nonce');
  requireExactBytes(
    encapsulationKey,
    SESSION_REQUEST_ENCAPSULATION_KEY_BYTES,
    'ML-KEM-1024 encapsulation key',
  );
  return encodeBase64Url(e2eWasm().computeSessionRequestCommitment(clientNonce, encapsulationKey));
}

export function deriveSessionAuthorizationKeyPair(seed: Uint8Array): SessionAuthorizationKeyPair {
  requireExactBytes(seed, SESSION_AUTHORIZATION_SEED_BYTES, 'session authorization seed');
  const signingKey = e2eWasm().MlDsa87SigningKey.fromSeed(seed);
  const verifyKey = signingKey.publicKey;
  requireExactBytes(verifyKey, SESSION_AUTHORIZATION_PUBLIC_KEY_BYTES, 'ML-DSA-87 public key');
  return { signingKey, verifyKey };
}

/**
 * Create the fixed Merkur session-authorization token. The signature covers
 * the canonical, unpadded base64url payload segment exactly as transported.
 * ML-DSA signing is hedged with fresh 32-byte entropy for every authorization.
 */
export function createSessionAuthorizationToken(
  input: CreateSessionAuthorizationTokenInput,
): string {
  const payload = validatePayload({
    u: input.userId,
    g: input.delegationId,
    b: input.browserNodeId,
    d: input.daemonId,
    s: input.sessionId,
    k: input.daemonIdentityKeyCommitment,
    q: input.sessionRequestCommitment,
    iat: input.issuedAtMs,
    e: input.expiresAtMs,
  });
  const payloadSegment = encodeBase64Url(TEXT_ENCODER.encode(JSON.stringify(payload)));
  const entropy = randomBytes(32);
  try {
    const signature = input.signingKey.sign(
      SESSION_AUTHORIZATION_CONTEXT,
      TEXT_ENCODER.encode(payloadSegment),
      entropy,
    );
    requireExactBytes(signature, SESSION_AUTHORIZATION_SIGNATURE_BYTES, 'ML-DSA-87 signature');
    return `${payloadSegment}.${encodeBase64Url(signature)}`;
  } finally {
    entropy.fill(0);
  }
}

/** Strict verifier used by TypeScript tests and tooling; the daemon owns live verification. */
export function verifySessionAuthorizationToken(
  token: string,
  verifyKey: Uint8Array,
  nowMs: number,
): SessionAuthorizationPayload | null {
  try {
    requireExactBytes(verifyKey, SESSION_AUTHORIZATION_PUBLIC_KEY_BYTES, 'ML-DSA-87 public key');
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) return null;
    const segments = token.split('.');
    if (segments.length !== 2) return null;
    const [payloadSegment, signatureSegment] = segments;
    if (payloadSegment === undefined || signatureSegment === undefined) return null;

    const payloadBytes = decodeCanonicalBase64Url(payloadSegment);
    const signature = decodeCanonicalBase64Url(signatureSegment);
    if (payloadBytes === null || signature === null) return null;
    if (signature.byteLength !== SESSION_AUTHORIZATION_SIGNATURE_BYTES) return null;

    const parsed: unknown = JSON.parse(TEXT_DECODER.decode(payloadBytes));
    if (!isRecord(parsed)) return null;
    const payload = validatePayload(parsed);
    if (encodeBase64Url(TEXT_ENCODER.encode(JSON.stringify(payload))) !== payloadSegment)
      return null;
    if (nowMs >= payload.e) return null;

    return e2eWasm().mlDsa87Verify(
      verifyKey,
      SESSION_AUTHORIZATION_CONTEXT,
      TEXT_ENCODER.encode(payloadSegment),
      signature,
    )
      ? payload
      : null;
  } catch {
    return null;
  }
}

function validatePayload(value: Record<string, unknown>): SessionAuthorizationPayload {
  const keys = Object.keys(value);
  if (
    keys.length !== 9 ||
    keys[0] !== 'u' ||
    keys[1] !== 'g' ||
    keys[2] !== 'b' ||
    keys[3] !== 'd' ||
    keys[4] !== 's' ||
    keys[5] !== 'k' ||
    keys[6] !== 'q' ||
    keys[7] !== 'iat' ||
    keys[8] !== 'e'
  ) {
    throw new Error('session authorization payload must contain the exact canonical fields');
  }
  const u = requireId(value.u, 'user id');
  const g = requireId(value.g, 'delegation id');
  const b = requireId(value.b, 'browser node id');
  const d = requireId(value.d, 'daemon id');
  const s = requireId(value.s, 'session id');
  const k = requireCommitment(value.k, 'daemon identity key commitment');
  const q = requireCommitment(value.q, 'session request commitment');
  const iat = requireTimestamp(value.iat, 'issued-at timestamp');
  const e = requireTimestamp(value.e, 'expiry timestamp');
  if (e <= iat || e - iat > SESSION_AUTHORIZATION_MAX_LIFETIME_MS) {
    throw new Error('session authorization lifetime is invalid');
  }
  return { u, g, b, d, s, k, q, iat, e };
}

function requireCommitment(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be canonical base64url`);
  }
  const decoded = decodeCanonicalBase64Url(value);
  if (decoded === null || decoded.byteLength !== SESSION_AUTHORIZATION_COMMITMENT_BYTES) {
    throw new Error(`${label} must be exactly ${SESSION_AUTHORIZATION_COMMITMENT_BYTES} bytes`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !PROTOCOL_ID_PATTERN.test(value)) {
    throw new Error(`${label} must use the canonical protocol id alphabet`);
  }
  if (TEXT_ENCODER.encode(value).byteLength > MAX_ID_BYTES) {
    throw new Error(`${label} exceeds ${MAX_ID_BYTES} UTF-8 bytes`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireExactBytes(value: Uint8Array, expectedLength: number, label: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== expectedLength) {
    throw new Error(`${label} must be exactly ${expectedLength} bytes`);
  }
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function decodeCanonicalBase64Url(value: string): Uint8Array | null {
  if (value.length === 0 || !BASE64URL_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? new Uint8Array(decoded) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
