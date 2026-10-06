import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { arch, platform } from 'node:os';
import { type Browser, chromium, firefox } from '@playwright/test';
import { HISTORICAL_TWO_CREDIT_WEBGL, historicalWebGlPlugin } from './perf/historical-webgl';
import type { FenceCadenceResult, FenceCadenceSample } from './perf/webgl-fence-cadence-worker';

const samples = Number(process.env.BENCH_SAMPLES ?? 100);
const warmups = Number(process.env.BENCH_WARMUPS ?? 5);
const seed = Number(process.env.BENCH_SEED ?? 1296388675);
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (
  !Number.isSafeInteger(samples) ||
  samples < 1 ||
  samples > 1000 ||
  !Number.isSafeInteger(warmups) ||
  warmups < 0 ||
  warmups > 100 ||
  !Number.isSafeInteger(seed) ||
  seed < 0 ||
  seed > 0xffff_ffff
) {
  throw new Error('invalid bounded BENCH_SAMPLES, BENCH_WARMUPS or BENCH_SEED');
}
const browserName = process.env.PW_E2E_BROWSER ?? 'chromium';
if (browserName !== 'chromium' && browserName !== 'firefox')
  throw new Error('use chromium or firefox');
const hashes: Record<string, string> = {};
const workerBuild = await Bun.build({
  entrypoints: [new URL('./perf/webgl-fence-cadence-worker.ts', import.meta.url).pathname],
  target: 'browser',
  format: 'esm',
  plugins: [historicalWebGlPlugin(process.cwd(), true, hashes)],
});
if (!workerBuild.success || workerBuild.outputs.length !== 1)
  throw new Error(String(workerBuild.logs));
const workerSource = await workerBuild.outputs[0]?.text();
if (workerSource === undefined) throw new Error('missing worker bundle');
const workerBundleSha256 = createHash('sha256').update(workerSource).digest('hex');
for (const path of [
  'scripts/bench-webgl-fence-cadence.ts',
  'scripts/perf/webgl-fence-cadence-worker.ts',
]) {
  hashes[path] = createHash('sha256')
    .update(await Bun.file(path).bytes())
    .digest('hex');
}
hashes.historicalTwoCreditSourceArchive = HISTORICAL_TWO_CREDIT_WEBGL;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    return new URL(request.url).pathname === '/worker.js'
      ? new Response(workerSource, {
          headers: {
            'content-type': 'text/javascript',
            'cross-origin-embedder-policy': 'require-corp',
            'cross-origin-resource-policy': 'same-origin',
          },
        })
      : new Response('<!doctype html><canvas width="640" height="384"></canvas>', {
          headers: {
            'content-type': 'text/html',
            'cross-origin-opener-policy': 'same-origin',
            'cross-origin-embedder-policy': 'require-corp',
          },
        });
  },
});
const browserType = browserName === 'chromium' ? chromium : firefox;
async function measureCell(arm: FenceCadenceSample['arm'], idleMs: number) {
  let browser: Browser | undefined;
  try {
    browser = await browserType.launch({
      headless: true,
      // Required for exact executable provenance on current Playwright Chromium.
      args: browserName === 'chromium' ? ['--enable-automation', '--enable-gpu'] : [],
    });
    const page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') process.stderr.write(`${message.text()}\n`);
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    let executable = browserType.executablePath();
    if (browserName === 'chromium') {
      const cdp = await browser.newBrowserCDPSession();
      const command = await cdp.send('Browser.getBrowserCommandLine');
      const actual = command.arguments[0];
      if (typeof actual !== 'string') throw new Error('missing actual Chromium executable');
      executable = actual;
      await cdp.detach();
    }
    const executableSha256 = createHash('sha256')
      .update(await Bun.file(executable).bytes())
      .digest('hex');
    const result = await page.evaluate(
      async ({ samples, warmups, arm, idleMs }): Promise<FenceCadenceResult> => {
        const canvas = document.querySelector('canvas');
        if (canvas === null) throw new Error('missing fixture canvas');
        const offscreen = canvas.transferControlToOffscreen();
        const worker = new Worker('/worker.js', { type: 'module' });
        try {
          return await new Promise<FenceCadenceResult>((resolve, reject) => {
            const deadline = setTimeout(
              () => reject(new Error('cadence experiment timed out')),
              // Each fence has a five-second guard plus the deliberate idle.
              60_000 + (samples + warmups) * (5_000 + idleMs),
            );
            worker.onmessage = (
              event: MessageEvent<{ result?: FenceCadenceResult; error?: string }>,
            ) => {
              clearTimeout(deadline);
              if (event.data.result !== undefined) resolve(event.data.result);
              else reject(new Error(event.data.error ?? 'malformed worker result'));
            };
            worker.onerror = (event) => {
              clearTimeout(deadline);
              reject(new Error(event.message));
            };
            worker.postMessage({ canvas: offscreen, samples, warmups, arm, idleMs }, [offscreen]);
          });
        } finally {
          worker.terminate();
        }
      },
      { samples, warmups, arm, idleMs },
    );
    if (
      result.samples.length !== samples ||
      result.samples.some(
        (sample, ordinal) =>
          sample.arm !== arm || sample.idleMs !== idleMs || sample.ordinal !== ordinal,
      )
    ) {
      throw new Error('incomplete or misattributed raw sample population');
    }
    return {
      arm,
      idleMs,
      browserVersion: browser.version(),
      executable,
      executableSha256,
      ...result,
    };
  } finally {
    await browser?.close();
  }
}

try {
  const cells = [];
  const cadences = [0, 8, 16, 33, 80, 400];
  for (let offset = 0; offset < cadences.length; offset += 1) {
    const idleMs = cadences[(seed + offset) % cadences.length];
    if (idleMs === undefined) throw new Error('invalid cadence schedule');
    for (let pair = 0; pair < 2; pair += 1) {
      const arm = (seed + offset + pair) % 2 === 0 ? 'production' : 'readback-diagnostic';
      process.stderr.write(`cadence cell ${cells.length + 1}/12: ${arm} ${idleMs}ms\n`);
      cells.push(await measureCell(arm, idleMs));
    }
  }
  const allSamples = cells.flatMap((cell) => cell.samples);
  if (allSamples.length !== samples * 12) throw new Error('incomplete raw sample population');
  const summarize = (values: number[]) => {
    values.sort((a, b) => a - b);
    return {
      count: values.length,
      median: values[Math.ceil(values.length * 0.5) - 1],
      p95: values[Math.ceil(values.length * 0.95) - 1],
      p99: values[Math.ceil(values.length * 0.99) - 1],
      worst: values.at(-1),
    };
  };
  const summaries = [];
  for (const arm of ['production', 'readback-diagnostic'] as const)
    for (const idleMs of [0, 8, 16, 33, 80, 400]) {
      const population = allSamples.filter(
        (sample) => sample.arm === arm && sample.idleMs === idleMs,
      );
      if (population.length !== samples) throw new Error('incomplete per-cadence population');
      summaries.push({
        arm,
        idleMs,
        count: population.length,
        submitCpuMs: summarize(population.map((sample) => sample.submitCpuMs)),
        readbackCpuMs: summarize(population.map((sample) => sample.readbackCpuMs)),
        endToObservedMs: summarize(population.map((sample) => sample.endToObservedMs)),
        lastPollIntervalMs: summarize(population.map((sample) => sample.lastPollIntervalMs)),
        unsignaledAfterReadback: population.filter((sample) => sample.unsignaledAfterReadback)
          .length,
      });
    }
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 2,
        boundary:
          'submit CPU and browser-observed fence readiness; not physical GPU timestamps, compositor paint, network latency or photons; synchronous readback is a diagnostic control only',
        sourceHead,
        hashes,
        workerBundleSha256,
        browser: browserName,
        isolation: 'fresh browser process per arm/cadence; no cross-arm or cadence interleaving',
        platform: platform(),
        arch: arch(),
        runtime: Bun.version,
        seed,
        warmups,
        samplesPerCell: samples,
        cells,
        summaries,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await server.stop(true);
}
