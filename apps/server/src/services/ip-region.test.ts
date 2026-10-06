import { describe, expect, test } from 'bun:test';

import { IP_ZONES, type IpZone, zoneForEdgeRegion, zoneForIp, zonesByProximity } from './ip-region';
import { IPV4_ZONE_TABLE } from './ip-region-table.generated';

describe('IPv4 zone resolution', () => {
  /**
   * Pinned vectors, per the plan's requirement that the map's contents be fixed
   * by example rather than trusted. Each is an address whose operator and
   * continent are matters of public record, so a regenerated table that moved
   * one of these has moved something real.
   */
  test.each([
    ['8.8.8.8', 'na', 'Google public DNS, ARIN'],
    ['1.1.1.1', 'apac', 'Cloudflare on APNIC 1.0.0.0/8'],
    ['9.9.9.9', 'na', 'Quad9, legacy IBM /8 administered by ARIN'],
    ['193.0.6.139', 'eu', 'RIPE NCC itself'],
    ['196.216.2.1', 'af', 'AFRINIC'],
    ['200.3.14.10', 'sa', 'LACNIC'],
    ['203.119.101.1', 'apac', 'APNIC itself'],
    ['17.253.144.10', 'na', 'Apple legacy /8'],
  ])('%s resolves to %s (%s)', (ip, expected) => {
    expect(zoneForIp(ip)).toBe(expected as IpZone);
  });

  /**
   * Space that carries no location must say so. Returning a zone here would
   * pin every daemon on a private network to one edge.
   */
  test.each([
    ['10.0.0.4', 'RFC1918'],
    ['192.168.1.1', 'RFC1918'],
    ['172.16.101.48', 'RFC1918'],
    ['127.0.0.1', 'loopback'],
    ['169.254.10.1', 'link-local'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['100.64.0.1', 'CGNAT'],
    ['192.0.2.7', 'TEST-NET-1'],
    ['203.0.113.7', 'TEST-NET-3 inside APNIC 203/8'],
    ['198.51.100.7', 'TEST-NET-2'],
  ])('%s has no zone (%s)', (ip) => {
    expect(zoneForIp(ip)).toBeNull();
  });

  test('malformed input resolves to null rather than throwing', () => {
    const malformed = [
      '',
      'not-an-ip',
      '999.1.1.1',
      '-1.0.0.0',
      '.1.2.3',
      'ff',
      '8.8.8',
      '8.8.8.8.8',
      '8.8.8.8abc',
      '08.8.8.8x',
      '1.2.3.256',
      '1.2.3.',
    ];
    for (const value of malformed) {
      expect(zoneForIp(value)).toBeNull();
    }
  });

  test('the generated table is exactly one letter per /8', () => {
    expect(IPV4_ZONE_TABLE).toHaveLength(256);
    expect(IPV4_ZONE_TABLE).toMatch(/^[nsefa?]+$/);
  });
});

describe('IPv6 zone resolution', () => {
  test.each([
    ['2a00:1450:4001:82b::200e', 'eu', 'RIPE /12'],
    ['2a01:4f8:c015:b50::1', 'eu', 'Hetzner, the box host prefix'],
    ['2600:1f18::1', 'na', 'ARIN /12'],
    ['2620:fe::9', 'na', 'Quad9 IPv6, ARIN /12'],
    ['2400:cb00:2048:1::1', 'apac', 'APNIC /12'],
    ['2800:3f0:4001::1', 'sa', 'LACNIC /12'],
    ['2c0f:f930::1', 'af', 'AFRINIC /12'],
    ['2003:a:e0f::1', 'eu', 'Deutsche Telekom /16 exception'],
  ])('%s resolves to %s (%s)', (ip, expected) => {
    expect(zoneForIp(ip)).toBe(expected as IpZone);
  });

  /**
   * `2001::/16` predates per-RIR /12s and is carved up among all of them, so a
   * /12 lookup inside it would return whichever entry happened to match first.
   * It must decline instead — this is the case the first draft got wrong.
   */
  test('2001::/16 declines rather than guessing a registry', () => {
    expect(zoneForIp('2001:4860:4860::8888')).toBeNull();
    expect(zoneForIp('2001:db8::1')).toBeNull();
  });

  test.each([
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['fd00:1234::1', 'unique local'],
    ['fc00::1', 'unique local'],
  ])('%s has no zone (%s)', (ip) => {
    expect(zoneForIp(ip)).toBeNull();
  });

  /**
   * An IPv4-mapped address describes a v4 holder; reading its v6 prefix would
   * place every such client in whatever zone `::ffff:` sorts into.
   */
  test('IPv4-mapped addresses resolve through their IPv4 tail', () => {
    expect(zoneForIp('::ffff:8.8.8.8')).toBe('na');
    expect(zoneForIp('::ffff:1.1.1.1')).toBe('apac');
    expect(zoneForIp('::ffff:10.0.0.1')).toBeNull();
  });
});

describe('edge region mapping', () => {
  test('the deployed edge regions are mapped', () => {
    expect(zoneForEdgeRegion('fra')).toBe('eu');
    expect(zoneForEdgeRegion('iad')).toBe('na');
  });

  test('region codes are matched case-insensitively', () => {
    expect(zoneForEdgeRegion('FRA')).toBe('eu');
  });

  /**
   * An unmapped region must decline so selection falls back to the hash. The
   * alternative — defaulting to a zone — silently routes a whole continent to
   * an edge chosen by a typo.
   */
  test('an unknown region declines', () => {
    expect(zoneForEdgeRegion('zzz')).toBeNull();
    expect(zoneForEdgeRegion('')).toBeNull();
  });
});

describe('zone proximity ordering', () => {
  test('every zone ranks itself first', () => {
    for (const zone of IP_ZONES) {
      expect(zonesByProximity(zone)[0]).toBe(zone);
    }
  });

  /**
   * Selection walks the ordering and stops at the first zone with an available
   * edge. A partial ordering would make that walk fall off the end and drop to
   * the hash for a daemon whose zone is merely unpopular.
   */
  test('every ordering is a total ordering over all zones', () => {
    for (const zone of IP_ZONES) {
      const order = zonesByProximity(zone);
      expect(order).toHaveLength(IP_ZONES.length);
      expect(new Set(order).size).toBe(IP_ZONES.length);
      for (const candidate of IP_ZONES) {
        expect(order).toContain(candidate);
      }
    }
  });

  test('the documented judgement calls hold', () => {
    const apac = zonesByProximity('apac');
    expect(apac.indexOf('na')).toBeLessThan(apac.indexOf('eu'));
    const africa = zonesByProximity('af');
    expect(africa.indexOf('eu')).toBeLessThan(africa.indexOf('na'));
  });
});
