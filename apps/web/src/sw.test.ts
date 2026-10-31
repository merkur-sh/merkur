import { expect, test } from 'bun:test';

interface Scenario {
  readonly navigation?: boolean;
  readonly cacheHit?: boolean;
  readonly putFails?: boolean;
  readonly networkFails?: boolean;
  readonly preload?: boolean;
  readonly status?: number;
  readonly installFails?: boolean;
}

interface Result {
  readonly status: number;
  readonly body: number[];
  readonly header: string | null;
  readonly fetches: number;
  readonly puts: number;
  readonly stored: number[];
  readonly install: string;
  readonly activations: number;
}

async function exercise(scenario: Scenario): Promise<Result> {
  const source = `
    const scenario = ${JSON.stringify(scenario)};
    const listeners = new Map();
    let fetches = 0, puts = 0, activations = 0, stored = [];
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const response = () => new Response(bytes, {
      status: scenario.status ?? 200, headers: { 'X-Shell': 'original' },
    });
    globalThis.addEventListener = (kind, listener) => listeners.set(kind, listener);
    globalThis.location = { origin: 'https://app.merkur.test' };
    globalThis.skipWaiting = async () => { activations++; };
    globalThis.caches = { async open() { return {
      async match() { return scenario.cacheHit ? response() : undefined; },
      async put(key, value) {
        puts++;
        if (scenario.putFails) throw new DOMException('full', 'QuotaExceededError');
        stored = Array.from(new Uint8Array(await value.arrayBuffer()));
      },
      async addAll() {
        if (scenario.installFails) throw new DOMException('full', 'QuotaExceededError');
      },
    }; } };
    globalThis.fetch = async () => {
      fetches++;
      if (scenario.networkFails) throw new TypeError('unreachable');
      return response();
    };
    await import(${JSON.stringify(new URL('./sw.ts', import.meta.url).href)});
    let installation;
    listeners.get('install')({ waitUntil(promise) { installation = promise; } });
    const install = await installation.then(() => 'complete', () => 'rejected');
    const request = new Request('https://app.merkur.test/shell.js');
    if (scenario.navigation) Object.defineProperty(request, 'mode', { value: 'navigate' });
    let delivery;
    listeners.get('fetch')({
      request,
      preloadResponse: Promise.resolve(scenario.preload ? response() : undefined),
      respondWith(promise) { delivery = promise; },
    });
    const delivered = await delivery;
    postMessage({ status: delivered.status,
      body: Array.from(new Uint8Array(await delivered.arrayBuffer())),
      header: delivered.headers.get('X-Shell'), fetches, puts, stored, install, activations });
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
  try {
    return await new Promise<Result>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<Result>) => resolve(event.data);
      worker.onerror = (event: ErrorEvent) => reject(new Error(event.message));
    });
  } finally {
    worker.terminate();
  }
}

for (const navigation of [false, true]) {
  const lane = navigation ? 'navigation' : 'asset';
  for (const [name, scenario, status, fetches, puts] of [
    ['quota', { putFails: true }, 200, 1, 1],
    ['publication', {}, 200, 1, 1],
    ['hit', { cacheHit: true }, 200, 0, 0],
    ['offline', { networkFails: true }, 503, 1, 0],
    ['http error', { status: 404 }, 404, 1, 0],
  ] as const) {
    test(`cache_write_failure ${lane} ${name}`, async () => {
      const result = await exercise({ navigation, ...scenario });
      expect(result.status).toBe(status);
      expect(result.fetches).toBe(fetches);
      expect(result.puts).toBe(puts);
      expect(result.body).toEqual(
        name === 'offline'
          ? Array.from(new TextEncoder().encode('Offline'))
          : [0, 1, 127, 128, 255],
      );
      expect(result.header).toBe(name === 'offline' ? null : 'original');
      expect(result.stored).toEqual(name === 'publication' ? [0, 1, 127, 128, 255] : []);
    });
  }
}

test('cache_write_failure navigation preload survives quota without a duplicate fetch', async () => {
  const result = await exercise({ navigation: true, preload: true, putFails: true });
  expect(result.status).toBe(200);
  expect(result.body).toEqual([0, 1, 127, 128, 255]);
  expect(result.header).toBe('original');
  expect(result.fetches).toBe(0);
  expect(result.puts).toBe(1);
});

test('cache_write_failure install still requires the complete manifest and never skips waiting', async () => {
  for (const installFails of [false, true]) {
    const result = await exercise({ installFails });
    expect(result.install).toBe(installFails ? 'rejected' : 'complete');
    expect(result.activations).toBe(0);
  }
});
