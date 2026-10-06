import '@merkur/shared/e2e-wasm-bun';
/**
 * Signed trace exports an idle daemon produces.
 *
 * The daemon's OTLP tracer (`daemonTracerLayer`) posts to
 * `/api/daemon/traces` through the signing `createDaemonFetch`, flushing every
 * 5 s whenever a sampled span has ended. Its only periodic span is
 * `daemon.health.snapshot`, opened by `runDaemonObservabilityReporterEffect`
 * at the default `Info` level, which the daemon's `Info` minimum samples.
 *
 * This runs the production reporter under the production tracer layer for a
 * fixed wall-clock window, with `globalThis.fetch` replaced by a counter and
 * the proof signer replaced by the software key the server's fixtures use, and
 * reports how many signed POSTs left, how many spans each carried and their
 * names. The reporter runs at `BENCH_REPORT_INTERVAL_MS` (default 1 s) so the
 * window stays short; in production the interval is 30 s against a 5 s
 * export cadence, so every snapshot span leaves in its own signed request.
 */
import { signDaemonProof } from '@merkur/auth';
import type { DaemonConfig } from '@merkur/config';
import { MerkurLoggerLayer } from '@merkur/logger';
import { Effect, Layer } from 'effect';
import { perfEnvInteger } from '../../../scripts/perf/harness';
import { daemonTracerLayer } from '../../daemon/src/observability/telemetry';
import {
  DaemonHealthServiceLive,
  runDaemonObservabilityReporterEffect,
} from '../../daemon/src/services/daemon-metrics';
import type { DaemonProofSigner } from '../../daemon/src/services/daemon-proof-signer';

const WINDOW_MS = perfEnvInteger('BENCH_WINDOW_MS', 11_000);
const REPORT_INTERVAL_MS = perfEnvInteger('BENCH_REPORT_INTERVAL_MS', 1_000);
const ORIGIN = 'https://merkur.bench';
const SEED = Buffer.alloc(32, 0x22).toString('base64url');

const config = {
  daemon_id: 'daemon-bench',
  server_origin: ORIGIN,
} as DaemonConfig;

let signatures = 0;
const signer: DaemonProofSigner = {
  signEffect: (purpose, transcript) =>
    Effect.sync(() => {
      signatures += 1;
      return signDaemonProof(SEED, purpose, transcript);
    }),
};

interface Export {
  readonly path: string;
  readonly bytes: number;
  readonly spans: string[];
}
const exports: Export[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const body = await request.text();
    const spans = [...body.matchAll(/"name":"([^"]+)"/g)]
      .map((match) => match[1] ?? '')
      .filter((name) => name.includes('.'));
    exports.push({ path: new URL(request.url).pathname, bytes: Buffer.byteLength(body), spans });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  },
  { preconnect: originalFetch.preconnect },
);

// stdout carries the reporter's JSON log lines; count them instead of printing.
let logLines = 0;
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => {
  logLines += 1;
  return true;
}) as typeof process.stdout.write;

try {
  await Effect.runPromise(
    runDaemonObservabilityReporterEffect(config.daemon_id, `${REPORT_INTERVAL_MS} millis`).pipe(
      Effect.timeout(`${WINDOW_MS} millis`),
      Effect.ignore,
      Effect.provide(
        Layer.mergeAll(
          daemonTracerLayer(config, signer),
          DaemonHealthServiceLive,
          MerkurLoggerLayer,
        ),
      ),
    ),
  );
} finally {
  process.stdout.write = originalWrite as typeof process.stdout.write;
  globalThis.fetch = originalFetch;
}

const spans = exports.flatMap((entry) => entry.spans);
const names = [...new Set(spans)];
const snapshotSpans = spans.filter((name) => name === 'daemon.health.snapshot').length;
originalWrite(
  `daemon trace export benchmark: window=${WINDOW_MS} ms, reporter interval=${REPORT_INTERVAL_MS} ms\n` +
    `   snapshot log lines=${logLines}  signed POSTs=${exports.length} (${exports.map((entry) => entry.path).join(', ')})  ` +
    `signatures=${signatures}\n` +
    `   spans exported=${spans.length} (daemon.health.snapshot=${snapshotSpans}; names: ${names.join(', ')})  ` +
    `bytes/export avg=${(exports.reduce((sum, entry) => sum + entry.bytes, 0) / Math.max(1, exports.length)).toFixed(0)}\n` +
    `   production cadence: reporter 30 s > export 5 s, so ${3_600 / 30} signed trace exports per daemon-hour from this span alone\n`,
);
