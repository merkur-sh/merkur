import { Option, Tracer } from 'effect';

/**
 * Tail sampling: decide whether to keep a trace once it is finished, not when it starts.
 *
 * # Why head sampling is the wrong shape
 *
 * Effect resolves a span's `sampled` flag at creation, from its `level` against
 * `MinimumTraceLevel`. That is a decision made before anything is known about the request.
 * The traces actually worth keeping are the slow ones and the failed ones, and a head
 * decision keeps them at exactly the same rate as the boring ones.
 *
 * So this tracer buffers a trace's spans and decides at root-end, when the outcome and the
 * duration are both known.
 *
 * # How it reuses Effect's serializer
 *
 * It wraps the tracer returned by `OtlpTracer.make` rather than replacing it. `span()`
 * delegates, so `traceId`, `spanId` and parent chaining are Effect's own — no ids are
 * fabricated here, which is what keeps a trace joinable with the browser's `traceparent`
 * and the daemon's spans.
 *
 * Each span Effect's OTLP tracer creates carries its exporter callback as an **own,
 * writable property**. We capture it, replace it with a no-op, and call the captured one
 * later for the spans of a kept trace. By then `end()` has already written the span's final
 * status, so Effect's own (module-private) OTLP serializer runs over the real span with
 * everything intact. There is no second serializer to keep in sync.
 *
 * That property is not part of Effect's public API. `tail-sampling-tracer.test.ts` pins the
 * assumption, so an upgrade that changes it fails loudly instead of silently exporting
 * every span forever.
 *
 * # Levels become tiers, not drops
 *
 * `sampled: false` arriving here means "declared below the trace-level threshold" — a
 * `Debug` span such as `redis.operation`. Rather than dropping it at creation, it is
 * buffered as low tier and emitted **only if the trace is kept**. A slow or failed request
 * therefore arrives with its full Redis breakdown, and a boring one costs nothing. That is
 * strictly more useful than either dropping it always or keeping it always.
 */

/** Spans of traces whose root never ends would accumulate forever without this. */
const MAX_PENDING_TRACES = 4096;

/**
 * Decisions remembered after a trace is flushed, so a span that ends *after* its root can
 * still be exported.
 *
 * A forked fiber can outlive the request that forked it, and its span then ends after the
 * root has already been decided. Without this it would hit a no-op hook and vanish — a
 * silent hole in an otherwise kept trace. Bounded and evicted oldest-first, like the
 * pending map.
 */
const MAX_REMEMBERED_DECISIONS = 4096;

/**
 * Span names whose presence forces a trace to be kept.
 *
 * The daemon exports its spans unconditionally through its own tracer. If the server dropped
 * a trace the daemon had already contributed to, the daemon's span would arrive orphaned
 * under a parent that was never exported. Keeping every trace that reached a daemon is what
 * makes the two agree without a collector coordinating them.
 */
const ALWAYS_KEEP_SPAN_NAMES: ReadonlySet<string> = new Set([
  'daemon-control.delivery',
  'daemon-control.broker-delivery',
]);

export type TailSamplingDecision =
  | 'kept_error'
  | 'kept_slow'
  | 'kept_daemon'
  | 'kept_ratio'
  | 'dropped_ratio'
  | 'evicted';

export interface TailSamplingOptions {
  /** Root spans at or above this duration are always kept. */
  readonly slowThresholdMs: number;
  /** Share of otherwise-unremarkable traces to keep, 0 to 1. */
  readonly ratio: number;
  /** Injected so tests are deterministic. */
  readonly random?: () => number;
  /** Called once per finished trace, for the sampling metric. */
  readonly onDecision?: (decision: TailSamplingDecision) => void;
}

/** The exporter callback Effect's OTLP spans carry as an own property. */
interface ExportingSpan {
  export?: (span: unknown) => void;
}

/**
 * Narrow, explicit guard rather than a cast: this is the one place the implementation
 * depends on runtime shape Effect does not publish, so it is checked rather than assumed.
 */
function exportHookOf(span: Tracer.Span): ((span: unknown) => void) | null {
  if (!Object.hasOwn(span as object, 'export')) {
    return null;
  }
  const hook = (span as unknown as ExportingSpan).export;
  return typeof hook === 'function' ? hook : null;
}

function replaceExportHook(span: Tracer.Span, hook: (span: unknown) => void): void {
  (span as unknown as ExportingSpan).export = hook;
}

const NANOS_PER_MILLI = 1_000_000n;

function endedDurationMs(span: Tracer.Span): number {
  if (span.status._tag !== 'Ended') return 0;
  return Number((span.status.endTime - span.status.startTime) / NANOS_PER_MILLI);
}

function endedInFailure(span: Tracer.Span): boolean {
  return span.status._tag === 'Ended' && span.status.exit._tag === 'Failure';
}

/**
 * A span roots a trace in this process when it has no parent, or when its parent arrived
 * from another service as an `ExternalSpan`.
 *
 * A browser-minted parent is an `ExternalSpan` from a client that exports no spans of its
 * own, so the server is the real root and correctly owns the decision.
 */
function rootsLocalTrace(parent: Option.Option<Tracer.AnySpan>): boolean {
  const value = Option.getOrUndefined(parent);
  return value === undefined || value._tag === 'ExternalSpan';
}

/**
 * An upstream service that exports its own spans has already decided. Honour it, or the two
 * halves of one trace disagree.
 */
function upstreamRefusedSampling(parent: Option.Option<Tracer.AnySpan>): boolean {
  const value = Option.getOrUndefined(parent);
  return value !== undefined && value.sampled === false;
}

interface BufferedSpan {
  readonly span: Tracer.Span;
  readonly emit: () => void;
}

function evictOldest<K, V>(map: Map<K, V>, limit: number, onEvict?: () => void): void {
  if (map.size < limit) return;
  const oldest = map.keys().next();
  if (!oldest.done) {
    map.delete(oldest.value);
    onEvict?.();
  }
}

export function makeTailSamplingTracer(
  inner: Tracer.Tracer,
  options: TailSamplingOptions,
): Tracer.Tracer {
  const random = options.random ?? Math.random;
  const pending = new Map<string, BufferedSpan[]>();
  const decided = new Map<string, boolean>();

  const report = (decision: TailSamplingDecision): void => {
    options.onDecision?.(decision);
  };

  const decide = (root: Tracer.Span, buffered: readonly BufferedSpan[]): TailSamplingDecision => {
    if (buffered.some((entry) => endedInFailure(entry.span))) return 'kept_error';
    if (endedDurationMs(root) >= options.slowThresholdMs) return 'kept_slow';
    if (buffered.some((entry) => ALWAYS_KEEP_SPAN_NAMES.has(entry.span.name))) return 'kept_daemon';
    return random() < options.ratio ? 'kept_ratio' : 'dropped_ratio';
  };

  const flush = (root: Tracer.Span): void => {
    const buffered = pending.get(root.traceId);
    if (buffered === undefined) return;
    pending.delete(root.traceId);

    const decision = decide(root, buffered);
    report(decision);

    const kept = decision !== 'dropped_ratio';
    evictOldest(decided, MAX_REMEMBERED_DECISIONS);
    decided.set(root.traceId, kept);
    if (!kept) return;

    // Only finished spans can be serialized. An unfinished one belongs to a fiber that
    // outlived the root; it exports itself through the remembered decision below.
    for (const entry of buffered) {
      if (entry.span.status._tag === 'Ended') entry.emit();
    }
  };

  return Tracer.make({
    span(spanOptions) {
      // Upstream already refused. Pass the refusal through so the inner tracer drops it,
      // and buffer nothing.
      if (upstreamRefusedSampling(spanOptions.parent)) {
        return inner.span({ ...spanOptions, sampled: false });
      }

      // Forced sampled so the inner exporter does not drop it before we decide. The
      // original flag is the *tier*, and it is preserved on the buffered span only in the
      // sense that a low-tier span is still emitted with a kept trace — the whole point of
      // deferring the decision.
      const span = inner.span({ ...spanOptions, sampled: true });

      const hook = exportHookOf(span);
      if (hook === null) {
        // Effect changed shape. Exporting immediately is the safe failure: a trace with no
        // sampling is far better than a trace with no spans. The test pins this so it is a
        // build failure long before it is a production one.
        return span;
      }

      const entry: BufferedSpan = { span, emit: () => hook(span) };

      // A span that ends after its trace was decided exports on the spot when the trace was
      // kept, and is discarded when it was not.
      replaceExportHook(span, () => {
        const kept = decided.get(span.traceId);
        if (kept === true) hook(span);
      });

      const buffered = pending.get(span.traceId);
      if (buffered === undefined) {
        evictOldest(pending, MAX_PENDING_TRACES, () => {
          report('evicted');
        });
        pending.set(span.traceId, [entry]);
      } else {
        buffered.push(entry);
      }

      if (rootsLocalTrace(spanOptions.parent)) {
        // `end()` writes the final status before invoking the export hook, so wrapping the
        // hook — rather than `end` — means the decision always sees a finished root.
        replaceExportHook(span, () => {
          flush(span);
        });
      }

      return span;
    },
  });
}
