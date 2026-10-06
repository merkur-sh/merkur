import { afterEach, describe, expect, test } from 'bun:test';
import type { PersistedResume } from './display-resume-schema';
import { loadResume, saveResume } from './display-resume-store';

const valid: PersistedResume = {
  key: 'daemon-1:tab-1',
  daemonId: 'daemon-1',
  tabId: 'tab-1',
  generation: 7,
  seq: 11,
  cols: 120,
  rows: 40,
  chunks: [new Uint8Array([1, 2, 3])],
  mtime: 1_700_000_000_000,
};

const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

afterEach(() => {
  if (originalIndexedDb === undefined) {
    Reflect.deleteProperty(globalThis, 'indexedDB');
  } else {
    Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
  }
});

describe('display resume store validation boundary', () => {
  test('loads a valid exact record without deleting it', async () => {
    const fake = installFakeIndexedDb(new Map([[valid.key, valid]]));

    expect(await loadResume('daemon-1', 'tab-1')).toEqual(valid);
    expect(fake.records.get(valid.key)).toEqual(valid);
    expect(fake.transactionModes).toEqual(['readwrite']);
  });

  test('atomically deletes an invalid record instead of returning it forever', async () => {
    const invalid = { ...valid, deprecatedChunks: true };
    const fake = installFakeIndexedDb(new Map([[valid.key, invalid]]));

    expect(await loadResume('daemon-1', 'tab-1')).toBeNull();
    expect(fake.records.has(valid.key)).toBeFalse();
    expect(fake.deletedKeys).toEqual([valid.key]);
    expect(fake.transactionModes).toEqual(['readwrite']);
  });

  test('deletes a record whose embedded identity does not match its IndexedDB key', async () => {
    const fake = installFakeIndexedDb(new Map([[valid.key, { ...valid, daemonId: 'daemon-2' }]]));

    expect(await loadResume('daemon-1', 'tab-1')).toBeNull();
    expect(fake.records.has(valid.key)).toBeFalse();
  });

  test('refuses invalid writes before opening IndexedDB', async () => {
    const fake = installFakeIndexedDb();

    await expect(saveResume({ ...valid, chunks: [] })).rejects.toThrow(
      'Refusing to persist an invalid display resume record',
    );
    expect(fake.openCount).toBe(0);
  });
});

function resumeFor(tab: number, mtime: number): PersistedResume {
  return {
    ...valid,
    key: `daemon-1:tab-${tab}`,
    tabId: `tab-${tab}`,
    mtime,
  };
}

describe('display resume store eviction', () => {
  test('keeps every record up to the cap of 8 and evicts exactly the oldest beyond it', async () => {
    const fake = installFakeIndexedDb();
    const storedAfterEachSave: number[] = [];

    for (let tab = 1; tab <= 10; tab += 1) {
      await saveResume(resumeFor(tab, 1_700_000_000_000 + tab));
      storedAfterEachSave.push(fake.records.size);
    }

    expect(storedAfterEachSave).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 8, 8]);
    expect(fake.deletedKeys).toEqual(['daemon-1:tab-1', 'daemon-1:tab-2']);
    expect([...fake.records.keys()].sort()).toEqual(
      [3, 4, 5, 6, 7, 8, 9, 10].map((tab) => `daemon-1:tab-${tab}`).sort(),
    );
  });

  test('a save reads keys only, never a stored snapshot', async () => {
    const fake = installFakeIndexedDb();

    for (let tab = 1; tab <= 9; tab += 1) {
      await saveResume(resumeFor(tab, 1_700_000_000_000 + tab));
    }

    expect(fake.records.size).toBe(8);
    expect(fake.valueReads).toBe(0);
  });

  test('a record that no longer parses counts toward the cap and goes oldest first', async () => {
    const stale = { ...resumeFor(0, 1_600_000_000_000), deprecatedChunks: true };
    const fake = installFakeIndexedDb(new Map([[stale.key, stale]]));

    for (let tab = 1; tab <= 7; tab += 1) {
      await saveResume(resumeFor(tab, 1_700_000_000_000 + tab));
    }
    // Saving does not parse what is already stored; loadResume deletes a stale
    // record when its key is read, and the cap reaches it by age.
    expect(fake.records.has(stale.key)).toBeTrue();
    expect(fake.records.size).toBe(8);

    await saveResume(resumeFor(8, 1_700_000_000_008));
    expect(fake.deletedKeys).toEqual([stale.key]);
    expect(fake.records.size).toBe(8);
  });
});

interface FakeIndexedDb {
  readonly records: Map<string, unknown>;
  readonly deletedKeys: string[];
  readonly transactionModes: IDBTransactionMode[];
  readonly openCount: number;
  /** Stored values handed back to the store module, by get or by a value cursor. */
  readonly valueReads: number;
}

interface FakeRequest {
  result?: unknown;
  error: DOMException | null;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

function installFakeIndexedDb(records: Map<string, unknown> = new Map()): FakeIndexedDb {
  const deletedKeys: string[] = [];
  const transactionModes: IDBTransactionMode[] = [];
  let openCount = 0;
  let valueReads = 0;

  const deleteRecord = (key: IDBValidKey): object => {
    const stringKey = String(key);
    deletedKeys.push(stringKey);
    records.delete(stringKey);
    return {};
  };

  // Primary keys of the records the `mtime` index holds, in index order.
  const mtimeOrder = (): string[] => {
    const indexed: Array<{ key: string; mtime: number }> = [];
    for (const [key, value] of records) {
      if (
        typeof value === 'object' &&
        value !== null &&
        'mtime' in value &&
        typeof value.mtime === 'number'
      ) {
        indexed.push({ key, mtime: value.mtime });
      }
    }
    indexed.sort((left, right) => left.mtime - right.mtime || left.key.localeCompare(right.key));
    return indexed.map((entry) => entry.key);
  };

  const database = {
    objectStoreNames: { contains: () => true },
    transaction(_storeName: string, mode: IDBTransactionMode) {
      transactionModes.push(mode);
      // The transaction completes once every request made on it has settled.
      let pending = 0;
      const begin = (): void => {
        pending += 1;
      };
      const settle = (): void => {
        pending -= 1;
        if (pending === 0) queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
      };
      const request = (produce: () => unknown): FakeRequest => {
        const created: FakeRequest = { error: null, onsuccess: null, onerror: null };
        begin();
        queueMicrotask(() => {
          created.result = produce();
          created.onsuccess?.(new Event('success'));
          settle();
        });
        return created;
      };
      const tx: {
        error: DOMException | null;
        oncomplete: ((event: Event) => void) | null;
        onabort: ((event: Event) => void) | null;
        onerror: ((event: Event) => void) | null;
        objectStore(): object;
      } = {
        error: null,
        oncomplete: null,
        onabort: null,
        onerror: null,
        objectStore() {
          return {
            get(key: IDBValidKey) {
              return request(() => {
                const value = records.get(String(key));
                if (value !== undefined) valueReads += 1;
                return value;
              });
            },
            put(value: PersistedResume) {
              return request(() => {
                records.set(value.key, value);
                return value.key;
              });
            },
            delete: deleteRecord,
            index(_name: 'mtime') {
              return {
                getAllKeys() {
                  return request(() => mtimeOrder());
                },
                openCursor(_range: null, _direction: IDBCursorDirection) {
                  const keys = mtimeOrder();
                  let position = 0;
                  const cursorRequest: FakeRequest = {
                    error: null,
                    onsuccess: null,
                    onerror: null,
                  };
                  const step = (): void => {
                    queueMicrotask(() => {
                      const key = keys[position];
                      if (key === undefined) {
                        cursorRequest.result = null;
                        cursorRequest.onsuccess?.(new Event('success'));
                        settle();
                        return;
                      }
                      valueReads += 1;
                      cursorRequest.result = {
                        primaryKey: key,
                        value: records.get(key),
                        delete: () => deleteRecord(key),
                        continue: () => {
                          position += 1;
                          step();
                        },
                      };
                      cursorRequest.onsuccess?.(new Event('success'));
                    });
                  };
                  begin();
                  step();
                  return cursorRequest;
                },
              };
            },
          };
        },
      };
      return tx;
    },
    close() {},
  };

  const factory = {
    open() {
      openCount += 1;
      const request: {
        result?: typeof database;
        error: DOMException | null;
        onsuccess: ((event: Event) => void) | null;
        onerror: ((event: Event) => void) | null;
        onblocked: ((event: Event) => void) | null;
        onupgradeneeded: ((event: Event) => void) | null;
      } = {
        error: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        request.result = database;
        request.onsuccess?.(new Event('success'));
      });
      return request;
    },
  };

  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: factory,
  });

  return {
    records,
    deletedKeys,
    transactionModes,
    get openCount() {
      return openCount;
    },
    get valueReads() {
      return valueReads;
    },
  };
}
