import { createHmac, timingSafeEqual } from 'node:crypto';
import { hasExactKeys } from '@merkur/shared/parsing';
import { customAlphabet, nanoid } from 'nanoid';

export * from './daemon-proof';
export * from './opaque';
export * from './session-authorization';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const LINK_TOKEN_TTL_MS = 5 * 60 * 1_000;
const TOKEN_ID_LENGTH = 21;
const HIGH_ENTROPY_TOKEN_LENGTH = 64;
const ACCESS_TOKEN_HMAC_KEY_BYTES = 64;
const ACCESS_TOKEN_TAG_BYTES = 64;
const ACCESS_TOKEN_MAX_BYTES = 4 * 1024;
const ACCESS_TOKEN_CLOCK_SKEW_SECONDS = 30;
const ACCESS_TOKEN_LABEL = 'merkur-access-token\0';
// Token storage is a symmetric boundary. SHA-512 preserves a 256-bit
// post-quantum brute-force floor for full-entropy keys and keeps every stored
// verifier fixed-width; this database is hard-cut with the protocol.
const HMAC_ALGORITHM = 'sha512';
const LINK_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
// A link claim bootstraps a long-lived machine credential. Keep the copy/paste
// alphabet, but give the one-time claim a full 256-bit brute-force floor.
const LINK_TOKEN_LENGTH = 52;
const EMPTY_HEX = '';
const HEX_ENCODING = 'hex';
const MILLISECONDS_PER_SECOND = 1_000;

const linkTokenGenerator = customAlphabet(LINK_ALPHABET, LINK_TOKEN_LENGTH);
const REJECTED_ROTATION = { outcome: 'rejected' } as const;

export interface AccessTokenConfig {
  readonly hmacKey: Uint8Array;
  readonly issuer: string;
  readonly audience: string;
}

export interface RefreshTokenRecord {
  readonly id: string;
  /** Constant across every rotation of one login; the unit of revocation. */
  readonly familyId: string;
  readonly userId: string;
  /** Browser delegation that owns this refresh family. */
  readonly delegationId: string;
  readonly tokenHash: string;
  readonly expiresAt: number;
  /** Set once the token has been spent on a rotation; null while it is live. */
  readonly rotatedAt: number | null;
}

export interface RefreshTokenIssue {
  readonly record: RefreshTokenRecord;
  readonly token: string;
}

export interface LinkTokenIssue {
  readonly token: string;
  readonly expiresAt: number;
}

export interface RefreshTokenStore {
  findById(id: string): Promise<RefreshTokenRecord | null>;
  insert(record: RefreshTokenRecord): Promise<void>;
  markRotated(id: string, rotatedAt: number): Promise<void>;
  deleteById(id: string): Promise<void>;
  deleteByFamilyId(familyId: string): Promise<void>;
  deleteByDelegationId(delegationId: string): Promise<void>;
}

export interface VerifiedAccessToken {
  readonly userId: string;
  readonly delegationId: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
}

export type TokenHashDomain = 'refresh' | 'device-link' | 'daemon-link-poll';

export interface RotateRefreshTokenInput {
  readonly store: RefreshTokenStore;
  readonly refreshTokenId: string;
  readonly presentedToken: string;
  readonly hmacSecret: string;
  readonly now?: number;
}

/**
 * `reuse-detected` means an authentic but already-spent token was presented,
 * which is only possible if the chain leaked. The whole family is revoked
 * before the result is returned; callers should treat it as a security event
 * and still answer the request as unauthenticated.
 *
 * There is deliberately no grace period for a benign double-submit. The clients
 * that hold this credential are responsible for never presenting a spent token:
 * refreshes are serialized across tabs by a Web Lock, and a refresh whose
 * outcome is ambiguous (timeout, network failure, 5xx) retires the credential in
 * the browser rather than being retried. A spent token reaching this function is
 * therefore always treated as a compromise.
 */
export type RotateRefreshTokenResult =
  | {
      readonly outcome: 'rotated';
      readonly rotated: RefreshTokenIssue;
      readonly revokedTokenId: string;
    }
  | { readonly outcome: 'reuse-detected'; readonly userId: string; readonly familyId: string }
  | { readonly outcome: 'rejected' };

export function hashToken(token: string, hmacSecret: string, domain: TokenHashDomain): string {
  ensureNonEmpty(token, 'token');
  ensureNonEmpty(hmacSecret, 'hmacSecret');

  return createHmac(HMAC_ALGORITHM, hmacSecret)
    .update(`merkur-token-hash\0${domain}\0`, 'utf8')
    .update(token, 'utf8')
    .digest(HEX_ENCODING);
}

export function verifyToken(
  token: string,
  expectedHash: string,
  hmacSecret: string,
  domain: TokenHashDomain,
): boolean {
  ensureNonEmpty(token, 'token');
  ensureNonEmpty(expectedHash, 'expectedHash');
  ensureNonEmpty(hmacSecret, 'hmacSecret');

  const computedHash = hashToken(token, hmacSecret, domain);
  return secureHexEqual(computedHash, expectedHash);
}

export async function createAccessToken(
  userId: string,
  delegationId: string,
  absoluteExpiresAt: number,
  config: AccessTokenConfig,
  now: Date = new Date(),
): Promise<string> {
  ensureNonEmpty(userId, 'userId');
  ensureNonEmpty(delegationId, 'delegationId');
  requireAccessTokenConfig(config);
  const issuedAt = Math.floor(now.getTime() / MILLISECONDS_PER_SECOND);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    throw new Error('Access token issue time is invalid');
  }
  if (!Number.isSafeInteger(absoluteExpiresAt) || absoluteExpiresAt < 0) {
    throw new Error('Access token absolute expiry is invalid');
  }
  const expiresAt = Math.min(
    issuedAt + ACCESS_TOKEN_TTL_SECONDS,
    Math.floor(absoluteExpiresAt / MILLISECONDS_PER_SECOND),
  );
  if (expiresAt <= issuedAt) {
    throw new Error('Access token absolute expiry has elapsed');
  }
  const payload = {
    iss: config.issuer,
    aud: config.audience,
    sub: userId,
    dlg: delegationId,
    iat: issuedAt,
    exp: expiresAt,
  };
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const tag = accessTokenTag(payloadSegment, config.hmacKey).toString('base64url');
  return `${payloadSegment}.${tag}`;
}

/**
 * Thrown by {@link verifyAccessToken} when the token itself is malformed,
 * mis-signed, expired, or missing claims. Callers can treat this as "401
 * invalid token" while letting any other failure (key import, config)
 * propagate as an infrastructure error.
 */
export class AccessTokenInvalidError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AccessTokenInvalidError';
  }
}

export async function verifyAccessToken(
  token: string,
  config: AccessTokenConfig,
): Promise<VerifiedAccessToken> {
  if (token.trim().length === 0 || token.length > ACCESS_TOKEN_MAX_BYTES) {
    throw new AccessTokenInvalidError('token must not be empty');
  }
  requireAccessTokenConfig(config);
  const segments = token.split('.');
  if (segments.length !== 2) {
    throw new AccessTokenInvalidError('Access token shape is malformed');
  }
  const payloadSegment = segments[0] ?? '';
  const tagSegment = segments[1] ?? '';
  const payloadBytes = decodeCanonicalBase64Url(payloadSegment);
  const presentedTag = decodeCanonicalBase64Url(tagSegment);
  if (
    payloadBytes === null ||
    presentedTag === null ||
    presentedTag.byteLength !== ACCESS_TOKEN_TAG_BYTES
  ) {
    throw new AccessTokenInvalidError('Access token encoding is malformed');
  }
  const expectedTag = accessTokenTag(payloadSegment, config.hmacKey);
  if (!timingSafeEqual(presentedTag, expectedTag)) {
    throw new AccessTokenInvalidError('Access token failed authentication');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadBytes).toString('utf8'));
  } catch (error) {
    throw new AccessTokenInvalidError('Access token payload is malformed', { cause: error });
  }
  if (!hasExactKeys(payload, ['iss', 'aud', 'sub', 'dlg', 'iat', 'exp'])) {
    throw new AccessTokenInvalidError('Access token payload fields are malformed');
  }
  const { iss, aud, sub: userId, dlg: delegationId, iat: issuedAt, exp: expiresAt } = payload;
  if (
    iss !== config.issuer ||
    aud !== config.audience ||
    typeof userId !== 'string' ||
    userId.length === 0 ||
    typeof delegationId !== 'string' ||
    delegationId.length === 0 ||
    typeof issuedAt !== 'number' ||
    !Number.isSafeInteger(issuedAt) ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt < 0 ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > ACCESS_TOKEN_TTL_SECONDS
  ) {
    throw new AccessTokenInvalidError('Access token claims are invalid');
  }
  const canonicalPayload = Buffer.from(
    JSON.stringify({ iss, aud, sub: userId, dlg: delegationId, iat: issuedAt, exp: expiresAt }),
    'utf8',
  ).toString('base64url');
  if (canonicalPayload !== payloadSegment) {
    throw new AccessTokenInvalidError('Access token payload is not canonical');
  }
  const nowSeconds = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
  if (nowSeconds >= expiresAt || issuedAt > nowSeconds + ACCESS_TOKEN_CLOCK_SKEW_SECONDS) {
    throw new AccessTokenInvalidError('Access token is expired or not yet valid');
  }

  return {
    userId,
    delegationId,
    expiresAt: expiresAt * MILLISECONDS_PER_SECOND,
    issuedAt: issuedAt * MILLISECONDS_PER_SECOND,
  };
}

export function createRefreshToken(
  userId: string,
  delegationId: string,
  absoluteExpiresAt: number,
  hmacSecret: string,
  now: number = Date.now(),
): RefreshTokenIssue {
  return issueRefreshToken(
    userId,
    delegationId,
    nanoid(TOKEN_ID_LENGTH),
    absoluteExpiresAt,
    hmacSecret,
    now,
  );
}

function issueRefreshToken(
  userId: string,
  delegationId: string,
  familyId: string,
  absoluteExpiresAt: number,
  hmacSecret: string,
  now: number,
): RefreshTokenIssue {
  ensureNonEmpty(userId, 'userId');
  ensureNonEmpty(delegationId, 'delegationId');
  ensureNonEmpty(familyId, 'familyId');
  ensureNonEmpty(hmacSecret, 'hmacSecret');
  if (!Number.isSafeInteger(absoluteExpiresAt) || absoluteExpiresAt <= now) {
    throw new Error('Refresh token absolute expiry must be in the future');
  }

  const token = nanoid(HIGH_ENTROPY_TOKEN_LENGTH);
  const recordId = nanoid(TOKEN_ID_LENGTH);
  const tokenHash = hashToken(token, hmacSecret, 'refresh');

  return {
    token,
    record: {
      id: recordId,
      familyId,
      userId,
      delegationId,
      tokenHash,
      expiresAt: absoluteExpiresAt,
      rotatedAt: null,
    },
  };
}

export async function rotateRefreshToken(
  input: RotateRefreshTokenInput,
): Promise<RotateRefreshTokenResult> {
  const now = input.now ?? Date.now();
  const existingToken = await input.store.findById(input.refreshTokenId);

  if (existingToken === null) {
    return REJECTED_ROTATION;
  }

  // Authenticate the presented token before acting on the record at all, so
  // that knowing (or guessing) a token id alone can never expire or revoke
  // someone else's session.
  const isTokenValid = verifyToken(
    input.presentedToken,
    existingToken.tokenHash,
    input.hmacSecret,
    'refresh',
  );
  if (!isTokenValid) {
    return REJECTED_ROTATION;
  }

  // Authentic, but already spent on an earlier rotation. Either a thief is
  // replaying a captured token or the legitimate holder is presenting one
  // whose successor was stolen; both mean the chain is compromised, so the
  // whole family goes rather than just this link.
  if (existingToken.rotatedAt !== null) {
    await input.store.deleteByFamilyId(existingToken.familyId);
    return {
      outcome: 'reuse-detected',
      userId: existingToken.userId,
      familyId: existingToken.familyId,
    };
  }

  if (existingToken.expiresAt <= now) {
    await input.store.deleteById(existingToken.id);
    return REJECTED_ROTATION;
  }

  const nextToken = issueRefreshToken(
    existingToken.userId,
    existingToken.delegationId,
    existingToken.familyId,
    existingToken.expiresAt,
    input.hmacSecret,
    now,
  );

  // The spent record is retained, not deleted: it is what makes a later replay
  // distinguishable from an unknown token. Expiry cleanup reaps it on the
  // original schedule.
  await input.store.markRotated(existingToken.id, now);
  await input.store.insert(nextToken.record);

  return {
    outcome: 'rotated',
    rotated: nextToken,
    revokedTokenId: existingToken.id,
  };
}

/**
 * Ends the whole rotation chain the token belongs to, including the spent
 * records retained for reuse detection. This is what an explicit logout wants:
 * leaving ancestors behind would keep replayable-looking rows alive until
 * expiry.
 */
export async function revokeRefreshTokenFamily(
  store: RefreshTokenStore,
  refreshTokenId: string,
): Promise<boolean> {
  const existingToken = await store.findById(refreshTokenId);
  if (existingToken === null) {
    return false;
  }

  await store.deleteByFamilyId(existingToken.familyId);
  return true;
}

export function createEntityId(): string {
  return nanoid(TOKEN_ID_LENGTH);
}

export function createLinkToken(now: number = Date.now()): LinkTokenIssue {
  return {
    token: linkTokenGenerator(),
    expiresAt: now + LINK_TOKEN_TTL_MS,
  };
}

function secureHexEqual(left: string, right: string): boolean {
  const leftBuffer = safeHexToBuffer(left);
  const rightBuffer = safeHexToBuffer(right);

  if (leftBuffer.length === 0 || rightBuffer.length === 0) {
    return false;
  }

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function safeHexToBuffer(value: string): Buffer {
  if (value.length % 2 !== 0) {
    return Buffer.from(EMPTY_HEX);
  }

  const hexPattern = /^[0-9a-fA-F]+$/;
  if (!hexPattern.test(value)) {
    return Buffer.from(EMPTY_HEX);
  }

  return Buffer.from(value, HEX_ENCODING);
}

function ensureNonEmpty(value: string, fieldName: string): void {
  if (value.length === 0) {
    throw new Error(`${fieldName} must not be empty`);
  }
}

function requireAccessTokenConfig(config: AccessTokenConfig): void {
  ensureNonEmpty(config.issuer, 'issuer');
  ensureNonEmpty(config.audience, 'audience');
  if (
    !(config.hmacKey instanceof Uint8Array) ||
    config.hmacKey.byteLength !== ACCESS_TOKEN_HMAC_KEY_BYTES
  ) {
    throw new Error(`Access-token HMAC key must be exactly ${ACCESS_TOKEN_HMAC_KEY_BYTES} bytes`);
  }
}

function accessTokenTag(payloadSegment: string, key: Uint8Array): Buffer {
  return createHmac('sha512', key)
    .update(ACCESS_TOKEN_LABEL, 'utf8')
    .update(payloadSegment, 'ascii')
    .digest();
}

function decodeCanonicalBase64Url(value: string): Uint8Array | null {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
}
