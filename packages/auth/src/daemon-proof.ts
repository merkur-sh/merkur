import {
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { e2eWasm } from '@merkur/shared/e2e-wasm-runtime';
import type { MlDsa87SigningKey } from '../../e2e-wasm/pkg/e2e_wasm.js';

export const DAEMON_PROOF_MAX_AGE_MS = 60_000;
export const DAEMON_PROOF_CLOCK_SKEW_MS = 30_000;
export const DAEMON_PROOF_REPLAY_TTL_MS = 121_000;
export const MAX_DAEMON_HTTP_BODY_BYTES = 4 * 1024 * 1024;
const ENCODER = new TextEncoder();
const CONTEXTS = {
  http: ENCODER.encode('merkur-daemon-http'),
  control: ENCODER.encode('merkur-daemon-control'),
};

export function daemonBodyDigest(bytes: Uint8Array): string {
  return createHash('sha512').update(bytes).digest('base64url');
}

export function createDaemonNonce(): string {
  return randomBytes(32).toString('base64url');
}

function canonicalBytes(value: string, length: number): Buffer {
  if (value.length !== Math.ceil((length * 4) / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid daemon proof encoding');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) {
    throw new Error('Invalid daemon proof encoding');
  }
  return bytes;
}

function requireDaemonId(daemonId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(daemonId)) throw new Error('Invalid daemon id');
}

function requireUrl(value: string): void {
  const url = new URL(value);
  if (
    url.href !== value ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    (url.protocol !== 'https:' && url.protocol !== 'http:')
  )
    throw new Error('Invalid daemon proof destination');
}

export interface DaemonHttpProof {
  readonly daemonId: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly signature: string;
  readonly p256Signature: string;
}

export function daemonHttpTranscript(
  proof: Omit<DaemonHttpProof, 'signature' | 'p256Signature'>,
  method: string,
  url: string,
  contentType: string,
  bodyDigest: string,
): Uint8Array {
  requireDaemonId(proof.daemonId);
  requireUrl(url);
  canonicalBytes(proof.nonce, 32);
  canonicalBytes(bodyDigest, 64);
  if (!Number.isSafeInteger(proof.timestamp) || proof.timestamp < 0 || !/^[A-Z]+$/.test(method)) {
    throw new Error('Invalid daemon HTTP proof');
  }
  // Ordered, length-unambiguous framing. Bind content type as well as exact bytes:
  // identical bytes interpreted by a different parser are a different request.
  return ENCODER.encode(
    JSON.stringify([
      proof.daemonId,
      method,
      url,
      contentType,
      bodyDigest,
      proof.timestamp,
      proof.nonce,
    ]),
  );
}

export function daemonControlTranscript(
  daemonId: string,
  url: string,
  daemonVersion: string,
  resumePresenceId: string | null,
  nonce: string,
): Uint8Array {
  requireDaemonId(daemonId);
  requireUrl(url);
  canonicalBytes(nonce, 32);
  return ENCODER.encode(JSON.stringify([daemonId, url, daemonVersion, resumePresenceId, nonce]));
}

export interface DaemonSignaturePair {
  readonly mldsa: string;
  readonly p256: string;
}

const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function scalar(bytes: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
}

function p256Preimage(context: Uint8Array, transcript: Uint8Array): Buffer {
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(transcript.byteLength));
  return Buffer.concat([context, size, transcript]);
}

function softwareP256Secret(seed: Uint8Array): Buffer {
  const domain = Buffer.from('merkur-daemon-identity-p256\0');
  const counterBytes = Buffer.alloc(4);
  for (let counter = 0; counter <= 0xffff_ffff; counter += 1) {
    counterBytes.writeUInt32BE(counter);
    const candidate = Buffer.from(
      hkdfSync('sha512', seed, Buffer.alloc(0), Buffer.concat([domain, counterBytes]), 32),
    );
    const value = scalar(candidate);
    if (value > 0n && value < P256_ORDER) return candidate;
    candidate.fill(0);
  }
  throw new Error('P-256 scalar derivation failed');
}

/** Software identity fixtures only; production signing is owned by Rust. */
export function deriveSoftwareDaemonP256PublicKey(seed: Uint8Array): Uint8Array {
  const secret = softwareP256Secret(seed);
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(secret);
    return ecdh.getPublicKey(undefined, 'uncompressed');
  } finally {
    secret.fill(0);
  }
}

function p256Jwk(bytes: Uint8Array) {
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('Invalid P-256 public key');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: Buffer.from(bytes.subarray(1, 33)).toString('base64url'),
    y: Buffer.from(bytes.subarray(33)).toString('base64url'),
  };
}

/** Fixture-only signer. No daemon runtime module may import this function. */
export function signDaemonProof(
  seedEncoded: string,
  purpose: keyof typeof CONTEXTS,
  transcript: Uint8Array,
): DaemonSignaturePair {
  const seed = canonicalBytes(seedEncoded, 32);
  const entropy = randomBytes(32);
  let key: MlDsa87SigningKey | undefined;
  try {
    key = e2eWasm().MlDsa87SigningKey.fromSeed(seed);
    const mldsa = Buffer.from(key.sign(CONTEXTS[purpose], transcript, entropy)).toString(
      'base64url',
    );
    return {
      mldsa,
      p256: Buffer.from(signSoftwareDaemonP256Proof(seed, CONTEXTS[purpose], transcript)).toString(
        'base64url',
      ),
    };
  } finally {
    seed.fill(0);
    entropy.fill(0);
    key?.free();
  }
}

/** Fixture-only P-256 signer shared by native/WASM interoperability tests. */
export function signSoftwareDaemonP256Proof(
  seed: Uint8Array,
  context: Uint8Array,
  transcript: Uint8Array,
): Uint8Array {
  const secret = softwareP256Secret(seed);
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(secret);
    const key = createPrivateKey({
      format: 'jwk',
      key: {
        ...p256Jwk(ecdh.getPublicKey(undefined, 'uncompressed')),
        d: secret.toString('base64url'),
      },
    });
    const signature = sign('sha256', p256Preimage(context, transcript), {
      key,
      dsaEncoding: 'ieee-p1363',
    });
    const s = scalar(signature.subarray(32));
    if (s > P256_ORDER / 2n)
      Buffer.from((P256_ORDER - s).toString(16).padStart(64, '0'), 'hex').copy(signature, 32);
    return signature;
  } finally {
    secret.fill(0);
  }
}

export function verifyDaemonProof(
  publicKey: string,
  p256PublicKey: string,
  purpose: keyof typeof CONTEXTS,
  transcript: Uint8Array,
  signature: string,
  p256Signature: string,
): boolean {
  try {
    const raw = canonicalBytes(p256Signature, 64);
    const s = scalar(raw.subarray(32));
    if (s === 0n || s > P256_ORDER / 2n) return false;
    const key = createPublicKey({ format: 'jwk', key: p256Jwk(canonicalBytes(p256PublicKey, 65)) });
    return (
      verify(
        'sha256',
        p256Preimage(CONTEXTS[purpose], transcript),
        { key, dsaEncoding: 'ieee-p1363' },
        raw,
      ) &&
      e2eWasm().mlDsa87Verify(
        canonicalBytes(publicKey, 2592),
        CONTEXTS[purpose],
        transcript,
        canonicalBytes(signature, 4627),
      )
    );
  } catch {
    return false;
  }
}

export async function daemonHttpProofHeaders(
  daemonId: string,
  signTranscript: (transcript: Uint8Array) => Promise<DaemonSignaturePair>,
  method: string,
  url: string,
  contentType: string,
  body: Uint8Array,
  timestamp: number,
): Promise<Record<string, string>> {
  const proof = { daemonId, timestamp, nonce: createDaemonNonce() };
  const transcript = daemonHttpTranscript(proof, method, url, contentType, daemonBodyDigest(body));
  const signature = await signTranscript(transcript);
  return {
    'x-merkur-daemon-id': daemonId,
    'x-merkur-timestamp': String(timestamp),
    'x-merkur-nonce': proof.nonce,
    'x-merkur-signature': signature.mldsa,
    'x-merkur-signature-p256': signature.p256,
  };
}

export function parseDaemonHttpProof(headers: Headers, now: number): DaemonHttpProof | null {
  try {
    // The retired bearer path is rejected, even alongside a valid proof.
    if (headers.has('authorization') || headers.has('content-encoding')) return null;
    const daemonId = headers.get('x-merkur-daemon-id') ?? '';
    const time = headers.get('x-merkur-timestamp') ?? '';
    const timestamp = Number(time);
    const nonce = headers.get('x-merkur-nonce') ?? '';
    const signature = headers.get('x-merkur-signature') ?? '';
    const p256Signature = headers.get('x-merkur-signature-p256') ?? '';
    requireDaemonId(daemonId);
    canonicalBytes(nonce, 32);
    canonicalBytes(signature, 4627);
    canonicalBytes(p256Signature, 64);
    if (
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0 ||
      String(timestamp) !== time ||
      !Number.isSafeInteger(now) ||
      timestamp > now + DAEMON_PROOF_CLOCK_SKEW_MS ||
      now - timestamp >= DAEMON_PROOF_MAX_AGE_MS
    )
      return null;
    return { daemonId, timestamp, nonce, signature, p256Signature };
  } catch {
    return null;
  }
}

/** Authentication frames precede the registered control protocol. */
export function parseDaemonChallenge(value: unknown): string | null {
  return parseAuthFrame(value, 'auth_challenge', 'nonce', 32);
}

export function parseDaemonControlSignature(value: unknown): DaemonSignaturePair | null {
  try {
    if (typeof value === 'string') {
      if (value.length > 8192) return null;
      value = JSON.parse(value);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3 ||
      record.type !== 'auth_proof' ||
      typeof record.signature !== 'string' ||
      typeof record.p256_signature !== 'string'
    )
      return null;
    canonicalBytes(record.signature, 4627);
    canonicalBytes(record.p256_signature, 64);
    return { mldsa: record.signature, p256: record.p256_signature };
  } catch {
    return null;
  }
}

function parseAuthFrame(
  value: unknown,
  type: string,
  field: string,
  length: number,
): string | null {
  try {
    if (typeof value === 'string') {
      if (value.length > 8192) return null;
      value = JSON.parse(value);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      record.type !== type ||
      typeof record[field] !== 'string'
    ) {
      return null;
    }
    const encoded = record[field];
    canonicalBytes(encoded, length);
    return encoded;
  } catch {
    return null;
  }
}
