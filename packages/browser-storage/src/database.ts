import { reportStorageFailure } from './failures';
import type { Cloned, Parse } from './parse';

/*
 * A typed IndexedDB over the native objects, after `idb`'s schema typing but
 * not its runtime: `idb` wraps every database, transaction, store and cursor in
 * a Proxy and looks each property read up in a WeakMap, which this does not
 * pay. It covers what Merkur stores, out-of-line keys and whole values, and
 * adds what `idb` leaves to its caller: every value read is parsed, a schema
 * change replaces the database instead of migrating it, and one connection per
 * database serves every transaction, reopened whenever the engine closes it.
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
 * `TransactionInactiveError`, or `InvalidStateError` once the commit has
 * finished. Do that work before the transaction or after it.
 */
type TransactionBody<T, R> = (transaction: T) => R | Promise<R>;

/**
 * A database's name, its schema version and its stores, and the transactions
 * over it. The first transaction opens the connection, and every later one
 * reuses it. The engine may close it: another tab opening a newer version, the
 * user clearing site data, WebKit losing its storage process while the page
 * was suspended. Each of these is an event or an `InvalidStateError` from the
 * connection itself, and the next transaction opens a new one. A transaction
 * already running on a connection that closes rejects; it is never run twice.
 */
export interface Database<S extends StoreDefinitions> {
  readonly name: string;
  /** Runs `body` in one read-only transaction over `stores`, resolving once it completes. */
  read<N extends StoreName<S>, R>(
    stores: readonly N[],
    body: TransactionBody<ReadTransaction<S, N>, R>,
  ): Promise<R>;
  /**
   * Runs `body` in one read-write transaction over `stores`, resolving with its
   * result once the transaction completes. A body that throws aborts the
   * transaction, so none of its writes land.
   */
  write<N extends StoreName<S>, R>(
    stores: readonly N[],
    body: TransactionBody<WriteTransaction<S, N>, R>,
    options?: WriteOptions,
  ): Promise<R>;
  /**
   * Opens the connection ahead of the transactions that will use it, resolving
   * at once while one is open. A caller that cannot wait on an open
   * indefinitely bounds it here, then runs its transactions on the connection.
   */
  connect(options?: ConnectOptions): Promise<void>;
  /**
   * Closes the connection, and abandons an open still in flight. The next
   * transaction opens a new one.
   */
  close(): void;
}

export interface ConnectOptions {
  /**
   * Gives up on the open. The open is abandoned with it: the connection it
   * would have produced is closed the moment it arrives, so an abandoned open
   * never holds the database, and the next call starts a new open.
   */
  readonly signal?: AbortSignal;
}

export interface WriteOptions {
  /**
   * `'strict'` resolves the write only once the engine has flushed it to disk,
   * so it survives a crash or power loss that follows; an engine is free to
   * complete a `'default'` or `'relaxed'` transaction from its cache. Worth one
   * flush for a record that must not be lost, such as a credential; a cache
   * leaves it unset.
   */
  readonly durability?: IDBTransactionDurability;
}

/** A store of `V` values under out-of-line keys of type `K`, each read through `parse`. */
export function keyedStore<K extends IDBValidKey, V>(
  parse: Parse<Cloned, V>,
): StoreDefinition<K, V> {
  return { parse };
}

/**
 * Declares a database; nothing opens until its first transaction. The version
 * is the schema's identity, not a migration step: opening a database stored
 * under an older version deletes every store it holds and creates the declared
 * ones empty, so a changed layout is a hard cutover and nothing ever reads a
 * record in an older shape. Bump it whenever a store is added, removed,
 * renamed, or its value shape changes.
 */
export function defineDatabase<S extends StoreDefinitions>(
  name: string,
  version: number,
  stores: S,
): Database<S> {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError(`IndexedDB ${name} version must be a positive integer`);
  }
  const connection = sharedConnection(name, version, stores);
  return {
    name,
    read(names, body) {
      return connection.transact(
        (database) => database.transaction(names, 'readonly'),
        (transaction) =>
          runTransaction(
            name,
            transaction,
            {
              store: (store) =>
                readStore(name, transaction.objectStore(store), parserOf(stores, store)),
            },
            body,
          ),
      );
    },
    write(names, body, options = {}) {
      return connection.transact(
        (database) => database.transaction(names, 'readwrite', options),
        (transaction) =>
          runTransaction(
            name,
            transaction,
            {
              store: (store) =>
                writeStore(name, transaction.objectStore(store), parserOf(stores, store)),
            },
            body,
          ),
      );
    },
    async connect(options = {}) {
      await connection.connect(options.signal);
    },
    close() {
      connection.close();
    },
  };
}

interface SharedConnection {
  /**
   * Begins a transaction on the connection, opening it first when there is
   * none, and hands it to `run`. A connection that turns out to be closing is
   * dropped and the transaction begun once more on a new one: `transaction()`
   * throws before any work starts, so nothing runs twice.
   */
  transact<R>(
    begin: (connection: IDBDatabase) => IDBTransaction,
    run: (transaction: IDBTransaction) => Promise<R>,
  ): Promise<R>;
  /** The open connection, or the one an open in flight or a new open produces. */
  connect(signal: AbortSignal | undefined): Promise<IDBDatabase>;
  close(): void;
}

function sharedConnection(
  name: string,
  version: number,
  stores: StoreDefinitions,
): SharedConnection {
  let current: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase> | null = null;

  const forget = (connection: IDBDatabase): void => {
    if (current === connection) current = null;
    connection.close();
  };

  /**
   * A connection closed by the engine rather than by this module: counted once,
   * by whichever of its `close` event and a refused `transaction()` comes
   * first. An abandoned open's connection, closed here, is never current.
   */
  const lost = (connection: IDBDatabase): void => {
    if (current === connection) reportStorageFailure(name, 'connection_lost');
    forget(connection);
  };

  const open = (): Promise<IDBDatabase> => {
    const pending: Promise<IDBDatabase> = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => {
        replaceStores(request.result, stores);
      };
      request.onsuccess = () => {
        const connection = request.result;
        if (opening !== pending) {
          // Abandoned: closed on arrival. A caller still waiting on it finds it
          // closing and opens again.
          connection.close();
          resolve(connection);
          return;
        }
        opening = null;
        current = connection;
        // Another tab opening a newer version: close, so its upgrade is never
        // blocked by this build's connection.
        connection.onversionchange = () => forget(connection);
        // The engine closed it: site data cleared, or the storage process lost.
        connection.onclose = () => lost(connection);
        resolve(connection);
      };
      request.onerror = () => {
        if (opening === pending) {
          opening = null;
          reportStorageFailure(name, 'open_failed');
        }
        reject(
          request.error ?? new DOMException(`Unable to open IndexedDB ${name}`, 'UnknownError'),
        );
      };
      // `blocked` needs no handler: the open waits until the older connections
      // close, which this module's own connections do on `versionchange`, and a
      // caller that cannot wait connects with a signal.
    });
    return pending;
  };

  const connect = (signal: AbortSignal | undefined): Promise<IDBDatabase> => {
    if (current !== null) return Promise.resolve(current);
    if (signal?.aborted === true) {
      reportStorageFailure(name, 'open_abandoned');
      return Promise.reject(signal.reason);
    }
    if (typeof indexedDB === 'undefined') {
      reportStorageFailure(name, 'open_failed');
      // A `DOMException` like every refusal an engine makes, so a caller tells a
      // storage failure from a bug by type alone.
      return Promise.reject(new DOMException('IndexedDB is unavailable', 'NotSupportedError'));
    }
    opening ??= open();
    const pending = opening;
    if (signal === undefined) return pending;
    return new Promise<IDBDatabase>((resolve, reject) => {
      const onAbort = (): void => {
        reportStorageFailure(name, 'open_abandoned');
        if (opening === pending) opening = null;
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (connection) => {
          signal.removeEventListener('abort', onAbort);
          resolve(connection);
        },
        (cause: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(cause);
        },
      );
    });
  };

  const transact = <R>(
    begin: (connection: IDBDatabase) => IDBTransaction,
    run: (transaction: IDBTransaction) => Promise<R>,
    reopened: boolean,
  ): Promise<R> => {
    const attempt = (connection: IDBDatabase): Promise<R> => {
      let transaction: IDBTransaction;
      try {
        transaction = begin(connection);
      } catch (cause) {
        // A connection closing underneath answers `InvalidStateError` before any
        // work starts; anything else (an undeclared store) is the caller's.
        if (reopened || !(cause instanceof DOMException && cause.name === 'InvalidStateError')) {
          return Promise.reject(cause);
        }
        lost(connection);
        return transact(begin, run, true);
      }
      return run(transaction);
    };
    return current === null ? connect(undefined).then(attempt) : attempt(current);
  };

  return {
    transact: (begin, run) => transact(begin, run, false),
    connect,
    close() {
      opening = null;
      if (current !== null) forget(current);
    },
  };
}

function replaceStores(connection: IDBDatabase, stores: StoreDefinitions): void {
  for (const name of Array.from(connection.objectStoreNames)) {
    connection.deleteObjectStore(name);
  }
  for (const name of Object.keys(stores)) {
    connection.createObjectStore(name);
  }
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
 * that fails aborts the transaction; an abort the engine chose is counted
 * against `database`, one the body caused is the body's failure alone.
 */
function runTransaction<T, R>(
  database: string,
  transaction: IDBTransaction,
  view: T,
  body: TransactionBody<T, R>,
): Promise<R> {
  return new Promise<R>((resolve, reject) => {
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
    const engineFailed = (cause: DOMException): void => {
      if (settled) return;
      reportStorageFailure(database, 'aborted');
      fail(cause);
    };
    transaction.oncomplete = () => {
      completed = true;
      finish();
    };
    transaction.onabort = () => {
      engineFailed(
        transaction.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'),
      );
    };
    transaction.onerror = () => {
      engineFailed(
        transaction.error ?? new DOMException('IndexedDB transaction failed', 'UnknownError'),
      );
    };
    // The body starts synchronously, in the same turn that created the
    // transaction, so its first request is issued while the transaction is
    // certainly active.
    let started: R | Promise<R>;
    try {
      started = body(view);
    } catch (cause) {
      started = Promise.reject(cause);
    }
    Promise.resolve(started).then(
      (value) => {
        result = { value };
        finish();
      },
      (cause: unknown) => {
        fail(cause);
        abortUnlessFinished(transaction);
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
  database: string,
  objectStore: IDBObjectStore,
  parse: Parse<Cloned, V>,
): ReadStore<K, V> {
  return { get: (key) => getParsed(database, objectStore, key, parse, false) };
}

function writeStore<K extends IDBValidKey, V>(
  database: string,
  objectStore: IDBObjectStore,
  parse: Parse<Cloned, V>,
): WriteStore<K, V> {
  return {
    get: (key) => getParsed(database, objectStore, key, parse, true),
    put(key, value) {
      objectStore.put(value, key);
    },
    delete(key) {
      objectStore.delete(key);
    },
  };
}

function getParsed<V>(
  database: string,
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
      if (value === null) {
        reportStorageFailure(database, 'unparseable');
        if (deleteInvalid) objectStore.delete(key);
      }
      resolve(value);
    };
    request.onerror = () => {
      reject(request.error ?? new DOMException('IndexedDB read failed', 'UnknownError'));
    };
  });
}
