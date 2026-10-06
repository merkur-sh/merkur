import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import { createLogger, type Logger, logWithLoggerEffect, setExportedLogSink } from './index';

describe('logWithLoggerEffect', () => {
  test('uses the native Effect logger surface inside a fiber', async () => {
    const calls: string[] = [];
    const logger: Logger = {
      info: () => calls.push('sync'),
      warn: () => calls.push('sync'),
      error: () => calls.push('sync'),
      effect: (_level, message) =>
        Effect.sync(() => {
          calls.push(`effect:${message}`);
        }),
    };

    await Effect.runPromise(logWithLoggerEffect(logger, 'error', 'control_failed'));

    expect(calls).toEqual(['effect:control_failed']);
  });

  test('retains the synchronous fallback for callback-oriented test doubles', async () => {
    const calls: string[] = [];
    const logger: Logger = {
      info: () => {},
      warn: () => {},
      error: (message) => calls.push(message),
    };

    await Effect.runPromise(logWithLoggerEffect(logger, 'error', 'callback_failed'));

    expect(calls).toEqual(['callback_failed']);
  });
});

describe('setExportedLogSink', () => {
  /**
   * Capture stdout with logging forced on.
   *
   * The unit runner sets `LOG_LEVEL=silent`, which makes `writeMerkurLog`
   * return before writing. Without pinning the level here these assertions
   * would pass for the wrong reason — an empty capture would prove silencing
   * rather than delegation.
   */
  function captureStdout(run: () => void): string[] {
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    process.stdout.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      run();
    } finally {
      process.stdout.write = originalWrite;
      if (originalLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = originalLevel;
      setExportedLogSink(null);
    }
    return writes;
  }

  test('routes the synchronous surface through the sink instead of stdout', () => {
    const seen: Array<[string, string, string]> = [];
    const writes = captureStdout(() => {
      setExportedLogSink((level, scope, message) => {
        seen.push([level, scope, message]);
      });
      createLogger('redis').error('redis_error', { connectionName: 'commands' });
    });

    expect(seen).toEqual([['error', 'redis', 'redis_error']]);
    // Delegated, not duplicated: `logEffect` reaches MerkurJsonLogger, which
    // writes the stdout line. Writing here too would double every record.
    expect(writes).toEqual([]);
  });

  test('falls back to stdout when the sink throws, so a broken exporter loses nothing', () => {
    const writes = captureStdout(() => {
      setExportedLogSink(() => {
        throw new Error('runtime disposing');
      });
      createLogger('server').error('server_fatal', { error: 'boom' });
    });

    expect(writes).toHaveLength(1);
    const record = JSON.parse(writes[0] ?? '{}');
    expect(record.message).toBe('server_fatal');
    expect(record.level).toBe('error');
  });

  test('restores direct stdout writes once the sink is cleared', () => {
    const writes = captureStdout(() => {
      setExportedLogSink(() => {});
      createLogger('server').warn('sunk');
      setExportedLogSink(null);
      createLogger('server').warn('direct');
    });

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? '{}').message).toBe('direct');
  });
});
