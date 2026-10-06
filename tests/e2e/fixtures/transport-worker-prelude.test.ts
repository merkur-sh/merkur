import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { type BrowserContext, type Route, request } from '@playwright/test';
import {
  instrumentTransportWorker,
  redirectTransportWorker,
  transportWorkerPrelude,
} from './transport-worker-prelude';

const EDGE = {
  from: 44434,
  to: 44436,
  marker: '[edge]',
  label: 'edge proxy',
  candidate: 'edge',
} as const;
const DIRECT = {
  from: 50000,
  to: 50001,
  marker: '[direct]',
  label: 'direct proxy',
  candidate: 'direct backend',
} as const;

describe('transport worker redirects', () => {
  test('one prelude applies every redirect a context holds, each to its own port', () => {
    const calls: string[] = [];
    const messages: unknown[][] = [];
    runInNewContext(
      `${transportWorkerPrelude([EDGE, DIRECT])}
        new WebTransport('https://[::1]:44434/');
        new WebTransport('https://127.0.0.1:50000/session');
        new WebTransport('https://[::1]:44435/');
      `,
      {
        WebTransport: class {
          constructor(url: string) {
            calls.push(url);
          }
        },
        URL,
        console: { info: (...args: unknown[]) => messages.push(args) },
      },
    );
    // The edge's registered (daemon) listener becomes the browser's own; the
    // direct candidate becomes the outer direct hop; anything else is untouched.
    expect(calls).toEqual([
      'https://[::1]:44436/',
      'https://[::1]:50001/session',
      'https://[::1]:44435/',
    ]);
    expect(messages.map((message) => message[0])).toEqual(['[edge]', '[direct]']);
  });

  test('refuses overlapping or self-targeting redirects before installing any', () => {
    expect(() => transportWorkerPrelude([EDGE, { ...DIRECT, from: EDGE.from }])).toThrow(
      'two redirects from port 44434',
    );
    expect(() => transportWorkerPrelude([{ ...EDGE, to: EDGE.from }])).toThrow(
      'edge proxy cannot target itself',
    );
    expect(() => transportWorkerPrelude([{ ...EDGE, to: 80 }])).toThrow('invalid edge proxy port');
  });
});

test('carrier instrumentation and proxy routing share one worker response and independent lifetimes', async () => {
  const handlers: Array<(route: Route) => Promise<void>> = [];
  let removals = 0;
  const context = {
    async route(_url: RegExp, handler: (route: Route) => Promise<void>) {
      handlers.push(handler);
    },
    async unroute() {
      removals += 1;
    },
  } as unknown as BrowserContext;
  const redirect = await redirectTransportWorker(context, EDGE);
  const removeInstrument = await instrumentTransportWorker(
    context,
    `{
    const Parent = globalThis.WebTransport;
    globalThis.WebTransport = class extends Parent {
      constructor(url) { super(url); globalThis.observed += 1; }
    };
  }`,
  );
  expect(handlers).toHaveLength(1);
  let patched = '';
  let fetches = 0;
  const handler = handlers[0];
  if (handler === undefined) throw new Error('missing worker route');
  const route = {
    async fetch() {
      fetches += 1;
      return { ok: () => true, text: async () => "new WebTransport('https://[::1]:44434/');" };
    },
    request: () => ({
      url: () => 'https://test/assets/transport-worker.js',
      allHeaders: async () => ({}),
    }),
    async fulfill({ body }: { body: string }) {
      patched = body;
    },
  } as unknown as Route;
  // A worker-scoped daemon context legitimately serves more than four tests.
  for (let testIndex = 0; testIndex < 5; testIndex += 1) await handler(route);
  const dials: string[] = [];
  const sandbox = {
    WebTransport: class {
      constructor(url: string) {
        dials.push(url);
      }
    },
    URL,
    observed: 0,
    console: { info() {} },
  };
  runInNewContext(patched, sandbox);
  expect(fetches).toBe(5);
  expect(dials).toEqual(['https://[::1]:44436/']);
  expect(sandbox.observed).toBe(1);
  expect(redirect.sourceHashes).toHaveLength(5);
  await redirect.remove();
  expect(removals).toBe(0);
  await removeInstrument();
  expect(removals).toBe(1);
});

test('worker asset fetches close their sockets across loads and preserve request headers', async () => {
  const ports: number[] = [];
  const forwarded: Array<string | null> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, owner) {
      const peer = owner.requestIP(req);
      if (peer === null) throw new Error('missing HTTP peer');
      ports.push(peer.port);
      forwarded.push(req.headers.get('x-forwarded-for'));
      return new Response('globalThis.workerLoaded = true;', {
        headers: { 'content-type': 'text/javascript' },
      });
    },
  });
  // A named agent: Playwright builds its default one from a synchronous `sw_vers`, and no
  // test worker spawns synchronously (oven-sh/bun#34069).
  const client = await request.newContext({ userAgent: 'merkur-test' });
  const handlers: Array<(route: Route) => Promise<void>> = [];
  const context = {
    async route(_url: RegExp, handler: (route: Route) => Promise<void>) {
      handlers.push(handler);
    },
    async unroute() {},
  } as unknown as BrowserContext;
  try {
    const redirect = await redirectTransportWorker(context, EDGE);
    const handler = handlers[0];
    if (handler === undefined) throw new Error('missing worker route');
    const url = new URL('/assets/transport-worker.js', server.url).href;
    let fulfilled = 0;
    const route = {
      fetch: (options?: Parameters<Route['fetch']>[0]) => client.get(url, options),
      request: () => ({
        url: () => url,
        allHeaders: async () => ({ 'x-forwarded-for': '198.19.201.191' }),
      }),
      async fulfill({ body }: { body: string }) {
        expect(body).toContain('globalThis.workerLoaded = true;');
        fulfilled += 1;
      },
    } as unknown as Route;
    await handler(route);
    await handler(route);
    expect(fulfilled).toBe(2);
    expect(new Set(ports).size).toBe(2);
    expect(forwarded).toEqual(['198.19.201.191', '198.19.201.191']);
    await redirect.remove();
  } finally {
    await client.dispose();
    await server.stop(true);
  }
});
