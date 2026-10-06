import {
  formatTraceparent,
  parseTraceparent,
  TRACEPARENT_HEADER,
  type TraceContext,
} from '@merkur/shared';
import { Effect, Tracer } from 'effect';

/**
 * Inbound and outbound W3C trace context, as Effect spans.
 *
 * # Why this exists at all
 *
 * It replaces `propagation.extract(context.active(), headers)` from the
 * OpenTelemetry SDK, which read the *ambient* context to decide a request's
 * parent. That ambient read is the fault behind three production incidents: a
 * finished span stayed installed as the global current span and silently
 * adopted later requests. Deriving the parent from the request itself removes
 * the ambient channel entirely — there is nothing left to inherit by accident.
 *
 * The wire format lives in `@merkur/shared` so the browser, the server and the
 * daemon share one implementation; this module is only the Effect adapter.
 */

function toExternalSpan(context: TraceContext | null): Tracer.ExternalSpan | undefined {
  return context === null ? undefined : Tracer.externalSpan(context);
}

/**
 * The inbound request's parent span, read from its headers.
 *
 * Takes the `Request` rather than a header string so route call sites cannot
 * accidentally pass the wrong header, and so the lookup is one place if the
 * header set ever grows.
 */
export function inboundTraceParent(request: Request): Tracer.ExternalSpan | undefined {
  return toExternalSpan(parseTraceparent(request.headers.get(TRACEPARENT_HEADER)));
}

/** A parent span from a `traceparent` carried on a non-HTTP message. */
export function traceParentFrom(header: string): Tracer.ExternalSpan | undefined {
  return toExternalSpan(parseTraceparent(header));
}

/**
 * The current span rendered as a `traceparent`, or `''` when there is none.
 *
 * Used to carry trace context to the daemon over the control link, which is the
 * one hop between the two that can carry it — a daemon is reached through a
 * long-lived WebSocket whose handshake happened long before any request.
 *
 * The empty string is the honest encoding of "no active span", which is the
 * normal state with telemetry unconfigured. It is not an absent field: the
 * control protocol validates key sets exactly, so an omitted key is a rejected
 * frame rather than a missing attribute.
 *
 * An unsampled span renders `-00`, so the daemon's child is unsampled too and
 * the sampling decision stays with whoever made it.
 */
export const currentTraceparent: Effect.Effect<string> = Effect.currentSpan.pipe(
  Effect.map((span) =>
    formatTraceparent({ traceId: span.traceId, spanId: span.spanId, sampled: span.sampled }),
  ),
  Effect.orElseSucceed(() => ''),
);
