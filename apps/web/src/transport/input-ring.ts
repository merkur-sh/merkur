/**
 * Lock-free SPSC ring for keystroke input: main thread writes, transport worker
 * reads. Mirrors the frame ring in terminal/shared-ring.ts.
 *
 * The ring IS the outbox. A slot is not free when the worker has read it; it is
 * free when the daemon has acknowledged the keystroke it holds (or the session
 * that owned it ended). The worker therefore never copies a payload out of the
 * ring: an `input_run` is encoded straight from the slots into the Noise
 * buffer, on the first send and on every retransmit, and the daemon's ACK is
 * what returns the slot to the writer. One end-to-end backlog budget lives in
 * the ring's meta words — charged by the writer when it publishes an entry,
 * released by the reader when the entry is acknowledged — so main's admission
 * gate reads one word per bound and never waits on a worker round trip.
 *
 * The input seq is allocated on the MAIN thread (synchronously, at keystroke
 * time) and carried in each entry, because predictive local echo in the
 * terminal worker is keyed off that exact seq — it must be available the moment
 * the keystroke is captured, before the worker has processed anything. The
 * worker addresses entries by ORDINAL: the reader assigns each entry it reads a
 * monotonic index into a set of reader-private column arrays (slot offset,
 * payload length, local seq, flags), and the sequence-mapping layer in
 * session/input-outbox.ts speaks ordinals to it.
 *
 * Input the application has not asked for (a key release, a bare modifier, a
 * focus report while the terminal's mode word says nothing reports them) is
 * published DEFERRED: in order, charged, but invisible to the reader and
 * silent to it. It leaves with the next ordinary entry, in the same run, so it
 * costs no datagram and no acknowledgement of its own. The writer releases
 * held entries by publishing the seq of its latest entry: on the next ordinary
 * entry, when the mode word starts reporting them, and when the ring cannot
 * admit an entry. Seqs only increase, so the reader reads a deferred entry once
 * its seq is at or below that word, and nothing is lost or reordered.
 */

import { readerNeedsWakeAfterPublish } from '../lib/spsc-ring-wake';
import {
  createPredictionAdmissionCoordinator,
  createPredictionAdmissionReader,
  PREDICTION_ADMISSION_ACCEPTED,
  PREDICTION_ADMISSION_SLOTS,
  type PredictionAdmissionCoordinator,
  type PredictionAdmissionReader,
} from './prediction-admission';

// meta (Int32Array):
//   [0] writeOffset     (bytes into the data area; writer-owned)
//   [1] ackedOffset     (bytes into the data area; reader-owned). The writer's
//                       free-space boundary: every slot below it was
//                       acknowledged by the daemon or dropped with its session,
//                       so the writer may overwrite it.
//   [2] dropped         (writes rejected because the ring was full)
//   [3] releasedSeq     (writer-owned; u32). Deferred entries with a seq at or
//                       below it are readable. The reader parks on this word
//                       while its head is a deferred entry above it.
//   [4] reserved
//   [5] bufferedBytes   (payload bytes published and not yet acknowledged;
//                       charged by the writer, released by the reader)
//   [6] bufferedEntries (entries published and not yet acknowledged; same
//                       ownership)
//   [7] consumedOffset  (bytes into the data area; reader-owned). What the
//                       reader has read. The writer's wake predicate compares
//                       against this word, never against [1]: a reader parks
//                       when it has read everything, not when everything it
//                       read has been acknowledged.
const INPUT_RING_META_BYTES = 32;
const INPUT_ENTRY_HEADER_BYTES = 8; // payloadLen (u32) + seq (u32)
const INPUT_ENTRY_ALIGN = 8;
const INPUT_SKIP_MARKER = 0;
// The ring's payload budget is 256 KiB, so payloadLen's high bit is otherwise
// unreachable. Reuse it to mark an entry whose shadow provenance was granted,
// without growing the 8-byte header or changing entry alignment. The transport
// still confirms the grant against the shared ledger, which the terminal worker
// may have downgraded in the meantime.
const INPUT_ENTRY_PREDICTION_CANDIDATE_MASK = 0x8000_0000;
// The next bit marks a deferred entry; see the module comment.
const INPUT_ENTRY_DEFERRED_MASK = 0x4000_0000;
const INPUT_ENTRY_PAYLOAD_LEN_MASK = 0x3fff_ffff;
const META_RELEASED_SEQ = 3;

/**
 * Sized so the byte budget, not the ring, is what binds. Slots are held until
 * the daemon acknowledges them, so the ring must hold the whole unacked
 * backlog plus its per-entry overhead: `MAX_BUFFERED_INPUT_BYTES` of payload
 * plus `MAX_BUFFERED_INPUT_ENTRIES` headers rounded to the entry alignment
 * (4,096 × 16 bytes = 64 KiB) stays under this by the alignment slack the
 * writer keeps between its cursor and the acknowledged cursor.
 */
export const INPUT_RING_SIZE = 384 * 1024;
/**
 * One end-to-end input backlog budget: every keystroke published and not yet
 * acknowledged by the daemon counts, whether the worker has read it or not.
 */
export const MAX_BUFFERED_INPUT_BYTES = 256 * 1024;
/**
 * A byte-only limit permits 262k one-byte objects. Bound entries separately so
 * a stalled ACK path cannot turn ordinary keypresses into tens of MiB of JS
 * object overhead. This also matches the daemon's bounded PTY write pipeline,
 * and it is the size of the reader's ordinal column arrays: the writer refuses
 * an entry past it, so an ordinal can never wrap onto one still held.
 */
export const MAX_BUFFERED_INPUT_ENTRIES = PREDICTION_ADMISSION_SLOTS;
const ORDINAL_MASK = MAX_BUFFERED_INPUT_ENTRIES - 1;
// Resume/network hints explicitly wake the reader. Keep a coarse watchdog only
// as a last-resort WebKit lost-notify backstop, avoiding a permanent park
// without waking an otherwise idle worker every second.
const INPUT_RING_WAIT_WATCHDOG_MS = 30_000;
const FLAG_SHADOW_MODELLED = 0x01;
const FLAG_DEFERRED = 0x02;

function alignUp(n: number, align: number): number {
  return (n + align - 1) & ~(align - 1);
}

export interface InputRingWriter {
  /**
   * Enqueue a keystroke. Once capacity is known, `classifyShadowModelled` is
   * called synchronously before the entry is published to the reader, and its
   * return value IS the provenance verdict: it mirrors the WASM model's own
   * admission arithmetic rather than promising a later answer, so nothing
   * downstream waits. The terminal worker may still downgrade the grant before
   * the transport reads it, never upgrade it. The callback is never called for
   * a rejected write.
   *
   * A `deferred` entry is published without waking the reader and is held
   * until the next ordinary entry or `releaseDeferred`.
   */
  write(
    seq: number,
    payload: Uint8Array,
    classifyShadowModelled?: (inputSeq: number) => boolean,
    deferred?: boolean,
  ): boolean;
  /**
   * Make every deferred entry published so far readable, and wake the reader.
   * A no-op when nothing is held.
   */
  releaseDeferred(): void;
  /** Rotate the authenticated prediction lineage before every session start. */
  beginPredictionLineage(): number;
  droppedCount(): number;
  /** Payload bytes published and not yet acknowledged, for synchronous admission. */
  bufferedBytes(): number;
  /** Entries published and not yet acknowledged, for synchronous admission. */
  bufferedEntries(): number;
}

export function createInputRingWriter(
  sab: SharedArrayBuffer,
  predictionAdmissionSab?: SharedArrayBuffer,
  onReadableEdge?: () => void,
): InputRingWriter {
  const meta = new Int32Array(sab, 0, 8);
  const dataView = new DataView(sab, INPUT_RING_META_BYTES);
  const dataBytes = new Uint8Array(sab, INPUT_RING_META_BYTES);
  const capacity = sab.byteLength - INPUT_RING_META_BYTES;
  const predictionAdmission: PredictionAdmissionCoordinator | null =
    predictionAdmissionSab === undefined
      ? null
      : createPredictionAdmissionCoordinator(predictionAdmissionSab);
  // Deferred entries were published since the last release.
  let holding = false;
  let lastPublishedSeq = 0;
  // Seqs restart with every writer; a bound left by an earlier one would
  // release this writer's deferred entries early.
  Atomics.store(meta, META_RELEASED_SEQ, 0);

  function wakeReader(): void {
    Atomics.notify(meta, 0);
    Atomics.notify(meta, META_RELEASED_SEQ);
    try {
      onReadableEdge?.();
    } catch {
      // The input sequence is already published. Reporting a failed write
      // here would let the caller reuse it and create a duplicate entry.
    }
  }

  function releaseDeferred(): void {
    if (!holding) return;
    holding = false;
    Atomics.store(meta, META_RELEASED_SEQ, lastPublishedSeq | 0);
    wakeReader();
  }

  return {
    write(
      seq: number,
      payload: Uint8Array,
      classifyShadowModelled?: (inputSeq: number) => boolean,
      deferred = false,
    ): boolean {
      const payloadLen = payload.byteLength;
      if (payloadLen === 0) return false; // zero-length reserved for skip marker
      const slotSize = alignUp(INPUT_ENTRY_HEADER_BYTES + payloadLen, INPUT_ENTRY_ALIGN);
      if (slotSize + INPUT_ENTRY_ALIGN > capacity) return false;
      // The reader's ordinal columns hold exactly this many entries. Main's
      // admission gate reads the same word first; this refusal is what keeps
      // a producer that bypasses that gate from wrapping an ordinal onto a slot
      // the daemon has not acknowledged.
      if (Atomics.load(meta, 6) >= MAX_BUFFERED_INPUT_ENTRIES) {
        Atomics.add(meta, 2, 1);
        return false;
      }

      const writeOff = Atomics.load(meta, 0);
      const ackedOff = Atomics.load(meta, 1);
      const consumedOff = Atomics.load(meta, 7);

      let pos: number;
      if (writeOff >= ackedOff) {
        if (writeOff + slotSize + INPUT_ENTRY_ALIGN <= capacity) {
          pos = writeOff;
        } else if (slotSize + INPUT_ENTRY_ALIGN <= ackedOff) {
          dataView.setUint32(writeOff, INPUT_SKIP_MARKER, true);
          pos = 0;
        } else {
          Atomics.add(meta, 2, 1);
          return false;
        }
      } else if (writeOff + slotSize + INPUT_ENTRY_ALIGN <= ackedOff) {
        pos = writeOff;
      } else {
        Atomics.add(meta, 2, 1);
        return false;
      }

      let predictionCandidate = false;
      if (classifyShadowModelled !== undefined) {
        try {
          predictionCandidate = classifyShadowModelled(seq) === true;
        } catch {
          // Prediction metadata is a capability grant. A UI-side prediction
          // failure must never turn an otherwise valid keystroke into a drop,
          // but it must fail closed on the wire.
          predictionCandidate = false;
        }
        // Decided here, synchronously, before the entry is visible. A reader
        // therefore never observes an undecided slot and never parks.
        predictionCandidate = predictionAdmission?.publish(seq, predictionCandidate) ?? false;
      }
      const encodedPayloadLen =
        payloadLen |
        (predictionCandidate ? INPUT_ENTRY_PREDICTION_CANDIDATE_MASK : 0) |
        (deferred ? INPUT_ENTRY_DEFERRED_MASK : 0);
      dataView.setUint32(pos, encodedPayloadLen >>> 0, true);
      dataView.setUint32(pos + 4, seq >>> 0, true);
      dataBytes.set(payload, pos + INPUT_ENTRY_HEADER_BYTES);

      // Charge the entry before publishing writeOffset. The reader therefore
      // cannot observe an entry that the main-side admission gate has not
      // already counted.
      Atomics.add(meta, 5, payloadLen);
      Atomics.add(meta, 6, 1);
      Atomics.store(meta, 0, pos + slotSize);
      lastPublishedSeq = seq;
      if (deferred) {
        holding = true;
        return true;
      }
      if (holding) {
        releaseDeferred();
        return true;
      }
      // The consumer can read the old tail and park while this producer is
      // copying. Re-read its cursor after publication so that transition still
      // receives both native and task wake edges. It is the CONSUMED cursor
      // that decides: a reader holding unacknowledged entries is still parked
      // once it has read everything published.
      const readerNeedsWake = readerNeedsWakeAfterPublish(
        writeOff,
        consumedOff,
        Atomics.load(meta, 7),
      );
      if (readerNeedsWake) wakeReader();
      return true;
    },
    releaseDeferred,
    beginPredictionLineage(): number {
      const lineage = predictionAdmission?.beginLineage() ?? 0;
      // A reader may be parked behind a candidate from the invalidated lineage.
      Atomics.notify(meta, 0);
      return lineage;
    },
    droppedCount(): number {
      return Atomics.load(meta, 2) >>> 0;
    },
    bufferedBytes(): number {
      return Atomics.load(meta, 5) >>> 0;
    },
    bufferedEntries(): number {
      return Atomics.load(meta, 6) >>> 0;
    },
  };
}

/**
 * The reader's view of the ring: entries addressed by ordinal.
 *
 * Every entry `tryReadNext` returns is HELD — its slot, its byte charge and its
 * entry charge stay with the reader — until `release` passes it. Ordinals are
 * monotonic for the reader's lifetime; the column arrays behind them are
 * indexed modulo `MAX_BUFFERED_INPUT_ENTRIES`, which the writer's entry cap
 * makes safe. The accessor trio `payloadLength` / `shadowModelled` /
 * `copyPayload` is the shape `@merkur/protocol`'s input-run encoder reads
 * from, so a run is encoded from the slots directly.
 */
export interface InputRingReader {
  /** Read the next published entry and return its ordinal, or -1 when none. */
  tryReadNext(): number;
  waitAsync(): Promise<void> | 'not-equal';
  /** The ordinal `tryReadNext` will assign next: the exclusive bound of what was read. */
  consumedOrdinal(): number;
  /** The oldest held ordinal: the exclusive bound of what was released. */
  releasedOrdinal(): number;
  localSeq(ordinal: number): number;
  payloadLength(ordinal: number): number;
  shadowModelled(ordinal: number): boolean;
  /** Whether the entry was written deferred (and has since been released). */
  deferred(ordinal: number): boolean;
  /** Whether `tryReadNext` would return an entry now. */
  hasReadable(): boolean;
  copyPayload(ordinal: number, destination: Uint8Array, destinationOffset: number): void;
  /**
   * Invalidate browser-model grants on every held entry at an authenticated
   * session boundary. Mutates the flags in place; no retry-path allocation.
   */
  revokeShadowProvenance(): void;
  /**
   * Release every held entry below `ordinal`: the daemon acknowledged them, or
   * the session that owned them ended. Their slots, byte charge and entry
   * charge return to the writer in one step.
   */
  release(ordinal: number): void;
  /** Drop every published-but-unread entry and release its admission charge. */
  discardQueuedEntries(): number;
}

export function createInputRingReader(
  sab: SharedArrayBuffer,
  waitTimeoutMs = INPUT_RING_WAIT_WATCHDOG_MS,
  predictionAdmissionSab?: SharedArrayBuffer,
  waitForReadableTask?: (watchdogMs: number) => Promise<void>,
): InputRingReader {
  const meta = new Int32Array(sab, 0, 8);
  const dataView = new DataView(sab, INPUT_RING_META_BYTES);
  const dataBytes = new Uint8Array(sab, INPUT_RING_META_BYTES);
  const predictionAdmission: PredictionAdmissionReader | null =
    predictionAdmissionSab === undefined
      ? null
      : createPredictionAdmissionReader(predictionAdmissionSab);
  // Reader-private columns, one row per held ordinal. Nothing here is shared
  // with the writer: the writer only ever sees the two cursors and the budget.
  const slotOffset = new Int32Array(MAX_BUFFERED_INPUT_ENTRIES);
  const slotLength = new Int32Array(MAX_BUFFERED_INPUT_ENTRIES);
  const slotSeq = new Uint32Array(MAX_BUFFERED_INPUT_ENTRIES);
  const slotFlags = new Uint8Array(MAX_BUFFERED_INPUT_ENTRIES);
  let consumed = 0;
  let released = 0;
  /**
   * Whether the entry at `entryOff` is deferred and not yet released. The
   * bound is monotonic, so this is one load and one compare, with no reader
   * state to keep in step with the writer's.
   */
  function isHeld(entryOff: number, encodedPayloadLen: number): boolean {
    if ((encodedPayloadLen & INPUT_ENTRY_DEFERRED_MASK) === 0) return false;
    const seq = dataView.getUint32(entryOff + 4, true);
    return seq > Atomics.load(meta, META_RELEASED_SEQ) >>> 0;
  }

  /** The head entry's offset, past any skip marker. */
  function headOffset(consumedOff: number): number {
    return dataView.getUint32(consumedOff, true) === INPUT_SKIP_MARKER ? 0 : consumedOff;
  }

  function assertHeld(ordinal: number): number {
    if (ordinal < released || ordinal >= consumed) {
      throw new RangeError(`input ring ordinal ${ordinal} is not held`);
    }
    return ordinal & ORDINAL_MASK;
  }

  function publishAckedOffset(consumedOff: number): void {
    Atomics.store(
      meta,
      1,
      released < consumed ? (slotOffset[released & ORDINAL_MASK] ?? 0) : consumedOff,
    );
  }

  return {
    tryReadNext(): number {
      let consumedOff = Atomics.load(meta, 7);
      const writeOff = Atomics.load(meta, 0);
      if (consumedOff === writeOff) return -1;

      let encodedPayloadLen = dataView.getUint32(consumedOff, true);
      if (encodedPayloadLen === INPUT_SKIP_MARKER) {
        consumedOff = 0;
        Atomics.store(meta, 7, 0);
        if (released === consumed) publishAckedOffset(0);
        if (consumedOff === writeOff) return -1;
        encodedPayloadLen = dataView.getUint32(consumedOff, true);
      }
      if (isHeld(consumedOff, encodedPayloadLen)) return -1;
      if (consumed - released >= MAX_BUFFERED_INPUT_ENTRIES) {
        throw new RangeError('input ring holds more entries than its ordinal columns');
      }

      const predictionCandidate = (encodedPayloadLen & INPUT_ENTRY_PREDICTION_CANDIDATE_MASK) !== 0;
      const payloadLen = encodedPayloadLen & INPUT_ENTRY_PAYLOAD_LEN_MASK;
      const seq = dataView.getUint32(consumedOff + 4, true);
      // Re-read rather than trusting the entry bit: the terminal worker may
      // have downgraded this grant after main published it. The verdict is
      // taken once, here, and carried through every retransmit of the entry.
      const shadowModelled =
        predictionCandidate && predictionAdmission?.status(seq) === PREDICTION_ADMISSION_ACCEPTED;

      const ordinal = consumed;
      const row = ordinal & ORDINAL_MASK;
      slotOffset[row] = consumedOff;
      slotLength[row] = payloadLen;
      slotSeq[row] = seq;
      slotFlags[row] =
        (shadowModelled ? FLAG_SHADOW_MODELLED : 0) |
        ((encodedPayloadLen & INPUT_ENTRY_DEFERRED_MASK) !== 0 ? FLAG_DEFERRED : 0);
      consumed = ordinal + 1;

      const slotSize = alignUp(INPUT_ENTRY_HEADER_BYTES + payloadLen, INPUT_ENTRY_ALIGN);
      Atomics.store(meta, 7, consumedOff + slotSize);
      return ordinal;
    },

    waitAsync(): Promise<void> | 'not-equal' {
      const writeOff = Atomics.load(meta, 0);
      const consumedOff = Atomics.load(meta, 7);
      // A published entry is readable unless it is deferred and unreleased;
      // then the release generation is the only thing to wait for.
      let word = 0;
      let expected = writeOff;
      if (consumedOff !== writeOff) {
        const head = headOffset(consumedOff);
        // Loaded before the check, so a release between the two is a changed
        // value to the wait rather than a lost notification.
        const releasedSeq = Atomics.load(meta, META_RELEASED_SEQ);
        if (head === writeOff || !isHeld(head, dataView.getUint32(head, true))) {
          return 'not-equal';
        }
        word = META_RELEASED_SEQ;
        expected = releasedSeq;
      }
      if (waitForReadableTask !== undefined) return waitForReadableTask(waitTimeoutMs);
      const result = Atomics.waitAsync(meta, word, expected, waitTimeoutMs);
      // The wait's own promise, not a `.then` over it: a park per keystroke
      // would otherwise mint a closure and a second promise only to drop the
      // 'ok' | 'timed-out' verdict every caller already ignores.
      if (result.async) return result.value as Promise<unknown> as Promise<void>;
      return 'not-equal';
    },

    consumedOrdinal(): number {
      return consumed;
    },

    releasedOrdinal(): number {
      return released;
    },

    localSeq(ordinal: number): number {
      return slotSeq[assertHeld(ordinal)] ?? 0;
    },

    payloadLength(ordinal: number): number {
      return slotLength[assertHeld(ordinal)] ?? 0;
    },

    shadowModelled(ordinal: number): boolean {
      return ((slotFlags[assertHeld(ordinal)] ?? 0) & FLAG_SHADOW_MODELLED) !== 0;
    },

    deferred(ordinal: number): boolean {
      return ((slotFlags[assertHeld(ordinal)] ?? 0) & FLAG_DEFERRED) !== 0;
    },

    hasReadable(): boolean {
      const consumedOff = Atomics.load(meta, 7);
      const writeOff = Atomics.load(meta, 0);
      if (consumedOff === writeOff) return false;
      const head = headOffset(consumedOff);
      return head !== writeOff && !isHeld(head, dataView.getUint32(head, true));
    },

    copyPayload(ordinal: number, destination: Uint8Array, destinationOffset: number): void {
      const row = assertHeld(ordinal);
      const start = (slotOffset[row] ?? 0) + INPUT_ENTRY_HEADER_BYTES;
      const length = slotLength[row] ?? 0;
      // `set` needs a source of exactly the payload's length. A subarray per
      // copy is one view per keystroke, which is what this ring exists to stop
      // minting; the payload is a handful of bytes, so copy them in place.
      for (let index = 0; index < length; index += 1) {
        destination[destinationOffset + index] = dataBytes[start + index] ?? 0;
      }
    },

    revokeShadowProvenance(): void {
      for (let ordinal = released; ordinal < consumed; ordinal += 1) {
        const row = ordinal & ORDINAL_MASK;
        slotFlags[row] = (slotFlags[row] ?? 0) & ~FLAG_SHADOW_MODELLED;
      }
    },

    release(ordinal: number): void {
      if (ordinal <= released) return;
      if (ordinal > consumed) {
        throw new RangeError(`input ring cannot release unread ordinal ${ordinal}`);
      }
      let bytes = 0;
      for (let held = released; held < ordinal; held += 1) {
        bytes += slotLength[held & ORDINAL_MASK] ?? 0;
      }
      const entries = ordinal - released;
      released = ordinal;
      // Move the writer's boundary before returning the charge: a producer
      // that sees the freed budget must also see the freed slots.
      publishAckedOffset(Atomics.load(meta, 7));
      atomicSaturatingSub(meta, 5, bytes);
      atomicSaturatingSub(meta, 6, entries);
    },

    discardQueuedEntries(): number {
      let discarded = 0;
      let consumedOff = Atomics.load(meta, 7);
      const writeOff = Atomics.load(meta, 0);
      while (consumedOff !== writeOff) {
        let encodedPayloadLen = dataView.getUint32(consumedOff, true);
        if (encodedPayloadLen === INPUT_SKIP_MARKER) {
          consumedOff = 0;
          if (consumedOff === writeOff) break;
          encodedPayloadLen = dataView.getUint32(consumedOff, true);
        }
        const payloadLen = encodedPayloadLen & INPUT_ENTRY_PAYLOAD_LEN_MASK;
        consumedOff += alignUp(INPUT_ENTRY_HEADER_BYTES + payloadLen, INPUT_ENTRY_ALIGN);
        atomicSaturatingSub(meta, 5, payloadLen);
        atomicSaturatingSub(meta, 6, 1);
        discarded += 1;
      }
      Atomics.store(meta, 7, consumedOff);
      publishAckedOffset(consumedOff);
      return discarded;
    },
  };
}

/** Directly wake a parked input reader after worker/page suspension. */
export function wakeInputRingReader(sab: SharedArrayBuffer): number {
  const meta = new Int32Array(sab, 0, 8);
  return Atomics.notify(meta, 0, 1) + Atomics.notify(meta, META_RELEASED_SEQ, 1);
}

function clampSharedCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(0x7fff_ffff, Math.floor(value));
}

function atomicSaturatingSub(meta: Int32Array, index: number, amount: number): void {
  const decrement = clampSharedCount(amount);
  for (;;) {
    const current = Atomics.load(meta, index);
    const next = Math.max(0, current - decrement);
    if (Atomics.compareExchange(meta, index, current, next) === current) return;
  }
}
