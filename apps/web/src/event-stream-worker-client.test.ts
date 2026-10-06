import { afterAll, describe, expect, test } from 'bun:test';

import { openAuthenticatedEventStream } from './event-stream-worker-client';
import { EventStreamHttpError, type SseEvent } from './lib/authenticated-transport';

const encoder = new TextEncoder();
const seen: { authorization: string | null; since: string | null }[] = [];

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    seen.push({
      authorization: request.headers.get('authorization'),
      since: request.headers.get('x-since'),
    });
    if (path === '/unauthorized') return new Response(null, { status: 401 });
    if (path === '/open-ended') {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('event: first\ndata: 1\n\n'));
          },
        }),
      );
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(`:${' '.repeat(64)}\n\n`));
          await Bun.sleep(5);
          controller.enqueue(encoder.encode('event: presence\ndata: []\n\n'));
          await Bun.sleep(5);
          controller.enqueue(encoder.encode('event: snapshot\ndata: {"seq":0}\n\n'));
          controller.close();
        },
      }),
    );
  },
});

afterAll(() => server.stop(true));

const url = (path: string): string => `http://127.0.0.1:${server.port}${path}`;

describe('event streams read in the worker', () => {
  test('delivers every event in order, with the page-built headers on the request', async () => {
    const events: SseEvent[] = [];
    let opened = 0;
    let activity = 0;
    await openAuthenticatedEventStream('access-token', url('/events'), {
      signal: new AbortController().signal,
      headers: { 'x-since': 'ab:3' },
      onOpen: () => {
        opened += 1;
      },
      onActivity: () => {
        activity += 1;
      },
      onEvent: (event) => events.push(event),
    });

    expect(opened).toBe(1);
    expect(activity).toBeGreaterThanOrEqual(1);
    expect(events).toEqual([
      { event: 'presence', data: '[]' },
      { event: 'snapshot', data: '{"seq":0}' },
    ]);
    expect(seen.at(-1)).toEqual({ authorization: 'Bearer access-token', since: 'ab:3' });
  });

  test('keeps a definitive HTTP status across the worker boundary', async () => {
    const error = await openAuthenticatedEventStream('token', url('/unauthorized'), {
      signal: new AbortController().signal,
      onEvent: () => {},
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(EventStreamHttpError);
    expect((error as EventStreamHttpError).status).toBe(401);
  });

  test('rejects with an AbortError when the owner closes an open stream', async () => {
    const controller = new AbortController();
    const first = Promise.withResolvers<void>();
    const stream = openAuthenticatedEventStream('token', url('/open-ended'), {
      signal: controller.signal,
      onEvent: () => first.resolve(),
    });
    await first.promise;
    controller.abort();

    const error = await stream.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
  });
});
