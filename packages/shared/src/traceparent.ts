/**
 * W3C trace-context `traceparent`, as plain strings.
 *
 * One implementation, shared by every TypeScript side that touches it: the
 * browser mints one per `/api/*` request, the server parses inbound requests
 * and formats context onto daemon control commands, and the daemon parses it
 * back off those commands. `apps/edge/src/register.rs` is the Rust mirror, and
 * both are pinned to the specification's own example vector by test — the same
 * discipline the STUN ticket uses, because nothing at runtime detects drift
 * between two implementations of a wire format.
 *
 * Deliberately free of any `effect` import. The callers that need an Effect
 * `ExternalSpan` build one from these fields; the browser needs only the string
 * and must not pull a tracing runtime into its bundle to get it.
 */

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;

/**
 * Only version `00` is accepted. Every producer is Merkur's own, and all of
 * them emit `00`. Accepting an unknown version would mean guessing at a layout
 * this code has never seen, which is a compatibility path rather than a parser.
 */
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const ZERO_TRACE_ID = '0'.repeat(TRACE_ID_BYTES * 2);
const ZERO_SPAN_ID = '0'.repeat(SPAN_ID_BYTES * 2);

const SAMPLED_FLAG = 0x01;
const SAMPLED_FLAGS = '01';
const UNSAMPLED_FLAGS = '00';

export const TRACEPARENT_HEADER = 'traceparent';

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Parses a `traceparent`, or returns `null` when it is absent or malformed.
 *
 * Malformed is not an error anywhere it is used: trace context is diagnostic,
 * and no request or command may fail because something upstream sent a bad
 * value. The caller roots its own trace instead.
 */
export function parseTraceparent(header: string | null | undefined): TraceContext | null {
  if (header === null || header === undefined) {
    return null;
  }

  const match = TRACEPARENT_PATTERN.exec(header.trim());
  if (match === null) {
    return null;
  }

  const [, traceId, spanId, flags] = match;
  if (traceId === undefined || spanId === undefined || flags === undefined) {
    return null;
  }

  // The specification requires both ids to be non-zero; an all-zero value is
  // how a sender signals "no context", and treating it as a parent would put
  // every such message into one trace.
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) {
    return null;
  }

  return {
    traceId,
    spanId,
    sampled: (Number.parseInt(flags, 16) & SAMPLED_FLAG) === SAMPLED_FLAG,
  };
}

export function formatTraceparent(context: TraceContext): string {
  const flags = context.sampled ? SAMPLED_FLAGS : UNSAMPLED_FLAGS;
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

/**
 * A fresh `traceparent` for one request, for a caller that has no tracer.
 *
 * Per request, not per session: a session-wide trace id would put every request
 * a tab ever makes into one trace, which is the exact shape that once fused
 * 66,005 records together and made the trace view useless.
 *
 * Always sampled, because a client with no tracer cannot see the server's
 * threshold and has no basis for the decision. It defers; the server drops what
 * it does not want.
 */
export function mintTraceContext(): TraceContext {
  const bytes = new Uint8Array(TRACE_ID_BYTES + SPAN_ID_BYTES);
  crypto.getRandomValues(bytes);
  return {
    traceId: toHex(bytes.subarray(0, TRACE_ID_BYTES)),
    spanId: toHex(bytes.subarray(TRACE_ID_BYTES)),
    sampled: true,
  };
}

export function mintTraceparent(): string {
  return formatTraceparent(mintTraceContext());
}

/** The header pair, for spreading into a `HeadersInit` object literal. */
export function traceparentHeader(): Record<string, string> {
  return { [TRACEPARENT_HEADER]: mintTraceparent() };
}
