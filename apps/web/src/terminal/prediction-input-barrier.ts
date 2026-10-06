import { advanceInputSequence, inputSequenceAdvances } from '../transport/input-sequence-domain';

const MAX_INPUT_SEQUENCE = 0xffff_ffff;

export interface PredictionInputBarrier {
  /**
   * Predictions derived after this unmodelled input would start from a stale
   * cursor/grid. Keep the barrier open through at least this local sequence.
   */
  openThrough(inputSeq: number): void;
  /**
   * Returns true while prediction must be rejected. A rejected newer input
   * extends the barrier so prediction cannot restart in the middle of an
   * unmodelled run.
   */
  rejectIfOpen(inputSeq: number): boolean;
  /** Close only after authoritative display covers every rejected input. */
  observeAuthoritative(inputSeq: number): void;
  reset(): void;
  highWater(): number;
}

/**
 * Constant-space causal fence between non-predictable input and local echo.
 *
 * Flushing speculative glyphs is not enough: predicting the following key
 * against the pre-flush cursor fabricates a mismatch. The worker must wait
 * until authoritative display catches the whole unmodelled prefix.
 */
export function createPredictionInputBarrier(): PredictionInputBarrier {
  let highWater = 0;

  function valid(inputSeq: number): boolean {
    return Number.isSafeInteger(inputSeq) && inputSeq > 0 && inputSeq <= MAX_INPUT_SEQUENCE;
  }

  return {
    openThrough(inputSeq): void {
      if (valid(inputSeq)) highWater = advanceInputSequence(highWater, inputSeq);
    },
    rejectIfOpen(inputSeq): boolean {
      if (highWater === 0) return false;
      if (valid(inputSeq)) highWater = advanceInputSequence(highWater, inputSeq);
      return true;
    },
    observeAuthoritative(inputSeq): void {
      if (
        highWater !== 0 &&
        valid(inputSeq) &&
        (inputSeq === highWater || inputSequenceAdvances(highWater, inputSeq))
      ) {
        highWater = 0;
      }
    },
    reset(): void {
      highWater = 0;
    },
    highWater(): number {
      return highWater;
    },
  };
}
