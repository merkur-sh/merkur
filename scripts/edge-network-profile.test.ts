import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_EDGE_NETWORK_SEED,
  edgeNetworkLinkEnvironment,
  edgeNetworkPlaywrightEnvironment,
  resolveEdgeNetworkConfig,
} from './edge-network-profile';

describe('edge network profiles', () => {
  test('calibrates application RTT over four proxy legs', () => {
    const cases = [
      ['fast', 50, 12_500, 5_000],
      ['typical', 120, 30_000, 15_000],
      ['difficult', 200, 50_000, 30_000],
    ] as const;

    for (const [name, targetRttMs, hopDelayUs, oneWayJitterUs] of cases) {
      const config = resolveEdgeNetworkConfig({ EDGE_NETWORK_PROFILE: name });
      if (config === null) throw new Error(`profile ${name} unexpectedly resolved to null`);
      expect(config.profile.targetRttMs).toBe(targetRttMs);
      expect(config.profile.hopDelayUs).toBe(hopDelayUs);
      expect(config.profile.hopDelayUs * 4).toBe(targetRttMs * 1_000);
      expect(config.profile.oneWayJitterUs).toBe(oneWayJitterUs);
      expect(config.hopJitterRadiusUs * 4).toBe(oneWayJitterUs);
      expect(config.seed).toBe(DEFAULT_EDGE_NETWORK_SEED);
    }
  });

  test('exports complete machine-readable metadata to Playwright', () => {
    const config = resolveEdgeNetworkConfig({
      EDGE_NETWORK_PROFILE: 'typical',
      EDGE_NETWORK_DATAGRAM_LOSS_PERCENT: '9',
      EDGE_NETWORK_REORDER: 'moderate',
      EDGE_NETWORK_SCENARIO: 'congestion',
      EDGE_NETWORK_SEED: '7',
    });

    expect(edgeNetworkPlaywrightEnvironment(config)).toEqual({
      EDGE_NETWORK_ACTIVE: '1',
      EDGE_NETWORK_ROLE: 'primary',
      EDGE_NETWORK_PROFILE: 'typical',
      EDGE_NETWORK_TARGET_RTT_MS: '120',
      EDGE_NETWORK_HOP_DELAY_MS: '30',
      EDGE_NETWORK_ONE_WAY_JITTER_MS: '15',
      EDGE_NETWORK_MAX_EXTRA_DELAY_MS: '47',
      EDGE_NETWORK_DATAGRAM_LOSS_PERCENT: '9',
      EDGE_NETWORK_FAULT_SITE: 'edge-to-client',
      EDGE_NETWORK_FAULT_SITES_PER_LOGICAL_DIRECTION: '1',
      EDGE_NETWORK_REORDER: 'moderate',
      EDGE_NETWORK_SCENARIO: 'congestion',
      EDGE_NETWORK_SEED: '7',
      EDGE_NETWORK_DRAIN_GRACE_MS: '172',
    });
    expect(edgeNetworkPlaywrightEnvironment(null)).toEqual({ EDGE_NETWORK_ACTIVE: '0' });
  });

  test('requires an explicit profile and rejects removed approximate knobs', () => {
    expect(resolveEdgeNetworkConfig({})).toBeNull();
    expect(() => resolveEdgeNetworkConfig({ EDGE_NETWORK_DATAGRAM_LOSS_PERCENT: '3' })).toThrow(
      'EDGE_NETWORK_DATAGRAM_LOSS_PERCENT requires EDGE_NETWORK_PROFILE',
    );
    expect(() =>
      resolveEdgeNetworkConfig({ EDGE_DELAY_MS: '25', EDGE_NETWORK_PROFILE: 'fast' }),
    ).toThrow('EDGE_DELAY_MS was removed');
    expect(() =>
      resolveEdgeNetworkConfig({ EDGE_LOSS_DENOM: '17', EDGE_NETWORK_PROFILE: 'fast' }),
    ).toThrow('EDGE_LOSS_DENOM was removed');
    expect(() =>
      resolveEdgeNetworkConfig({
        EDGE_NETWORK_PROFILE: 'fast',
        EDGE_NETWORK_LOSS_PERCENT: '3',
      }),
    ).toThrow('EDGE_NETWORK_LOSS_PERCENT was removed');
  });

  test('accepts only matrix loss rates and a bounded deterministic seed', () => {
    for (const [lossPercent, expected] of [
      ['0', 0],
      ['1', 1],
      ['3', 3],
      ['9', 9],
    ] as const) {
      expect(
        resolveEdgeNetworkConfig({
          EDGE_NETWORK_PROFILE: 'fast',
          EDGE_NETWORK_DATAGRAM_LOSS_PERCENT: lossPercent,
        })?.datagramLossPercent,
      ).toBe(expected);
    }
    expect(() =>
      resolveEdgeNetworkConfig({
        EDGE_NETWORK_PROFILE: 'fast',
        EDGE_NETWORK_DATAGRAM_LOSS_PERCENT: '5',
      }),
    ).toThrow('EDGE_NETWORK_DATAGRAM_LOSS_PERCENT must be one of 0, 1, 3, 9');
    expect(() =>
      resolveEdgeNetworkConfig({
        EDGE_NETWORK_PROFILE: 'fast',
        EDGE_NETWORK_SEED: '4294967296',
      }),
    ).toThrow('EDGE_NETWORK_SEED must be an unsigned 32-bit integer');
  });

  test('an explicit companion remains slower without changing primary profiles', () => {
    for (const primary of ['fast', 'typical', 'difficult'] as const) {
      const environment = {
        FORCE_EDGE: '0',
        DIRECT_NETWORK_PROFILE: primary,
        EDGE_NETWORK_PROFILE: 'difficult',
        EDGE_NETWORK_COMPANION_RTT_MS: '300',
      };
      const config = resolveEdgeNetworkConfig(environment);
      if (config === null) throw new Error('companion is absent');
      expect(config.companionPrimaryProfile).toBe(primary);
      expect(config.profile).toEqual({
        name: 'difficult',
        targetRttMs: 300,
        hopDelayUs: 75_000,
        oneWayJitterUs: 30_000,
      });
      expect(config.drainGraceMs).toBe(175);
      expect(edgeNetworkPlaywrightEnvironment(config)).toMatchObject({
        EDGE_NETWORK_ROLE: 'direct-companion',
        EDGE_NETWORK_COMPANION_PRIMARY_PROFILE: primary,
        EDGE_NETWORK_COMPANION_RTT_MS: '300',
        EDGE_NETWORK_TARGET_RTT_MS: '300',
        EDGE_NETWORK_HOP_DELAY_MS: '75',
      });
    }
    expect(
      resolveEdgeNetworkConfig({ EDGE_NETWORK_PROFILE: 'difficult' })?.profile.targetRttMs,
    ).toBe(200);
  });

  test('rejects companion misuse, missing base profile and non-slower RTTs', () => {
    const valid = {
      FORCE_EDGE: '0',
      DIRECT_NETWORK_PROFILE: 'difficult',
      EDGE_NETWORK_PROFILE: 'difficult',
      EDGE_NETWORK_COMPANION_RTT_MS: '300',
    };
    for (const value of ['0', '120', '200', '200.5', '1001', 'NaN', 'Infinity', '']) {
      expect(() =>
        resolveEdgeNetworkConfig({ ...valid, EDGE_NETWORK_COMPANION_RTT_MS: value }),
      ).toThrow();
    }
    for (const invalid of [
      { FORCE_EDGE: '1' },
      { FORCE_EDGE: undefined },
      { DIRECT_NETWORK_PROFILE: undefined },
      { DIRECT_NETWORK_PROFILE: 'unknown' },
      { EDGE_NETWORK_PROFILE: undefined },
    ]) {
      expect(() => resolveEdgeNetworkConfig({ ...valid, ...invalid })).toThrow();
    }
    expect(() =>
      resolveEdgeNetworkConfig({
        ...valid,
        DIRECT_NETWORK_PROFILE: 'fast',
        EDGE_NETWORK_COMPANION_RTT_MS: '120',
      }),
    ).toThrow();
  });

  test('declares each bottleneck as links in the proxy grammar', () => {
    const links = (profile: string, bottleneck: string) => {
      const config = resolveEdgeNetworkConfig({
        EDGE_NETWORK_PROFILE: profile,
        EDGE_NETWORK_BOTTLENECK: bottleneck,
      });
      if (config?.bottleneck == null) throw new Error(`${bottleneck} declared no bottleneck`);
      return edgeNetworkLinkEnvironment(config.bottleneck.links);
    };
    expect(links('fast', 'uplink-bloat')).toEqual({ BOTTLENECK_DAEMON_UP: '10000000:262144' });
    expect(links('fast', 'downlink-bloat')).toEqual({ BOTTLENECK_BROWSER_DOWN: '25000000:640000' });
    // A quarter of 25 Mbit/s times 120 ms, and a whole one.
    expect(links('typical', 'downlink-shallow')).toEqual({
      BOTTLENECK_BROWSER_DOWN: '25000000:93750',
    });
    expect(links('typical', 'downlink-bdp')).toEqual({
      BOTTLENECK_BROWSER_DOWN: '25000000:375000',
    });
    expect(links('fast', 'downlink-deep')).toEqual({ BOTTLENECK_BROWSER_DOWN: '25000000:625000' });
    expect(links('fast', 'downlink-half')).toEqual({ BOTTLENECK_BROWSER_DOWN: '25000000:78125' });
    expect(links('fast', 'downlink-fast-bdp')).toEqual({
      BOTTLENECK_BROWSER_DOWN: '100000000:625000',
    });
    expect(links('fast', 'downlink-step')).toEqual({
      BOTTLENECK_BROWSER_DOWN: '25000000:640000@2000=5000000',
    });
    expect(links('fast', 'downlink-fq')).toEqual({
      BOTTLENECK_BROWSER_DOWN: '50000000:625000:fq',
    });
    expect(() =>
      resolveEdgeNetworkConfig({ EDGE_NETWORK_PROFILE: 'fast', EDGE_NETWORK_BOTTLENECK: 'lte' }),
    ).toThrow('EDGE_NETWORK_BOTTLENECK must be one of');
    expect(() => resolveEdgeNetworkConfig({ EDGE_NETWORK_BOTTLENECK: 'uplink-bloat' })).toThrow(
      'EDGE_NETWORK_BOTTLENECK requires EDGE_NETWORK_PROFILE',
    );
  });

  test('a competitor shares a declared link and reaches Playwright with the links', () => {
    const config = resolveEdgeNetworkConfig({
      EDGE_NETWORK_PROFILE: 'fast',
      EDGE_NETWORK_BOTTLENECK: 'downlink-deep',
      EDGE_NETWORK_COMPETITOR: 'browser',
    });
    expect(config?.competitor).toBe('browser');
    const environment = edgeNetworkPlaywrightEnvironment(config);
    expect(environment.EDGE_NETWORK_BOTTLENECK).toBe('downlink-deep');
    expect(environment.EDGE_NETWORK_COMPETITOR).toBe('browser');
    expect(JSON.parse(environment.EDGE_NETWORK_LINKS ?? '[]')).toEqual([
      {
        role: 'browser',
        direction: 'down',
        rateBps: 25_000_000,
        bufferBytes: 625_000,
        fq: false,
        step: null,
      },
    ]);
    // Nothing to share: the daemon declares no link here.
    expect(() =>
      resolveEdgeNetworkConfig({
        EDGE_NETWORK_PROFILE: 'fast',
        EDGE_NETWORK_BOTTLENECK: 'downlink-deep',
        EDGE_NETWORK_COMPETITOR: 'daemon',
      }),
    ).toThrow('EDGE_NETWORK_COMPETITOR must share a link');
    expect(() =>
      resolveEdgeNetworkConfig({
        EDGE_NETWORK_PROFILE: 'fast',
        EDGE_NETWORK_COMPETITOR: 'browser',
      }),
    ).toThrow('EDGE_NETWORK_COMPETITOR must share a link');
  });
});
