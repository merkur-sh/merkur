import { describe, expect, test } from 'bun:test';

import {
  createProxyControlResponseAssembler,
  PROXY_CONTROL_CHUNK_PAYLOAD_BYTES,
  PROXY_LINK_LOG2_BUCKETS,
  type ProxyImpairmentStats,
  type ProxyRelayStatus,
  parseProxyImpairmentStats,
  parseProxyMarkStatus,
  parseProxySettleStatus,
  proxyLinkReleaseErrors,
} from './edge-network-stats';
import {
  classifyProxyOutputLine,
  edgeHarnessPhases,
  isEdgeHandshakeTimeoutLine,
  LineBuffer,
  type ProxyOutputKind,
  parseEdgeAttachmentLine,
  parseProxyRelayLine,
  relayRoleErrors,
} from './run-edge-harness';

test('functional CI selects every correctness spec while the default retains latency first', () => {
  const all = edgeHarnessPhases([]);
  expect(all).toHaveLength(2);
  expect(all[0]).toEqual([
    '--workers=1',
    'tests/e2e/startup-latency.e2e.ts',
    'tests/e2e/terminal-performance-matrix.e2e.ts',
    'tests/e2e/transport-latency.e2e.ts',
  ]);
  const functional = all[1];
  if (functional === undefined) throw new Error('Missing functional phase');
  expect(edgeHarnessPhases(['--functional'])).toEqual([functional]);
  expect(functional.filter((arg) => arg.endsWith('.e2e.ts'))).toHaveLength(16);
  expect(edgeHarnessPhases(['--functional', '--workers=1'])[0]?.at(-1)).toBe('--workers=1');
  expect(edgeHarnessPhases(['terminal.e2e.ts', '--workers=1'])).toEqual([
    ['terminal.e2e.ts', '--workers=1'],
  ]);
});

describe('edge harness output monitoring', () => {
  test('reassembles tokens split across arbitrary process output chunks', () => {
    const lines = new LineBuffer();

    expect(lines.push('delay_pro')).toEqual([]);
    expect(lines.push('xy: ready [::1]:4434 -> [::1]:4433 profile=fast target_')).toEqual([]);
    expect(lines.push('rtt_ms=50 datagram_loss_percent=3 fault_site=edge-to-client\nnext')).toEqual(
      [
        'delay_proxy: ready [::1]:4434 -> [::1]:4433 profile=fast target_rtt_ms=50 datagram_loss_percent=3 fault_site=edge-to-client',
      ],
    );
    expect(lines.push(' line\r\n')).toEqual(['next line']);
  });

  test('distinguishes deliberate impairment and reorder from invalid overload loss', () => {
    const cases = [
      ['delay_proxy: ready [::1]:4434 -> [::1]:4433 profile=typical target_rtt_ms=120', 'ready'],
      ['delay_proxy: impaired 1 packet(s): seeded edge-to-client downstream loss', 'impairment'],
      ['delay_proxy: reordered 1 packet(s): seeded edge-to-client downstream holdback', 'reorder'],
      [
        'delay_proxy: split 1 coalesced datagram(s): 1-RTT suffix released ahead of its crypto prefix',
        'split',
      ],
      ['delay_proxy: dropped 1 packet(s): relay packet lease exhausted limit=65535', 'overload'],
      ['unrelated diagnostic', 'other'],
    ] as const satisfies readonly (readonly [string, ProxyOutputKind])[];

    for (const [line, expected] of cases) {
      expect(classifyProxyOutputLine(line)).toBe(expected);
    }
  });

  test('validates the complete machine-readable impairment counters', () => {
    const response = JSON.stringify({
      kind: 'stats',
      nonce: 'n-1',
      stats: {
        schemaVersion: 9,
        epoch: 2,
        config: {
          profile: 'typical',
          targetRttMs: 120,
          baseDelayUs: 30_000,
          jitterRadiusUs: 3_750,
          datagramLossPercent: 3,
          faultSite: 'edge-to-client',
          faultSitesPerLogicalDirection: 1,
          reorder: 'moderate',
          scenario: 'congestion',
          seed: 7,
        },
        upstream: directionStats(1_000, 0, false),
        downstream: directionStats(2_000, 60),
        logicalPathImpairment: {
          faultSite: 'edge-to-client',
          faultSitesPerLogicalDirection: 1,
          requestedDatagramLossPercent: 3,
          observedFaultSitePackets: 2_000,
          droppedAtFaultSite: 60,
          achievedPacketLossPercent: 3,
        },
        harnessDrops: { oversized: 0, admission: 0, leaseExhausted: 0 },
        splitDatagrams: 0,
        pendingScheduledPackets: 0,
        exactLossWindowsCompleted: 19,
        exactLossDroppedInCompletedWindows: 57,
        relays: [relayStatus(3, 0, 400, 900, 27, 5), relayStatus(7, 0, 600, 1_100, 33, 5)],
        links: [linkStatus()],
        relayLinks: [
          { admissionSeq: 3, listener: BROWSER, upstreamPort: 50_003, links: [relayLink()] },
          { admissionSeq: 7, listener: BROWSER, upstreamPort: 50_007, links: [relayLink()] },
        ],
      },
    });
    const parsed = parseChunkedProxyFixture(response, 'stats', 'n-1');
    expect(parsed?.config.profile).toBe('typical');
    expect(parsed?.config.faultSite).toBe('edge-to-client');
    expect(parsed?.upstream.achievedPacketLossPercent).toBe(0);
    expect(parsed?.logicalPathImpairment.achievedPacketLossPercent).toBe(3);
    expect(parsed?.downstream.scheduledDelayUs.p99).toBe(35_000);
    expect(parsed?.downstream.actualResidenceUs.p99).toBe(35_500);
    expect(parsed?.downstream.releaseOvershootUs.p99).toBe(500);
    expect(parsed?.exactLossWindowsCompleted).toBe(19);
    expect(parsed?.relays.map((relay) => relay.admissionSeq)).toEqual([3, 7]);
    expect(parsed?.links[0]?.config).toEqual({
      role: 'browser',
      direction: 'down',
      rateBps: 25_000_000,
      bufferBytes: 640_000,
      fq: false,
      step: null,
    });
    expect(parsed === null ? null : proxyLinkReleaseErrors(parsed)).toEqual([]);
    const late = parseChunkedProxyFixture(
      response.replace('"releaseOvershootP99UpperUs":16', '"releaseOvershootP99UpperUs":512'),
      'stats',
      'n-1',
    );
    expect(late === null ? null : proxyLinkReleaseErrors(late)).toEqual([
      'browser downlink released packets late: p99 below 512 µs is not under one 480 µs packet',
    ]);
    for (const [from, to, reason] of [
      ['"admissionSeq":7', '"admissionSeq":2', 'relays must arrive in admission order'],
      ['"pendingScheduledPackets":0', '"pendingScheduledPackets":1', 'relay pending is the total'],
      ['"downSeen":1100', '"downSeen":1101', 'a since-mark ledger cannot exceed its epoch'],
      [
        '"downDropped":33,"downReordered":5',
        '"downDropped":33,"downReordered":6',
        'relays cannot reorder more than the epoch selected',
      ],
      [
        '"exactLossWindowsCompleted":19',
        '"exactLossWindowsCompleted":21',
        'completed windows cannot exceed the packets seen',
      ],
      [
        '"downMaxInFlight":300',
        '"downMaxInFlight":65536',
        'no delay line holds more packets than its relay has leases',
      ],
      [
        '"harnessDrops":{"oversized":0,',
        '"harnessDrops":{"upstream":0,"oversized":0,',
        'the removed queue counters are a hard cutover',
      ],
      ['"leaseExhausted":0', '"leaseExhausted":-1', 'a harness drop count is a count'],
      ['"leaseExhausted":0', '"leaseExhausted":0.5', 'a harness drop count is an integer'],
      [
        '"role":"browser","direction"',
        '"role":"edge","direction"',
        'a link belongs to a peer role',
      ],
      ['"rateBps":25000000,"bufferBytes"', '"rateBps":0,"bufferBytes"', 'a link has a rate'],
      [
        '"arrivals":10,"departures":10',
        '"arrivals":9,"departures":10',
        'a link departs only arrivals',
      ],
      [
        '"relayLinks":[{"admissionSeq":3',
        '"relayLinks":[{"admissionSeq":9',
        'relay links arrive in admission order',
      ],
      [
        '"competitor":false},"upstreamPort":50003',
        '"competitor":0},"upstreamPort":50003',
        'a flag',
      ],
    ] as const) {
      expect(
        parseChunkedProxyFixture(response.replace(from, to), 'stats', 'n-1'),
        reason,
      ).toBeNull();
    }
    expect(parseChunkedProxyFixture(response, 'reset', 'n-1')).toBeNull();
    expect(parseChunkedProxyFixture(response, 'stats', 'wrong')).toBeNull();
    expect(
      parseChunkedProxyFixture(response.replace('"seen":1000', '"seen":-1'), 'stats', 'n-1'),
    ).toBeNull();
    expect(
      parseChunkedProxyFixture(
        response.replace('"exactLossDropped":0', '"exactLossDropped":1'),
        'stats',
        'n-1',
      ),
      'the hard-cut schema rejects any destructive upstream impairment',
    ).toBeNull();
    expect(
      parseChunkedProxyFixture(
        response.replace('"reorderInversions":0', '"reorderInversions":1'),
        'stats',
        'n-1',
      ),
      'centered upstream jitter may not become a delivered inversion',
    ).toBeNull();
    expect(
      parseChunkedProxyFixture(
        response.replace('"schemaVersion":9', '"schemaVersion":8'),
        'stats',
        'n-1',
      ),
      'the proxy statistics schema is a hard cutover',
    ).toBeNull();
    expect(
      parseChunkedProxyFixture(
        response.replace('"releaseEarlyCount":0', '"releaseEarlyCount":-1'),
        'stats',
        'n-1',
      ),
    ).toBeNull();
  });

  test('validates compact settle arithmetic without accepting histogram payloads', () => {
    const response = JSON.stringify({
      kind: 'settle',
      nonce: 's-1',
      status: {
        schemaVersion: 9,
        epoch: 9,
        mark: { generation: 4, key: 17 },
        // A relay detached since the mark: its packets stay here, not in `relays`.
        sinceMark: { upSeen: 16, downSeen: 19, downDropped: 1, downReordered: 2 },
        upstream: {
          seen: 20,
          forwarded: 20,
          dropped: 0,
          released: 20,
          reorderInversions: 0,
        },
        downstream: {
          seen: 22,
          forwarded: 21,
          dropped: 1,
          released: 20,
          reorderInversions: 2,
        },
        harnessDrops: { oversized: 0, admission: 0, leaseExhausted: 0 },
        splitDatagrams: 0,
        pendingScheduledPackets: 1,
        relays: [relayStatus(2, 1, 12, 13, 1, 1)],
      },
    });
    const parsed = parseChunkedProxyFixture(response, 'settle', 's-1', parseProxySettleStatus);
    expect(parsed?.downstream).toEqual({
      seen: 22,
      forwarded: 21,
      dropped: 1,
      released: 20,
      reorderInversions: 2,
    });
    expect(parsed?.mark).toEqual({ generation: 4, key: 17 });
    expect(parsed?.sinceMark).toEqual({
      upSeen: 16,
      downSeen: 19,
      downDropped: 1,
      downReordered: 2,
    });
    expect(parsed?.relays).toEqual([relayStatus(2, 1, 12, 13, 1, 1)]);
    expect(JSON.stringify(parsed)).not.toContain('histogram');
    expect(
      parseChunkedProxyFixture(response, 'settle', 'wrong', parseProxySettleStatus),
    ).toBeNull();
    // The same status answers `mark`, fenced by kind, nonce and the marked key.
    const marked = response.replace('"kind":"settle"', '"kind":"mark"');
    expect(
      parseChunkedProxyFixture(marked, 'mark', 's-1', (value) => parseProxyMarkStatus(value, 17))
        ?.mark.generation,
    ).toBe(4);
    expect(
      parseChunkedProxyFixture(marked, 'mark', 's-1', (value) => parseProxyMarkStatus(value, 18)),
    ).toBeNull();
    expect(
      parseChunkedProxyFixture(response, 'mark', 's-1', (value) => parseProxyMarkStatus(value, 17)),
    ).toBeNull();
    expect(parseChunkedProxyFixture(marked, 'settle', 's-1', parseProxySettleStatus)).toBeNull();
    for (const [from, to, reason] of [
      [
        '"downSeen":13,"downDropped":1',
        '"downSeen":13,"downDropped":14',
        'a relay cannot drop more than it saw',
      ],
      [
        '"sinceMark":{"upSeen":16',
        '"sinceMark":{"upSeen":11',
        'a live relay ledger is part of the trace-wide one',
      ],
      ['"sinceMark":{"upSeen":16', '"sinceMark":{"upSeen":21', 'a mark only narrows the epoch'],
      ['"sinceMark":{', '"since":{', 'the trace-wide ledger is required'],
      ['"upMaxInFlight":1', '"upMaxInFlight":65536', 'a delay line holds at most every lease'],
      ['"harnessDrops":{', '"queueDrops":{', 'the harness drops are required'],
    ] as const) {
      expect(
        parseChunkedProxyFixture(
          response.replace(from, to),
          'settle',
          's-1',
          parseProxySettleStatus,
        ),
        reason,
      ).toBeNull();
    }
    expect(
      parseChunkedProxyFixture(
        response.replace(
          '"released":20,"reorderInversions":2',
          '"released":23,"reorderInversions":2',
        ),
        'settle',
        's-1',
        parseProxySettleStatus,
      ),
    ).toBeNull();
    expect(
      parseChunkedProxyFixture(
        response.replace('"forwarded":20,"dropped":0', '"forwarded":19,"dropped":0'),
        'settle',
        's-1',
        parseProxySettleStatus,
      ),
    ).toBeNull();
  });

  test('classifies each relay by the lane and role the edge attached through it', () => {
    const attachment = parseEdgeAttachmentLine(
      '2026-09-19T12:00:00.000000Z  INFO merkur_edge::relay: edge: peer attached to splice ' +
        'session_id=f00d#bulk role=Browser remote=[::1]:51234',
      7,
    );
    expect(attachment).toEqual({ role: 'browser', lane: 'bulk', remotePort: 51_234, atMs: 7 });
    expect(
      parseEdgeAttachmentLine(
        'INFO edge: peer attached to splice session_id=f00d role=Daemon remote=[::1]:40000',
        1,
      )?.lane,
    ).toBe('interactive');
    expect(parseEdgeAttachmentLine('INFO edge: peer detached session_id=f00d', 1)).toBeNull();
    const relay = parseProxyRelayLine(
      'delay_proxy: relay admission_seq=4 role=browser competitor=false client=[::1]:61000 upstream_port=51234',
      6,
    );
    expect(relay).toEqual({
      admissionSeq: 4,
      role: 'browser',
      competitor: false,
      upstreamPort: 51_234,
      atMs: 6,
    });
    if (attachment === null || relay === null) throw new Error('both lines parse');
    expect(relayRoleErrors([attachment], [relay])).toEqual([]);
    // A browser connection that reached the edge through the daemon's
    // listener crossed the daemon's links: the redirect did not apply.
    expect(relayRoleErrors([attachment], [{ ...relay, role: 'daemon' }])).toEqual([
      "the edge's browser bulk attachment came through a daemon relay",
    ]);
    expect(relayRoleErrors([attachment], [])).toEqual([
      "the edge's browser bulk attachment from port 51234 came through no proxy relay",
    ]);
  });

  test('attributes a reused upstream port to its admission before each attachment', () => {
    const browser = {
      admissionSeq: 7,
      role: 'browser' as const,
      competitor: false,
      upstreamPort: 60_784,
      atMs: 10,
    };
    const daemon = { ...browser, admissionSeq: 69, role: 'daemon' as const, atMs: 30 };
    const first = {
      role: 'browser' as const,
      lane: 'signaling' as const,
      remotePort: 60_784,
      atMs: 20,
    };
    const second = { ...first, role: 'daemon' as const, atMs: 40 };
    expect(relayRoleErrors([first, second], [browser, daemon])).toEqual([]);
    expect(relayRoleErrors([first, second], [daemon, browser])).toEqual([]);
    // A later correct-role reuse must not disguise the earlier wrong listener.
    expect(relayRoleErrors([{ ...first, role: 'daemon' }], [browser, daemon])).toEqual([
      "the edge's daemon signaling attachment came through a browser relay",
    ]);
    expect(relayRoleErrors([first], [daemon])).toEqual([
      "the edge's browser signaling attachment from port 60784 came through no proxy relay",
    ]);
  });

  test('recognizes the edge declaring a session handshake deadlock', () => {
    expect(
      isEdgeHandshakeTimeoutLine(
        '2026-08-30T18:24:35.467571Z  WARN merkur_edge::relay: edge: session handshake timed out',
      ),
    ).toBe(true);
    // The neighbouring failure arm in `relay.rs` is a different outcome: the
    // handshake resolved and was rejected, which is not the deadlock.
    expect(
      isEdgeHandshakeTimeoutLine('WARN merkur_edge::relay: edge: session handshake failed: reset'),
    ).toBe(false);
    expect(isEdgeHandshakeTimeoutLine('edge: peer detached session_id=abc role=Browser')).toBe(
      false,
    );
  });
});

function relayStatus(
  admissionSeq: number,
  pending: number,
  upSeen: number,
  downSeen: number,
  downDropped: number,
  downReordered: number,
): ProxyRelayStatus {
  return {
    admissionSeq,
    listener: BROWSER,
    upstreamPort: 50_000 + admissionSeq,
    pending,
    upSeen,
    downSeen,
    downDropped,
    downReordered,
    upMaxInFlight: pending,
    downMaxInFlight: 300,
    bottleneckDrops: 0,
  };
}

const BROWSER = { role: 'browser', competitor: false } as const;

function log2(counts: Record<number, number> = {}): number[] {
  return Array.from({ length: PROXY_LINK_LOG2_BUCKETS }, (_, bucket) => counts[bucket] ?? 0);
}

function linkStatus(): Record<string, unknown> {
  return {
    config: {
      role: 'browser',
      direction: 'down',
      rateBps: 25_000_000,
      bufferBytes: 640_000,
      fq: false,
      step: null,
    },
    rateBps: 25_000_000,
    totals: {
      arrivals: 10,
      departures: 10,
      bottleneckDrops: 0,
      lostAfterLink: 1,
      departedBytes: 13_000,
      busyNs: 4_160_000,
      rateChanges: 0,
      residenceLog2Us: log2({ 9: 10 }),
      bytesAheadLog2: log2({ 0: 1, 11: 9 }),
      releaseOvershootLog2Us: log2({ 3: 10 }),
    },
    releaseOvershootP99UpperUs: 16,
    lowestRatePacketUs: 480,
  };
}

function relayLink(): Record<string, unknown> {
  return {
    direction: 'down',
    stats: {
      packets: 5,
      bytes: 6_500,
      bottleneckDrops: 0,
      maxResidenceUs: 500,
      residenceLog2Us: log2({ 9: 5 }),
      bytesAheadLog2: log2({ 11: 5 }),
    },
  };
}

function directionStats(
  seen: number,
  dropped: number,
  destructive = true,
): Record<string, unknown> {
  return {
    seen,
    forwarded: seen - dropped,
    dropped,
    exactLossDropped: dropped,
    burstLossDropped: 0,
    burstLossRunsCompleted: 0,
    jittered: seen,
    reorderInversions: destructive ? 8 : 0,
    reordered: destructive ? 10 : 0,
    congested: destructive ? 20 : 0,
    congestedForwarded: destructive ? 20 : 0,
    congestionClamped: 0,
    maxCongestionQueueDelayUs: destructive ? 8_000 : 0,
    maxForwardedCongestionQueueDelayUs: destructive ? 8_000 : 0,
    achievedPacketLossPercent: (dropped * 100) / seen,
    scheduledDelayUs: {
      count: seen - dropped,
      mean: 30_000,
      min: 26_250,
      p50: 30_000,
      p95: 34_000,
      p99: 35_000,
      max: 62_000,
      histogramBucketUs: 500,
      histogram: proxyDelayHistogram(seen - dropped, 26_250, 30_000, 34_000, 35_000, 62_000),
    },
    releaseTargetResidenceUs: {
      count: seen - dropped,
      mean: 30_000,
      min: 26_250,
      p50: 30_000,
      p95: 34_000,
      p99: 35_000,
      max: 62_000,
      histogramBucketUs: 500,
      histogram: proxyDelayHistogram(seen - dropped, 26_250, 30_000, 34_000, 35_000, 62_000),
    },
    actualResidenceUs: {
      count: seen - dropped,
      mean: 30_500,
      min: 26_500,
      p50: 30_500,
      p95: 34_500,
      p99: 35_500,
      max: 63_000,
      histogramBucketUs: 500,
      histogram: proxyDelayHistogram(seen - dropped, 26_500, 30_500, 34_500, 35_500, 63_000),
    },
    releaseOvershootUs: {
      count: seen - dropped,
      mean: 500,
      min: 100,
      p50: 500,
      p95: 500,
      p99: 500,
      max: 1_000,
      histogramBucketUs: 500,
      histogram: proxyDelayHistogram(seen - dropped, 100, 500, 500, 500, 1_000),
    },
    releaseEarlyCount: 0,
    maxReleaseEarlyUs: 0,
  };
}

function proxyDelayHistogram(
  count: number,
  minimumUs: number,
  p50Us: number,
  p95Us: number,
  p99Us: number,
  maximumUs: number,
): number[] {
  const histogram = Array<number>(512).fill(0);
  if (count === 0) return histogram;
  const add = (bucket: number, amount: number): void => {
    const index = Math.min(511, Math.max(0, bucket));
    histogram[index] = (histogram[index] ?? 0) + amount;
  };
  const quantileBucket = (valueUs: number): number =>
    valueUs === maximumUs && valueUs % 500 !== 0
      ? Math.floor(valueUs / 500)
      : Math.max(0, Math.ceil(valueUs / 500) - 1);
  const rank50 = Math.ceil(count * 0.5);
  const rank95 = Math.ceil(count * 0.95);
  const rank99 = Math.ceil(count * 0.99);
  add(Math.floor(minimumUs / 500), 1);
  add(quantileBucket(p50Us), rank50 - 1);
  add(quantileBucket(p95Us), rank95 - rank50);
  add(quantileBucket(p99Us), rank99 - rank95);
  add(Math.floor(maximumUs / 500), count - rank99);
  return histogram;
}

/**
 * Chunk a `{kind, nonce, stats | status}` fixture the way the proxy does and
 * reassemble it; null wherever the assembler or the parser refuses it.
 */
function parseChunkedProxyFixture<T = ProxyImpairmentStats>(
  response: string,
  expectedKind: 'reset' | 'stats' | 'settle' | 'mark',
  expectedNonce: string,
  parse: (value: unknown) => T | null = parseProxyImpairmentStats as (value: unknown) => T | null,
): T | null {
  const envelope = JSON.parse(response) as {
    kind: string;
    nonce: string;
    stats?: unknown;
    status?: unknown;
  };
  const payload = Buffer.from(JSON.stringify(envelope.stats ?? envelope.status));
  const chunkCount = Math.ceil(payload.length / PROXY_CONTROL_CHUNK_PAYLOAD_BYTES);
  const assembler = createProxyControlResponseAssembler(expectedKind, expectedNonce, parse);
  let result: T | null = null;
  try {
    for (let chunkIndex = chunkCount - 1; chunkIndex >= 0; chunkIndex -= 1) {
      const chunk = payload.subarray(
        chunkIndex * PROXY_CONTROL_CHUNK_PAYLOAD_BYTES,
        Math.min((chunkIndex + 1) * PROXY_CONTROL_CHUNK_PAYLOAD_BYTES, payload.length),
      );
      result =
        assembler.push(
          JSON.stringify({
            kind: envelope.kind,
            nonce: envelope.nonce,
            responseId: 17,
            chunkIndex,
            chunkCount,
            payloadByteLength: payload.length,
            payloadBase64: chunk.toString('base64'),
          }),
        ) ?? result;
    }
  } catch {
    return null;
  }
  return result;
}
