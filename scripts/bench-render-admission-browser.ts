import { chromium } from '@playwright/test';
import { summarizeSamples } from './perf/harness';
import type { RenderAdmissionBrowserRequest } from './perf/render-admission-browser-worker';

const build = await Bun.build({
  entrypoints: ['scripts/perf/render-admission-browser-worker.ts'],
  target: 'browser',
  format: 'esm',
});
if (!build.success || build.outputs.length !== 1) throw new Error(String(build.logs));
const source = await build.outputs[0]?.text();
const burst = process.argv.includes('--burst');
const sourceHashes: Record<string, string> = {};
for (const path of [
  'apps/web/src/terminal/render-mailbox.ts',
  'apps/web/src/renderer-webgpu.ts',
  'scripts/perf/render-admission-browser-worker.ts',
])
  sourceHashes[path] = new Bun.CryptoHasher('sha256')
    .update(await Bun.file(path).arrayBuffer())
    .digest('hex');
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    return new URL(request.url).pathname === '/worker.js'
      ? new Response(source, { headers: { 'content-type': 'text/javascript' } })
      : new Response('<!doctype html><body>', { headers: { 'content-type': 'text/html' } });
  },
});
const browser = await chromium.launch({
  channel: 'chromium',
  headless: true,
  args: ['--enable-gpu'],
});
try {
  for (const delayMs of [0, 100])
    for (const dense of [false, true])
      for (const arm of [
        'historical-two',
        'opportunity',
        'opportunity',
        'historical-two',
      ] as const) {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.port}`);
        const raw = await page.evaluate(
          async ({ arm, dense, delayMs, burst }) => {
            const host = document.createElement('canvas');
            host.width = 800;
            host.height = 600;
            document.body.append(host);
            const canvas = host.transferControlToOffscreen();
            const worker = new Worker('/worker.js', { type: 'module' });
            try {
              const result = await new Promise<{
                offered: number[];
                due: number[];
                submitted: number[];
                gpuObserved: number[];
                callbackObserved: number[];
                cpu: number[];
                lastSubmitted: number;
                error?: string;
              }>((resolve, reject) => {
                worker.onmessage = (event) => resolve(event.data);
                worker.onerror = (event) => reject(new Error(event.message));
                worker.postMessage(
                  {
                    canvas,
                    arm,
                    dense,
                    delayMs,
                    offers: 120,
                    periodMs: 10,
                    burst,
                  } satisfies RenderAdmissionBrowserRequest,
                  [canvas],
                );
              });
              if (result.error) throw new Error(result.error);
              if (
                result.submitted.length !== 120 ||
                result.gpuObserved.length !== 120 ||
                result.lastSubmitted !== 120
              )
                throw new Error('missing offered revision, cannot drop tail samples');
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              );
              const readback = new OffscreenCanvas(800, 600);
              const context = readback.getContext('2d');
              if (!context) throw new Error('pixel oracle unavailable');
              context.drawImage(host, 0, 0);
              const pixels = context.getImageData(0, 0, 800, 600).data;
              let pixelError: string | null = null;
              for (let row = 0; row < 30; row++) {
                const offset = (row * 20 + 10) * 800 * 4;
                const expected = dense || row === 0 ? 120 : 0;
                if (Math.abs((pixels[offset] ?? -999) - expected) > 1) {
                  pixelError = `final row ${row}: expected red ${expected}, got ${pixels[offset]}`;
                  break;
                }
              }
              return { ...result, pixelError };
            } finally {
              worker.terminate();
            }
          },
          { arm, dense, delayMs, burst },
        );
        const delta = (values: number[], base: number[]) =>
          values.map((value, index) => value - (base[index] ?? Number.NaN));
        process.stdout.write(
          `${JSON.stringify({
            arm,
            dense,
            delayMs,
            workload: burst ? 'six-offers-per-100ms-burst' : 'uniform-10ms',
            sourceHashes,
            boundary:
              'worker offer / submission / original queue observation / injected callback; not paint',
            submission: summarizeSamples(delta(raw.submitted, raw.offered)),
            originalCompletion: summarizeSamples(delta(raw.gpuObserved, raw.offered)),
            scheduledCompletion: summarizeSamples(delta(raw.gpuObserved, raw.due)),
            offerLateness: summarizeSamples(delta(raw.offered, raw.due)),
            cpu: summarizeSamples(raw.cpu),
            raw,
          })}\n`,
        );
        await page.close();
        if (raw.pixelError !== null) throw new Error(raw.pixelError);
      }
} finally {
  await browser.close();
  server.stop(true);
}
