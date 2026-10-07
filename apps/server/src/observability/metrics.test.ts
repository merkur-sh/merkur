import { expect, test } from 'bun:test';
import { Effect, Layer, Metric } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { OtlpMetrics, OtlpSerialization } from 'effect/observability';

import * as merkurMetrics from './metrics';

import {
  DAEMON_CONTROL_DELIVERY_LATENCY_BOUNDARIES,
  daemonControlDeliveryLatencyMs,
  merkurMetricsSnapshot,
  TELEMETRY_RTT_BOUNDARIES,
} from './metrics';

/**
 * A week of production command-acknowledgement latency, in ms. The previous
 * boundary ladder collapsed p50/p75/p90 into one bucket and p95/p99 into
 * another, which is what the distinctness assertion below exists to prevent.
 */
const OBSERVED_DELIVERY_QUANTILES_MS = [18.54, 63.41, 71.4, 85.26, 108.23, 131.91, 248.76, 467.07];

function bucketFor(boundaries: readonly number[], sample: number): number {
  const boundary = boundaries.find((candidate) => sample <= candidate);
  return boundary ?? Number.POSITIVE_INFINITY;
}

test('HTTP metric snapshots preserve frequency labels as JSON objects', async () => {
  const frequency = Metric.frequency(`merkur_test_frequency_${crypto.randomUUID()}`);
  await Effect.runPromise(Metric.update(frequency, 'accepted'));

  const snapshots = await Effect.runPromise(merkurMetricsSnapshot);
  const snapshot = snapshots.find((candidate) => candidate.id === frequency.id);

  expect(snapshot).toBeDefined();
  expect(snapshot?.state).toEqual({
    occurrences: {
      accepted: 1,
    },
  });
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
});

test('histogram boundary ladders are strictly increasing and positive', () => {
  for (const boundaries of [DAEMON_CONTROL_DELIVERY_LATENCY_BOUNDARIES, TELEMETRY_RTT_BOUNDARIES]) {
    expect(boundaries.length).toBeGreaterThan(0);
    expect(boundaries[0]).toBeGreaterThan(0);
    for (let index = 1; index < boundaries.length; index += 1) {
      const previous = boundaries[index - 1];
      const current = boundaries[index];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      expect(current ?? 0).toBeGreaterThan(previous ?? 0);
    }
  }
});

test('every observed delivery-latency quantile lands in its own bucket', () => {
  const buckets = OBSERVED_DELIVERY_QUANTILES_MS.map((sample) =>
    bucketFor(DAEMON_CONTROL_DELIVERY_LATENCY_BOUNDARIES, sample),
  );

  // The regression this guards: with the previous ladder, p50 (71.40),
  // p75 (85.26) and p90 (108.23) shared a bucket and p95 (131.91) shared one
  // with p99 (248.76), so those quantiles were equal by construction.
  expect(new Set(buckets).size).toBe(OBSERVED_DELIVERY_QUANTILES_MS.length);
});

test('the delivery-latency histogram records into the retuned boundaries', async () => {
  await Effect.runPromise(
    Effect.forEach(OBSERVED_DELIVERY_QUANTILES_MS, (sample) =>
      Metric.update(daemonControlDeliveryLatencyMs, sample),
    ),
  );

  const state = await Effect.runPromise(Metric.value(daemonControlDeliveryLatencyMs));

  expect(state.count).toBeGreaterThanOrEqual(OBSERVED_DELIVERY_QUANTILES_MS.length);
  // Effect reports one entry per declared boundary; the implicit +Inf overflow
  // bucket is not materialised here, though OTLP export still emits it.
  expect(state.buckets.map(([boundary]) => boundary)).toEqual([
    ...DAEMON_CONTROL_DELIVERY_LATENCY_BOUNDARIES,
  ]);

  // Cumulative counts must be non-decreasing, and the samples must be spread
  // across the ladder rather than piled into a single bucket.
  const cumulative = state.buckets.map(([, count]) => count);
  for (let index = 1; index < cumulative.length; index += 1) {
    expect(cumulative[index] ?? 0).toBeGreaterThanOrEqual(cumulative[index - 1] ?? 0);
  }
  const populated = cumulative.filter(
    (count, index) => count > (index === 0 ? 0 : (cumulative[index - 1] ?? 0)),
  );
  expect(populated.length).toBe(OBSERVED_DELIVERY_QUANTILES_MS.length);
});

// Exercise the installed OTLP exporter: catalog metadata determines whether
// Axiom treats a process restart as a counter reset and which units it displays.
test('OTLP exports event totals as monotonic counters and dimensional units', async () => {
  interface ExportedMetric {
    readonly name: string;
    readonly unit: string;
    readonly sum?: { readonly isMonotonic: boolean };
    readonly histogram?: object;
  }
  const exported: ExportedMetric[] = [];
  const sink = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body: {
        resourceMetrics: { scopeMetrics: { metrics: ExportedMetric[] }[] }[];
      } = await request.json();
      for (const resource of body.resourceMetrics) {
        for (const scope of resource.scopeMetrics) exported.push(...scope.metrics);
      }
      return Response.json({});
    },
  });
  const exporter = OtlpMetrics.layer({
    url: `http://127.0.0.1:${sink.port}/v1/metrics`,
    exportInterval: '1 hour',
    resource: { serviceName: 'merkur-metrics-test' },
  }).pipe(Layer.provide([FetchHttpClient.layer, OtlpSerialization.layerJson]));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const candidates: readonly unknown[] = Object.values(merkurMetrics);
        for (const metric of candidates) {
          if (Metric.isMetric(metric)) yield* Metric.value(metric);
        }
      }).pipe(Effect.provide(exporter)),
    );
    const totals = exported.filter((metric) => metric.name.endsWith('_total'));
    expect(totals.length).toBeGreaterThan(30);
    for (const metric of totals) {
      expect({ name: metric.name, monotonic: metric.sum?.isMonotonic }).toEqual({
        name: metric.name,
        monotonic: true,
      });
    }
    const latencies = exported.filter((metric) => metric.name.endsWith('_ms'));
    expect(latencies.map((metric) => metric.name)).toEqual(
      expect.arrayContaining([
        'merkur_daemon_control_delivery_latency_ms',
        'merkur_daemon_ping_rtt_p50_ms',
        'merkur_daemon_ping_rtt_p95_ms',
        'merkur_daemon_suspension_gap_ms',
        'merkur_browser_link_rtt_p50_ms',
        'merkur_browser_link_rtt_p95_ms',
        'merkur_browser_input_ack_rtt_p50_ms',
        'merkur_browser_input_ack_rtt_p95_ms',
      ]),
    );
    for (const metric of latencies) {
      expect(metric.unit).toBe('ms');
      expect(metric.histogram).toBeDefined();
    }
    for (const direction of ['tx', 'rx']) {
      expect(
        exported.find((metric) => metric.name === `merkur_browser_link_${direction}_bytes_total`)
          ?.unit,
      ).toBe('By');
    }
  } finally {
    sink.stop(true);
  }
});
