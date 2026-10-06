import { type Static, Type } from 'typebox';

import { BROWSER_CLIENT_NAME_MAX_LENGTH } from './browser-client';

/**
 * The HTTP responses the browser reads, written once.
 *
 * The server declares each of these as a route's `response`, and the browser
 * checks what arrives against the same object (`schema-check.ts`): it does not
 * take the server's word for a response. A rule belongs here when JSON Schema
 * can state it. What it cannot state — two fields agreeing, a commitment
 * matching its key — stays in the code that reads the response.
 *
 * A string is `Text`, `Base64Url`, or a literal: its whole rule is one
 * `pattern`, which the server's validator and the browser's checker compile
 * the same way, with the `u` flag. `minLength` and `maxLength` are not used:
 * TypeBox counts them in grapheme clusters by its own segmentation, which no
 * other reader of a response reproduces.
 *
 * Built with the `Type` builder only. `typebox/value` and `typebox/compile` are
 * the validator and must not be imported here: this module ships to the
 * browser.
 */

/** The last character of a base64url value whose final group holds one byte: its low four bits are zero. */
const ONE_BYTE_TAIL = '[AQgw]';

/** The last character when the final group holds two bytes: its low two bits are zero. */
const TWO_BYTE_TAIL = '[AEIMQUYcgkosw048]';

const TAILS = ['', ONE_BYTE_TAIL, TWO_BYTE_TAIL];

/**
 * Canonical unpadded base64url of exactly `bytes` bytes, as one pattern: the
 * length the byte count gives, in the alphabet, with the spare bits of the last
 * character zero. A value that passes decodes to `bytes` bytes and encodes back
 * to itself, so no reader has to decode it to check it.
 */
export function Base64Url(bytes: number) {
  const spare = bytes % 3;
  const free = Math.floor(bytes / 3) * 4 + spare;

  return Type.String({ pattern: `^[A-Za-z0-9_-]{${free}}${TAILS[spare] ?? ''}$` });
}

/**
 * Text of `minimum` to `maximum` code points, any of them; no upper bound when
 * `maximum` is omitted. Under the `u` flag `[\s\S]` is one code point, a lone
 * surrogate included, so the bound is the same count on every engine.
 */
function Text(minimum: number, maximum?: number) {
  return Type.String({ pattern: `^[\\s\\S]{${minimum},${maximum ?? ''}}$` });
}

/** A safe non-negative integer: an instant in epoch milliseconds, or a count. */
const Timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

/** A user, delegation, daemon or claim id: issued in the protocol id alphabet, not as bytes. */
const Id = Text(1, 128);

/** Names one OPAQUE or reset flow: 32 random bytes. */
const FlowId = Base64Url(32);

/**
 * What a machine is called. Every request that writes a name is held to this
 * object, so a stored name is always one a response can carry.
 */
export const DeviceName = Text(1, 128);

export const DevicePlatform = Text(1, 64);

/** A SHA-512 hash. */
const Commitment = Base64Url(64);

const MlDsaPublicKey = Base64Url(2_592);

const OpaqueRegistrationResponse = Base64Url(64);

export const AuthSessionResponse = Type.Object(
  {
    // Two base64url segments joined by a dot, not one encoding of a byte string.
    accessToken: Text(1),
    userId: Id,
    delegationId: Id,
    delegationExpiresAt: Timestamp,
    serverTimeMs: Timestamp,
    /** True when this sign-in called off a scheduled erasure of the account. */
    deletionCancelled: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type AuthSessionResponse = Static<typeof AuthSessionResponse>;

const AuthLoginStartResponse = Type.Object(
  {
    flowId: FlowId,
    userId: Id,
    loginResponse: Base64Url(320),
    rootPublicKey: MlDsaPublicKey,
    rootEnvelope: Type.Object(
      {
        nonce: Base64Url(12),
        ciphertext: Base64Url(48),
      },
      { additionalProperties: false },
    ),
    rootEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    delegationIssuedAt: Timestamp,
    delegationExpiresAt: Timestamp,
  },
  { additionalProperties: false },
);

const AuthRegistrationStartResponse = Type.Object(
  {
    flowId: FlowId,
    userId: Id,
    registrationResponse: OpaqueRegistrationResponse,
    delegationIssuedAt: Timestamp,
    delegationExpiresAt: Timestamp,
  },
  { additionalProperties: false },
);

export const AuthStartResponse = Type.Object(
  {
    login: AuthLoginStartResponse,
    registration: AuthRegistrationStartResponse,
  },
  { additionalProperties: false },
);

export type AuthStartResponse = Static<typeof AuthStartResponse>;

/** What this server names accounts by, and whether it accepts new ones. */
export const AuthPolicyResponse = Type.Object(
  {
    identity: Type.Union([Type.Literal('username'), Type.Literal('email')]),
    registration: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type AuthPolicyResponse = Static<typeof AuthPolicyResponse>;

export const AuthEmailCodeResponse = Type.Object(
  { sent: Type.Literal(true) },
  { additionalProperties: false },
);

export const AuthResetCodeResponse = Type.Object(
  { flowId: FlowId },
  { additionalProperties: false },
);

/** One machine a password reset will unlink; `box` marks a hosted box it will destroy. */
export const PasswordResetDevice = Type.Object(
  {
    name: DeviceName,
    platform: DevicePlatform,
    box: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type PasswordResetDevice = Static<typeof PasswordResetDevice>;

/** A reset whose mailed code was accepted, and what finishing it will destroy. */
export const AuthResetVerifyResponse = Type.Object(
  {
    /** Names the proven reset; the flow the code was mailed for is spent. */
    flowId: FlowId,
    devices: Type.Array(PasswordResetDevice),
  },
  { additionalProperties: false },
);

export type AuthResetVerifyResponse = Static<typeof AuthResetVerifyResponse>;

export const AuthResetStartResponse = Type.Object(
  {
    userId: Id,
    registrationResponse: OpaqueRegistrationResponse,
    /**
     * The epoch the new root's first delegation must name. A reset replaces a
     * root, so it never names the first epoch.
     */
    rootEpoch: Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER }),
    delegationIssuedAt: Timestamp,
    delegationExpiresAt: Timestamp,
  },
  { additionalProperties: false },
);

export type AuthResetStartResponse = Static<typeof AuthResetStartResponse>;

/** The one answer of a mutation that has nothing to report. */
export const OkResponse = Type.Object({ ok: Type.Literal(true) }, { additionalProperties: false });

/** The instant a scheduled account erasure falls due. */
export const AccountDeletionResponse = Type.Object(
  { scheduledFor: Timestamp },
  { additionalProperties: false },
);

const ClientName = Type.Union([Text(1, BROWSER_CLIENT_NAME_MAX_LENGTH), Type.Null()]);

export const BrowserSessionRecord = Type.Object(
  {
    delegationId: Id,
    issuedAt: Timestamp,
    expiresAt: Timestamp,
    revokedAt: Type.Union([Timestamp, Type.Null()]),
    current: Type.Boolean(),
    /**
     * What the server parsed this browser to be when it issued the delegation
     * (`BrowserClient`). Either name can be null: an unrecognized `User-Agent`
     * is a supported outcome, and the sessions list says so rather than
     * guessing.
     */
    client: Type.Object(
      {
        browser: ClientName,
        platform: ClientName,
        installed: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type BrowserSessionRecord = Static<typeof BrowserSessionRecord>;

export const BrowserSessionListResponse = Type.Object(
  {
    serverTimeMs: Timestamp,
    sessions: Type.Array(BrowserSessionRecord),
  },
  { additionalProperties: false },
);

export type BrowserSessionListResponse = Static<typeof BrowserSessionListResponse>;

export const BrowserSessionsRevokedResponse = Type.Object(
  { revoked: Type.Integer({ minimum: 0, maximum: 32 }) },
  { additionalProperties: false },
);

/** A daemon's link claim as the server holds it, with the nonce an approval must sign. */
export const DaemonLinkClaimInspectResponse = Type.Object(
  {
    linkClaimId: Id,
    daemonId: Id,
    daemonIdentityPublicKey: MlDsaPublicKey,
    /** An uncompressed P-256 point. */
    daemonIdentityP256PublicKey: Base64Url(65),
    identitySealBackend: Type.Union([Type.Literal('hardware'), Type.Literal('software')]),
    daemonIdentityKeyCommitment: Commitment,
    name: DeviceName,
    platform: DevicePlatform,
    claimCommitment: Commitment,
    serverNonce: Base64Url(32),
    serverTimeMs: Timestamp,
  },
  { additionalProperties: false },
);

export type DaemonLinkClaimInspectResponse = Static<typeof DaemonLinkClaimInspectResponse>;

export const PushVapidPublicKeyResponse = Type.Object(
  {
    /** The server's VAPID key, an uncompressed P-256 point. */
    publicKey: Base64Url(65),
  },
  { additionalProperties: false },
);

export type PushVapidPublicKeyResponse = Static<typeof PushVapidPublicKeyResponse>;

/** Whether this account may create boxes, and whether it is on the waitlist. */
export const BoxAccessResponse = Type.Object(
  {
    status: Type.Union([
      Type.Literal('none'),
      Type.Literal('waitlisted'),
      Type.Literal('approved'),
    ]),
  },
  { additionalProperties: false },
);

export type BoxAccessResponse = Static<typeof BoxAccessResponse>;

export const BoxCreatedResponse = Type.Object(
  {
    // The name the box was asked for, as the box host knows it; not an encoding.
    boxId: Text(1),
    /**
     * Code the new box's daemon emitted. It must be approved with the account
     * password before the box finishes linking and appears as a device. A claim
     * id and a secret joined by a dot, so not one encoding either.
     */
    linkCode: Text(1),
  },
  { additionalProperties: false },
);

export type BoxCreatedResponse = Static<typeof BoxCreatedResponse>;

// The build's version, whatever the build was stamped with; a tag, a commit or `dev`.
export const ServerVersionResponse = Type.Object(
  { version: Text(0) },
  { additionalProperties: false },
);
