import { describe, expect, test } from 'bun:test';
import type { TelemetryInputFrontierStatus } from '../../../apps/web/src/perf/telemetry-drain-status';
import type { TelemetryWorkerDrainStatus } from '../../../apps/web/src/telemetry-worker-protocol';
import type { ProxySettleStatus } from '../../../scripts/edge-network-stats';
import {
  type PresentationDrainObservation,
  presentationDrainQuietMs,
  waitForPresentationDrain,
} from './presentation-measurement-settle';

describe('presentation measurement drain', () => {
  test('a redraw arriving after its final marker restarts the exact quiet interval', async () => {
    let nowMs = 0;
    const observations = [browserStatus(1), browserStatus(1), browserStatus(2), browserStatus(2)];
    let pollIndex = 0;
    await waitForPresentationDrain({
      measurementId: 1,
      quietMs: 50,
      timeoutMs: 500,
      pollMs: 25,
      nowMs: () => nowMs,
      wait: async (durationMs) => {
        nowMs += durationMs;
      },
      poll: async () => ({
        browserStatus: observations[Math.min(pollIndex++, observations.length - 1)] ?? null,
        proxyStatus: null,
      }),
    });
    expect(nowMs).toBe(100);
  });

  test('actual proxy release, not early scheduling, starts the final quiet interval', async () => {
    let nowMs = 0;
    let pollIndex = 0;
    const proxy = [
      proxyStatus(11, 10, 1),
      proxyStatus(11, 10, 1),
      proxyStatus(11, 11, 0),
      proxyStatus(11, 11, 0),
      proxyStatus(11, 11, 0),
    ];
    await waitForPresentationDrain({
      measurementId: 1,
      quietMs: 40,
      timeoutMs: 500,
      pollMs: 20,
      nowMs: () => nowMs,
      wait: async (durationMs) => {
        nowMs += durationMs;
      },
      poll: async () => ({
        browserStatus: browserStatus(1),
        proxyStatus: proxy[Math.min(pollIndex++, proxy.length - 1)] ?? null,
      }),
    });
    expect(nowMs).toBe(80);
  });

  test('can establish measurement-free quiet before opening an exact window', async () => {
    let nowMs = 0;
    await waitForPresentationDrain({
      startAtMs: 5,
      quietMs: 40,
      timeoutMs: 500,
      pollMs: 20,
      nowMs: () => nowMs,
      wait: async (durationMs) => {
        nowMs += durationMs;
      },
      poll: async () => ({
        browserStatus: browserStatus(0),
        proxyStatus: proxyStatus(10, 10, 0),
      }),
    });
    expect(nowMs).toBe(40);
  });

  test('waits until an authoritative commit has an observed GPU fence', async () => {
    let nowMs = 0;
    let pollIndex = 0;
    await waitForPresentationDrain({
      measurementId: 1,
      quietMs: 20,
      timeoutMs: 200,
      pollMs: 10,
      nowMs: () => nowMs,
      wait: async (durationMs) => {
        nowMs += durationMs;
      },
      poll: async () => {
        const pending = pollIndex++ < 3;
        return {
          browserStatus: browserStatus(pending ? 1 : 2, pending ? 1 : 0),
          proxyStatus: null,
        };
      },
    });
    expect(nowMs).toBe(50);
  });

  test('an open graphics tile job holds quiet, and each transition restarts it', async () => {
    let nowMs = 0;
    let pollIndex = 0;
    // Presentation is idle throughout; only the tile job moves and then retires.
    const graphics = [
      { eventCount: 3, open: 1 },
      { eventCount: 3, open: 1 },
      { eventCount: 3, open: 1 },
      { eventCount: 5, open: 1 },
      { eventCount: 8, open: 0 },
    ];
    await waitForPresentationDrain({
      measurementId: 1,
      quietMs: 20,
      timeoutMs: 500,
      pollMs: 10,
      nowMs: () => nowMs,
      wait: async (durationMs) => {
        nowMs += durationMs;
      },
      poll: async () => ({
        browserStatus: browserStatus(
          1,
          0,
          1,
          graphics[Math.min(pollIndex++, graphics.length - 1)] ?? { eventCount: 8, open: 0 },
        ),
        proxyStatus: null,
      }),
    });
    expect(nowMs).toBe(60);
  });

  test('fails closed when observation lineage changes mid-drain', async () => {
    let nowMs = 0;
    let pollIndex = 0;
    await expect(
      waitForPresentationDrain({
        measurementId: 1,
        quietMs: 50,
        timeoutMs: 500,
        pollMs: 25,
        nowMs: () => nowMs,
        wait: async (durationMs) => {
          nowMs += durationMs;
        },
        poll: async () => ({
          browserStatus: browserStatus(1, 0, pollIndex++ === 0 ? 1 : 2),
          proxyStatus: null,
        }),
      }),
    ).rejects.toThrow(/epoch changed/);
  });

  test('fails closed when the bounded telemetry egress queue saturated', async () => {
    const baseStatus = browserStatus(1);
    const saturated = {
      ...baseStatus,
      stats: { ...baseStatus.stats, pendingRowsDropped: 1 },
    };
    await expect(
      waitForPresentationDrain({
        measurementId: 1,
        quietMs: 10,
        timeoutMs: 100,
        poll: async () => ({ browserStatus: saturated, proxyStatus: null }),
      }),
    ).rejects.toThrow(/egress saturation/);
  });

  test('closes the ledger at the first poll that sees the timed input complete, not a later one', async () => {
    let nowMs = 0;
    // The window opened after 4 awaited inputs, the newest seq 40.
    const baseline = { observationEpoch: 1, input: frontier(4, 40, 40, 40) };
    const polls: PresentationDrainObservation[] = [
      // Queued (seq 42: a deferred release took 41), neither ACKed nor fenced.
      {
        browserStatus: browserStatus(1, 0, 1, undefined, frontier(5, 42, 40, 40)),
        proxyStatus: proxyStatus(30, 29, 1),
      },
      // ACKed, the echo committed but not yet fenced.
      {
        browserStatus: browserStatus(2, 1, 1, undefined, frontier(5, 42, 42, 40)),
        proxyStatus: proxyStatus(34, 33, 1),
      },
      // Fenced: this poll's proxy read is the close.
      {
        browserStatus: browserStatus(3, 0, 1, undefined, frontier(5, 42, 42, 42)),
        proxyStatus: proxyStatus(36, 36, 0),
      },
      {
        browserStatus: browserStatus(3, 0, 1, undefined, frontier(5, 42, 42, 42)),
        proxyStatus: proxyStatus(39, 39, 0),
      },
    ];
    let pollIndex = 0;
    const close = await waitForPresentationDrain({
      measurementId: 1,
      timedInput: baseline,
      quietMs: 40,
      timeoutMs: 500,
      pollMs: 20,
      nowMs: () => nowMs,
      wait: async (durationMs) => {
        nowMs += durationMs;
      },
      poll: async () => polls[Math.min(pollIndex++, polls.length - 1)] ?? polls[0] ?? fail(),
    });
    expect(close).toEqual({ input: frontier(5, 42, 42, 42), proxyStatus: proxyStatus(36, 36, 0) });
    expect(nowMs).toBe(100);
  });

  test('never settles a timed window before its input completes', async () => {
    let nowMs = 0;
    let pollIndex = 0;
    const close = await waitForPresentationDrain({
      measurementId: 1,
      timedInput: { observationEpoch: 1, input: frontier(0, 0, 0, 0) },
      quietMs: 20,
      timeoutMs: 500,
      pollMs: 10,
      nowMs: () => nowMs,
      wait: async (durationMs) => {
        nowMs += durationMs;
      },
      // Quiet from the first poll; the ACK and the fence land on the sixth.
      poll: async () => {
        const acked = pollIndex++ >= 5 ? 1 : 0;
        return {
          browserStatus: browserStatus(1, 0, 1, undefined, frontier(1, 1, acked, acked)),
          proxyStatus: null,
        };
      },
    });
    expect(close?.input).toEqual(frontier(1, 1, 1, 1));
    expect(nowMs).toBe(50);
  });

  test('a second input in a timed window fails the drain', async () => {
    await expect(
      waitForPresentationDrain({
        measurementId: 1,
        timedInput: { observationEpoch: 1, input: frontier(3, 9, 9, 9) },
        quietMs: 10,
        timeoutMs: 100,
        poll: async () => ({
          browserStatus: browserStatus(1, 0, 1, undefined, frontier(5, 11, 11, 11)),
          proxyStatus: null,
        }),
      }),
    ).rejects.toThrow(/queued 2 inputs, not one/);
  });

  test('a timed window whose input never completes reports its frontier at the timeout', async () => {
    let nowMs = 0;
    await expect(
      waitForPresentationDrain({
        measurementId: 1,
        timedInput: { observationEpoch: 1, input: frontier(3, 9, 9, 9) },
        quietMs: 10,
        timeoutMs: 100,
        pollMs: 25,
        nowMs: () => nowMs,
        wait: async (durationMs) => {
          nowMs += durationMs;
        },
        poll: async () => ({
          browserStatus: browserStatus(1, 0, 1, undefined, frontier(4, 10, 10, 9)),
          proxyStatus: null,
        }),
      }),
    ).rejects.toThrow(/timed input never completed: .*"fencedSeq":9/);
  });

  test('profile bound covers delivery skew plus the bounded repair tail', () => {
    expect(
      presentationDrainQuietMs({
        EDGE_NETWORK_TARGET_RTT_MS: '200',
        EDGE_NETWORK_ONE_WAY_JITTER_MS: '30',
        EDGE_NETWORK_MAX_EXTRA_DELAY_MS: '20',
        EDGE_NETWORK_DATAGRAM_LOSS_PERCENT: '9',
        EDGE_NETWORK_SCENARIO: 'steady',
      }),
    ).toBe(508);
  });
});

function browserStatus(
  activityEventCount: number,
  pendingAuthoritativeRenderCount = 0,
  observationEpoch = 1,
  graphicsAsset = { eventCount: 0, open: 0 },
  input = frontier(0, 0, 0, 0),
): TelemetryWorkerDrainStatus {
  return {
    activity: {
      observationEpoch,
      observationStartedAtMs: 1,
      activityRevision: activityEventCount,
      activityEventCount,
      latestActivityAtMs: activityEventCount,
      pendingAuthoritativeRenderCount,
      trackingOverflow: false,
      graphicsAsset: {
        ...graphicsAsset,
        demanded: graphicsAsset.open,
        requested: 0,
        firstByte: 0,
        fin: 0,
        published: 0,
        consumed: 0,
        retired: 0,
        failed: 0,
      },
      input,
    },
    stats: {
      recordsDrained: activityEventCount,
      recordsLost: 0,
      rowsShipped: 0,
      bytesShipped: 0,
      sendFailures: 0,
      pendingRows: 0,
      pendingRowsDropped: 0,
      budgetExhausted: false,
    },
  };
}

function proxyStatus(
  seen: number,
  released: number,
  pendingScheduledPackets: number,
): ProxySettleStatus {
  const direction = {
    seen,
    forwarded: seen,
    dropped: 0,
    released,
    reorderInversions: 0,
  } as const;
  return {
    schemaVersion: 9,
    epoch: 1,
    mark: { generation: 1, key: 0 },
    sinceMark: { upSeen: seen, downSeen: seen, downDropped: 0, downReordered: 0 },
    upstream: direction,
    downstream: direction,
    harnessDrops: { oversized: 0, admission: 0, leaseExhausted: 0 },
    splitDatagrams: 0,
    pendingScheduledPackets,
    relays: [],
  };
}

function frontier(
  queuedCount: number,
  queuedSeq: number,
  ackedSeq: number,
  fencedSeq: number,
): TelemetryInputFrontierStatus {
  return {
    queuedCount,
    queuedSeq,
    ackedSeq,
    ackAtMs: ackedSeq === 0 ? 0 : 1_000 + ackedSeq,
    fencedSeq,
    fenceAtMs: fencedSeq === 0 ? 0 : 2_000 + fencedSeq,
  };
}

function fail(): never {
  throw new Error('no poll scripted');
}
