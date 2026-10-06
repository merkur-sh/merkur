import '@merkur/shared/e2e-wasm-bun';
/**
 * Server-side cost of the two browser telemetry streams.
 *
 * With profiling on, a browser posts one `/api/telemetry/perf` batch per full
 * `MAX_ROWS_PER_REQUEST` (1,000 rows, gzip NDJSON) and one
 * `/api/telemetry/link` report per transport heartbeat (2 s). Both go through
 * the production `telemetryRoutesPlugin` here, with the rate limiter stubbed
 * to allow and the Axiom endpoint pointed at a local sink that counts what it
 * receives, so every byte the route forwards is observed.
 *
 * Three measurements:
 *
 * 1. **Routes, end to end.** JS cells per request and bytes forwarded per
 *    request for the production handlers. Timing here includes a loopback
 *    HTTP forward and is reported for scale only.
 * 2. **Perf body handling, paired A/B.** The route decompresses the batch,
 *    decodes it into one JS string, splits it into an array of line strings
 *    only to count them, then forwards the decoded string, which `fetch`
 *    encodes back into UTF-8. `production` mirrors that code exactly;
 *    `bytes` counts newline bytes in the decompressed buffer and forwards the
 *    buffer; `gzip` counts the same way and forwards the original compressed
 *    bytes under `content-encoding: gzip`. Line counts are asserted equal
 *    across arms over edge-case bodies (blank lines, trailing newline, invalid
 *    UTF-8), since a non-empty byte run always decodes to a non-empty string
 *    and U+000A is never part of a multi-byte sequence.
 * 3. **`recordFrequencyCount`, paired A/B.** The production helper allocates
 *    an array of `count` labels and folds it through `Effect.forEach` into one
 *    `Metric.update` effect per occurrence; the candidate applies the same
 *    `updateUnsafe` calls inside one `Effect.contextWith`. Frequency state is
 *    asserted identical.
 *
 * The route now forwards the decompressed bytes and records frequencies in one
 * step, so sections 2 and 3 keep the replaced code as their `production` arm:
 * the production route matches the `bytes` arm and the `candidate` helper.
 *
 * Wall time comes from ABBA / BAAB rounds; cells are `heapStats()` object type
 * counts summed after a full collection, minus a control loop.
 */
import { fullGC, heapStats } from 'bun:jsc';
import { promisify } from 'node:util';
import { gunzip, gzipSync } from 'node:zlib';

import { Effect, Layer, ManagedRuntime, Metric } from 'effect';

import { percentile, perfEnvInteger } from '../../../scripts/perf/harness';
import { type ServerConfig, ServerConfigService } from '../src/config';
import { telemetryRoutesPlugin } from '../src/http/routes/telemetry-routes';
import { createLogger } from '../src/logger';
import { browserLinkPathFrequency } from '../src/observability/metrics';
import type { runServerProgram } from '../src/runtime';
import { RateLimitServiceTag } from '../src/services/rate-limit-service';

const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 30);
const OPS_PER_SAMPLE = perfEnvInteger('BENCH_OPS', 20);
const WARMUP_OPS = perfEnvInteger('BENCH_WARMUP_OPS', 200);
const ROUTE_OPS = perfEnvInteger('BENCH_ROUTE_OPS', 100);
const ROWS_PER_BATCH = 1_000;
const MAX_PERF_BODY_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

const decompressPerfBody = promisify(gunzip);

// ---------------------------------------------------------------------------
// Realistic batch: the telemetry worker stamps every row with the session id
// and build version and joins JSON rows with '\n' (apps/web/src/telemetry-worker.ts).
// ---------------------------------------------------------------------------

const KINDS = ['input_sent', 'input_ack', 'display_apply', 'render_start', 'render_end'] as const;

function perfBatch(rows: number): string {
  const lines: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    lines.push(
      JSON.stringify({
        kind: KINDS[index % KINDS.length],
        at_ms: 1_000_000 + index * 1.37,
        merkur_session_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
        merkur_version: '0.57.1',
        input_seq: index,
        display_seq: index >> 1,
        render_seq: index >> 2,
        queued_display_frames: index % 3,
        wanted_at_ms: 1_000_000 + index * 1.37 + 8.3,
        gate: index % 2 === 0 ? 'immediate' : 'vsync',
        fence_wait_ms: (index % 7) * 0.13,
        opportunity_wait_ms: (index % 5) * 0.21,
        refresh_period_ms: 8.333,
        refresh_confidence01: 0.94,
        byte_length: 96 + (index % 400),
      }),
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Perf body handling arms
// ---------------------------------------------------------------------------

interface HandledBody {
  readonly lineCount: number;
  /** What the route hands to `fetch`, already in the form that goes on the wire. */
  readonly forwardedBytes: number;
  readonly sink: number;
}

/** Mirrors `readPerfBody` plus the route's line count and forward, byte for byte. */
async function productionArm(compressed: Uint8Array): Promise<HandledBody> {
  const decoded = await decompressPerfBody(compressed, { maxOutputLength: MAX_PERF_BODY_BYTES });
  const rows = decoded.toString('utf8');
  const lineCount = rows.split('\n').filter((line) => line.length > 0).length;
  // `fetch(url, { body: rows })` encodes the string to UTF-8 before sending.
  const wire = Buffer.from(rows, 'utf8');
  return { lineCount, forwardedBytes: wire.byteLength, sink: wire[wire.byteLength - 1] ?? 0 };
}

function countNonEmptyLines(bytes: Uint8Array): number {
  let lines = 0;
  let start = 0;
  let newline = bytes.indexOf(NEWLINE, start);
  while (newline !== -1) {
    if (newline > start) lines += 1;
    start = newline + 1;
    newline = bytes.indexOf(NEWLINE, start);
  }
  if (bytes.byteLength > start) lines += 1;
  return lines;
}

/** Counts on the decompressed bytes and forwards them without a string round trip. */
async function bytesArm(compressed: Uint8Array): Promise<HandledBody> {
  const decoded = await decompressPerfBody(compressed, { maxOutputLength: MAX_PERF_BODY_BYTES });
  const lineCount = countNonEmptyLines(decoded);
  return {
    lineCount,
    forwardedBytes: decoded.byteLength,
    sink: decoded[decoded.byteLength - 1] ?? 0,
  };
}

/** Counts on the decompressed bytes and forwards the browser's own gzip bytes. */
async function gzipArm(compressed: Uint8Array): Promise<HandledBody> {
  const decoded = await decompressPerfBody(compressed, { maxOutputLength: MAX_PERF_BODY_BYTES });
  const lineCount = countNonEmptyLines(decoded);
  return {
    lineCount,
    forwardedBytes: compressed.byteLength,
    sink: compressed[compressed.byteLength - 1] ?? 0,
  };
}

function assertLineCountsAgree(): void {
  const cases: Uint8Array[] = [
    new TextEncoder().encode(''),
    new TextEncoder().encode('\n'),
    new TextEncoder().encode('\n\n{"a":1}\n\n'),
    new TextEncoder().encode('{"a":1}\n{"b":2}'),
    new TextEncoder().encode('{"a":1}\n{"b":2}\n'),
    new TextEncoder().encode('{"é":"ü"}\n\n{"💥":1}\n'),
    // Invalid UTF-8: a lone continuation byte, a truncated sequence, then a newline.
    Uint8Array.from([0x80, 0x0a, 0xe2, 0x82, 0x0a, 0x0a, 0xff]),
    new TextEncoder().encode(perfBatch(ROWS_PER_BATCH)),
  ];
  for (const bytes of cases) {
    const text = Buffer.from(bytes).toString('utf8');
    const expected = text.split('\n').filter((line) => line.length > 0).length;
    const actual = countNonEmptyLines(bytes);
    if (actual !== expected) {
      throw new Error(
        `bench: line counts disagree (${actual} vs ${expected}) for ${bytes.length} B`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// recordFrequencyCount arms
// ---------------------------------------------------------------------------

type Frequency = Metric.Metric<string, Metric.FrequencyState>;

/** Byte-for-byte copy of the private helper in telemetry-routes.ts. */
function recordFrequencyCountProduction(
  frequency: Frequency,
  label: string,
  count: number,
): Effect.Effect<void> {
  if (count <= 0) {
    return Effect.void;
  }
  return Effect.forEach(
    Array.from({ length: count }, () => label),
    (value) => Metric.update(frequency, value),
    { discard: true },
  );
}

function recordFrequencyCountCandidate(
  frequency: Frequency,
  label: string,
  count: number,
): Effect.Effect<void> {
  if (count <= 0) {
    return Effect.void;
  }
  return Effect.contextWith((context) =>
    Effect.sync(() => {
      for (let index = 0; index < count; index += 1) frequency.updateUnsafe(label, context);
    }),
  );
}

/** The eight labelled counts one link report records (one sample, relay, ready). */
const LINK_REPORT_COUNTS: ReadonlyArray<readonly [string, number]> = [
  ['direct', 0],
  ['relay', 1],
  ['unknown', 0],
  ['connecting', 0],
  ['ready', 1],
  ['reconnecting', 0],
  ['dormant', 0],
  ['closed', 0],
];
/** The daemon perf report's pong count over its 60 s window at a 2 s ping. */
const DAEMON_REPORT_COUNTS: ReadonlyArray<readonly [string, number]> = [
  ['pong', 30],
  ['timeout', 0],
  ['send_failed', 0],
  ['suspended', 0],
];

function frequencyReport(
  record: typeof recordFrequencyCountProduction,
  frequency: Frequency,
  counts: ReadonlyArray<readonly [string, number]>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const [label, count] of counts) yield* record(frequency, label, count);
  });
}

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

function liveCells(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

/**
 * Cells allocated per operation. Valid only when no collection ran during the
 * measured loop (a collection frees cells and the delta undercounts), which is
 * detected through `objectCount` — the survivor count of the last collection —
 * and answered by retrying with half the operations.
 */
async function cellsPerOp(run: () => Promise<unknown>, ops: number): Promise<number> {
  for (let attempt = ops; attempt >= 1; attempt = Math.floor(attempt / 2)) {
    fullGC();
    const controlBefore = liveCells();
    for (let index = 0; index < attempt; index += 1) await null;
    const control = liveCells() - controlBefore;
    fullGC();
    const survivors = heapStats().objectCount;
    const before = liveCells();
    for (let index = 0; index < attempt; index += 1) await run();
    const after = liveCells();
    if (heapStats().objectCount === survivors) return (after - before - control) / attempt;
  }
  throw new Error('bench: a collection ran during every allocation measurement');
}

async function timeBatch(run: () => Promise<unknown>): Promise<number> {
  const startedAt = Bun.nanoseconds();
  for (let index = 0; index < OPS_PER_SAMPLE; index += 1) await run();
  return (Bun.nanoseconds() - startedAt) / OPS_PER_SAMPLE;
}

async function pairedTimes(
  arms: Readonly<Record<string, () => Promise<unknown>>>,
): Promise<Record<string, number[]>> {
  const names = Object.keys(arms);
  const times: Record<string, number[]> = Object.fromEntries(names.map((name) => [name, []]));
  for (let index = 0; index < WARMUP_OPS; index += 1) {
    for (const name of names) await arms[name]?.();
  }
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const forward = sample % 2 === 0 ? names : [...names].reverse();
    const order = [...forward, ...[...forward].reverse()];
    for (const name of order) {
      const run = arms[name];
      if (run !== undefined) times[name]?.push(await timeBatch(run));
    }
  }
  return times;
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// 1. Production routes, end to end
// ---------------------------------------------------------------------------

async function measureRoutes(compressed: Uint8Array<ArrayBuffer>, rawBytes: number): Promise<void> {
  let forwardedBodies = 0;
  let forwardedBytes = 0;
  const sink = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      forwardedBodies += 1;
      forwardedBytes += (await request.arrayBuffer()).byteLength;
      return new Response(null, { status: 204 });
    },
  });
  const config = {
    telemetry: {
      axiomToken: 'bench-token',
      axiomDataset: 'traces',
      axiomMetricsDataset: 'metrics',
      axiomPerfDataset: 'perf',
      axiomEndpoint: `http://127.0.0.1:${sink.port}`,
      environment: 'bench',
    },
  } as unknown as ServerConfig;
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(ServerConfigService, config),
      Layer.succeed(RateLimitServiceTag, { consume: () => Effect.succeed({ allowed: true }) }),
      Layer.succeed(Metric.MetricRegistry, new Map()),
    ),
  );
  const app = telemetryRoutesPlugin({
    runServerProgram: runtime.runPromise as typeof runServerProgram,
    authorizeRequest: async () => ({
      userId: 'bench',
      delegationId: 'bench',
      delegationExpiresAt: 0,
    }),
    logger: createLogger('telemetry-ingest-bench'),
  });
  const linkBody = JSON.stringify({
    windowMs: 2_000,
    sampleCount: 1,
    rttP50Ms: 40,
    rttP95Ms: 60,
    rttMaxMs: 60,
    inputAckP50Ms: 20,
    inputAckP95Ms: 30,
    degradedSampleCount: 0,
    txBytes: 1_200,
    rxBytes: 18_000,
    pathDirect: 0,
    pathRelay: 1,
    pathUnknown: 0,
    stateConnecting: 0,
    stateReady: 1,
    stateReconnecting: 0,
    stateDormant: 0,
    stateClosed: 0,
  });
  const postPerf = async () => {
    const response = await app.handle(
      new Request('http://localhost/api/telemetry/perf', {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson', 'content-encoding': 'gzip' },
        body: compressed,
      }),
    );
    if (response.status !== 204) throw new Error(`bench: perf route answered ${response.status}`);
  };
  const postLink = async () => {
    const response = await app.handle(
      new Request('http://localhost/api/telemetry/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: linkBody,
      }),
    );
    if (response.status !== 204) throw new Error(`bench: link route answered ${response.status}`);
  };
  try {
    for (let index = 0; index < WARMUP_OPS; index += 1) {
      await postPerf();
      await postLink();
    }
    forwardedBodies = 0;
    forwardedBytes = 0;
    const perfCells = await cellsPerOp(postPerf, ROUTE_OPS);
    const bytesPerForward = forwardedBytes / Math.max(1, forwardedBodies);
    const linkCells = await cellsPerOp(postLink, ROUTE_OPS);
    const perfTimes: number[] = [];
    const linkTimes: number[] = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      perfTimes.push(await timeBatch(postPerf));
      linkTimes.push(await timeBatch(postLink));
    }
    write('1. production routes (rate limit stubbed; perf forward goes to a loopback sink)');
    write(
      `   /api/telemetry/perf  ${ROWS_PER_BATCH} rows: received ${compressed.byteLength} B gzip, ` +
        `raw ${rawBytes} B; forwarded ${bytesPerForward.toFixed(0)} B/request ` +
        `(${(bytesPerForward / compressed.byteLength).toFixed(2)}x the received body)`,
    );
    write(
      `   /api/telemetry/perf  cells/request=${perfCells.toFixed(0)}  ` +
        `us/request p50=${(percentile(perfTimes, 0.5) / 1_000).toFixed(1)} ` +
        `p95=${(percentile(perfTimes, 0.95) / 1_000).toFixed(1)} (includes loopback forward, n=${SAMPLES})`,
    );
    write(
      `   /api/telemetry/link  cells/request=${linkCells.toFixed(0)}  ` +
        `us/request p50=${(percentile(linkTimes, 0.5) / 1_000).toFixed(1)} ` +
        `p95=${(percentile(linkTimes, 0.95) / 1_000).toFixed(1)} (n=${SAMPLES})`,
    );
  } finally {
    await runtime.dispose();
    sink.stop(true);
  }
}

// ---------------------------------------------------------------------------
// 2. Perf body handling A/B
// ---------------------------------------------------------------------------

async function measurePerfBody(compressed: Uint8Array): Promise<void> {
  assertLineCountsAgree();
  const arms = {
    production: () => productionArm(compressed),
    bytes: () => bytesArm(compressed),
    gzip: () => gzipArm(compressed),
  } as const;
  const results = {
    production: await productionArm(compressed),
    bytes: await bytesArm(compressed),
    gzip: await gzipArm(compressed),
  };
  for (const result of Object.values(results)) {
    if (result.lineCount !== ROWS_PER_BATCH) {
      throw new Error(`bench: expected ${ROWS_PER_BATCH} rows, counted ${result.lineCount}`);
    }
  }
  // Warm first: cold code allocates inline-cache and tier-up cells of its own.
  for (let index = 0; index < WARMUP_OPS; index += 1) {
    for (const run of Object.values(arms)) await run();
  }
  const cells = {
    production: await cellsPerOp(arms.production, ROUTE_OPS),
    bytes: await cellsPerOp(arms.bytes, ROUTE_OPS),
    gzip: await cellsPerOp(arms.gzip, ROUTE_OPS),
  };
  const times = await pairedTimes(arms);
  write('2. perf body handling, paired A/B (decompress + count + wire body)');
  for (const name of ['production', 'bytes', 'gzip'] as const) {
    const samples = times[name] ?? [];
    write(
      `   ${name.padEnd(10)} forwarded=${String(results[name].forwardedBytes).padStart(7)} B  ` +
        `cells/op=${cells[name].toFixed(0).padStart(5)}  ` +
        `us/op p50=${(percentile(samples, 0.5) / 1_000).toFixed(1).padStart(7)} ` +
        `p95=${(percentile(samples, 0.95) / 1_000).toFixed(1).padStart(7)} (n=${samples.length})`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. recordFrequencyCount A/B
// ---------------------------------------------------------------------------

async function measureFrequency(): Promise<void> {
  const makeRuntime = () => ManagedRuntime.make(Layer.succeed(Metric.MetricRegistry, new Map()));
  const runtimes = { production: makeRuntime(), candidate: makeRuntime() };
  const recorders = {
    production: recordFrequencyCountProduction,
    candidate: recordFrequencyCountCandidate,
  };
  try {
    write('3. recordFrequencyCount, paired A/B');
    for (const [report, counts] of [
      ['link report', LINK_REPORT_COUNTS],
      ['daemon report', DAEMON_REPORT_COUNTS],
    ] as const) {
      const arms = {
        production: () =>
          runtimes.production.runPromise(
            frequencyReport(recorders.production, browserLinkPathFrequency, counts),
          ),
        candidate: () =>
          runtimes.candidate.runPromise(
            frequencyReport(recorders.candidate, browserLinkPathFrequency, counts),
          ),
      };
      for (let index = 0; index < WARMUP_OPS; index += 1) {
        await arms.production();
        await arms.candidate();
      }
      const cells = {
        production: await cellsPerOp(arms.production, ROUTE_OPS),
        candidate: await cellsPerOp(arms.candidate, ROUTE_OPS),
      };
      const times = await pairedTimes(arms);
      const states = await Promise.all([
        runtimes.production.runPromise(Metric.value(browserLinkPathFrequency)),
        runtimes.candidate.runPromise(Metric.value(browserLinkPathFrequency)),
      ]);
      const [productionState, candidateState] = states.map((state) =>
        JSON.stringify([...state.occurrences].sort()),
      );
      if (productionState !== candidateState) {
        throw new Error(`bench: frequency states differ: ${productionState} vs ${candidateState}`);
      }
      for (const name of ['production', 'candidate'] as const) {
        const samples = times[name] ?? [];
        write(
          `   ${report.padEnd(13)} ${name.padEnd(10)} cells/report=${cells[name].toFixed(1).padStart(6)}  ` +
            `ns/report p50=${percentile(samples, 0.5).toFixed(0).padStart(6)} ` +
            `p95=${percentile(samples, 0.95).toFixed(0).padStart(6)} (n=${samples.length}; runPromise included)`,
        );
      }
    }
  } finally {
    await runtimes.production.dispose();
    await runtimes.candidate.dispose();
  }
}

const raw = perfBatch(ROWS_PER_BATCH);
const compressed = new Uint8Array(gzipSync(Buffer.from(raw, 'utf8')));
write(
  `telemetry ingest benchmark: samples=${SAMPLES}, ops/sample=${OPS_PER_SAMPLE}, warmup=${WARMUP_OPS}, ` +
    `allocation ops=${ROUTE_OPS}`,
);
await measureRoutes(compressed, Buffer.byteLength(raw));
await measurePerfBody(compressed);
await measureFrequency();
