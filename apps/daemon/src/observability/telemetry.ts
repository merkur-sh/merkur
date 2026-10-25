import type { DaemonConfig } from '@merkur/config';
import { merkurVersion } from '@merkur/shared';
import { Effect, Exit, Layer, Option, Scope, Semaphore, SubscriptionRef, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { OtlpExporter, OtlpSerialization, OtlpTracer } from 'effect/observability';
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
export const MINIMUM_TRACE_LEVEL = 'Info';

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
 *
 * # Consent
 *
 * Nothing is exported unless the account opted in, which the daemon learns
 * only from its control connection. Each stretch of reporting being on is an
 * export period with its own exporter, and every export a period makes waits on
 * the period's gate before it is signed or sent. The first period opens with
 * the process and its gate stays shut until the first `registered` states the
 * account's choice, so spans from startup are held, then sent or discarded.
 * Turning reporting off aborts the period's request in flight, refuses its
 * final flush and closes it; spans begun while off go to the native tracer.
 */
export interface DaemonTelemetry {
  /** Installed as `Tracer.Tracer` for the daemon runtime. */
  readonly tracer: Tracer.Tracer;
  /** Whether the account's consent is on, as the control connection last stated it. */
  readonly enabled: SubscriptionRef.SubscriptionRef<boolean>;
  /** Applies the control connection's statement of the account's consent. */
  readonly set: (enabled: boolean) => Effect.Effect<void>;
  /** Shutdown: a period that is on delivers its final flush; nothing opens afterwards. */
  readonly retire: Effect.Effect<void>;
}

interface ExportPeriod {
  readonly scope: Scope.Closeable;
  readonly tracer: Tracer.Tracer;
  readonly controller: AbortController;
  readonly resolveGate: (enabled: boolean) => void;
  pending: boolean;
}

export const createDaemonTelemetryScoped = Effect.fnUntraced(function* (
  config: DaemonConfig,
  signer: DaemonProofSigner,
): Effect.fn.Return<DaemonTelemetry, never, Scope.Scope> {
  const enabled = yield* SubscriptionRef.make(false);
  const lock = yield* Semaphore.make(1);
  const signedFetch = createDaemonFetch(config, signer);
  let retired = false;

  const openPeriod = Effect.fnUntraced(function* (pending: boolean) {
    const scope = yield* Scope.make();
    const controller = new AbortController();
    const { promise: gate, resolve: resolveGate } = Promise.withResolvers<boolean>();
    if (!pending) resolveGate(true);
    const fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (!(await gate) || controller.signal.aborted) {
          throw new DOMException('Telemetry reporting is off', 'AbortError');
        }
        const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
        const signal =
          callerSignal === null
            ? controller.signal
            : AbortSignal.any([controller.signal, callerSignal]);
        signal.throwIfAborted();
        return signedFetch(input, { ...init, signal });
      },
      { preconnect: signedFetch.preconnect },
    );
    const services = yield* Layer.buildWithScope(
      Layer.mergeAll(
        OtlpExporter.layerFlusher,
        OtlpSerialization.layerJson,
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
      scope,
    );
    const tracer = yield* OtlpTracer.make({
      url: `${config.server_origin}/api/daemon/traces`,
      resource: {
        serviceName: SERVICE_NAME,
        serviceVersion: merkurVersion(),
      },
      exportInterval: SPAN_EXPORT_INTERVAL,
      shutdownTimeout: SHUTDOWN_TIMEOUT,
      // Omitting context keeps finished spans out of global context.
    }).pipe(Effect.provide(services), Scope.provide(scope));
    return { scope, tracer, controller, resolveGate, pending } satisfies ExportPeriod;
  });

  let period = Option.some<ExportPeriod>(yield* openPeriod(true));
  const tracer = Tracer.make({
    span: (options) =>
      (Option.isSome(period) ? period.value.tracer : Tracer.nativeTracer).span(options),
  });
  const set = (value: boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (retired) return;
      if (value) {
        if (Option.isSome(period)) {
          if (!period.value.pending) return;
          period.value.pending = false;
          period.value.resolveGate(true);
        } else {
          period = Option.some(yield* openPeriod(false));
        }
        yield* SubscriptionRef.set(enabled, true);
      } else if (Option.isSome(period)) {
        const previous = period.value;
        period = Option.none();
        previous.resolveGate(false);
        previous.controller.abort();
        yield* SubscriptionRef.set(enabled, false);
        // The same gate refuses the scope's final flush and drops its partial batch.
        yield* Scope.close(previous.scope, Exit.void);
      }
    }).pipe(Effect.uninterruptible, lock.withPermit);

  const retire = Effect.gen(function* () {
    if (retired) return;
    retired = true;
    if (Option.isNone(period)) return;
    const previous = period.value;
    period = Option.none();
    if (previous.pending) {
      previous.resolveGate(false);
      previous.controller.abort();
    }
    // An enabled period closes while the signer is bound, delivering its final batch.
    yield* Scope.close(previous.scope, Exit.void);
    previous.controller.abort();
  }).pipe(Effect.uninterruptible, lock.withPermit);
  yield* Effect.addFinalizer(() => retire);
  return { tracer, enabled, set, retire };
}, Effect.uninterruptible);
