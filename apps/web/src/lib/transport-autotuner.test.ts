import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';

import { STORAGE_NAMES } from './storage-names';
import { createTransportAutotuner } from './transport-autotuner';

const CONTEXT = 'device-1:8:200';
const SAVE_DELAY_MS = 5_000;

const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  if (originalIndexedDb === undefined) Reflect.deleteProperty(globalThis, 'indexedDB');
  else Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
});

/** The rewards stored for `CONTEXT`, as the total count across arms. */
async function storedSampleCount(): Promise<number | null> {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(STORAGE_NAMES.transport_autotuner);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (!connection.objectStoreNames.contains('tuners')) return null;
    const record = await new Promise<{ counts: number[] } | undefined>((resolve, reject) => {
      const request = connection.transaction('tuners').objectStore('tuners').get(CONTEXT);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return record === undefined ? null : record.counts.reduce((sum, count) => sum + count, 0);
  } finally {
    connection.close();
  }
}

/**
 * Lets IndexedDB work through what is queued (it runs on `setImmediate`, which the
 * fake timers leave alone) until the stored count is `expected`, and answers the
 * count it last saw.
 */
async function storedCountOnceSettled(expected: number): Promise<number | null> {
  let seen: number | null = null;
  for (let turn = 0; turn < 200 && seen !== expected; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    seen = await storedSampleCount();
  }
  return seen;
}

describe('transport autotuner persistence', () => {
  test('two tabs in one context add up their samples instead of overwriting each other', async () => {
    const first = createTransportAutotuner(CONTEXT);
    expect(await storedCountOnceSettled(0)).toBe(0);
    const second = createTransportAutotuner(CONTEXT);

    for (let sample = 0; sample < 3; sample += 1) first.observeAndMaybeSample(40, 'direct');
    for (let sample = 0; sample < 2; sample += 1) second.observeAndMaybeSample(400, 'relay');
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(await storedCountOnceSettled(5)).toBe(5);

    // The first tab's next save starts from what the second stored, not from its own copy.
    first.observeAndMaybeSample(40, 'direct');
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(await storedCountOnceSettled(6)).toBe(6);
  });

  test('a new tab starts from what the context learned before', async () => {
    const earlier = createTransportAutotuner(CONTEXT);
    for (let sample = 0; sample < 4; sample += 1) earlier.observeAndMaybeSample(400, 'relay');
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(await storedCountOnceSettled(4)).toBe(4);

    const later = createTransportAutotuner(CONTEXT);
    later.observeAndMaybeSample(400, 'relay');
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(await storedCountOnceSettled(5)).toBe(5);
  });
});
