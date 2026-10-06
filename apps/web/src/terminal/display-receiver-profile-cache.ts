import { DISPLAY_RECEIVER_PROFILE_BYTES } from './display-receiver-profile';

const DATABASE = 'merkur-display-performance';
const STORE = 'receiver-profiles';
const KEY = `${process.env.MERKUR_TERM_WASM_HASH ?? 'dev'}:${navigator.userAgent}`;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('receiver profile database failed'));
  });
}

export async function restoreDisplayReceiverProfile(destination: SharedArrayBuffer): Promise<void> {
  if (destination.byteLength !== DISPLAY_RECEIVER_PROFILE_BYTES || !('indexedDB' in globalThis)) {
    return;
  }
  try {
    const database = await openDatabase();
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('receiver profile read failed'));
    });
    database.close();
    if (!(value instanceof ArrayBuffer) || value.byteLength !== destination.byteLength) return;
    const source = new Int32Array(value);
    const target = new Int32Array(destination);
    // Cold restore loses to any live publication. Compare/exchange owns the
    // empty mailbox before copying, so a slow IndexedDB read cannot overwrite
    // observations gathered after terminal readiness.
    if (Atomics.compareExchange(target, 0, 0, 1) !== 0) return;
    // Seqlock commit: a transport reader sees either the empty mailbox or the
    // exact cached snapshot, never half of each.
    let committed = false;
    try {
      for (let index = 1; index < target.length; index += 1) {
        Atomics.store(target, index, source[index] ?? 0);
      }
      Atomics.store(target, 0, ((source[0] ?? 0) + 2) & ~1);
      committed = true;
    } finally {
      if (!committed) Atomics.store(target, 0, 0);
    }
  } catch {
    // Cache absence/private-mode refusal is not a transport failure.
  }
}

export async function persistDisplayReceiverProfile(source: SharedArrayBuffer): Promise<void> {
  if (source.byteLength !== DISPLAY_RECEIVER_PROFILE_BYTES || !('indexedDB' in globalThis)) return;
  try {
    const words = new Int32Array(source);
    let snapshot: Int32Array | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = Atomics.load(words, 0);
      if ((before & 1) !== 0) continue;
      const copy = new Int32Array(words.length);
      for (let index = 0; index < words.length; index += 1)
        copy[index] = Atomics.load(words, index);
      if (Atomics.load(words, 0) === before) {
        snapshot = copy;
        break;
      }
    }
    if (snapshot === null) return;
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const request = database
        .transaction(STORE, 'readwrite')
        .objectStore(STORE)
        .put(snapshot.buffer, KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('receiver profile write failed'));
    });
    database.close();
  } catch {
    // Performance evidence is opportunistic and never blocks display.
  }
}
