import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { emitPerfMetric, summarizeSamples } from './perf/harness';

const samples = Number(process.env.ROW_LAYOUT_SAMPLES ?? 12);
const output =
  process.env.ROW_LAYOUT_OUTPUT ??
  resolve(tmpdir(), `merkur-row-layout-${Date.now()}-${process.pid}.json`);
if (!Number.isSafeInteger(samples) || samples < 2 || samples > 100)
  throw new Error('ROW_LAYOUT_SAMPLES must be 2..100');
const build = await Bun.build({
  entrypoints: ['scripts/perf/row-layout-worker.ts'],
  target: 'browser',
  format: 'esm',
});
if (!build.success || build.outputs.length !== 1) throw new Error(String(build.logs));
const workerSource = await build.outputs[0]?.text();
if (workerSource === undefined) throw new Error('missing worker');
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    return new URL(request.url).pathname === '/worker.js'
      ? new Response(workerSource, {
          headers: {
            'content-type': 'text/javascript',
            'cross-origin-resource-policy': 'same-origin',
            'cross-origin-embedder-policy': 'require-corp',
          },
        })
      : new Response(
          '<!doctype html><style>canvas{display:block;max-width:95vw;max-height:95vh}</style><body>',
          {
            headers: {
              'content-type': 'text/html',
              'cross-origin-opener-policy': 'same-origin',
              'cross-origin-embedder-policy': 'require-corp',
            },
          },
        );
  },
});
const browser = await chromium.launch({ channel: 'chromium', headless: false });
const cells = [];
let failure: string | null = null;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.bringToFront();
  for (const [cols, rows] of [
    [80, 24],
    [160, 48],
    [320, 100],
  ] as const) {
    for (const workload of [
      'top-cardinality',
      'scattered',
      'redraw',
      'skewed-cardinality',
    ] as const) {
      const measured = await page.evaluate(
        async ({ cols, rows, workload, samples }) => {
          type Request = import('./perf/row-layout-worker').RowLayoutRequest;
          type Sample = {
            cpuMs: number;
            completionMs: number;
            uploadBytes: number;
            cpuCopyBytes: number;
            uploadCalls: number;
            instances: number;
          };
          const results: {
            arm: Request['arm'];
            results: Sample[];
            identity: unknown;
            retainedGeometryBytes: number;
            mismatchedChannels: number;
          }[] = [];
          let reference: Uint8Array | null = null;
          for (const arm of ['flat', 'slabs', 'slabs', 'flat'] as const) {
            const host = document.createElement('canvas');
            host.width = cols * 8;
            host.height = rows * 16;
            document.body.append(host);
            const canvas = host.transferControlToOffscreen();
            const worker = new Worker('/worker.js', { type: 'module' });
            try {
              const value = await new Promise<{
                ok: true;
                results: Sample[];
                identity: unknown;
                retainedGeometryBytes: number;
                pixels: ArrayBuffer;
              }>((resolve, reject) => {
                const timeout = setTimeout(
                  () => reject(new Error('row layout component timed out after 30 seconds')),
                  30_000,
                );
                worker.onerror = (event) => {
                  clearTimeout(timeout);
                  reject(new Error(event.message));
                };
                worker.onmessage = (event) => {
                  clearTimeout(timeout);
                  const result = event.data;
                  if (!result.ok) reject(new Error(result.error));
                  else resolve(result);
                };
                worker.postMessage(
                  { canvas, cols, rows, arm, workload, samples } satisfies Request,
                  [canvas],
                );
              });
              const pixels = new Uint8Array(value.pixels);
              let mismatchedChannels = 0;
              if (reference === null) reference = pixels;
              else {
                if (reference.byteLength !== pixels.byteLength)
                  throw new Error('pixel size mismatch');
                for (let i = 0; i < pixels.length; i += 1)
                  if (Math.abs((reference[i] ?? 0) - (pixels[i] ?? 0)) > 1) mismatchedChannels += 1;
              }
              if (mismatchedChannels > 0)
                throw new Error(`${arm}: ${mismatchedChannels} pixel channels differ`);
              results.push({
                arm,
                results: value.results,
                identity: value.identity,
                retainedGeometryBytes: value.retainedGeometryBytes,
                mismatchedChannels,
              });
            } finally {
              worker.terminate();
              host.remove();
            }
          }
          return results;
        },
        { cols, rows, workload, samples },
      );
      for (const [repetition, value] of measured.entries()) {
        const summary = {
          cols,
          rows,
          workload,
          arm: value.arm,
          repetition,
          cpu: summarizeSamples(value.results.map((sample) => sample.cpuMs)),
          completion: summarizeSamples(value.results.map((sample) => sample.completionMs)),
          retainedGeometryBytes: value.retainedGeometryBytes,
          meanUploadBytes:
            value.results.reduce((sum, sample) => sum + sample.uploadBytes, 0) / samples,
          meanCopyBytes:
            value.results.reduce((sum, sample) => sum + sample.cpuCopyBytes, 0) / samples,
          meanUploadCalls:
            value.results.reduce((sum, sample) => sum + sample.uploadCalls, 0) / samples,
          instances: value.results.at(-1)?.instances,
          identity: value.identity,
          mismatchedChannels: value.mismatchedChannels,
        };
        process.stdout.write(`${JSON.stringify(summary)}\n`);
        for (const [boundary, distribution] of [
          ['cpu', summary.cpu],
          ['queue-completion', summary.completion],
        ] as const)
          for (const [percentile, label, value] of [
            [0.5, 'p50', distribution.median],
            [0.95, 'p95', distribution.p95],
            [0.99, 'p99', distribution.p99],
          ] as const)
            emitPerfMetric({
              name: `row-layout-${cols}x${rows}-${workload}-${summary.arm}-${repetition}-${boundary}-${label}`,
              value,
              unit: 'ms/frame',
              percentile,
              sampleSize: samples,
              direction: 'lower',
            });
        cells.push({ ...summary, samples: value.results });
      }
    }
  }
} catch (error) {
  failure = String(error);
  throw error;
} finally {
  await browser.close();
  server.stop(true);
  await Bun.write(
    output,
    JSON.stringify(
      {
        boundary:
          'Matched isolated geometry-storage component. One exact queue completion awaited per sample; no paint, open-loop, network or full-terminal claim. Same glyph shader/layout both arms; no decorations/IME/prediction. Five warmups per arm, ABBA, all failures fatal.',
        workerSha256: createHash('sha256').update(workerSource).digest('hex'),
        layout: 'exact-column-stride',
        failure,
        cells,
        maximumSlabBytes: {
          glyph: 512 * 192 * 56,
          background: 512 * 192 * 28,
          decorations: 512 * 192 * 8 * 28,
        },
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Row-layout raw evidence: ${output}\n`);
}
