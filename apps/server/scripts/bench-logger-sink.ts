import '@merkur/shared/e2e-wasm-bun';
/**
 * Cost of one structured log line through `@merkur/logger`.
 *
 * Two production paths write a line:
 *
 * - **sync** (`createLogger(scope).info(...)` with no exported sink, which is
 *   the daemon's case and the server's fallback): `writeMerkurLog` reads
 *   `LOG_LEVEL` from the environment, sanitizes the message and every context
 *   key and string, `JSON.stringify`s the record and writes it.
 * - **effect** (`logEffect`, and on the server every sync call too, routed
 *   through `setExportedLogSink`): `logEffect` sanitizes the context and
 *   `JSON.stringify`s it into a log annotation when the effect is built;
 *   `MerkurJsonLogger` then `JSON.parse`s that annotation, and
 *   `writeMerkurLog` sanitizes the parsed copy again and stringifies it again.
 *
 * Workloads are the real call shapes: a `dataplane_stderr` line (the daemon
 * re-logs every dataplane stderr chunk), a small control event, and the
 * `daemon_health_snapshot` record the daemon writes every 30 s, built by the
 * production `daemonObservabilitySnapshot` after one production
 * `transport_stats` metric event, logged exactly as
 * `runDaemonObservabilityReporterEffect` logs it.
 *
 * For the effect path the harness also times, on the same snapshot context, the
 * three steps that repeat work already done when the annotation was built
 * (parse, second sanitize, second stringify), and checks that the second
 * sanitize is a no-op on these inputs (the redaction rules are idempotent), so
 * that upper bound on what a single-pass writer could save is measured, not
 * inferred. stdout is replaced by a byte counter for the duration.
 */
import { fullGC, heapStats } from 'bun:jsc';

import { createLogger, logEffect, MerkurLoggerLayer } from '@merkur/logger';
import { Effect, Layer } from 'effect';
import { sanitizeLogContext } from '../../../packages/logger/src/sink';
import { percentile, perfEnvInteger } from '../../../scripts/perf/harness';
import {
  DaemonHealthServiceLive,
  daemonObservabilitySnapshot,
  recordDataplaneMetricEvent,
} from '../../daemon/src/services/daemon-metrics';
import type {
  DataplanePathStats,
  DataplaneTransportStats,
} from '../../daemon/src/services/dataplane-client';
import { enforceRateLimit, type RateLimitService } from '../src/services/rate-limit-service';

const LINES = perfEnvInteger('BENCH_LINES', 200);
const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 30);
const WARMUP_LINES = perfEnvInteger('BENCH_WARMUP_LINES', 2_000);

let stdoutBytes = 0;
let stdoutWrites = 0;
const originalWrite = process.stdout.write.bind(process.stdout);

function report(line: string): void {
  originalWrite(`${line}\n`);
}

function silenceStdout(): void {
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutWrites += 1;
    stdoutBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    return true;
  }) as typeof process.stdout.write;
}

function restoreStdout(): void {
  process.stdout.write = originalWrite as typeof process.stdout.write;
}

function pathStats(scale: number): DataplanePathStats {
  return {
    pathsAvailable: 1,
    pathsLive: 1,
    rttEwmaUsMax: 21_000 * scale,
    networkRttEwmaUsMax: 19_000 * scale,
    jitterEwmaUsMax: 900 * scale,
    sendFailuresMax: 0,
    lastAckAgeMsMax: 12,
    displayDatagramsReceived: 4_812 * scale,
    displayDatagramsRecoveredByFec: 3,
    displayDatagramsDeclaredLost: 1,
    displayDatagramsOutcomeUnknown: 0,
    quicSentPackets: 9_311 * scale,
    quicLostPackets: 4,
    quicLostBytes: 4_800,
    quicCongestionEvents: 1,
    quicBlackHoles: 0,
    quicDatagramsTx: 5_002 * scale,
    quicDatagramsRx: 4_990 * scale,
    quicUdpTxBytes: 6_220_311 * scale,
    quicUdpRxBytes: 812_004 * scale,
    quicMtuMin: 1_200,
    quicCwndBytesMin: 14_720,
    quicRttUsMax: 23_000 * scale,
  };
}

function transportStats(): DataplaneTransportStats {
  return {
    windowMs: 10_000,
    peers: 1,
    parkedPeers: 0,
    webtransport: pathStats(1),
    edge: pathStats(2),
    rowVersionsSent: 18_442,
    rowVersionsSupersededUnapplied: 2,
    rowVersionsSupersededApplied: 11,
    rowResendsIdentical: 0,
    stalePreparedFlushesSent: 0,
    burstsAbandoned: 0,
    burstsUnsafeToRewind: 0,
    datagramSendFailures: 0,
    fecRepairsSent: 41,
    fecRepairsRefused: 0,
    resyncRowsRequested: 0,
    rowsDeclaredLost: 1,
    unackedDatagramsMax: 7,
    edgeReliableQueuedBytesMax: 18_000,
    inboundDatagramDropsWt: 0,
    inboundDatagramDropsEdge: 0,
    overCapacitySessionRejections: 0,
    directWtIncomingExpected: 1,
    directWtIncomingUnexpected: 0,
    directWtAdmitted: 1,
    natKeepalivesSent: 12,
    natPunchBurstsSent: 1,
    natPunchRefusedNotGlobal: 0,
    natPunchRefusedRateLimited: 0,
    natSideChannelSendFailed: 0,
    natSideChannelWouldBlock: 0,
    statsEventsDropped: 0,
    rebindRequests: 2,
    rebindAccepted: 2,
    rebindCommitted: 2,
    rebindRefused: 0,
    rebindEnvelopesRejected: 0,
    rebindEventsSuppressed: 0,
  };
}

/** The daemon's real stderr shape: an ANSI-coloured `tracing` line. */
const STDERR_LINE =
  '\u001b[2m2026-09-18T23:27:38.155219Z\u001b[0m \u001b[32m INFO\u001b[0m \u001b[2mmerkur_dataplane::session\u001b[0m\u001b[2m:\u001b[0m peer authenticated ' +
  'peer_node_id=b7f1c2d4e5f60718293a4b5c6d7e8f90 carrier=edge generation=3 rtt_us=21000 ' +
  'session_id=0f8fad5b-d9cb-469f-a165-70867728950e'.padEnd(420, ' ');

const CONTROL_CONTEXT = {
  daemonId: 'daemon-3a362053-6826-49f9-8248-9efcd49888bd',
  connectionId: '1c6d1ab2-6a4f-4c1a-9f7d-2c77f1d0a4e2',
  presenceId: 'a3b1f0c8-5f0e-4e57-9c2c-3f0e9a1b2c3d',
  claimSeq: 118,
  leaseOrigin: 'claimed',
};

function liveCells(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

async function cellsPerLine(run: (lines: number) => Promise<void>): Promise<number> {
  for (let lines = LINES; lines >= 1; lines = Math.floor(lines / 2)) {
    fullGC();
    const survivors = heapStats().objectCount;
    const before = liveCells();
    await run(lines);
    const after = liveCells();
    if (heapStats().objectCount === survivors) return (after - before) / lines;
  }
  return Number.NaN;
}

async function nsPerLine(run: (lines: number) => Promise<void>): Promise<number[]> {
  await run(WARMUP_LINES);
  const samples: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const startedAt = Bun.nanoseconds();
    await run(LINES);
    samples.push((Bun.nanoseconds() - startedAt) / LINES);
  }
  return samples;
}

async function measure(label: string, run: (lines: number) => Promise<void>): Promise<void> {
  const bytesBefore = stdoutBytes;
  const writesBefore = stdoutWrites;
  await run(1);
  const lineBytes = stdoutBytes - bytesBefore;
  if (stdoutWrites - writesBefore !== 1) throw new Error(`bench: ${label} wrote no line`);
  // Warm first: cold code allocates inline-cache and tier-up cells of its own.
  await run(WARMUP_LINES);
  const cells = await cellsPerLine(run);
  const times = await nsPerLine(run);
  restoreStdout();
  report(
    `   ${label.padEnd(26)} line=${String(lineBytes).padStart(5)} B  cells/line=${cells.toFixed(0).padStart(5)}  ` +
      `us/line p50=${(percentile(times, 0.5) / 1_000).toFixed(2).padStart(6)} p95=${(percentile(times, 0.95) / 1_000).toFixed(2).padStart(6)} (n=${SAMPLES}x${LINES})`,
  );
  silenceStdout();
}

const runtimeLayer = Layer.mergeAll(DaemonHealthServiceLive, MerkurLoggerLayer);

const snapshotContext = await Effect.runPromise(
  Effect.gen(function* () {
    yield* recordDataplaneMetricEvent({ type: 'transport_stats', stats: transportStats() });
    const snapshot = yield* daemonObservabilitySnapshot;
    return { daemonId: CONTROL_CONTEXT.daemonId, ...snapshot };
  }).pipe(Effect.provide(runtimeLayer)),
);

const logger = createLogger('daemon');
const previousLevel = process.env.LOG_LEVEL;
process.env.LOG_LEVEL = 'info';
report(`logger sink benchmark: samples=${SAMPLES}, lines/sample=${LINES}`);
report('1. production log paths (stdout replaced by a byte counter)');
silenceStdout();
try {
  await measure('sync dataplane_stderr', async (lines) => {
    for (let index = 0; index < lines; index += 1) {
      logger.info('dataplane_stderr', { line: STDERR_LINE });
    }
  });
  await measure('effect control event', (lines) =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (let index = 0; index < lines; index += 1) {
          yield* logEffect('info', 'daemon', 'daemon_control_registered', CONTROL_CONTEXT);
        }
      }).pipe(Effect.provide(MerkurLoggerLayer)),
    ),
  );
  await measure('effect health snapshot', (lines) =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (let index = 0; index < lines; index += 1) {
          yield* logEffect('info', 'daemon', 'daemon_health_snapshot', snapshotContext).pipe(
            Effect.withLogSpan('daemon.health.snapshot'),
            Effect.withSpan('daemon.health.snapshot'),
          );
        }
      }).pipe(Effect.provide(MerkurLoggerLayer)),
    ),
  );
} finally {
  restoreStdout();
  if (previousLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = previousLevel;
}

report('2. repeated work inside one effect line (health snapshot context)');
const annotation = JSON.stringify(sanitizeLogContext(snapshotContext));
const parsed = JSON.parse(annotation) as Record<string, unknown>;
if (JSON.stringify(sanitizeLogContext(parsed)) !== annotation) {
  throw new Error('bench: second sanitize changed the context; the redundancy claim is false');
}
const steps = {
  'first sanitize+stringify': () => JSON.stringify(sanitizeLogContext(snapshotContext)).length,
  'parse annotation': () => Object.keys(JSON.parse(annotation) as object).length,
  'second sanitize': () => Object.keys(sanitizeLogContext(parsed)).length,
  'second stringify': () => JSON.stringify(parsed).length,
  'LOG_LEVEL read': () => process.env.LOG_LEVEL?.trim().toLowerCase().length ?? 0,
} as const;
let sink = 0;
for (const [label, step] of Object.entries(steps)) {
  for (let index = 0; index < WARMUP_LINES; index += 1) sink += step();
  const times: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const startedAt = Bun.nanoseconds();
    for (let index = 0; index < LINES; index += 1) sink += step();
    times.push((Bun.nanoseconds() - startedAt) / LINES);
  }
  report(
    `   ${label.padEnd(26)} us p50=${(percentile(times, 0.5) / 1_000).toFixed(2).padStart(6)} ` +
      `p95=${(percentile(times, 0.95) / 1_000).toFixed(2).padStart(6)} (context ${annotation.length} B, n=${SAMPLES}x${LINES})`,
  );
}
report(`   (second sanitize verified a no-op on this context; checksum ${sink})`);

report(
  '3. per-call logger construction (enforceRateLimit, enforceRateLimitFailClosed, refundRateLimit)',
);
const allowAll: RateLimitService = { consume: () => Effect.succeed({ allowed: true }) };
const checks = [{ key: 'telemetry-link:user:bench', limit: 120, windowMs: 60_000 }] as const;
const construction = {
  'createLogger per call': async (calls: number) => {
    for (let index = 0; index < calls; index += 1)
      if (createLogger('server').effect !== undefined) sink += 1;
  },
  'enforceRateLimit call': (calls: number) =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (let index = 0; index < calls; index += 1) yield* enforceRateLimit(allowAll, checks);
      }),
    ),
} as const;
for (const [label, run] of Object.entries(construction)) {
  // Warm first: cold code allocates inline-cache and tier-up cells of its own.
  await run(WARMUP_LINES);
  const cells = await cellsPerLine(run);
  const times = await nsPerLine(run);
  report(
    `   ${label.padEnd(26)} cells/call=${cells.toFixed(1).padStart(6)}  ns/call p50=${percentile(times, 0.5).toFixed(0)} ` +
      `p95=${percentile(times, 0.95).toFixed(0)} (n=${SAMPLES}x${LINES})`,
  );
}
