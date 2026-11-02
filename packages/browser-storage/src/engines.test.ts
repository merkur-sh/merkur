import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import {
  type Browser,
  type BrowserType,
  chromium,
  firefox,
  type LaunchOptions,
  webkit,
} from '@playwright/test';

import type { ScenarioResult } from './conformance';
import type { PageConformance } from './conformance-page';

// `conformance.ts` in real engines. `fake-indexeddb` follows the specification;
// WebKit and Gecko have their own IndexedDB and web storage, and this is where
// a difference between them and the specification shows up.

const PAGE_ENTRY = fileURLToPath(new URL('./conformance-page.ts', import.meta.url));
const WORKER_ENTRY = fileURLToPath(new URL('./conformance-worker.ts', import.meta.url));

const ENGINES: readonly (readonly [string, BrowserType])[] = [
  ['Chromium', chromium],
  ['WebKit', webkit],
  ['Firefox', firefox],
];

/**
 * Firefox's processes each enter a macOS sandbox of their own, which Bazel's
 * sandbox does not permit (`sandbox_init() failed`). These are Firefox's own
 * switches for its process sandboxes; the storage it implements is unchanged.
 */
const FIREFOX_UNSANDBOXED = {
  MOZ_DISABLE_CONTENT_SANDBOX: '1',
  MOZ_DISABLE_GMP_SANDBOX: '1',
  MOZ_DISABLE_GPU_SANDBOX: '1',
  MOZ_DISABLE_RDD_SANDBOX: '1',
  MOZ_DISABLE_SOCKET_PROCESS_SANDBOX: '1',
  MOZ_DISABLE_UTILITY_SANDBOX: '1',
};

/** A browser launch and a first page take seconds; the scenarios themselves take less. */
const ENGINE_TIMEOUT_MS = 60_000;

const bundles = new Map<string, string>();
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(async () => {
  for (const [path, entry] of [
    ['/page.js', PAGE_ENTRY],
    ['/worker.js', WORKER_ENTRY],
  ] as const) {
    const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
    const output = build.outputs[0];
    if (!build.success || output === undefined) {
      throw new Error(`bundling ${entry} failed: ${build.logs.join('\n')}`);
    }
    bundles.set(path, await output.text());
  }
  server = Bun.serve({
    // A loopback origin is a secure context, as the app's own origin is.
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const bundle = bundles.get(path);
      if (bundle !== undefined) {
        return new Response(bundle, { headers: { 'content-type': 'text/javascript' } });
      }
      return new Response('<!doctype html><script type="module" src="/page.js"></script>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
});

afterAll(async () => {
  await server?.stop(true);
});

function origin(): string {
  if (server === null) throw new Error('the conformance server is not running');
  return `http://127.0.0.1:${server.port}/`;
}

/** Names each failed scenario with what it saw, so a red run says which and why. */
function failuresOf(results: readonly ScenarioResult[]): string[] {
  return results.flatMap((result) =>
    result.failure === null ? [] : [`${result.name}: ${result.failure}`],
  );
}

for (const [engine, browserType] of ENGINES) {
  describe(engine, () => {
    let browser: Browser | null = null;

    beforeAll(async () => {
      const options: LaunchOptions = { headless: true };
      if (browserType === firefox) options.env = { ...process.env, ...FIREFOX_UNSANDBOXED };
      browser = await browserType.launch(options);
    }, ENGINE_TIMEOUT_MS);

    afterAll(async () => {
      await browser?.close();
    });

    async function openPage() {
      if (browser === null) throw new Error(`${engine} did not launch`);
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(origin(), { waitUntil: 'load' });
      await page.waitForFunction(() => 'storageConformance' in globalThis);
      return { context, page };
    }

    test(
      'every scenario holds in a page',
      async () => {
        const { context, page } = await openPage();
        try {
          const results = await page.evaluate(() => {
            // SAFETY: `conformance-page.ts` installs `storageConformance`, and `openPage`
            // waited for it.
            const conformance = (
              globalThis as typeof globalThis & { storageConformance: PageConformance }
            ).storageConformance;
            return conformance.run();
          });
          expect(failuresOf(results)).toEqual([]);
          expect(results.length).toBeGreaterThan(10);
        } finally {
          await context.close();
        }
      },
      ENGINE_TIMEOUT_MS,
    );

    test(
      'every scenario holds in a dedicated worker',
      async () => {
        const { context, page } = await openPage();
        try {
          const results = await page.evaluate(
            () =>
              new Promise<ScenarioResult[]>((resolve, reject) => {
                const worker = new Worker('/worker.js', { type: 'module' });
                worker.onmessage = (event: MessageEvent<ScenarioResult[]>) => {
                  worker.terminate();
                  resolve(event.data);
                };
                worker.onerror = (event) => reject(new Error(event.message));
                worker.postMessage('run');
              }),
          );
          expect(failuresOf(results)).toEqual([]);
          expect(results.length).toBeGreaterThan(5);
        } finally {
          await context.close();
        }
      },
      ENGINE_TIMEOUT_MS,
    );

    /**
     * The guarantee a value with several writers stands on. Two pages of one
     * context share an origin's storage, as two tabs do, and each adds fifty
     * read-modify-writes to one counter at once. The same race over
     * `localStorage` under one Web Lock lost an update in Firefox, whose tabs
     * read `localStorage` from snapshots of their own.
     */
    test(
      'read-write transactions apply every change once when two tabs race on one record',
      async () => {
        if (browser === null) throw new Error(`${engine} did not launch`);
        const context = await browser.newContext();
        try {
          const pages = await Promise.all([context.newPage(), context.newPage()]);
          for (const page of pages) {
            await page.goto(origin(), { waitUntil: 'load' });
            await page.waitForFunction(() => 'storageConformance' in globalThis);
          }
          const database = `two-tabs-${crypto.randomUUID()}`;
          const increment = (page: (typeof pages)[number], times: number) =>
            page.evaluate(
              ({ name, count }) =>
                // SAFETY: `conformance-page.ts` installs `storageConformance`, and each page
                // waited for it before the race began.
                (
                  globalThis as typeof globalThis & { storageConformance: PageConformance }
                ).storageConformance.increment(name, count),
              { name: database, count: times },
            );
          await Promise.all(pages.map((page) => increment(page, 50)));
          const [first] = pages;
          if (first === undefined) throw new Error('no page opened');
          expect(await increment(first, 0)).toBe(100);
        } finally {
          await context.close();
        }
      },
      ENGINE_TIMEOUT_MS,
    );
  });
}
