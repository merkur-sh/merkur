import { refusalOf, reportStorageFailure } from './failures';
import type { Json, Parse } from './parse';

/**
 * `T` when `JSON.stringify` then `JSON.parse` gives back a value of the same
 * type, and `never` at every place it would not: functions, class instances
 * with methods (`Date`, `Map`, typed arrays), `bigint`, `symbol`, and a
 * required property that may be `undefined`, which the round trip drops. An
 * optional property may be absent. `NaN` and the infinities are numbers to the
 * type system, so the parser still has to refuse the `null` they come back as.
 */
export type JsonRoundTrip<T> = T extends string | number | boolean | null
  ? T
  : T extends readonly unknown[]
    ? { readonly [I in keyof T]: JsonRoundTrip<T[I]> }
    : T extends (...args: never[]) => void
      ? never
      : T extends object
        ? { [K in keyof T]: K extends string ? JsonRoundTrip<T[K]> : never }
        : never;

/** One key of `localStorage` or `sessionStorage`, holding one JSON value of type `T`. */
export interface StoredValue<T> {
  /**
   * The stored value, or `null` when there is none, storage is unavailable, or
   * what is stored does not parse. A value that does not parse is removed, so
   * one written by another build is read once at most.
   */
  read(): T | null;
  /**
   * Whether the value was stored. A full quota, a private mode, a sandbox and
   * a worker (which has no web storage) all answer `false` rather than throw:
   * a cache that cannot be written must not take its caller down with it.
   */
  write(value: T): boolean;
  remove(): void;
}

/*
 * A key has one writer. Firefox gives each tab its own snapshot of
 * `localStorage` and delivers another tab's writes asynchronously, so a read
 * under a Web Lock can still miss the write the previous holder made:
 * `engines.test.ts` measured a lost update between two tabs that took turns
 * under one lock. A value several tabs change belongs in IndexedDB, whose
 * read-write transactions over one store run one at a time across tabs.
 */

type StorageArea = 'localStorage' | 'sessionStorage';

/*
 * The parser's result type is `T & JsonRoundTrip<T>` rather than a bound on
 * `T`: a self-referential bound (`T extends JsonRoundTrip<T>`) is a circular
 * constraint to TypeScript, while the intersection is checked after `T` is
 * inferred from the parser, so a parser of a type JSON cannot carry is a
 * compile error where the key is declared.
 */

/** A key in `localStorage`: the origin's, shared by every tab and kept across sessions. */
export function localValue<T>(
  key: string,
  parse: Parse<Json, T & JsonRoundTrip<T>>,
): StoredValue<T> {
  return storedValue('localStorage', key, parse);
}

/** A key in `sessionStorage`: this tab's, kept across reloads of it. */
export function sessionValue<T>(
  key: string,
  parse: Parse<Json, T & JsonRoundTrip<T>>,
): StoredValue<T> {
  return storedValue('sessionStorage', key, parse);
}

function storedValue<T>(area: StorageArea, key: string, parse: Parse<Json, T>): StoredValue<T> {
  return {
    read() {
      const storage = storageArea(area, key);
      if (storage === null) return null;
      const raw = attempt(key, () => storage.getItem(key));
      if (raw === REFUSAL || raw === null) return null;
      let decoded: Json;
      try {
        decoded = JSON.parse(raw);
      } catch (cause) {
        if (!(cause instanceof SyntaxError)) throw cause;
        reportStorageFailure(key, 'unparseable');
        removeKey(storage, key);
        return null;
      }
      const value = parse(decoded);
      if (value === null) {
        reportStorageFailure(key, 'unparseable');
        removeKey(storage, key);
      }
      return value;
    },
    write(value) {
      const storage = storageArea(area, key);
      if (storage === null) return false;
      const serialized = JSON.stringify(value);
      return attempt(key, () => storage.setItem(key, serialized)) !== REFUSAL;
    },
    remove() {
      const storage = storageArea(area, key);
      if (storage !== null) removeKey(storage, key);
    },
  };
}

/** The marker `attempt` answers with when the browser refused the call. */
const REFUSAL: unique symbol = Symbol('refused');

/**
 * Runs one web-storage call. A browser refusal is counted against `key` and
 * answered with `REFUSAL`; anything else is a bug and propagates.
 */
function attempt<R>(key: string, call: () => R): R | typeof REFUSAL {
  try {
    return call();
  } catch (cause) {
    const failure = refusalOf(cause);
    if (failure === null) throw cause;
    reportStorageFailure(key, failure);
    return REFUSAL;
  }
}

/**
 * The area, looked up on every call rather than once: a worker has none, a
 * sandboxed or storage-blocked document refuses the property read itself, and
 * a test installs its own. A worker having no area is not a failure.
 */
function storageArea(area: StorageArea, key: string): Storage | null {
  const storage = attempt(key, () =>
    area === 'localStorage' ? globalThis.localStorage : globalThis.sessionStorage,
  );
  return storage === REFUSAL || storage === undefined || storage === null ? null : storage;
}

/** A refused removal leaves a value that is refused again on its next read. */
function removeKey(storage: Storage, key: string): void {
  attempt(key, () => storage.removeItem(key));
}
