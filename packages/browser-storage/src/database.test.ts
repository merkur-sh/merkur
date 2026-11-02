import { afterEach, describe, expect, test } from 'bun:test';

import {
  defineDatabase,
  keyedStore,
  openDatabase,
  type WriteOptions,
  withDatabase,
} from './database';
import { observeStorageFailures, type StorageFailureEvent } from './failures';
import type { Cloned } from './parse';
import { installIndexedDb, removeGlobal, restoreGlobals } from './test-environment';

// The behaviour every engine must share is in `conformance.ts`, run here and in
// real browsers. This file holds what only Bun can set up, and the types.

interface Note {
  readonly text: string;
}

const isText = (value: unknown): value is string => value === String(value);

function parseNote(value: Cloned): Note | null {
  return value instanceof Object && 'text' in value && isText(value.text)
    ? { text: value.text }
    : null;
}

const notes = defineDatabase('notes', 1, {
  notes: keyedStore<string, Note>(parseNote),
  counts: keyedStore<number, number>((value) =>
    Number.isSafeInteger(value) ? Number(value) : null,
  ),
});

afterEach(restoreGlobals);

describe('opening', () => {
  test('rejects where IndexedDB does not exist, and counts it', async () => {
    removeGlobal('indexedDB');
    const seen: StorageFailureEvent[] = [];
    const stop = observeStorageFailures((event) => seen.push(event));
    try {
      await expect(openDatabase(notes)).rejects.toThrow('IndexedDB is unavailable');
    } finally {
      stop();
    }
    expect(seen).toEqual([{ target: 'notes', failure: 'open_failed' }]);
  });

  test('refuses a version that is not a positive integer', () => {
    expect(() => defineDatabase('bad', 0, {})).toThrow(RangeError);
    expect(() => defineDatabase('bad', 1.5, {})).toThrow(RangeError);
  });
});

describe('static typing', () => {
  // Each call the compiler refuses is also run, so the test states what
  // IndexedDB itself would have done with it.
  test('store names, keys and values are checked at compile time', async () => {
    installIndexedDb();
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
      // @ts-expect-error a durability IndexedDB does not define
      const unknownDurability: WriteOptions = { durability: 'eventually' };
      expect(String(unknownDurability.durability)).toBe('eventually');

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
