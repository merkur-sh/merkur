import { SpanTreeTracerLayer } from '@merkur/logger';
import { merkurVersion, spanAttributes } from '@merkur/shared';
import { Context, Effect, Layer, Redacted, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import {
  OtlpExporter,
  OtlpLogger,
  OtlpMetrics,
  OtlpSerialization,
  OtlpTracer,
} from 'effect/observability';

import { type ServerConfig, ServerConfigService, type TelemetryConfig } from '../config';
import { traceSamplingFrequency } from './metrics';
import { makeTailSamplingTracer } from './tail-sampling-tracer';

export const SERVICE_NAME = 'merkur-server';
const SPAN_EXPORT_INTERVAL = '2 seconds';
const METRICS_EXPORT_INTERVAL = '30 seconds';
const SHUTDOWN_TIMEOUT = '5 seconds';
// One identity for this process, shared by every signal and exporter scope.
// Without it cumulative metrics from replicas running the same build collide.
const SERVICE_INSTANCE_ID = crypto.randomUUID();

/**
 * All three signals reach Axiom through Effect's own OTLP modules. No
 * `@opentelemetry/*` package is involved.
 *
 * # Why the OpenTelemetry SDK is gone
 *
 * It was here for one reason: `@elysiajs/opentelemetry` opened the HTTP request
 * span, Effect opened the route span, and only a shared global provider could
 * put them in one trace. Sharing that provider meant sharing OpenTelemetry's
 * *global context*, and `@effect/opentelemetry`'s tracer published Effect's
 * current span into it on every fiber step without ever clearing it when the
 * span ended.
 *
 * That single mutable pointer produced three separate production incidents: a
 * never-ending span that stayed ambient for 12.7 hours and fused 66,005 records
 * into one trace; a *finished* span that `getActiveSpan()` kept returning, which
 * adopted 268 requests across six routes; and Bun handing every request callback
 * the async context captured when the listener was bound, which put 272 requests
 * under one span. Each fix was a guard on the symptom.
 *
 * The bridge existed to let third-party OpenTelemetry instrumentation attach to
 * Effect spans — and auto-instrumentation was deliberately disabled here, so it
 * was never used. `OtlpTracer.make` takes an optional `context` hook, which is
 * the only mechanism by which a tracer publishes into a foreign global context.
 * **Omitting it is the fix**: nothing reads or writes ambient trace state, so
 * there is no ambient state to inherit by accident. Inbound trace context is
 * parsed from the request header and passed as an explicit parent instead —
 * see `observability/traceparent.ts` and `http/effect-route.ts`.
 *
 * Traces and logs are JSON; metrics are protobuf, which Axiom requires on
 * `/v1/metrics` while rejecting it elsewhere. Metrics also carry a different
 * dataset header, so they cannot share an exporter regardless.
 */
function signalHeaders(telemetry: TelemetryConfig): Record<string, string> {
  return {
    authorization: `Bearer ${Redacted.value(telemetry.axiomToken)}`,
    'x-axiom-dataset': telemetry.axiomDataset,
  };
}

function telemetryResource(telemetry: TelemetryConfig) {
  return {
    serviceName: SERVICE_NAME,
    serviceVersion: merkurVersion(),
    // A resource attribute, not a span attribute, but written as a literal so
    // `check:span-attributes` can read it rather than skip a computed key.
    attributes: spanAttributes({
      'deployment.environment.name': telemetry.environment,
      'service.instance.id': SERVICE_INSTANCE_ID,
    }),
  };
}

/**
 * The tracer alone, without the log and metric exporters.
 *
 * It takes the constructed `Tracer` rather than building its own, because
 * building the layer twice would create a second batch queue and a second
 * flush against one endpoint.
 */
export function telemetryTracerLayer(config: ServerConfig, telemetry: TelemetryConfig) {
  return Layer.effect(
    Tracer.Tracer,
    Effect.map(
      OtlpTracer.make({
        url: `${telemetry.axiomEndpoint}/v1/traces`,
        headers: signalHeaders(telemetry),
        resource: telemetryResource(telemetry),
        exportInterval: SPAN_EXPORT_INTERVAL,
        shutdownTimeout: SHUTDOWN_TIMEOUT,
        // `context` is deliberately absent. See the note above: supplying it is
        // what published Effect's current span into OpenTelemetry's global context
        // and made every finished span ambient until the next one replaced it.
      }),
      // The OTLP tracer becomes the *inner* tracer: it still allocates ids and
      // serializes, but the decision to export moves to trace end. See
      // `tail-sampling-tracer.ts`.
      (inner) =>
        makeTailSamplingTracer(inner, {
          slowThresholdMs: config.traceSlowThresholdMs,
          ratio: config.traceSampleRatio,
          onDecision: (decision) => {
            // Synchronous because a tracer callback has no fiber to run an Effect in.
            traceSamplingFrequency.updateUnsafe(decision, Context.empty());
          },
        }),
    ),
  ).pipe(
    // `layerFlusher` must be provided exactly once across all signals; its own
    // comment warns that duplicating it gives one registry per signal and a
    // `flush` that does not drain everything.
    Layer.provide(OtlpExporter.layerFlusher),
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  );
}

function enabledTelemetryLayer(config: ServerConfig, telemetry: TelemetryConfig) {
  const resource = telemetryResource(telemetry);

  return Layer.mergeAll(
    telemetryTracerLayer(config, telemetry),
    OtlpLogger.layer({
      url: `${telemetry.axiomEndpoint}/v1/logs`,
      headers: signalHeaders(telemetry),
      resource,
      // Keeps the stdout JSON logger installed by `MerkurLoggerLayer` so the
      // platform log stream is unchanged.
      mergeWithExisting: true,
    }).pipe(Layer.provide(OtlpSerialization.layerJson)),
    OtlpMetrics.layer({
      url: `${telemetry.axiomEndpoint}/v1/metrics`,
      headers: {
        authorization: `Bearer ${Redacted.value(telemetry.axiomToken)}`,
        'x-axiom-metrics-dataset': telemetry.axiomMetricsDataset,
      },
      resource,
      temporality: 'cumulative',
      exportInterval: METRICS_EXPORT_INTERVAL,
    }).pipe(Layer.provide(OtlpSerialization.layerProtobuf)),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

/**
 * Telemetry, selected once at layer construction.
 *
 * With no Axiom configuration the spans are printed to stdout as a tree rather
 * than discarded. Previously this branch installed nothing, so `Effect.withSpan`
 * ran against the default no-op tracer and no local run could show whether a
 * span had the parent the code intended — which is exactly the property the
 * three incidents above turned on.
 *
 * The sampling threshold is applied in both branches, so stdout and OTLP never
 * disagree about which spans exist.
 */
export const TelemetryLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfigService;
    const signals =
      config.telemetry === undefined
        ? SpanTreeTracerLayer
        : enabledTelemetryLayer(config, config.telemetry);

    return Layer.mergeAll(signals, Layer.succeed(Tracer.MinimumTraceLevel, config.traceLevel));
  }),
);
