import { defineDatabase, keyedStore } from '@merkur/browser-storage';
import { STORAGE_NAMES } from '../lib/storage-names';
import { DISPLAY_RECEIVER_PROFILE_BYTES } from './display-receiver-profile';

const STORE = 'receiver-profiles';
const KEY = `${process.env.MERKUR_TERM_WASM_HASH ?? 'dev'}:${navigator.userAgent}`;

const receiverProfiles = defineDatabase(STORAGE_NAMES.receiver_profiles, 1, {
  [STORE]: keyedStore<string, ArrayBuffer>((value) =>
    value instanceof ArrayBuffer && value.byteLength === DISPLAY_RECEIVER_PROFILE_BYTES
      ? value
      : null,
  ),
});

export async function restoreDisplayReceiverProfile(destination: SharedArrayBuffer): Promise<void> {
  if (destination.byteLength !== DISPLAY_RECEIVER_PROFILE_BYTES) return;
  try {
    const value = await receiverProfiles.read([STORE], (transaction) =>
      transaction.store(STORE).get(KEY),
    );
    if (value === null) return;
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
  if (source.byteLength !== DISPLAY_RECEIVER_PROFILE_BYTES) return;
  try {
    const words = new Int32Array(source);
    let snapshot: Int32Array<ArrayBuffer> | null = null;
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
    const profile = snapshot.buffer;
    await receiverProfiles.write([STORE], (transaction) =>
      transaction.store(STORE).put(KEY, profile),
    );
  } catch {
    // Performance evidence is opportunistic and never blocks display.
  }
}
