/**
 * The behaviour this package promises, as scenarios that run unchanged in Bun
 * against `fake-indexeddb` (`database.test.ts`, `web-storage.test.ts`) and in
 * Chromium, WebKit and Firefox, in a page and in a dedicated worker
 * (`engines.test.ts`). Each scenario makes its own database names and keys, so
 * scenarios never share state, and asserts with `check`, whose message names
 * what the engine did instead.
 */
import { defineDatabase, keyedStore, openDatabase, withDatabase } from './database';
import { observeStorageFailures, type StorageFailureEvent } from './failures';
import type { Cloned } from './parse';
import { localValue, sessionValue } from './web-storage';

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

/** Deletes `name`, failing when an open connection would block the delete. */
function deleteUnblocked(name: string, blockedBecause: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onblocked = () => reject(new ConformanceError(blockedBecause));
    request.onerror = () => reject(request.error);
  });
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'a write is read back through its store parser',
    needs: ['indexedDB'],
    async run() {
      const definition = notesDatabase(unique('roundtrip'));
      await withDatabase(definition, async (database) => {
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
      });
      await deleteUnblocked(definition.name, 'connection left open');
    },
  },
  {
    name: 'an unparseable value reads as absent, is counted, and only a write deletes it',
    needs: ['indexedDB'],
    async run() {
      const definition = notesDatabase(unique('unparseable'));
      await withDatabase(definition, async () => undefined);
      await putRaw(definition.name, 'notes', 'stale', { body: 'from an older build' });
      const failures = await failuresDuring(() =>
        withDatabase(definition, async (database) => {
          same(
            await database.read(['notes'], (tx) => tx.store('notes').get('stale')),
            null,
            'read-only get',
          );
          same(await countRaw(definition.name, 'notes'), 1, 'records after a read-only get');
          same(
            await database.write(['notes'], (tx) => tx.store('notes').get('stale')),
            null,
            'read-write get',
          );
          same(await countRaw(definition.name, 'notes'), 0, 'records after a read-write get');
        }),
      );
      same(
        failures,
        [
          { target: definition.name, failure: 'unparseable' },
          { target: definition.name, failure: 'unparseable' },
        ],
        'failures reported',
      );
      await deleteUnblocked(definition.name, 'connection left open');
    },
  },
  {
    name: 'a body that throws aborts its transaction, and the engine is not blamed',
    needs: ['indexedDB'],
    async run() {
      const definition = notesDatabase(unique('throwing-body'));
      const failures = await failuresDuring(() =>
        withDatabase(definition, async (database) => {
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
        }),
      );
      same(failures, [], 'failures reported');
      await deleteUnblocked(definition.name, 'connection left open');
    },
  },
  {
    name: 'a body that rejects after a read aborts the writes it queued',
    needs: ['indexedDB'],
    async run() {
      const definition = notesDatabase(unique('late-rejection'));
      await withDatabase(definition, async (database) => {
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
      });
      await deleteUnblocked(definition.name, 'connection left open');
    },
  },
  {
    name: 'a value that cannot be cloned rejects the write with DataCloneError',
    needs: ['indexedDB'],
    async run() {
      const definition = defineDatabase(unique('uncloneable'), 1, {
        values: keyedStore<string, () => void>((value) =>
          value instanceof Function ? () => undefined : null,
        ),
      });
      await withDatabase(definition, async (database) => {
        same(
          await rejection(
            database.write(['values'], (transaction) => {
              transaction.store('values').put('fn', () => undefined);
            }),
          ),
          'DataCloneError',
          'rejection',
        );
      });
      await deleteUnblocked(definition.name, 'connection left open');
    },
  },
  {
    name: 'awaiting other work inside a body loses the transaction from under it',
    needs: ['indexedDB'],
    async run() {
      const definition = notesDatabase(unique('inactive'));
      await withDatabase(definition, async (database) => {
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
      });
      await deleteUnblocked(definition.name, 'connection left open');
    },
  },
  {
    name: 'a strict write resolves and reads back, and the engine records strict durability',
    needs: ['indexedDB'],
    async run() {
      const definition = notesDatabase(unique('strict'));
      await withDatabase(definition, async (database) => {
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
      });
      const connection = await rawOpen(definition.name);
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
      await deleteUnblocked(definition.name, 'connection left open');
    },
  },
  {
    name: 'a newer version replaces every store and is not blocked by an open connection',
    needs: ['indexedDB'],
    async run() {
      const name = unique('versions');
      const older = notesDatabase(name, 1);
      const held = await openDatabase(older);
      await held.write(['notes'], (tx) => tx.store('notes').put('old', { text: 'old layout' }));
      const newer = defineDatabase(name, 2, { notes: keyedStore<string, Note>(parseNote) });
      await withDatabase(newer, async (database) => {
        same(
          await database.read(['notes'], (tx) => tx.store('notes').get('old')),
          null,
          'record of the older layout',
        );
      });
      same(
        await rejection(held.read(['notes'], (tx) => tx.store('notes').get('old'))),
        'InvalidStateError',
        'the older connection after it gave way',
      );
      const connection = await rawOpen(name);
      const stores = Array.from(connection.objectStoreNames);
      connection.close();
      same(stores, ['notes'], 'stores after the upgrade');
      await deleteUnblocked(name, 'connection left open');
    },
  },
  {
    name: 'an open given up before it starts rejects with the reason and is counted',
    needs: ['indexedDB'],
    async run() {
      const definition = notesDatabase(unique('abort-early'));
      const reason = new ConformanceError('gave up');
      const controller = new AbortController();
      controller.abort(reason);
      let rejected = false;
      const failures = await failuresDuring(async () => {
        rejected = await rejectsWith(
          openDatabase(definition, { signal: controller.signal }),
          reason,
        );
      });
      check(rejected, 'the open rejects with the abort reason');
      same(failures, [{ target: definition.name, failure: 'open_abandoned' }], 'failures reported');
    },
  },
  {
    name: 'an open given up mid-flight rejects, and its late connection is closed',
    needs: ['indexedDB'],
    async run() {
      const definition = notesDatabase(unique('abort-late'));
      const controller = new AbortController();
      const reason = new ConformanceError('timed out');
      const pending = openDatabase(definition, { signal: controller.signal });
      controller.abort(reason);
      check(await rejectsWith(pending, reason), 'the open rejects with the abort reason');
      await deleteUnblocked(definition.name, 'the abandoned connection is still open');
    },
  },
  {
    name: 'withDatabase closes its connection when its body throws',
    needs: ['indexedDB'],
    async run() {
      const definition = notesDatabase(unique('closes'));
      same(
        await rejection(
          withDatabase(definition, async () => {
            throw new ConformanceError('body failed');
          }),
        ),
        'ConformanceError',
        'rejection',
      );
      await deleteUnblocked(definition.name, 'withDatabase left its connection open');
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
      await deleteUnblocked(database, 'connection left open');
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
      });
      same(failures, [], 'failures reported');
    },
  },
];

function counterDatabase(name: string) {
  return defineDatabase(name, 1, { counts: keyedStore<'count', number>(parseCount) });
}

/**
 * Adds one to the count in database `name` `times` times, every addition a
 * read-modify-write of its own and all of them started at once, then answers
 * the count. Exported so a test can run it in two tabs together.
 */
export async function incrementConcurrently(name: string, times: number): Promise<number | null> {
  return await withDatabase(counterDatabase(name), async (database) => {
    await Promise.all(
      Array.from({ length: times }, () =>
        database.write(['counts'], async (transaction) => {
          const counts = transaction.store('counts');
          counts.put('count', ((await counts.get('count')) ?? 0) + 1);
        }),
      ),
    );
    return await database.read(['counts'], (tx) => tx.store('counts').get('count'));
  });
}
