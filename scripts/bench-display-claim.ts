/** Rust viewer materializes canonical display resume claims at authenticated fences. */
import { createViewerDriver } from './perf/client-viewer-driver';
import { emitPerfMetric, summarizeSamples } from './perf/harness';
import { ingressFixture } from './term-wasm-ingress-fixture';

const samples = Number(process.env.BENCH_SAMPLES ?? 400);
if (!Number.isSafeInteger(samples) || samples <= 0) throw new Error('invalid BENCH_SAMPLES');
for (const dirtyRows of [0, 1, 4, 40]) {
  const driver = createViewerDriver();
  const delta = ingressFixture(120, 40, dirtyRows, 1, false);
  const times: number[] = [];
  let lineage = 1;
  try {
    for (let index = 0; index < samples + 60; index++) {
      driver.apply(delta);
      const start = performance.now();
      driver.viewer.fence(index, ++lineage);
      let resume = false;
      for (
        let output = driver.pollOutput(index);
        output !== null;
        output = driver.pollOutput(index)
      ) {
        if (output.kind !== 6) continue;
        if (
          output.words[0] !== 1 ||
          output.words[3] !== 120 ||
          output.words[4] !== 40 ||
          output.bytes.length !== 320
        )
          throw new Error('Rust resume claim authority mismatch');
        resume = true;
      }
      if (!resume) throw new Error('authenticated fence produced no canonical resume claim');
      if (index >= 60) times.push(performance.now() - start);
    }
    const stats = summarizeSamples(times);
    process.stdout.write(
      `${JSON.stringify({ benchmark: 'display-claim', dirtyRows, samples, scope: 'Rust authenticated fence, resume hash materialization and transferable output copies', ...stats })}\n`,
    );
    emitPerfMetric({
      name: `display-claim-${dirtyRows}`,
      value: stats.median,
      unit: 'ms/authentication',
      direction: 'lower',
      sampleSize: samples,
    });
  } finally {
    driver.close();
  }
}
