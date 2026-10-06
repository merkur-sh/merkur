import { createDeviceEventsSseLifetime } from '../src/http/sse';
import '@merkur/shared/e2e-wasm-bun';
/**
 * Boots the composed server app with telemetry enabled and checks that traces,
 * logs and metrics leave the process the way Axiom requires them.
 *
 * By default it exports to a throwaway in-process OTLP sink and asserts the
 * wire contract locally. Point it at the real thing to verify credentials:
 *
 *   AXIOM_TOKEN=xaat-... AXIOM_DATASET=merkur AXIOM_METRICS_DATASET=merkur-metrics \
 *     bun run --cwd apps/server telemetry:smoke
 *
 * The assertions that matter and are easy to get wrong: metrics go to a
 * *different* dataset header than traces and logs, and Axiom accepts only
 * protobuf on /v1/metrics.
 */
import { deriveSessionAuthorizationKeyPair } from '@merkur/auth';
import { Effect, Layer, ManagedRuntime, Metric, Redacted } from 'effect';

import { type ServerConfig, ServerConfigService, type TelemetryConfig } from '../src/config';
import { createServerApp } from '../src/http/server-app';
import { createLogger } from '../src/logger';
import { createAuthorizeRequest } from '../src/middleware/authenticated-user';
import {
  merkurMetricsSnapshot,
  serverReadyGauge,
  traceSamplingFrequency,
} from '../src/observability/metrics';
import { TelemetryLive } from '../src/observability/telemetry';
import type { runServerProgram } from '../src/runtime';
import { type AuthService, AuthServiceTag } from '../src/services/auth-service';
import {
  type HealthService,
  HealthServiceTag,
  type ServerHealthSnapshot,
} from '../src/services/health-service';

const SPAN_FLUSH_WAIT_MS = 2_600;
const SHUTDOWN_WAIT_MS = 400;
const EXPECTED_SPANS = ['health.ready'];

/**
 * The specification's own example, sent as an inbound `traceparent`.
 *
 * The old assertion here was "elysia and effect spans share one trace", a
 * property that only existed because two span systems had to be reconciled
 * through a shared global provider. There is one system now.
 *
 * What replaces it is the opposite property, on the one route that must refuse
 * inbound context: health spans declare `{ root: true }` so a platform prober
 * cannot attach a liveness poll to somebody else's trace. Adoption itself is
 * asserted against the real route funnel in
 * `src/observability/trace-topology.test.ts`.
 */
const INBOUND_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const INBOUND_TRACEPARENT = `00-${INBOUND_TRACE_ID}-b7ad6b7169203331-01`;

interface Capture {
  readonly path: string;
  readonly contentType: string | null;
  readonly authorization: string | null;
  readonly dataset: string | null;
  readonly metricsDataset: string | null;
  readonly spanNames: string[];
  readonly traceIds: string[];
  readonly logBodies: string[];
  readonly instanceIds: string[];
  readonly raw: Uint8Array;
  upstreamStatus?: number;
  upstreamBody?: string;
}

const captures: Capture[] = [];

function collectJsonSignal(capture: Capture, payload: Record<string, unknown>): void {
  const signals = [
    ...((payload.resourceSpans ?? []) as Array<Record<string, unknown>>),
    ...((payload.resourceLogs ?? []) as Array<Record<string, unknown>>),
  ];
  for (const signal of signals) {
    const resource = signal.resource as
      | { attributes?: Array<{ key: string; value?: { stringValue?: string } }> }
      | undefined;
    for (const attribute of resource?.attributes ?? []) {
      if (attribute.key === 'service.instance.id' && attribute.value?.stringValue !== undefined) {
        capture.instanceIds.push(attribute.value.stringValue);
      }
    }
  }
  for (const resourceSpan of (payload.resourceSpans ?? []) as Array<Record<string, unknown>>) {
    for (const scopeSpan of (resourceSpan.scopeSpans ?? []) as Array<Record<string, unknown>>) {
      for (const span of (scopeSpan.spans ?? []) as Array<{ name: string; traceId: string }>) {
        capture.spanNames.push(span.name);
        capture.traceIds.push(span.traceId);
      }
    }
  }
  for (const resourceLog of (payload.resourceLogs ?? []) as Array<Record<string, unknown>>) {
    for (const scopeLog of (resourceLog.scopeLogs ?? []) as Array<Record<string, unknown>>) {
      for (const record of (scopeLog.logRecords ?? []) as Array<{
        body?: { stringValue?: string };
      }>) {
        capture.logBodies.push(record.body?.stringValue ?? '');
      }
    }
  }
}

/**
 * Upstream to forward to, or `undefined` to answer locally.
 *
 * The app always exports to this sink, never straight to Axiom. In live mode
 * the sink forwards each request onward unchanged and returns Axiom's own
 * status, so one run both asserts the wire contract and actually delivers.
 * Pointing the app at Axiom directly would make every assertion here blind,
 * which reads as a failure even when the export succeeded.
 */
const forwardTo = process.env.AXIOM_TOKEN === undefined ? undefined : axiomEndpoint();

function axiomEndpoint(): string {
  return (process.env.AXIOM_ENDPOINT ?? 'https://api.axiom.co').replace(/\/+$/, '');
}

const sink = Bun.serve({
  port: 0,
  async fetch(request) {
    const contentType = request.headers.get('content-type');
    const raw = await request.arrayBuffer();
    const capture: Capture = {
      path: new URL(request.url).pathname,
      contentType,
      authorization: request.headers.get('authorization'),
      dataset: request.headers.get('x-axiom-dataset'),
      metricsDataset: request.headers.get('x-axiom-metrics-dataset'),
      spanNames: [],
      traceIds: [],
      logBodies: [],
      instanceIds: [],
      raw: new Uint8Array(raw),
    };
    if (contentType?.includes('json') === true) {
      collectJsonSignal(
        capture,
        JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>,
      );
    }
    captures.push(capture);

    if (forwardTo === undefined) {
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }
    // Only the headers Axiom needs. Replaying the inbound set would carry
    // `host` and `content-length` for this sink, which the upstream rejects.
    const forwardHeaders: Record<string, string> = {};
    for (const name of [
      'authorization',
      'content-type',
      'x-axiom-dataset',
      'x-axiom-metrics-dataset',
    ]) {
      const value = request.headers.get(name);
      if (value !== null) forwardHeaders[name] = value;
    }
    try {
      const upstream = await fetch(`${forwardTo}${capture.path}`, {
        method: 'POST',
        headers: forwardHeaders,
        body: raw,
      });
      capture.upstreamStatus = upstream.status;
      capture.upstreamBody = (await upstream.text()).slice(0, 200);
      return new Response(capture.upstreamBody, { status: upstream.status });
    } catch (error) {
      capture.upstreamStatus = 0;
      capture.upstreamBody = String(error).slice(0, 200);
      return new Response('{}', { status: 500 });
    }
  },
});

// Credentials and dataset names are the real ones in live mode, so the header
// assertions below check exactly what production would send; only the host is
// swapped for the sink, which forwards onward.
const telemetry: TelemetryConfig = {
  axiomToken: Redacted.make(process.env.AXIOM_TOKEN ?? 'xaat-smoke-token'),
  axiomDataset: process.env.AXIOM_DATASET ?? 'merkur-traces',
  axiomMetricsDataset: process.env.AXIOM_METRICS_DATASET ?? 'merkur-metrics',
  axiomPerfDataset: process.env.AXIOM_PERF_DATASET ?? 'merkur-perf',
  axiomEndpoint: `http://localhost:${sink.port}`,
  environment: process.env.TELEMETRY_ENVIRONMENT ?? 'smoke',
};

const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  dbUrl: ':memory:',
  dbAuthToken: undefined,
  redisUrl: Redacted.make('redis://127.0.0.1:6379'),
  publicOrigin: 'https://merkur.test',
  website: undefined,
  accessTokenHmacKey: new Uint8Array(64),
  jwtIssuer: 'merkur',
  jwtAudience: 'merkur-clients',
  tokenHmacSecret: Redacted.make('x'.repeat(32)),
  authAllowRegistration: true,
  authIdentity: 'username',
  emailDelivery: undefined,
  trustedProxyHops: 1,
  sessionTokenSigningKey: deriveSessionAuthorizationKeyPair(new Uint8Array(32)).signingKey,
  sessionTokenVerifyKeyB64: 'A'.repeat(3_456),
  sessionTokenTtlMs: 60_000,
  webPush: undefined,
  edgeRegistrationKeys: new Map(),
  opaqueServerSetup: Redacted.make(Buffer.alloc(128).toString('base64url')),
  opaqueServerPublicKey: Buffer.alloc(32).toString('base64url'),
  stunTicketKey: new Uint8Array(32),
  edgeAttachTicketKey: new Uint8Array(64).fill(11),
  stunServers: [],
  boxHostStunObservers: [],
  boxHost: undefined,

  telemetry,
  // `Debug` rather than the production `Info`: the health-route spans this
  // probe uses are declared at `Debug` precisely so they stay out of production
  // traces, and an unsampled span is never exported — so at `Info` this smoke
  // test would assert on a span that correctly does not exist.
  traceLevel: 'Debug',
  traceSampleRatio: 1,
  traceSlowThresholdMs: 1_000,
};

const health: HealthService = {
  snapshot: Effect.succeed({
    status: 'ready' as const,
    ready: true,
    checkedAt: 0,
    components: {} as ServerHealthSnapshot['components'],
  }),
  markHealthy: () => Effect.void,
  markUnhealthy: () => Effect.void,
  updateComponents: () => Effect.void,
};

// Every member dies: this probe exercises the telemetry pipeline, and any auth
// call reaching here would mean the probe is testing something else.
const unused = () => Effect.die(new Error('unused by the telemetry smoke probe'));
const auth: AuthService = {
  startAuth: unused,
  requestEmailCode: unused,
  finishRegistration: unused,
  finishLogin: unused,
  changePassword: unused,
  requestPasswordResetCode: unused,
  verifyPasswordResetCode: unused,
  startPasswordReset: unused,
  finishPasswordReset: unused,
  refresh: unused,
  logout: unused,
  verifyBearerToken: () => Effect.succeed(null),
  listBrowserSessions: unused,
  revokeBrowserSessions: unused,
  requireActiveDelegation: unused,
  scheduleAccountDeletion: unused,
  accountsDueForDeletion: unused,
  purgeAccount: unused,
};

const runtime = ManagedRuntime.make(
  Layer.mergeAll(Layer.succeed(HealthServiceTag, health), Layer.succeed(AuthServiceTag, auth)).pipe(
    Layer.provideMerge(TelemetryLive),
    Layer.provideMerge(Layer.succeed(ServerConfigService, config)),
  ),
);
// Cast through `unknown`: this probe provides only the two services its one
// route needs, which is a strictly narrower context than `ServerRuntimeContext`.
// Widening the fakes to the full runtime would mean standing up Redis and
// SQLite to assert an OTLP wire contract.
const runProgram = ((
  program: Effect.Effect<unknown, unknown, never>,
  options?: Effect.RunOptions,
) => runtime.runPromise(program, options)) as unknown as typeof runServerProgram;

// Forces the layer — and with it the OTLP exporter's scope — to be built
// before any request arrives.
await runtime.runPromise(Effect.void);

const app = createServerApp({
  deviceEventsLifetime: createDeviceEventsSseLifetime(),
  config,
  runServerProgram: runProgram,
  authorizeRequest: createAuthorizeRequest(runProgram),
  logger: createLogger('telemetry-smoke'),
  webIndexFile: '/nonexistent/index.html',
  webDistDirectory: '/nonexistent',
});

await app.listen(0);
const response = await fetch(`http://localhost:${app.server?.port}/health/ready`, {
  headers: { traceparent: INBOUND_TRACEPARENT },
});
/**
 * The tail sampler's decision, read out of the live registry.
 *
 * Spans reaching the sink already prove the sampler is in the export path, but not that its
 * *policy* ran — a tracer that ignored the policy entirely would look identical. One
 * recorded decision per finished trace is the evidence that it did.
 */
let samplingDecisions = 0;
await runtime.runPromise(
  Effect.gen(function* () {
    yield* Effect.log('telemetry_smoke_probe').pipe(Effect.annotateLogs('scope', 'smoke'));
    yield* Metric.update(serverReadyGauge, 1);
    const snapshots = yield* merkurMetricsSnapshot;
    const sampling = snapshots.find((candidate) => candidate.id === traceSamplingFrequency.id);
    const occurrences = (sampling?.state as { occurrences?: Record<string, number> } | undefined)
      ?.occurrences;
    samplingDecisions = Object.values(occurrences ?? {}).reduce((sum, count) => sum + count, 0);
  }),
);

await Bun.sleep(SPAN_FLUSH_WAIT_MS);
await app.stop();
await runtime.dispose();
await Bun.sleep(SHUTDOWN_WAIT_MS);
sink.stop();

const traces = captures.find((capture) => capture.path === '/v1/traces');
const logs = captures.find((capture) => capture.path === '/v1/logs');
const metrics = captures.find((capture) => capture.path === '/v1/metrics');
const distinctTraceIds = new Set(traces?.traceIds ?? []);
const expectedAuthorization = `Bearer ${Redacted.value(telemetry.axiomToken)}`;
const instanceIds = new Set(captures.flatMap((capture) => capture.instanceIds));
const instanceId = traces?.instanceIds[0];

const checks: Array<readonly [string, boolean]> = [
  [
    'traces, logs and protobuf metrics share one process resource identity',
    instanceIds.size === 1 &&
      instanceId !== undefined &&
      instanceId.length > 0 &&
      (logs?.instanceIds.includes(instanceId) ?? false) &&
      metrics !== undefined &&
      Buffer.from(metrics.raw).includes(Buffer.from(instanceId)),
  ],
  ['request served', response.status === 200],
  ['traces exported', traces !== undefined],
  ['logs exported', logs !== undefined],
  ['metrics exported', metrics !== undefined],
  ['traces authorized', traces?.authorization === expectedAuthorization],
  ['traces use x-axiom-dataset', traces?.dataset === telemetry.axiomDataset],
  ['logs use x-axiom-dataset', logs?.dataset === telemetry.axiomDataset],
  [
    'metrics use x-axiom-metrics-dataset',
    metrics?.metricsDataset === telemetry.axiomMetricsDataset,
  ],
  ['metrics sent as protobuf', metrics?.contentType?.includes('protobuf') === true],
  ['probe log exported', logs?.logBodies.includes('telemetry_smoke_probe') === true],
  ...EXPECTED_SPANS.map(
    (name) => [`span ${name}`, traces?.spanNames.includes(name) === true] as const,
  ),
  ['all spans from one request share one trace', distinctTraceIds.size === 1],
  ['tail sampling decided at least one trace', samplingDecisions > 0],
  [
    'the health span refuses an inbound traceparent',
    traces !== undefined && !traces.traceIds.includes(INBOUND_TRACE_ID),
  ],
  ...(forwardTo === undefined
    ? []
    : ([
        [
          'axiom accepted traces',
          traces?.upstreamStatus !== undefined && traces.upstreamStatus < 300,
        ],
        ['axiom accepted logs', logs?.upstreamStatus !== undefined && logs.upstreamStatus < 300],
        [
          'axiom accepted metrics',
          metrics?.upstreamStatus !== undefined && metrics.upstreamStatus < 300,
        ],
      ] as const)),
];

const logger = createLogger('telemetry-smoke');
for (const [label, ok] of checks) {
  logger.info('telemetry_smoke_check', { check: label, ok });
}
const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  logger.error('telemetry_smoke_failed', {
    failed: failed.map(([label]) => label),
    upstream: {
      traces: [traces?.upstreamStatus, traces?.upstreamBody],
      logs: [logs?.upstreamStatus, logs?.upstreamBody],
      metrics: [metrics?.upstreamStatus, metrics?.upstreamBody],
    },
  });
  process.exit(1);
}
logger.info('telemetry_smoke_passed', {
  spans: traces?.spanNames ?? [],
  forwardedTo: forwardTo ?? 'local sink only',
  upstream: {
    traces: traces?.upstreamStatus,
    logs: logs?.upstreamStatus,
    metrics: metrics?.upstreamStatus,
  },
});
