import { describe, expect, test } from 'bun:test';

import {
  createStunTicketIssuer,
  deriveStunIntegrityKey,
  encodeStunTicket,
  STUN_TICKET_LIFETIME_MS,
  verifyStunTicket,
} from './stun-ticket-service';

/**
 * The STUN ticket format has two implementations: this one issues, and
 * `apps/stun/src/ticket.rs` verifies. Nothing at runtime checks that they
 * agree — a daemon handed a ticket the responder rejects simply gets silence,
 * which surfaces as `NatMapping::Unknown` and a quietly missing direct path.
 *
 * So the encoding is pinned here against fixed vectors rather than against
 * whatever this file currently produces. The same vectors appear in the Rust
 * crate's tests; if either side changes the layout, the labels, or the
 * truncation, one of the two suites fails.
 */

const KEY = Buffer.alloc(64, 3);
const NONCE = Buffer.alloc(16, 7);
const EXPIRY = 1_000_600n;

describe('ticket encoding', () => {
  /**
   * The exact bytes. Independently produced by the Rust verifier's own test
   * (`the_pinned_cross_language_vector_round_trips`) from the same inputs, so
   * this is a genuine cross-language check rather than a snapshot of whatever
   * this file happens to emit. Layout:
   * version(1) || expiry_be64(8) || nonce(16) || HMAC-SHA256(key,
   * "merkur-stun-ticket-v1" || version || expiry || nonce)[0..16].
   */
  test('encodes to a stable, fixed-length credential', () => {
    const ticket = encodeStunTicket(KEY, EXPIRY, NONCE);
    const decoded = Buffer.from(ticket, 'base64url');

    expect(decoded.byteLength).toBe(41);
    expect(decoded.readUInt8(0)).toBe(1);
    expect(decoded.readBigUInt64BE(1)).toBe(EXPIRY);
    expect(decoded.subarray(9, 25).toString('base64url')).toBe(NONCE.toString('base64url'));
    // base64url of 41 bytes is 55 characters, which is what the control
    // protocol's length bound and the responder's amplification budget assume.
    expect(ticket).toHaveLength(55);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  /**
   * The pinned vector. A change to the tag label, the field order, the integer
   * width, or the truncation length moves this string.
   */
  test('matches the pinned cross-language vector', () => {
    expect(encodeStunTicket(KEY, EXPIRY, NONCE)).toBe(
      'AQAAAAAAD0SYBwcHBwcHBwcHBwcHBwcHB5XG308T8ATzJFC6B2Xm0XE',
    );
  });

  test('the tag covers every authenticated field', () => {
    const base = encodeStunTicket(KEY, EXPIRY, NONCE);
    expect(encodeStunTicket(KEY, EXPIRY + 1n, NONCE)).not.toBe(base);
    expect(encodeStunTicket(KEY, EXPIRY, Buffer.alloc(16, 8))).not.toBe(base);
    expect(encodeStunTicket(Buffer.alloc(64, 4), EXPIRY, NONCE)).not.toBe(base);
  });

  test('a nonce of the wrong width is refused rather than padded', () => {
    expect(() => encodeStunTicket(KEY, EXPIRY, Buffer.alloc(8, 7))).toThrow();
    expect(() => encodeStunTicket(KEY, EXPIRY, Buffer.alloc(32, 7))).toThrow();
  });
});

describe('ticket verification', () => {
  test('an issued ticket verifies under its own key', () => {
    expect(verifyStunTicket(KEY, encodeStunTicket(KEY, EXPIRY, NONCE))).toBe(true);
  });

  test('a ticket from another deployment key is refused', () => {
    const foreign = encodeStunTicket(Buffer.alloc(64, 4), EXPIRY, NONCE);
    expect(verifyStunTicket(KEY, foreign)).toBe(false);
  });

  /**
   * Every byte is authenticated. Flipping any one of them — including inside
   * the tag itself — must fail, which is what stops a captured ticket from
   * being edited into a longer-lived one.
   */
  test('any single mutated byte invalidates a ticket', () => {
    const original = Buffer.from(encodeStunTicket(KEY, EXPIRY, NONCE), 'base64url');
    for (let index = 0; index < original.byteLength; index += 1) {
      const mutated = Buffer.from(original);
      // biome-ignore lint/style/noNonNullAssertion: index is bounded by the loop.
      mutated[index] = mutated[index]! ^ 0x01;
      expect(verifyStunTicket(KEY, mutated.toString('base64url'))).toBe(false);
    }
  });

  test('a truncated or overlong credential is refused before any HMAC', () => {
    const valid = encodeStunTicket(KEY, EXPIRY, NONCE);
    const bytes = Buffer.from(valid, 'base64url');
    expect(verifyStunTicket(KEY, bytes.subarray(0, 40).toString('base64url'))).toBe(false);
    expect(verifyStunTicket(KEY, Buffer.concat([bytes, Buffer.of(0)]).toString('base64url'))).toBe(
      false,
    );
    expect(verifyStunTicket(KEY, '')).toBe(false);
  });
});

describe('integrity key derivation', () => {
  /**
   * The key the daemon signs with must be bound to the specific ticket. If two
   * tickets shared a key, one daemon's credential would authenticate another's
   * messages.
   */
  test('each ticket derives a distinct key', () => {
    const first = encodeStunTicket(KEY, EXPIRY, Buffer.alloc(16, 1));
    const second = encodeStunTicket(KEY, EXPIRY, Buffer.alloc(16, 2));
    expect(deriveStunIntegrityKey(KEY, first).toString('base64url')).not.toBe(
      deriveStunIntegrityKey(KEY, second).toString('base64url'),
    );
  });

  test('derivation is a full-width HMAC output', () => {
    expect(deriveStunIntegrityKey(KEY, encodeStunTicket(KEY, EXPIRY, NONCE))).toHaveLength(32);
  });

  /**
   * The tag and the integrity key come from the same 64-byte secret, so the
   * domain-separation labels are load-bearing. Without them a ticket's own tag
   * would be a prefix of a valid signing key.
   */
  test('the integrity key is domain-separated from the ticket tag', () => {
    const ticket = encodeStunTicket(KEY, EXPIRY, NONCE);
    const tag = Buffer.from(ticket, 'base64url').subarray(25);
    const integrity = deriveStunIntegrityKey(KEY, ticket);
    expect(integrity.subarray(0, 16).toString('base64url')).not.toBe(tag.toString('base64url'));
  });

  test('the pinned integrity vector matches the Rust derivation', () => {
    expect(
      deriveStunIntegrityKey(KEY, encodeStunTicket(KEY, EXPIRY, NONCE)).toString('base64url'),
    ).toBe('MiRErNQ0xkLbd72f3fsxZqtyo9wJ_LbvmlppSKq85zA');
  });
});

describe('issuer', () => {
  test('mints a ticket that verifies, with the configured lifetime', () => {
    const issuer = createStunTicketIssuer(new Uint8Array(KEY), ['a:3478', 'b:3479'], []);
    const minted = issuer.issue(1_700_000_000_000);

    expect(verifyStunTicket(KEY, minted.ticket)).toBe(true);
    expect(minted.lifetimeMs).toBe(STUN_TICKET_LIFETIME_MS);
    // The reported lifetime has to describe the expiry actually sealed into the
    // ticket, or the daemon stops probing at a moment unrelated to when the
    // responder starts refusing it. Read the expiry back off the wire bytes
    // rather than trusting the field beside them.
    expect(Number(Buffer.from(minted.ticket, 'base64url').readBigUInt64BE(1))).toBe(
      Math.floor((1_700_000_000_000 + STUN_TICKET_LIFETIME_MS) / 1000),
    );
    expect(minted.secret).toBe(deriveStunIntegrityKey(KEY, minted.ticket).toString('base64url'));
    expect([...issuer.serversFor(null)]).toEqual(['a:3478', 'b:3479']);
  });

  /**
   * A box reaches its own host's observer without crossing its NAT, so that
   * observer sees the box's private address. Leaving it out of the box's list
   * is what keeps the box from reading its own bridge as a symmetric NAT.
   */
  test("a box daemon is not given its own host's observers", () => {
    const issuer = createStunTicketIssuer(
      new Uint8Array(KEY),
      ['fly:3478', 'fly:3479', '[2001:db8::5]:34780', '198.51.100.9:34780'],
      ['[2001:db8::5]:34780', '198.51.100.9:34780'],
    );
    expect([...issuer.serversFor('calm-harbor')]).toEqual(['fly:3478', 'fly:3479']);
    expect([...issuer.serversFor(null)]).toEqual([
      'fly:3478',
      'fly:3479',
      '[2001:db8::5]:34780',
      '198.51.100.9:34780',
    ]);
  });

  /**
   * Two tickets minted in the same millisecond must differ, or a captured one
   * would be indistinguishable from the next one issued.
   */
  test('successive tickets are distinct even at the same instant', () => {
    const issuer = createStunTicketIssuer(new Uint8Array(KEY), ['a:3478', 'b:3479'], []);
    const first = issuer.issue(1_700_000_000_000);
    const second = issuer.issue(1_700_000_000_000);
    expect(first.ticket).not.toBe(second.ticket);
    expect(first.secret).not.toBe(second.secret);
  });

  /**
   * The lifetime must stay inside the responder's independently enforced
   * ceiling (`MAX_TICKET_LIFETIME_SECS` = 15 minutes in `ticket.rs`), or every
   * minted ticket would be refused as `LifetimeTooLong`.
   */
  test('the lifetime stays within the responder ceiling', () => {
    expect(STUN_TICKET_LIFETIME_MS).toBeLessThan(15 * 60 * 1000);
  });
});
