/**
 * Cost of the profiling emission path.
 *
 * The acceptance criterion for continuous profiling is that a session with it
 * on is indistinguishable from one with it off. That claim rests on the write
 * being cheap enough to disappear against a frame budget, so this measures the
 * three states the hot path can actually be in:
 *
 * - **disabled**: the `perfEnabled` branch a non-profiling session pays.
 * - **enabled**: an allocation-free emitter writing one record.
 * - **legacy**: `structuredClone` of the same event, which is the serialisation
 *   `postMessage` performs. Still an under-estimate of what was replaced: it
 *   omits the main-thread task each message scheduled, and that wake — not the
 *   bytes — was the reason profiling perturbed the thing it measured.
 *
 * Measuring the bare object literal was tried and discarded: it never escapes
 * the loop, so escape analysis deletes it and the benchmark reports a cost the
 * production path never had.
 *
 * The figure to compare against is ~1200 events/sec, which is the repo's own
 * sizing (`TRACE_EVENT_TARGET_HZ` x `TRACE_EVENTS_PER_FRAME`).
 */
import { emitRenderStart, PERF_KIND_RENDER_START } from '../apps/web/src/perf/perf-event-codec';
import { createPerfRingBuffer, createPerfRingWriter } from '../apps/web/src/perf/perf-ring';
import type { TerminalPerfEvent } from '../apps/web/src/perf/terminal-latency';
import { emitPerfMetric, perfEnvInteger } from './perf/harness';

const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 400);
const EVENTS_PER_BATCH = perfEnvInteger('BENCH_BATCH_SIZE', 1_200);
const WARMUPS = perfEnvInteger('BENCH_WARMUPS', 100);

/** Events per second the instrumentation is sized for. */
const PRODUCTION_EVENT_RATE_HZ = 1_200;

const ring = createPerfRingBuffer(65_536);
const writer = createPerfRingWriter(ring);

// A sink the optimiser cannot discard: without it a dead-code pass could delete
// the legacy allocation entirely and report a cost of zero.
let sink = 0;
let perfEnabled = false;

function runDisabledBatch(): number {
  const startedAt = performance.now();
  for (let index = 0; index < EVENTS_PER_BATCH; index += 1) {
    if (perfEnabled) {
      emitRenderStart(
        writer,
        index,
        index,
        index,
        0,
        1,
        index,
        'immediate',
        0,
        0,
        0,
        0,
        8.3,
        0.9,
        0,
        0,
      );
    }
    sink += index;
  }
  return performance.now() - startedAt;
}

function runEnabledBatch(): number {
  const startedAt = performance.now();
  for (let index = 0; index < EVENTS_PER_BATCH; index += 1) {
    emitRenderStart(
      writer,
      index,
      index,
      index,
      0,
      1,
      index,
      'immediate',
      0,
      0,
      0,
      0,
      8.3,
      0.9,
      0,
      0,
    );
    sink += index;
  }
  return performance.now() - startedAt;
}

function runLegacyBatch(): number {
  const startedAt = performance.now();
  for (let index = 0; index < EVENTS_PER_BATCH; index += 1) {
    const event: TerminalPerfEvent = {
      kind: 'render_start',
      atMs: index,
      renderSeq: index,
      displayInputSeq: index,
      predictionInputSeq: 0,
      queuedDisplayFrames: 1,
      wantedAtMs: index,
      gate: 'immediate',
      fenceReleasedAtMs: 0,
      fenceReleasedRenderSeq: 0,
      opportunityEnteredAtMs: 0,
      opportunityDelayMs: 0,
      fenceWaitMs: 0,
      opportunityWaitMs: 0,
      refreshPeriodMs: 8.3,
      refreshConfidence01: 0.9,
    };
    // The serialisation `postMessage` performs. Forces the allocation to
    // escape, which is also what stops escape analysis deleting it.
    sink += structuredClone(event).renderSeq;
  }
  return performance.now() - startedAt;
}

function measure(run: () => number): { p50: number; p95: number } {
  for (let warmup = 0; warmup < WARMUPS; warmup += 1) run();
  const elapsed: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) elapsed.push(run());
  elapsed.sort((left, right) => left - right);
  return { p50: nearestRank(elapsed, 0.5), p95: nearestRank(elapsed, 0.95) };
}

perfEnabled = false;
const disabled = measure(runDisabledBatch);
perfEnabled = true;
const enabled = measure(runEnabledBatch);
const legacy = measure(runLegacyBatch);

if (!(enabled.p50 > 0)) throw new Error('perf-ring benchmark timer did not advance');

/** Nanoseconds per event, the unit that makes the frame-budget comparison direct. */
function nsPerEvent(batchMs: number): number {
  return (batchMs * 1_000_000) / EVENTS_PER_BATCH;
}
/** Fraction of one second spent emitting, at the production event rate. */
function dutyCycle(batchMs: number): number {
  return (nsPerEvent(batchMs) * PRODUCTION_EVENT_RATE_HZ) / 1_000_000_000;
}

process.stdout.write(
  `perf ring benchmark: samples=${SAMPLES}, warmups=${WARMUPS}, eventsPerBatch=${EVENTS_PER_BATCH}, checksum=${sink}\n` +
    `disabled: ${nsPerEvent(disabled.p50).toFixed(1)} ns/event (p95 ${nsPerEvent(disabled.p95).toFixed(1)})\n` +
    `enabled:  ${nsPerEvent(enabled.p50).toFixed(1)} ns/event (p95 ${nsPerEvent(enabled.p95).toFixed(1)})\n` +
    `legacy:   ${nsPerEvent(legacy.p50).toFixed(1)} ns/event (p95 ${nsPerEvent(legacy.p95).toFixed(1)}) — structuredClone, still excludes the main-thread wake\n` +
    `at ${PRODUCTION_EVENT_RATE_HZ} events/s: legacy costs ${(dutyCycle(legacy.p50) * 100).toFixed(4)}% of wall clock\n` +
    `at ${PRODUCTION_EVENT_RATE_HZ} events/s: enabled costs ${(dutyCycle(enabled.p50) * 100).toFixed(4)}% of wall clock\n`,
);

emitPerfMetric({
  name: 'perf-ring-emit-disabled',
  value: nsPerEvent(disabled.p50),
  unit: 'ns/event',
  direction: 'lower',
  percentile: 0.5,
  sampleSize: SAMPLES * EVENTS_PER_BATCH,
});
emitPerfMetric({
  name: 'perf-ring-emit-enabled',
  value: nsPerEvent(enabled.p50),
  unit: 'ns/event',
  direction: 'lower',
  percentile: 0.5,
  sampleSize: SAMPLES * EVENTS_PER_BATCH,
});
emitPerfMetric({
  name: 'perf-ring-emit-duty-cycle',
  value: dutyCycle(enabled.p50),
  unit: 'fraction',
  direction: 'lower',
  sampleSize: SAMPLES * EVENTS_PER_BATCH,
});

function nearestRank(sorted: readonly number[], ratio: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}
// Referenced so the kind constant stays part of this benchmark's contract: a
// slot-layout change to render_start must be reflected here too.
void PERF_KIND_RENDER_START;
