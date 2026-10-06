import { emitPerfMetric } from './perf/harness';

const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 100_000);
const ROWS = 40;

const rows = Array.from({ length: ROWS }, (_, index) => ({ index, hash: BigInt(index + 1) }));
const recipients = Array.from({ length: 4 }, (_, index) => ({
  rowHashes: new BigUint64Array(ROWS).fill(index % 2 === 0 ? 0n : 1n),
}));

const start = performance.now();
let kept = 0;
for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
  for (const recipient of recipients) {
    kept += rows.filter((row) => recipient.rowHashes[row.index] !== row.hash).length;
  }
}
const elapsedMs = performance.now() - start;
const opsPerSecond = Math.round((ITERATIONS / elapsedMs) * 1000);

process.stdout.write(
  `daemon multicast benchmark: iterations=${ITERATIONS}\n` +
    `hash-gate: ${opsPerSecond.toLocaleString('en-US')} ops/s, ${elapsedMs.toFixed(1)}ms, kept=${kept}\n`,
);
emitPerfMetric({
  name: 'multicast-hash-gate-model',
  value: opsPerSecond,
  unit: 'ops/s',
  direction: 'higher',
  sampleSize: ITERATIONS,
});
