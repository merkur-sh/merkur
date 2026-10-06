/** Actual production Rust viewer receive, presentation and ACK boundary. */
import { createViewerDriver } from './perf/client-viewer-driver';
import { emitPerfMetric, summarizeSamples } from './perf/harness';
import { ingressFixture } from './term-wasm-ingress-fixture';

const iterations = Number(process.env.BENCH_ITERATIONS ?? 10_000);
if (!Number.isSafeInteger(iterations) || iterations <= 0)
  throw new Error('invalid BENCH_ITERATIONS');
for (const dirtyRows of [0, 1, 8, 40]) {
  const driver = createViewerDriver(120, 40);
  const frame = ingressFixture(120, 40, dirtyRows, 1, true);
  const samples: number[] = [];
  try {
    for (let index = 0; index < iterations + 100; index++) {
      const start = performance.now();
      driver.apply(frame);
      if (index >= 100) samples.push(performance.now() - start);
    }
    const result = summarizeSamples(samples);
    process.stdout.write(
      `${JSON.stringify({ benchmark: 'worker-viewer-apply', dirtyRows, iterations, scope: 'WASM copy, Rust receive/presentation/ACK; excludes network and GPU', ...result })}\n`,
    );
    emitPerfMetric({
      name: `worker-viewer-apply-${dirtyRows}`,
      value: result.median,
      unit: 'ms',
      direction: 'lower',
      sampleSize: iterations,
    });
  } finally {
    driver.close();
  }
}
