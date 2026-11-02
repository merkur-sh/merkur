import { afterEach, describe, expect, test } from 'bun:test';

import forceCloseDatabase from 'fake-indexeddb/lib/forceCloseDatabase';

import { defineDatabase, keyedStore, type WriteOptions } from '../src/database';
import { observeStorageFailures, type StorageFailureEvent } from '../src/failures';
import type { Cloned } from '../src/parse';
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

function notesDatabase(name: string) {
  return defineDatabase(name, 1, {
    notes: keyedStore<string, Note>(parseNote),
    counts: keyedStore<number, number>((value) =>
      Number.isSafeInteger(value) ? Number(value) : null,
    ),
  });
}

afterEach(restoreGlobals);

describe('opening', () => {
  test('rejects where IndexedDB does not exist, and counts it', async () => {
    removeGlobal('indexedDB');
    const notes = notesDatabase('absent');
    const seen: StorageFailureEvent[] = [];
    const stop = observeStorageFailures((event) => seen.push(event));
    try {
      await expect(notes.read(['notes'], () => null)).rejects.toThrow('IndexedDB is unavailable');
    } finally {
      stop();
    }
    expect(seen).toEqual([{ target: 'absent', failure: 'open_failed' }]);
  });

  test('refuses a version that is not a positive integer', () => {
    expect(() => defineDatabase('bad', 0, {})).toThrow(RangeError);
    expect(() => defineDatabase('bad', 1.5, {})).toThrow(RangeError);
  });

  test('a connection the engine force-closes is replaced by the next transaction', async () => {
    const factory = installIndexedDb();
    const opened: IDBDatabase[] = [];
    const open = factory.open.bind(factory);
    factory.open = (name, version) => {
      const request = open(name, version);
      request.addEventListener('success', () => opened.push(request.result));
      return request;
    };
    const notes = notesDatabase('force-closed');
    await notes.write(['notes'], (tx) => tx.store('notes').put('a', { text: 'kept' }));
    const [first] = opened;
    if (first === undefined) throw new Error('no connection was opened');
    // The `close` event an engine fires when it closes a connection itself:
    // site data cleared, or WebKit's storage process lost.
    const seen: StorageFailureEvent[] = [];
    const stop = observeStorageFailures((event) => seen.push(event));
    try {
      const closed = new Promise((resolve) => first.addEventListener('close', resolve));
      forceCloseDatabase(first);
      await closed;
      expect(await notes.read(['notes'], (tx) => tx.store('notes').get('a'))).toEqual({
        text: 'kept',
      });
    } finally {
      stop();
      notes.close();
    }
    expect(opened).toHaveLength(2);
    expect(seen).toEqual([{ target: 'force-closed', failure: 'connection_lost' }]);
  });
});

describe('static typing', () => {
  // Each call the compiler refuses is also run, so the test states what
  // IndexedDB itself would have done with it.
  test('store names, keys and values are checked at compile time', async () => {
    installIndexedDb();
    const database = notesDatabase('typing');
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
    database.close();
  });
});
