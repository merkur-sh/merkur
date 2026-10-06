/**
 * Allocation-free main-thread -> terminal-worker prediction command lane.
 *
 * The input producer publishes fixed-width commands into this SPSC ring. The
 * terminal worker drains them directly into the WASM prediction model and
 * publishes admission and visibility state in the same SAB. All terminal pixels
 * are worker-owned; this lane carries no presentation ACK or cursor image.
 */

import type { PredictionModelSnapshot } from './prediction-admission-model';

export const PREDICTION_COMMAND_PRINTABLE = 1;
export const PREDICTION_COMMAND_BACKSPACE = 2;
export const PREDICTION_COMMAND_DELETE = 3;
export const PREDICTION_COMMAND_CURSOR_SHIFT = 4;
export const PREDICTION_COMMAND_FLUSH = 5;

export type PredictionCommandKind =
  | typeof PREDICTION_COMMAND_PRINTABLE
  | typeof PREDICTION_COMMAND_BACKSPACE
  | typeof PREDICTION_COMMAND_DELETE
  | typeof PREDICTION_COMMAND_CURSOR_SHIFT
  | typeof PREDICTION_COMMAND_FLUSH;

const HEADER_WORDS = 20;
const HEADER_BYTES = HEADER_WORDS * Int32Array.BYTES_PER_ELEMENT;
const ENTRY_BYTES = 24;
export const PREDICTION_COMMAND_SLOTS = 4_096;
const PREDICTION_COMMAND_MASK = PREDICTION_COMMAND_SLOTS - 1;

const WRITE_INDEX_WORD = 0;
const READ_INDEX_WORD = 1;
const DROPPED_WORD = 2;
const OVERFLOW_COUNT_WORD = 3;
const OVERFLOW_SEQ_WORD = 4;
const REQUIRED_EPOCH_WORD = 5;
const ACTIVE_EPOCH_WORD = 6;
const VISIBLE_WORD = 7;
// Admission snapshot is independent of display/renderer completion.
const MODEL_VERSION_WORD = 8;
const MODEL_FLAGS_WORD = 9;
const MODEL_START_COL_WORD = 10;
const MODEL_CURSOR_COL_WORD = 11;
const MODEL_END_COL_WORD = 12;
const MODEL_OPS_REMAINING_WORD = 13;
const MODEL_COLS_WORD = 14;
const MODEL_THROUGH_SEQ_WORD = 15;
const PREVIEW_VERSION_WORD = 16;
const PREVIEW_MASK_WORD = 17;
const WAKE_WORD = 18;
export const PROVISIONAL_PREVIEW_SLOTS = 10;
const PREVIEW_ENTRY_BYTES = 24;
const PREVIEW_OFFSET = HEADER_BYTES + PREDICTION_COMMAND_SLOTS * ENTRY_BYTES;

/** Borrowed stable snapshot, overwritten on the next drain; never retain its arrays. */
export interface ProvisionalPreviewSnapshot {
  readonly activeMask: number;
  readonly pointers: Float64Array;
  readonly codepoints: Uint32Array;
  readonly epochs: Uint32Array;
  readonly modelVersions: Uint32Array;
}

/** The terminal worker is armed: epoch adopted, no display reset, no causal fence. */
const MODEL_ARMED = 1 << 30;

const MAX_EPOCH = 0x7fff_ffff;

const ENTRY_SEQ_OFFSET = 0;
const ENTRY_KIND_OFFSET = 4;
const ENTRY_VALUE_OFFSET = 8;
// Bytes 12..16 are the alignment padding the f64 below already required, so
// this field costs no bytes and no extra cache line — one store into a line
// the write is touching anyway.
const ENTRY_FLAGS_OFFSET = 12;
const ENTRY_SENT_AT_OFFSET = 16;

/**
 * Main considered this op displayable when it wrote it.
 *
 * The visibility gate is an *admission* decision taken once per speculative
 * line, and only a printable can seed one — so this rides on printables and is
 * clear on every other command, which inherit their line's decision. It carries
 * the visibility admission main actually made. The worker is the only painter;
 * this remains a line-admission decision, not a later gate re-evaluation.
 */
const ENTRY_FLAG_VISIBLE = 1 << 0;

export const PREDICTION_FAST_PATH_SIZE =
  PREVIEW_OFFSET + PROVISIONAL_PREVIEW_SLOTS * PREVIEW_ENTRY_BYTES;

export interface PredictionFastPathWriter {
  /** Fence old commands before an authenticated terminal epoch changes. */
  beginEpoch(): number;
  epochReady(): boolean;
  writePrintable(inputSeq: number, codepoint: number, sentAtMs: number, visible: boolean): boolean;
  writeBackspace(inputSeq: number, sentAtMs: number): boolean;
  writeDelete(inputSeq: number, sentAtMs: number): boolean;
  writeCursorShift(inputSeq: number, delta: -1 | 1, sentAtMs: number): boolean;
  writeFlush(inputSeq?: number): boolean;
  /** Latest UNSENT pointer set, independent of command/input sequence admission. */
  writeProvisional(
    pointerId: number,
    codepoint: number | null,
    epoch: number,
    modelVersion: number,
  ): boolean;
  wake(): void;
  droppedCount(): number;
}

export interface PredictionFastStateReader {
  epochReady(): boolean;
  activeEpoch(): number;
  visible(): boolean;
  /**
   * Torn-free read of the admission model. Returns the seqlock version, or 0
   * when the snapshot could not be read consistently — which denies the
   * provenance bit rather than guessing at a half-published model.
   */
  readModelInto(target: PredictionModelSnapshot): number;
  /** Same seqlock, copied directly into the Rust capture owner's seven words. */
  readModelWordsInto(target: Uint32Array): number;
}

export type PredictionCommandVisitor = (
  kind: PredictionCommandKind,
  inputSeq: number,
  value: number,
  sentAtMs: number,
  visible: boolean,
) => void;

export interface PredictionFastPathConsumer {
  epochReady(): boolean;
  /** Exact published admission seqlock, used to reject stale pointer previews. */
  modelVersion(): number;
  /** Fresh authority with identical model words still invalidates queued previews. */
  invalidateModelRevision(): void;
  /**
   * Discard commands from the prior epoch, then publish the required epoch as
   * active. `onDiscarded` lets the worker fail their admission slots closed.
   */
  adoptRequiredEpoch(onDiscarded?: (inputSeq: number) => void): number;
  drain(limit: number, visitor: PredictionCommandVisitor): number;
  discardPending(onDiscarded?: (inputSeq: number) => void): number;
  pendingCount(): number;
  previewsPending(): boolean;
  drainProvisionalPreviews(visitor: (snapshot: ProvisionalPreviewSnapshot) => void): boolean;
  takeOverflowInputSeq(): number | null;
  waitAsync(timeoutMs?: number): Promise<void> | 'not-equal';
  wake(): void;
  publishVisible(visible: boolean): void;
  /**
   * Publish the model's admission bounds. Called after every drained command
   * batch and every authoritative apply, so main's synchronous decision reads
   * the newest model the worker has actually reached.
   */
  publishModel(
    armed: boolean,
    flags: number,
    startCol: number,
    cursorCol: number,
    endCol: number,
    opsRemaining: number,
    cols: number,
    throughInputSeq: number,
  ): void;
  resetPublishedState(): void;
}

export function createPredictionFastPathBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(PREDICTION_FAST_PATH_SIZE);
}

export function createPredictionFastPathWriter(sab: SharedArrayBuffer): PredictionFastPathWriter {
  const { words, view } = fastPathViews(sab);

  function writeProvisional(
    pointerId: number,
    codepoint: number | null,
    epoch: number,
    modelVersion: number,
  ): boolean {
    if (
      !Number.isSafeInteger(pointerId) ||
      pointerId < 0 ||
      !validInputSeq(epoch) ||
      epoch !== Atomics.load(words, ACTIVE_EPOCH_WORD) ||
      !epochReady(words)
    )
      return false;
    if (
      codepoint !== null &&
      (!Number.isInteger(codepoint) ||
        codepoint < 0x20 ||
        codepoint > 0x7e ||
        !validInputSeq(modelVersion) ||
        (modelVersion & 1) !== 0)
    )
      return false;
    const mask = Atomics.load(words, PREVIEW_MASK_WORD);
    let index = -1;
    let empty = -1;
    for (let slot = 0; slot < PROVISIONAL_PREVIEW_SLOTS; slot++) {
      if ((mask & (1 << slot)) === 0) {
        if (empty < 0) empty = slot;
      } else if (view.getFloat64(PREVIEW_OFFSET + slot * PREVIEW_ENTRY_BYTES, true) === pointerId)
        index = slot;
    }
    if (index < 0) {
      if (codepoint === null) return true;
      if (empty < 0) return false;
      index = empty;
    }
    const base = PREVIEW_OFFSET + index * PREVIEW_ENTRY_BYTES;
    Atomics.add(words, PREVIEW_VERSION_WORD, 1);
    if (codepoint === null) {
      // Erase the retired slot, not a queue of pointer-clear tombstones.
      for (let offset = 0; offset < PREVIEW_ENTRY_BYTES; offset += 4)
        view.setUint32(base + offset, 0, true);
      Atomics.store(words, PREVIEW_MASK_WORD, mask & ~(1 << index));
    } else {
      view.setFloat64(base, pointerId, true);
      view.setUint32(base + 8, codepoint, true);
      view.setUint32(base + 12, epoch, true);
      view.setUint32(base + 16, modelVersion, true);
      Atomics.store(words, PREVIEW_MASK_WORD, mask | (1 << index));
    }
    Atomics.add(words, PREVIEW_VERSION_WORD, 1);
    signalWake(words);
    return true;
  }

  function write(
    kind: PredictionCommandKind,
    inputSeq: number,
    value: number,
    sentAtMs: number,
    visible: boolean,
  ): boolean {
    if (!validCommand(kind, inputSeq, value, sentAtMs)) return false;
    if (!epochReady(words)) return false;

    const writeIndex = Atomics.load(words, WRITE_INDEX_WORD) & PREDICTION_COMMAND_MASK;
    const nextIndex = (writeIndex + 1) & PREDICTION_COMMAND_MASK;
    const readIndex = Atomics.load(words, READ_INDEX_WORD) & PREDICTION_COMMAND_MASK;
    if (nextIndex === readIndex) {
      Atomics.add(words, DROPPED_WORD, 1);
      Atomics.store(words, OVERFLOW_SEQ_WORD, inputSeq | 0);
      Atomics.add(words, OVERFLOW_COUNT_WORD, 1);
      signalWake(words);
      return false;
    }

    const base = HEADER_BYTES + writeIndex * ENTRY_BYTES;
    view.setUint32(base + ENTRY_SEQ_OFFSET, inputSeq >>> 0, true);
    view.setUint32(base + ENTRY_KIND_OFFSET, kind, true);
    view.setInt32(base + ENTRY_VALUE_OFFSET, value | 0, true);
    view.setUint32(base + ENTRY_FLAGS_OFFSET, visible ? ENTRY_FLAG_VISIBLE : 0, true);
    view.setFloat64(base + ENTRY_SENT_AT_OFFSET, sentAtMs, true);

    // Release-publish only after every non-atomic entry field is complete.
    Atomics.store(words, WRITE_INDEX_WORD, nextIndex);
    signalWake(words);
    return true;
  }

  return {
    beginEpoch(): number {
      for (;;) {
        const current = Atomics.load(words, REQUIRED_EPOCH_WORD);
        const next = current <= 0 || current >= MAX_EPOCH ? 1 : current + 1;
        if (Atomics.compareExchange(words, REQUIRED_EPOCH_WORD, current, next) !== current) {
          continue;
        }
        Atomics.add(words, PREVIEW_VERSION_WORD, 1);
        Atomics.store(words, PREVIEW_MASK_WORD, 0);
        for (let offset = PREVIEW_OFFSET; offset < PREDICTION_FAST_PATH_SIZE; offset += 4)
          view.setUint32(offset, 0, true);
        Atomics.add(words, PREVIEW_VERSION_WORD, 1);
        signalWake(words);
        return next;
      }
    },
    epochReady(): boolean {
      return epochReady(words);
    },
    writePrintable(inputSeq, codepoint, sentAtMs, visible): boolean {
      return write(PREDICTION_COMMAND_PRINTABLE, inputSeq, codepoint, sentAtMs, visible);
    },
    writeBackspace(inputSeq, sentAtMs): boolean {
      return write(PREDICTION_COMMAND_BACKSPACE, inputSeq, 0, sentAtMs, false);
    },
    writeDelete(inputSeq, sentAtMs): boolean {
      return write(PREDICTION_COMMAND_DELETE, inputSeq, 0, sentAtMs, false);
    },
    writeCursorShift(inputSeq, delta, sentAtMs): boolean {
      return write(PREDICTION_COMMAND_CURSOR_SHIFT, inputSeq, delta, sentAtMs, false);
    },
    writeFlush(inputSeq = 0): boolean {
      return write(PREDICTION_COMMAND_FLUSH, inputSeq, 0, 0, false);
    },
    writeProvisional,
    wake(): void {
      signalWake(words);
    },
    droppedCount(): number {
      return Atomics.load(words, DROPPED_WORD) >>> 0;
    },
  };
}

export function createPredictionFastStateReader(sab: SharedArrayBuffer): PredictionFastStateReader {
  const { words } = fastPathViews(sab);
  return {
    readModelWordsInto(target): number {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const before = Atomics.load(words, MODEL_VERSION_WORD);
        if ((before & 1) !== 0) continue;
        target[0] = Atomics.load(words, MODEL_FLAGS_WORD);
        target[1] = Atomics.load(words, MODEL_START_COL_WORD);
        target[2] = Atomics.load(words, MODEL_CURSOR_COL_WORD);
        target[3] = Atomics.load(words, MODEL_END_COL_WORD);
        target[4] = Atomics.load(words, MODEL_OPS_REMAINING_WORD);
        target[5] = Atomics.load(words, MODEL_COLS_WORD);
        target[6] = Atomics.load(words, MODEL_THROUGH_SEQ_WORD);
        const after = Atomics.load(words, MODEL_VERSION_WORD);
        if (before === after && (after & 1) === 0) return before >>> 0;
      }
      return 0;
    },
    epochReady(): boolean {
      return epochReady(words);
    },
    activeEpoch(): number {
      return Math.max(0, Atomics.load(words, ACTIVE_EPOCH_WORD));
    },
    visible(): boolean {
      return epochReady(words) && Atomics.load(words, VISIBLE_WORD) === 1;
    },
    readModelInto(target): number {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const before = Atomics.load(words, MODEL_VERSION_WORD);
        if ((before & 1) !== 0) continue;
        const flags = Atomics.load(words, MODEL_FLAGS_WORD);
        const startCol = Atomics.load(words, MODEL_START_COL_WORD);
        const cursorCol = Atomics.load(words, MODEL_CURSOR_COL_WORD);
        const endCol = Atomics.load(words, MODEL_END_COL_WORD);
        const opsRemaining = Atomics.load(words, MODEL_OPS_REMAINING_WORD);
        const cols = Atomics.load(words, MODEL_COLS_WORD);
        const throughInputSeq = Atomics.load(words, MODEL_THROUGH_SEQ_WORD) >>> 0;
        const after = Atomics.load(words, MODEL_VERSION_WORD);
        if (before !== after || (after & 1) !== 0) continue;
        target.armed = (flags & MODEL_ARMED) !== 0;
        target.flags = flags & ~MODEL_ARMED;
        target.startCol = startCol;
        target.cursorCol = cursorCol;
        target.endCol = endCol;
        target.opsRemaining = opsRemaining;
        target.cols = cols;
        target.throughInputSeq = throughInputSeq;
        return before >>> 0;
      }
      return 0;
    },
  };
}

export function createPredictionFastPathConsumer(
  sab: SharedArrayBuffer,
): PredictionFastPathConsumer {
  const { words, view } = fastPathViews(sab);
  let consumedPreviewVersion = 0;
  const previewSnapshot = {
    activeMask: 0,
    pointers: new Float64Array(PROVISIONAL_PREVIEW_SLOTS),
    codepoints: new Uint32Array(PROVISIONAL_PREVIEW_SLOTS),
    epochs: new Uint32Array(PROVISIONAL_PREVIEW_SLOTS),
    modelVersions: new Uint32Array(PROVISIONAL_PREVIEW_SLOTS),
  };
  function previewsPending(): boolean {
    return Atomics.load(words, PREVIEW_VERSION_WORD) !== consumedPreviewVersion;
  }

  function discardPending(onDiscarded?: (inputSeq: number) => void): number {
    let readIndex = Atomics.load(words, READ_INDEX_WORD) & PREDICTION_COMMAND_MASK;
    const writeIndex = Atomics.load(words, WRITE_INDEX_WORD) & PREDICTION_COMMAND_MASK;
    let discarded = 0;
    while (readIndex !== writeIndex) {
      const base = HEADER_BYTES + readIndex * ENTRY_BYTES;
      const inputSeq = view.getUint32(base + ENTRY_SEQ_OFFSET, true);
      if (inputSeq > 0) onDiscarded?.(inputSeq);
      readIndex = (readIndex + 1) & PREDICTION_COMMAND_MASK;
      discarded += 1;
    }
    Atomics.store(words, READ_INDEX_WORD, readIndex);
    return discarded;
  }

  function resetPublishedState(): void {
    Atomics.store(words, VISIBLE_WORD, 0);
    // Disarmed with a zeroed model: main denies the provenance bit until the
    // worker republishes from the adopted epoch.
    publishModel(words, false, 0, 0, 0, 0, 0, 0, 0);
  }

  return {
    epochReady(): boolean {
      return epochReady(words);
    },
    adoptRequiredEpoch(onDiscarded): number {
      discardPending(onDiscarded);
      Atomics.store(words, OVERFLOW_COUNT_WORD, 0);
      Atomics.store(words, OVERFLOW_SEQ_WORD, 0);
      resetPublishedState();
      const required = Math.max(0, Atomics.load(words, REQUIRED_EPOCH_WORD));
      Atomics.store(words, ACTIVE_EPOCH_WORD, required);
      return required;
    },
    modelVersion(): number {
      return Atomics.load(words, MODEL_VERSION_WORD) >>> 0;
    },
    invalidateModelRevision(): void {
      Atomics.add(words, MODEL_VERSION_WORD, 2);
    },
    drain(limit, visitor): number {
      if (!Number.isSafeInteger(limit) || limit <= 0 || !epochReady(words)) return 0;
      let readIndex = Atomics.load(words, READ_INDEX_WORD) & PREDICTION_COMMAND_MASK;
      const writeIndex = Atomics.load(words, WRITE_INDEX_WORD) & PREDICTION_COMMAND_MASK;
      let processed = 0;
      while (readIndex !== writeIndex && processed < limit) {
        const base = HEADER_BYTES + readIndex * ENTRY_BYTES;
        const inputSeq = view.getUint32(base + ENTRY_SEQ_OFFSET, true);
        const kind = view.getUint32(base + ENTRY_KIND_OFFSET, true) as PredictionCommandKind;
        const value = view.getInt32(base + ENTRY_VALUE_OFFSET, true);
        const flags = view.getUint32(base + ENTRY_FLAGS_OFFSET, true);
        const sentAtMs = view.getFloat64(base + ENTRY_SENT_AT_OFFSET, true);
        readIndex = (readIndex + 1) & PREDICTION_COMMAND_MASK;
        Atomics.store(words, READ_INDEX_WORD, readIndex);
        if (validCommand(kind, inputSeq, value, sentAtMs)) {
          visitor(kind, inputSeq, value, sentAtMs, (flags & ENTRY_FLAG_VISIBLE) !== 0);
        }
        processed += 1;
      }
      return processed;
    },
    discardPending,
    pendingCount(): number {
      const writeIndex = Atomics.load(words, WRITE_INDEX_WORD) & PREDICTION_COMMAND_MASK;
      const readIndex = Atomics.load(words, READ_INDEX_WORD) & PREDICTION_COMMAND_MASK;
      return (writeIndex - readIndex + PREDICTION_COMMAND_SLOTS) & PREDICTION_COMMAND_MASK;
    },
    previewsPending,
    drainProvisionalPreviews(visitor): boolean {
      if (!epochReady(words)) return false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const before = Atomics.load(words, PREVIEW_VERSION_WORD);
        if (before === consumedPreviewVersion) return false;
        if ((before & 1) !== 0) continue;
        const mask = Atomics.load(words, PREVIEW_MASK_WORD);
        for (let slot = 0; slot < PROVISIONAL_PREVIEW_SLOTS; slot++) {
          const base = PREVIEW_OFFSET + slot * PREVIEW_ENTRY_BYTES;
          previewSnapshot.pointers[slot] = view.getFloat64(base, true);
          previewSnapshot.codepoints[slot] = view.getUint32(base + 8, true);
          previewSnapshot.epochs[slot] = view.getUint32(base + 12, true);
          previewSnapshot.modelVersions[slot] = view.getUint32(base + 16, true);
        }
        if (before !== Atomics.load(words, PREVIEW_VERSION_WORD) || !epochReady(words)) continue;
        previewSnapshot.activeMask = mask & ((1 << PROVISIONAL_PREVIEW_SLOTS) - 1);
        consumedPreviewVersion = before;
        visitor(previewSnapshot);
        return true;
      }
      return false;
    },
    takeOverflowInputSeq(): number | null {
      if (Atomics.exchange(words, OVERFLOW_COUNT_WORD, 0) === 0) return null;
      return Atomics.exchange(words, OVERFLOW_SEQ_WORD, 0) >>> 0;
    },
    waitAsync(timeoutMs = 30_000): Promise<void> | 'not-equal' {
      if (!epochReady(words)) return 'not-equal';
      // Sample before testing work: every publication changes this value, so a
      // preview/overflow arriving between the checks and wait cannot lose a wake.
      const wakeVersion = Atomics.load(words, WAKE_WORD);
      const writeIndex = Atomics.load(words, WRITE_INDEX_WORD);
      if (
        writeIndex !== Atomics.load(words, READ_INDEX_WORD) ||
        previewsPending() ||
        Atomics.load(words, OVERFLOW_COUNT_WORD) !== 0
      ) {
        return 'not-equal';
      }
      const result = Atomics.waitAsync(words, WAKE_WORD, wakeVersion, Math.max(0, timeoutMs));
      if (!result.async) return 'not-equal';
      // The wait's own promise: callers only await it, never read its verdict.
      return result.value as Promise<unknown> as Promise<void>;
    },
    wake(): void {
      signalWake(words);
    },
    publishVisible(visible): void {
      Atomics.store(words, VISIBLE_WORD, visible ? 1 : 0);
    },
    publishModel(
      armed,
      flags,
      startCol,
      cursorCol,
      endCol,
      opsRemaining,
      cols,
      throughInputSeq,
    ): void {
      publishModel(
        words,
        armed,
        flags,
        startCol,
        cursorCol,
        endCol,
        opsRemaining,
        cols,
        throughInputSeq,
      );
    },
    resetPublishedState,
  };
}

function fastPathViews(sab: SharedArrayBuffer): {
  readonly words: Int32Array;
  readonly view: DataView;
} {
  if (sab.byteLength !== PREDICTION_FAST_PATH_SIZE) {
    throw new RangeError(`prediction fast-path buffer must be ${PREDICTION_FAST_PATH_SIZE} bytes`);
  }
  return { words: new Int32Array(sab, 0, HEADER_WORDS), view: new DataView(sab) };
}

function epochReady(words: Int32Array): boolean {
  const required = Atomics.load(words, REQUIRED_EPOCH_WORD);
  return required > 0 && Atomics.load(words, ACTIVE_EPOCH_WORD) === required;
}

function signalWake(words: Int32Array): void {
  Atomics.add(words, WAKE_WORD, 1);
  Atomics.notify(words, WAKE_WORD);
}

function publishModel(
  words: Int32Array,
  armed: boolean,
  flags: number,
  startCol: number,
  cursorCol: number,
  endCol: number,
  opsRemaining: number,
  cols: number,
  throughInputSeq: number,
): void {
  const modelFlags = (flags & ~MODEL_ARMED) | (armed ? MODEL_ARMED : 0);
  startCol = Math.max(0, startCol) | 0;
  cursorCol = Math.max(0, cursorCol) | 0;
  endCol = Math.max(0, endCol) | 0;
  opsRemaining = Math.max(0, opsRemaining) | 0;
  cols = Math.max(0, cols) | 0;
  throughInputSeq |= 0;
  // One worker owns publication. Re-rendering an unchanged model must not
  // invalidate an unsent pointer preview of that exact model. Epoch changes
  // remain a separate admission boundary; fresh authority clears previews at
  // the worker boundary even when these model words happen to be identical.
  if (
    Atomics.load(words, MODEL_VERSION_WORD) !== 0 &&
    Atomics.load(words, MODEL_FLAGS_WORD) === modelFlags &&
    Atomics.load(words, MODEL_START_COL_WORD) === startCol &&
    Atomics.load(words, MODEL_CURSOR_COL_WORD) === cursorCol &&
    Atomics.load(words, MODEL_END_COL_WORD) === endCol &&
    Atomics.load(words, MODEL_OPS_REMAINING_WORD) === opsRemaining &&
    Atomics.load(words, MODEL_COLS_WORD) === cols &&
    Atomics.load(words, MODEL_THROUGH_SEQ_WORD) === throughInputSeq
  )
    return;
  Atomics.add(words, MODEL_VERSION_WORD, 1);
  Atomics.store(words, MODEL_FLAGS_WORD, modelFlags);
  Atomics.store(words, MODEL_START_COL_WORD, startCol);
  Atomics.store(words, MODEL_CURSOR_COL_WORD, cursorCol);
  Atomics.store(words, MODEL_END_COL_WORD, endCol);
  Atomics.store(words, MODEL_OPS_REMAINING_WORD, opsRemaining);
  Atomics.store(words, MODEL_COLS_WORD, cols);
  Atomics.store(words, MODEL_THROUGH_SEQ_WORD, throughInputSeq);
  Atomics.add(words, MODEL_VERSION_WORD, 1);
}

function validCommand(
  kind: number,
  inputSeq: number,
  value: number,
  sentAtMs: number,
): kind is PredictionCommandKind {
  if (kind === PREDICTION_COMMAND_FLUSH) return inputSeq === 0 || validInputSeq(inputSeq);
  if (!validInputSeq(inputSeq) || !Number.isFinite(sentAtMs) || sentAtMs < 0) return false;
  if (kind === PREDICTION_COMMAND_PRINTABLE) return predictableCodepoint(value);
  if (kind === PREDICTION_COMMAND_CURSOR_SHIFT) return value === -1 || value === 1;
  return kind === PREDICTION_COMMAND_BACKSPACE || kind === PREDICTION_COMMAND_DELETE;
}

function validInputSeq(inputSeq: number): boolean {
  return Number.isSafeInteger(inputSeq) && inputSeq > 0 && inputSeq <= 0xffff_ffff;
}

function predictableCodepoint(codepoint: number): boolean {
  if (!Number.isSafeInteger(codepoint)) return false;
  if (codepoint >= 0x20 && codepoint <= 0x7e) return true;
  if (codepoint < 0xa0 || codepoint > 0x2aff) return false;
  if (codepoint >= 0x300 && codepoint <= 0x36f) return false;
  if (codepoint >= 0x1ab0 && codepoint <= 0x1aff) return false;
  if (codepoint >= 0x1dc0 && codepoint <= 0x1dff) return false;
  if (codepoint >= 0x20d0 && codepoint <= 0x20ff) return false;
  return codepoint < 0x1100 || codepoint > 0x11ff;
}
