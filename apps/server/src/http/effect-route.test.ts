import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import { createLogger } from '../logger';
import type { ServerRuntimeContext } from '../runtime';
import { type RunServerProgram, runLoggedEffect, runRouteEffect } from './effect-route';

describe('Effect HTTP bridge', () => {
  test('passes the request AbortSignal to route programs', async () => {
    const observedSignals: Array<AbortSignal | undefined> = [];
    const runner = createAbortingRunner(observedSignals);
    const controller = new AbortController();
    const cancellation = new Error('request disconnected');
    const running = runRouteEffect(runner, Effect.never, {
      eventName: 'test_route',
      logger: createLogger('effect-route-test'),
      request: new Request('http://localhost/test'),
      signal: controller.signal,
    });

    controller.abort(cancellation);
    await expect(running).rejects.toBe(cancellation);
    expect(observedSignals).toEqual([controller.signal]);
  });

  test('passes the request AbortSignal to logged programs', async () => {
    const observedSignals: Array<AbortSignal | undefined> = [];
    const runner = createAbortingRunner(observedSignals);
    const controller = new AbortController();
    const cancellation = new Error('request disconnected');
    const running = runLoggedEffect(runner, Effect.never, {
      eventName: 'test_logged_route',
      logger: createLogger('effect-route-test'),
      request: new Request('http://localhost/test'),
      signal: controller.signal,
    });

    controller.abort(cancellation);
    await expect(running).rejects.toBe(cancellation);
    expect(observedSignals).toEqual([controller.signal]);
  });

  test('names route spans after the operation, not the failure event', async () => {
    const runner = ((program: Effect.Effect<unknown, unknown, never>) =>
      Effect.runPromise(program)) as RunServerProgram;

    // `runRouteEffect` wraps this program in the route span, so reading the
    // current span from inside it observes exactly the name that reaches Axiom.
    const observedName = await runRouteEffect(
      runner,
      Effect.map(Effect.currentSpan, (span) => span.name),
      {
        eventName: 'edge_register_failed',
        logger: createLogger('effect-route-test'),
        request: new Request('http://localhost/api/edge/register'),
      },
    );

    // A healthy request must not surface as `edge_register_failed` in a trace.
    expect(observedName).toBe('edge_register');
  });
});

function createAbortingRunner(observedSignals: Array<AbortSignal | undefined>): RunServerProgram {
  return function run<A, E, R extends ServerRuntimeContext>(
    _program: Effect.Effect<A, E, R>,
    options?: Effect.RunOptions,
  ): Promise<A> {
    const signal = options?.signal;
    observedSignals.push(signal);
    return new Promise<A>((_resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
}
