import '@merkur/shared/e2e-wasm-bun';
/**
 * Server cost of a signed daemon HTTP request, and how many the fleet sends.
 *
 * An idle linked daemon sends two kinds of signed HTTP request in steady
 * state: `POST /api/daemon/perf` every 60 s (`DEFAULT_REPORT_INTERVAL` in
 * `daemon-perf-reporter.ts`) and `POST /api/daemon/traces` whenever its OTLP
 * tracer has a finished `Info` span to export. The only periodic daemon span is
 * `daemon.health.snapshot` (`runDaemonObservabilityReporterEffect`, every 30 s,
 * default `Info` level against the daemon's `Info` `MinimumTraceLevel`), so an
 * idle daemon exports one trace batch every 30 s.
 *
 * Every such request runs `authorizeDaemonRequest`: a rate-limit consume, an
 * ML-DSA-87 and a P-256 signature verification, a Redis `SET NX` replay claim,
 * then the route's own rate-limit consume. This drives the production
 * `telemetryRoutesPlugin` with real signatures (the software daemon key the
 * server's own fixtures use), a counting Redis double and a counting rate
 * limiter, and reports per request: wall time (p50/p95), JS cells, Redis
 * round trips and signature verifications. It also times the verification
 * alone, and the software signing a daemon without a hardware key performs.
 */
import { fullGC, heapStats } from 'bun:jsc';

import {
  daemonHttpProofHeaders,
  deriveSessionAuthorizationKeyPair,
  deriveSoftwareDaemonP256PublicKey,
  signDaemonProof,
  verifyDaemonProof,
} from '@merkur/auth';
import { Effect, Layer, Metric } from 'effect';

import { percentile, perfEnvInteger } from '../../../scripts/perf/harness';
import { type ServerConfig, ServerConfigService } from '../src/config';
import { ApiModels } from '../src/http/api-models';
import { telemetryRoutesPlugin } from '../src/http/routes/telemetry-routes';
import { createLogger } from '../src/logger';
import type { runServerProgram } from '../src/runtime';
import { type DeviceService, DeviceServiceTag } from '../src/services/device-service';
import { RateLimitServiceTag } from '../src/services/rate-limit-service';
import { type RedisService, RedisServiceTag } from '../src/services/redis-service';

const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 30);
const OPS_PER_SAMPLE = perfEnvInteger('BENCH_OPS', 10);
const WARMUP_OPS = perfEnvInteger('BENCH_WARMUP_OPS', 30);
const ALLOCATION_OPS = perfEnvInteger('BENCH_ALLOCATION_OPS', 20);
const ORIGIN = 'http://127.0.0.1';
const DAEMON_ID = 'daemon-1';
const SEED = Buffer.alloc(32, 0x22).toString('base64url');
const PUBLIC_KEY = Buffer.from(
  deriveSessionAuthorizationKeyPair(Buffer.from(SEED, 'base64url')).verifyKey,
).toString('base64url');
const P256_PUBLIC_KEY = Buffer.from(
  deriveSoftwareDaemonP256PublicKey(Buffer.from(SEED, 'base64url')),
).toString('base64url');

/** Periodic signed requests per daemon per hour, from the intervals above. */
const TRACE_EXPORTS_PER_HOUR = 3_600 / 30;
const PERF_REPORTS_PER_HOUR = 3_600 / 60;

const counters = { redisCommands: 0, rateLimitConsumes: 0, verifications: 0 };

const unused = () => Effect.die(new Error('bench: unexpected service call'));

const devices: DeviceService = {
  listDevices: unused,
  getDevice: unused,
  createLinkToken: unused,
  resolveBox: unused,
  listAccountBoxes: unused,
  getDaemonSessionIdentity: unused,
  renameDevice: unused,
  deleteDevice: unused,
  touchDaemon: unused,
  touchDaemonsSeen: unused,
  authenticateDaemonProof: (id, transcript, signature, purpose, p256Signature) =>
    Effect.sync(() => {
      counters.verifications += 1;
      return id === DAEMON_ID &&
        verifyDaemonProof(
          PUBLIC_KEY,
          P256_PUBLIC_KEY,
          purpose,
          transcript,
          signature,
          p256Signature,
        )
        ? { daemonId: id, userId: 'user-1', boxId: null }
        : null;
    }),
};

const redis: RedisService = {
  useCommands: (fn) =>
    Effect.promise(async () =>
      fn({
        async sendCommand<T>(): Promise<T> {
          counters.redisCommands += 1;
          return 'OK' as T;
        },
      }),
    ),
  publish: unused,
  subscribe: unused,
  unsubscribe: unused,
  healthSnapshot: unused,
};

const config = {
  publicOrigin: ORIGIN,
  // Unconfigured export: the route authenticates, rate-limits and then
  // discards, so the measurement is the server's own work and no forward.
  telemetry: undefined,
} as unknown as ServerConfig;

const layer = Layer.mergeAll(
  Layer.succeed(ServerConfigService, config),
  Layer.succeed(DeviceServiceTag, devices),
  Layer.succeed(RedisServiceTag, redis),
  Layer.succeed(RateLimitServiceTag, {
    consume: () =>
      Effect.sync(() => {
        counters.rateLimitConsumes += 1;
        return { allowed: true } as const;
      }),
  }),
  Layer.succeed(Metric.MetricRegistry, new Map()),
);
const runProgram = ((program, runOptions) =>
  Effect.runPromise(
    Effect.provide(program as Effect.Effect<unknown, unknown, never>, layer),
    runOptions,
  )) as typeof runServerProgram;

const app = telemetryRoutesPlugin({
  runServerProgram: runProgram,
  authorizeRequest: async () => null,
  logger: createLogger('daemon-requests-bench'),
});

/** One `daemon.health.snapshot` span as Effect's OTLP JSON serializer shapes it. */
const TRACE_BODY = JSON.stringify({
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'merkur-daemon' } },
          { key: 'service.version', value: { stringValue: '0.57.1' } },
        ],
        droppedAttributesCount: 0,
      },
      scopeSpans: [
        {
          scope: { name: 'merkur-daemon' },
          spans: [
            {
              traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
              spanId: '00f067aa0ba902b7',
              name: 'daemon.health.snapshot',
              kind: 1,
              startTimeUnixNano: '1758240000000000000',
              endTimeUnixNano: '1758240000000350000',
              attributes: [],
              droppedAttributesCount: 0,
              events: [],
              droppedEventsCount: 0,
              status: { code: 1 },
              links: [],
              droppedLinksCount: 0,
            },
          ],
        },
      ],
    },
  ],
});

const PERF_BODY = JSON.stringify(
  Object.fromEntries(
    Object.keys(ApiModels.DaemonPerfReportBody.properties).map((key) => [
      key,
      key === 'windowMs' ? 60_000 : key === 'controlPingPonged' ? 30 : 0,
    ]),
  ),
);

async function signedRequest(path: string, body: string): Promise<Request> {
  const bytes = new TextEncoder().encode(body);
  const url = `${ORIGIN}${path}`;
  const headers = await daemonHttpProofHeaders(
    DAEMON_ID,
    async (transcript) => signDaemonProof(SEED, 'http', transcript),
    'POST',
    url,
    'application/json',
    bytes,
    Date.now(),
  );
  return new Request(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: bytes,
  });
}

/** Requests are signed ahead of time; only the server's handling is timed. */
async function presign(path: string, body: string, count: number): Promise<Request[]> {
  const requests: Request[] = [];
  for (let index = 0; index < count; index += 1) requests.push(await signedRequest(path, body));
  return requests;
}

async function serve(request: Request): Promise<void> {
  const response = await app.handle(request);
  if (response.status !== 204) throw new Error(`bench: route answered ${response.status}`);
}

function liveCells(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

/** Cells per request, or NaN when a collection ran inside the window (reported, not hidden). */
async function cellsPerRequest(requests: readonly Request[]): Promise<number> {
  fullGC();
  const survivors = heapStats().objectCount;
  const before = liveCells();
  for (const request of requests) await serve(request);
  const after = liveCells();
  return heapStats().objectCount === survivors ? (after - before) / requests.length : Number.NaN;
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function measureRoute(label: string, path: string, body: string) {
  for (const request of await presign(path, body, WARMUP_OPS)) await serve(request);
  const before = { ...counters };
  const counted = await presign(path, body, ALLOCATION_OPS);
  const cells = await cellsPerRequest(counted);
  const counts = {
    redis: (counters.redisCommands - before.redisCommands) / ALLOCATION_OPS,
    rateLimit: (counters.rateLimitConsumes - before.rateLimitConsumes) / ALLOCATION_OPS,
    verifications: (counters.verifications - before.verifications) / ALLOCATION_OPS,
  };
  const times: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const requests = await presign(path, body, OPS_PER_SAMPLE);
    const startedAt = Bun.nanoseconds();
    for (const request of requests) await serve(request);
    times.push((Bun.nanoseconds() - startedAt) / OPS_PER_SAMPLE);
  }
  write(
    `   ${label.padEnd(18)} body=${Buffer.byteLength(body)} B  us/request p50=${(percentile(times, 0.5) / 1_000).toFixed(0)} ` +
      `p95=${(percentile(times, 0.95) / 1_000).toFixed(0)}  cells/request=${cells.toFixed(0)}  ` +
      `redis=${counts.redis.toFixed(2)} rate-limit=${counts.rateLimit.toFixed(2)} ` +
      `verifications=${counts.verifications.toFixed(2)} (n=${SAMPLES}x${OPS_PER_SAMPLE})`,
  );
  return percentile(times, 0.5);
}

async function measureCrypto(): Promise<void> {
  const transcript = new TextEncoder().encode('bench transcript');
  const signature = signDaemonProof(SEED, 'http', transcript);
  const verify: number[] = [];
  const sign: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    let startedAt = Bun.nanoseconds();
    if (
      !verifyDaemonProof(
        PUBLIC_KEY,
        P256_PUBLIC_KEY,
        'http',
        transcript,
        signature.mldsa,
        signature.p256,
      )
    ) {
      throw new Error('bench: signature did not verify');
    }
    verify.push(Bun.nanoseconds() - startedAt);
    startedAt = Bun.nanoseconds();
    signDaemonProof(SEED, 'http', transcript);
    sign.push(Bun.nanoseconds() - startedAt);
  }
  write(
    `   verifyDaemonProof  us p50=${(percentile(verify, 0.5) / 1_000).toFixed(0)} p95=${(percentile(verify, 0.95) / 1_000).toFixed(0)} ` +
      `(ML-DSA-87 + P-256, packages/auth, n=${SAMPLES})`,
  );
  write(
    `   signDaemonProof    us p50=${(percentile(sign, 0.5) / 1_000).toFixed(0)} p95=${(percentile(sign, 0.95) / 1_000).toFixed(0)} ` +
      `(software key in JS; a linked daemon signs ML-DSA in Rust and P-256 in its hardware key, n=${SAMPLES})`,
  );
}

write(`daemon request benchmark: samples=${SAMPLES}, ops/sample=${OPS_PER_SAMPLE}`);
write('1. signed daemon requests through the production routes');
const traceUs =
  (await measureRoute('/api/daemon/traces', '/api/daemon/traces', TRACE_BODY)) / 1_000;
const perfUs = (await measureRoute('/api/daemon/perf', '/api/daemon/perf', PERF_BODY)) / 1_000;
write('2. signature work per request');
await measureCrypto();
const perDaemonHourMs = (traceUs * TRACE_EXPORTS_PER_HOUR + perfUs * PERF_REPORTS_PER_HOUR) / 1_000;
write(
  `3. idle daemon: ${TRACE_EXPORTS_PER_HOUR} trace exports + ${PERF_REPORTS_PER_HOUR} perf reports per hour ` +
    `= ${perDaemonHourMs.toFixed(0)} ms server CPU per daemon-hour (p50), ` +
    `${((perDaemonHourMs / 3_600_000) * 1_000 * 100).toFixed(2)}% of one core per 1,000 daemons`,
);
