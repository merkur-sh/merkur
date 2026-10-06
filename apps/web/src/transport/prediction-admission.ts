/**
 * Fixed shared admission ledger for wire-level shadow provenance.
 *
 * The verdict is main's, and it is synchronous. Main mirrors the WASM model's
 * admission arithmetic (`terminal/prediction-admission-model.ts`) at keystroke
 * time and publishes ACCEPTED or REJECTED before the input-ring entry becomes
 * visible, so the transport worker always reads a decided slot and never parks
 * waiting for the terminal worker.
 *
 * There is deliberately no pending state. The terminal worker keeps one power:
 * it may DOWNGRADE an accepted grant it then refuses, which is a pure safety
 * valve for the narrow window in which authority invalidated the model base
 * between main's snapshot read and the worker's execution. It can never
 * upgrade, so a keystroke's provenance is only ever weakened after the fact.
 *
 * No per-input object or Map is created: all coordination is bounded atomics.
 */

export const PREDICTION_ADMISSION_SLOTS = 4_096;

const HEADER_WORDS = 1;
const SLOT_WORDS = 3;
const REQUIRED_LINEAGE_WORD = 0;
const SLOT_SEQ_WORD = 0;
const SLOT_LINEAGE_WORD = 1;
const SLOT_STATE_WORD = 2;

const STATE_ACCEPTED = 2;
const STATE_REJECTED = 3;
const MAX_LINEAGE = 0x7fff_ffff;

export const PREDICTION_ADMISSION_REJECTED = 0;
export const PREDICTION_ADMISSION_ACCEPTED = 1;

export const PREDICTION_ADMISSION_SIZE =
  (HEADER_WORDS + PREDICTION_ADMISSION_SLOTS * SLOT_WORDS) * Int32Array.BYTES_PER_ELEMENT;

export interface PredictionAdmissionCoordinator {
  /** Rotate the required authenticated display lineage and invalidate older grants. */
  beginLineage(): number;
  /**
   * Publish main's verdict for one input before its ring entry is visible.
   * Returns false when the ledger is not usable (no lineage yet), which the
   * caller must treat as a denial.
   */
  publish(inputSeq: number, admitted: boolean): boolean;
}

export interface PredictionAdmissionResolver {
  /**
   * Downgrade one accepted grant the speculative model then refused.
   * Returns true only when an accepted grant was actually withdrawn, which is
   * the exact divergence signal the worker counts.
   */
  reject(inputSeq: number): boolean;
}

export interface PredictionAdmissionReader {
  status(inputSeq: number): 0 | 1;
}

export function createPredictionAdmissionBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(PREDICTION_ADMISSION_SIZE);
}

export function createPredictionAdmissionCoordinator(
  sab: SharedArrayBuffer,
): PredictionAdmissionCoordinator {
  const words = admissionWords(sab);

  return {
    beginLineage(): number {
      for (;;) {
        const current = Atomics.load(words, REQUIRED_LINEAGE_WORD);
        const next = current >= MAX_LINEAGE || current <= 0 ? 1 : current + 1;
        if (Atomics.compareExchange(words, REQUIRED_LINEAGE_WORD, current, next) !== current) {
          continue;
        }
        return next;
      }
    },

    publish(inputSeq, admitted): boolean {
      if (!isInputSeq(inputSeq)) return false;
      const lineage = Atomics.load(words, REQUIRED_LINEAGE_WORD);
      if (lineage <= 0) return false;
      const base = slotBase(inputSeq);
      // Invalidate the old modulo-slot grant before publishing this identity,
      // so a reader that observes the new sequence can never pair it with the
      // previous occupant's verdict.
      Atomics.store(words, base + SLOT_STATE_WORD, STATE_REJECTED);
      Atomics.store(words, base + SLOT_SEQ_WORD, inputSeq | 0);
      Atomics.store(words, base + SLOT_LINEAGE_WORD, lineage);
      if (admitted) Atomics.store(words, base + SLOT_STATE_WORD, STATE_ACCEPTED);
      return admitted;
    },
  };
}

export function createPredictionAdmissionResolver(
  sab: SharedArrayBuffer,
): PredictionAdmissionResolver {
  const words = admissionWords(sab);

  return {
    reject(inputSeq): boolean {
      if (!isInputSeq(inputSeq)) return false;
      const base = slotBase(inputSeq);
      if (Atomics.load(words, base + SLOT_SEQ_WORD) >>> 0 !== inputSeq) return false;
      return (
        Atomics.compareExchange(words, base + SLOT_STATE_WORD, STATE_ACCEPTED, STATE_REJECTED) ===
        STATE_ACCEPTED
      );
    },
  };
}

export function createPredictionAdmissionReader(sab: SharedArrayBuffer): PredictionAdmissionReader {
  const words = admissionWords(sab);

  return {
    status(inputSeq): 0 | 1 {
      if (!isInputSeq(inputSeq)) return PREDICTION_ADMISSION_REJECTED;
      const base = slotBase(inputSeq);
      if (Atomics.load(words, base + SLOT_SEQ_WORD) >>> 0 !== inputSeq) {
        return PREDICTION_ADMISSION_REJECTED;
      }
      const candidateLineage = Atomics.load(words, base + SLOT_LINEAGE_WORD);
      if (
        candidateLineage <= 0 ||
        candidateLineage !== Atomics.load(words, REQUIRED_LINEAGE_WORD)
      ) {
        return PREDICTION_ADMISSION_REJECTED;
      }
      return Atomics.load(words, base + SLOT_STATE_WORD) === STATE_ACCEPTED
        ? PREDICTION_ADMISSION_ACCEPTED
        : PREDICTION_ADMISSION_REJECTED;
    },
  };
}

function admissionWords(sab: SharedArrayBuffer): Int32Array {
  if (sab.byteLength !== PREDICTION_ADMISSION_SIZE) {
    throw new RangeError(`prediction admission buffer must be ${PREDICTION_ADMISSION_SIZE} bytes`);
  }
  return new Int32Array(sab);
}

function isInputSeq(inputSeq: number): boolean {
  return Number.isSafeInteger(inputSeq) && inputSeq > 0 && inputSeq <= 0xffff_ffff;
}

function slotBase(inputSeq: number): number {
  return HEADER_WORDS + ((inputSeq - 1) & (PREDICTION_ADMISSION_SLOTS - 1)) * SLOT_WORDS;
}
