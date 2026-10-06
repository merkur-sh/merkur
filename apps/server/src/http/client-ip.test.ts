import { describe, expect, test } from 'bun:test';

import { resolveClientIp, resolveRateLimitSource } from './client-ip';

const SOCKET_ADDRESS = '198.51.100.7';

function request(forwardedFor?: string): Request {
  return new Request('https://merkur.test/api/auth/continue', {
    method: 'POST',
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  });
}

const server = {
  requestIP: () => ({ address: SOCKET_ADDRESS }),
};

describe('resolveClientIp', () => {
  test('ignores X-Forwarded-For entirely when no proxy is trusted', () => {
    // A directly reachable server lets any client forge the header, so trusting
    // it would hand out a fresh rate-limit key per request.
    expect(resolveClientIp(request('203.0.113.1'), server, 0)).toBe(SOCKET_ADDRESS);
    expect(resolveClientIp(request('203.0.113.1, 203.0.113.2'), server, 0)).toBe(SOCKET_ADDRESS);
  });

  test('reads the entry appended by the outermost trusted proxy', () => {
    expect(resolveClientIp(request('203.0.113.1, 10.0.0.1'), server, 1)).toBe('10.0.0.1');
    expect(resolveClientIp(request('203.0.113.1, 10.0.0.1, 10.0.0.2'), server, 2)).toBe('10.0.0.1');
    expect(resolveClientIp(request(' 203.0.113.9 '), server, 1)).toBe('203.0.113.9');
  });

  test('never reaches left of the trusted hop when the header is too short', () => {
    // A forged single-entry header behind two real proxies must not be read as
    // the client address.
    expect(resolveClientIp(request('203.0.113.1'), server, 2)).toBe(SOCKET_ADDRESS);
    expect(resolveClientIp(request('203.0.113.1, 10.0.0.1'), server, 3)).toBe(SOCKET_ADDRESS);
  });

  test('falls back to the socket address for absent or non-IP entries', () => {
    expect(resolveClientIp(request(), server, 1)).toBe(SOCKET_ADDRESS);
    expect(resolveClientIp(request('not-an-ip'), server, 1)).toBe(SOCKET_ADDRESS);
    expect(resolveClientIp(request('   '), server, 1)).toBe(SOCKET_ADDRESS);
    expect(resolveClientIp(request('203.0.113.1, '), server, 1)).toBe(SOCKET_ADDRESS);
  });

  test('resolves IPv6 forwarded entries', () => {
    expect(resolveClientIp(request('203.0.113.1, 2001:db8::1'), server, 1)).toBe('2001:db8::1');
  });

  test('reports unknown when there is no socket address either', () => {
    expect(resolveClientIp(request(), null, 1)).toBe('unknown');
    expect(resolveClientIp(request('not-an-ip'), { requestIP: () => null }, 1)).toBe('unknown');
  });
});

describe('resolveRateLimitSource', () => {
  const source = (address: string) => resolveRateLimitSource(request(address), server, 1);

  test('an IPv4 address is its own source', () => {
    expect(source('203.0.113.9')).toBe('203.0.113.9');
    expect(resolveRateLimitSource(request(), server, 0)).toBe(SOCKET_ADDRESS);
  });

  test('every address of one IPv6 /64 is one source', () => {
    // The host chooses the low 64 bits, so they cannot tell two clients apart.
    expect(source('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(source('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(source('2001:0DB8:0001:0002:a:b:c:d')).toBe('2001:db8:1:2::/64');
    expect(source('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
  });

  test('a compressed address expands before its prefix is taken', () => {
    expect(source('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(source('2001:db8::5:6:7:8:9')).toBe('2001:db8:0:5::/64');
    expect(source('::1')).toBe('0:0:0:0::/64');
    expect(source('2001:db8:1:2::192.0.2.1')).toBe('2001:db8:1:2::/64');
  });

  test('an IPv4-mapped address is its IPv4 source, not one shared /64', () => {
    expect(source('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(source('::ffff:cb00:7109')).toBe('203.0.113.9');
    expect(source('0:0:0:0:0:ffff:cb00:7109')).toBe('203.0.113.9');
    const dualStack = { requestIP: () => ({ address: '::ffff:198.51.100.7' }) };
    expect(resolveRateLimitSource(request(), dualStack, 0)).toBe('198.51.100.7');
  });

  test('a source that is no address is passed through', () => {
    expect(resolveRateLimitSource(request(), null, 1)).toBe('unknown');
    const scoped = { requestIP: () => ({ address: 'fe80::1%en0' }) };
    expect(resolveRateLimitSource(request(), scoped, 0)).toBe('fe80::1%en0');
  });
});
