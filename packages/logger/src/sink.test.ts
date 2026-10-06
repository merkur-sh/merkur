import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { sanitizeLogContext, writeMerkurLog } from './sink';

const originalLogLevel = process.env.LOG_LEVEL;

// The sink drops records below LOG_LEVEL and the unit suite runs `silent`.
// These tests exercise the write path itself, so they need an emitting level.
beforeAll(() => {
  process.env.LOG_LEVEL = 'info';
});

afterAll(() => {
  if (originalLogLevel === undefined) {
    delete process.env.LOG_LEVEL;
    return;
  }
  process.env.LOG_LEVEL = originalLogLevel;
});

describe('LOG_LEVEL filtering', () => {
  test('drops records below the configured level and keeps the rest', () => {
    const written: string[] = [];
    const originalWrite = process.stdout.write;
    Object.defineProperty(process.stdout, 'write', {
      configurable: true,
      value: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    });

    try {
      process.env.LOG_LEVEL = 'warn';
      writeMerkurLog(leveledRecord('info'));
      writeMerkurLog(leveledRecord('warn'));
      writeMerkurLog(leveledRecord('error'));

      process.env.LOG_LEVEL = 'silent';
      writeMerkurLog(leveledRecord('error'));

      process.env.LOG_LEVEL = 'not-a-level';
      writeMerkurLog(leveledRecord('info'));
    } finally {
      Object.defineProperty(process.stdout, 'write', {
        configurable: true,
        value: originalWrite,
      });
      process.env.LOG_LEVEL = 'info';
    }

    expect(written.map((line) => JSON.parse(line).level)).toEqual(['warn', 'error', 'info']);
  });
});

function leveledRecord(level: 'info' | 'warn' | 'error') {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    level,
    scope: 'sink-test',
    message: 'level_gate',
    context: {},
  };
}

describe('sanitizeLogContext', () => {
  test('redacts sensitive fields recursively without discarding safe context', () => {
    const sanitized = sanitizeLogContext({
      daemonId: 'daemon-1',
      authorization: 'Bearer secret',
      nested: {
        api_key: 'secret-api-key',
        tokenHmacSecret: 'secret-hmac',
        pairingRoot: 'pairing-root',
        pairing_code: 'pairing-code',
        noisePsk: 'noise-psk',
        decapsulationKey: 'ml-kem-private-key',
        commandId: 'command-1',
      },
    });

    expect(sanitized).toEqual({
      daemonId: 'daemon-1',
      authorization: '<redacted>',
      nested: {
        api_key: '<redacted>',
        tokenHmacSecret: '<redacted>',
        pairingRoot: '<redacted>',
        pairing_code: '<redacted>',
        noisePsk: '<redacted>',
        decapsulationKey: '<redacted>',
        commandId: 'command-1',
      },
    });
  });

  test('normalizes circular structures instead of making logging throw', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(sanitizeLogContext({ circular })).toEqual({
      circular: {
        self: '<circular>',
      },
    });
  });

  test('contains hostile getters and proxies at the logging boundary', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('getter defect');
        },
      },
    );

    expect(sanitizeLogContext({ hostile })).toEqual({
      hostile: '<unserializable>',
    });
  });

  test('scrubs credentials embedded in otherwise safe error strings', () => {
    expect(
      sanitizeLogContext({
        error:
          'request Bearer super-secret failed at redis://user:password@example.test/0?token=value',
      }),
    ).toEqual({
      error:
        'request Bearer <redacted> failed at redis://<redacted>@example.test/0?token=<redacted>',
    });
  });

  test('contains a broken stdout sink instead of interrupting lifecycle code', () => {
    const originalWrite = process.stdout.write;
    Object.defineProperty(process.stdout, 'write', {
      configurable: true,
      value: () => {
        throw new Error('broken pipe');
      },
      writable: true,
    });
    try {
      expect(() =>
        writeMerkurLog({
          ts: new Date(0).toISOString(),
          level: 'error',
          scope: 'test',
          message: 'cleanup_log',
          context: {},
        }),
      ).not.toThrow();
    } finally {
      Object.defineProperty(process.stdout, 'write', {
        configurable: true,
        value: originalWrite,
        writable: true,
      });
    }
  });
});
