import { type Layer, Logger, References } from 'effect';
import { writeMerkurLog } from './sink';

const LOG_ANNOTATION_SCOPE = 'scope';
const LOG_ANNOTATION_CONTEXT_JSON = '__merkur_context_json';

export const MerkurJsonLogger = Logger.make(({ logLevel, message, fiber, date }) => {
  const annotations = fiber.getRef(References.CurrentLogAnnotations);
  const scope =
    typeof annotations[LOG_ANNOTATION_SCOPE] === 'string'
      ? annotations[LOG_ANNOTATION_SCOPE]
      : 'unknown';

  const context = readContextFromAnnotations(annotations);
  const now = date.getTime();
  const spans: Record<string, number> = {};
  for (const [label, startedAt] of fiber.getRef(References.CurrentLogSpans)) {
    spans[label] = now - startedAt;
  }

  const level =
    logLevel === 'Info'
      ? 'info'
      : logLevel === 'Warn'
        ? 'warn'
        : logLevel === 'Error' || logLevel === 'Fatal'
          ? 'error'
          : 'info';

  // The same source `OtlpLogger` reads, so stdout and the exported record agree on which
  // trace a line belongs to.
  const span = fiber.cache.span;

  writeMerkurLog({
    ts: date.toISOString(),
    level,
    scope,
    message: typeof message === 'string' ? message : String(message),
    context,
    fiberId: String(fiber.id),
    spans,
    ...(span === undefined ? {} : { traceId: span.traceId, spanId: span.spanId }),
  });
});

/**
 * Structured JSON logging only. Span export belongs to the OTLP tracer the
 * server installs (`apps/server/src/observability/telemetry.ts`); emitting
 * spans here as well would duplicate every span in a second shape and double
 * the log volume. Without an OTLP tracer installed, Effect's built-in tracer
 * still produces spans with valid identifiers — they are simply not exported.
 */
export function makeMerkurLoggerLayer(): Layer.Layer<never> {
  return Logger.layer([MerkurJsonLogger]);
}

export const MerkurLoggerLayer = makeMerkurLoggerLayer();

function readContextFromAnnotations(annotations: Record<string, unknown>): Record<string, unknown> {
  const encodedContext = annotations[LOG_ANNOTATION_CONTEXT_JSON];
  if (typeof encodedContext === 'string') {
    try {
      const parsed = JSON.parse(encodedContext);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to annotation-based context below.
    }
  }

  const context: Record<string, unknown> = {};
  for (const key of Object.keys(annotations)) {
    if (key !== LOG_ANNOTATION_SCOPE && key !== LOG_ANNOTATION_CONTEXT_JSON) {
      context[key] = annotations[key];
    }
  }
  return context;
}
