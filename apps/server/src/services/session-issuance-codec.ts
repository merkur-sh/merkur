import {
  DAEMON_IDENTITY_PUBLIC_KEY_BYTES,
  SESSION_AUTHORIZATION_COMMITMENT_BYTES,
  SESSION_REQUEST_CLIENT_NONCE_BYTES,
  SESSION_REQUEST_ENCAPSULATION_KEY_BYTES,
} from '@merkur/auth';
import { hasExactKeys, isCanonicalEdgeWebTransportUrl, isRecord } from '@merkur/shared';
import { type DaemonBinding, parseDaemonBinding } from '@merkur/shared/user-authorization';
import { EDGE_ATTACH_TICKET_BYTES } from './edge-attach-ticket';
import { IP_ZONES, type IpZone } from './ip-region';
import type { DaemonPresence, DaemonPresenceState } from './realtime-coordination-service';
import type {
  SessionIssuancePreparation,
  SessionIssuanceResponse,
} from './session-issuance-contract';

const SESSION_ISSUANCE_IDENTITY_KEYS = [
  'state',
  'issuanceId',
  'userId',
  'delegationId',
  'daemonId',
  'browserNodeId',
  'daemonIdentityKeyCommitment',
  'sessionRequestCommitment',
  'sessionId',
] as const;
const SESSION_ISSUANCE_PREPARED_KEYS = [
  ...SESSION_ISSUANCE_IDENTITY_KEYS,
  'response',
  'expiresAtMs',
] as const;
const SESSION_ISSUANCE_SUPERSEDED_KEYS = [
  ...SESSION_ISSUANCE_IDENTITY_KEYS,
  'successorIssuanceId',
  'successorSessionRequestCommitment',
] as const;
const SESSION_ISSUANCE_MISSING_PREDECESSOR_KEYS = [
  'state',
  'issuanceId',
  'userId',
  'delegationId',
  'daemonId',
  'browserNodeId',
  'daemonIdentityKeyCommitment',
  'successorIssuanceId',
  'successorSessionRequestCommitment',
] as const;
const SESSION_ISSUANCE_RESPONSE_KEYS = [
  'daemonId',
  'daemonIdentityPublicKey',
  'daemonIdentityP256PublicKey',
  'daemonBinding',
  'controlPresence',
  'sessionToken',
  'sessionTokenExpiresAtMs',
  'sessionId',
  'edgeWtUrl',
  'edgeCertHashes',
  'edgeAttachTicket',
  'clientNonce',
  'encapsulationKey',
] as const;
// Mirrors DAEMON_PRESENCE_FIELDS in realtime-coordination-service. This record
// persists a whole DaemonPresence in Redis and validates it with its own exact
// key list, so a field added there must be added here in the same commit or
// every session request fails to parse its control fence.
const SESSION_CONTROL_PRESENCE_KEYS = [
  'daemonId',
  'userId',
  'ownerInstanceId',
  'connectionId',
  'presenceId',
  'claimSeq',
  'state',
  'updatedAt',
  'zone',
] as const;
const SESSION_CONTROL_PRESENCE_STATES: readonly DaemonPresenceState[] = ['online', 'suspended'];

export type StoredSessionIssuance =
  | AllocatingSessionIssuance
  | PreparedSessionIssuance
  | CommittedSessionIssuance
  | CancelledSessionIssuance
  | SupersededSessionIssuance
  | MissingPredecessorSupersession;

interface SessionIssuanceIdentity {
  readonly issuanceId: string;
  readonly userId: string;
  readonly delegationId: string;
  readonly daemonId: string;
  readonly browserNodeId: string;
  readonly daemonIdentityKeyCommitment: string;
  readonly sessionRequestCommitment: string;
  readonly sessionId: string;
}

export interface AllocatingSessionIssuance extends SessionIssuanceIdentity {
  readonly state: 'allocating';
}

export interface PreparedSessionIssuance extends SessionIssuanceIdentity {
  readonly state: 'prepared';
  readonly response: SessionIssuanceResponse;
  readonly expiresAtMs: number;
}

export interface CommittedSessionIssuance extends SessionIssuanceIdentity {
  readonly state: 'committed';
  readonly response: SessionIssuanceResponse;
  readonly expiresAtMs: number;
}

export interface CancelledSessionIssuance extends SessionIssuanceIdentity {
  readonly state: 'cancelled' | 'expired';
}

export interface SupersededSessionIssuance extends SessionIssuanceIdentity {
  readonly state: 'superseded';
  readonly successorIssuanceId: string;
  readonly successorSessionRequestCommitment: string;
}

/**
 * Durable proof that a successor won before its predecessor was ever allocated.
 * It intentionally has no predecessor session id or request commitment: there
 * is no daemon session to cancel, but every late issue under this id must fail.
 */
export interface MissingPredecessorSupersession {
  readonly state: 'superseded_missing';
  readonly issuanceId: string;
  readonly userId: string;
  readonly delegationId: string;
  readonly daemonId: string;
  readonly browserNodeId: string;
  readonly daemonIdentityKeyCommitment: string;
  readonly successorIssuanceId: string;
  readonly successorSessionRequestCommitment: string;
}

export function parseStoredSessionIssuance(raw: string): StoredSessionIssuance | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.state) {
    case 'superseded_missing':
      return parseMissingPredecessor(value);
    case 'allocating':
    case 'cancelled':
    case 'expired':
      return parseAllocatedRecord(value, value.state, SESSION_ISSUANCE_IDENTITY_KEYS);
    case 'superseded':
      return parseAllocatedRecord(value, value.state, SESSION_ISSUANCE_SUPERSEDED_KEYS);
    case 'prepared':
    case 'committed':
      return parseAllocatedRecord(value, value.state, SESSION_ISSUANCE_PREPARED_KEYS);
    default:
      return null;
  }
}

type IssuanceLineage = Pick<
  SessionIssuanceIdentity,
  | 'issuanceId'
  | 'userId'
  | 'delegationId'
  | 'daemonId'
  | 'browserNodeId'
  | 'daemonIdentityKeyCommitment'
>;

function hasValidLineage(
  value: Record<string, unknown>,
): value is Record<string, unknown> & IssuanceLineage {
  return (
    isNonEmptyString(value.issuanceId) &&
    isNonEmptyString(value.userId) &&
    isNonEmptyString(value.delegationId) &&
    isNonEmptyString(value.daemonId) &&
    isNonEmptyString(value.browserNodeId) &&
    isCanonicalBase64UrlBytes(
      value.daemonIdentityKeyCommitment,
      SESSION_AUTHORIZATION_COMMITMENT_BYTES,
    )
  );
}

function hasValidSuccessor(
  value: Record<string, unknown>,
): value is Record<string, unknown> &
  Pick<SupersededSessionIssuance, 'successorIssuanceId' | 'successorSessionRequestCommitment'> {
  return (
    isNonEmptyString(value.successorIssuanceId) &&
    isCanonicalBase64UrlBytes(
      value.successorSessionRequestCommitment,
      SESSION_AUTHORIZATION_COMMITMENT_BYTES,
    )
  );
}

function parseMissingPredecessor(
  value: Record<string, unknown>,
): MissingPredecessorSupersession | null {
  if (!hasExactKeys(value, SESSION_ISSUANCE_MISSING_PREDECESSOR_KEYS)) return null;
  if (!hasValidLineage(value) || !hasValidSuccessor(value)) return null;
  return {
    state: 'superseded_missing',
    issuanceId: value.issuanceId,
    userId: value.userId,
    delegationId: value.delegationId,
    daemonId: value.daemonId,
    browserNodeId: value.browserNodeId,
    daemonIdentityKeyCommitment: value.daemonIdentityKeyCommitment,
    successorIssuanceId: value.successorIssuanceId,
    successorSessionRequestCommitment: value.successorSessionRequestCommitment,
  };
}

function parseAllocatedRecord(
  value: Record<string, unknown>,
  state: Exclude<StoredSessionIssuance['state'], 'superseded_missing'>,
  keys: readonly string[],
): StoredSessionIssuance | null {
  if (!hasExactKeys(value, keys)) return null;
  if (
    !hasValidLineage(value) ||
    !isCanonicalBase64UrlBytes(
      value.sessionRequestCommitment,
      SESSION_AUTHORIZATION_COMMITMENT_BYTES,
    ) ||
    !isNonEmptyString(value.sessionId)
  )
    return null;
  const identity: SessionIssuanceIdentity = {
    issuanceId: value.issuanceId,
    userId: value.userId,
    delegationId: value.delegationId,
    daemonId: value.daemonId,
    browserNodeId: value.browserNodeId,
    daemonIdentityKeyCommitment: value.daemonIdentityKeyCommitment,
    sessionRequestCommitment: value.sessionRequestCommitment,
    sessionId: value.sessionId,
  };
  if (state === 'allocating' || state === 'cancelled' || state === 'expired')
    return { ...identity, state };
  if (state === 'superseded') {
    if (!hasValidSuccessor(value)) return null;
    return {
      ...identity,
      state,
      successorIssuanceId: value.successorIssuanceId,
      successorSessionRequestCommitment: value.successorSessionRequestCommitment,
    };
  }
  const response = parseSessionIssuanceResponse(value.response);
  if (
    response === null ||
    !responseMatchesIdentity(response, identity) ||
    typeof value.expiresAtMs !== 'number' ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs <= 0 ||
    response.sessionTokenExpiresAtMs !== value.expiresAtMs
  )
    return null;
  return { ...identity, state, response, expiresAtMs: value.expiresAtMs };
}

/** Terminal records retain identity only, never the prepared credentials. */
export function terminalIssuance(
  record: SessionIssuanceIdentity,
  state: CancelledSessionIssuance['state'],
): CancelledSessionIssuance {
  return {
    state,
    issuanceId: record.issuanceId,
    userId: record.userId,
    delegationId: record.delegationId,
    daemonId: record.daemonId,
    browserNodeId: record.browserNodeId,
    daemonIdentityKeyCommitment: record.daemonIdentityKeyCommitment,
    sessionRequestCommitment: record.sessionRequestCommitment,
    sessionId: record.sessionId,
  };
}

function parseSessionIssuanceResponse(value: unknown): SessionIssuanceResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, SESSION_ISSUANCE_RESPONSE_KEYS)) return null;
  const controlPresence = parseSessionControlPresence(value.controlPresence);
  let daemonBinding: DaemonBinding;
  try {
    daemonBinding = parseDaemonBinding(value.daemonBinding);
  } catch {
    return null;
  }
  if (
    !isNonEmptyString(value.daemonId) ||
    !isCanonicalBase64UrlBytes(value.daemonIdentityPublicKey, DAEMON_IDENTITY_PUBLIC_KEY_BYTES) ||
    !isCanonicalBase64UrlBytes(value.daemonIdentityP256PublicKey, 65) ||
    controlPresence === null ||
    controlPresence.daemonId !== value.daemonId ||
    daemonBinding.daemonId !== value.daemonId ||
    daemonBinding.userId !== controlPresence.userId ||
    !isNonEmptyString(value.sessionToken) ||
    typeof value.sessionTokenExpiresAtMs !== 'number' ||
    !Number.isSafeInteger(value.sessionTokenExpiresAtMs) ||
    value.sessionTokenExpiresAtMs <= 0 ||
    !isNonEmptyString(value.sessionId) ||
    !isCanonicalEdgeWebTransportUrl(value.edgeWtUrl) ||
    !Array.isArray(value.edgeCertHashes) ||
    value.edgeCertHashes.length === 0 ||
    value.edgeCertHashes.length > 2 ||
    !value.edgeCertHashes.every(isCanonicalSha256Base64) ||
    new Set(value.edgeCertHashes).size !== value.edgeCertHashes.length ||
    !isCanonicalBase64UrlBytes(value.edgeAttachTicket, EDGE_ATTACH_TICKET_BYTES) ||
    !isCanonicalBase64UrlBytes(value.clientNonce, SESSION_REQUEST_CLIENT_NONCE_BYTES) ||
    !isCanonicalBase64UrlBytes(value.encapsulationKey, SESSION_REQUEST_ENCAPSULATION_KEY_BYTES)
  ) {
    return null;
  }
  return {
    daemonId: value.daemonId,
    daemonIdentityPublicKey: value.daemonIdentityPublicKey,
    daemonIdentityP256PublicKey: value.daemonIdentityP256PublicKey,
    daemonBinding,
    controlPresence,
    sessionToken: value.sessionToken,
    sessionTokenExpiresAtMs: value.sessionTokenExpiresAtMs,
    sessionId: value.sessionId,
    edgeWtUrl: value.edgeWtUrl,
    edgeCertHashes: value.edgeCertHashes,
    edgeAttachTicket: value.edgeAttachTicket,
    clientNonce: value.clientNonce,
    encapsulationKey: value.encapsulationKey,
  };
}

function parseSessionControlPresence(value: unknown): DaemonPresence | null {
  if (!isRecord(value) || !hasExactKeys(value, SESSION_CONTROL_PRESENCE_KEYS)) return null;
  const state = SESSION_CONTROL_PRESENCE_STATES.find((candidate) => candidate === value.state);
  if (
    !isNonEmptyString(value.daemonId) ||
    !isNonEmptyString(value.userId) ||
    !isNonEmptyString(value.ownerInstanceId) ||
    !isNonEmptyString(value.connectionId) ||
    !isNonEmptyString(value.presenceId) ||
    typeof value.claimSeq !== 'number' ||
    !Number.isSafeInteger(value.claimSeq) ||
    value.claimSeq <= 0 ||
    state === undefined ||
    typeof value.updatedAt !== 'number' ||
    !Number.isSafeInteger(value.updatedAt) ||
    value.updatedAt <= 0 ||
    (value.zone !== null && !IP_ZONES.some((zone) => zone === value.zone))
  ) {
    return null;
  }
  return {
    daemonId: value.daemonId,
    userId: value.userId,
    ownerInstanceId: value.ownerInstanceId,
    connectionId: value.connectionId,
    presenceId: value.presenceId,
    claimSeq: value.claimSeq,
    state,
    updatedAt: value.updatedAt,
    zone: value.zone === null ? null : (value.zone as IpZone),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isCanonicalSha256Base64(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.byteLength === 32 && decoded.toString('base64') === value;
  } catch {
    return false;
  }
}

function isCanonicalBase64UrlBytes(value: unknown, expectedBytes: number): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.byteLength === expectedBytes && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
}

export function validPreparation(
  preparation: SessionIssuancePreparation,
  identity: SessionIssuanceIdentity,
): boolean {
  return (
    parseSessionIssuanceResponse(preparation.response) !== null &&
    responseMatchesIdentity(preparation.response, identity) &&
    Number.isSafeInteger(preparation.expiresAtMs) &&
    preparation.expiresAtMs > 0 &&
    preparation.response.sessionTokenExpiresAtMs === preparation.expiresAtMs
  );
}

/** Both initial preparation and every durable replay must carry the same owner. */
function responseMatchesIdentity(
  response: SessionIssuanceResponse,
  identity: SessionIssuanceIdentity,
): boolean {
  return (
    response.sessionId === identity.sessionId &&
    response.daemonId === identity.daemonId &&
    response.controlPresence.userId === identity.userId &&
    response.daemonBinding.daemonIdentityKeyCommitment === identity.daemonIdentityKeyCommitment
  );
}
