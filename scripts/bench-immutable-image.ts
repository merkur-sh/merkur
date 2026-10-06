import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { arch, platform } from 'node:os';
import { resolve } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';
import { historicalWebGlPlugin } from './perf/historical-webgl';
import type {
  ImageExperimentMessage,
  ImageExperimentResult,
  ImmutableImageSubmitted,
} from './perf/immutable-image-worker';

// Component experiment, deliberately separate from the unfinished production
// scheduler. Every repository implementation dependency is loaded from this
// checkpoint; the result records its exact closure and built worker hash.
const RENDERER_CHECKPOINT = 'fc3e6e36';

export function summarizeImageExperiment(values: readonly number[]) {
  if (values.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error(`invalid experiment duration (minimum ${Math.min(...values)})`);
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
  return {
    count: sorted.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    worst: sorted.at(-1) ?? null,
  };
}

export function imageExperimentOfferPlan(durationMs: number, intervalMs: number) {
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 100 ||
    durationMs > 30_000 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > 1000
  )
    throw new Error('invalid bounded experiment schedule');
  return Array.from(
    { length: Math.ceil(durationMs / intervalMs) },
    (_, index) => index * intervalMs,
  );
}

async function run() {
  const durationMs = Number(process.env.IMAGE_EXPERIMENT_DURATION_MS ?? 10_000);
  const warmupMs = 1000;
  imageExperimentOfferPlan(durationMs, 100);
  if (durationMs > 29_000) throw new Error('duration plus warmup exceeds bounded schedule');
  const browserName = process.env.PW_E2E_BROWSER ?? 'chromium';
  if (browserName !== 'chromium' && browserName !== 'firefox' && browserName !== 'webkit')
    throw new Error('use chromium, firefox or webkit');
  const browserType = { chromium, firefox, webkit }[browserName];
  const root = process.cwd();
  const checkpoint = execFileSync('git', ['rev-parse', RENDERER_CHECKPOINT], {
    encoding: 'utf8',
  }).trim();
  const closure: Record<string, string> = {};
  const build = await Bun.build({
    entrypoints: [resolve('scripts/perf/immutable-image-worker.ts')],
    target: 'browser',
    format: 'esm',
    plugins: [historicalWebGlPlugin(root, false, closure)],
  });
  if (!build.success || build.outputs.length !== 1) throw new Error(String(build.logs));
  const source = await build.outputs[0]?.text();
  if (source === undefined || closure['apps/web/src/renderer-webgl2.ts'] === undefined)
    throw new Error('missing pinned renderer bundle');
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const worker = new URL(request.url).pathname === '/worker.js';
      return new Response(
        worker
          ? source
          : '<!doctype html><style>html,body{margin:0;background:black}canvas{display:block;width:800px;height:480px}</style><canvas width="1600" height="960"></canvas>',
        {
          headers: {
            'content-type': worker ? 'text/javascript' : 'text/html',
            'cross-origin-opener-policy': 'same-origin',
            'cross-origin-embedder-policy': 'require-corp',
            'cross-origin-resource-policy': 'same-origin',
          },
        },
      );
    },
  });
  const cells = [];
  try {
    for (const workload of ['typing', 'redraw'] as const) {
      const intervalMs = workload === 'typing' ? 100 : 8;
      const plan = imageExperimentOfferPlan(durationMs + warmupMs, intervalMs);
      for (const [armIndex, arm] of (['direct', 'bitmap', 'bitmap', 'direct'] as const).entries()) {
        process.stderr.write(
          `image experiment ${browserName} ${workload} ${armIndex + 1}/4 ${arm}\n`,
        );
        const browser = await browserType.launch({
          headless: true,
          ...(browserName === 'chromium'
            ? { channel: 'chromium', args: ['--enable-automation', '--enable-gpu'] }
            : {}),
        });
        let observed: unknown = null;
        try {
          const page = await browser.newPage({
            viewport: { width: 1000, height: 700 },
            deviceScaleFactor: 2,
          });
          await page.goto(`http://127.0.0.1:${server.port}/`);
          let executable = browserType.executablePath();
          if (browserName === 'chromium') {
            const cdp = await browser.newBrowserCDPSession();
            const command = await cdp.send('Browser.getBrowserCommandLine');
            const actual = command.arguments[0];
            if (typeof actual !== 'string') throw new Error('missing actual browser executable');
            executable = actual;
            await cdp.detach();
          }
          const result = await page.evaluate(
            async ({ arm, workload, plan, warmupMs }) => {
              const canvas = document.querySelector('canvas');
              if (canvas === null) throw new Error('missing canvas');
              const bitmapContext = arm === 'bitmap' ? canvas.getContext('bitmaprenderer') : null;
              if (arm === 'bitmap' && bitmapContext === null)
                throw new Error('bitmaprenderer unavailable');
              const offscreen =
                arm === 'direct'
                  ? canvas.transferControlToOffscreen()
                  : new OffscreenCanvas(1600, 960);
              const epochNow = () => performance.timeOrigin + performance.now();
              const rafTimes: number[] = [];
              let rafHandle = 0;
              let measuring = false;
              let latestAcceptedOrdinal = 0;
              let lastRafAcceptedOrdinal = 0;
              const opportunities: { atMs: number; latestAcceptedOrdinal: number }[] = [];
              const frame = () => {
                rafTimes.push(epochNow());
                if (measuring && latestAcceptedOrdinal !== lastRafAcceptedOrdinal) {
                  opportunities.push({ atMs: epochNow(), latestAcceptedOrdinal });
                  lastRafAcceptedOrdinal = latestAcceptedOrdinal;
                }
                rafHandle = requestAnimationFrame(frame);
              };
              rafHandle = requestAnimationFrame(frame);
              // Calibrate before warmup, not from the tested arm's output cadence.
              await new Promise<void>((resolve) => setTimeout(resolve, 500));
              const periods = rafTimes
                .slice(1)
                .map((value, index) => value - (rafTimes[index] ?? value))
                .sort((a, b) => a - b);
              const periodMs = periods[Math.floor(periods.length / 2)];
              if (periodMs === undefined || periodMs < 2 || periodMs > 100)
                throw new Error('invalid refresh calibration');
              rafTimes.length = 0;
              const worker = new Worker('/worker.js', { type: 'module' });
              type Submission = ImmutableImageSubmitted;
              type Accepted = Omit<Submission, 'kind' | 'bitmap'> & {
                mainReceivedAtMs: number;
                acceptedAtMs: number;
              };
              const accepted: Accepted[] = [];
              const offers: { ordinal: number; scheduledAtMs: number; offeredAtMs: number }[] = [];
              let timer: ReturnType<typeof setTimeout> | undefined;
              let deadline: ReturnType<typeof setTimeout> | undefined;
              let startAtMs = 0;
              let nextIndex = 0;
              let consumedImages = 0;
              let finished = false;
              let finishRequested = false;
              let visibilityChanged = false;
              const visibility = () => {
                visibilityChanged = true;
              };
              document.addEventListener('visibilitychange', visibility);
              const maybeFinish = () => {
                if (
                  nextIndex === plan.length &&
                  latestAcceptedOrdinal === plan.length &&
                  !finishRequested
                ) {
                  finishRequested = true;
                  worker.postMessage({ kind: 'finish' });
                }
              };
              try {
                const workerResult = await new Promise<ImageExperimentResult>((resolve, reject) => {
                  deadline = setTimeout(
                    () => reject(new Error('image experiment timed out')),
                    (plan.at(-1) ?? 0) + 20_000,
                  );
                  const offerNext = () => {
                    const target = plan[nextIndex];
                    if (target === undefined) {
                      maybeFinish();
                      return;
                    }
                    const wait = startAtMs + target - epochNow();
                    if (wait > 0.2) {
                      timer = setTimeout(offerNext, wait);
                      return;
                    }
                    const ordinal = nextIndex + 1;
                    const offeredAtMs = epochNow();
                    offers.push({ ordinal, scheduledAtMs: startAtMs + target, offeredAtMs });
                    worker.postMessage({ kind: 'offer', ordinal, offeredAtMs });
                    nextIndex += 1;
                    // Open loop: the next offered update never waits for acceptance.
                    timer = setTimeout(
                      offerNext,
                      Math.max(0, startAtMs + (plan[nextIndex] ?? target) - epochNow()),
                    );
                  };
                  worker.onerror = (event) => reject(new Error(event.message));
                  worker.onmessage = (event: MessageEvent<ImageExperimentMessage>) => {
                    try {
                      const message = event.data;
                      if (message.kind === 'error')
                        throw new Error(message.message ?? 'worker failed');
                      if (message.kind === 'ready') {
                        startAtMs = epochNow();
                        measuring = true;
                        offerNext();
                        return;
                      }
                      if (message.kind === 'done') {
                        resolve(message);
                        return;
                      }
                      if (message.kind !== 'submitted') return;
                      const mainReceivedAtMs = epochNow();
                      if (message.ordinal <= latestAcceptedOrdinal)
                        throw new Error('nonmonotonic accepted image');
                      const bitmap = message.bitmap;
                      if (arm === 'bitmap') {
                        if (bitmap === undefined || bitmapContext === null)
                          throw new Error('missing transferred bitmap');
                        try {
                          bitmapContext.transferFromImageBitmap(bitmap);
                          consumedImages += 1;
                        } finally {
                          bitmap.close();
                        }
                      } else if (bitmap !== undefined) {
                        bitmap.close();
                        throw new Error('unexpected bitmap in control');
                      }
                      const acceptedAtMs = epochNow();
                      latestAcceptedOrdinal = message.ordinal;
                      accepted.push({
                        ordinal: message.ordinal,
                        offeredAtMs: message.offeredAtMs,
                        receivedAtMs: message.receivedAtMs,
                        renderStartAtMs: message.renderStartAtMs,
                        renderEndAtMs: message.renderEndAtMs,
                        imageEndAtMs: message.imageEndAtMs,
                        postedAtMs: message.postedAtMs,
                        mainReceivedAtMs,
                        acceptedAtMs,
                      });
                      // The direct arm deliberately has the same metadata round trip.
                      // This is consumer acceptance, NEVER a GPU/presentation ACK.
                      worker.postMessage({ kind: 'accepted', ordinal: message.ordinal });
                      maybeFinish();
                    } catch (error) {
                      reject(error);
                    }
                  };
                  worker.postMessage(
                    {
                      kind: 'init',
                      canvas: offscreen,
                      arm,
                      width: 1600,
                      height: 960,
                      periodMs,
                      workload,
                    },
                    [offscreen],
                  );
                });
                measuring = false;
                const timingEndedAtMs = epochNow();
                // Software-pixel diagnostic is AFTER the entire timed population.
                await new Promise<void>((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                );
                const diagnostic = document.createElement('canvas');
                diagnostic.width = 1600;
                diagnostic.height = 960;
                const context = diagnostic.getContext('2d', { willReadFrequently: true });
                if (context === null) throw new Error('diagnostic canvas unavailable');
                context.drawImage(canvas, 0, 0);
                const markerPixels = Array.from({ length: 30 }, (_, row) =>
                  Array.from(context.getImageData(2, row * 32 + 16, 1, 1).data),
                );
                const finalPixels = context.getImageData(0, 0, 1600, 960).data;
                let finalPixelHash = 0x811c9dc5;
                for (const channel of finalPixels)
                  finalPixelHash = Math.imul(finalPixelHash ^ channel, 0x01000193) >>> 0;
                finished = true;
                return {
                  workerResult,
                  arm,
                  workload,
                  periodMs,
                  warmupMs,
                  startAtMs,
                  timingEndedAtMs,
                  visibilityChanged,
                  offers,
                  accepted,
                  rafTimes,
                  opportunities,
                  consumedImages,
                  markerPixels,
                  finalPixelHash,
                  latestAcceptedOrdinal,
                  dpr: devicePixelRatio,
                  visibility: document.visibilityState,
                };
              } finally {
                if (timer !== undefined) clearTimeout(timer);
                if (deadline !== undefined) clearTimeout(deadline);
                cancelAnimationFrame(rafHandle);
                document.removeEventListener('visibilitychange', visibility);
                // Any late transferred resource is explicitly discarded before termination.
                worker.onmessage = (event: MessageEvent<Submission>) => event.data.bitmap?.close();
                worker.postMessage({ kind: 'shutdown' });
                if (finished) await new Promise<void>((resolve) => setTimeout(resolve, 10));
                worker.terminate();
              }
            },
            { arm, workload, plan, warmupMs },
          );
          observed = result;
          const integrityErrors: string[] = [];
          const counts = result.workerResult;
          if (
            counts.offeredCount !== plan.length ||
            counts.receivedCount !== plan.length ||
            counts.submittedCount !== result.accepted.length ||
            counts.submittedCount + counts.coalescedCount !== plan.length ||
            counts.lastOrdinal !== plan.length ||
            result.latestAcceptedOrdinal !== plan.length
          )
            integrityErrors.push('incomplete or inconsistent offered/accepted population');
          if (
            counts.maxOutstanding !== 1 ||
            counts.createdBitmapCount !== result.consumedImages ||
            (arm === 'bitmap' && counts.createdBitmapCount !== counts.submittedCount) ||
            (arm === 'direct' && counts.createdBitmapCount !== 0)
          )
            integrityErrors.push('image ownership accounting failed');
          if (result.visibilityChanged || result.visibility !== 'visible')
            integrityErrors.push('visibility changed during observation');
          for (const [row, expected] of counts.expectedPixels.entries()) {
            const pixel = result.markerPixels[row];
            if (
              pixel === undefined ||
              pixel.some(
                (channel, index) => Math.abs(channel - (expected.rgba[index] ?? -1000)) > 1,
              )
            )
              integrityErrors.push(`final row ${row} pixel mismatch`);
          }
          if (integrityErrors.length !== 0) process.exitCode = 1;
          const firstMeasuredOrdinal = Math.ceil(warmupMs / intervalMs) + 1;
          const measured = result.accepted.filter(
            (sample) => sample.ordinal >= firstMeasuredOrdinal,
          );
          const measuredOffers = result.offers.filter(
            (sample) => sample.scheduledAtMs >= result.startAtMs + warmupMs,
          );
          const distribution = (value: (sample: (typeof measured)[number]) => number) =>
            summarizeImageExperiment(measured.map(value));
          // Include every offered state, not just the lucky latest states that
          // survived coalescing. Coverage means same-or-newer absolute fixture
          // state accepted by the consumer, not that this ordinal was visible.
          let coveringIndex = 0;
          const coveringDurations = measuredOffers.map((offer) => {
            while ((result.accepted[coveringIndex]?.ordinal ?? Infinity) < offer.ordinal)
              coveringIndex += 1;
            const covering = result.accepted[coveringIndex];
            if (covering === undefined) throw new Error('uncovered offered update');
            return covering.acceptedAtMs - offer.offeredAtMs;
          });
          const cell = {
            browserVersion: browser.version(),
            executable,
            executableSha256: createHash('sha256')
              .update(await Bun.file(executable).bytes())
              .digest('hex'),
            armIndex,
            integrityErrors,
            ...result,
            // timeOrigin conversion alone is not a calibrated cross-realm
            // clock join. Preserve signed raw differences as diagnostics; all
            // claimed latency distributions below use same-realm intervals.
            clockDiagnostics: {
              calibrated: false,
              mainToWorkerMinimumMs: Math.min(
                ...measured.map((sample) => sample.receivedAtMs - sample.offeredAtMs),
              ),
              workerToMainMinimumMs: Math.min(
                ...measured.map((sample) => sample.mainReceivedAtMs - sample.postedAtMs),
              ),
            },
            summary: {
              offered: measuredOffers.length,
              accepted: measured.length,
              offerLatenessMs: summarizeImageExperiment(
                measuredOffers.map((sample) =>
                  Math.max(0, sample.offeredAtMs - sample.scheduledAtMs),
                ),
              ),
              workerWaitMs: distribution((sample) => sample.renderStartAtMs - sample.receivedAtMs),
              renderCpuMs: distribution((sample) => sample.renderEndAtMs - sample.renderStartAtMs),
              imageProductionMs: distribution(
                (sample) => sample.imageEndAtMs - sample.renderEndAtMs,
              ),
              acceptCpuMs: distribution((sample) => sample.acceptedAtMs - sample.mainReceivedAtMs),
              offerToAcceptanceMs: distribution(
                (sample) => sample.acceptedAtMs - sample.offeredAtMs,
              ),
              offerToCoveringAcceptanceMs: summarizeImageExperiment(coveringDurations),
              acceptanceGapMs: summarizeImageExperiment(
                measured
                  .slice(1)
                  .map(
                    (sample, index) =>
                      sample.acceptedAtMs - (measured[index]?.acceptedAtMs ?? sample.acceptedAtMs),
                  ),
              ),
              maxOrdinalGap: Math.max(
                0,
                ...measured
                  .slice(1)
                  .map(
                    (sample, index) =>
                      sample.ordinal - (measured[index]?.ordinal ?? sample.ordinal),
                  ),
              ),
            },
          };
          cells.push(cell);
          process.stderr.write(
            `${JSON.stringify({ arm, workload, summary: cell.summary, worker: result.workerResult, markerPixels: result.markerPixels })}\n`,
          );
        } catch (error) {
          cells.push({
            arm,
            armIndex,
            workload,
            error: error instanceof Error ? error.message : String(error),
            raw: observed,
          });
          process.exitCode = 1;
        } finally {
          await browser.close();
        }
      }
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          boundary:
            'Component image-handoff experiment; credit-matched direct control, not the production scheduler. Acceptance/rAF are not physical paint. No network, terminal semantics, speculation, GPU-queue bound or physical-iPhone claim.',
          checkpoint,
          closure,
          workerBundleSha256: createHash('sha256').update(source).digest('hex'),
          browser: browserName,
          platform: platform(),
          arch: arch(),
          runtime: Bun.version,
          durationMs,
          warmupMs,
          dimensions: [1600, 960],
          schedule: 'open-loop; fresh browser per cell; ABBA per workload',
          sourceHash: createHash('sha256')
            .update(await Bun.file(import.meta.path).bytes())
            .digest('hex'),
          cells,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await server.stop(true);
  }
}

if (import.meta.main) await run();
