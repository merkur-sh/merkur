import { afterEach, describe, expect, test } from 'bun:test';
import {
  authenticatedRequestHeaders,
  EventStreamHttpError,
  EventStreamTooLargeError,
  MAX_SSE_EVENT_CHARS,
  readEventStream,
  type SseEvent,
} from './authenticated-transport';

/** Read one stream the way the event-stream worker does, collecting its events. */
function openStream(
  accessToken: string,
  path: string,
  onEvent: (event: SseEvent) => void = () => {},
): Promise<void> {
  return readEventStream(
    path,
    { signal: new AbortController().signal, headers: authenticatedRequestHeaders(accessToken) },
    {
      onOpen: () => {},
      onChunk: (events) => {
        for (const event of events) onEvent(event);
      },
    },
  );
}

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

afterEach(() => {
  if (originalFetch === undefined) {
    Reflect.deleteProperty(globalThis, 'fetch');
  } else {
    Object.defineProperty(globalThis, 'fetch', originalFetch);
  }
});

describe('authenticated event stream', () => {
  test('preserves a definitive HTTP status for side-effect policy', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: (async () => new Response(null, { status: 401 })) as unknown as typeof fetch,
    });

    const error = await openStream('token', 'https://merkur.test/events').catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(EventStreamHttpError);
    expect((error as EventStreamHttpError).status).toBe(401);
  });

  test('streams complete events and keeps authentication on the request', async () => {
    const captured = { request: null as Request | null };
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: (async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.request = new Request(input, init);
        return new Response('event: devices\ndata: []\n\n', { status: 200 });
      }) as typeof fetch,
    });
    const events: Array<{ event: string; data: string }> = [];

    await openStream('access-token', 'https://merkur.test/events', (event) => events.push(event));

    expect(captured.request?.headers.get('authorization')).toBe('Bearer access-token');
    expect(events).toEqual([{ event: 'devices', data: '[]' }]);
  });

  /**
   * The failure this line prevents is silent on both sides. A browser gives a
   * cache entry one writer and blocks every other request for that key behind
   * it; a stream that never ends never releases it, so the next page's request
   * sat with no headers, no bytes, no error, and no arrival at the server for
   * 20.5 s — the browser's own lock timeout — while the machine list waited.
   * Nothing here is cacheable, so the entry that created the lock had no reason
   * to exist. A refactor that drops this init would restore that exactly, and
   * nothing else in the suite would notice.
   */
  test('never enters the HTTP cache, so no other request can queue behind it', async () => {
    const captured = { request: null as Request | null };
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: (async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.request = new Request(input, init);
        return new Response('event: devices\ndata: []\n\n', { status: 200 });
      }) as typeof fetch,
    });

    await openStream('access-token', 'https://merkur.test/events');

    expect(captured.request?.cache).toBe('no-store');
  });

  test('incrementally parses an event split across many tiny chunks', async () => {
    const encoded = new TextEncoder().encode('event: devices\ndata: [1,2,3]\n\n');
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    const events: Array<{ event: string; data: string }> = [];

    await openStream('token', 'https://merkur.test/events', (event) => events.push(event));

    expect(events).toEqual([{ event: 'devices', data: '[1,2,3]' }]);
  });

  test('rejects a delimiter-starved event at the memory bound', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: (async () =>
        new Response(`data: ${'x'.repeat(MAX_SSE_EVENT_CHARS)}`, {
          status: 200,
        })) as unknown as typeof fetch,
    });

    const error = await openStream('token', 'https://merkur.test/events').catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(EventStreamTooLargeError);
  });
});
