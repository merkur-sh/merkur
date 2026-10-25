import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';

const originalFetch = globalThis.fetch;
let saveAccountTelemetry: typeof import('./api').saveAccountTelemetry;
let response = JSON.stringify({ enabled: true });
let status = 200;
let request: Request | null = null;

beforeAll(async () => {
  if (typeof globalThis.location === 'undefined') {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: { origin: 'https://merkur.test' },
    });
  }
  ({ saveAccountTelemetry } = await import('./api'));
});

beforeEach(() => {
  request = null;
  response = JSON.stringify({ enabled: true });
  status = 200;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(response, { status, headers: { 'content-type': 'application/json' } });
    },
    { preconnect: () => {} },
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sentRequest(): Request {
  if (request === null) throw new Error('request missing');
  return request;
}

test('saves account consent with an authenticated PUT and adopts the response', async () => {
  const abort = new AbortController();
  response = JSON.stringify({ enabled: false });
  expect(await saveAccountTelemetry('access-token', true, abort.signal)).toEqual({
    enabled: false,
  });
  const sent = sentRequest();
  expect(new URL(sent.url).pathname).toBe('/api/account/telemetry');
  expect(sent.method).toBe('PUT');
  expect(sent.headers.get('authorization')).toBe('Bearer access-token');
  expect(sent.headers.get('content-type')).toBe('application/json');
  expect(sent.credentials).toBe('include');
  expect(await sent.json()).toEqual({ enabled: true });
  abort.abort();
  expect(sent.signal.aborted).toBe(true);
});

test('sends false as the chosen value', async () => {
  expect(await saveAccountTelemetry('token', false, new AbortController().signal)).toEqual({
    enabled: true,
  });
  expect(await sentRequest().json()).toEqual({ enabled: false });
});

test('rejects responses outside the shared AccountTelemetry schema', async () => {
  for (const malformed of [
    null,
    {},
    true,
    { enabled: null },
    { enabled: 'true' },
    { enabled: true, extra: 1 },
  ]) {
    response = JSON.stringify(malformed);
    await expect(saveAccountTelemetry('token', true, new AbortController().signal)).rejects.toThrow(
      'Invalid account telemetry response',
    );
  }
});

test('a refused PUT fails instead of adopting a value', async () => {
  status = 503;
  response = JSON.stringify({ error: 'unavailable' });
  await expect(saveAccountTelemetry('token', true, new AbortController().signal)).rejects.toThrow(
    'API request failed: 503 unavailable',
  );
});
