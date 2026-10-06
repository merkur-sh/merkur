import { describe, expect, test } from 'bun:test';
import { createSseParserBenchmarkDriver } from './bench-sse-parser';

describe('SSE parser benchmark driver', () => {
  test('runs the production incremental parser across fragmented events', () => {
    const runBatch = createSseParserBenchmarkDriver(3, 257, 1);
    const result = runBatch();

    expect(result.parsedEvents).toBe(3);
    expect(result.parsedChars).toBe(771);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.checksum).not.toBe(0);
  });

  test('rejects invalid dimensions before allocating benchmark payloads', () => {
    expect(() => createSseParserBenchmarkDriver(0, 1, 1)).toThrow(
      'eventsPerSample must be a positive safe integer',
    );
    expect(() => createSseParserBenchmarkDriver(1, -1, 1)).toThrow(
      'payloadChars must be a positive safe integer',
    );
    expect(() => createSseParserBenchmarkDriver(1, 1, 0)).toThrow(
      'chunkChars must be a positive safe integer',
    );
  });
});
