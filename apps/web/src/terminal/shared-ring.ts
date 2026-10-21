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
 * frame ring's lineage announcement moves none. The frame ring's word is
 * `meta[3]`, a wake sequence.
 *
 * Wake proof. Every producer edge stores its state (an entry cursor
 * or a lineage), then bumps the wake word, then notifies. A reader snapshots the
 * wake word first, then reads the state it waits on, then re-reads the word,
 * then parks on the snapshot. An edge therefore lands in exactly one of three
 * places: before the recheck, where the moved state or the moved word returns
 * `'not-equal'` synchronously; between the recheck and the park, where
 * `Atomics.waitAsync` sees the moved word and returns synchronously; or after
 * the park, where the notify resolves it. Boundedness: each `'not-equal'` is
 * charged to one producer edge — an entry or a lineage announcement — so a
 * drain loop that `continue`s without yielding on `'not-equal'` cannot spin.
 *
 * Lineage fence. An authenticated session boundary travels in the ring as an
 * ordered entry, not as a message to the reader's realm: the producer announces
 * the fence's token in `meta[4]`, then publishes the fence entry. Until the
 * reader takes the announced fence, every entry ahead of it belongs to a
 * lineage that has ended and is discarded unread; entries behind it are the new
 * lineage's. The producer never waits for the reader to take a fence: frames it
 * writes after the fence are already ordered behind it. The reader records the
 * token of the fence its viewer installed in `meta[5]`, which the producer reads
 * as the viewer's confirmation of the lineage.
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
//   [3]: native wake sequence
//   [4]: announced lineage fence token (writer-owned; 0 = none yet)
//   [5]: installed lineage fence token (reader-owned; 0 = none yet)
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
//
// A lineage fence entry (kind `FRAME_KIND_LINEAGE_FENCE`) carries a 12-byte
// payload: fence token (u32), display lineage (u32), flags (u32; bit 0 = the
// viewer's session is new).

const FRAME_RING_META_WORDS = 6;
const FRAME_RING_META_BYTES = FRAME_RING_META_WORDS * 4;
const FRAME_ENTRY_HEADER_BYTES = 24;
const FRAME_ENTRY_ALIGN = 8;
const FRAME_SKIP_MARKER = 0;
const FRAME_RING_WAKE_INDEX = 3;
const FRAME_RING_ANNOUNCED_FENCE_INDEX = 4;
const FRAME_RING_INSTALLED_FENCE_INDEX = 5;
const FRAME_FENCE_PAYLOAD_BYTES = 12;
const FRAME_FENCE_NEW_SESSION = 1;

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
/** An authenticated display lineage boundary; see the lineage fence above. */
export const FRAME_KIND_LINEAGE_FENCE = 2;

/** One lineage boundary, as the reader hands it to the viewer. */
export interface FrameRingFence {
  /** The writer's token for this fence; never 0. */
  readonly token: number;
  readonly lineage: number;
  /** The viewer's session is new: it resets rather than continues. */
  readonly newSession: boolean;
}

/** The fence a `FRAME_KIND_LINEAGE_FENCE` entry's payload carries. */
export function readFrameRingFence(payload: Uint8Array): FrameRingFence {
  if (payload.byteLength !== FRAME_FENCE_PAYLOAD_BYTES) {
    throw new Error('frame ring lineage fence has the wrong length');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, FRAME_FENCE_PAYLOAD_BYTES);
  return {
    token: view.getUint32(0, true),
    lineage: view.getUint32(4, true),
    newSession: (view.getUint32(8, true) & FRAME_FENCE_NEW_SESSION) !== 0,
  };
}
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

function wakeNativeFrameReader(meta: Int32Array): void {
  Atomics.add(meta, FRAME_RING_WAKE_INDEX, 1);
  Atomics.notify(meta, FRAME_RING_WAKE_INDEX);
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
  /**
   * Announce a new display lineage and return its fence token. From here the
   * reader discards every entry published before this fence's entry, which
   * `publishFence` writes; nothing waits for the reader to take it.
   */
  fenceSessionLineage(lineage: number, newSession: boolean): number;
  /**
   * Publish the announced fence's entry. False while the ring has no room for
   * it: the announcement already lets the reader discard what precedes the
   * fence, and its space edge says when to publish again.
   */
  publishFence(): boolean;
  /** The token of the last fence the reader's viewer installed; 0 before any. */
  installedFence(): number;
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
  // The fence entry's payload, reused for every fence this writer publishes.
  const fencePayload = new Uint8Array(FRAME_FENCE_PAYLOAD_BYTES);
  const fenceView = new DataView(fencePayload.buffer);
  let fenceToken = Atomics.load(meta, FRAME_RING_ANNOUNCED_FENCE_INDEX) >>> 0;
  let fencePending = false;

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
    if (readerNeedsWake) wakeReader();
    return true;
  }

  function wakeReader(): void {
    wakeNativeFrameReader(meta);
    try {
      onReadableEdge?.();
    } catch {
      // What woke the reader is already published and cannot be rolled back.
      // The reader's watchdog remains the fail-safe if task delivery fails.
    }
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
    fenceSessionLineage(lineage: number, newSession: boolean): number {
      fenceToken = (fenceToken + 1) >>> 0 || 1;
      fenceView.setUint32(0, fenceToken, true);
      fenceView.setUint32(4, lineage, true);
      fenceView.setUint32(8, newSession ? FRAME_FENCE_NEW_SESSION : 0, true);
      fencePending = true;
      Atomics.store(meta, FRAME_RING_ANNOUNCED_FENCE_INDEX, fenceToken | 0);
      // The announcement alone frees the reader to discard what precedes the
      // fence, which a full ring needs before the fence entry fits.
      wakeReader();
      return fenceToken;
    },
    publishFence(): boolean {
      if (!fencePending) return true;
      if (
        !writePayload(
          FRAME_FENCE_PAYLOAD_BYTES,
          fencePayload,
          null,
          FRAME_KIND_LINEAGE_FENCE,
          false,
        )
      )
        return false;
      fencePending = false;
      return true;
    },
    installedFence(): number {
      return Atomics.load(meta, FRAME_RING_INSTALLED_FENCE_INDEX) >>> 0;
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
   * Discard everything the producer published before this call, except an
   * announced fence not yet taken, which stays next to read.
   *
   * The writer publishes an entry by storing writeOffset only after its bytes
   * are complete, so the walk to that offset discards exactly the
   * fully-published prefix. Entries published afterwards remain readable. Used
   * when a replacement runtime takes over a ring whose entries the previous one
   * left half-applied. Returns true when unread bytes or an outstanding lease
   * were discarded.
   */
  discardPending(): boolean;
  /**
   * A fence is announced and not yet taken: until it is, this reader hands out
   * that fence and nothing else.
   */
  fencePending(): boolean;
  /** Record that the viewer installed the lineage of the fence with `token`. */
  installFence(token: number): void;
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
  // The token of the last fence this ring handed to a reader. A fresh reader
  // starts from the last one a viewer installed.
  let takenFence = Atomics.load(meta, FRAME_RING_INSTALLED_FENCE_INDEX) >>> 0;
  // A fence skipped for a later one may have begun a new session, which the
  // later fence then carries: the viewer still has to start over.
  let skippedNewSession = false;

  function entryEnd(readOff: number): number {
    return (
      readOff +
      alignUp(FRAME_ENTRY_HEADER_BYTES + dataView.getUint32(readOff, true), FRAME_ENTRY_ALIGN)
    );
  }

  /**
   * Offset of the next entry to hand out, or -1 when the ring is empty.
   * Consumes skip markers on the way, and, while a fence is announced but not
   * yet taken, every entry ahead of it: they belong to a lineage that ended.
   */
  function nextEntryOffset(): number {
    for (;;) {
      let readOff = Atomics.load(meta, 1);
      const writeOff = Atomics.load(meta, 0);
      if (readOff === writeOff) return -1;
      if (dataView.getUint32(readOff, true) === FRAME_SKIP_MARKER) {
        readOff = 0;
        Atomics.store(meta, 1, 0);
        if (readOff === writeOff) return -1;
      }
      // The writer announces a fence before it publishes the fence's entry, so
      // reading the entry's cursor first and the announcement second sees the
      // announcement of every fence entry already readable.
      const announced = Atomics.load(meta, FRAME_RING_ANNOUNCED_FENCE_INDEX) >>> 0;
      if (announced === takenFence) return readOff;
      if (dataView.getUint8(readOff + 4) === FRAME_KIND_LINEAGE_FENCE) {
        const payload = readOff + FRAME_ENTRY_HEADER_BYTES;
        const flags = dataView.getUint32(payload + 8, true);
        if (dataView.getUint32(payload, true) === announced) {
          if (skippedNewSession)
            dataView.setUint32(payload + 8, flags | FRAME_FENCE_NEW_SESSION, true);
          skippedNewSession = false;
          return readOff;
        }
        skippedNewSession ||= (flags & FRAME_FENCE_NEW_SESSION) !== 0;
      }
      Atomics.store(meta, 1, entryEnd(readOff));
    }
  }

  /** An entry is being handed out: a fence among them is taken with it. */
  function noteTaken(readOff: number): void {
    if (dataView.getUint8(readOff + 4) !== FRAME_KIND_LINEAGE_FENCE) return;
    takenFence = dataView.getUint32(readOff + FRAME_ENTRY_HEADER_BYTES, true);
  }

  return {
    tryRead(): FrameRingEntry | null {
      if (leaseOutstanding) return null;
      const readOff = nextEntryOffset();
      if (readOff < 0) return null;
      noteTaken(readOff);
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
      noteTaken(readOff);
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
      return Atomics.load(meta, 1) !== Atomics.load(meta, 0);
    },

    discardPending(): boolean {
      const writeOff = Atomics.load(meta, 0);
      let readOff = Atomics.load(meta, 1);
      const discarded = leaseOutstanding || readOff !== writeOff;
      leaseOutstanding = false;
      lease.payload = EMPTY_PAYLOAD;
      // Everything published so far goes, except a fence not yet taken: the
      // lineage it begins is the one whose entries follow.
      const announced = Atomics.load(meta, FRAME_RING_ANNOUNCED_FENCE_INDEX) >>> 0;
      while (readOff !== writeOff) {
        if (dataView.getUint32(readOff, true) === FRAME_SKIP_MARKER) {
          readOff = 0;
          continue;
        }
        if (
          announced !== takenFence &&
          dataView.getUint8(readOff + 4) === FRAME_KIND_LINEAGE_FENCE &&
          dataView.getUint32(readOff + FRAME_ENTRY_HEADER_BYTES, true) === announced
        )
          break;
        readOff = entryEnd(readOff);
      }
      Atomics.store(meta, 1, readOff);
      return discarded;
    },

    fencePending(): boolean {
      return Atomics.load(meta, FRAME_RING_ANNOUNCED_FENCE_INDEX) >>> 0 !== takenFence;
    },

    installFence(token): void {
      Atomics.store(meta, FRAME_RING_INSTALLED_FENCE_INDEX, token | 0);
    },

    waitAsync(): Promise<unknown> | 'not-equal' {
      const wakeState = Atomics.load(meta, FRAME_RING_WAKE_INDEX);
      if (Atomics.load(meta, 1) !== Atomics.load(meta, 0)) return 'not-equal';
      // Publication may land between the first state/cursor snapshots. The
      // second state read turns that race into a synchronous retry; a later
      // publication changes the futex before Atomics.waitAsync can park.
      if (Atomics.load(meta, FRAME_RING_WAKE_INDEX) !== wakeState) return 'not-equal';
      if (waitForReadableTask !== undefined) return waitForReadableTask(waitTimeoutMs);
      const result = Atomics.waitAsync(meta, FRAME_RING_WAKE_INDEX, wakeState, waitTimeoutMs);
      return result.async ? result.value : 'not-equal';
    },
  };
}
