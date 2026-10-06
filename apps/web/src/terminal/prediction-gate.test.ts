import { describe, expect, test } from 'bun:test';
import {
  TERMINAL_MODE_ALT_SCREEN,
  TERMINAL_MODE_KNOWN_MASK,
  TERMINAL_MODE_POINTER_CLICKS,
  TERMINAL_MODE_POINTER_DRAG,
  TERMINAL_MODE_POINTER_HOVER,
  TERMINAL_MODE_PREDICTION_SAFE,
  TERMINAL_MODE_WHEEL,
} from '@merkur/shared';
import {
  classifyPredictionDisplayInvalidation,
  classifyPredictionModelAdmission,
  classifyPredictionReconciliation,
  isPredictionInputCoveredByAuthority,
  isShadowModelInputSafe,
  shouldDisplayPrediction,
  shouldSkipCoveredPredictionAction,
} from './prediction-gate';

describe('isShadowModelInputSafe', () => {
  const predictionSafe = TERMINAL_MODE_PREDICTION_SAFE;
  const routing = [
    TERMINAL_MODE_POINTER_CLICKS,
    TERMINAL_MODE_POINTER_DRAG,
    TERMINAL_MODE_POINTER_HOVER,
    TERMINAL_MODE_WHEEL,
    TERMINAL_MODE_ALT_SCREEN,
  ];

  test('requires the authenticated bit and a visible authoritative cursor', () => {
    expect(isShadowModelInputSafe(predictionSafe, true, false)).toBe(true);
    expect(isShadowModelInputSafe(0, true, false)).toBe(false);
    expect(isShadowModelInputSafe(predictionSafe, false, false)).toBe(false);
    expect(isShadowModelInputSafe(predictionSafe, true, true)).toBe(false);
  });

  test('mirrors WASM rejection for unknown modes', () => {
    // A bit outside the known mask is a future mode this build cannot reason
    // about, so it fails closed.
    expect(
      isShadowModelInputSafe(predictionSafe | (TERMINAL_MODE_KNOWN_MASK + 1), true, false),
    ).toBe(false);
    // Known routing bits do not independently make ordinary line editing unsafe.
    expect(isShadowModelInputSafe(predictionSafe | TERMINAL_MODE_WHEEL, true, false)).toBe(true);
  });

  /**
   * The other half of the multiplexer case. tmux with `mouse on` sets the mouse
   * bits and the alternate screen together, so removing only the screen proxy
   * left the same sessions unpredicted. Mouse tracking governs how pointer
   * events are encoded, not whether the shell echoes typed characters.
   */
  test('mouse tracking under a grant still predicts', () => {
    for (const bit of routing) {
      expect(isShadowModelInputSafe(predictionSafe | bit, true, false)).toBe(true);
    }
    // The full multiplexer shape, every routing bit tmux sets at once.
    const tmux = routing.reduce((mode, bit) => mode | bit, predictionSafe);
    expect(isShadowModelInputSafe(tmux, true, false)).toBe(true);
  });

  /**
   * This case used to assert the opposite, under a name claiming to mirror the
   * WASM model — which is exactly what the WASM model does not do. The stale
   * expectation kept the divergence green: `prediction_mode_is_unsafe` in
   * `packages/term-wasm/src/lib.rs` dropped the alternate screen because a
   * multiplexer holds it for its whole lifetime while the shell inside has an
   * ordinary line editor, and this gate is the one the input path consults.
   */
  test('a granted prompt on the alternate screen still predicts (the tmux case)', () => {
    const altScreen = TERMINAL_MODE_ALT_SCREEN;
    expect(isShadowModelInputSafe(predictionSafe | altScreen, true, false)).toBe(true);
    // Alternate screen plus the wheel a multiplexer's alternate scroll claims.
    expect(
      isShadowModelInputSafe(predictionSafe | altScreen | TERMINAL_MODE_WHEEL, true, false),
    ).toBe(true);
    // The grant is still what carries it: without one, the mode is irrelevant.
    expect(isShadowModelInputSafe(altScreen, true, false)).toBe(false);
  });
});

describe('shouldDisplayPrediction', () => {
  test('admits a trusted, causally safe path', () => {
    expect(shouldDisplayPrediction({ allowed: true, trustReady: true })).toBe(true);
  });

  test('keeps unproven predictions hidden', () => {
    expect(shouldDisplayPrediction({ allowed: true, trustReady: false })).toBe(false);
  });

  test('suppression wins over trust', () => {
    expect(shouldDisplayPrediction({ allowed: false, trustReady: true })).toBe(false);
  });
});

describe('classifyPredictionDisplayInvalidation', () => {
  test('uses a causal fence only when a snapshot invalidates the prediction base', () => {
    expect(classifyPredictionDisplayInvalidation('display_snapshot', true, true)).toBe(
      'causal_reset',
    );
    expect(classifyPredictionDisplayInvalidation('display_snapshot', false, true)).toBe('none');
    expect(classifyPredictionDisplayInvalidation('display_snapshot', true, false)).toBe('none');
  });

  test('never invalidates prediction for a delta, however large', () => {
    // A multi-row repaint at an open prompt IS the echo of the user's own
    // typing (syntax highlighting, autosuggestion, a multi-line prompt). It is
    // exactly when prediction pays, and the retired frame-size proxy suppressed
    // it on 32% of production delta frames.
    expect(classifyPredictionDisplayInvalidation('display_delta', true, true)).toBe('none');
  });
});

describe('classifyPredictionModelAdmission', () => {
  test('admits input whenever the model base is authoritative', () => {
    expect(
      classifyPredictionModelAdmission({
        displayEpochReset: false,
        causalBarrierOpen: false,
      }),
    ).toBe('model');
  });

  test('rejects an unauthoritative epoch or causal model base', () => {
    expect(
      classifyPredictionModelAdmission({
        displayEpochReset: true,
        causalBarrierOpen: false,
      }),
    ).toBe('reject_epoch');
    expect(
      classifyPredictionModelAdmission({
        displayEpochReset: false,
        causalBarrierOpen: true,
      }),
    ).toBe('reject_causal');
  });
});

describe('isPredictionInputCoveredByAuthority', () => {
  test('cancels queued prediction work once display covers its sequence', () => {
    expect(isPredictionInputCoveredByAuthority(3, 5)).toBe(true);
    expect(isPredictionInputCoveredByAuthority(5, 5)).toBe(true);
    expect(isPredictionInputCoveredByAuthority(6, 5)).toBe(false);
    expect(isPredictionInputCoveredByAuthority(1, 0)).toBe(false);
  });

  test('compares covered input in serial order across uint32 wrap', () => {
    expect(isPredictionInputCoveredByAuthority(0xffff_ffff, 1)).toBe(true);
    expect(isPredictionInputCoveredByAuthority(1, 0xffff_ffff)).toBe(false);
  });

  test('never treats malformed or out-of-domain telemetry as authority', () => {
    expect(isPredictionInputCoveredByAuthority(0, 5)).toBe(false);
    expect(isPredictionInputCoveredByAuthority(Number.NaN, 5)).toBe(false);
    expect(isPredictionInputCoveredByAuthority(5, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isPredictionInputCoveredByAuthority(0x1_0000_0000, 0x1_0000_0000)).toBe(false);
  });
});

describe('shouldSkipCoveredPredictionAction', () => {
  test('never skips a covered semantic flush but drops obsolete model work', () => {
    expect(shouldSkipCoveredPredictionAction('flush', 10, 10)).toBe(false);
    expect(shouldSkipCoveredPredictionAction('printable', 10, 10)).toBe(true);
    expect(shouldSkipCoveredPredictionAction('cursor_shift', 11, 10)).toBe(false);
  });
});

describe('classifyPredictionReconciliation', () => {
  test('rebases on an already-applied authoritative mismatch without opening a causal fence', () => {
    expect(
      classifyPredictionReconciliation({
        mismatchedPredictions: 1,
        expiredCoveredPredictions: 0,
        expiredStalledPredictions: 0,
      }),
    ).toBe('authoritative_rebase');
  });

  test('resets trust only when authority covered the retired input', () => {
    expect(
      classifyPredictionReconciliation({
        mismatchedPredictions: 0,
        expiredCoveredPredictions: 3,
        expiredStalledPredictions: 0,
      }),
    ).toBe('trust_reset');
  });

  test('never resets trust for a stalled link', () => {
    // Nothing contradicted these glyphs; authority never arrived. Resetting
    // trust here is the second bootstrap blocker, and it fires hardest on the
    // lossy links where prediction is worth the most.
    expect(
      classifyPredictionReconciliation({
        mismatchedPredictions: 0,
        expiredCoveredPredictions: 0,
        expiredStalledPredictions: 7,
      }),
    ).toBe('none');
    expect(
      classifyPredictionReconciliation({
        mismatchedPredictions: 0,
        expiredCoveredPredictions: 0,
        expiredStalledPredictions: 0,
      }),
    ).toBe('none');
  });
});
