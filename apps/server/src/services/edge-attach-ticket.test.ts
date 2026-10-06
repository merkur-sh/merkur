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
    expect(encodeEdgeAttachTicket(KEY, 'browser', 'daemon-1', 'session-1', 0n)).toBe(
      'AQEAAAAAAAAAAKjJ6FRstzs_T-7SD4qU60I',
    );
    expect(encodeEdgeAttachTicket(KEY, 'daemon', 'daemon-1', '', 1_790_000_090n)).toBe(
      'AQIAAAAAarE72rtPDdT1Fc4HX_bsiZ172Gk',
    );
  });

  test('preserves UTF-8 byte lengths, embedded NULs and all eight expiry bytes', () => {
    expect(
      encodeEdgeAttachTicket(KEY, 'browser', 'daemon-α\0雪', 'session-🛰️', 0xffffffffffffffffn),
    ).toBe('AQH__________waM3NSf6tKGBS0r_uxWg9k');
    expect(
      encodeEdgeAttachTicket(KEY, 'daemon', 'daemon-α\0雪', 'session-🛰️', 0xffffffffffffffffn),
    ).toBe('AQL__________0leBSAvzojb65AdnJyUn4w');
  });

  test('bounds each identifier by its encoded byte length', () => {
    const maximum = '雪'.repeat(21_845);
    expect(() => encodeEdgeAttachTicket(KEY, 'browser', maximum, maximum, 0n)).not.toThrow();
    expect(() => encodeEdgeAttachTicket(KEY, 'browser', `${maximum}a`, '', 0n)).toThrow();
    expect(() => encodeEdgeAttachTicket(KEY, 'browser', '', `${maximum}a`, 0n)).toThrow();
  });

  test('a daemon ticket names no session and expires one lifetime out', () => {
    const issuer = createEdgeAttachTicketIssuer(new Uint8Array(KEY));
    const nowMs = 1_790_000_000_000;
    expect(issuer.forDaemon('daemon-1', nowMs)).toBe(
      encodeEdgeAttachTicket(
        KEY,
        'daemon',
        'daemon-1',
        '',
        BigInt((nowMs + EDGE_ATTACH_TICKET_LIFETIME_MS) / 1000),
      ),
    );
  });

  test('a browser ticket binds its session and daemon and carries no expiry', () => {
    const issuer = createEdgeAttachTicketIssuer(new Uint8Array(KEY));
    const ticket = issuer.forBrowser('daemon-1', 'session-1');
    expect(ticket).toBe(encodeEdgeAttachTicket(KEY, 'browser', 'daemon-1', 'session-1', 0n));
    expect(issuer.forBrowser('daemon-2', 'session-1')).not.toBe(ticket);
    expect(issuer.forBrowser('daemon-1', 'session-2')).not.toBe(ticket);
    expect(Buffer.from(ticket, 'base64url').subarray(2, 10)).toEqual(Buffer.alloc(8));
  });
});
