import { MAX_DISPLAY_FRAME_BYTES, type SynchronousByteSource } from '@merkur/shared';
import { readerNeedsWakeAfterPublish } from '../lib/spsc-ring-wake';
import type { InputSequenceMapping } from '../transport/input-sequence-domain';

/**
 * Lock-free SPSC ring buffers using SharedArrayBuffer + Atomics.
 *
 * Frame ring (transport worker → terminal worker): variable-length display
 * frames. What the Rust viewer sends back crosses the other way on its own
 * ring (`viewer-output-ring.ts`), under this ring's wake proof.
 *
 * Each ring owns one wake word, and its reader parks on that word — never on a
 * cursor — because not every edge that must wake a reader moves a cursor: the
 * frame ring's lineage fence and release,
 * change no cursor at all. The frame ring's word is `meta[3]` (a wake sequence
 * carrying the fence bit).
 *
 * Wake proof. Every producer edge stores its state (an entry cursor
 * or a lineage), then bumps the wake word, then notifies. A reader snapshots the
 * wake word first, then reads the state it waits on, then re-reads the word,
 * then parks on the snapshot. An edge therefore lands in exactly one of three
 * places: before the recheck, where the moved state or the moved word returns
 * `'not-equal'` synchronously; between the recheck and the park, where
 * `Atomics.waitAsync` sees the moved word and returns synchronously; or after
 * the park, where the notify resolves it. Boundedness: each `'not-equal'` is
 * charged to one producer edge — an entry, a fence transition, or a lineage
 * advance — so a drain loop that `continue`s without yielding on `'not-equal'`
 * cannot spin.
 *
 * The frame ring notifies only when their reader may be parked. A producer may also
 * carry a task edge (`onReadableEdge`) for a reader that parks on a task wait
 * instead of the native word; whether a reader does is decided by the realm
 * that constructs it, not here.
 */

// ── Frame Ring ───────────────────────────────────────────────────────────────
//
// meta (Int32Array):
//   [0]: writeOffset (bytes into data area; writer-owned, in [0, capacity))
//   [1]: readOffset  (bytes into data area; reader-owned, in [0, capacity))
//   [2]: dropped     (count of writes rejected due to ring full)
//   [3]: native wake sequence (bits 1-31) | authenticated-lineage fence (bit 0)
//
// Each entry occupies an 8-byte-aligned slot. The slot length is implied by
// `payloadLen` (entry slot = alignUp(24 + payloadLen, 8)). The production
// reader leases: it sees exactly `payloadLen` bytes in place, through the one
// lease record the reader owns, until it releases the entry. The copying
// reader (tests and benches) owns a fresh copy of that range. Alignment
// padding is never observed.
//   [0-3]:  payloadLen (u32, payload bytes only; 0 = skip-to-start marker)
//   [4]:    kind       (0 = display_frame, 1 = hash_digest)
//   [5]:    flags      (bit 0 = allowLarge)
//   [6-7]:  padding
//   [8-11]: input mapping epoch (u32)
//   [12-15]: local-minus-wire input seq delta (u32, modular)
//   [16-19]: proven wire input seq minimum (u32; 0 = inactive)
//   [20-23]: proven wire input seq maximum (u32)
//   [24..]: payload

const FRAME_RING_META_WORDS = 4;
const FRAME_RING_META_BYTES = FRAME_RING_META_WORDS * 4;
const FRAME_ENTRY_HEADER_BYTES = 24;
const FRAME_ENTRY_ALIGN = 8;
const FRAME_SKIP_MARKER = 0;
const FRAME_RING_WAKE_INDEX = 3;
const FRAME_RING_LINEAGE_FENCED = 1;
const FRAME_RING_WAKE_SEQUENCE_INCREMENT = 2;

// Two maximum slots plus their empty-sentinel space guarantee that a maximum
// frame fits at every empty-ring cursor, including either side of wraparound.
// This preserves one contiguous lease and one ingress copy for jumbo frames.
export const FRAME_RING_SIZE =
  FRAME_RING_META_BYTES +
  2 *
    (alignUp(FRAME_ENTRY_HEADER_BYTES + MAX_DISPLAY_FRAME_BYTES, FRAME_ENTRY_ALIGN) +
      FRAME_ENTRY_ALIGN);

/** Canonical opened Session terminal ingress: kind is base + channel. */
export const FRAME_KIND_CLIENT_INGRESS_BASE = 16;
export const FRAME_KIND_DISPLAY = 0;
export const FRAME_KIND_HASH_DIGEST = 1;
/**
 * The terminal worker's wake-port edge after it drained a frame ring that had
 * refused an entry. Numeric like the other port edges (zero is the task-mode
 * ring wake, one the presentation period); see `FrameRingReader.takeRefusal`.
 */
export const FRAME_RING_SPACE_EDGE = 2;
// Keep a coarse timeout as a last-resort backstop if both native and worker-task
// delivery fail, instead of polling while an otherwise idle terminal is open.
const RING_WAIT_WATCHDOG_MS = 30_000;

/**
 * Recovery wake for a natively parked frame reader (a suspended WebKit worker
 * can lose an `Atomics.notify`). A pure notify: a reader that has not parked
 * yet re-observes the ring itself before it does, so no state changes here.
 */
export function wakeFrameRingReader(sab: SharedArrayBuffer): number {
  return Atomics.notify(new Int32Array(sab, 0, FRAME_RING_META_WORDS), FRAME_RING_WAKE_INDEX, 1);
}

function alignUp(n: number, align: number): number {
  return (n + align - 1) & ~(align - 1);
}

function transitionFrameRingWakeState(meta: Int32Array, fenced: boolean): number {
  let observed = Atomics.load(meta, FRAME_RING_WAKE_INDEX);
  for (;;) {
    const advanced = (observed + FRAME_RING_WAKE_SEQUENCE_INCREMENT) & ~FRAME_RING_LINEAGE_FENCED;
    const next = advanced | (fenced ? FRAME_RING_LINEAGE_FENCED : 0) | 0;
    const actual = Atomics.compareExchange(meta, FRAME_RING_WAKE_INDEX, observed, next);
    if (actual === observed) return next >>> 0;
    observed = actual;
  }
}

function wakeNativeFrameReaderIfReadable(meta: Int32Array): void {
  let observed = Atomics.load(meta, FRAME_RING_WAKE_INDEX);
  while ((observed & FRAME_RING_LINEAGE_FENCED) === 0) {
    const next = (observed + FRAME_RING_WAKE_SEQUENCE_INCREMENT) | 0;
    const actual = Atomics.compareExchange(meta, FRAME_RING_WAKE_INDEX, observed, next);
    if (actual === observed) {
      Atomics.notify(meta, FRAME_RING_WAKE_INDEX);
      return;
    }
    observed = actual;
  }
}

export interface FrameRingWriter {
  write(
    payload: Uint8Array,
    kind: number,
    allowLarge: boolean,
    inputSequenceMapping?: InputSequenceMapping,
  ): boolean;
  /** Copy a transient source directly into its unpublished ring reservation. */
  writeFrom(
    payload: SynchronousByteSource,
    kind: number,
    allowLarge: boolean,
    inputSequenceMapping?: InputSequenceMapping,
  ): boolean;
  /** Fence native draining and return the exact uint32 state token that owns it. */
  fenceSessionLineage(): number;
  droppedCount(): number;
}

export function createFrameRingWriter(
  sab: SharedArrayBuffer,
  onReadableEdge?: () => void,
): FrameRingWriter {
  const meta = new Int32Array(sab, 0, FRAME_RING_META_WORDS);
  const dataView = new DataView(sab, FRAME_RING_META_BYTES);
  const dataBytes = new Uint8Array(sab, FRAME_RING_META_BYTES);
  const capacity = sab.byteLength - FRAME_RING_META_BYTES;
  let writeActive = false;

  // Exactly one of `bytes` and `source` is the payload; branching on it, not a
  // copier closure, keeps a frame write from allocating.
  function writePayload(
    payloadLen: number,
    bytes: Uint8Array | null,
    source: SynchronousByteSource | null,
    kind: number,
    allowLarge: boolean,
    inputSequenceMapping?: InputSequenceMapping,
  ): boolean {
    if (writeActive) throw new Error('frame ring write is not reentrant');
    if (payloadLen === 0) return false; // zero-length sentinel reserved for skip marker
    const slotSize = alignUp(FRAME_ENTRY_HEADER_BYTES + payloadLen, FRAME_ENTRY_ALIGN);
    // Reserve at least one alignment unit so writeOffset can never equal
    // readOffset after a write — that state is reserved for "empty".
    if (slotSize + FRAME_ENTRY_ALIGN > capacity) return false;

    const writeOff = Atomics.load(meta, 0);
    const readOff = Atomics.load(meta, 1);

    let pos: number;
    if (writeOff >= readOff) {
      if (writeOff + slotSize + FRAME_ENTRY_ALIGN <= capacity) {
        pos = writeOff;
      } else if (slotSize + FRAME_ENTRY_ALIGN <= readOff) {
        // Wrap. Skip marker tells the reader to jump to start.
        dataView.setUint32(writeOff, FRAME_SKIP_MARKER, true);
        pos = 0;
      } else {
        Atomics.add(meta, 2, 1);
        return false;
      }
    } else if (writeOff + slotSize + FRAME_ENTRY_ALIGN <= readOff) {
      pos = writeOff;
    } else {
      Atomics.add(meta, 2, 1);
      return false;
    }

    writeActive = true;
    try {
      // Header and payload remain invisible until the release-store below. A
      // copier failure can leave scratch bytes in the free reservation but can
      // never publish a partial entry.
      dataView.setUint32(pos, payloadLen, true);
      dataView.setUint8(pos + 4, kind);
      dataView.setUint8(pos + 5, allowLarge ? 1 : 0);
      dataView.setUint32(pos + 8, inputSequenceMapping?.epoch ?? 0, true);
      dataView.setUint32(pos + 12, inputSequenceMapping?.localMinusWire ?? 0, true);
      dataView.setUint32(pos + 16, inputSequenceMapping?.wireMin ?? 0, true);
      dataView.setUint32(pos + 20, inputSequenceMapping?.wireMax ?? 0, true);
      if (bytes !== null) dataBytes.set(bytes, pos + FRAME_ENTRY_HEADER_BYTES);
      else source?.copyTo(dataBytes, pos + FRAME_ENTRY_HEADER_BYTES);
      Atomics.store(meta, 0, pos + slotSize);
    } finally {
      writeActive = false;
    }

    // Re-read the consumer cursor after publication. It may have drained the
    // old tail and parked while this producer was copying the new entry even
    // though the initial snapshot was nonempty.
    const readerNeedsWake = readerNeedsWakeAfterPublish(writeOff, readOff, Atomics.load(meta, 1));
    if (readerNeedsWake) {
      // The task edge remains available while fenced so WebKit can preserve
      // worker-message ordering. Native readers are released only after the
      // terminal worker has installed the corresponding session epoch.
      wakeNativeFrameReaderIfReadable(meta);
      try {
        onReadableEdge?.();
      } catch {
        // The entry is already published and cannot be rolled back. The
        // reader's watchdog remains the fail-safe if task delivery fails.
      }
    }
    return true;
  }

  return {
    write(
      payload: Uint8Array,
      kind: number,
      allowLarge: boolean,
      inputSequenceMapping?: InputSequenceMapping,
    ): boolean {
      return writePayload(
        payload.byteLength,
        payload,
        null,
        kind,
        allowLarge,
        inputSequenceMapping,
      );
    },
    writeFrom(
      payload: SynchronousByteSource,
      kind: number,
      allowLarge: boolean,
      inputSequenceMapping?: InputSequenceMapping,
    ): boolean {
      return writePayload(
        payload.byteLength,
        null,
        payload,
        kind,
        allowLarge,
        inputSequenceMapping,
      );
    },
    fenceSessionLineage(): number {
      const token = transitionFrameRingWakeState(meta, true);
      Atomics.notify(meta, FRAME_RING_WAKE_INDEX);
      return token;
    },
    droppedCount(): number {
      return Atomics.load(meta, 2) >>> 0;
    },
  };
}

export interface FrameRingEntry {
  readonly payload: Uint8Array;
  readonly kind: number;
  readonly allowLarge: boolean;
  readonly inputSequenceMapping: InputSequenceMapping;
}

/**
 * The reader's one lease record. `tryReadLeased` overwrites its fields for
 * each entry and hands back the same object, so neither the lease, its
 * `payload` view, nor its `inputSequenceMapping` may be retained past
 * `release()`: the next read moves all three.
 */
export interface FrameRingLease extends FrameRingEntry {
  /**
   * Advance the consumer cursor. `payload` is reset to an empty view so a
   * late read sees no bytes rather than a slot the producer may be refilling.
   */
  release(): void;
}

const EMPTY_PAYLOAD = new Uint8Array(0);

interface MutableInputSequenceMapping {
  epoch: number;
  localMinusWire: number;
  wireMin: number;
  wireMax: number;
}

interface MutableFrameRingLease extends FrameRingLease {
  payload: Uint8Array;
  kind: number;
  allowLarge: boolean;
  readonly inputSequenceMapping: MutableInputSequenceMapping;
}

export interface FrameRingReader {
  /**
   * Copying read for tests and benches: a fresh entry that owns its bytes.
   * Production drains through `tryReadLeased`. Throws while a lease is
   * outstanding — advancing the cursor under a live lease would hand its slot
   * back to the producer.
   */
  tryRead(): FrameRingEntry | null;
  /**
   * Read in place through the reader's one lease record. Exactly one lease may
   * be outstanding: a second read before `release()` would overwrite the record
   * the caller is still applying, so it throws instead of returning `null` —
   * the pump is synchronous and non-reentrant, and this is where that is
   * enforced rather than assumed.
   */
  tryReadLeased(): FrameRingLease | null;
  /** Readable backlog without allocating a waiter or acquiring a lease. */
  hasPending(): boolean;
  /** Occupied ring bytes, including framing/alignment, sampled without traversal. */
  pendingBytes(): number;
  /** Cumulative producer refusals (uint32), including refusals between slices. */
  droppedCount(): number;
  /**
   * Whether the producer refused an entry since the last call; read once a
   * drain finds the ring empty. A producer that must not lose a refused entry
   * writes it again at once: its refusal is counted before the write returns,
   * so either that second write sees the space this reader freed, or this read
   * sees the count and the terminal worker posts `FRAME_RING_SPACE_EDGE`.
   */
  takeRefusal(): boolean;
  /**
   * Fence everything the producer published before this call.
   *
   * The writer publishes an entry by storing writeOffset only after its bytes
   * are complete, so copying that offset to readOffset atomically discards
   * exactly the fully-published prefix. Entries published afterwards remain
   * readable. Used at authenticated session boundaries where bytes from the
   * previous daemon lineage must not consume the new epoch's snapshot gate.
   * Returns true when unread bytes or an outstanding lease were discarded.
   */
  discardPending(): boolean;
  /** Resume reads only if this epoch still owns the producer's exact fence. */
  releaseSessionLineageFence(expectedToken: number): boolean;
  /**
   * `'not-equal'` when the ring can be read now; otherwise the park promise,
   * resolved by a producer edge or the watchdog. Its resolved value is not the
   * signal — the ring state is — so it is handed back untouched rather than
   * paying a continuation per park to erase it.
   */
  waitAsync(): Promise<unknown> | 'not-equal';
}

export function createFrameRingReader(
  sab: SharedArrayBuffer,
  waitTimeoutMs = RING_WAIT_WATCHDOG_MS,
  waitForReadableTask?: (watchdogMs: number) => Promise<void>,
): FrameRingReader {
  const meta = new Int32Array(sab, 0, FRAME_RING_META_WORDS);
  const dataView = new DataView(sab, FRAME_RING_META_BYTES);
  // The one lease this reader hands out, and the cursor its release stores.
  // Allocated once with the reader; every `tryReadLeased` overwrites the
  // fields and the mapping in place, so a steady drain mints exactly one
  // object per entry — the exact-length payload view the frame pool and WASM
  // need — and nothing else.
  let leaseOutstanding = false;
  let leaseNextReadOff = 0;
  const lease: MutableFrameRingLease = {
    payload: EMPTY_PAYLOAD,
    kind: 0,
    allowLarge: false,
    inputSequenceMapping: { epoch: 0, localMinusWire: 0, wireMin: 0, wireMax: 0 },
    release(): void {
      // A lease `discardPending` already invalidated must not rewind the fence
      // it moved; a double release is a no-op for the same reason.
      if (!leaseOutstanding) return;
      leaseOutstanding = false;
      lease.payload = EMPTY_PAYLOAD;
      Atomics.store(meta, 1, leaseNextReadOff);
    },
  };
  // Refusals before this reader existed were answered by whoever read then.
  let refusalsTaken = Atomics.load(meta, 2);

  /**
   * Offset of the next published entry, or -1 when the ring is fenced or
   * empty. Consumes a skip marker on the way.
   */
  function nextEntryOffset(): number {
    let readOff = Atomics.load(meta, 1);
    const writeOff = Atomics.load(meta, 0);
    // The producer fences before it can publish a new lineage. Load its cursor
    // first, then the fence, so observing new bytes also observes that fence.
    if ((Atomics.load(meta, FRAME_RING_WAKE_INDEX) & FRAME_RING_LINEAGE_FENCED) !== 0) {
      return -1;
    }
    if (readOff === writeOff) return -1;
    if (dataView.getUint32(readOff, true) === FRAME_SKIP_MARKER) {
      readOff = 0;
      Atomics.store(meta, 1, 0);
      if (readOff === writeOff) return -1;
    }
    return readOff;
  }

  return {
    tryRead(): FrameRingEntry | null {
      if (leaseOutstanding) return null;
      const readOff = nextEntryOffset();
      if (readOff < 0) return null;
      const payloadLen = dataView.getUint32(readOff, true);
      const entry: FrameRingEntry = {
        payload: new Uint8Array(
          sab,
          FRAME_RING_META_BYTES + readOff + FRAME_ENTRY_HEADER_BYTES,
          payloadLen,
        ).slice(),
        kind: dataView.getUint8(readOff + 4),
        allowLarge: (dataView.getUint8(readOff + 5) & 1) !== 0,
        inputSequenceMapping: {
          epoch: dataView.getUint32(readOff + 8, true),
          localMinusWire: dataView.getUint32(readOff + 12, true),
          wireMin: dataView.getUint32(readOff + 16, true),
          wireMax: dataView.getUint32(readOff + 20, true),
        },
      };
      Atomics.store(
        meta,
        1,
        readOff + alignUp(FRAME_ENTRY_HEADER_BYTES + payloadLen, FRAME_ENTRY_ALIGN),
      );
      return entry;
    },

    tryReadLeased(): FrameRingLease | null {
      if (leaseOutstanding) return null;
      const readOff = nextEntryOffset();
      if (readOff < 0) return null;
      const payloadLen = dataView.getUint32(readOff, true);
      lease.payload = new Uint8Array(
        sab,
        FRAME_RING_META_BYTES + readOff + FRAME_ENTRY_HEADER_BYTES,
        payloadLen,
      );
      lease.kind = dataView.getUint8(readOff + 4);
      lease.allowLarge = (dataView.getUint8(readOff + 5) & 1) !== 0;
      const mapping = lease.inputSequenceMapping;
      mapping.epoch = dataView.getUint32(readOff + 8, true);
      mapping.localMinusWire = dataView.getUint32(readOff + 12, true);
      mapping.wireMin = dataView.getUint32(readOff + 16, true);
      mapping.wireMax = dataView.getUint32(readOff + 20, true);
      leaseNextReadOff =
        readOff + alignUp(FRAME_ENTRY_HEADER_BYTES + payloadLen, FRAME_ENTRY_ALIGN);
      leaseOutstanding = true;
      return lease;
    },

    pendingBytes(): number {
      const readOff = Atomics.load(meta, 1);
      const writeOff = Atomics.load(meta, 0);
      return (writeOff - readOff + dataView.byteLength) % dataView.byteLength;
    },

    droppedCount(): number {
      return Atomics.load(meta, 2) >>> 0;
    },

    takeRefusal(): boolean {
      const refusals = Atomics.load(meta, 2);
      if (refusals === refusalsTaken) return false;
      refusalsTaken = refusals;
      return true;
    },

    hasPending(): boolean {
      const readOff = Atomics.load(meta, 1);
      const writeOff = Atomics.load(meta, 0);
      return (
        readOff !== writeOff &&
        (Atomics.load(meta, FRAME_RING_WAKE_INDEX) & FRAME_RING_LINEAGE_FENCED) === 0
      );
    },

    discardPending(): boolean {
      const writeOff = Atomics.load(meta, 0);
      const readOff = Atomics.load(meta, 1);
      const discarded = leaseOutstanding || readOff !== writeOff;
      leaseOutstanding = false;
      lease.payload = EMPTY_PAYLOAD;
      Atomics.store(meta, 1, writeOff);
      return discarded;
    },

    releaseSessionLineageFence(expectedToken): boolean {
      const expected = expectedToken | 0;
      if (expectedToken !== expected >>> 0 || (expected & FRAME_RING_LINEAGE_FENCED) === 0) {
        return false;
      }
      const next =
        ((expected + FRAME_RING_WAKE_SEQUENCE_INCREMENT) & ~FRAME_RING_LINEAGE_FENCED) | 0;
      if (Atomics.compareExchange(meta, FRAME_RING_WAKE_INDEX, expected, next) !== expected) {
        return false;
      }
      Atomics.notify(meta, FRAME_RING_WAKE_INDEX);
      return true;
    },

    waitAsync(): Promise<unknown> | 'not-equal' {
      const wakeState = Atomics.load(meta, FRAME_RING_WAKE_INDEX);
      const lineageFenced = (wakeState & FRAME_RING_LINEAGE_FENCED) !== 0;
      if (!lineageFenced) {
        const writeOff = Atomics.load(meta, 0);
        const readOff = Atomics.load(meta, 1);
        if (readOff !== writeOff) return 'not-equal';
        // Publication may land between the first state/cursor snapshots. The
        // second state read turns that race into a synchronous retry; a later
        // publication changes the futex before Atomics.waitAsync can park.
        if (Atomics.load(meta, FRAME_RING_WAKE_INDEX) !== wakeState) return 'not-equal';
      }
      if (waitForReadableTask !== undefined) return waitForReadableTask(waitTimeoutMs);
      const result = Atomics.waitAsync(meta, FRAME_RING_WAKE_INDEX, wakeState, waitTimeoutMs);
      return result.async ? result.value : 'not-equal';
    },
  };
}
