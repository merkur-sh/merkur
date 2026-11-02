/**
 * What went wrong with browser storage, by the storage it happened to. Every
 * failure this package recovers from (a refused write, a value that no longer
 * parses, an aborted transaction) still answers its caller with `null` or
 * `false`; this is where it is counted instead of vanishing.
 *
 * - `quota`: a write the browser refused for space (`QuotaExceededError`).
 * - `refused`: any other access the browser refused: storage blocked, a
 *   sandbox, or an engine's own failure such as a corrupted profile.
 * - `unparseable`: a stored value its parser did not accept, or web-storage
 *   text that is not JSON.
 * - `aborted`: an IndexedDB transaction the engine aborted. A transaction the
 *   caller's own body abandoned is the caller's error and is not counted.
 * - `open_failed`: an IndexedDB open the engine refused, or no IndexedDB at all.
 * - `open_abandoned`: an IndexedDB open its caller gave up on before it opened.
 */
export const STORAGE_FAILURES = [
  'quota',
  'refused',
  'unparseable',
  'aborted',
  'open_failed',
  'open_abandoned',
] as const;

export type StorageFailure = (typeof STORAGE_FAILURES)[number];

/** `target` is the web-storage key, or the IndexedDB database's name. */
export interface StorageFailureEvent {
  readonly target: string;
  readonly failure: StorageFailure;
}

type StorageFailureListener = (event: StorageFailureEvent) => void;

const listeners = new Set<StorageFailureListener>();

/** Hears every failure in this realm (a page or a worker) until the returned call. */
export function observeStorageFailures(listener: StorageFailureListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function reportStorageFailure(target: string, failure: StorageFailure): void {
  for (const listener of listeners) listener({ target, failure });
}

/**
 * The failure a browser meant by throwing `cause` from a storage call, or
 * `null` when `cause` is not the browser refusing (a bug, which propagates).
 *
 * Engines refuse with a `DOMException`, except Gecko for its own internal
 * failures: `CreateException` (`dom/bindings/Exceptions.cpp`) makes a
 * `DOMException` only for DOM-module result codes and otherwise a legacy
 * `Exception`, which has no global constructor and is not a `DOMException`.
 * `localStorage` passes such codes through unchanged (`LSObject::GetItem` and
 * `SetItem` throw whatever opening the database returned, for example
 * `NS_ERROR_FILE_CORRUPTED`), so that object is recognised by what its
 * interface exposes: `result`, the failing nsresult with its high bit set.
 */
export function refusalOf(cause: unknown): 'quota' | 'refused' | null {
  if (cause instanceof DOMException) {
    return cause.name === 'QuotaExceededError' ? 'quota' : 'refused';
  }
  return isGeckoException(cause) ? 'refused' : null;
}

const NSRESULT_FAILURE = 0x8000_0000;

function isGeckoException(cause: unknown): boolean {
  return (
    cause instanceof Object &&
    'result' in cause &&
    'name' in cause &&
    Number.isSafeInteger(cause.result) &&
    Number(cause.result) >= NSRESULT_FAILURE &&
    cause.name === String(cause.name)
  );
}
