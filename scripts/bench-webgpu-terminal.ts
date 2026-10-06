import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { arch, platform, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';
import { imageExperimentOfferPlan, summarizeImageExperiment } from './bench-immutable-image';
import { emitPerfMetric } from './perf/harness';
import { HISTORICAL_TWO_CREDIT_WEBGL, historicalWebGlPlugin } from './perf/historical-webgl';
import type {
  WebGpuTerminalCompleted,
  WebGpuTerminalDone,
  WebGpuTerminalMessage,
  WebGpuTerminalSubmitted,
} from './perf/webgpu-terminal-worker';

interface Offer {
  ordinal: number;
  offeredAtMs: number;
  scheduledAtMs: number;
}
interface Submission extends WebGpuTerminalSubmitted {
  mainReceivedAtMs: number;
}
interface Completion extends WebGpuTerminalCompleted {
  mainReceivedAtMs: number;
}

/** Every offer counts, including states replaced before submission. No clock-domain joins. */
export function coveringNoticeDurations(
  offers: readonly Offer[],
  notices: readonly { ordinal: number; mainReceivedAtMs: number }[],
): number[] {
  let index = 0;
  let previousOrdinal = 0;
  for (const offer of offers) {
    if (!Number.isSafeInteger(offer.ordinal) || offer.ordinal <= previousOrdinal)
      throw new Error('nonmonotonic offer ownership');
    previousOrdinal = offer.ordinal;
  }
  previousOrdinal = 0;
  for (const notice of notices) {
    if (!Number.isSafeInteger(notice.ordinal) || notice.ordinal <= previousOrdinal)
      throw new Error('nonmonotonic notice ownership');
    previousOrdinal = notice.ordinal;
  }
  return offers.map((offer) => {
    while ((notices[index]?.ordinal ?? Infinity) < offer.ordinal) index += 1;
    const notice = notices[index];
    if (notice === undefined) throw new Error('uncovered offered state');
    const elapsed = notice.mainReceivedAtMs - offer.offeredAtMs;
    if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error('invalid coverage duration');
    return elapsed;
  });
}

export function compareGpuPixels(reference: Uint8Array, candidate: Uint8Array) {
  if (reference.length === 0 || reference.length !== candidate.length)
    throw new Error('pixel dimensions differ');
  let differingChannels = 0;
  let aboveTolerance = 0;
  let maximumError = 0;
  for (let i = 0; i < reference.length; i += 1) {
    const difference = Math.abs((reference[i] ?? 0) - (candidate[i] ?? 0));
    if (difference > 0) differingChannels += 1;
    if (difference > 1) aboveTolerance += 1;
    maximumError = Math.max(maximumError, difference);
  }
  return { channels: reference.length, differingChannels, aboveTolerance, maximumError };
}

/** Qualification of the injected workload, not a filter on renderer latency. */
export function qualifyGpuOfferCadence(offers: readonly Offer[]): string[] {
  if (offers.length < 2) return ['insufficient offered cadence population'];
  const lateness = summarizeImageExperiment(
    offers.map((offer) => Math.max(0, offer.offeredAtMs - offer.scheduledAtMs)),
  );
  const first = offers[0];
  const last = offers.at(-1);
  if (first === undefined || last === undefined) throw new Error('missing cadence endpoints');
  const errors: string[] = [];
  if ((lateness.p95 ?? Infinity) > 10) errors.push('offer lateness p95 exceeds predeclared 10 ms');
  if ((lateness.worst ?? Infinity) > 50)
    errors.push('offer lateness exceeds predeclared 50 ms maximum');
  if (last.offeredAtMs - first.offeredAtMs > (last.scheduledAtMs - first.scheduledAtMs) * 1.05 + 10)
    errors.push('offered workload span stretched beyond 5% plus 10 ms');
  return errors;
}

async function run() {
  const durationMs = Number(process.env.GPU_EXPERIMENT_DURATION_MS ?? 10_000);
  const warmupMs = 1000;
  imageExperimentOfferPlan(durationMs, 100);
  if (durationMs > 29_000) throw new Error('duration plus warmup exceeds bound');
  const browserName = process.env.PW_E2E_BROWSER ?? 'chromium';
  if (browserName !== 'chromium' && browserName !== 'firefox' && browserName !== 'webkit')
    throw new Error('use chromium, firefox or webkit');
  const headless = process.env.GPU_EXPERIMENT_HEADED !== '1';
  const browserType = { chromium, firefox, webkit }[browserName];
  const checkpoint = execFileSync('git', ['rev-parse', 'fc3e6e36'], { encoding: 'utf8' }).trim();
  const root = process.cwd();
  const closure: Record<string, string> = {};
  // Archived exact-two-fence control. This experiment does not select or retain
  // a legacy renderer in the production application.
  const build = await Bun.build({
    entrypoints: [resolve('scripts/perf/webgpu-terminal-worker.ts')],
    target: 'browser',
    format: 'esm',
    plugins: [historicalWebGlPlugin(root, true, closure)],
  });
  if (!build.success || build.outputs.length !== 1) throw new Error(String(build.logs));
  const source = await build.outputs[0]?.text();
  if (source === undefined || closure['apps/web/src/renderer-webgl2.ts'] === undefined)
    throw new Error('missing pinned renderer');
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
    for (const intervalMs of [100, 33, 8]) {
      const workload = intervalMs === 8 ? 'redraw' : 'typing';
      const plan = imageExperimentOfferPlan(durationMs + warmupMs, intervalMs);
      let referencePixels: Uint8Array | null = null;
      for (const [armIndex, arm] of (['webgl', 'webgpu', 'webgpu', 'webgl'] as const).entries()) {
        process.stderr.write(
          `GPU experiment ${browserName} ${workload}/${intervalMs} ${armIndex + 1}/4 ${arm}\n`,
        );
        const launchOptions = {
          headless,
          ...(browserName === 'chromium'
            ? { channel: 'chromium', args: ['--enable-automation', '--enable-gpu'] }
            : {}),
        };
        const browser = await browserType.launch(launchOptions);
        let observed: unknown = null;
        try {
          let executable = browserType.executablePath();
          if (browserName === 'chromium') {
            const cdp = await browser.newBrowserCDPSession();
            const command = await cdp.send('Browser.getBrowserCommandLine');
            const actual = command.arguments[0];
            if (typeof actual !== 'string') throw new Error('missing actual executable');
            executable = actual;
            await cdp.detach();
          }
          const page = await browser.newPage({
            viewport: { width: 1000, height: 700 },
            deviceScaleFactor: 2,
          });
          await page.goto(`http://127.0.0.1:${server.port}/`);
          await page.bringToFront();
          const result = await page.evaluate(
            async ({ arm, workload, plan }) => {
              const canvas = document.querySelector('canvas');
              if (canvas === null) throw new Error('missing canvas');
              const offscreen = canvas.transferControlToOffscreen();
              const focusEvents = [
                { atMs: performance.now(), focused: document.hasFocus(), reason: 'initial' },
              ];
              const onFocus = () =>
                focusEvents.push({
                  atMs: performance.now(),
                  focused: document.hasFocus(),
                  reason: 'focus-event',
                });
              window.addEventListener('focus', onFocus);
              window.addEventListener('blur', onFocus);
              const rafTimes: number[] = [];
              let rafHandle = 0;
              const frame = () => {
                rafTimes.push(performance.now());
                rafHandle = requestAnimationFrame(frame);
              };
              rafHandle = requestAnimationFrame(frame);
              await new Promise<void>((resolve) => setTimeout(resolve, 500));
              const periods = rafTimes
                .slice(1)
                .map((value, index) => value - (rafTimes[index] ?? value))
                .sort((a, b) => a - b);
              const periodMs = periods[Math.floor(periods.length / 2)];
              if (periodMs === undefined || periodMs < 2 || periodMs > 100)
                throw new Error('invalid refresh calibration');
              rafTimes.length = 0;
              const offers: Offer[] = [];
              const submitted: Submission[] = [];
              const completed: Completion[] = [];
              const worker = new Worker('/worker.js', { type: 'module' });
              let timer: ReturnType<typeof setTimeout> | undefined;
              let deadline: ReturnType<typeof setTimeout> | undefined;
              let visibilityChanged = false;
              const onVisibility = () => {
                visibilityChanged = true;
              };
              document.addEventListener('visibilitychange', onVisibility);
              let startAtMs = 0;
              let failure: string | null = null;
              let workerResult: WebGpuTerminalDone | null = null;
              let pixelsBase64 = '';
              const markerPixels: number[][] = [];
              try {
                workerResult = await new Promise<WebGpuTerminalDone>((resolve, reject) => {
                  deadline = setTimeout(
                    () => reject(new Error('GPU experiment timeout')),
                    (plan.at(-1) ?? 0) + 20_000,
                  );
                  let nextIndex = 0;
                  const offerNext = () => {
                    const target = plan[nextIndex];
                    if (target === undefined) {
                      worker.postMessage({ kind: 'finish' });
                      return;
                    }
                    const wait = startAtMs + target - performance.now();
                    if (wait > 0.2) {
                      timer = setTimeout(offerNext, wait);
                      return;
                    }
                    const ordinal = nextIndex + 1;
                    const offeredAtMs = performance.now();
                    offers.push({ ordinal, offeredAtMs, scheduledAtMs: startAtMs + target });
                    worker.postMessage({ kind: 'offer', ordinal, offeredAtMs });
                    nextIndex += 1;
                    timer = setTimeout(
                      offerNext,
                      Math.max(0, startAtMs + (plan[nextIndex] ?? target) - performance.now()),
                    );
                  };
                  worker.onerror = (event) => reject(new Error(event.message));
                  worker.onmessage = (event: MessageEvent<WebGpuTerminalMessage>) => {
                    const message = event.data;
                    const mainReceivedAtMs = performance.now();
                    switch (message.kind) {
                      case 'ready':
                        startAtMs = performance.now();
                        offerNext();
                        break;
                      case 'submitted':
                        submitted.push({ ...message, mainReceivedAtMs });
                        break;
                      case 'completed':
                        completed.push({ ...message, mainReceivedAtMs });
                        break;
                      case 'done':
                        resolve(message);
                        break;
                      case 'error':
                        reject(new Error(message.message));
                        break;
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
                // This software-pixel check occurs outside all timed populations.
                await new Promise<void>((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                );
                const diagnostic = document.createElement('canvas');
                diagnostic.width = 1600;
                diagnostic.height = 960;
                const context = diagnostic.getContext('2d', { willReadFrequently: true });
                if (context === null) throw new Error('diagnostic canvas unavailable');
                context.drawImage(canvas, 0, 0);
                for (const point of workerResult.expectedPixels)
                  markerPixels.push(Array.from(context.getImageData(point.x, point.y, 1, 1).data));
                const pixels = context.getImageData(0, 0, 1600, 960).data;
                const chunks: string[] = [];
                for (let i = 0; i < pixels.length; i += 32768)
                  chunks.push(String.fromCharCode(...pixels.subarray(i, i + 32768)));
                pixelsBase64 = btoa(chunks.join(''));
              } catch (error) {
                failure = error instanceof Error ? error.message : String(error);
              } finally {
                if (timer !== undefined) clearTimeout(timer);
                if (deadline !== undefined) clearTimeout(deadline);
                cancelAnimationFrame(rafHandle);
                document.removeEventListener('visibilitychange', onVisibility);
                window.removeEventListener('focus', onFocus);
                window.removeEventListener('blur', onFocus);
                worker.postMessage({ kind: 'shutdown' });
                await new Promise<void>((resolve) => setTimeout(resolve, 10));
                worker.terminate();
              }
              return {
                workerResult,
                failure,
                offers,
                submitted,
                completed,
                rafTimes,
                startAtMs,
                periodMs,
                visibilityChanged,
                visibility: document.visibilityState,
                dpr: devicePixelRatio,
                focusEvents,
                finalFocus: document.hasFocus(),
                pixelsBase64,
                markerPixels,
              };
            },
            { arm, workload, plan },
          );
          const { pixelsBase64, ...raw } = result;
          observed = raw;
          if (raw.failure !== null || raw.workerResult === null)
            throw new Error(raw.failure ?? 'missing worker result');
          const counts = raw.workerResult;
          const errors: string[] = [];
          if (counts.expectedPixels.length !== 120 || raw.markerPixels.length !== 120)
            errors.push('incomplete independent pixel oracle');
          if (
            counts.receivedCount !== plan.length ||
            counts.offeredCount !== plan.length ||
            counts.submittedCount !== raw.submitted.length ||
            counts.completedCount !== raw.completed.length ||
            counts.submittedCount !== counts.completedCount ||
            counts.submittedCount + counts.coalescedCount !== plan.length ||
            counts.lastOrdinal !== plan.length ||
            counts.maxOutstanding < 1 ||
            counts.maxOutstanding > 2
          )
            errors.push('count/queue ownership mismatch');
          if (raw.visibilityChanged || raw.visibility !== 'visible')
            errors.push('visibility changed');
          const ownership = new Map(raw.submitted.map((sample) => [sample.ordinal, sample]));
          if (ownership.size !== raw.submitted.length) errors.push('duplicate submission');
          for (const sample of raw.completed) {
            const submit = ownership.get(sample.ordinal);
            if (
              submit === undefined ||
              submit.rendererSubmissionId !== sample.rendererSubmissionId ||
              submit.offeredAtMs !== sample.offeredAtMs ||
              submit.renderEndAtMs !== sample.renderEndAtMs
            )
              errors.push('completion owner mismatch');
          }
          for (const sample of raw.submitted)
            if (raw.offers[sample.ordinal - 1]?.offeredAtMs !== sample.offeredAtMs)
              errors.push('offer owner mismatch');
          for (const [row, expected] of counts.expectedPixels.entries()) {
            const pixel = raw.markerPixels[row];
            if (
              pixel === undefined ||
              pixel.some((value, index) => Math.abs(value - (expected.rgba[index] ?? -1000)) > 1)
            )
              errors.push(`row ${row} marker mismatch`);
          }
          const pixels = Buffer.from(pixelsBase64, 'base64');
          if (pixels.length !== 1600 * 960 * 4) throw new Error('incomplete final image');
          if (referencePixels === null && arm === 'webgl') referencePixels = pixels;
          if (referencePixels === null) throw new Error('missing WebGL pixel reference');
          const pixelComparison = compareGpuPixels(referencePixels, pixels);
          if (pixelComparison.aboveTolerance !== 0)
            errors.push('full-image pixel mismatch (>1 per channel)');
          const firstMeasuredOrdinal = Math.ceil(warmupMs / intervalMs) + 1;
          const offers = raw.offers.filter((value) => value.ordinal >= firstMeasuredOrdinal);
          const submissions = raw.submitted.filter(
            (value) => value.ordinal >= firstMeasuredOrdinal,
          );
          const completions = raw.completed.filter(
            (value) => value.ordinal >= firstMeasuredOrdinal,
          );
          const timingErrors = qualifyGpuOfferCadence(offers);
          if (raw.focusEvents.some((event) => !event.focused) || !raw.finalFocus)
            timingErrors.push('benchmark document lost focus');
          const summary = {
            offered: offers.length,
            submitted: submissions.length,
            offerLatenessMs: summarizeImageExperiment(
              offers.map((value) => Math.max(0, value.offeredAtMs - value.scheduledAtMs)),
            ),
            offerToCoveringSubmissionNoticeMs: summarizeImageExperiment(
              coveringNoticeDurations(offers, raw.submitted),
            ),
            offerToCoveringCompletionNoticeMs: summarizeImageExperiment(
              coveringNoticeDurations(offers, raw.completed),
            ),
            scheduledToCoveringCompletionNoticeMs: summarizeImageExperiment(
              coveringNoticeDurations(
                offers.map((offer) => ({ ...offer, offeredAtMs: offer.scheduledAtMs })),
                raw.completed,
              ),
            ),
            workerWaitMs: summarizeImageExperiment(
              submissions.map((value) => value.renderStartAtMs - value.receivedAtMs),
            ),
            renderCpuMs: summarizeImageExperiment(
              submissions.map((value) => value.renderEndAtMs - value.renderStartAtMs),
            ),
            completionRegistrationCpuMs: summarizeImageExperiment(
              submissions.map((value) => value.completionTrackingEndAtMs - value.renderEndAtMs),
            ),
            submitAndTrackCpuMs: summarizeImageExperiment(
              submissions.map((value) => value.completionTrackingEndAtMs - value.renderStartAtMs),
            ),
            observedGpuCompletionMs: summarizeImageExperiment(
              completions.map((value) => value.completedAtMs - value.renderEndAtMs),
            ),
            completionNoticeGapMs: summarizeImageExperiment(
              completions
                .slice(1)
                .map(
                  (value, index) =>
                    value.mainReceivedAtMs -
                    (completions[index]?.mainReceivedAtMs ?? value.mainReceivedAtMs),
                ),
            ),
          };
          const cell = {
            arm,
            armIndex,
            workload,
            intervalMs,
            browserVersion: browser.version(),
            executable,
            executableSha256: createHash('sha256')
              .update(await Bun.file(executable).bytes())
              .digest('hex'),
            launchOptions,
            integrityErrors: errors,
            timingErrors,
            timingEligible: errors.length === 0 && timingErrors.length === 0,
            pixelHash: createHash('sha256').update(pixels).digest('hex'),
            pixelComparison,
            ...raw,
            summary,
          };
          cells.push(cell);
          if (errors.length !== 0 || timingErrors.length !== 0) process.exitCode = 1;
          if (errors.length === 0 && timingErrors.length === 0) {
            for (const [boundary, distribution] of [
              ['offer-to-covering-submission-notice', summary.offerToCoveringSubmissionNoticeMs],
              ['offer-to-covering-completion-notice', summary.offerToCoveringCompletionNoticeMs],
              ['observed-gpu-completion', summary.observedGpuCompletionMs],
            ] as const) {
              if (distribution.p95 !== null)
                emitPerfMetric({
                  name: `component-${browserName}-${arm}-${intervalMs}ms-${boundary}`,
                  value: distribution.p95,
                  unit: 'ms',
                  direction: 'lower',
                  percentile: 0.95,
                  sampleSize: distribution.count,
                });
            }
          }
          process.stderr.write(
            `${JSON.stringify({ arm, intervalMs, summary, counts, errors, timingErrors, pixelComparison })}\n`,
          );
        } catch (error) {
          cells.push({
            arm,
            armIndex,
            workload,
            intervalMs,
            error: error instanceof Error ? error.message : String(error),
            raw: observed,
          });
          process.exitCode = 1;
        } finally {
          await browser.close();
        }
      }
    }
    const outputPath =
      process.env.GPU_EXPERIMENT_OUTPUT ??
      resolve(tmpdir(), `merkur-webgpu-${browserName}-${Date.now()}.json`);
    await Bun.write(
      outputPath,
      `${JSON.stringify(
        {
          boundary:
            'Direct-canvas component experiment with matched two-completion capacity and latest-state scheduler. Main notices and worker observed GPU completion are NOT compositor presentation or physical paint. No PTY, network or speculation.',
          checkpoint,
          candidateSourceArchive: HISTORICAL_TWO_CREDIT_WEBGL,
          closure,
          workerBundleSha256: createHash('sha256').update(source).digest('hex'),
          runnerSha256: createHash('sha256')
            .update(await Bun.file(import.meta.path).bytes())
            .digest('hex'),
          browser: browserName,
          headless,
          platform: platform(),
          arch: arch(),
          runtime: Bun.version,
          durationMs,
          warmupMs,
          dimensions: [1600, 960],
          schedule:
            'open-loop ABBA; fresh browser per cell; all offered states retained in coverage metrics',
          cells,
        },
        null,
        2,
      )}\n`,
    );
    process.stderr.write(`Raw GPU experiment report: ${outputPath}\n`);
  } finally {
    await server.stop(true);
  }
}

if (import.meta.main) await run();
