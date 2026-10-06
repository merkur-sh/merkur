import type { DaemonConfig } from '@merkur/config';
import { merkurVersion } from '@merkur/shared';
import { Layer, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { OtlpSerialization, OtlpTracer } from 'effect/unstable/observability';
import { createDaemonFetch } from '../services/daemon-fetch';
import type { DaemonProofSigner } from '../services/daemon-proof-signer';

const SERVICE_NAME = 'merkur-daemon';
const SPAN_EXPORT_INTERVAL = '5 seconds';
const SHUTDOWN_TIMEOUT = '3 seconds';

/**
 * Spans below this level are never sampled.
 *
 * A constant rather than a config field. The daemon's configuration lives in
 * `~/.merkur/config.json`, so making this settable would mean a re-link to
 * change it, and there is no operator sitting at a user's machine to change it
 * anyway. The server-side threshold is the one that is worth turning.
 */
const MINIMUM_TRACE_LEVEL = 'Info';

/**
 * Daemon span export.
 *
 * # Why this points at the Merkur server, not at Axiom
 *
 * A daemon runs on a user's machine. Shipping it a vendor ingest token would
 * put a fleet-wide write credential on every laptop, and would add a second
 * outbound destination to a process whose entire network surface is otherwise
 * the Merkur server and the edge.
 *
 * So the daemon exports OTLP to `POST /api/daemon/traces`, authenticated with
 * the credentials it already holds, and the server forwards. This is exactly
 * the argument `docs/observability.md` already makes for browser profiling
 * rows: "the server's only job here is to hold the Axiom token, which must
 * never reach a browser."
 *
 * What crosses the boundary is the same closed set of span attributes the rest
 * of the repo may set, enforced at build time by `check:span-attributes`. No
 * terminal content, no free-text field, no user identity.
 */
export function daemonTracerLayer(
  config: DaemonConfig,
  signer: DaemonProofSigner,
): Layer.Layer<never> {
  return Layer.mergeAll(
    OtlpTracer.layer({
      url: `${config.server_origin}/api/daemon/traces`,
      resource: {
        serviceName: SERVICE_NAME,
        serviceVersion: merkurVersion(),
      },
      exportInterval: SPAN_EXPORT_INTERVAL,
      shutdownTimeout: SHUTDOWN_TIMEOUT,
      // `context` deliberately omitted, as on the server: supplying it is what
      // publishes the current span into a global context that outlives it.
    }).pipe(
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, createDaemonFetch(config, signer))),
        ),
      ),
    ),
    Layer.succeed(Tracer.MinimumTraceLevel, MINIMUM_TRACE_LEVEL),
  );
}
