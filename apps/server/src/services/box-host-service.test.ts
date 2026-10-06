import { describe, expect, spyOn, test } from 'bun:test';
import { Deferred, Effect, Fiber, Redacted, Result } from 'effect';
import { BoxHostError, BoxHostUnconfiguredError, createBoxHostService } from './box-host-service';

const options = {
  boxHost: { url: 'https://box-host.test', token: Redacted.make('host-token'), timeoutMs: 1_000 },
  serverOrigin: 'https://merkur.test',
};

function pendingResponseBody() {
  const bodyStarted = Deferred.makeUnsafe<void>();
  const state: { signal: AbortSignal | null } = { signal: null };
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        state.signal = init?.signal ?? null;
        return new Response(
          new ReadableStream({
            start(controller) {
              state.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
              Deferred.doneUnsafe(bodyStarted, Effect.void);
            },
          }),
        );
      },
      { preconnect: fetch.preconnect },
    ),
  );
  return { state, bodyStarted, fetchSpy };
}

describe('BoxHostService cancellation', () => {
  test('interrupting a request aborts its pending response body', async () => {
    const { state, bodyStarted, fetchSpy } = pendingResponseBody();
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(createBoxHostService(options).start('box-1'));
          yield* Deferred.await(bodyStarted);
          yield* Fiber.interrupt(fiber);
        }),
      );
      expect(state.signal).not.toBeNull();
      expect(state.signal?.aborted).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('the deadline includes body consumption and aborts the fetch', async () => {
    const { state, fetchSpy } = pendingResponseBody();
    try {
      const result = await Effect.runPromise(
        Effect.result(
          createBoxHostService({
            ...options,
            boxHost: { ...options.boxHost, timeoutMs: 10 },
          }).start('box-1'),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(BoxHostError);
        expect(result.failure.message).toBe('box host request timed out');
      }
      expect(state.signal?.aborted).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('BoxHostService remove', () => {
  const answering = (status: number) =>
    spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async () =>
          new Response(JSON.stringify({ error: 'box_not_found', detail: 'box-1' }), { status }),
        { preconnect: fetch.preconnect },
      ),
    );

  test("the host's exact 404 means the box is already removed", async () => {
    const fetchSpy = answering(404);
    try {
      await Effect.runPromise(createBoxHostService(options).remove('box-1'));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('any other refusal is an error, never absence', async () => {
    const fetchSpy = answering(502);
    try {
      const result = await Effect.runPromise(
        Effect.result(createBoxHostService(options).remove('box-1')),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(BoxHostError);
        if (result.failure instanceof BoxHostError) expect(result.failure.status).toBe(502);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

test('an absent box host refuses provisioning before issuing HTTP', async () => {
  const result = await Effect.runPromise(
    Effect.result(
      createBoxHostService({ boxHost: undefined, serverOrigin: options.serverOrigin }).start(
        'box-1',
      ),
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(BoxHostUnconfiguredError);
});
