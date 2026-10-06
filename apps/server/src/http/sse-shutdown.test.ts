import '../elysia-runtime';
import { expect, test } from 'bun:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { Elysia } from 'elysia';
import { createDeviceEventsSseLifetime, createDeviceEventsSseResponse } from './sse';

function latch() {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test('closes and joins SSE before graceful HTTP drain while preserving ordinary requests', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const lifetime = createDeviceEventsSseLifetime();
  const releaseStarted = latch();
  const releaseFinish = latch();
  const ordinaryStarted = latch();
  const ordinaryFinish = latch();
  let admitted = 0;
  let released = 0;
  const app = new Elysia()
    .get('/events', ({ request }) =>
      createDeviceEventsSseResponse<never, never>({
        lifetime,
        run: (program, options) => runtime.runPromise(program, options),
        request,
        userId: 'shutdown-native',
        keepAliveMs: 60_000,
        since: null,
        subscribe: () =>
          Effect.sync(() => {
            admitted += 1;
            return Effect.promise(async () => {
              releaseStarted.open();
              await releaseFinish.promise;
              released += 1;
            });
          }),
        subscribePresence: () => Effect.succeed(Effect.void),
        readCursor: Effect.succeed({ epoch: 'a1b2c3d4e5f6071', seq: 0 }),
        loadSnapshot: Effect.succeed([]),
        onError: (error) => {
          throw error;
        },
        onClosed: () => {},
      }),
    )
    .get('/ordinary', async () => {
      ordinaryStarted.open();
      await ordinaryFinish.promise;
      return 'completed';
    });
  await app.listen({ port: 0, hostname: '127.0.0.1' });
  const port = app.server?.port;
  if (port === undefined) throw new Error('test server did not bind');
  const base = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${base}/events`);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('event stream body missing');
    const ordinary = fetch(`${base}/ordinary`);
    await ordinaryStarted.promise;
    const stoppingStreams = lifetime.stop();
    await releaseStarted.promise;
    expect(lifetime.isStopped()).toBe(true);
    expect((await fetch(`${base}/events`)).status).toBe(503);
    expect(admitted).toBe(1);
    expect(released).toBe(0);
    releaseFinish.open();
    await stoppingStreams;
    expect(released).toBe(1);
    while (!(await reader.read()).done) {
      /* Drain the accepted initial frames. */
    }

    let stopped = false;
    const stoppingServer = Promise.resolve(app.stop(false)).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    ordinaryFinish.open();
    expect(await (await ordinary).text()).toBe('completed');
    await stoppingServer;
    expect(stopped).toBe(true);
    await lifetime.stop();
    expect(released).toBe(1);
  } finally {
    releaseFinish.open();
    ordinaryFinish.open();
    await lifetime.stop();
    await app.stop(true);
    await runtime.dispose();
  }
});
