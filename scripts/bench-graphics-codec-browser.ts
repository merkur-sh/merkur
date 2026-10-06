// Run the generated corpus in an isolated module worker in each browser engine.
import path from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';

const root = path.resolve(import.meta.dir, '..');
const fixtures = path.join(root, 'test-results/graphics-codec-fixtures');
const built = await Bun.build({
  entrypoints: [path.join(import.meta.dir, './bench-graphics-codec-worker.ts')],
  target: 'browser',
});
const output = built.outputs[0];
if (!built.success || output === undefined)
  throw new Error(`worker build: ${built.logs.join('\n')}`);
const worker = await output.text();
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    };
    if (url.pathname === '/')
      return new Response('<!doctype html><title>Tile codec measurement</title>', { headers });
    if (url.pathname === '/worker.js')
      return new Response(worker, { headers: { ...headers, 'Content-Type': 'text/javascript' } });
    if (url.pathname === '/graphics_codec_probe_bg.wasm') {
      return new Response(
        Bun.file(path.join(root, 'packages/graphics-codec-probe/pkg/graphics_codec_probe_bg.wasm')),
        { headers },
      );
    }
    if (url.pathname === '/graphics_wasm_bg.wasm') {
      return new Response(
        Bun.file(path.join(root, 'packages/graphics-wasm/pkg/graphics_wasm_bg.wasm')),
        { headers },
      );
    }
    if (/^\/fixtures\/[a-z0-9.-]+$/.test(url.pathname)) {
      return new Response(Bun.file(path.join(fixtures, url.pathname.slice('/fixtures/'.length))), {
        headers,
      });
    }
    return new Response(null, { status: 404 });
  },
});
const results = [];
try {
  for (const engine of [chromium, firefox, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.goto(server.url.href);
      const result = await page.evaluate(
        () =>
          new Promise<unknown>((resolve, reject) => {
            const worker = new Worker('/worker.js', { type: 'module' });
            worker.onerror = (event) => {
              worker.terminate();
              reject(new Error(event.message));
            };
            worker.onmessage = (event: MessageEvent<unknown>) => {
              worker.terminate();
              resolve(event.data);
            };
            worker.postMessage(null);
          }),
      );
      if (typeof result !== 'object' || result === null || 'error' in result) {
        throw new Error(`worker failed: ${JSON.stringify(result)}`);
      }
      results.push({ engine: engine.name(), result });
      process.stdout.write(`${JSON.stringify(results.at(-1))}\n`);
    } finally {
      await browser.close();
    }
  }
  await Bun.write(
    path.join(root, 'test-results/graphics-codec-browser.json'),
    JSON.stringify(results, null, 2),
  );
} finally {
  await server.stop(true);
}
