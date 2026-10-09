/**
 * Fixed-capacity interning table for the handful of strings profiling records
 * refer to, held in shared memory alongside the record rings.
 *
 * # Why shared memory rather than a side channel
 *
 * Records carry integer ids, never strings, so the hot path never touches a
 * string. The ids have to resolve somewhere, and the obvious cheap option is to
 * `postMessage` each novel string once. That loses a race: `postMessage` is
 * delivered on a task, so the reader can drain a record whose id has no string
 * yet and — because a record that cannot be decoded faithfully is dropped —
 * silently lose events at the start of every session, which is exactly when
 * `session_bound` and the startup milestones happen.
 *
 * Publishing into the same shared buffer removes the race: the id is published
 * with a release store that happens-before the record referencing it, so a
 * reader that can see the record can always see the string.
 *
 * # Sizing
 *
 * Only three fields ever intern: a session id, a device id, and a transport
 * disconnect reason. A long session interns a handful of values, so a small
 * fixed table with no eviction is the right shape — and a table that cannot
 * grow is one that cannot be made to allocate by a hostile value.
 */

const SLOT_BYTES = 96;
const SLOT_HEADER_BYTES = 2;
const SLOT_TEXT_BYTES = SLOT_BYTES - SLOT_HEADER_BYTES;
const META_BYTES = 64;
const META_PUBLISHED = 0;

export const PERF_STRING_TABLE_SLOTS = 64;
export const PERF_STRING_TABLE_BYTES = META_BYTES + PERF_STRING_TABLE_SLOTS * SLOT_BYTES;

/** Id 0 always means "absent"; real ids are slot index + 1. */
export const PERF_STRING_ABSENT = 0;

// Interning is synchronous within a JS realm; bytes reach the owning slot
// before another interner can use this scratch. Worker realms own separate copies.
const encoder = new TextEncoder();
// Finish a UTF-8 scalar crossing the slot boundary, then retain the same byte prefix.
const encoded = new Uint8Array(SLOT_TEXT_BYTES + 3);

export function createPerfStringTableBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(PERF_STRING_TABLE_BYTES);
}

export interface PerfStringInterner {
  intern(value: string | undefined): number;
}

export interface PerfStringResolver {
  resolve(id: number): string | null;
}

export function createPerfStringInterner(sab: SharedArrayBuffer): PerfStringInterner {
  const meta = new Int32Array(sab, 0, META_BYTES / 4);
  const bytes = new Uint8Array(sab, META_BYTES);
  const ids = new Map<string, number>();
  let published = 0;

  return {
    intern(value: string | undefined): number {
      if (value === undefined) return PERF_STRING_ABSENT;
      const existing = ids.get(value);
      if (existing !== undefined) return existing;
      // Full table: the value is dropped rather than evicting a live id, which
      // would silently repoint records already written against it.
      if (published >= PERF_STRING_TABLE_SLOTS) return PERF_STRING_ABSENT;

      const slot = published;
      const offset = slot * SLOT_BYTES;
      // Small inputs have bounded encoding cost; large inputs write only the slot prefix.
      const text = value.length <= SLOT_TEXT_BYTES ? encoder.encode(value) : encoded;
      const written = text === encoded ? encoder.encodeInto(value, encoded).written : text.length;
      const length = Math.min(written, SLOT_TEXT_BYTES);
      bytes.set(text.subarray(0, length), offset + SLOT_HEADER_BYTES);
      // Little-endian u16 length, written before the count is published.
      bytes[offset] = length & 0xff;
      bytes[offset + 1] = (length >>> 8) & 0xff;

      published = slot + 1;
      // Release store: a reader that observes this count also observes the
      // bytes written above it.
      Atomics.store(meta, META_PUBLISHED, published);

      const id = slot + 1;
      ids.set(value, id);
      return id;
    },
  };
}

export function createPerfStringResolver(sab: SharedArrayBuffer): PerfStringResolver {
  const meta = new Int32Array(sab, 0, META_BYTES / 4);
  const bytes = new Uint8Array(sab, META_BYTES);
  const decoder = new TextDecoder();
  // Decoding is cached because a resolve happens per decoded record, while a
  // slot's bytes never change once published.
  const cache: (string | undefined)[] = [];

  return {
    resolve(id: number): string | null {
      if (id === PERF_STRING_ABSENT) return null;
      const cached = cache[id];
      if (cached !== undefined) return cached;

      const slot = id - 1;
      if (slot < 0 || slot >= Atomics.load(meta, META_PUBLISHED)) return null;

      const offset = slot * SLOT_BYTES;
      const low = bytes[offset] ?? 0;
      const high = bytes[offset + 1] ?? 0;
      const length = Math.min(low | (high << 8), SLOT_TEXT_BYTES);
      // Copied out of shared memory before decoding, not decoded in place.
      // `TextDecoder.decode` rejects a view backed by a SharedArrayBuffer
      // ("The provided ArrayBufferView value must not be shared"), and this
      // table is shared by construction, so decoding the subarray directly
      // throws in the browser. It throws inside the telemetry worker's drain,
      // which kills the worker on its first tick and leaves it answering
      // nothing. The copy costs one small allocation per *distinct id*, not
      // per record, because the cache below is what the record path hits.
      const value = decoder.decode(
        bytes.slice(offset + SLOT_HEADER_BYTES, offset + SLOT_HEADER_BYTES + length),
      );
      cache[id] = value;
      return value;
    },
  };
}
