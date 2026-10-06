import { chromium } from '@playwright/test';
import type { CompletionObserverRequest } from './perf/completion-observer-worker';
import { summarizeSamples } from './perf/harness';

// Optional first argument preserves complete raw arms; stdout stays summaries.
const outputPath = process.argv[2];
const records: string[] = [];

const build = await Bun.build({
  entrypoints: ['scripts/perf/completion-observer-worker.ts'],
  target: 'browser',
  format: 'esm',
});
if (!build.success || build.outputs.length !== 1) throw new Error(String(build.logs));
const source = await build.outputs[0]?.text();
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
  for (const dense of [false, true])
    for (const sentinel of [false, true, true, false]) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.port}`);
      const raw = await page.evaluate(
        async ({ dense, sentinel }) => {
          const host = document.createElement('canvas');
          host.width = 800;
          host.height = 600;
          document.body.append(host);
          const canvas = host.transferControlToOffscreen();
          const worker = new Worker('/worker.js', { type: 'module' });
          try {
            return await new Promise<{
              error?: string;
              samples: {
                revision: number;
                cpuMs: number;
                submittedAt: number;
                queueObservedAt: number;
                mapObservedAt: number | null;
              }[];
            }>((resolve, reject) => {
              worker.onmessage = (event) => resolve(event.data);
              worker.onerror = (event) => reject(new Error(event.message));
              worker.postMessage(
                {
                  canvas,
                  sentinel,
                  dense,
                  offers: 180,
                  periodMs: 10,
                } satisfies CompletionObserverRequest,
                [canvas],
              );
            });
          } finally {
            worker.terminate();
          }
        },
        { dense, sentinel },
      );
      if (raw.error) throw new Error(raw.error);
      if (
        raw.samples.at(-1)?.revision !== 180 ||
        raw.samples.some((s) => !s.queueObservedAt || (sentinel && s.mapObservedAt === null))
      )
        throw new Error('missing completion sample');
      const record = {
        dense,
        sentinel,
        queue: summarizeSamples(raw.samples.map((s) => s.queueObservedAt - s.submittedAt)),
        map: sentinel
          ? summarizeSamples(
              raw.samples.flatMap((s) =>
                s.mapObservedAt === null ? [] : [s.mapObservedAt - s.submittedAt],
              ),
            )
          : null,
        queueMinusMap: sentinel
          ? summarizeSamples(
              raw.samples.flatMap((s) =>
                s.mapObservedAt === null ? [] : [s.queueObservedAt - s.mapObservedAt],
              ),
            )
          : null,
        cpu: summarizeSamples(raw.samples.map((s) => s.cpuMs)),
        raw,
      };
      const { raw: _raw, ...summary } = record;
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      if (outputPath) {
        records.push(JSON.stringify(record));
        await Bun.write(outputPath, `${records.join('\n')}\n`);
      }
      await page.close();
    }
} finally {
  await browser.close();
  server.stop(true);
}
