import { describe, expect, test } from 'bun:test';
import { type PersistedWtPath, parsePersistedWtPath, wtPathKey } from './wt-path-schema';

const valid: PersistedWtPath = {
  key: wtPathKey('daemon-1', '198.51.100.7'),
  daemonId: 'daemon-1',
  address: '198.51.100.7',
  certHash: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  candidate: { addr: '2001:db8::1', port: 4433, kind: 'host6', scope: 'public' },
  nat: {
    publicIp: '203.0.113.8',
    natType: 'endpoint_independent',
    natFiltering: 'unknown',
    hairpin: true,
  },
  mtime: 1_700_000_000_000,
};

describe('persisted WebTransport path schema', () => {
  test('accepts the exact current record bound to the requested daemon and network', () => {
    expect(parsePersistedWtPath(valid, 'daemon-1', '198.51.100.7')).toEqual(valid);
  });

  test('rejects key drift, identity or network mismatch, and an unsafe time', () => {
    expect(
      parsePersistedWtPath({ ...valid, retired: true }, 'daemon-1', '198.51.100.7'),
    ).toBeNull();
    expect(parsePersistedWtPath(valid, 'daemon-2', '198.51.100.7')).toBeNull();
    // What worked from one network says nothing about another.
    expect(parsePersistedWtPath(valid, 'daemon-1', '192.0.2.1')).toBeNull();
    expect(
      parsePersistedWtPath({ ...valid, key: 'daemon-1|192.0.2.1' }, 'daemon-1', '198.51.100.7'),
    ).toBeNull();
    expect(
      parsePersistedWtPath(
        { ...valid, mtime: Number.MAX_SAFE_INTEGER + 1 },
        'daemon-1',
        '198.51.100.7',
      ),
    ).toBeNull();
  });

  test('rejects malformed candidate and NAT subrecords atomically', () => {
    expect(
      parsePersistedWtPath(
        { ...valid, candidate: { ...valid.candidate, addr: 'not-an-ip' } },
        'daemon-1',
        '198.51.100.7',
      ),
    ).toBeNull();
    expect(
      parsePersistedWtPath(
        { ...valid, candidate: { ...valid.candidate, scope: 'lan' } },
        'daemon-1',
        '198.51.100.7',
      ),
    ).toBeNull();
    expect(
      parsePersistedWtPath(
        { ...valid, candidate: { ...valid.candidate, legacy: true } },
        'daemon-1',
        '198.51.100.7',
      ),
    ).toBeNull();
    expect(
      parsePersistedWtPath(
        { ...valid, nat: { ...valid.nat, publicIp: '::d:' } },
        'daemon-1',
        '198.51.100.7',
      ),
    ).toBeNull();
  });
});
