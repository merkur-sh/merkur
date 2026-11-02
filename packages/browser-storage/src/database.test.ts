import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';

import { defineDatabase, keyedStore, openDatabase, withDatabase } from './database';
import type { Cloned } from './parse';

interface Note {
  readonly text: string;
}

const isText = (value: unknown): value is string => value === String(value);

function parseNote(value: Cloned): Note | null {
  return value instanceof Object && 'text' in value && isText(value.text)
    ? { text: value.text }
    : null;
}

function parseCount(value: Cloned): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null;
}

const notes = defineDatabase('notes', 1, {
  notes: keyedStore<string, Note>(parseNote),
  counts: keyedStore<number, number>(parseCount),
});

const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
});

afterEach(() => {
  if (originalIndexedDb === undefined) Reflect.deleteProperty(globalThis, 'indexedDB');
  else Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
});

/** Writes a value the store's parser refuses, through the raw API, as an older build would. */
async function putRaw(store: string, key: IDBValidKey, value: Cloned): Promise<void> {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('notes');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = connection.transaction(store, 'readwrite');
    transaction.objectStore(store).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  connection.close();
}

describe('typed IndexedDB transactions', () => {
  test('a write is read back through its store parser', async () => {
    await withDatabase(notes, async (database) => {
      await database.write(['notes', 'counts'], (transaction) => {
        transaction.store('notes').put('first', { text: 'hello' });
        transaction.store('counts').put(1, 7);
      });
      const read = await database.read(['notes', 'counts'], async (transaction) => [
        await transaction.store('notes').get('first'),
        await transaction.store('counts').get(1),
        await transaction.store('notes').get('missing'),
      ]);
      expect(read).toEqual([{ text: 'hello' }, 7, null]);
    });
  });

  test('a value its parser refuses reads as absent and is deleted only by a write', async () => {
    await withDatabase(notes, async () => undefined);
    await putRaw('notes', 'stale', { body: 'from an older build' });

    await withDatabase(notes, async (database) => {
      expect(await database.read(['notes'], (tx) => tx.store('notes').get('stale'))).toBeNull();
      expect(await countRaw('notes')).toBe(1);

      expect(await database.write(['notes'], (tx) => tx.store('notes').get('stale'))).toBeNull();
      expect(await countRaw('notes')).toBe(0);
    });
  });

  test('a body that throws aborts the transaction and none of its writes land', async () => {
    await withDatabase(notes, async (database) => {
      const failure = new Error('refused');
      await expect(
        database.write(['notes', 'counts'], (transaction) => {
          transaction.store('notes').put('kept-out', { text: 'never' });
          transaction.store('counts').put(2, 2);
          throw failure;
        }),
      ).rejects.toBe(failure);

      expect(
        await database.read(['notes', 'counts'], async (transaction) => [
          await transaction.store('notes').get('kept-out'),
          await transaction.store('counts').get(2),
        ]),
      ).toEqual([null, null]);
    });
  });

  test('a body that rejects after a read aborts the writes it queued', async () => {
    await withDatabase(notes, async (database) => {
      await expect(
        database.write(['notes'], async (transaction) => {
          const store = transaction.store('notes');
          store.put('half', { text: 'queued' });
          await store.get('half');
          throw new Error('late refusal');
        }),
      ).rejects.toThrow('late refusal');

      expect(await database.read(['notes'], (tx) => tx.store('notes').get('half'))).toBeNull();
    });
  });

  test('a write that cannot be cloned rejects the transaction', async () => {
    const functions = defineDatabase('functions', 1, {
      values: keyedStore<string, () => void>((value) =>
        value instanceof Function ? () => undefined : null,
      ),
    });
    await withDatabase(functions, async (database) => {
      await expect(
        database.write(['values'], (transaction) => {
          transaction.store('values').put('fn', () => undefined);
        }),
      ).rejects.toThrow();
    });
  });

  test('read resolves only after its transaction completes', async () => {
    await withDatabase(notes, async (database) => {
      const order: string[] = [];
      await database.read(['notes'], (transaction) => {
        order.push('body');
        return transaction.store('notes').get('anything');
      });
      order.push('resolved');
      expect(order).toEqual(['body', 'resolved']);
    });
  });
});

describe('schema versions', () => {
  test('a newer version replaces every store with the declared ones, empty', async () => {
    await withDatabase(notes, (database) =>
      database.write(['notes'], (tx) => tx.store('notes').put('old', { text: 'old shape' })),
    );

    const replaced = defineDatabase('notes', 2, {
      notes: keyedStore<string, Note>(parseNote),
    });
    await withDatabase(replaced, async (database) => {
      expect(await database.read(['notes'], (tx) => tx.store('notes').get('old'))).toBeNull();
    });
    const names = await new Promise<string[]>((resolve, reject) => {
      const request = factory.open('notes');
      request.onsuccess = () => {
        resolve(Array.from(request.result.objectStoreNames));
        request.result.close();
      };
      request.onerror = () => reject(request.error);
    });
    expect(names).toEqual(['notes']);
  });

  test('an open connection gives way to a newer version instead of blocking it', async () => {
    const held = await openDatabase(notes);
    const newer = defineDatabase('notes', 2, { notes: keyedStore<string, Note>(parseNote) });

    const opened = await openDatabase(newer);
    opened.close();
    await expect(held.read(['notes'], (tx) => tx.store('notes').get('x'))).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
  });

  test('refuses a version that is not a positive integer', () => {
    expect(() => defineDatabase('bad', 0, {})).toThrow(RangeError);
    expect(() => defineDatabase('bad', 1.5, {})).toThrow(RangeError);
  });
});

describe('opening', () => {
  test('an aborted signal rejects with its reason before opening', async () => {
    const reason = new Error('gave up');
    const controller = new AbortController();
    controller.abort(reason);
    await expect(openDatabase(notes, { signal: controller.signal })).rejects.toBe(reason);
  });

  test('an abort while the open is in flight rejects, and the late connection closes', async () => {
    const controller = new AbortController();
    const reason = new Error('timed out');
    const pending = openDatabase(notes, { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);

    // A late connection still open would block this delete until it closed.
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase('notes');
      request.onsuccess = () => resolve();
      request.onblocked = () => reject(new Error('the abandoned connection is still open'));
      request.onerror = () => reject(request.error);
    });
  });

  test('rejects where IndexedDB does not exist', async () => {
    Reflect.deleteProperty(globalThis, 'indexedDB');
    await expect(openDatabase(notes)).rejects.toThrow('IndexedDB is unavailable');
  });

  test('withDatabase closes the connection when its body throws', async () => {
    let held: { close(): void } | null = null;
    await expect(
      withDatabase(notes, async (database) => {
        held = database;
        throw new Error('body failed');
      }),
    ).rejects.toThrow('body failed');
    expect(held).not.toBeNull();
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase('notes');
      request.onsuccess = () => resolve();
      request.onblocked = () => reject(new Error('withDatabase left its connection open'));
    });
  });
});

describe('static typing', () => {
  // Each call the compiler refuses is also run, so the test states what
  // IndexedDB itself would have done with it.
  test('store names, keys and values are checked at compile time', async () => {
    await withDatabase(notes, async (database) => {
      await expect(
        database.write(['notes'], (transaction) => {
          // @ts-expect-error a store outside the transaction's scope
          transaction.store('counts');
        }),
      ).rejects.toMatchObject({ name: 'NotFoundError' });
      await expect(
        database.read(['notes'], (transaction) => {
          // @ts-expect-error a read-only transaction cannot write
          transaction.store('notes').put('x', { text: 'x' });
        }),
        // A read-only store has no `put` at all, so the call never reaches IndexedDB.
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        // @ts-expect-error a store the database does not declare
        database.read(['missing'], () => null),
      ).rejects.toMatchObject({ name: 'NotFoundError' });

      // IndexedDB takes these; only the types refuse them.
      await database.write(['notes'], (transaction) => {
        // @ts-expect-error a key of the wrong type
        transaction.store('notes').put(1, { text: 'x' });
        // @ts-expect-error a value of the wrong type
        transaction.store('notes').put('x', { body: 'x' });
      });
      const note: Note | null = await database.read(['notes'], (tx) => tx.store('notes').get('x'));
      expect(note).toBeNull();
    });
  });
});

async function countRaw(store: string): Promise<number> {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('notes');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<number>((resolve, reject) => {
      const request = connection.transaction(store, 'readonly').objectStore(store).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    connection.close();
  }
}
