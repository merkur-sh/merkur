import { Exit, Layer, Option, Tracer } from 'effect';

/**
 * A development tracer that prints each finished trace to stdout as a tree.
 *
 * Without an OTLP endpoint the server and daemon still create spans, and until
 * now those spans went nowhere at all: `Effect.withSpan` ran against Effect's
 * default no-op tracer and every parent/child relationship the code declares
 * was unobservable locally. This makes them visible with no collector, no
 * container and no configuration.
 *
 * The trace id is printed in the header because it is the only way to match a
 * trace across processes — the server, the daemon and the edge write to three
 * separate stdouts, and nothing else joins them.
 */

const NANOS_PER_MILLI = 1_000_000n;

/**
 * Traces are flushed when their root span ends, so a trace whose root never
 * ends would accumulate forever. Bounding the map keeps a diagnostic from
 * growing without limit in a long dev session; the oldest incomplete trace is
 * dropped first.
 */
const MAX_PENDING_TRACES = 256;

const TREE_BRANCH = '├─ ';
const TREE_LAST = '└─ ';
const TREE_PIPE = '│  ';
const TREE_BLANK = '   ';

type SpanEvent = readonly [name: string, startTime: bigint, attributes: Record<string, unknown>];

/**
 * `NativeSpan` already resolves the trace id from the parent and allocates the
 * ids, so the only thing worth adding is a completion callback.
 */
class TreeSpan extends Tracer.NativeSpan {
  readonly onEnded: (span: TreeSpan) => void;

  constructor(
    options: {
      readonly name: string;
      readonly parent: Option.Option<Tracer.AnySpan>;
      readonly annotations: Tracer.NativeSpan['annotations'];
      readonly links: Array<Tracer.SpanLink>;
      readonly startTime: bigint;
      readonly kind: Tracer.SpanKind;
      readonly sampled: boolean;
    },
    onEnded: (span: TreeSpan) => void,
  ) {
    super(options);
    this.onEnded = onEnded;
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit);
    this.onEnded(this);
  }
}

/**
 * A span roots a trace in *this* process when it has no parent, or when its
 * parent arrived from another service as an `ExternalSpan`. Both are the point
 * at which the local tree is complete and can be printed.
 */
function rootsLocalTrace(span: TreeSpan): boolean {
  const parent = Option.getOrUndefined(span.parent);
  return parent === undefined || parent._tag === 'ExternalSpan';
}

function durationMs(span: TreeSpan): number {
  if (span.status._tag !== 'Ended') {
    return 0;
  }
  const nanos = span.status.endTime - span.status.startTime;
  return Number(nanos / NANOS_PER_MILLI) + Number(nanos % NANOS_PER_MILLI) / 1_000_000;
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function formatOutcome(span: TreeSpan): string {
  if (span.status._tag !== 'Ended') {
    return ' unfinished';
  }
  if (Exit.isFailure(span.status.exit)) {
    return ' FAILED';
  }
  return '';
}

/**
 * Attributes are rendered inline because a dev tree is read at a glance. The
 * values are the ones the code sets deliberately; nothing here is a redaction
 * boundary, because this tracer never leaves the machine.
 */
function formatAttributes(span: TreeSpan): string {
  if (span.attributes.size === 0) {
    return '';
  }
  const rendered = [...span.attributes.entries()]
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  return `  ${rendered}`;
}

function formatEvent(event: SpanEvent, spanStart: bigint): string {
  const [name, startTime] = event;
  const offset = Number((startTime - spanStart) / NANOS_PER_MILLI);
  return `[event] ${name} +${offset}ms`;
}

function childrenOf(spans: readonly TreeSpan[], parentSpanId: string | null): TreeSpan[] {
  return spans
    .filter((span) => {
      const parent = Option.getOrUndefined(span.parent);
      const localParentId =
        parent === undefined || parent._tag === 'ExternalSpan' ? null : parent.spanId;
      return localParentId === parentSpanId;
    })
    .sort((left, right) => Number(left.startTime - right.startTime));
}

function renderSpan(
  span: TreeSpan,
  spans: readonly TreeSpan[],
  prefix: string,
  connector: string,
  lines: string[],
): void {
  lines.push(
    `${prefix}${connector}${span.name}  ${formatMs(durationMs(span))}${formatOutcome(span)}${formatAttributes(span)}`,
  );

  const childPrefix =
    connector === '' ? '' : prefix + (connector === TREE_LAST ? TREE_BLANK : TREE_PIPE);

  for (const event of span.events as readonly SpanEvent[]) {
    lines.push(`${childPrefix}${TREE_BRANCH}${formatEvent(event, span.startTime)}`);
  }

  const children = childrenOf(spans, span.spanId);
  children.forEach((child, index) => {
    const last = index === children.length - 1;
    renderSpan(child, spans, childPrefix, last ? TREE_LAST : TREE_BRANCH, lines);
  });
}

function renderTraceTree(traceId: string, spans: readonly TreeSpan[]): string {
  const roots = childrenOf(spans, null);
  const lines = [`── trace ${traceId} ${'─'.repeat(Math.max(0, 48 - traceId.length))}`];
  for (const root of roots) {
    renderSpan(root, spans, '', '', lines);
  }
  return `${lines.join('\n')}\n`;
}

function writeToStdout(text: string): void {
  if (typeof process !== 'undefined' && typeof process.stdout?.write === 'function') {
    process.stdout.write(text);
  }
}

/**
 * Builds the tracer. `write` is injectable so tests can assert the rendered
 * tree without capturing stdout.
 */
export function makeSpanTreeTracer(write: (text: string) => void = writeToStdout): Tracer.Tracer {
  const pending = new Map<string, TreeSpan[]>();

  const flush = (span: TreeSpan): void => {
    const spans = pending.get(span.traceId);
    if (spans === undefined) {
      return;
    }
    pending.delete(span.traceId);
    write(renderTraceTree(span.traceId, spans));
  };

  return Tracer.make({
    span(options) {
      // `root` is honoured here rather than by the caller: Effect passes both
      // the resolved parent and the root flag, leaving the decision to the
      // tracer. A rooted span must start its own trace id, not inherit one.
      const parent = options.root ? Option.none<Tracer.AnySpan>() : options.parent;

      const span = new TreeSpan(
        {
          name: options.name,
          parent,
          annotations: options.annotations,
          links: options.links,
          startTime: options.startTime,
          kind: options.kind,
          sampled: options.sampled,
        },
        (ended) => {
          if (rootsLocalTrace(ended)) {
            flush(ended);
          }
        },
      );

      if (!options.sampled) {
        return span;
      }

      const spans = pending.get(span.traceId);
      if (spans === undefined) {
        if (pending.size >= MAX_PENDING_TRACES) {
          const oldest = pending.keys().next();
          if (!oldest.done) {
            pending.delete(oldest.value);
          }
        }
        pending.set(span.traceId, [span]);
      } else {
        spans.push(span);
      }

      return span;
    },
  });
}

/**
 * Installs the stdout span tree as the process tracer.
 *
 * Deliberately not gated on an environment variable: it is selected by the
 * absence of an OTLP configuration, so the two are mutually exclusive by
 * construction and no combination of settings can produce both or neither.
 */
export const SpanTreeTracerLayer: Layer.Layer<never> = Layer.succeed(
  Tracer.Tracer,
  makeSpanTreeTracer(),
);
