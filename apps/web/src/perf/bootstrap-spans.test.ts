import { describe, expect, test } from 'bun:test';

import { createBootstrapSpanDeriver } from './bootstrap-spans';
import type { TerminalPerfEvent, TerminalStartupMilestone } from './terminal-latency';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const ROOT_SPAN_ID = 'b7ad6b7169203331';

function milestone(
  name: TerminalStartupMilestone,
  atMs: number,
  overrides: { attemptId?: number; traceId?: string } = {},
): TerminalPerfEvent {
  return {
    kind: 'startup_milestone',
    atMs,
    attemptId: overrides.attemptId ?? 7,
    deviceId: 'device-a',
    milestone: name,
    elapsedMs: atMs - 1_000,
    traceId: overrides.traceId ?? TRACE_ID,
    spanId: ROOT_SPAN_ID,
  };
}

const LADDER: ReadonlyArray<[TerminalStartupMilestone, number]> = [
  ['device_selected', 1_000],
  ['terminal_mount_requested', 1_010],
  ['worker_ready', 1_120],
  ['terminal_view_presented', 1_040],
  ['transport_start', 1_050],
  ['transport_connected', 1_400],
  ['first_display_applied', 1_520],
  ['first_display_visible', 1_600],
];

interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
}

function spansOf(batch: { readonly resourceSpans: readonly unknown[] } | null): OtlpSpan[] {
  const resource = batch?.resourceSpans?.[0] as
    | { scopeSpans?: Array<{ spans?: OtlpSpan[] }> }
    | undefined;
  return resource?.scopeSpans?.[0]?.spans ?? [];
}

describe('bootstrap span derivation', () => {
  test('a completed attempt yields the phase tree under the attempt trace', () => {
    const deriver = createBootstrapSpanDeriver();
    const spans = spansOf(deriver.derive(LADDER.map(([name, at]) => milestone(name, at))));

    expect(spans.map((span) => span.name).sort()).toEqual([
      'browser.display.first_frame',
      'browser.display.first_paint',
      'browser.session.bootstrap',
      'browser.session.connect',
      'browser.terminal.worker_boot',
      'browser.ui.present',
    ]);
    for (const span of spans) {
      expect(span.traceId).toBe(TRACE_ID);
    }
  });

  /**
   * The root claims the span id the server was told to parent off, so the server's
   * `session_request` span becomes its child rather than the root of a separate trace.
   */
  test('the root claims the traceparent span id and the rest hang off it', () => {
    const deriver = createBootstrapSpanDeriver();
    const spans = spansOf(deriver.derive(LADDER.map(([name, at]) => milestone(name, at))));

    const root = spans.find((span) => span.name === 'browser.session.bootstrap');
    expect(root?.spanId).toBe(ROOT_SPAN_ID);
    expect(root?.parentSpanId).toBeUndefined();

    for (const span of spans.filter((candidate) => candidate !== root)) {
      expect(span.parentSpanId).toBe(ROOT_SPAN_ID);
      expect(span.spanId).not.toBe(ROOT_SPAN_ID);
    }
    expect(new Set(spans.map((span) => span.spanId)).size).toBe(spans.length);
  });

  test('timestamps convert epoch milliseconds to OTLP nanoseconds', () => {
    const deriver = createBootstrapSpanDeriver();
    const spans = spansOf(deriver.derive(LADDER.map(([name, at]) => milestone(name, at))));

    const root = spans.find((span) => span.name === 'browser.session.bootstrap');
    expect(root?.startTimeUnixNano).toBe('1000000000');
    expect(root?.endTimeUnixNano).toBe('1600000000');
  });

  /**
   * The worker ships in 1,000-row slices, so a boundary can fall inside a 600 ms bootstrap.
   */
  test('an attempt split across batches still yields one tree', () => {
    const deriver = createBootstrapSpanDeriver();
    const first = LADDER.slice(0, 4).map(([name, at]) => milestone(name, at));
    const second = LADDER.slice(4).map(([name, at]) => milestone(name, at));

    expect(deriver.derive(first)).toBeNull();
    const spans = spansOf(deriver.derive(second));
    expect(spans.find((span) => span.name === 'browser.terminal.worker_boot')).toBeDefined();
    expect(spans.find((span) => span.name === 'browser.session.bootstrap')).toBeDefined();
  });

  /**
   * A failed connect never reaches the last rung. Emitting a truncated tree would claim a
   * bootstrap completed when it did not.
   */
  test('an attempt that never completes emits nothing', () => {
    const deriver = createBootstrapSpanDeriver();
    const partial = LADDER.slice(0, 6).map(([name, at]) => milestone(name, at));
    expect(deriver.derive(partial)).toBeNull();
  });

  test('a reused attempt id with a new traceparent starts a fresh accumulation', () => {
    const deriver = createBootstrapSpanDeriver();
    const other = '1'.repeat(32);

    deriver.derive(LADDER.slice(0, 4).map(([name, at]) => milestone(name, at)));
    const spans = spansOf(
      deriver.derive(LADDER.map(([name, at]) => milestone(name, at, { traceId: other }))),
    );

    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.traceId).toBe('1'.repeat(32));
    }
  });

  /**
   * An all-zero id is what a record carrying no trace context decodes to. There is nothing
   * to attribute such an attempt to, so it must yield no spans rather than a trace of zeros.
   */
  test('an all-zero trace id yields no spans', () => {
    const deriver = createBootstrapSpanDeriver();
    const events = LADDER.map(([name, at]) => milestone(name, at, { traceId: '0'.repeat(32) }));
    expect(deriver.derive(events)).toBeNull();
  });

  test('non-startup events are ignored', () => {
    const deriver = createBootstrapSpanDeriver();
    expect(deriver.derive([{ kind: 'session_start', atMs: 1 }])).toBeNull();
  });
});
