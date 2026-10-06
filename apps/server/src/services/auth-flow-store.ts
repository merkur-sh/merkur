import { randomBytes, timingSafeEqual } from 'node:crypto';

import { hasExactKeys, isRecord } from '@merkur/shared';
import { Effect } from 'effect';

import {
  parseRedisFlag,
  parseRedisNonNegativeSafeInteger,
  parseRedisOptionalString,
  parseRedisPositiveSafeInteger,
} from './redis-reply';
import type { RedisError, RedisService } from './redis-service';

const AUTH_FLOW_TTL_MS = 2 * 60 * 1_000;
/**
 * A flow waiting on a mailed code lives this long from the last send. Two
 * minutes covers an OPAQUE round trip; it does not cover opening a mailbox.
 */
export const AUTH_EMAIL_FLOW_TTL_MS = 10 * 60 * 1_000;
/** Guesses one flow gets at its code before the flow is destroyed. */
export const AUTH_EMAIL_CODE_MAX_ATTEMPTS = 5;
const EMAIL_CODE_MAC_PATTERN = /^[a-f0-9]{64}$/u;
const FLOW_ID_BYTES = 32;
const MAX_CREATE_ATTEMPTS = 3;
const FLOW_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface AuthStartFlow {
  readonly kind: 'auth-start';
  readonly userId: string;
  readonly username: string;
  readonly serverLoginState: string;
  readonly accountExists: boolean;
  readonly credentialFingerprint: string | null;
  readonly registrationAllowed: boolean;
  readonly delegationIssuedAt: number;
  readonly delegationExpiresAt: number;
}

/**
 * A password reset waiting on the code mailed to `username`.
 *
 * It is created for every address asked about, so `accountExists` is false and
 * `userId` synthetic when there is no account; such a flow is never mailed a
 * code and never verifies. The fingerprint and epoch are the account as it was
 * when the code was requested.
 */
export interface PasswordResetCodeFlow {
  readonly kind: 'password-reset-code';
  readonly userId: string;
  readonly username: string;
  readonly accountExists: boolean;
  readonly credentialFingerprint: string | null;
  readonly rootEpoch: number;
}

/**
 * A password reset whose mailbox is proven: the capability to replace the
 * account's credential and root, once, while the account is still in the state
 * the fingerprint and epoch name.
 */
export interface PasswordResetFlow {
  readonly kind: 'password-reset';
  readonly userId: string;
  readonly username: string;
  readonly credentialFingerprint: string;
  readonly rootEpoch: number;
  readonly delegationIssuedAt: number;
  readonly delegationExpiresAt: number;
}

type StoredFlow = AuthStartFlow | PasswordResetCodeFlow | PasswordResetFlow;

export type EmailCodeCheck = 'match' | 'mismatch' | 'exhausted' | 'missing';

/**
 * Every flow lives under one key space and names its kind. A reader asks for
 * one kind and is given nothing for an id of another, so an id minted for a
 * reset finishes no sign-in and the reverse.
 */
export interface AuthFlowStore {
  createStart(flow: AuthStartFlow): Effect.Effect<string, RedisError>;
  consumeStart(flowId: string): Effect.Effect<AuthStartFlow | null, RedisError>;
  /** Reads a flow without consuming it; a code request must leave it for the finish. */
  peekStart(flowId: string): Effect.Effect<AuthStartFlow | null, RedisError>;
  /** Lives for the mailed-code lifetime from creation; its code is attached next. */
  createResetCode(flow: PasswordResetCodeFlow): Effect.Effect<string, RedisError>;
  /** Reads whose reset a code guess is aimed at, before the guess is counted. */
  peekResetCode(flowId: string): Effect.Effect<PasswordResetCodeFlow | null, RedisError>;
  consumeResetCode(flowId: string): Effect.Effect<PasswordResetCodeFlow | null, RedisError>;
  createReset(flow: PasswordResetFlow): Effect.Effect<string, RedisError>;
  /** Reads a proven reset without consuming it; only its finish spends it. */
  peekReset(flowId: string): Effect.Effect<PasswordResetFlow | null, RedisError>;
  consumeReset(flowId: string): Effect.Effect<PasswordResetFlow | null, RedisError>;
  /**
   * Extends the flow to the mailed-code lifetime and records `mac` as its code,
   * replacing any earlier one. Attempts carry over a resend, so resending buys
   * no extra guesses. Returns the send ordinal (1 for the first), or `null`
   * when the flow is already gone.
   */
  attachEmailCode(flowId: string, mac: string): Effect.Effect<number | null, RedisError>;
  /**
   * Spends one attempt and compares `mac` with the recorded code. Exhausting
   * the attempts destroys the flow; a match leaves it for `consumeStart`.
   */
  checkEmailCode(flowId: string, mac: string): Effect.Effect<EmailCodeCheck, RedisError>;
  /** Drops a flow's code once the flow is consumed. */
  discardEmailCode(flowId: string): Effect.Effect<void, RedisError>;
}

export function createAuthFlowStore(redis: RedisService): AuthFlowStore {
  return {
    createStart: (flow) => createFlow(redis, flow, AUTH_FLOW_TTL_MS),
    consumeStart: (flowId) => readFlow(redis, 'GETDEL', flowId).pipe(Effect.map(authStartOf)),
    peekStart: (flowId) => readFlow(redis, 'GET', flowId).pipe(Effect.map(authStartOf)),
    createResetCode: (flow) => createFlow(redis, flow, AUTH_EMAIL_FLOW_TTL_MS),
    peekResetCode: (flowId) => readFlow(redis, 'GET', flowId).pipe(Effect.map(resetCodeOf)),
    consumeResetCode: (flowId) => readFlow(redis, 'GETDEL', flowId).pipe(Effect.map(resetCodeOf)),
    createReset: (flow) => createFlow(redis, flow, AUTH_EMAIL_FLOW_TTL_MS),
    peekReset: (flowId) => readFlow(redis, 'GET', flowId).pipe(Effect.map(resetOf)),
    consumeReset: (flowId) => readFlow(redis, 'GETDEL', flowId).pipe(Effect.map(resetOf)),
    attachEmailCode: (flowId, mac) => attachEmailCode(redis, flowId, mac),
    checkEmailCode: (flowId, mac) => checkEmailCode(redis, flowId, mac),
    discardEmailCode: (flowId) =>
      isCanonicalFlowId(flowId)
        ? redis.useCommands((client) => client.sendCommand<unknown>(['DEL', codeKey(flowId)]))
        : Effect.void,
  };
}

function createFlow(
  redis: RedisService,
  flow: StoredFlow,
  ttlMs: number,
): Effect.Effect<string, RedisError> {
  const raw = JSON.stringify(flow);
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const flowId = randomBytes(FLOW_ID_BYTES).toString('base64url');
      const result = yield* redis.useCommands((client) =>
        client.sendCommand<unknown>(['SET', flowKey(flowId), raw, 'NX', 'PX', String(ttlMs)]),
      );
      if (result === 'OK') return flowId;
    }
    return yield* redis.useCommands(() => {
      throw new Error('Unable to allocate a unique authentication flow id');
    });
  });
}

/** `GETDEL` consumes the flow whatever its kind: a wrong-kind id is spent, not kept. */
function readFlow(
  redis: RedisService,
  command: 'GET' | 'GETDEL',
  flowId: string,
): Effect.Effect<StoredFlow | null, RedisError> {
  if (!isCanonicalFlowId(flowId)) return Effect.succeed(null);
  return redis
    .useCommands((client) => client.sendCommand<unknown>([command, flowKey(flowId)]))
    .pipe(Effect.map(parseStoredFlow));
}

function authStartOf(flow: StoredFlow | null): AuthStartFlow | null {
  return flow?.kind === 'auth-start' ? flow : null;
}

function resetCodeOf(flow: StoredFlow | null): PasswordResetCodeFlow | null {
  return flow?.kind === 'password-reset-code' ? flow : null;
}

function resetOf(flow: StoredFlow | null): PasswordResetFlow | null {
  return flow?.kind === 'password-reset' ? flow : null;
}

function attachEmailCode(
  redis: RedisService,
  flowId: string,
  mac: string,
): Effect.Effect<number | null, RedisError> {
  if (!isCanonicalFlowId(flowId) || !EMAIL_CODE_MAC_PATTERN.test(mac)) {
    return Effect.succeed(null);
  }
  const ttl = String(AUTH_EMAIL_FLOW_TTL_MS);
  return redis.useCommands(async (client) => {
    // The flow is extended first: a flow that already expired gets no code,
    // and a code key never outlives the flow it belongs to.
    const extended = parseRedisFlag(
      await client.sendCommand<unknown>(['PEXPIRE', flowKey(flowId), ttl]),
      'auth flow PEXPIRE',
    );
    if (!extended) return null;
    const key = codeKey(flowId);
    await client.sendCommand<unknown>(['HSET', key, 'mac', mac]);
    await client.sendCommand<unknown>(['HSETNX', key, 'attempts', '0']);
    const sends = parseRedisPositiveSafeInteger(
      await client.sendCommand<unknown>(['HINCRBY', key, 'sends', '1']),
      'auth flow code HINCRBY sends',
    );
    await client.sendCommand<unknown>(['PEXPIRE', key, ttl]);
    return sends;
  });
}

function checkEmailCode(
  redis: RedisService,
  flowId: string,
  mac: string,
): Effect.Effect<EmailCodeCheck, RedisError> {
  if (!isCanonicalFlowId(flowId) || !EMAIL_CODE_MAC_PATTERN.test(mac)) {
    return Effect.succeed('missing');
  }
  return redis.useCommands(async (client): Promise<EmailCodeCheck> => {
    const key = codeKey(flowId);
    // Counted before it is compared, so concurrent guesses cannot share one
    // attempt. Incrementing a key that expired recreates it without a TTL,
    // which the missing-code branch deletes again.
    const attempts = parseRedisNonNegativeSafeInteger(
      await client.sendCommand<unknown>(['HINCRBY', key, 'attempts', '1']),
      'auth flow code HINCRBY attempts',
    );
    const stored = parseRedisOptionalString(
      await client.sendCommand<unknown>(['HGET', key, 'mac']),
      'auth flow code HGET mac',
    );
    if (stored === null) {
      await client.sendCommand<unknown>(['DEL', key]);
      return 'missing';
    }
    if (attempts > AUTH_EMAIL_CODE_MAX_ATTEMPTS) {
      await client.sendCommand<unknown>(['DEL', key, flowKey(flowId)]);
      return 'exhausted';
    }
    if (!EMAIL_CODE_MAC_PATTERN.test(stored)) {
      throw new Error('Authentication flow code is malformed');
    }
    return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(mac, 'hex'))
      ? 'match'
      : 'mismatch';
  });
}

function parseStoredFlow(value: unknown): StoredFlow | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('Authentication flow reply is not text');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('Authentication flow JSON is malformed', { cause: error });
  }
  if (!isRecord(parsed)) throw new Error('Authentication flow is malformed');
  const flow = parseAuthStartFlow(parsed) ?? parseResetCodeFlow(parsed) ?? parseResetFlow(parsed);
  if (flow === null) throw new Error('Authentication flow fields are malformed');
  return flow;
}

function parseAuthStartFlow(parsed: Record<string, unknown>): AuthStartFlow | null {
  if (
    parsed.kind === 'auth-start' &&
    hasExactKeys(parsed, [
      'kind',
      'userId',
      'username',
      'serverLoginState',
      'accountExists',
      'credentialFingerprint',
      'registrationAllowed',
      'delegationIssuedAt',
      'delegationExpiresAt',
    ]) &&
    isIdentifier(parsed.userId) &&
    typeof parsed.username === 'string' &&
    parsed.username.length > 0 &&
    typeof parsed.serverLoginState === 'string' &&
    parsed.serverLoginState.length > 0 &&
    typeof parsed.accountExists === 'boolean' &&
    (parsed.credentialFingerprint === null || isFingerprint(parsed.credentialFingerprint)) &&
    typeof parsed.registrationAllowed === 'boolean' &&
    isTimestamp(parsed.delegationIssuedAt) &&
    isTimestamp(parsed.delegationExpiresAt)
  ) {
    return {
      kind: 'auth-start',
      userId: parsed.userId,
      username: parsed.username,
      serverLoginState: parsed.serverLoginState,
      accountExists: parsed.accountExists,
      credentialFingerprint: parsed.credentialFingerprint,
      registrationAllowed: parsed.registrationAllowed,
      delegationIssuedAt: parsed.delegationIssuedAt,
      delegationExpiresAt: parsed.delegationExpiresAt,
    };
  }
  return null;
}

function parseResetCodeFlow(parsed: Record<string, unknown>): PasswordResetCodeFlow | null {
  if (
    parsed.kind === 'password-reset-code' &&
    hasExactKeys(parsed, [
      'kind',
      'userId',
      'username',
      'accountExists',
      'credentialFingerprint',
      'rootEpoch',
    ]) &&
    isIdentifier(parsed.userId) &&
    typeof parsed.username === 'string' &&
    parsed.username.length > 0 &&
    typeof parsed.accountExists === 'boolean' &&
    (parsed.credentialFingerprint === null || isFingerprint(parsed.credentialFingerprint)) &&
    isRootEpoch(parsed.rootEpoch)
  ) {
    return {
      kind: 'password-reset-code',
      userId: parsed.userId,
      username: parsed.username,
      accountExists: parsed.accountExists,
      credentialFingerprint: parsed.credentialFingerprint,
      rootEpoch: parsed.rootEpoch,
    };
  }
  return null;
}

function parseResetFlow(parsed: Record<string, unknown>): PasswordResetFlow | null {
  if (
    parsed.kind === 'password-reset' &&
    hasExactKeys(parsed, [
      'kind',
      'userId',
      'username',
      'credentialFingerprint',
      'rootEpoch',
      'delegationIssuedAt',
      'delegationExpiresAt',
    ]) &&
    isIdentifier(parsed.userId) &&
    typeof parsed.username === 'string' &&
    parsed.username.length > 0 &&
    isFingerprint(parsed.credentialFingerprint) &&
    isRootEpoch(parsed.rootEpoch) &&
    isTimestamp(parsed.delegationIssuedAt) &&
    isTimestamp(parsed.delegationExpiresAt)
  ) {
    return {
      kind: 'password-reset',
      userId: parsed.userId,
      username: parsed.username,
      credentialFingerprint: parsed.credentialFingerprint,
      rootEpoch: parsed.rootEpoch,
      delegationIssuedAt: parsed.delegationIssuedAt,
      delegationExpiresAt: parsed.delegationExpiresAt,
    };
  }
  return null;
}

function flowKey(flowId: string): string {
  return `auth:flow:${flowId}`;
}

function codeKey(flowId: string): string {
  return `auth:flow-code:${flowId}`;
}

function isCanonicalFlowId(value: string): boolean {
  if (!FLOW_ID_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === FLOW_ID_BYTES && decoded.toString('base64url') === value;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isRootEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
