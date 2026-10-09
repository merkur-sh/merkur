import { describe, expect, test } from 'bun:test';
import {
  createPerfStringInterner,
  createPerfStringResolver,
  createPerfStringTableBuffer,
  PERF_STRING_TABLE_SLOTS,
} from './perf-string-table';

describe('perf string table', () => {
  test('interners publish independent bytes before reusing realm scratch', () => {
    const first = createPerfStringTableBuffer();
    const second = createPerfStringTableBuffer();
    createPerfStringInterner(first).intern('first-😀');
    createPerfStringInterner(second).intern('second-界');
    expect(createPerfStringResolver(first).resolve(1)).toBe('first-😀');
    expect(createPerfStringResolver(second).resolve(1)).toBe('second-界');
  });

  test('preserves UTF-8 byte truncation across scalar boundaries', () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    for (const character of ['é', '界', '😀', '\ud800', '\udfff']) {
      for (let prefix = 90; prefix <= 96; prefix += 1) {
        for (const repeats of [1, 100]) {
          const value = 'a'.repeat(prefix) + character.repeat(repeats);
          const buffer = createPerfStringTableBuffer();
          const interner = createPerfStringInterner(buffer);
          const resolver = createPerfStringResolver(buffer);
          const id = interner.intern(value);
          expect(resolver.resolve(id)).toBe(decoder.decode(encoder.encode(value).slice(0, 94)));
          expect(interner.intern(value)).toBe(id);
        }
      }
    }
  });

  test('does not cache unpublished slots and never repoints published ids', () => {
    const buffer = createPerfStringTableBuffer();
    const interner = createPerfStringInterner(buffer);
    const resolver = createPerfStringResolver(buffer);
    expect(resolver.resolve(1)).toBeNull();
    expect(interner.intern(undefined)).toBe(0);
    for (let index = 0; index < PERF_STRING_TABLE_SLOTS; index += 1) {
      expect(interner.intern(`session-${index}`)).toBe(index + 1);
      expect(resolver.resolve(index + 1)).toBe(`session-${index}`);
    }
    expect(interner.intern('overflow')).toBe(0);
    expect(resolver.resolve(1)).toBe('session-0');
    expect(interner.intern('session-0')).toBe(1);
  });
});
