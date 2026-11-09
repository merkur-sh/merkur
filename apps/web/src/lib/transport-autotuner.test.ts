import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';

import { STORAGE_NAMES } from './storage-names';
import { createTransportAutotuner } from './transport-autotuner';

const CONTEXT = 'device-1:8:200';
const SAVE_DELAY_MS = 5_000;

const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
let completedWrites: Array<() => void> = [];

async function nextWrites(count = 1): Promise<void> {
  await Promise.all(
    Array.from(
      { length: count },
      () => new Promise<void>((resolve) => completedWrites.push(resolve)),
    ),
  );
}

function observedFactory(): IDBFactory {
  const factory = new IDBFactory();
  const open = factory.open.bind(factory);
  factory.open = (...args) => {
    const request = open(...args);
    request.addEventListener('success', () => {
      const database = request.result;
      const transaction = database.transaction.bind(database);
      database.transaction = (...args) => {
        const pending = transaction(...args);
        if (pending.mode === 'readwrite') {
          pending.addEventListener('complete', () => completedWrites.shift()?.(), { once: true });
        }
        return pending;
      };
    });
    return request;
  };
  return factory;
}

beforeEach(() => {
  completedWrites = [];
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: observedFactory() });
  jest.useFakeTimers();
});

afterEach(async () => {
  jest.useRealTimers();
  // The autotuner holds its connection between saves; deleting the database
  // closes it, so the next test's autotuner opens on that test's factory.
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(STORAGE_NAMES.transport_autotuner);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
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

describe('transport autotuner persistence', () => {
  test('two tabs in one context add up their samples instead of overwriting each other', async () => {
    const firstReady = nextWrites();
    const first = createTransportAutotuner(CONTEXT);
    await firstReady;
    expect(await storedSampleCount()).toBe(0);
    const secondReady = nextWrites();
    const second = createTransportAutotuner(CONTEXT);
    await secondReady;

    for (let sample = 0; sample < 3; sample += 1) first.observeAndMaybeSample(40, 'direct');
    for (let sample = 0; sample < 2; sample += 1) second.observeAndMaybeSample(400, 'relay');
    const saved = nextWrites(2);
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    await saved;
    expect(await storedSampleCount()).toBe(5);

    // The first tab's next save starts from what the second stored, not from its own copy.
    first.observeAndMaybeSample(40, 'direct');
    const updated = nextWrites();
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    await updated;
    expect(await storedSampleCount()).toBe(6);
  });

  test('a new tab starts from what the context learned before', async () => {
    const earlierReady = nextWrites();
    const earlier = createTransportAutotuner(CONTEXT);
    await earlierReady;
    for (let sample = 0; sample < 4; sample += 1) earlier.observeAndMaybeSample(400, 'relay');
    const saved = nextWrites();
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    await saved;
    expect(await storedSampleCount()).toBe(4);

    const laterReady = nextWrites();
    const later = createTransportAutotuner(CONTEXT);
    await laterReady;
    later.observeAndMaybeSample(400, 'relay');
    const updated = nextWrites();
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    await updated;
    expect(await storedSampleCount()).toBe(5);
  });
});
