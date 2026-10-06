import { describe, expect, test } from 'bun:test';

import { createAuthorizationHeader, createBearerToken, parseBearerToken } from './auth-header';
import { readU16BE, readU32BE, readVarintU32OrNull, writeU32BE } from './binary';
import { clamp01, clampInt, nextPowerOfTwo } from './math';
import {
  hasExactKeys,
  isRecord,
  parseJson,
  readFiniteNumberField,
  readNonEmptyStringField,
  readNullableFiniteNumberField,
  readStringField,
} from './parsing';
import {
  currentReleasePlatform,
  daemonArtifactName,
  latestReleaseAssetUrl,
  releaseAssetUrl,
} from './release';
import {
  canTransitionTerminalLifecycle,
  transitionTerminalLifecycleOrThrow,
} from './session-lifecycle';
import { merkurVersion } from './version';

describe('authorization headers', () => {
  test('creates and parses bearer tokens', () => {
    expect(createBearerToken('token-1')).toBe('Bearer token-1');
    expect(createAuthorizationHeader('token-1')).toEqual({ Authorization: 'Bearer token-1' });
    expect(parseBearerToken('Bearer  token-1 ')).toBe('token-1');
  });

  test('rejects missing, empty, and non-bearer authorization', () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken('Basic token-1')).toBeNull();
    expect(parseBearerToken('Bearer   ')).toBeNull();
  });
});

describe('binary primitives', () => {
  test('round-trips fixed-width big-endian integers', () => {
    const bytes = new Uint8Array(6);
    writeU32BE(bytes, 1, 0xfedcba98);
    expect(readU16BE(bytes, 1)).toBe(0xfedc);
    expect(readU32BE(bytes, 1)).toBe(0xfedcba98);
    expect(readU32BE(new Uint8Array([0xff]), 0)).toBe(0xff000000);
  });

  test('rejects truncated and oversized varints', () => {
    expect(readVarintU32OrNull(new Uint8Array([0x80]), 0)).toBeNull();
    expect(readVarintU32OrNull(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80]), 0)).toBeNull();
  });
});

describe('numeric helpers', () => {
  test('rounds capacities to powers of two', () => {
    expect(nextPowerOfTwo(0)).toBe(1);
    expect(nextPowerOfTwo(3)).toBe(4);
    expect(nextPowerOfTwo(16)).toBe(16);
  });

  test('clamps finite values and rejects non-finite values', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clampInt(3.6, 1, 5)).toBe(4);
    expect(clampInt(10, 1, 5)).toBe(5);
    expect(clampInt(Number.POSITIVE_INFINITY, 1, 5)).toBe(1);
  });
});

describe('untrusted value parsing', () => {
  test('distinguishes records and parses valid JSON', () => {
    expect(isRecord({ key: 'value' })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(parseJson('{"ok":true}')).toEqual({ ok: true });
    expect(parseJson('{')).toBeNull();
  });

  test('exact keys are a set: any order, nothing missing, nothing extra', () => {
    expect(hasExactKeys({ b: 1, a: undefined }, ['a', 'b'])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys({ a: 1, c: 2 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys(Object.create({ a: 1, b: 2 }), ['a', 'b'])).toBe(false);
    expect(hasExactKeys(['a', 'b'], ['0', '1'])).toBe(false);
    expect(hasExactKeys(null, [])).toBe(false);
  });

  test('reads typed fields without coercion', () => {
    const value = { text: 'hello', empty: '', number: 4, nullish: null, nan: Number.NaN };
    expect(readStringField(value, 'text')).toBe('hello');
    expect(readStringField(value, 'number')).toBeNull();
    expect(readNonEmptyStringField(value, 'text')).toBe('hello');
    expect(readNonEmptyStringField(value, 'empty')).toBeNull();
    expect(readFiniteNumberField(value, 'number')).toBe(4);
    expect(readFiniteNumberField(value, 'nan')).toBeNull();
    expect(readNullableFiniteNumberField(value, 'nullish')).toBeNull();
    expect(readNullableFiniteNumberField(value, 'number')).toBe(4);
    expect(readNullableFiniteNumberField(value, 'text')).toBeUndefined();
  });
});

describe('terminal lifecycle', () => {
  test('accepts idempotent and allowed transitions', () => {
    expect(canTransitionTerminalLifecycle('idle', 'idle')).toBe(true);
    expect(canTransitionTerminalLifecycle('idle', 'connecting')).toBe(true);
    expect(transitionTerminalLifecycleOrThrow('authenticating', 'ready')).toBe('ready');
    expect(transitionTerminalLifecycleOrThrow('closed', 'connecting')).toBe('connecting');
  });

  test('rejects transitions that skip lifecycle boundaries', () => {
    expect(canTransitionTerminalLifecycle('idle', 'ready')).toBe(false);
    expect(() => transitionTerminalLifecycleOrThrow('ready', 'authenticating')).toThrow(
      'Invalid lifecycle transition: ready -> authenticating',
    );
  });
});

describe('release and build metadata', () => {
  test('builds encoded public GitHub release download URLs', () => {
    expect(daemonArtifactName('darwin-x64')).toBe('merkur-daemon-darwin-x64.tar.gz');
    expect(releaseAssetUrl('v1.0 beta', 'asset name.tar.gz')).toBe(
      'https://github.com/merkur-sh/merkur/releases/download/v1.0%20beta/asset%20name.tar.gz',
    );
    expect(latestReleaseAssetUrl('merkur-release.json')).toBe(
      'https://github.com/merkur-sh/merkur/releases/latest/download/merkur-release.json',
    );
    const candidate = `${process.platform}-${process.arch}`;
    const expectedPlatform =
      candidate === 'darwin-arm64' ||
      candidate === 'darwin-x64' ||
      candidate === 'linux-x64' ||
      candidate === 'linux-arm64'
        ? candidate
        : null;
    expect(currentReleasePlatform()).toBe(expectedPlatform);
  });

  test('reports stamped and development versions', () => {
    const previous = process.env.MERKUR_VERSION;
    try {
      delete process.env.MERKUR_VERSION;
      expect(merkurVersion()).toBe('dev');
      process.env.MERKUR_VERSION = 'v9.8.7';
      expect(merkurVersion()).toBe('v9.8.7');
    } finally {
      if (previous === undefined) delete process.env.MERKUR_VERSION;
      else process.env.MERKUR_VERSION = previous;
    }
  });
});
