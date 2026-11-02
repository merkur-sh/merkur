import type { Cloned, Parse } from './parse';

/*
 * A typed IndexedDB over the native objects, after `idb`'s schema typing but
 * not its runtime: `idb` wraps every database, transaction, store and cursor in
 * a Proxy and looks each property read up in a WeakMap, which this does not
 * pay. It covers what Merkur stores, out-of-line keys and whole values, and
 * adds what `idb` leaves to its caller: every value read is parsed, and a
 * schema change replaces the database instead of migrating it.
 */

declare const KEY: unique symbol;

/** One object store: values of type `V` under out-of-line keys of type `K`. */
export interface StoreDefinition<K extends IDBValidKey, V> {
  readonly parse: Parse<Cloned, V>;
  /** Carries `K` for the type system; never present at runtime. */
  readonly [KEY]?: K;
}

/** The stores a database holds, by name. */
export type StoreDefinitions = Readonly<Record<string, StoreDefinition<IDBValidKey, unknown>>>;

/**
 * A database's name, its schema version and its stores. The version is the
 * schema's identity, not a migration step: opening a database stored under an
 * older version deletes every store it holds and creates the declared ones
 * empty, so a changed layout is a hard cutover and nothing ever reads a
 * record in an older shape. Bump it whenever a store is added, removed,
 * renamed, or its value shape changes.
 */
export interface DatabaseDefinition<S extends StoreDefinitions> {
  readonly name: string;
  readonly version: number;
  readonly stores: S;
}

type KeyOf<D> = D extends StoreDefinition<infer K, unknown> ? K : never;
type ValueOf<D> = D extends StoreDefinition<IDBValidKey, infer V> ? V : never;
type StoreName<S extends StoreDefinitions> = keyof S & string;

/** A store as a read-only transaction sees it. */
export interface ReadStore<K extends IDBValidKey, V> {
  /**
   * The value under `key`, or `null` when there is none or it does not parse.
   * In a read-write transaction a value that does not parse is also deleted.
   */
  get(key: K): Promise<V | null>;
}

/**
 * A store as a read-write transaction sees it. Writes are queued on the
 * transaction rather than awaited one by one: a failed write aborts the
 * transaction, and `Database.write` rejects with its error.
 */
export interface WriteStore<K extends IDBValidKey, V> extends ReadStore<K, V> {
  put(key: K, value: V): void;
  delete(key: K): void;
}

export interface ReadTransaction<S extends StoreDefinitions, N extends StoreName<S>> {
  store<M extends N>(name: M): ReadStore<KeyOf<S[M]>, ValueOf<S[M]>>;
}

export interface WriteTransaction<S extends StoreDefinitions, N extends StoreName<S>> {
  store<M extends N>(name: M): WriteStore<KeyOf<S[M]>, ValueOf<S[M]>>;
}

/**
 * The body of a transaction. IndexedDB commits a transaction as soon as it has
 * no request in flight at the end of a task, so a body awaits only this
 * transaction's own requests: awaiting anything else (`crypto.subtle`, a
 * fetch, a timer) lets it commit underneath, and the next request throws
 * `TransactionInactiveError`. Do that work before the transaction or after it.
 */
type TransactionBody<T, R> = (transaction: T) => R | Promise<R>;

export interface Database<S extends StoreDefinitions> {
  /** Runs `body` in one read-only transaction over `stores`, resolving once it completes. */
  read<N extends StoreName<S>, R>(
    stores: readonly N[],
    body: TransactionBody<ReadTransaction<S, N>, R>,
  ): Promise<R>;
  /**
   * Runs `body` in one read-write transaction over `stores`, resolving with its
   * result once every write is durable. A body that throws aborts the
   * transaction, so none of its writes land.
   */
  write<N extends StoreName<S>, R>(
    stores: readonly N[],
    body: TransactionBody<WriteTransaction<S, N>, R>,
  ): Promise<R>;
  close(): void;
}

export interface OpenOptions {
  /**
   * Gives up on the open. A connection that arrives after the abort is closed
   * the moment it does, so an abandoned open never holds the database.
   */
  readonly signal?: AbortSignal;
}

/** A store of `V` values under out-of-line keys of type `K`, each read through `parse`. */
export function keyedStore<K extends IDBValidKey, V>(
  parse: Parse<Cloned, V>,
): StoreDefinition<K, V> {
  return { parse };
}

export function defineDatabase<S extends StoreDefinitions>(
  name: string,
  version: number,
  stores: S,
): DatabaseDefinition<S> {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError(`IndexedDB ${name} version must be a positive integer`);
  }
  return { name, version, stores };
}

/**
 * Opens the database. The connection closes itself when another tab opens a
 * newer version, so a schema cutover is never blocked by a tab still running
 * the previous build's connection.
 */
export function openDatabase<S extends StoreDefinitions>(
  definition: DatabaseDefinition<S>,
  options: OpenOptions = {},
): Promise<Database<S>> {
  const { signal } = options;
  return new Promise<Database<S>>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = indexedDB.open(definition.name, definition.version);
    let abandoned = false;
    const onAbort = (): void => {
      abandoned = true;
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    request.onupgradeneeded = () => {
      replaceStores(request.result, definition.stores);
    };
    request.onsuccess = () => {
      signal?.removeEventListener('abort', onAbort);
      const connection = request.result;
      if (abandoned) {
        connection.close();
        return;
      }
      connection.onversionchange = () => connection.close();
      resolve(createDatabase(connection, definition.stores));
    };
    request.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      if (abandoned) return;
      reject(request.error ?? new Error(`Unable to open IndexedDB ${definition.name}`));
    };
    // `blocked` needs no handler: the open waits until the older connections
    // close, which this module's own connections do on `versionchange`, and a
    // caller that cannot wait passes a signal.
  });
}

/** Opens the database, runs `use`, and closes the connection however `use` ends. */
export async function withDatabase<S extends StoreDefinitions, R>(
  definition: DatabaseDefinition<S>,
  use: (database: Database<S>) => Promise<R>,
  options?: OpenOptions,
): Promise<R> {
  const database = await openDatabase(definition, options);
  try {
    return await use(database);
  } finally {
    database.close();
  }
}

function replaceStores(connection: IDBDatabase, stores: StoreDefinitions): void {
  for (const name of Array.from(connection.objectStoreNames)) {
    connection.deleteObjectStore(name);
  }
  for (const name of Object.keys(stores)) {
    connection.createObjectStore(name);
  }
}

function createDatabase<S extends StoreDefinitions>(
  connection: IDBDatabase,
  stores: S,
): Database<S> {
  return {
    read(names, body) {
      return runTransaction(
        connection,
        names,
        'readonly',
        (transaction) => ({
          store: (name) => readStore(transaction.objectStore(name), parserOf(stores, name)),
        }),
        body,
      );
    },
    write(names, body) {
      return runTransaction(
        connection,
        names,
        'readwrite',
        (transaction) => ({
          store: (name) => writeStore(transaction.objectStore(name), parserOf(stores, name)),
        }),
        body,
      );
    },
    close() {
      connection.close();
    },
  };
}

/** The parser declared for `name`. */
function parserOf<S extends StoreDefinitions, N extends StoreName<S>>(
  stores: S,
  name: N,
): Parse<Cloned, ValueOf<S[N]>> {
  const definition = stores[name];
  if (definition === undefined) throw new Error(`IndexedDB store ${name} is not declared`);
  // SAFETY: `definition` is `S[N]`, a `StoreDefinition<KeyOf<S[N]>, ValueOf<S[N]>>`, so its
  // parser returns `ValueOf<S[N]>`; TypeScript cannot carry that through the indexed access.
  return definition.parse as Parse<Cloned, ValueOf<S[N]>>;
}

/**
 * Settles once both the transaction and the body have: with the body's result
 * when the transaction completes, with the first failure otherwise. A body
 * that fails aborts the transaction.
 */
function runTransaction<T, R>(
  connection: IDBDatabase,
  names: readonly string[],
  mode: IDBTransactionMode,
  view: (transaction: IDBTransaction) => T,
  body: TransactionBody<T, R>,
): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const transaction = connection.transaction(names, mode);
    let settled = false;
    let completed = false;
    let result: { readonly value: R } | null = null;
    const fail = (cause: unknown): void => {
      if (settled) return;
      settled = true;
      reject(cause);
    };
    const finish = (): void => {
      if (settled || !completed || result === null) return;
      settled = true;
      resolve(result.value);
    };
    transaction.oncomplete = () => {
      completed = true;
      finish();
    };
    transaction.onabort = () => {
      fail(transaction.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
    };
    transaction.onerror = () => {
      fail(transaction.error ?? new DOMException('IndexedDB transaction failed', 'UnknownError'));
    };
    // The body starts synchronously, inside the task that created the
    // transaction, so its first request is issued while the transaction is
    // certainly active.
    let started: R | Promise<R>;
    try {
      started = body(view(transaction));
    } catch (cause) {
      started = Promise.reject(cause);
    }
    Promise.resolve(started).then(
      (value) => {
        result = { value };
        finish();
      },
      (cause: unknown) => {
        abortUnlessFinished(transaction);
        fail(cause);
      },
    );
  });
}

/**
 * Aborts a transaction the body gave up on. One that has already committed or
 * aborted answers `InvalidStateError`, and the body's own failure is still the
 * answer the caller gets.
 */
function abortUnlessFinished(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'InvalidStateError')) throw cause;
  }
}

function readStore<K extends IDBValidKey, V>(
  objectStore: IDBObjectStore,
  parse: Parse<Cloned, V>,
): ReadStore<K, V> {
  return { get: (key) => getParsed(objectStore, key, parse, false) };
}

function writeStore<K extends IDBValidKey, V>(
  objectStore: IDBObjectStore,
  parse: Parse<Cloned, V>,
): WriteStore<K, V> {
  return {
    get: (key) => getParsed(objectStore, key, parse, true),
    put(key, value) {
      objectStore.put(value, key);
    },
    delete(key) {
      objectStore.delete(key);
    },
  };
}

function getParsed<V>(
  objectStore: IDBObjectStore,
  key: IDBValidKey,
  parse: Parse<Cloned, V>,
  deleteInvalid: boolean,
): Promise<V | null> {
  return new Promise<V | null>((resolve, reject) => {
    const request = objectStore.get(key);
    request.onsuccess = () => {
      const stored: Cloned | undefined = request.result;
      if (stored === undefined) {
        resolve(null);
        return;
      }
      const value = parse(stored);
      if (value === null && deleteInvalid) objectStore.delete(key);
      resolve(value);
    };
    request.onerror = () => {
      reject(request.error ?? new DOMException('IndexedDB read failed', 'UnknownError'));
    };
  });
}
