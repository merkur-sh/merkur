import { describe, expect, test } from 'bun:test';
import {
  createEdgeAttachTicketIssuer,
  EDGE_ATTACH_TICKET_LIFETIME_MS,
  encodeEdgeAttachTicket,
} from './edge-attach-ticket';

const KEY = Buffer.alloc(64, 7);

describe('edge attach tickets', () => {
  // Pinned byte-for-byte by `conformance_vector` in apps/edge/src/attach_ticket.rs.
  test('match the vector the edge verifier pins', () => {
    expect(encodeEdgeAttachTicket(KEY, 'browser', 'account-1', 'daemon-1', 'session-1', 0n)).toBe(
      'AQEAAAAAAAAAAOKVgb4PtGhqTO1v5xkqMU9wmdJv6YvIntrCbyT7ouK2',
    );
    expect(encodeEdgeAttachTicket(KEY, 'daemon', 'account-1', 'daemon-1', '', 1_790_000_090n)).toBe(
      'AQIAAAAAarE72uKVgb4PtGhqTO1v5xkqMU_kLSZi3SgA0mujNhWJ0mox',
    );
  });

  test('preserves UTF-8 byte lengths, embedded NULs and all eight expiry bytes', () => {
    const odd = ['account-α\0雪', 'daemon-α\0雪', 'session-🛰️'] as const;
    expect(encodeEdgeAttachTicket(KEY, 'browser', ...odd, 0xffffffffffffffffn)).toBe(
      'AQH__________yPoPQ0KmbAAeko0NhEtx7O55lbMJiFk4Vki_DYTocrz',
    );
    expect(encodeEdgeAttachTicket(KEY, 'daemon', ...odd, 0xffffffffffffffffn)).toBe(
      'AQL__________yPoPQ0KmbAAeko0NhEtx7MFUrpDfOVNa2Q_rzPkMQS_',
    );
  });

  test('bounds each identifier by its encoded byte length', () => {
    const maximum = '雪'.repeat(21_845);
    expect(() => encodeEdgeAttachTicket(KEY, 'browser', 'a', maximum, maximum, 0n)).not.toThrow();
    expect(() => encodeEdgeAttachTicket(KEY, 'browser', 'a', `${maximum}a`, '', 0n)).toThrow();
    expect(() => encodeEdgeAttachTicket(KEY, 'browser', 'a', '', `${maximum}a`, 0n)).toThrow();
  });

  test('a daemon ticket names no session and expires one lifetime out', () => {
    const issuer = createEdgeAttachTicketIssuer(new Uint8Array(KEY));
    const nowMs = 1_790_000_000_000;
    expect(issuer.forDaemon('account-1', 'daemon-1', nowMs)).toBe(
      encodeEdgeAttachTicket(
        KEY,
        'daemon',
        'account-1',
        'daemon-1',
        '',
        BigInt((nowMs + EDGE_ATTACH_TICKET_LIFETIME_MS) / 1000),
      ),
    );
  });

  test('a browser ticket binds its session and daemon and carries no expiry', () => {
    const issuer = createEdgeAttachTicketIssuer(new Uint8Array(KEY));
    const ticket = issuer.forBrowser('account-1', 'daemon-1', 'session-1');
    expect(ticket).toBe(
      encodeEdgeAttachTicket(KEY, 'browser', 'account-1', 'daemon-1', 'session-1', 0n),
    );
    expect(issuer.forBrowser('account-1', 'daemon-2', 'session-1')).not.toBe(ticket);
    expect(issuer.forBrowser('account-1', 'daemon-1', 'session-2')).not.toBe(ticket);
    expect(Buffer.from(ticket, 'base64url').subarray(2, 10)).toEqual(Buffer.alloc(8));
  });

  test('every ticket of one account names the same opaque tenant, and no other', () => {
    const issuer = createEdgeAttachTicketIssuer(new Uint8Array(KEY));
    const tenant = (ticket: string) => Buffer.from(ticket, 'base64url').subarray(10, 26);
    const browser = issuer.forBrowser('account-1', 'daemon-1', 'session-1');
    expect(tenant(issuer.forDaemon('account-1', 'daemon-2', 0))).toEqual(tenant(browser));
    expect(tenant(issuer.forBrowser('account-2', 'daemon-1', 'session-1'))).not.toEqual(
      tenant(browser),
    );
    expect(tenant(browser).includes(Buffer.from('account-1'))).toBe(false);
  });
});
