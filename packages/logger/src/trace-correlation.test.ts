import { expect, test } from 'bun:test';
import { Effect } from 'effect';

import { MerkurLoggerLayer } from './effect-logger';
import { logEffect } from './index';
import type { MerkurLogRecord } from './sink';

/**
 * Trace correlation on log records.
 *
 * `OtlpLogger` stamps `traceId`/`spanId` from `fiber.cache.span`, and the stdout record now
 * reads the same source — so a line is pivotable to its trace wherever one exists, in both
 * places, or in neither. What must never happen is the two disagreeing.
 */
async function captureRecords(program: Effect.Effect<void>): Promise<MerkurLogRecord[]> {
  const records: MerkurLogRecord[] = [];
  const originalWrite = process.stdout.write;
  const originalLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  // SAFETY: MerkurLoggerLayer writes each record as one string chunk and reads
  // no return value beyond the boolean this stub gives.
  process.stdout.write = ((chunk: string) => {
    // SAFETY: every chunk is one JSON line the layer serialised from a MerkurLogRecord.
    records.push(JSON.parse(chunk) as MerkurLogRecord);
    return true;
  }) as typeof process.stdout.write;
  try {
    await Effect.runPromise(program.pipe(Effect.provide(MerkurLoggerLayer)));
    return records;
  } finally {
    process.stdout.write = originalWrite;
    if (originalLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLevel;
  }
}

test('a record logged inside a span carries that span trace identity', async () => {
  const records = await captureRecords(
    logEffect('info', 'test', 'inside_a_span').pipe(Effect.withSpan('session_request')),
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
  const records = await captureRecords(logEffect('info', 'test', 'no_span'));

  expect(records).toHaveLength(1);
  expect(records[0]?.traceId).toBeUndefined();
  expect(records[0]?.spanId).toBeUndefined();
});

test('records from different spans carry different span ids under one trace', async () => {
  const records = await captureRecords(
    Effect.gen(function* () {
      yield* logEffect('info', 'test', 'outer');
      yield* logEffect('info', 'test', 'inner').pipe(Effect.withSpan('redis.operation'));
    }).pipe(Effect.withSpan('session_request')),
  );

  expect(records).toHaveLength(2);
  expect(records[0]?.traceId).toBe(records[1]?.traceId ?? '');
  expect(records[0]?.spanId).not.toBe(records[1]?.spanId ?? '');
});
