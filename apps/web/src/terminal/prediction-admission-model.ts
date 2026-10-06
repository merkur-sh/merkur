/** The terminal owner's published model ABI; arithmetic lives in merkur-client. */

/** A shadow line exists, its base matches authority, and the mode is safe. */
export const PREDICTION_MODEL_BASE_READY = 1 << 0;

export type LocalPredictionOp =
  | 'printable'
  | 'backspace'
  | 'delete'
  | 'cursor_left'
  | 'cursor_right';

export interface PredictionModelSnapshot {
  /** Terminal-worker armedness: epoch adopted, no display reset, no causal fence. */
  armed: boolean;
  /** `PREDICTION_MODEL_*` bits, as published by the WASM model. */
  flags: number;
  startCol: number;
  cursorCol: number;
  endCol: number;
  /** `MAX_SHADOW_OPS - ops.len()`, so the cap never has to be mirrored here. */
  opsRemaining: number;
  cols: number;
  /** Highest local input sequence the worker has already drained. */
  throughInputSeq: number;
}
