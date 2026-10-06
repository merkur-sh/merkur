import type { TerminalPerfEvent, TerminalStartupMilestone } from './terminal-latency';

/**
 * OTLP spans for the session bootstrap, derived from perf-ring records that already exist.
 *
 * # Why derived rather than instrumented
 *
 * Merkur is a latency product and the ~600 ms connect path is the part users feel, but it
 * lived only as profiling *rows* in a second dataset, joined to server traces by session id.
 * "Why did connect take three seconds" was two queries across two stores.
 *
 * The span tree was already in the data. `TerminalStartupMilestone` records independent
 * startup branches once per attempt with absolute epoch-millisecond timestamps. The
 * milestone pairs below are the spans. Deriving them adds no instrumentation call sites, no ring
 * writes, and **no main-thread work at all** — this runs in the telemetry worker, on a batch
 * it has already decoded and sorted, on a cold thread.
 *
 * Spans are for bounded, causal, once-per-session work. Rows remain the shape for the
 * unbounded per-frame stream. Nothing here ever runs per frame.
 */

/** OTLP `unixNano` from the ring's absolute epoch milliseconds. */
const NANOS_PER_MILLI = 1_000_000;

const SERVICE_NAME = 'merkur-browser';

/**
 * `SpanKind.INTERNAL`. The browser is the origin of the trace, not a server handling a
 * request, and these describe its own work rather than a call it made.
 */
const SPAN_KIND_INTERNAL = 1;

interface DerivedSpan {
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The tree, as milestone pairs.
 *
 * The root spans the whole attempt; the rest are the phases inside it. Every bound is a
 * milestone the app already emits, so this table is the entire specification of the derived
 * trace — there is nothing to keep in sync in another file.
 */
const SPAN_BOUNDS: ReadonlyArray<{
  readonly name: string;
  readonly from: TerminalStartupMilestone;
  readonly to: TerminalStartupMilestone;
}> = [
  { name: 'browser.session.bootstrap', from: 'device_selected', to: 'first_display_visible' },
  { name: 'browser.terminal.worker_boot', from: 'terminal_mount_requested', to: 'worker_ready' },
  { name: 'browser.ui.present', from: 'terminal_mount_requested', to: 'terminal_view_presented' },
  { name: 'browser.session.connect', from: 'transport_start', to: 'transport_connected' },
  { name: 'browser.display.first_frame', from: 'transport_connected', to: 'first_display_applied' },
  {
    name: 'browser.display.first_paint',
    from: 'first_display_applied',
    to: 'first_display_visible',
  },
];

const ROOT_SPAN_NAME = 'browser.session.bootstrap';

/** One connect attempt's milestones, accumulated across drain batches. */
interface AttemptState {
  readonly traceId: string;
  readonly spanId: string;
  readonly deviceId: string;
  readonly milestones: Map<TerminalStartupMilestone, number>;
}

export interface BootstrapSpanBatch {
  readonly resourceSpans: readonly unknown[];
}

function hex(value: number, digits: number): string {
  return value.toString(16).padStart(digits, '0');
}

/**
 * A deterministic span id for a derived span.
 *
 * Derived spans are not created by a tracer, so they need ids. They must be stable across
 * batches — a phase whose bounds arrive in different drains must not produce two spans — so
 * the id is a function of the trace and the span name rather than random. The root instead
 * claims the span id the attempt's `traceparent` already carries, which is what makes the
 * server's `session_request` span its child.
 */
function derivedSpanId(traceId: string, name: string): string {
  let hash = 0x811c9dc5;
  for (const text of [traceId, name]) {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  // 64 bits from two rounds, so distinct names do not collide within one trace.
  const low = hash;
  let high = Math.imul(hash ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  high = (high ^ (high >>> 13)) >>> 0;
  return `${hex(high, 8)}${hex(low, 8)}`;
}

/**
 * Accumulates startup milestones and emits OTLP spans once an attempt completes.
 *
 * Stateful across batches for the same reason `createPerfSessionStamper` is: the worker
 * ships in 1,000-row slices and a boundary can fall in the middle of a 600 ms bootstrap.
 */
export function createBootstrapSpanDeriver(): {
  readonly derive: (events: readonly TerminalPerfEvent[]) => BootstrapSpanBatch | null;
} {
  const attempts = new Map<number, AttemptState>();

  const finish = (attemptId: number, state: AttemptState): unknown[] => {
    // An all-zero id is what a record with no trace context decodes to; there is nothing to
    // attribute such an attempt to, so it yields no spans rather than a trace of zeros.
    if (/^0+$/.test(state.traceId) || /^0+$/.test(state.spanId)) return [];

    const spans: unknown[] = [];
    for (const bound of SPAN_BOUNDS) {
      const startMs = state.milestones.get(bound.from);
      const endMs = state.milestones.get(bound.to);
      if (startMs === undefined || endMs === undefined || endMs < startMs) continue;
      const derived: DerivedSpan = { name: bound.name, startMs, endMs };
      const isRoot = bound.name === ROOT_SPAN_NAME;
      spans.push({
        traceId: state.traceId,
        // The root claims the id the server was told to parent off.
        spanId: isRoot ? state.spanId : derivedSpanId(state.traceId, derived.name),
        ...(isRoot ? {} : { parentSpanId: state.spanId }),
        name: derived.name,
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: String(Math.round(derived.startMs * NANOS_PER_MILLI)),
        endTimeUnixNano: String(Math.round(derived.endMs * NANOS_PER_MILLI)),
        attributes: [
          { key: 'merkur.attempt.id', value: { intValue: String(attemptId) } },
          { key: 'merkur.device.id', value: { stringValue: state.deviceId } },
        ],
      });
    }
    return spans;
  };

  return {
    derive(events) {
      const completed: unknown[] = [];

      for (const event of events) {
        if (event.kind !== 'startup_milestone') continue;

        let state = attempts.get(event.attemptId);
        if (state === undefined || state.traceId !== event.traceId) {
          // A new attempt, or the same attempt id reused by a later one. Either way the
          // previous accumulation is not this trace's.
          state = {
            traceId: event.traceId,
            spanId: event.spanId,
            deviceId: event.deviceId,
            milestones: new Map(),
          };
          attempts.set(event.attemptId, state);
        }
        state.milestones.set(event.milestone, event.atMs);

        // The last rung of the ladder ends the attempt. An attempt that never reaches it —
        // a failed connect — emits nothing rather than a truncated tree claiming success.
        if (event.milestone === 'first_display_visible') {
          completed.push(...finish(event.attemptId, state));
          attempts.delete(event.attemptId);
        }
      }

      if (completed.length === 0) return null;
      return {
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: 'service.name', value: { stringValue: SERVICE_NAME } }],
            },
            scopeSpans: [{ scope: { name: SERVICE_NAME }, spans: completed }],
          },
        ],
      };
    },
  };
}
