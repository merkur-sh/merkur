/**
 * Cells and time for the browser display/telemetry paths that run on a clock
 * rather than per frame, so their cost can be weighed against their cadence:
 *
 * - `trace-context`: `mintTraceparent()`, once per authenticated HTTP request
 *   and per telemetry batch.
 * - `hash-digest-40` / `hash-digest-256`: Rust viewer digest admission of the
 *   daemon's heartbeat row-hash digest for a 40-row and a maximum-row grid.
 * - `receiver-profile-publish`: the terminal worker's receiver-profile
 *   publication with every bucket window full (at most every 250 ms).
 * - `receiver-profile-read`: the transport worker's `readIfChanged` of that
 *   publication.
 * - `receiver-profile-compressed` / `receiver-profile-raw-compressed`: sample
 *   admission with an unchanged raw baseline and with one updated per sample.
 * - `receiver-profile-publish-one` / `receiver-profile-publish-all`: publication
 *   after one bucket changes and after every bucket changes.
 *
 * Every workload calls the production function. Cells are `bun:jsc`
 * object-type counts with a full collection before each snapshot.
 */
import { fullGC, heapStats } from 'bun:jsc';
import {
  createDisplayReceiverProfileBuffer,
  createDisplayReceiverProfileReader,
  createDisplayReceiverProfileWriter,
} from '../apps/web/src/terminal/display-receiver-profile';
import { MESSAGE_TYPE_DISPLAY_HASH_DIGEST } from '../packages/protocol/src';
import { MAX_TERMINAL_ROWS } from '../packages/shared/src/terminal';
import { mintTraceparent } from '../packages/shared/src/traceparent';
import { createViewerDriver } from './perf/client-viewer-driver';
import { emitPerfMetric, perfEnvInteger } from './perf/harness';

const ALLOCATION_OPS = perfEnvInteger('BENCH_ALLOCATION_OPS', 256);
const ALLOCATION_SAMPLES = perfEnvInteger('BENCH_ALLOCATION_SAMPLES', 15);
const TIMING_OPS = perfEnvInteger('BENCH_TIMING_OPS', 2_000);
const TIMING_SAMPLES = perfEnvInteger('BENCH_TIMING_SAMPLES', 100);
const WARMUPS = perfEnvInteger('BENCH_WARMUPS', 20);

let sink = 0;

function digestBytes(rows: number): Uint8Array {
  const bytes = new Uint8Array(4 + 10 + rows * 10);
  bytes[0] = MESSAGE_TYPE_DISPLAY_HASH_DIGEST;
  const length = bytes.length - 4;
  bytes[1] = length >>> 16;
  bytes[2] = length >>> 8;
  bytes[3] = length;
  const view = new DataView(bytes.buffer, 4);
  view.setUint32(0, 1, false);
  view.setUint32(4, 0, false);
  view.setUint16(8, rows, false);
  for (let row = 0; row < rows; row += 1) {
    view.setUint16(10 + row * 10, row, false);
    view.setUint32(12 + row * 10, row * 2_654_435_761, false);
    view.setUint32(16 + row * 10, row ^ 0x9e37_79b9, false);
  }
  return bytes;
}

function receiverProfile() {
  const sab = createDisplayReceiverProfileBuffer();
  const writer = createDisplayReceiverProfileWriter(sab);
  const reader = createDisplayReceiverProfileReader(sab);
  // Fill every window: six size classes x four ratio classes x two dictionary classes.
  for (let round = 0; round < 32; round += 1) {
    for (const raw of [256, 900, 1_800, 3_600, 7_000, 12_000]) {
      writer.recordRaw(raw, 20 + round);
      for (const ratio of [0.1, 0.2, 0.4, 0.8]) {
        writer.recordCompressed(raw, raw * ratio, round % 2 === 0, 40 + round);
        writer.recordCompressed(raw, raw * ratio, round % 2 === 1, 40 + round);
      }
    }
  }
  return { writer, reader };
}

function workloads(): Record<string, (ops: number) => void> {
  const digest40 = digestBytes(40);
  const digest256 = digestBytes(MAX_TERMINAL_ROWS);
  const profile = receiverProfile();
  const viewer40 = createViewerDriver(120, 40);
  const viewer256 = createViewerDriver(120, MAX_TERMINAL_ROWS);
  let now = 1_700_000_000_000;
  return {
    'trace-context': (ops) => {
      for (let op = 0; op < ops; op += 1) sink += mintTraceparent().length;
    },
    'hash-digest-40': (ops) => {
      for (let op = 0; op < ops; op += 1) {
        viewer40.receive(digest40, 1, op);
        viewer40.drain(op);
        sink += viewer40.viewer.applied_sequence();
      }
    },
    'hash-digest-256': (ops) => {
      for (let op = 0; op < ops; op += 1) {
        viewer256.receive(digest256, 1, op);
        viewer256.drain(op);
        sink += viewer256.viewer.applied_sequence();
      }
    },
    'receiver-profile-publish': (ops) => {
      for (let op = 0; op < ops; op += 1) {
        now += 250;
        profile.writer.publish(1_000, now);
      }
    },
    'receiver-profile-read': (ops) => {
      for (let op = 0; op < ops; op += 1) {
        now += 250;
        profile.writer.publish(1_000, now);
        sink += profile.reader.readIfChanged()?.buckets.length ?? -1;
      }
    },
    'receiver-profile-compressed': (ops) => {
      for (let op = 0; op < ops; op += 1) {
        profile.writer.recordCompressed(1_800, 720, false, 50 + (op % 32));
      }
    },
    'receiver-profile-raw-compressed': (ops) => {
      for (let op = 0; op < ops; op += 1) {
        profile.writer.recordRaw(1_800, 20 + (op % 32));
        profile.writer.recordCompressed(1_800, 720, false, 50 + (op % 32));
      }
    },
    'receiver-profile-publish-one': (ops) => {
      for (let op = 0; op < ops; op += 1) {
        profile.writer.recordCompressed(1_800, 720, false, 50 + (op % 32));
        now += 250;
        profile.writer.publish(1_000, now);
      }
    },
    'receiver-profile-publish-all': (ops) => {
      const sizes = [256, 900, 1_800, 3_600, 7_000, 12_000];
      const ratios = [0.1, 0.2, 0.4, 0.8];
      for (let op = 0; op < ops; op += 1) {
        for (const raw of sizes) {
          for (const ratio of ratios) {
            profile.writer.recordCompressed(raw, raw * ratio, false, 50 + (op % 32));
            profile.writer.recordCompressed(raw, raw * ratio, true, 50 + (op % 32));
          }
        }
        now += 250;
        profile.writer.publish(1_000, now);
      }
    },
  };
}

function cellTotal(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

function cellsPerOp(run: (ops: number) => void): number {
  const perOp: number[] = [];
  for (let sample = 0; sample < ALLOCATION_SAMPLES; sample += 1) {
    fullGC();
    const before = cellTotal();
    run(ALLOCATION_OPS);
    perOp.push((cellTotal() - before) / ALLOCATION_OPS);
  }
  perOp.sort((left, right) => left - right);
  return perOp[Math.floor(perOp.length / 2)] ?? Number.NaN;
}

function nsPerOp(run: (ops: number) => void): { median: number; p95: number } {
  const samples: number[] = [];
  for (let sample = 0; sample < TIMING_SAMPLES; sample += 1) {
    const startedAt = performance.now();
    run(TIMING_OPS);
    samples.push(((performance.now() - startedAt) * 1_000_000) / TIMING_OPS);
  }
  samples.sort((left, right) => left - right);
  return {
    median: samples[Math.floor(samples.length / 2)] ?? Number.NaN,
    p95: samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] ?? Number.NaN,
  };
}

if (import.meta.main) {
  process.stdout.write(
    `periodic display/telemetry paths: allocationOps=${ALLOCATION_OPS}, ` +
      `allocationSamples=${ALLOCATION_SAMPLES}, timingOps=${TIMING_OPS}, timingSamples=${TIMING_SAMPLES}\n`,
  );
  for (const [name, run] of Object.entries(workloads())) {
    for (let warmup = 0; warmup < WARMUPS; warmup += 1) run(TIMING_OPS);
    const cells = cellsPerOp(run);
    const time = nsPerOp(run);
    process.stdout.write(
      `${name}: cells/op=${cells.toFixed(2)}, ns/op median=${time.median.toFixed(1)} ` +
        `p95=${time.p95.toFixed(1)} (n=${TIMING_SAMPLES})\n`,
    );
    emitPerfMetric({
      name: `periodic-${name}-cells`,
      value: cells,
      unit: 'cells/op',
      direction: 'lower',
      sampleSize: ALLOCATION_SAMPLES,
    });
    emitPerfMetric({
      name: `periodic-${name}-time`,
      value: time.median,
      unit: 'ns/op',
      direction: 'lower',
      percentile: 0.5,
      sampleSize: TIMING_SAMPLES,
    });
  }
  process.stdout.write(`sink=${sink}\n`);
}
