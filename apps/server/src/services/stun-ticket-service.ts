import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Mints the short-lived credentials that let a daemon use the Merkur STUN
 * responders.
 *
 * The wire format has a second implementation in Rust
 * (`apps/stun/src/ticket.rs`), which is the one that verifies. The two must
 * stay byte-identical; `stun-ticket-service.test.ts` pins the encoding against
 * vectors rather than against this code, so a change here that the responder
 * does not follow fails a test instead of silently locking every daemon out of
 * NAT discovery.
 *
 * Why the server holds the key at all: the responder must remain stateless and
 * hold nothing per daemon, so authorisation has to travel in the credential.
 * The daemon never sees this key — it receives only a minted ticket, over the
 * control connection it has already authenticated.
 */

const TICKET_VERSION = 1;
const NONCE_BYTES = 16;
const TAG_BYTES = 16;
/** version(1) + expiry(8) + nonce(16) + tag(16) */
const TICKET_BYTES = 1 + 8 + NONCE_BYTES + TAG_BYTES;

/** Must match `apps/stun/src/ticket.rs`. */
const TAG_LABEL = Buffer.from('merkur-stun-ticket-v1', 'utf8');
const INTEGRITY_LABEL = Buffer.from('merkur-stun-message-integrity-v1', 'utf8');

/**
 * How long a minted ticket stays valid.
 *
 * Well inside the responder's own ceiling (`MAX_TICKET_LIFETIME_SECS`), which
 * it enforces independently — the responder does not trust this value, it
 * bounds it.
 *
 * Sized against the refresh cadence, not against a probe. A replacement ticket
 * rides every lease renewal (`DAEMON_CONTROL_LEASE_RENEWAL_MS`, 20 s), so a
 * connected daemon always holds one with at least seventy seconds left, and a
 * probe needs about three seconds of it. What the lifetime actually decides is
 * how long a *disconnected* daemon can keep probing — which is the property the
 * refresh cadence was already claimed to deliver and could not, because a
 * ten-minute ticket outlives the connection that carried it by ten minutes
 * however often it is replaced. Ninety seconds is what makes the two agree.
 */
export const STUN_TICKET_LIFETIME_MS = 90 * 1000;

export interface StunTicket {
  /** base64url, carried verbatim in the STUN USERNAME attribute. */
  readonly ticket: string;
  /**
   * base64url of the 32-byte key this ticket's MESSAGE-INTEGRITY-SHA256 is
   * computed under, by both the daemon and the responder.
   *
   * Handed over because the daemon cannot derive it without the deployment
   * secret, and giving it that secret would let it mint tickets rather than
   * merely use one.
   */
  readonly secret: string;
  /**
   * Validity as a duration, which is what the control message carries.
   *
   * Not an absolute instant: the daemon would have to compare it against its own
   * clock, and a daemon running ahead of the server would read every fresh
   * ticket as already expired and stop probing. The receiver stamps a duration
   * against its own clock instead, so only elapsed time matters.
   */
  readonly lifetimeMs: number;
}

/**
 * Mints tickets from a fixed key. Pure apart from the nonce: the caller passes
 * the current time, so the daemon-control service mints from the same clock it
 * already uses and a test can pin an expiry without waiting on wall time.
 *
 * Not an Effect service. There is no I/O, no lifecycle, and nothing to fail —
 * wrapping an HMAC in a requirements channel would add indirection to a call
 * that happens on every heartbeat.
 */
export interface StunTicketIssuer {
  readonly issue: (nowMs: number) => StunTicket;
  /**
   * Vantage points advertised to one daemon, as `host:port`.
   *
   * A box daemon gets the list without the observers on its own box host: it
   * reaches them without crossing its NAT, so they would see its private address
   * and classify nothing but the host's own bridge.
   */
  readonly serversFor: (boxId: string | null) => readonly string[];
}

export function createStunTicketIssuer(
  key: Uint8Array,
  servers: readonly string[],
  boxHostObservers: readonly string[],
): StunTicketIssuer {
  const keyBuffer = Buffer.from(key);
  const coLocated = new Set(boxHostObservers);
  const boxServers = servers.filter((server) => !coLocated.has(server));
  return {
    serversFor: (boxId) => (boxId === null ? servers : boxServers),
    issue: (nowMs: number): StunTicket => {
      const expiresAtMs = nowMs + STUN_TICKET_LIFETIME_MS;
      const ticket = encodeStunTicket(
        keyBuffer,
        BigInt(Math.floor(expiresAtMs / 1000)),
        randomBytes(NONCE_BYTES),
      );
      return {
        ticket,
        secret: deriveStunIntegrityKey(keyBuffer, ticket).toString('base64url'),
        lifetimeMs: STUN_TICKET_LIFETIME_MS,
      };
    },
  };
}

function ticketTag(key: Buffer, ticket: Buffer): Buffer {
  return new Bun.CryptoHasher('sha256', key)
    .update(TAG_LABEL)
    .update(ticket.subarray(0, 9 + NONCE_BYTES))
    .digest()
    .subarray(0, TAG_BYTES);
}

/**
 * Encode a ticket. Exported for the conformance test, which checks this against
 * fixed vectors so the Rust verifier and this issuer cannot drift apart.
 */
export function encodeStunTicket(key: Buffer, expiryUnixSeconds: bigint, nonce: Buffer): string {
  if (nonce.byteLength !== NONCE_BYTES) {
    throw new Error(`stun ticket nonce must be ${NONCE_BYTES} bytes`);
  }
  const ticket = Buffer.alloc(TICKET_BYTES);
  ticket.writeUInt8(TICKET_VERSION, 0);
  ticket.writeBigUInt64BE(expiryUnixSeconds, 1);
  nonce.copy(ticket, 9);
  ticketTag(key, ticket).copy(ticket, 9 + NONCE_BYTES);
  return ticket.toString('base64url');
}

/**
 * Derive the message-integrity key a responder will use for this ticket.
 *
 * The server never needs this — the daemon derives it the same way from the
 * ticket it was handed, and the responder derives it from the ticket it
 * receives. It exists here so the conformance test can prove all three
 * derivations agree.
 */
export function deriveStunIntegrityKey(key: Buffer, ticket: string): Buffer {
  return new Bun.CryptoHasher('sha256', key)
    .update(INTEGRITY_LABEL)
    .update(Buffer.from(ticket, 'base64url'))
    .digest();
}

/**
 * Verify a ticket, mirroring the responder's checks.
 *
 * Only used by tests: the server issues, it never verifies. Present so the
 * issuer's own encoding is checked by something other than itself.
 */
export function verifyStunTicket(key: Buffer, ticket: string): boolean {
  const decoded = Buffer.from(ticket, 'base64url');
  if (decoded.byteLength !== TICKET_BYTES || decoded.readUInt8(0) !== TICKET_VERSION) {
    return false;
  }
  const expected = ticketTag(key, decoded);
  return timingSafeEqual(expected, decoded.subarray(9 + NONCE_BYTES));
}
