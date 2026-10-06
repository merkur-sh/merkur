import { expect, test } from 'bun:test';
import { Effect, Logger } from 'effect';

import type { MerkurLoggerLayer } from './effect-logger';
import { logEffect } from './index';
import type { MerkurLogRecord } from './sink';

/**
 * Trace correlation on log records.
 *
 * `OtlpLogger` stamps `traceId`/`spanId` from `fiber.currentSpan`, and the stdout record now
 * reads the same source — so a line is pivotable to its trace wherever one exists, in both
 * places, or in neither. What must never happen is the two disagreeing.
 */
function captureRecords(): { layer: typeof MerkurLoggerLayer; records: MerkurLogRecord[] } {
  const records: MerkurLogRecord[] = [];
  const capturing = Logger.make((options) => {
    const span = options.fiber.currentSpan;
    records.push({
      ts: options.date.toISOString(),
      level: 'info',
      scope: 'test',
      message: String(options.message),
      context: {},
      ...(span === undefined ? {} : { traceId: span.traceId, spanId: span.spanId }),
    });
  });
  return { layer: Logger.layer([capturing]) as typeof MerkurLoggerLayer, records };
}

test('a record logged inside a span carries that span trace identity', async () => {
  const { layer, records } = captureRecords();

  await Effect.runPromise(
    logEffect('info', 'test', 'inside_a_span').pipe(
      Effect.withSpan('session_request'),
      Effect.provide(layer),
    ),
  );

  expect(records).toHaveLength(1);
  expect(records[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(records[0]?.spanId).toMatch(/^[0-9a-f]{16}$/);
});

/**
 * A record from a fiber with no span — an EventEmitter callback, a detached fiber — carries
 * no trace id, and that is correct. Inventing one would attach a connection-lifecycle event
 * to an unrelated request.
 */
test('a record logged with no span carries no trace identity', async () => {
  const { layer, records } = captureRecords();

  await Effect.runPromise(logEffect('info', 'test', 'no_span').pipe(Effect.provide(layer)));

  expect(records).toHaveLength(1);
  expect(records[0]?.traceId).toBeUndefined();
  expect(records[0]?.spanId).toBeUndefined();
});

test('records from different spans carry different span ids under one trace', async () => {
  const { layer, records } = captureRecords();

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* logEffect('info', 'test', 'outer');
      yield* logEffect('info', 'test', 'inner').pipe(Effect.withSpan('redis.operation'));
    }).pipe(Effect.withSpan('session_request'), Effect.provide(layer)),
  );

  expect(records).toHaveLength(2);
  expect(records[0]?.traceId).toBe(records[1]?.traceId ?? '');
  expect(records[0]?.spanId).not.toBe(records[1]?.spanId ?? '');
});
