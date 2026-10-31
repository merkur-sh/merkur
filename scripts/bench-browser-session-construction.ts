import { chromium, firefox, webkit } from '@playwright/test';
import type { BrowserSessionConstructionResult } from './perf/browser-session-construction';

const snapshotIndex = process.argv.indexOf('--snapshot');
const snapshot = snapshotIndex < 0 ? undefined : process.argv[snapshotIndex + 1];
const saveIndex = process.argv.indexOf('--save');
const save = saveIndex < 0 ? undefined : process.argv[saveIndex + 1];
let source: string;
let wasmBytes: ArrayBuffer;
if (snapshot !== undefined) {
  source = await Bun.file(`${snapshot}/proof.js`).text();
  wasmBytes = await Bun.file(`${snapshot}/e2e_wasm_bg.wasm`).arrayBuffer();
} else {
  const build = await Bun.build({
    entrypoints: ['scripts/perf/browser-session-construction.ts'],
    target: 'browser',
    format: 'esm',
  });
  const output = build.outputs[0];
  if (!build.success || build.outputs.length !== 1 || output === undefined)
    throw new Error(String(build.logs));
  source = await output.text();
  wasmBytes = await Bun.file('packages/e2e-wasm/pkg/e2e_wasm_bg.wasm').arrayBuffer();
}
if (save !== undefined) {
  await Bun.write(`${save}/proof.js`, source);
  await Bun.write(`${save}/e2e_wasm_bg.wasm`, wasmBytes);
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/proof.js')
      return new Response(source, { headers: { 'content-type': 'text/javascript' } });
    if (path === '/wasm')
      return new Response(wasmBytes, { headers: { 'content-type': 'application/wasm' } });
    return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
  },
});
try {
  for (const [engine, type] of [
    ['chromium', chromium],
    ['firefox', firefox],
    ['webkit', webkit],
  ] as const) {
    if (process.env.BENCH_ENGINE !== undefined && process.env.BENCH_ENGINE !== engine) continue;
    const browser = await type.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.port}`);
      const result: BrowserSessionConstructionResult = await page.evaluate(async () => {
        const url = '/proof.js';
        const proof = await import(url);
        return await proof.run();
      });
      process.stdout.write(`${engine} ${JSON.stringify(result)}\n`);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.stop(true);
}
