import { terminalModeAllowsPrediction } from '@merkur/shared';

const MAX_INPUT_SEQUENCE = 0xffff_ffff;

/**
 * Exact synchronous gate for granting wire-level shadow provenance.
 *
 * This mirrors the WASM model's cheap preconditions that main already knows.
 * The daemon treats a true bit as a capability, so an uninitialized mode, a
 * hidden authoritative cursor, an active preedit, mouse tracking, or a future
 * unknown mode must fail closed before the input ring is published.
 *
 * The mode half is `terminalModeAllowsPrediction`, shared with the terminal
 * worker and pinned to `prediction_mode_is_unsafe` in
 * `packages/term-wasm/src/lib.rs`. It used to be a local copy of the mask that
 * still vetoed the alternate screen after the Rust model and the worker had
 * both dropped it — and because this is the copy the input path consults,
 * speculative echo stayed disarmed under tmux and every other full-screen
 * application while the code read as though it had been fixed.
 */
export function isShadowModelInputSafe(
  mode: number,
  authoritativeCursorVisible: boolean,
  preeditActive: boolean,
): boolean {
  return terminalModeAllowsPrediction(mode) && authoritativeCursorVisible && !preeditActive;
}

/**
 * Whether hidden predictions may become visible: the causal base is
 * authoritative, the mode is safe, and the bounded trust window has enough
 * consecutive, high-ratio confirmations. Nothing measured enters this.
 *
 * It used to compare a smoothed path RTT against a measured local paint
 * latency, on the theory that an echo landing inside the same perceptual
 * envelope as the prediction is not worth showing. Both terms were estimates
 * and the comparison had no hysteresis, so on a 56 ms path against a local p90
 * that a single stalled fence could drag to 80–100 ms the gate flipped
 * visible/learning on RTT noise 70 times in a minute (2026-09-07), and every
 * line that happened to start while it read `learning` was typed dark. The
 * prediction render a fast path cannot use costs one frame of worker time and
 * paints the same glyph the echo paints; the flapping was the visible defect.
 */
export interface PredictionDisplayInput {
  /**
   * False while the causal base is not authoritative or the terminal mode is
   * unsafe. There is deliberately no timed arm here: withdrawal is owned by an
   * exact grid mismatch and re-entry by counted confirmations.
   */
  readonly allowed: boolean;
  /** The bounded recent window has enough consecutive, high-ratio confirmations. */
  readonly trustReady: boolean;
}

export type PredictionModelAdmission = 'model' | 'reject_epoch' | 'reject_causal';

/**
 * True when authoritative display has already covered this local input.
 *
 * Prediction batches and display frames use independent event sources, so an
 * action can wait in the worker queue while its real echo advances the grid.
 * Applying that stale action afterwards would predict from a cursor that is
 * already newer than the input. Sequence coverage is the event that cancels
 * such work; no timer or retry is involved.
 */
export function isPredictionInputCoveredByAuthority(
  inputSeq: number,
  authoritativeInputHighWater: number,
): boolean {
  return (
    Number.isSafeInteger(inputSeq) &&
    inputSeq > 0 &&
    inputSeq <= MAX_INPUT_SEQUENCE &&
    Number.isSafeInteger(authoritativeInputHighWater) &&
    authoritativeInputHighWater > 0 &&
    authoritativeInputHighWater <= MAX_INPUT_SEQUENCE &&
    (inputSeq === authoritativeInputHighWater ||
      inputSequenceAdvances(inputSeq, authoritativeInputHighWater))
  );
}

/**
 * Covered model work is obsolete, but a semantic flush is never obsolete:
 * Enter, completion, history, paste, and composition boundaries must rotate
 * the shadow epoch even if authenticated display wins the queue race.
 */
export function shouldSkipCoveredPredictionAction(
  kind: 'printable' | 'backspace' | 'delete' | 'cursor_shift' | 'flush',
  inputSeq: number | undefined,
  authoritativeInputHighWater: number,
): boolean {
  return (
    kind !== 'flush' &&
    inputSeq !== undefined &&
    isPredictionInputCoveredByAuthority(inputSeq, authoritativeInputHighWater)
  );
}

export interface PredictionModelAdmissionInput {
  /** No prediction may be based on a display lineage that is awaiting its snapshot. */
  readonly displayEpochReset: boolean;
  /** Unmodelled input must be covered by authoritative display before prediction resumes. */
  readonly causalBarrierOpen: boolean;
}

/**
 * Admit input into the speculative model.
 *
 * Both rejections are exact predicates over runtime state: an epoch awaiting
 * its snapshot and a causal barrier awaiting authoritative coverage. Neither
 * is a clock, and there is no third, weaker arm — a model base is authoritative
 * or it is not.
 */
export function classifyPredictionModelAdmission(
  input: PredictionModelAdmissionInput,
): PredictionModelAdmission {
  if (input.displayEpochReset) return 'reject_epoch';
  if (input.causalBarrierOpen) return 'reject_causal';
  return 'model';
}

export type PredictionDisplayInvalidation = 'none' | 'causal_reset';

/**
 * Classify how an authoritative display update invalidates local prediction.
 *
 * `invalidatesPredictionBase` is true only when the snapshot replaces the
 * speculative geometry/base (for example a resize or session-lineage reset).
 * WASM rotates the shadow lineage for every snapshot; this flag decides
 * whether the worker must additionally hold later input behind an
 * authoritative causal fence.
 *
 * Frame size is deliberately not an input. It was a proxy for "the shell is
 * not at an editable prompt", and the daemon's authenticated grant answers that
 * question exactly — while the common case the proxy mis-read (a highlighting
 * or multi-row prompt repainting its own echo) is precisely where prediction
 * pays. A same-geometry snapshot becomes the new authority immediately after
 * WASM clears the old shadow lineage, so it needs no additional input fence.
 * Only a snapshot that changes the prediction base needs a causal reset.
 *
 * Positional because it runs once per applied frame; a delta's answer is
 * `'none'` whatever the other two arguments say, which is what lets the caller
 * skip computing them for deltas.
 */
export function classifyPredictionDisplayInvalidation(
  displayKind: 'display_snapshot' | 'display_delta',
  invalidatesPredictionBase: boolean,
  hasPendingPredictions: boolean,
): PredictionDisplayInvalidation {
  if (displayKind === 'display_snapshot' && invalidatesPredictionBase && hasPendingPredictions) {
    return 'causal_reset';
  }
  return 'none';
}

export type PredictionReconciliationRecovery = 'none' | 'trust_reset' | 'authoritative_rebase';

export interface PredictionReconciliationInput {
  /** Predictions that directly contradicted the already-applied authoritative grid. */
  readonly mismatchedPredictions: number;
  /**
   * Predictions retired past their lifetime whose input sequence authoritative
   * display had already covered. Authority arrived and never confirmed them, so
   * this is a contradiction wearing an expiry's clothes.
   */
  readonly expiredCoveredPredictions: number;
  /**
   * Predictions retired past their lifetime that authoritative display never
   * reached. Nothing contradicted them; the link stalled. The glyphs are
   * withdrawn as a resource bound, but the trust evidence stays intact — a
   * stalled link is exactly when a rebuilt trust gate would take longest to
   * re-arm, and being hidden is not evidence of being wrong.
   */
  readonly expiredStalledPredictions: number;
}

/**
 * Classify prediction recovery after an authoritative frame has been applied.
 *
 * A mismatch is not an unmodelled-input boundary: WASM has already removed the
 * tainted epoch and reset its predicted cursor to this frame's real cursor.
 * Opening the input barrier here would reject and continually extend through
 * new typing, turning one correction into remote echo for the rest of the
 * command. Keep the model available from the fresh authority and let confirmed
 * frames re-open visibility.
 *
 * Expiry is split by the same exact predicate the model already uses to cancel
 * covered work (`isPredictionInputCoveredByAuthority`). Authority that arrived
 * and left a prediction unconfirmed is evidence; authority that never arrived
 * is not, and resetting trust on it would let one stalled link keep the gate
 * shut for the rest of the session.
 */
export function classifyPredictionReconciliation(
  input: PredictionReconciliationInput,
): PredictionReconciliationRecovery {
  if (input.mismatchedPredictions > 0) return 'authoritative_rebase';
  if (input.expiredCoveredPredictions > 0) return 'trust_reset';
  return 'none';
}

export function shouldDisplayPrediction(input: PredictionDisplayInput): boolean {
  return input.allowed && input.trustReady;
}

import { inputSequenceAdvances } from '../transport/input-sequence-domain';
