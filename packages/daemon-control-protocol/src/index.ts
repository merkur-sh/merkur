export const DAEMON_CONTROL_PROTOCOL_VERSION = 1 as const;
export const MAX_DAEMON_CONTROL_FRAME_BYTES = 32 * 1024;

const MAX_IDENTIFIER_BYTES = 512;
const MAX_REJECTION_REASON_BYTES = 64;
const MAX_EDGE_CERT_HASHES = 2;
const SESSION_CLIENT_NONCE_BYTES = 32;
const ML_KEM_1024_ENCAPSULATION_KEY_BYTES = 1_568;
const ML_DSA_87_PUBLIC_KEY_BYTES = 2_592;
const ML_DSA_87_SIGNATURE_BYTES = 4_627;
const AUTHORIZATION_HASH_BYTES = 64;
const AUTHORIZATION_NONCE_BYTES = 32;
const USER_DELEGATION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export interface DaemonControlRegisteredMessage {
  readonly type: 'registered';
  readonly version: typeof DAEMON_CONTROL_PROTOCOL_VERSION;
  readonly connectionId: string;
  readonly presenceId: string;
  readonly claimSeq: number;
  readonly revocationGeneration: number;
  /**
   * Carrier liveness runs on WebSocket ping frames, not on messages. The daemon
   * sends one every `pingIntervalMs`; the server reports it as silent once
   * `silentAfterMs` pass without one, and the daemon treats a pong that fails
   * to arrive inside that window plus a few intervals as a dead carrier.
   */
  readonly pingIntervalMs: number;
  readonly silentAfterMs: number;
  /**
   * Where the daemon may ask "what address did this come from", and the
   * credential that gets it answered.
   *
   * Carried on the control connection rather than configured on the daemon
   * because the credential is short-lived by design and the server is the only
   * party holding the key that mints it. The daemon never learns that key.
   */
  readonly stunServers: readonly string[];
  readonly stunTicket: string;
  /**
   * The per-ticket message-integrity key, base64url.
   *
   * Sent because the daemon cannot derive it: derivation needs the deployment
   * secret shared between the server and the responders, and letting a daemon
   * hold that would let it mint its own tickets. It receives only the key for
   * the one short-lived ticket it was given.
   */
  readonly stunTicketSecret: string;
  /**
   * How long this ticket stays valid, as a duration rather than an instant.
   *
   * A deadline in the issuer's clock would have to be compared against the
   * daemon's, and the two are only as aligned as their NTP. A daemon whose clock
   * ran ahead would read every fresh ticket as expired and silently stop
   * probing. A duration is stamped against the receiving clock at arrival, so
   * only elapsed time matters and no cross-host comparison happens at all.
   */
  readonly stunTicketLifetimeMs: number;
  /**
   * The edge attach ticket this daemon presents on every edge dial, base64url.
   *
   * Bound to this daemon's id and short-lived; a replacement rides every
   * `lease`. The daemon never checks its expiry: an edge does, and a daemon
   * whose control connection has been down for a ticket's lifetime is exactly
   * the daemon the edge should refuse.
   */
  readonly edgeAttachTicket: string;
  /**
   * Every edge the registry holds, as its registration states it now; the
   * statement rides every `lease` too. A dial pins its edge's newest hashes, so
   * a tunnel redialled after any number of certificate rotations reaches it,
   * and a restarted dataplane states its incarnation to each edge, which
   * retires every session its predecessor left there.
   */
  readonly edges: readonly DaemonControlEdge[];
}

/**
 * One registered edge: the URL its attachments dial, and the SHA-256 hashes of
 * the certificate it serves and the one it serves next.
 */
export interface DaemonControlEdge {
  readonly edgeWtUrl: string;
  readonly certHashes: readonly string[];
}

/**
 * Sent by the server each time it renews this daemon's Redis lease.
 *
 * Carries the two things that must reach the daemon on a bounded cadence: the
 * revocation generation, as the upper bound on how stale the daemon's view can
 * be when a `revocation` push was lost, and a replacement STUN ticket. A ticket
 * outlives a session start but not the reprobe interval, so refresh rides a
 * cadence the server already runs; a daemon that has lost its control
 * connection correctly stops being able to probe.
 */
export interface DaemonControlLeaseMessage {
  readonly type: 'lease';
  readonly version: typeof DAEMON_CONTROL_PROTOCOL_VERSION;
  readonly revocationGeneration: number;
  readonly stunTicket: string;
  readonly stunTicketSecret: string;
  /** See `DaemonControlRegisteredMessage.stunTicketLifetimeMs`. */
  readonly stunTicketLifetimeMs: number;
  /** See `DaemonControlRegisteredMessage.edgeAttachTicket`. */
  readonly edgeAttachTicket: string;
  /** See `DaemonControlRegisteredMessage.edges`. */
  readonly edges: readonly DaemonControlEdge[];
}

/**
 * The revoke-all push: sent the moment the account's revocation generation is
 * incremented, so the dataplane evicts every live peer without waiting for the
 * next `lease`.
 */
export interface DaemonControlRevocationMessage {
  readonly type: 'revocation';
  readonly version: typeof DAEMON_CONTROL_PROTOCOL_VERSION;
  readonly revocationGeneration: number;
}

export interface DaemonControlSessionOffer {
  /** Authenticated account that owns the linked daemon. */
  readonly userId: string;
  /** Root-authorized browser delegation required for this exact session. */
  readonly delegationId: string;
  /** Browser-generated nonce for this one-use post-quantum bootstrap. */
  readonly clientNonce: string;
  /** Browser's one-use ML-KEM-1024 encapsulation key. */
  readonly encapsulationKey: string;
  readonly edgeWtUrl: string;
  readonly edgeCertHashes: readonly string[];
}

export interface DaemonControlSessionStartMessage {
  readonly type: 'session_start';
  readonly version: typeof DAEMON_CONTROL_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly sessionId: string;
  readonly browserNodeId: string;
  readonly offer: DaemonControlSessionOffer;
  /**
   * W3C trace context for the request that issued this command, so the daemon's
   * work joins the browser's trace instead of rooting an unrelated one.
   *
   * Empty when the server has no active span, which is the normal state with
   * telemetry unconfigured. It is a required key, never an optional one:
   * `hasExactKeys` rejects any frame whose key set differs, so an omitted field
   * is a rejected command rather than a missing attribute.
   */
  readonly traceparent: string;
}

export interface DaemonControlSessionCancelMessage {
  readonly type: 'session_cancel';
  readonly version: typeof DAEMON_CONTROL_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly sessionId: string;
  readonly browserNodeId: string;
  /** See {@link DaemonControlSessionStartMessage.traceparent}. */
  readonly traceparent: string;
}

export interface UserDelegationCertificate {
  readonly userId: string;
  readonly rootKeyCommitment: string;
  readonly delegationId: string;
  readonly delegatePublicKey: string;
  readonly scopes: readonly ['terminal-session', 'session-revoke'];
  readonly serverOrigin: string;
  readonly rootEpoch: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly signature: string;
}

export interface DelegationRevocationTarget {
  readonly delegationId: string;
  readonly expiresAt: number;
}

export interface DelegationRevocationStatement {
  readonly userId: string;
  readonly rootKeyCommitment: string;
  readonly actorDelegationId: string;
  readonly targets: readonly DelegationRevocationTarget[];
  readonly issuedAt: number;
  readonly nonce: string;
  readonly signature: string;
}

export interface DaemonControlDelegationRevokeMessage {
  readonly type: 'delegation_revoke';
  readonly version: typeof DAEMON_CONTROL_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly actorCertificate: UserDelegationCertificate;
  readonly revocation: DelegationRevocationStatement;
  /** See {@link DaemonControlSessionStartMessage.traceparent}. */
  readonly traceparent: string;
}

export interface DaemonControlSupersededMessage {
  readonly type: 'superseded';
  readonly version: typeof DAEMON_CONTROL_PROTOCOL_VERSION;
}

export type DaemonControlServerMessage =
  | DaemonControlRegisteredMessage
  | DaemonControlLeaseMessage
  | DaemonControlRevocationMessage
  | DaemonControlSessionStartMessage
  | DaemonControlSessionCancelMessage
  | DaemonControlDelegationRevokeMessage
  | DaemonControlSupersededMessage;

export type DaemonControlCommandMessage =
  | DaemonControlSessionStartMessage
  | DaemonControlSessionCancelMessage
  | DaemonControlDelegationRevokeMessage;

export interface DaemonControlCommandAcceptedMessage {
  readonly type: 'command_ack';
  readonly version: typeof DAEMON_CONTROL_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly status: 'accepted';
}

export interface DaemonControlCommandRejectedMessage {
  readonly type: 'command_ack';
  readonly version: typeof DAEMON_CONTROL_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly status: 'rejected';
  /**
   * Stable, log-safe machine code such as `dataplane_backpressure`.
   * Free-form exception text is deliberately not part of the wire protocol.
   */
  readonly reason: string;
}

export type DaemonControlCommandAckMessage =
  | DaemonControlCommandAcceptedMessage
  | DaemonControlCommandRejectedMessage;

export type DaemonControlDaemonMessage = DaemonControlCommandAckMessage;

const REGISTERED_KEYS = [
  'type',
  'version',
  'connectionId',
  'presenceId',
  'claimSeq',
  'revocationGeneration',
  'pingIntervalMs',
  'silentAfterMs',
  'stunServers',
  'stunTicket',
  'stunTicketSecret',
  'stunTicketLifetimeMs',
  'edgeAttachTicket',
  'edges',
] as const;
const LEASE_KEYS = [
  'type',
  'version',
  'revocationGeneration',
  'stunTicket',
  'stunTicketSecret',
  'stunTicketLifetimeMs',
  'edgeAttachTicket',
  'edges',
] as const;
const EDGE_KEYS = ['edgeWtUrl', 'certHashes'] as const;
/**
 * Bound on the edges one statement names. The daemon dials each once per
 * process, so an unbounded list would make a lease cost unbounded handshakes;
 * the deployment runs a handful.
 */
const MAX_DAEMON_CONTROL_EDGES = 32;
const REVOCATION_KEYS = ['type', 'version', 'revocationGeneration'] as const;
/**
 * Bound on the advertised vantage points.
 *
 * The daemon probes every one of these on its startup path, so an unbounded
 * list would be a way to make a daemon spend its startup budget sending
 * datagrams. Three is what the deployment uses; the cap leaves room without
 * leaving it open.
 */
const MAX_STUN_SERVERS = 8;
/** `host:port`, long enough for a bracketed IPv6 literal. */
const MAX_STUN_SERVER_CHARS = 64;
/** base64url of a 41-byte ticket is 55 characters; allow a little slack. */
const MAX_STUN_TICKET_CHARS = 128;
/** base64url of the 26-byte edge attach ticket (`apps/edge/src/attach_ticket.rs`). */
const EDGE_ATTACH_TICKET_CHARS = 35;
const SESSION_START_KEYS = [
  'type',
  'version',
  'commandId',
  'sessionId',
  'browserNodeId',
  'offer',
  'traceparent',
] as const;
const SESSION_CANCEL_KEYS = [
  'type',
  'version',
  'commandId',
  'sessionId',
  'browserNodeId',
  'traceparent',
] as const;
const DELEGATION_REVOKE_KEYS = [
  'type',
  'version',
  'commandId',
  'actorCertificate',
  'revocation',
  'traceparent',
] as const;
const SUPERSEDED_KEYS = ['type', 'version'] as const;
const COMMAND_ACCEPTED_KEYS = ['type', 'version', 'commandId', 'status'] as const;
const COMMAND_REJECTED_KEYS = ['type', 'version', 'commandId', 'status', 'reason'] as const;
const SESSION_OFFER_KEYS = [
  'userId',
  'delegationId',
  'clientNonce',
  'encapsulationKey',
  'edgeWtUrl',
  'edgeCertHashes',
] as const;

export function parseDaemonControlServerMessage(raw: unknown): DaemonControlServerMessage | null {
  const decoded = decodeFrame(raw);
  if (!isRecord(decoded) || decoded.version !== DAEMON_CONTROL_PROTOCOL_VERSION) {
    return null;
  }

  switch (decoded.type) {
    case 'registered':
      return parseRegistered(decoded);
    case 'lease':
      return parseLease(decoded);
    case 'revocation':
      return parseRevocation(decoded);
    case 'session_start':
      return parseSessionStart(decoded);
    case 'session_cancel':
      return parseSessionCancel(decoded);
    case 'delegation_revoke':
      return parseDelegationRevoke(decoded);
    case 'superseded':
      return hasExactKeys(decoded, SUPERSEDED_KEYS)
        ? {
            type: 'superseded',
            version: DAEMON_CONTROL_PROTOCOL_VERSION,
          }
        : null;
    default:
      return null;
  }
}

export function parseDaemonControlDaemonMessage(raw: unknown): DaemonControlDaemonMessage | null {
  const decoded = decodeFrame(raw);
  if (!isRecord(decoded) || decoded.version !== DAEMON_CONTROL_PROTOCOL_VERSION) {
    return null;
  }

  if (decoded.type !== 'command_ack') {
    return null;
  }

  const commandId = readIdentifier(decoded.commandId);
  if (commandId === null) {
    return null;
  }
  if (decoded.status === 'accepted' && hasExactKeys(decoded, COMMAND_ACCEPTED_KEYS)) {
    return {
      type: 'command_ack',
      version: DAEMON_CONTROL_PROTOCOL_VERSION,
      commandId,
      status: 'accepted',
    };
  }
  if (decoded.status === 'rejected' && hasExactKeys(decoded, COMMAND_REJECTED_KEYS)) {
    const reason = readRejectionReason(decoded.reason);
    return reason === null
      ? null
      : {
          type: 'command_ack',
          version: DAEMON_CONTROL_PROTOCOL_VERSION,
          commandId,
          status: 'rejected',
          reason,
        };
  }
  return null;
}

export function createDaemonControlRegisteredMessage(
  connectionId: string,
  presenceId: string,
  claimSeq: number,
  revocationGeneration: number,
  pingIntervalMs: number,
  silentAfterMs: number,
  stunServers: readonly string[],
  stunTicket: string,
  stunTicketSecret: string,
  stunTicketLifetimeMs: number,
  edgeAttachTicket: string,
  edges: readonly DaemonControlEdge[],
): DaemonControlRegisteredMessage {
  return {
    type: 'registered',
    version: DAEMON_CONTROL_PROTOCOL_VERSION,
    connectionId,
    presenceId,
    claimSeq,
    revocationGeneration,
    pingIntervalMs,
    silentAfterMs,
    stunServers,
    stunTicket,
    stunTicketSecret,
    stunTicketLifetimeMs,
    edgeAttachTicket,
    edges,
  };
}

export function createDaemonControlLeaseMessage(
  revocationGeneration: number,
  stunTicket: string,
  stunTicketSecret: string,
  stunTicketLifetimeMs: number,
  edgeAttachTicket: string,
  edges: readonly DaemonControlEdge[],
): DaemonControlLeaseMessage {
  return {
    type: 'lease',
    version: DAEMON_CONTROL_PROTOCOL_VERSION,
    revocationGeneration,
    stunTicket,
    stunTicketSecret,
    stunTicketLifetimeMs,
    edgeAttachTicket,
    edges,
  };
}

export function createDaemonControlRevocationMessage(
  revocationGeneration: number,
): DaemonControlRevocationMessage {
  return {
    type: 'revocation',
    version: DAEMON_CONTROL_PROTOCOL_VERSION,
    revocationGeneration,
  };
}

export function createDaemonControlSessionStartMessage(
  commandId: string,
  sessionId: string,
  browserNodeId: string,
  offer: DaemonControlSessionOffer,
  traceparent: string,
): DaemonControlSessionStartMessage {
  return {
    type: 'session_start',
    version: DAEMON_CONTROL_PROTOCOL_VERSION,
    commandId,
    sessionId,
    browserNodeId,
    offer,
    traceparent,
  };
}

export function createDaemonControlSessionCancelMessage(
  commandId: string,
  sessionId: string,
  browserNodeId: string,
  traceparent: string,
): DaemonControlSessionCancelMessage {
  return {
    type: 'session_cancel',
    version: DAEMON_CONTROL_PROTOCOL_VERSION,
    commandId,
    sessionId,
    browserNodeId,
    traceparent,
  };
}

export function createDaemonControlDelegationRevokeMessage(
  commandId: string,
  actorCertificate: UserDelegationCertificate,
  revocation: DelegationRevocationStatement,
  traceparent: string,
): DaemonControlDelegationRevokeMessage {
  return {
    type: 'delegation_revoke',
    version: DAEMON_CONTROL_PROTOCOL_VERSION,
    commandId,
    actorCertificate,
    revocation,
    traceparent,
  };
}

export function createDaemonControlSupersededMessage(): DaemonControlSupersededMessage {
  return {
    type: 'superseded',
    version: DAEMON_CONTROL_PROTOCOL_VERSION,
  };
}

export function createDaemonControlCommandAckMessage(
  commandId: string,
  result:
    | { readonly status: 'accepted' }
    | { readonly status: 'rejected'; readonly reason: string },
): DaemonControlCommandAckMessage {
  return result.status === 'accepted'
    ? {
        type: 'command_ack',
        version: DAEMON_CONTROL_PROTOCOL_VERSION,
        commandId,
        status: 'accepted',
      }
    : {
        type: 'command_ack',
        version: DAEMON_CONTROL_PROTOCOL_VERSION,
        commandId,
        status: 'rejected',
        reason: result.reason,
      };
}

export function encodeDaemonControlMessage(
  message: DaemonControlServerMessage | DaemonControlDaemonMessage,
): string {
  return JSON.stringify(message);
}

function parseRegistered(value: Record<string, unknown>): DaemonControlRegisteredMessage | null {
  if (!hasExactKeys(value, REGISTERED_KEYS)) {
    return null;
  }
  const connectionId = readIdentifier(value.connectionId);
  const presenceId = readIdentifier(value.presenceId);
  const claimSeq = readPositiveSafeInteger(value.claimSeq);
  const revocationGeneration = readNonNegativeSafeInteger(value.revocationGeneration);
  const pingIntervalMs = readPositiveSafeInteger(value.pingIntervalMs);
  const silentAfterMs = readPositiveSafeInteger(value.silentAfterMs);
  const stunServers = readStunServers(value.stunServers);
  const stunTicket = readStunTicket(value.stunTicket);
  const stunTicketSecret = readStunTicket(value.stunTicketSecret);
  const stunTicketLifetimeMs = readPositiveSafeInteger(value.stunTicketLifetimeMs);
  const edgeAttachTicket = readEdgeAttachTicket(value.edgeAttachTicket);
  const edges = readEdges(value.edges);
  if (
    connectionId === null ||
    presenceId === null ||
    claimSeq === null ||
    revocationGeneration === null ||
    pingIntervalMs === null ||
    silentAfterMs === null ||
    stunServers === null ||
    stunTicket === null ||
    stunTicketSecret === null ||
    stunTicketLifetimeMs === null ||
    edgeAttachTicket === null ||
    edges === null ||
    // A silence window no longer than the ping interval would report every
    // daemon silent between two consecutive frames.
    silentAfterMs <= pingIntervalMs
  ) {
    return null;
  }
  return {
    type: 'registered',
    version: DAEMON_CONTROL_PROTOCOL_VERSION,
    connectionId,
    presenceId,
    claimSeq,
    revocationGeneration,
    pingIntervalMs,
    silentAfterMs,
    stunServers,
    stunTicket,
    stunTicketSecret,
    stunTicketLifetimeMs,
    edgeAttachTicket,
    edges,
  };
}

function parseLease(value: Record<string, unknown>): DaemonControlLeaseMessage | null {
  if (!hasExactKeys(value, LEASE_KEYS)) {
    return null;
  }
  const revocationGeneration = readNonNegativeSafeInteger(value.revocationGeneration);
  const stunTicket = readStunTicket(value.stunTicket);
  const stunTicketSecret = readStunTicket(value.stunTicketSecret);
  const stunTicketLifetimeMs = readPositiveSafeInteger(value.stunTicketLifetimeMs);
  const edgeAttachTicket = readEdgeAttachTicket(value.edgeAttachTicket);
  const edges = readEdges(value.edges);
  return revocationGeneration === null ||
    stunTicket === null ||
    stunTicketSecret === null ||
    stunTicketLifetimeMs === null ||
    edgeAttachTicket === null ||
    edges === null
    ? null
    : {
        type: 'lease',
        version: DAEMON_CONTROL_PROTOCOL_VERSION,
        revocationGeneration,
        stunTicket,
        stunTicketSecret,
        stunTicketLifetimeMs,
        edgeAttachTicket,
        edges,
      };
}

/** Distinct canonical edge URLs, each with one or two distinct hashes. */
function readEdges(value: unknown): readonly DaemonControlEdge[] | null {
  if (!Array.isArray(value) || value.length > MAX_DAEMON_CONTROL_EDGES) return null;
  const edges: DaemonControlEdge[] = [];
  for (const edge of value) {
    if (
      !isRecord(edge) ||
      !hasExactKeys(edge, EDGE_KEYS) ||
      !isCanonicalEdgeWebTransportUrl(edge.edgeWtUrl) ||
      !isEdgeCertHashes(edge.certHashes) ||
      edges.some((known) => known.edgeWtUrl === edge.edgeWtUrl)
    ) {
      return null;
    }
    edges.push({ edgeWtUrl: edge.edgeWtUrl, certHashes: edge.certHashes });
  }
  return edges;
}

function isEdgeCertHashes(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_EDGE_CERT_HASHES &&
    value.every(isCanonicalSha256Base64) &&
    new Set(value).size === value.length
  );
}

function parseRevocation(value: Record<string, unknown>): DaemonControlRevocationMessage | null {
  if (!hasExactKeys(value, REVOCATION_KEYS)) {
    return null;
  }
  const revocationGeneration = readNonNegativeSafeInteger(value.revocationGeneration);
  return revocationGeneration === null
    ? null
    : {
        type: 'revocation',
        version: DAEMON_CONTROL_PROTOCOL_VERSION,
        revocationGeneration,
      };
}

function parseSessionStart(
  value: Record<string, unknown>,
): DaemonControlSessionStartMessage | null {
  if (!hasExactKeys(value, SESSION_START_KEYS)) {
    return null;
  }
  const commandId = readIdentifier(value.commandId);
  const sessionId = readIdentifier(value.sessionId);
  const browserNodeId = readIdentifier(value.browserNodeId);
  const offer = parseSessionOffer(value.offer);
  const traceparent = readTraceparent(value.traceparent);
  if (
    commandId === null ||
    sessionId === null ||
    browserNodeId === null ||
    offer === null ||
    traceparent === null
  ) {
    return null;
  }
  return {
    type: 'session_start',
    version: DAEMON_CONTROL_PROTOCOL_VERSION,
    commandId,
    sessionId,
    browserNodeId,
    offer,
    traceparent,
  };
}

function parseSessionCancel(
  value: Record<string, unknown>,
): DaemonControlSessionCancelMessage | null {
  if (!hasExactKeys(value, SESSION_CANCEL_KEYS)) {
    return null;
  }
  const commandId = readIdentifier(value.commandId);
  const sessionId = readIdentifier(value.sessionId);
  const browserNodeId = readIdentifier(value.browserNodeId);
  const traceparent = readTraceparent(value.traceparent);
  if (commandId === null || sessionId === null || browserNodeId === null || traceparent === null) {
    return null;
  }
  return {
    type: 'session_cancel',
    version: DAEMON_CONTROL_PROTOCOL_VERSION,
    commandId,
    sessionId,
    browserNodeId,
    traceparent,
  };
}

function parseDelegationRevoke(
  value: Record<string, unknown>,
): DaemonControlDelegationRevokeMessage | null {
  if (!hasExactKeys(value, DELEGATION_REVOKE_KEYS)) {
    return null;
  }
  const commandId = readIdentifier(value.commandId);
  const traceparent = readTraceparent(value.traceparent);
  if (commandId === null || traceparent === null) {
    return null;
  }
  try {
    return {
      type: 'delegation_revoke',
      version: DAEMON_CONTROL_PROTOCOL_VERSION,
      commandId,
      actorCertificate: parseUserDelegationCertificate(value.actorCertificate),
      revocation: parseDelegationRevocationStatement(value.revocation),
      traceparent,
    };
  } catch {
    return null;
  }
}

function parseUserDelegationCertificate(value: unknown): UserDelegationCertificate {
  if (
    !isRecord(value) ||
    !hasExactOrderedKeys(value, [
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
    ])
  ) {
    throw new Error('invalid delegation certificate');
  }
  const userId = readAuthorizationId(value.userId);
  const delegationId = readAuthorizationId(value.delegationId);
  const rootEpoch = readPositiveSafeInteger(value.rootEpoch);
  const issuedAt = readNonNegativeSafeInteger(value.issuedAt);
  const expiresAt = readNonNegativeSafeInteger(value.expiresAt);
  if (
    userId === null ||
    delegationId === null ||
    rootEpoch === null ||
    issuedAt === null ||
    expiresAt === null ||
    expiresAt - issuedAt !== USER_DELEGATION_LIFETIME_MS ||
    !isCanonicalAuthorizationOrigin(value.serverOrigin) ||
    !isCanonicalBase64UrlBytes(value.rootKeyCommitment, AUTHORIZATION_HASH_BYTES) ||
    !isCanonicalBase64UrlBytes(value.delegatePublicKey, ML_DSA_87_PUBLIC_KEY_BYTES) ||
    !isCanonicalBase64UrlBytes(value.signature, ML_DSA_87_SIGNATURE_BYTES) ||
    !Array.isArray(value.scopes) ||
    value.scopes.length !== 2 ||
    value.scopes[0] !== 'terminal-session' ||
    value.scopes[1] !== 'session-revoke'
  ) {
    throw new Error('invalid delegation certificate');
  }
  return {
    userId,
    rootKeyCommitment: value.rootKeyCommitment,
    delegationId,
    delegatePublicKey: value.delegatePublicKey,
    scopes: ['terminal-session', 'session-revoke'],
    serverOrigin: value.serverOrigin,
    rootEpoch,
    issuedAt,
    expiresAt,
    signature: value.signature,
  };
}

function parseDelegationRevocationStatement(value: unknown): DelegationRevocationStatement {
  if (
    !isRecord(value) ||
    !hasExactOrderedKeys(value, [
      'userId',
      'rootKeyCommitment',
      'actorDelegationId',
      'targets',
      'issuedAt',
      'nonce',
      'signature',
    ])
  ) {
    throw new Error('invalid delegation revocation');
  }
  const userId = readAuthorizationId(value.userId);
  const actorDelegationId = readAuthorizationId(value.actorDelegationId);
  const issuedAt = readNonNegativeSafeInteger(value.issuedAt);
  if (
    userId === null ||
    actorDelegationId === null ||
    issuedAt === null ||
    !isCanonicalBase64UrlBytes(value.rootKeyCommitment, AUTHORIZATION_HASH_BYTES) ||
    !isCanonicalBase64UrlBytes(value.nonce, AUTHORIZATION_NONCE_BYTES) ||
    !isCanonicalBase64UrlBytes(value.signature, ML_DSA_87_SIGNATURE_BYTES) ||
    !Array.isArray(value.targets) ||
    value.targets.length === 0 ||
    value.targets.length > 32
  ) {
    throw new Error('invalid delegation revocation');
  }
  const targets = value.targets.map((target) => parseDelegationRevocationTarget(target));
  if (
    targets.some(
      (target, index) =>
        index > 0 && (targets[index - 1]?.delegationId ?? '') >= target.delegationId,
    )
  ) {
    throw new Error('invalid delegation revocation');
  }
  return {
    userId,
    rootKeyCommitment: value.rootKeyCommitment,
    actorDelegationId,
    targets,
    issuedAt,
    nonce: value.nonce,
    signature: value.signature,
  };
}

function parseDelegationRevocationTarget(value: unknown): DelegationRevocationTarget {
  if (!isRecord(value) || !hasExactOrderedKeys(value, ['delegationId', 'expiresAt'])) {
    throw new Error('invalid delegation revocation target');
  }
  const delegationId = readAuthorizationId(value.delegationId);
  const expiresAt = readNonNegativeSafeInteger(value.expiresAt);
  if (delegationId === null || expiresAt === null) {
    throw new Error('invalid delegation revocation target');
  }
  return { delegationId, expiresAt };
}

function readAuthorizationId(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/u.test(value)
    ? value
    : null;
}

function isCanonicalAuthorizationOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || UTF8_ENCODER.encode(value).byteLength > 2_048) return false;
  try {
    const url = new URL(value);
    const isLoopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return (
      url.origin === value &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback))
    );
  } catch {
    return false;
  }
}

function parseSessionOffer(value: unknown): DaemonControlSessionOffer | null {
  if (!isRecord(value) || !hasExactKeys(value, SESSION_OFFER_KEYS)) {
    return null;
  }
  const userId = readIdentifier(value.userId);
  const delegationId = readIdentifier(value.delegationId);
  if (
    userId === null ||
    delegationId === null ||
    !isCanonicalBase64UrlBytes(value.clientNonce, SESSION_CLIENT_NONCE_BYTES) ||
    !isCanonicalBase64UrlBytes(value.encapsulationKey, ML_KEM_1024_ENCAPSULATION_KEY_BYTES)
  ) {
    return null;
  }
  if (!isCanonicalEdgeWebTransportUrl(value.edgeWtUrl) || !isEdgeCertHashes(value.edgeCertHashes)) {
    return null;
  }
  return {
    userId,
    delegationId,
    clientNonce: value.clientNonce,
    encapsulationKey: value.encapsulationKey,
    edgeWtUrl: value.edgeWtUrl,
    edgeCertHashes: value.edgeCertHashes,
  };
}

function isCanonicalBase64UrlBytes(value: unknown, expectedBytes: number): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const remainder = value.length % 4;
    if (remainder === 1) return false;
    const padded =
      value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - remainder) % 4);
    const decoded = atob(padded);
    const canonical = btoa(decoded).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    return decoded.length === expectedBytes && canonical === value;
  } catch {
    return false;
  }
}

function decodeFrame(raw: unknown): unknown | null {
  if (typeof raw === 'string') {
    if (UTF8_ENCODER.encode(raw).byteLength > MAX_DAEMON_CONTROL_FRAME_BYTES) {
      return null;
    }
    return parseJson(raw);
  }
  if (raw instanceof ArrayBuffer) {
    return decodeBytes(new Uint8Array(raw));
  }
  if (ArrayBuffer.isView(raw)) {
    return decodeBytes(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  }
  if (isRecord(raw)) {
    try {
      const encoded = JSON.stringify(raw);
      return UTF8_ENCODER.encode(encoded).byteLength <= MAX_DAEMON_CONTROL_FRAME_BYTES ? raw : null;
    } catch {
      return null;
    }
  }
  return null;
}

function decodeBytes(bytes: Uint8Array): unknown | null {
  if (bytes.byteLength > MAX_DAEMON_CONTROL_FRAME_BYTES) {
    return null;
  }
  try {
    return parseJson(UTF8_DECODER.decode(bytes));
  } catch {
    return null;
  }
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function hasExactOrderedKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

/**
 * A ticket is opaque to the daemon: it forwards the bytes and never interprets
 * them. Validation is therefore shape only — bounded length and the base64url
 * alphabet, so a malformed one is refused here rather than at the socket.
 */
/** Opaque to the daemon like the STUN ticket, and exactly the edge's length. */
function readEdgeAttachTicket(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length === EDGE_ATTACH_TICKET_CHARS &&
    /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : null;
}

function readStunTicket(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  if (value.length > MAX_STUN_TICKET_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  return value;
}

/**
 * `host:port` vantage points, bounded and de-duplicated.
 *
 * Duplicates are refused rather than collapsed: two identical entries would
 * look like two observations to the daemon's NAT inference and behave like
 * one, which is worse than having one.
 */
function readStunServers(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STUN_SERVERS) {
    return null;
  }
  const servers: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return null;
    }
    if (entry.length > MAX_STUN_SERVER_CHARS || containsControlCharacter(entry)) {
      return null;
    }
    if (servers.includes(entry)) {
      return null;
    }
    servers.push(entry);
  }
  return servers;
}

/**
 * A W3C `traceparent`, or the empty string when the sender had no active span.
 *
 * Narrow rather than a generic string check, matching the house style for every
 * other field here: the format is fixed-width hex, so anything else is a bug or
 * an attack, and neither should reach a span's parent.
 */
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

function readTraceparent(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (value === '' || TRACEPARENT_PATTERN.test(value)) {
    return value;
  }
  return null;
}

function readIdentifier(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const byteLength = UTF8_ENCODER.encode(value).byteLength;
  if (byteLength > MAX_IDENTIFIER_BYTES || containsControlCharacter(value)) {
    return null;
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function readRejectionReason(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    UTF8_ENCODER.encode(value).byteLength > MAX_REJECTION_REASON_BYTES ||
    !/^[a-z][a-z0-9_]*$/u.test(value)
  ) {
    return null;
  }
  return value;
}

function readPositiveSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0 ? value : null;
}

function readNonNegativeSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 ? value : null;
}

function isCanonicalEdgeWebTransportUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === '' &&
      url.toString() === value
    );
  } catch {
    return false;
  }
}

function isCanonicalSha256Base64(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const decoded = atob(value);
    return decoded.length === 32 && btoa(decoded) === value;
  } catch {
    return false;
  }
}
