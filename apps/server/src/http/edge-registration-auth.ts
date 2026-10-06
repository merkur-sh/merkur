import { timingSafeEqual } from 'node:crypto';
import { Clock, Data, Effect } from 'effect';

export const EDGE_REGISTRATION_METHOD = 'POST';
export const EDGE_REGISTRATION_PATH = '/api/edge/register';
export const EDGE_ID_HEADER = 'x-merkur-edge-id';
export const EDGE_TIMESTAMP_HEADER = 'x-merkur-edge-timestamp';
export const EDGE_NONCE_HEADER = 'x-merkur-edge-nonce';
export const EDGE_AUTH_HEADER = 'x-merkur-edge-auth';

const EDGE_REGISTRATION_AUTH_DOMAIN = 'merkur-edge-registration-auth';
const EDGE_REGISTRATION_CLOCK_SKEW_MS = 60_000;
const EDGE_REGISTRATION_KEY_BYTES = 64;
const EDGE_REGISTRATION_NONCE_BYTES = 32;
const EDGE_REGISTRATION_TAG_BYTES = 64;
const EDGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^(?:0|[1-9]\d{0,15})$/;
const CANONICAL_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface EdgeRegistrationPayload {
  readonly edgeId: string;
  readonly edgeRegion: string;
  readonly edgeWtUrl: string;
  readonly certHash: string;
  readonly certHashes: readonly string[];
}

export interface EdgeRegistrationAuthenticationInput {
  readonly method: string;
  readonly path: string;
  readonly edgeId: string | null;
  readonly timestamp: string | null;
  readonly nonce: string | null;
  readonly authentication: string | null;
  readonly payload: EdgeRegistrationPayload;
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

export interface AuthenticatedEdgeRegistration {
  readonly edgeId: string;
  readonly nonce: string;
}

export class EdgeRegistrationAuthenticationError extends Data.TaggedError(
  'EdgeRegistrationAuthenticationError',
)<{
  readonly reason: 'missing' | 'malformed' | 'stale' | 'unknown-edge' | 'edge-mismatch' | 'invalid';
}> {}

/**
 * Authenticate one control-plane registration. Time comes from Effect's Clock
 * so tests and request interruption retain the same ownership as the route.
 */
export const authenticateEdgeRegistration = Effect.fn('authenticateEdgeRegistration')(function* (
  input: EdgeRegistrationAuthenticationInput,
): Effect.fn.Return<AuthenticatedEdgeRegistration, EdgeRegistrationAuthenticationError> {
  const { edgeId, timestamp, nonce, authentication } = input;
  if (edgeId === null || timestamp === null || nonce === null || authentication === null) {
    return yield* new EdgeRegistrationAuthenticationError({ reason: 'missing' });
  }
  if (
    input.method !== EDGE_REGISTRATION_METHOD ||
    input.path !== EDGE_REGISTRATION_PATH ||
    !EDGE_ID_PATTERN.test(edgeId) ||
    !CANONICAL_TIMESTAMP_PATTERN.test(timestamp)
  ) {
    return yield* new EdgeRegistrationAuthenticationError({ reason: 'malformed' });
  }

  const timestampMs = Number(timestamp);
  const now = yield* Clock.currentTimeMillis;
  if (
    !Number.isSafeInteger(timestampMs) ||
    timestamp !== String(timestampMs) ||
    Math.abs(now - timestampMs) > EDGE_REGISTRATION_CLOCK_SKEW_MS
  ) {
    return yield* new EdgeRegistrationAuthenticationError({ reason: 'stale' });
  }
  const nonceBytes = decodeCanonicalBase64Url(nonce, EDGE_REGISTRATION_NONCE_BYTES);
  const presentedTag = decodeCanonicalBase64Url(authentication, EDGE_REGISTRATION_TAG_BYTES);
  if (nonceBytes === null || presentedTag === null) {
    return yield* new EdgeRegistrationAuthenticationError({ reason: 'malformed' });
  }
  if (input.payload.edgeId !== edgeId) {
    return yield* new EdgeRegistrationAuthenticationError({ reason: 'edge-mismatch' });
  }
  const key = input.keys.get(edgeId);
  if (key === undefined || key.byteLength !== EDGE_REGISTRATION_KEY_BYTES) {
    return yield* new EdgeRegistrationAuthenticationError({ reason: 'unknown-edge' });
  }

  const expectedTag = computeEdgeRegistrationAuthentication({
    key,
    edgeId,
    method: input.method,
    path: input.path,
    timestamp,
    nonce: nonceBytes,
    payload: input.payload,
  });
  if (!timingSafeEqual(presentedTag, expectedTag)) {
    return yield* new EdgeRegistrationAuthenticationError({ reason: 'invalid' });
  }
  return { edgeId, nonce };
});

export function computeEdgeRegistrationAuthentication(input: {
  readonly key: Uint8Array;
  readonly edgeId: string;
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: Uint8Array;
  readonly payload: EdgeRegistrationPayload;
}): Buffer {
  const payloadHash = Bun.CryptoHasher.hash(
    'sha512',
    encodeCanonicalEdgeRegistration(input.payload),
  );
  const authenticated = Buffer.concat([
    lengthPrefix(Buffer.from(EDGE_REGISTRATION_AUTH_DOMAIN, 'utf8')),
    lengthPrefix(Buffer.from(input.edgeId, 'utf8')),
    lengthPrefix(Buffer.from(input.method, 'ascii')),
    lengthPrefix(Buffer.from(input.path, 'ascii')),
    lengthPrefix(Buffer.from(input.timestamp, 'ascii')),
    lengthPrefix(input.nonce),
    lengthPrefix(payloadHash),
  ]);
  return new Bun.CryptoHasher('sha512', input.key).update(authenticated).digest();
}

export function encodeCanonicalEdgeRegistration(payload: EdgeRegistrationPayload): Buffer {
  return Buffer.from(
    JSON.stringify({
      edgeId: payload.edgeId,
      edgeRegion: payload.edgeRegion,
      edgeWtUrl: payload.edgeWtUrl,
      certHash: payload.certHash,
      certHashes: payload.certHashes,
    }),
    'utf8',
  );
}

function lengthPrefix(value: Uint8Array): Buffer {
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(value.byteLength);
  return Buffer.concat([prefix, value]);
}

function decodeCanonicalBase64Url(value: string, expectedBytes: number): Buffer | null {
  if (!CANONICAL_BASE64URL_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === expectedBytes && decoded.toString('base64url') === value
    ? decoded
    : null;
}
