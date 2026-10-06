import { describe, expect, test } from 'bun:test';

import {
  createLinkQualityAggregator,
  LINK_RTT_BOUNDS_MS,
  type LinkQualitySample,
} from './link-quality-aggregator';

function sample(overrides: Partial<LinkQualitySample> = {}): LinkQualitySample {
  return {
    rttMs: 40,
    inputAckRttMs: 40,
    path: 'relay',
    linkState: 'ready',
    degraded: false,
    txBytes: 0,
    rxBytes: 0,
    ...overrides,
  };
}

describe('link quality aggregator', () => {
  test('an empty window reports nothing at all', () => {
    const aggregator = createLinkQualityAggregator(0);
    expect(aggregator.drain(60_000)).toBeNull();
  });

  test('counts samples, paths and link states over the window', () => {
    const aggregator = createLinkQualityAggregator(0);
    aggregator.observe(sample({ path: 'direct', linkState: 'connecting' }));
    aggregator.observe(sample({ path: 'direct', linkState: 'ready' }));
    aggregator.observe(sample({ path: 'relay', linkState: 'ready' }));
    aggregator.observe(sample({ path: 'unknown', linkState: 'dormant', degraded: true }));

    const report = aggregator.drain(60_000);
    expect(report).not.toBeNull();
    expect(report?.sampleCount).toBe(4);
    expect(report?.pathDirect).toBe(2);
    expect(report?.pathRelay).toBe(1);
    expect(report?.pathUnknown).toBe(1);
    expect(report?.stateConnecting).toBe(1);
    expect(report?.stateReady).toBe(2);
    expect(report?.stateDormant).toBe(1);
    expect(report?.degradedSampleCount).toBe(1);
    expect(report?.windowMs).toBe(60_000);
  });

  test('draining resets the window so counts never carry over', () => {
    const aggregator = createLinkQualityAggregator(0);
    aggregator.observe(sample());
    expect(aggregator.drain(60_000)?.sampleCount).toBe(1);

    aggregator.observe(sample());
    const second = aggregator.drain(120_000);
    expect(second?.sampleCount).toBe(1);
    expect(second?.windowMs).toBe(60_000);
  });

  test('percentiles report the containing bucket bound', () => {
    const aggregator = createLinkQualityAggregator(0);
    // Ninety samples at 10ms and ten at 300ms: p50 sits in the 10ms bucket and
    // p95 in the 300ms one.
    for (let index = 0; index < 90; index += 1) aggregator.observe(sample({ rttMs: 9 }));
    for (let index = 0; index < 10; index += 1) aggregator.observe(sample({ rttMs: 260 }));

    const report = aggregator.drain(60_000);
    expect(report?.rttP50Ms).toBe(10);
    expect(report?.rttP95Ms).toBe(300);
    expect(report?.rttMaxMs).toBe(260);
  });

  test('a value above the top bound still reports a finite percentile', () => {
    const aggregator = createLinkQualityAggregator(0);
    aggregator.observe(sample({ rttMs: 99_999 }));

    const report = aggregator.drain(60_000);
    const topBound = LINK_RTT_BOUNDS_MS[LINK_RTT_BOUNDS_MS.length - 1];
    expect(report?.rttP50Ms).toBe(topBound);
    expect(report?.rttMaxMs).toBe(99_999);
  });

  test('missing rtt samples do not drag the percentile toward zero', () => {
    const aggregator = createLinkQualityAggregator(0);
    // A window that is mostly disconnected: only one sample carried an RTT.
    for (let index = 0; index < 9; index += 1) {
      aggregator.observe(sample({ rttMs: null, inputAckRttMs: null, linkState: 'reconnecting' }));
    }
    aggregator.observe(sample({ rttMs: 45, inputAckRttMs: null }));

    const report = aggregator.drain(60_000);
    expect(report?.sampleCount).toBe(10);
    expect(report?.rttP50Ms).toBe(50);
    // No input-ack samples at all means zero, not a fabricated percentile.
    expect(report?.inputAckP50Ms).toBe(0);
  });

  test('byte counters are differenced, since the transport reports cumulative totals', () => {
    const aggregator = createLinkQualityAggregator(0);
    aggregator.observe(sample({ txBytes: 1_000, rxBytes: 5_000 }));
    aggregator.observe(sample({ txBytes: 1_400, rxBytes: 9_000 }));

    const report = aggregator.drain(60_000);
    expect(report?.txBytes).toBe(400);
    expect(report?.rxBytes).toBe(4_000);
  });

  test('single-sample heartbeat reports preserve byte differences across drains', () => {
    const aggregator = createLinkQualityAggregator(0);
    expect(aggregator.drain(1_000)).toBeNull();
    aggregator.observe(sample({ txBytes: 1_000, rxBytes: 5_000 }));
    expect(aggregator.drain(2_000)?.txBytes).toBe(0);
    aggregator.observe(sample({ txBytes: 1_400, rxBytes: 9_000 }));
    const next = aggregator.drain(4_000);
    expect(next?.txBytes).toBe(400);
    expect(next?.rxBytes).toBe(4_000);
    expect(aggregator.drain(5_000)).toBeNull();
    aggregator.observe(sample({ txBytes: 1_700, rxBytes: 10_000 }));
    const afterEmptyDrain = aggregator.drain(6_000);
    expect(afterEmptyDrain?.txBytes).toBe(300);
    expect(afterEmptyDrain?.rxBytes).toBe(1_000);
  });

  test('a counter reset preserves bytes observed before it in a backpressured report', () => {
    const aggregator = createLinkQualityAggregator(0);
    aggregator.observe(sample({ txBytes: 1_000, rxBytes: 5_000 }));
    aggregator.drain(2_000);
    aggregator.observe(sample({ txBytes: 1_400, rxBytes: 9_000 }));
    aggregator.observe(sample({ txBytes: 5, rxBytes: 10 }));
    aggregator.observe(sample({ txBytes: 105, rxBytes: 210 }));
    const report = aggregator.drain(8_000);
    expect(report?.txBytes).toBe(500);
    expect(report?.rxBytes).toBe(4_200);
  });

  test('a counter reset starts a fresh byte window instead of reporting a negative', () => {
    const aggregator = createLinkQualityAggregator(0);
    aggregator.observe(sample({ txBytes: 10_000, rxBytes: 10_000 }));
    // Transport restarted its accounting mid-window.
    aggregator.observe(sample({ txBytes: 5, rxBytes: 5 }));
    aggregator.observe(sample({ txBytes: 120, rxBytes: 220 }));

    const report = aggregator.drain(60_000);
    expect(report?.txBytes).toBe(115);
    expect(report?.rxBytes).toBe(215);
  });

  test('non-finite and negative latencies are ignored', () => {
    const aggregator = createLinkQualityAggregator(0);
    aggregator.observe(sample({ rttMs: Number.NaN }));
    aggregator.observe(sample({ rttMs: Number.POSITIVE_INFINITY }));
    aggregator.observe(sample({ rttMs: -5 }));

    const report = aggregator.drain(60_000);
    expect(report?.sampleCount).toBe(3);
    expect(report?.rttP50Ms).toBe(0);
    expect(report?.rttMaxMs).toBe(0);
  });

  test('bucket bounds are strictly increasing', () => {
    for (let index = 1; index < LINK_RTT_BOUNDS_MS.length; index += 1) {
      expect(LINK_RTT_BOUNDS_MS[index] ?? 0).toBeGreaterThan(LINK_RTT_BOUNDS_MS[index - 1] ?? 0);
    }
  });
});
