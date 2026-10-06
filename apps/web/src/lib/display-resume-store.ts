// IndexedDB-backed cache of the most-recent display snapshot per (daemon, tab).
// Cold-start tab refresh paints from this cache before the network is even open;
// the in-flight `display_resume` request then drives a 1-RTT delta to current.
//
// Key shape: `${daemonId}:${tabId}`. The tab id is generated once and
// stored in sessionStorage so it survives `location.reload()` but is fresh for
// new tabs, keeping cached display state scoped to one browser tab.

import { type PersistedResume, parsePersistedResume } from './display-resume-schema';

export type { PersistedResume } from './display-resume-schema';

const DB_NAME = 'merkur_session';
const STORE_NAME = 'resume';
// v3 is the hard identity cut from transport endpoint ids to logical daemon ids.
// Recreate the path store because its keyPath changed; exact schema parsers
// discard v2 resume records rather than aliasing the retired field.
// v4 adds the edge-path store, which lets a cold connect dial the edge while
// issuance is still in flight.
// v5 keys the direct-path store by daemon and network, so it is recreated.
const DB_VERSION = 5;
export const WT_PATH_STORE_NAME = 'wt-path';
export const EDGE_PATH_STORE_NAME = 'edge-path';
const MAX_ENTRIES = 8;
const LOCK_NAME = 'merkur-resume-write';

export function resumeKey(daemonId: string, tabId: string): string {
  return `${daemonId}:${tabId}`;
}

function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return openSessionDb();
}

/** Shared opener for the merkur_session DB — creates every store. */
export function openSessionDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('mtime', 'mtime');
      }
      if (!db.objectStoreNames.contains(WT_PATH_STORE_NAME)) {
        db.createObjectStore(WT_PATH_STORE_NAME, { keyPath: 'key' });
      } else if (event.oldVersion < 5) {
        db.deleteObjectStore(WT_PATH_STORE_NAME);
        db.createObjectStore(WT_PATH_STORE_NAME, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(EDGE_PATH_STORE_NAME)) {
        db.createObjectStore(EDGE_PATH_STORE_NAME, { keyPath: 'daemonId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

export async function loadResume(daemonId: string, tabId: string): Promise<PersistedResume | null> {
  if (!indexedDbAvailable()) return null;
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null;
  }
  try {
    return await new Promise<PersistedResume | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const key = resumeKey(daemonId, tabId);
      const req = store.get(key);
      let result: PersistedResume | null = null;
      req.onsuccess = () => {
        if (req.result !== undefined) {
          result = parsePersistedResume(req.result, daemonId, tabId);
          if (result === null) {
            store.delete(key);
          }
        }
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function saveResume(entry: PersistedResume): Promise<void> {
  if (!indexedDbAvailable()) return;
  const parsed = parsePersistedResume(entry, entry.daemonId, entry.tabId);
  if (parsed === null) {
    throw new TypeError('Refusing to persist an invalid display resume record');
  }
  if (typeof navigator === 'undefined' || navigator.locks === undefined) {
    await persistUnlocked(parsed);
    return;
  }
  await navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, async () => {
    await persistUnlocked(parsed);
  });
}

async function persistUnlocked(entry: PersistedResume): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(entry);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    await evictOldestIfOverCap(db);
  } catch {
    // Quota or transaction failures are non-fatal; cold-start will just paint
    // nothing rather than stale state.
  } finally {
    db.close();
  }
}

/**
 * Evict the oldest records beyond the cap, oldest `mtime` first. Only primary
 * keys are read: a save must not deserialise every stored snapshot, chunks
 * included, on the transport worker. A record that no longer parses counts
 * toward the cap like any other and is deleted where it is read, by
 * `loadResume`.
 */
async function evictOldestIfOverCap(db: IDBDatabase): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.index('mtime').getAllKeys();
    req.onsuccess = () => {
      const keys = req.result;
      const excess = keys.length - MAX_ENTRIES;
      for (let index = 0; index < excess; index += 1) {
        const key = keys[index];
        if (key !== undefined) store.delete(key);
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
