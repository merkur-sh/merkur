/**
 * The behaviour this package promises, as scenarios that run unchanged in Bun
 * against `fake-indexeddb` (`conformance.test.ts`) and in Chromium, WebKit and
 * Firefox, in a page and in a dedicated worker (`engines.test.ts`). Each
 * scenario makes its own database names and keys, so scenarios never share
 * state, and asserts with `check`, whose message names what the engine did
 * instead.
 */
import { defineDatabase, deleteDatabases, keyedStore } from '../src/database';
import { observeStorageFailures, type StorageFailureEvent } from '../src/failures';
import type { Cloned } from '../src/parse';
import { localValue, removeLocalKeys, sessionValue } from '../src/web-storage';

/** What a realm has: a page has both, a dedicated worker has no web storage. */
export interface Capabilities {
  readonly indexedDB: boolean;
  readonly webStorage: boolean;
}

export interface Scenario {
  readonly name: string;
  /** Runs only where every one of these is available. */
  readonly needs: readonly (keyof Capabilities)[];
  /** Runs only where web storage is absent, to prove what the package does there. */
  readonly withoutWebStorage?: true;
  readonly run: () => Promise<void>;
}

export interface ScenarioResult {
  readonly name: string;
  /** `null` when the scenario passed, otherwise what failed. */
  readonly failure: string | null;
}

/** The scenarios a realm with these capabilities runs. */
export function scenariosFor(capabilities: Capabilities): readonly Scenario[] {
  return SCENARIOS.filter(
    (scenario) =>
      scenario.needs.every((need) => capabilities[need]) &&
      (scenario.withoutWebStorage !== true || !capabilities.webStorage),
  );
}

export async function runScenarios(capabilities: Capabilities): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenariosFor(capabilities)) {
    try {
      await scenario.run();
      results.push({ name: scenario.name, failure: null });
    } catch (cause) {
      results.push({ name: scenario.name, failure: describe(cause) });
    }
  }
  return results;
}

function describe(cause: unknown): string {
  if (cause instanceof Error || cause instanceof DOMException) {
    return `${cause.name}: ${cause.message}`;
  }
  return String(cause);
}

class ConformanceError extends Error {
  override readonly name = 'ConformanceError';
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ConformanceError(message);
}

function same<T>(actual: T, expected: T, what: string): void {
  const shown = JSON.stringify(actual);
  check(shown === JSON.stringify(expected), `${what}: got ${shown}`);
}

/** Whether `promise` rejects with exactly `expected`. */
function rejectsWith(promise: Promise<unknown>, expected: ConformanceError): Promise<boolean> {
  return promise.then(
    () => false,
    (cause) => cause === expected,
  );
}

/** The name an awaited promise rejected with, or `null` when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (cause) {
    if (cause instanceof Error || cause instanceof DOMException) return cause.name;
    return String(cause);
  }
}

let counter = 0;

/** A name no other scenario, run or tab uses. */
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${crypto.randomUUID()}`;
}

/** The failures reported while `body` runs. */
async function failuresDuring(body: () => Promise<void>): Promise<StorageFailureEvent[]> {
  const seen: StorageFailureEvent[] = [];
  const stop = observeStorageFailures((event) => seen.push(event));
  try {
    await body();
  } finally {
    stop();
  }
  return seen;
}

/**
 * Runs `body` while counting the connections this realm's `indexedDB.open`
 * hands out, and answers them in order.
 */
async function connectionsDuring(body: () => Promise<void>): Promise<IDBDatabase[]> {
  const opened: IDBDatabase[] = [];
  const open = indexedDB.open;
  indexedDB.open = (name, version) => {
    const request = open.call(indexedDB, name, version);
    request.addEventListener('success', () => opened.push(request.result));
    return request;
  };
  try {
    await body();
  } finally {
    indexedDB.open = open;
  }
  return opened;
}

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

function notesDatabase(name: string, version = 1) {
  return defineDatabase(name, version, {
    notes: keyedStore<string, Note>(parseNote),
    counts: keyedStore<number, number>(parseCount),
  });
}

function rawOpen(name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Writes through the raw API, as an older build or another tab would. */
async function putRaw(database: string, store: string, key: IDBValidKey, value: Cloned) {
  const connection = await rawOpen(database);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = connection.transaction(store, 'readwrite');
      transaction.objectStore(store).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    connection.close();
  }
}

async function countRaw(database: string, store: string): Promise<number> {
  const connection = await rawOpen(database);
  try {
    // Settled on the transaction's completion, not the request's: WebKit counts a
    // connection closed under a finishing transaction as still open to a delete.
    return await new Promise<number>((resolve, reject) => {
      const transaction = connection.transaction(store, 'readonly');
      const request = transaction.objectStore(store).count();
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    connection.close();
  }
}

/**
 * Deletes `name`, failing when an open connection would block the delete. The
 * package's own connection gives way to it, as it does to a newer version.
 */
function deleteUnblocked(name: string, blockedBecause: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onblocked = () => reject(new ConformanceError(blockedBecause));
    request.onerror = () => reject(request.error);
  });
}

const HELD = 'the shared connection did not give way to a delete';

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'a write is read back through its store parser',
    needs: ['indexedDB'],
    async run() {
      const database = notesDatabase(unique('roundtrip'));
      await database.write(['notes', 'counts'], (transaction) => {
        transaction.store('notes').put('first', { text: 'hello' });
        transaction.store('counts').put(1, 7);
      });
      same(
        await database.read(['notes', 'counts'], async (transaction) => [
          await transaction.store('notes').get('first'),
          await transaction.store('counts').get(1),
          await transaction.store('notes').get('missing'),
        ]),
        [{ text: 'hello' }, 7, null],
        'values read back',
      );
      await deleteUnblocked(database.name, HELD);
    },
  },
  {
    name: 'every transaction shares one connection, and one closed by a delete is reopened',
    needs: ['indexedDB'],
    async run() {
      const database = notesDatabase(unique('shared'));
      const opened = await connectionsDuring(async () => {
        await database.write(['notes'], (tx) => tx.store('notes').put('a', { text: 'one' }));
        await Promise.all([
          database.read(['notes'], (tx) => tx.store('notes').get('a')),
          database.write(['counts'], (tx) => tx.store('counts').put(1, 1)),
        ]);
        same(
          await database.read(['notes'], (tx) => tx.store('notes').get('a')),
          { text: 'one' },
          'value through the shared connection',
        );
        await deleteUnblocked(database.name, HELD);
        same(
          await database.read(['notes'], (tx) => tx.store('notes').get('a')),
          null,
          'value after the delete',
        );
      });
      same(opened.length, 2, 'connections opened: one, then one after the delete');
      await deleteUnblocked(database.name, HELD);
    },
  },
  {
    name: 'a connection closed underneath is replaced before the transaction begins',
    needs: ['indexedDB'],
    async run() {
      const database = notesDatabase(unique('closed-underneath'));
      let value: Note | null = null;
      const failures = await failuresDuring(async () => {
        const opened = await connectionsDuring(async () => {
          await database.write(['notes'], (tx) => tx.store('notes').put('a', { text: 'kept' }));
        });
        // Closed without an event, as the engine's own close is before its
        // `close` event arrives: `transaction()` answers `InvalidStateError`.
        for (const connection of opened) connection.close();
        value = await database.read(['notes'], (tx) => tx.store('notes').get('a'));
      });
      same(value, { text: 'kept' }, 'value through the replacement connection');
      same(failures, [{ target: database.name, failure: 'connection_lost' }], 'failures reported');
      await deleteUnblocked(database.name, HELD);
    },
  },
  {
    name: 'an unparseable value reads as absent, is counted, and only a write deletes it',
    needs: ['indexedDB'],
    async run() {
      const database = notesDatabase(unique('unparseable'));
      await database.read(['notes'], () => null);
      await putRaw(database.name, 'notes', 'stale', { body: 'from an older build' });
      const failures = await failuresDuring(async () => {
        same(
          await database.read(['notes'], (tx) => tx.store('notes').get('stale')),
          null,
          'read-only get',
        );
        same(await countRaw(database.name, 'notes'), 1, 'records after a read-only get');
        same(
          await database.write(['notes'], (tx) => tx.store('notes').get('stale')),
          null,
          'read-write get',
        );
        same(await countRaw(database.name, 'notes'), 0, 'records after a read-write get');
      });
      same(
        failures,
        [
          { target: database.name, failure: 'unparseable' },
          { target: database.name, failure: 'unparseable' },
        ],
        'failures reported',
      );
      await deleteUnblocked(database.name, HELD);
    },
  },
  {
    name: 'a body that throws aborts its transaction, and the engine is not blamed',
    needs: ['indexedDB'],
    async run() {
      const database = notesDatabase(unique('throwing-body'));
      const failures = await failuresDuring(async () => {
        const refusal = new ConformanceError('refused by the body');
        check(
          await rejectsWith(
            database.write(['notes', 'counts'], (transaction) => {
              transaction.store('notes').put('kept-out', { text: 'never' });
              transaction.store('counts').put(2, 2);
              throw refusal;
            }),
            refusal,
          ),
          'the write rejects with the body’s own error',
        );
        same(
          await database.read(['notes', 'counts'], async (transaction) => [
            await transaction.store('notes').get('kept-out'),
            await transaction.store('counts').get(2),
          ]),
          [null, null],
          'writes of the aborted transaction',
        );
      });
      same(failures, [], 'failures reported');
      await deleteUnblocked(database.name, HELD);
    },
  },
  {
    name: 'a body that rejects after a read aborts the writes it queued',
    needs: ['indexedDB'],
    async run() {
      const database = notesDatabase(unique('late-rejection'));
      same(
        await rejection(
          database.write(['notes'], async (transaction) => {
            const store = transaction.store('notes');
            store.put('half', { text: 'queued' });
            await store.get('half');
            throw new ConformanceError('late refusal');
          }),
        ),
        'ConformanceError',
        'rejection',
      );
      same(
        await database.read(['notes'], (tx) => tx.store('notes').get('half')),
        null,
        'the queued write',
      );
      await deleteUnblocked(database.name, HELD);
    },
  },
  {
    name: 'a value that cannot be cloned rejects the write with DataCloneError',
    needs: ['indexedDB'],
    async run() {
      const database = defineDatabase(unique('uncloneable'), 1, {
        values: keyedStore<string, () => void>((value) =>
          value instanceof Function ? () => undefined : null,
        ),
      });
      same(
        await rejection(
          database.write(['values'], (transaction) => {
            transaction.store('values').put('fn', () => undefined);
          }),
        ),
        'DataCloneError',
        'rejection',
      );
      await deleteUnblocked(database.name, HELD);
    },
  },
  {
    name: 'awaiting other work inside a body loses the transaction from under it',
    needs: ['indexedDB'],
    async run() {
      const database = notesDatabase(unique('inactive'));
      // `TransactionInactiveError` while the commit is under way,
      // `InvalidStateError` once it has finished: which one depends on how
      // far the engine got, never on anything the body can control.
      const name = await rejection(
        database.write(['notes'], async (transaction) => {
          transaction.store('notes').put('before', { text: 'committed' });
          await new Promise((resolve) => setTimeout(resolve, 0));
          transaction.store('notes').put('after', { text: 'too late' });
        }),
      );
      check(
        name === 'TransactionInactiveError' || name === 'InvalidStateError',
        `the late request is refused as inactive or finished: got ${name}`,
      );
      // Whether the earlier write landed is not the body's to decide: Chromium
      // and WebKit had not finished it when the timer fired, so the refusal
      // aborted the whole transaction, while `fake-indexeddb` had committed it.
      // Only the late write is certain to be lost.
      same(
        await database.read(['notes'], (tx) => tx.store('notes').get('after')),
        null,
        'the late write',
      );
      await deleteUnblocked(database.name, HELD);
    },
  },
  {
    name: 'a strict write resolves and reads back, and the engine records strict durability',
    needs: ['indexedDB'],
    async run() {
      const database = notesDatabase(unique('strict'));
      await database.write(
        ['notes'],
        (transaction) => transaction.store('notes').put('durable', { text: 'flushed' }),
        { durability: 'strict' },
      );
      same(
        await database.read(['notes'], (tx) => tx.store('notes').get('durable')),
        { text: 'flushed' },
        'value read back',
      );
      const connection = await rawOpen(database.name);
      try {
        const transaction = connection.transaction('notes', 'readwrite', { durability: 'strict' });
        check(
          !('durability' in transaction) || transaction.durability === 'strict',
          'an engine that reports durability reports the requested strict durability',
        );
        transaction.abort();
      } finally {
        connection.close();
      }
      await deleteUnblocked(database.name, HELD);
    },
  },
  {
    name: 'a newer version replaces every store, and the older build can no longer open it',
    needs: ['indexedDB'],
    async run() {
      const name = unique('versions');
      const older = notesDatabase(name, 1);
      await older.write(['notes'], (tx) => tx.store('notes').put('old', { text: 'old layout' }));
      const newer = defineDatabase(name, 2, { notes: keyedStore<string, Note>(parseNote) });
      same(
        await newer.read(['notes'], (tx) => tx.store('notes').get('old')),
        null,
        'record of the older layout',
      );
      let refused: string | null = null;
      const failures = await failuresDuring(async () => {
        refused = await rejection(older.read(['notes'], (tx) => tx.store('notes').get('old')));
      });
      same(refused, 'VersionError', 'the older build after its connection gave way');
      same(failures, [{ target: name, failure: 'open_failed' }], 'failures reported');
      const connection = await rawOpen(name);
      const stores = Array.from(connection.objectStoreNames);
      connection.close();
      same(stores, ['notes'], 'stores after the upgrade');
      await deleteUnblocked(name, HELD);
    },
  },
  {
    name: 'an open given up before it starts rejects with the reason and is counted',
    needs: ['indexedDB'],
    async run() {
      const database = notesDatabase(unique('abort-early'));
      const reason = new ConformanceError('gave up');
      const controller = new AbortController();
      controller.abort(reason);
      let rejected = false;
      const failures = await failuresDuring(async () => {
        rejected = await rejectsWith(database.connect({ signal: controller.signal }), reason);
      });
      check(rejected, 'the open rejects with the abort reason');
      same(failures, [{ target: database.name, failure: 'open_abandoned' }], 'failures reported');
    },
  },
  {
    name: 'an open given up mid-flight rejects, its late connection is closed, and the next opens',
    needs: ['indexedDB'],
    async run() {
      const database = notesDatabase(unique('abort-late'));
      const controller = new AbortController();
      const reason = new ConformanceError('timed out');
      const pending = database.connect({ signal: controller.signal });
      controller.abort(reason);
      check(await rejectsWith(pending, reason), 'the open rejects with the abort reason');
      await deleteUnblocked(database.name, 'the abandoned connection is still open');
      await database.write(['notes'], (tx) => tx.store('notes').put('next', { text: 'opened' }));
      same(
        await database.read(['notes'], (tx) => tx.store('notes').get('next')),
        { text: 'opened' },
        'a transaction after the abandoned open',
      );
      await deleteUnblocked(database.name, HELD);
    },
  },
  {
    name: 'web storage reads back JSON through its parser, each area on its own',
    needs: ['webStorage'],
    async run() {
      const key = unique('roundtrip');
      const local = localValue(key, (value) => (isText(value) ? value : null));
      const session = sessionValue(key, (value) => (isText(value) ? value : null));
      check(local.write('local text'), 'the local write is stored');
      same(localStorage.getItem(key), '"local text"', 'stored text');
      same(local.read(), 'local text', 'local value');
      same(session.read(), null, 'session value before its own write');
      check(session.write('session text'), 'the session write is stored');
      same(session.read(), 'session text', 'session value');
      local.remove();
      session.remove();
      same(localStorage.getItem(key), null, 'local key after removal');
    },
  },
  {
    name: 'web storage removes and counts a value its parser refuses, or text that is not JSON',
    needs: ['webStorage'],
    async run() {
      const refused = unique('refused');
      const garbled = unique('garbled');
      localStorage.setItem(refused, '{"colour":"dark"}');
      localStorage.setItem(garbled, 'not json');
      const failures = await failuresDuring(async () => {
        same(localValue(refused, (value) => (isText(value) ? value : null)).read(), null, 'value');
        same(localValue(garbled, (value) => (isText(value) ? value : null)).read(), null, 'text');
      });
      same(localStorage.getItem(refused), null, 'refused key after the read');
      same(localStorage.getItem(garbled), null, 'garbled key after the read');
      same(
        failures,
        [
          { target: refused, failure: 'unparseable' },
          { target: garbled, failure: 'unparseable' },
        ],
        'failures reported',
      );
    },
  },
  {
    name: 'a write past the quota answers false and is counted as quota',
    needs: ['webStorage'],
    async run() {
      const key = unique('quota');
      const value = localValue(key, (stored) => (isText(stored) ? stored : null));
      // Twelve million characters: more than every engine's per-origin limit (5 to 10 MB).
      let stored = true;
      const failures = await failuresDuring(async () => {
        stored = value.write('x'.repeat(12_000_000));
      });
      value.remove();
      check(!stored, 'the oversized write answers false');
      same(failures, [{ target: key, failure: 'quota' }], 'failures reported');
    },
  },
  {
    name: 'read-write transactions apply every change once when callers race',
    needs: ['indexedDB'],
    async run() {
      const database = unique('counter');
      same(await incrementConcurrently(database, 25), 25, 'final count');
      await deleteUnblocked(database, HELD);
    },
  },
  {
    name: 'without web storage every call is inert and is not a failure',
    needs: [],
    withoutWebStorage: true,
    async run() {
      const value = localValue(unique('absent'), (stored) =>
        Number.isSafeInteger(stored) ? Number(stored) : null,
      );
      const failures = await failuresDuring(async () => {
        same(value.read(), null, 'read');
        same(value.write(1), false, 'write');
        value.remove();
        removeLocalKeys(() => true);
      });
      same(failures, [], 'failures reported');
    },
  },
  {
    name: 'removeLocalKeys removes the keys it names and leaves the rest',
    needs: ['webStorage'],
    async run() {
      const stale = unique('stale');
      const kept = unique('kept');
      const names = [`${stale}-a`, `${stale}-b`, kept];
      for (const name of names) localStorage.setItem(name, JSON.stringify(name));
      const failures = await failuresDuring(async () => {
        removeLocalKeys((key) => key.startsWith(stale));
      });
      same(
        names.map((name) => localStorage.getItem(name)),
        [null, null, JSON.stringify(kept)],
        'keys after the removal',
      );
      same(failures, [], 'failures reported');
      localStorage.removeItem(kept);
    },
  },
  {
    name: 'deleteDatabases deletes the databases it names, and a deleted one reopens empty',
    needs: ['indexedDB'],
    async run() {
      const stale = unique('stale');
      const deleted = notesDatabase(`${stale}-open`);
      const kept = notesDatabase(unique('kept'));
      for (const database of [deleted, kept]) {
        await database.write(['notes'], (tx) => tx.store('notes').put('a', { text: 'there' }));
      }
      // One the package never opened, as an earlier build's module left it.
      (await rawOpen(`${stale}-raw`)).close();
      const failures = await failuresDuring(() =>
        deleteDatabases((name) => name.startsWith(stale)),
      );
      same(failures, [], 'failures reported');
      const remaining = (await indexedDB.databases()).flatMap(({ name }) =>
        name === undefined ? [] : [name],
      );
      check(!remaining.some((name) => name.startsWith(stale)), 'every named database is gone');
      check(remaining.includes(kept.name), 'the database it did not name is kept');
      same(
        await deleted.read(['notes'], (tx) => tx.store('notes').get('a')),
        null,
        'a deleted database, opened again',
      );
      same(
        await kept.read(['notes'], (tx) => tx.store('notes').get('a')),
        { text: 'there' },
        'the kept database',
      );
      await deleteUnblocked(deleted.name, HELD);
      await deleteUnblocked(kept.name, HELD);
    },
  },
];

/**
 * Adds one to the count in database `name` `times` times, every addition a
 * read-modify-write of its own and all of them started at once, then answers
 * the count. Exported so a test can run it in two tabs together.
 */
export async function incrementConcurrently(name: string, times: number): Promise<number | null> {
  const database = defineDatabase(name, 1, { counts: keyedStore<'count', number>(parseCount) });
  try {
    await Promise.all(
      Array.from({ length: times }, () =>
        database.write(['counts'], async (transaction) => {
          const counts = transaction.store('counts');
          counts.put('count', ((await counts.get('count')) ?? 0) + 1);
        }),
      ),
    );
    return await database.read(['counts'], (tx) => tx.store('counts').get('count'));
  } finally {
    database.close();
  }
}
