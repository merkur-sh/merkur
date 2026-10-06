import { expect, test } from 'bun:test';
import { Effect, Tracer } from 'effect';

import { makeSpanTreeTracer } from './span-tree-tracer';

function collect(): { tracer: Tracer.Tracer; output: () => string } {
  let text = '';
  const tracer = makeSpanTreeTracer((chunk) => {
    text += chunk;
  });
  return { tracer, output: () => text };
}

function withTracer(tracer: Tracer.Tracer) {
  return <A, E>(program: Effect.Effect<A, E, never>) =>
    program.pipe(Effect.provideService(Tracer.Tracer, tracer));
}

test('prints a finished trace as a tree, nested and attributed', async () => {
  const { tracer, output } = collect();

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.void.pipe(
        Effect.withSpan('redis.operation', {
          attributes: { 'db.system': 'redis' },
        }),
      );
      yield* Effect.void.pipe(Effect.withSpan('daemon-control.delivery'));
    }).pipe(Effect.withSpan('session_request'), withTracer(tracer)),
  );

  const text = output();
  expect(text).toContain('── trace ');
  expect(text).toContain('session_request');
  expect(text).toContain('├─ redis.operation');
  expect(text).toContain('└─ daemon-control.delivery');
  expect(text).toContain('db.system=redis');
});

/**
 * The tree is flushed by the *root* ending. A child that ends first must not
 * emit a tree of its own, or every nested span would print a fragment.
 */
test('nothing is printed until the root span ends', async () => {
  const { tracer, output } = collect();

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.void.pipe(Effect.withSpan('child'));
      expect(output()).toBe('');
    }).pipe(Effect.withSpan('root'), withTracer(tracer)),
  );

  expect(output()).toContain('root');
  expect(output().match(/── trace /g)).toHaveLength(1);
});

test('a failed span is marked', async () => {
  const { tracer, output } = collect();

  await Effect.runPromise(
    Effect.fail('boom').pipe(Effect.withSpan('session_request'), Effect.result, withTracer(tracer)),
  );

  expect(output()).toContain('FAILED');
});

/**
 * An unsampled span is never collected, so a `Debug` span below the threshold
 * costs the printer nothing — the same decision the OTLP exporter makes.
 */
test('unsampled spans are not printed', async () => {
  const { tracer, output } = collect();

  await Effect.runPromise(
    Effect.void.pipe(
      Effect.withSpan('redis.operation', { level: 'Debug' }),
      Effect.withSpan('session_request'),
      withTracer(tracer),
      Effect.provideService(Tracer.MinimumTraceLevel, 'Info'),
    ),
  );

  expect(output()).toContain('session_request');
  expect(output()).not.toContain('redis.operation');
});

test('a rooted span prints as its own trace', async () => {
  const { tracer, output } = collect();

  await Effect.runPromise(
    Effect.void.pipe(
      Effect.withSpan('server.health.refresh', { root: true }),
      Effect.withSpan('caller'),
      withTracer(tracer),
    ),
  );

  expect(output().match(/── trace /g)).toHaveLength(2);
});
