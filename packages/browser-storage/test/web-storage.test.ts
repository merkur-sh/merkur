import { afterEach, describe, expect, test } from 'bun:test';

import { observeStorageFailures, type StorageFailureEvent } from '../src/failures';
import { guarded } from '../src/parse';
import { localValue } from '../src/web-storage';
import {
  installStorage,
  installStorageGetter,
  removeGlobal,
  restoreGlobals,
} from './test-environment';

// The behaviour every engine must share is in `conformance.ts`, run here and in
// real browsers. This file holds the refusals only a fake can produce.

const isString = (value: unknown): value is string => value === String(value);

/**
 * What Gecko throws for an internal failure such as a corrupted profile: a
 * legacy `Exception`, not a `DOMException`, whose `result` is the nsresult.
 */
const GECKO_FILE_CORRUPTED = {
  name: 'NS_ERROR_FILE_CORRUPTED',
  message: '',
  result: 0x8052_000b,
};

function failuresDuring(body: () => void): StorageFailureEvent[] {
  const seen: StorageFailureEvent[] = [];
  const stop = observeStorageFailures((event) => seen.push(event));
  try {
    body();
  } finally {
    stop();
  }
  return seen;
}

afterEach(restoreGlobals);

describe('refusals', () => {
  test('a quota refusal answers false and is counted as quota', () => {
    const storage = installStorage('localStorage');
    storage.refuseWrites = new DOMException('quota', 'QuotaExceededError');
    const value = localValue('id', guarded(isString));

    const seen = failuresDuring(() => expect(value.write('x')).toBe(false));
    expect(seen).toEqual([{ target: 'id', failure: 'quota' }]);
  });

  test('Gecko’s own failure exception is a refusal, not a bug', () => {
    const storage = installStorage('localStorage');
    storage.refuseWrites = GECKO_FILE_CORRUPTED;
    const value = localValue('id', guarded(isString));

    const seen = failuresDuring(() => expect(value.write('x')).toBe(false));
    expect(seen).toEqual([{ target: 'id', failure: 'refused' }]);
  });

  test('anything else a storage call throws is a bug and propagates', () => {
    const storage = installStorage('localStorage');
    const bug = new TypeError('not a refusal');
    storage.refuseWrites = bug;

    expect(() => localValue('id', guarded(isString)).write('x')).toThrow(bug);
  });

  test('an area whose property read is refused is treated as absent and counted', () => {
    installStorageGetter('localStorage', () => {
      throw new DOMException('denied', 'SecurityError');
    });
    const value = localValue('id', guarded(isString));

    const seen = failuresDuring(() => {
      expect(value.read()).toBeNull();
      expect(value.write('x')).toBe(false);
    });
    expect(seen).toEqual([
      { target: 'id', failure: 'refused' },
      { target: 'id', failure: 'refused' },
    ]);
  });

  test('a worker having no area is not a failure', () => {
    removeGlobal('localStorage');
    const value = localValue('id', guarded(isString));

    const seen = failuresDuring(() => {
      expect(value.read()).toBeNull();
      expect(value.write('x')).toBe(false);
      value.remove();
    });
    expect(seen).toEqual([]);
  });

  test('the area is looked up on every call, not when the key is declared', () => {
    const value = localValue('id', guarded(isString));
    const storage = installStorage('localStorage');

    expect(value.write('later')).toBe(true);
    expect(storage.entries.get('id')).toBe('"later"');
  });
});
