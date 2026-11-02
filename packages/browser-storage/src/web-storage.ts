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
      const storage = storageArea(area);
      if (storage === null) return null;
      const raw = refusedAsNull(() => storage.getItem(key));
      if (raw === null) return null;
      let decoded: Json;
      try {
        decoded = JSON.parse(raw);
      } catch (cause) {
        if (!(cause instanceof SyntaxError)) throw cause;
        removeKey(storage, key);
        return null;
      }
      const value = parse(decoded);
      if (value === null) removeKey(storage, key);
      return value;
    },
    write(value) {
      const storage = storageArea(area);
      if (storage === null) return false;
      const serialized = JSON.stringify(value);
      return (
        refusedAsNull(() => {
          storage.setItem(key, serialized);
          return true;
        }) === true
      );
    },
    remove() {
      const storage = storageArea(area);
      if (storage !== null) removeKey(storage, key);
    },
  };
}

/**
 * The area, looked up on every call rather than once: a worker has none, a
 * sandboxed or storage-blocked document refuses the property read itself, and
 * a test installs its own.
 */
function storageArea(area: StorageArea): Storage | null {
  const storage = refusedAsNull(() =>
    area === 'localStorage' ? globalThis.localStorage : globalThis.sessionStorage,
  );
  return storage === undefined ? null : storage;
}

function removeKey(storage: Storage, key: string): void {
  // A refused removal leaves a value that is refused again on its next read.
  refusedAsNull(() => {
    storage.removeItem(key);
    return true;
  });
}

/**
 * `null` where the browser refuses web storage, which it does with a
 * `DOMException`: `SecurityError` where storage is blocked, `QuotaExceededError`
 * on a full or private-mode write. Anything else is a bug and propagates.
 */
function refusedAsNull<R>(access: () => R): R | null {
  try {
    return access();
  } catch (cause) {
    if (cause instanceof DOMException) return null;
    throw cause;
  }
}
