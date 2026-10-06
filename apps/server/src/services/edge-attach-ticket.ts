/**
 * Mints the attach tickets without which an edge closes a peer before it
 * reaches the splice registry.
 *
 * The wire format has a second implementation in Rust
 * (`apps/edge/src/attach_ticket.rs`), which is the one that verifies. The two
 * must stay byte-identical; `edge-attach-ticket.test.ts` and the edge's
 * `conformance_vector` pin the same vector, because nothing at runtime detects
 * drift — a mismatch would lock every session out of the relay.
 *
 * A daemon ticket binds the daemon id and expires; one rides every control
 * lease, so a daemon that is unlinked or disconnected stops being able to
 * attach within one lifetime. A browser ticket binds a session and the daemon
 * it was issued for and never expires: renewal and rebind happen in-band, and
 * the ticket is useless without a live daemon ticket for the same daemon.
 */

const TICKET_VERSION = 1;
const ROLE_BROWSER = 1;
const ROLE_DAEMON = 2;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + 1 + 8;
/** version(1) + role(1) + expiry(8) + tag(16) */
const TICKET_BYTES = HEADER_BYTES + TAG_BYTES;
/** Decoded length of every ticket, for callers validating one they persisted. */
export const EDGE_ATTACH_TICKET_BYTES = TICKET_BYTES;
/** Must match `apps/edge/src/attach_ticket.rs`. */
const TAG_LABEL = Buffer.from('merkur-edge-attach-ticket-v1', 'utf8');
/** The length prefix the tag uses for each identifier. */
const MAX_FIELD_BYTES = 0xffff;

/**
 * How long a daemon ticket stays valid.
 *
 * Sized against the refresh cadence exactly as the STUN ticket is: a
 * replacement rides every lease renewal (`DAEMON_CONTROL_LEASE_RENEWAL_MS`,
 * 20 s), so a connected daemon always holds one with at least seventy seconds
 * left, and what the lifetime decides is how long a daemon that lost its
 * control connection — or was unlinked — can still attach. The edge bounds it
 * independently.
 */
export const EDGE_ATTACH_TICKET_LIFETIME_MS = 90 * 1000;

export interface EdgeAttachTicketIssuer {
  /** The ticket a daemon presents on every edge dial until the next lease. */
  readonly forDaemon: (daemonId: string, nowMs: number) => string;
  /** The ticket a browser presents on every lane of one session. */
  readonly forBrowser: (daemonId: string, sessionId: string) => string;
}

/**
 * Not an Effect service, for the reason the STUN issuer is not: an HMAC with no
 * I/O and nothing to fail, called on every lease and every issuance.
 */
export function createEdgeAttachTicketIssuer(key: Uint8Array): EdgeAttachTicketIssuer {
  const keyBuffer = Buffer.from(key);
  return {
    forDaemon: (daemonId, nowMs) =>
      encodeEdgeAttachTicket(
        keyBuffer,
        'daemon',
        daemonId,
        '',
        BigInt(Math.floor((nowMs + EDGE_ATTACH_TICKET_LIFETIME_MS) / 1000)),
      ),
    forBrowser: (daemonId, sessionId) =>
      encodeEdgeAttachTicket(keyBuffer, 'browser', daemonId, sessionId, 0n),
  };
}

/**
 * Encode a ticket. Exported for the conformance test, which checks it against
 * the vector the edge's verifier also pins.
 */
export function encodeEdgeAttachTicket(
  key: Buffer,
  role: 'browser' | 'daemon',
  daemonId: string,
  sessionId: string,
  expiryUnixSeconds: bigint,
): string {
  const roleByte = role === 'browser' ? ROLE_BROWSER : ROLE_DAEMON;
  const daemon = Buffer.from(daemonId, 'utf8');
  const session = Buffer.from(role === 'browser' ? sessionId : '', 'utf8');
  if (daemon.byteLength > MAX_FIELD_BYTES || session.byteLength > MAX_FIELD_BYTES) {
    throw new Error('edge attach ticket field exceeds its length prefix');
  }
  const authenticated = Buffer.alloc(
    TAG_LABEL.byteLength + HEADER_BYTES + 4 + daemon.byteLength + session.byteLength,
  );
  let offset = TAG_LABEL.copy(authenticated);
  authenticated.writeUInt8(TICKET_VERSION, offset);
  authenticated.writeUInt8(roleByte, offset + 1);
  authenticated.writeBigUInt64BE(expiryUnixSeconds, offset + 2);
  offset += HEADER_BYTES;
  authenticated.writeUInt16BE(daemon.byteLength, offset);
  offset += 2;
  offset += daemon.copy(authenticated, offset);
  authenticated.writeUInt16BE(session.byteLength, offset);
  offset += 2;
  session.copy(authenticated, offset);
  const tag = new Bun.CryptoHasher('sha256', key).update(authenticated).digest();
  const ticket = Buffer.alloc(TICKET_BYTES);
  authenticated.copy(ticket, 0, TAG_LABEL.byteLength, TAG_LABEL.byteLength + HEADER_BYTES);
  tag.copy(ticket, HEADER_BYTES, 0, TAG_BYTES);
  return ticket.toString('base64url');
}
