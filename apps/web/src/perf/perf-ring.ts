/**
 * Lock-free SPSC ring for profiling records, in a SharedArrayBuffer.
 *
 * This exists because the previous transport for profiling events — an object
 * literal plus `postMessage` per event — cost an allocation, a structured clone
 * and a **main-thread task wake** for every one of them, at the repo's own
 * sizing of ~1200 events/sec (`TRACE_EVENT_TARGET_HZ` x `TRACE_EVENTS_PER_FRAME`).
 * The main thread owns keystroke handling and the speculative glyph overlay, so
 * that transport perturbed exactly what it was trying to measure. Writing a
 * fixed-stride record here is a handful of typed-array stores and one
 * `Atomics.store`, and no other thread is woken at all.
 *
 * # How this differs from `terminal/shared-ring.ts`
 *
 * Two deliberate inversions of the frame/ACK ring contract:
 *
 * 1. **Overwrite-on-full, never reject.** The frame ring drops the newest write
 *    and reports it, because losing a display frame is a correctness event. A
 *    profiler must never apply backpressure to the thing it profiles, so a full
 *    ring loses the *oldest* records and the reader reports the loss as data.
 * 2. **No `Atomics.notify`.** Frame and ACK writers notify because their readers
 *    park. This reader must never park — it polls from a cold thread on a slow
 *    timer. A wake per record would reintroduce the cost this module exists to
 *    remove.
 *
 * # Discipline
 *
 * Zero imports, so it can be reasoned about as arithmetic over a buffer and is
 * safe to call from any realm. Enforced Effect-free by
 * `scripts/check-latency-boundaries.ts`.
 */

/**
 * Bytes per record. Eight f64 slots followed by sixteen u32 slots.
 *
 * A fixed stride, sized for the widest event rather than per-event, buys a
 * branch-free writer and O(1) indexing with no length prefix and no alignment
 * arithmetic. The space wasted by narrow events is the correct trade in a hot
 * path: the widest events (`render_start`, `render_end`, `frame_complete`) are
 * also the most frequent, so the average waste is small.
 *
 * The f64 block comes first so every f64 slot is naturally 8-byte aligned from
 * the start of the record, which requires the stride itself to be a multiple
 * of 8.
 */
export const PERF_RECORD_BYTES = 128;
export const PERF_RECORD_F64_SLOTS = 8;
export const PERF_RECORD_U32_SLOTS = 16;

const F64_BLOCK_BYTES = PERF_RECORD_F64_SLOTS * 8;

/**
 * Meta header, padded to a cache line so the writer's cursor store never
 * shares a line with record data the reader is scanning.
 */
const META_BYTES = 64;
const META_WRITE_SEQ = 0;

/** Default capacity: 65,536 records is ~54s of trace at 1200 events/sec. */
export const PERF_RING_DEFAULT_RECORDS = 65_536;

export function perfRingByteLength(records: number = PERF_RING_DEFAULT_RECORDS): number {
  return META_BYTES + records * PERF_RECORD_BYTES;
}

export function createPerfRingBuffer(
  records: number = PERF_RING_DEFAULT_RECORDS,
): SharedArrayBuffer {
  return new SharedArrayBuffer(perfRingByteLength(records));
}

/**
 * Writes one record. Every setter targets the record currently being built;
 * `commit` publishes it and advances the cursor.
 *
 * The staging slots are *in the ring itself*, not a scratch record copied in on
 * commit — that would double the stores. The consequence is that a reader can
 * observe a partially written record, which is why the reader re-validates
 * against the cursor after copying and discards anything the writer has lapped.
 */
export interface PerfRingWriter {
  /** Begin a record. Zeroes the slots this record will not set. */
  begin(kind: number): void;
  f64(slot: number, value: number): void;
  u32(slot: number, value: number): void;
  i32(slot: number, value: number): void;
  /** Publish the staged record. */
  commit(): void;
  /** Records written since construction. Diagnostic only. */
  readonly writtenCount: number;
}

export function createPerfRingWriter(sab: SharedArrayBuffer): PerfRingWriter {
  const meta = new Int32Array(sab, 0, META_BYTES / 4);
  const capacity = Math.floor((sab.byteLength - META_BYTES) / PERF_RECORD_BYTES);
  if (capacity <= 0) throw new RangeError('perf ring buffer is too small for one record');

  const f64 = new Float64Array(sab, META_BYTES, capacity * (PERF_RECORD_BYTES / 8));
  const u32 = new Uint32Array(sab, META_BYTES, capacity * (PERF_RECORD_BYTES / 4));
  const i32 = new Int32Array(sab, META_BYTES, capacity * (PERF_RECORD_BYTES / 4));

  // Writer-owned. Never loaded from the meta header: only this thread advances
  // it, so an atomic load would be a fence bought for nothing.
  let writeSeq = 0;
  let f64Base = 0;
  let u32Base = 0;

  return {
    begin(kind: number): void {
      const index = writeSeq % capacity;
      f64Base = index * (PERF_RECORD_BYTES / 8);
      u32Base = index * (PERF_RECORD_BYTES / 4) + F64_BLOCK_BYTES / 4;
      // Clearing is what lets every decoder read a fixed slot set without the
      // encoder having to write slots its event kind does not use. One fill
      // clears both blocks: all-zero bits represent f64 +0 and u32 0.
      u32.fill(0, u32Base - F64_BLOCK_BYTES / 4, u32Base + PERF_RECORD_U32_SLOTS);
      u32[u32Base] = kind >>> 0;
    },
    f64(slot: number, value: number): void {
      f64[f64Base + slot] = value;
    },
    u32(slot: number, value: number): void {
      u32[u32Base + slot] = value >>> 0;
    },
    i32(slot: number, value: number): void {
      i32[u32Base + slot] = value | 0;
    },
    commit(): void {
      writeSeq = (writeSeq + 1) >>> 0;
      // The single release fence. Everything above is a plain store, ordered
      // before this by the atomic.
      Atomics.store(meta, META_WRITE_SEQ, writeSeq | 0);
    },
    get writtenCount(): number {
      return writeSeq;
    },
  };
}

/** One record, copied out of the ring into caller-owned scratch. */
export interface PerfRecordView {
  readonly kind: number;
  f64(slot: number): number;
  u32(slot: number): number;
  i32(slot: number): number;
}

export interface PerfRingDrainResult {
  readonly drained: number;
  /**
   * Records the writer overwrote before this reader reached them.
   *
   * Never silently zero-filled or interpolated: a gap in a profile has to be
   * visible as a gap, because a decomposition computed across one does not sum.
   */
  readonly lost: number;
}

export interface PerfRingReader {
  /**
   * Copy out every record published since the last drain, oldest first.
   *
   * `visit` must consume the view synchronously — it is reused across records
   * to keep the drain allocation-free per record.
   */
  drain(visit: (record: PerfRecordView) => void): PerfRingDrainResult;
}

export function createPerfRingReader(sab: SharedArrayBuffer): PerfRingReader {
  const meta = new Int32Array(sab, 0, META_BYTES / 4);
  const capacity = Math.floor((sab.byteLength - META_BYTES) / PERF_RECORD_BYTES);
  if (capacity <= 0) throw new RangeError('perf ring buffer is too small for one record');

  const f64 = new Float64Array(sab, META_BYTES, capacity * (PERF_RECORD_BYTES / 8));
  const u32 = new Uint32Array(sab, META_BYTES, capacity * (PERF_RECORD_BYTES / 4));

  // Scratch, allocated once. A record is copied here before it is handed to the
  // visitor so the visitor never reads memory the writer may be mutating.
  const scratchF64 = new Float64Array(PERF_RECORD_F64_SLOTS);
  const scratchU32 = new Uint32Array(PERF_RECORD_U32_SLOTS);
  const scratchI32 = new Int32Array(scratchU32.buffer);

  const view: PerfRecordView = {
    get kind(): number {
      return scratchU32[0] ?? 0;
    },
    f64: (slot: number): number => scratchF64[slot] ?? 0,
    u32: (slot: number): number => scratchU32[slot] ?? 0,
    i32: (slot: number): number => scratchI32[slot] ?? 0,
  };

  let readSeq = 0;

  return {
    drain(visit: (record: PerfRecordView) => void): PerfRingDrainResult {
      const writeSeq = Atomics.load(meta, META_WRITE_SEQ) >>> 0;
      let available = (writeSeq - readSeq) >>> 0;
      let lost = 0;

      if (available > capacity) {
        // The writer lapped us. Skip to the oldest record still intact.
        lost = available - capacity;
        readSeq = (writeSeq - capacity) >>> 0;
        available = capacity;
      }

      let drained = 0;
      while (available > 0) {
        const index = readSeq % capacity;
        const f64Base = index * (PERF_RECORD_BYTES / 8);
        const u32Base = index * (PERF_RECORD_BYTES / 4) + F64_BLOCK_BYTES / 4;

        // Element copies rather than `set(subarray(...))`: the two views that
        // form would be two typed-array objects per record on a path that runs
        // at the producers' full event rate.
        for (let slot = 0; slot < PERF_RECORD_F64_SLOTS; slot += 1) {
          scratchF64[slot] = f64[f64Base + slot] ?? 0;
        }
        for (let slot = 0; slot < PERF_RECORD_U32_SLOTS; slot += 1) {
          scratchU32[slot] = u32[u32Base + slot] ?? 0;
        }

        // Re-validate: overwrite-on-full means the writer may have reached this
        // slot mid-copy. If it has, the copy is torn and the record is dropped
        // rather than decoded into a plausible-looking lie.
        const nowWriteSeq = Atomics.load(meta, META_WRITE_SEQ) >>> 0;
        if ((nowWriteSeq - readSeq) >>> 0 > capacity) {
          lost += 1;
        } else {
          visit(view);
          drained += 1;
        }

        readSeq = (readSeq + 1) >>> 0;
        available -= 1;
      }

      return { drained, lost };
    },
  };
}
