import { describe, expect, test } from 'bun:test';

import {
  TERMINAL_MODE_ALT_SCREEN,
  TERMINAL_MODE_FOCUS,
  TERMINAL_MODE_INPUT_REPORTS,
  TERMINAL_MODE_KEY_RELEASES,
  TERMINAL_MODE_KNOWN_MASK,
  TERMINAL_MODE_MODIFIER_KEYS,
  TERMINAL_MODE_POINTER_CLICKS,
  TERMINAL_MODE_POINTER_DRAG,
  TERMINAL_MODE_POINTER_HOVER,
  TERMINAL_MODE_PREDICTION_SAFE,
  TERMINAL_MODE_UNSAFE_FOR_PREDICTION,
  TERMINAL_MODE_WHEEL,
  terminalModeAllowsPrediction,
  terminalModePredictionRefusal,
} from './terminal-mode';

const ROUTING_BITS = [
  TERMINAL_MODE_POINTER_CLICKS,
  TERMINAL_MODE_POINTER_DRAG,
  TERMINAL_MODE_POINTER_HOVER,
  TERMINAL_MODE_WHEEL,
  TERMINAL_MODE_ALT_SCREEN,
  TERMINAL_MODE_KEY_RELEASES,
  TERMINAL_MODE_MODIFIER_KEYS,
  TERMINAL_MODE_FOCUS,
] as const;

/**
 * The Rust side is the authority and nothing at runtime detects drift, so these
 * numbers are pinned against it by hand. Their counterparts are
 * `DISPLAY_MODE_*` in `apps/daemon/dataplane/src/pty/terminal.rs` and in
 * `packages/term-wasm/src/lib.rs`.
 */
describe('terminal mode bits mirror the Rust authority', () => {
  test('every bit matches the dataplane and term-wasm', () => {
    expect(TERMINAL_MODE_POINTER_CLICKS).toBe(1);
    expect(TERMINAL_MODE_POINTER_DRAG).toBe(2);
    expect(TERMINAL_MODE_POINTER_HOVER).toBe(4);
    expect(TERMINAL_MODE_WHEEL).toBe(8);
    expect(TERMINAL_MODE_ALT_SCREEN).toBe(16);
    expect(TERMINAL_MODE_PREDICTION_SAFE).toBe(32);
    expect(TERMINAL_MODE_KEY_RELEASES).toBe(64);
    expect(TERMINAL_MODE_MODIFIER_KEYS).toBe(128);
    expect(TERMINAL_MODE_FOCUS).toBe(256);
    expect(TERMINAL_MODE_INPUT_REPORTS).toBe(0x1c0);
    expect(TERMINAL_MODE_KNOWN_MASK).toBe(0x1ff);
  });

  /**
   * The regression this module exists for. Both mode proxies are gone from
   * `prediction_mode_is_unsafe` in `term-wasm`; any bit reappearing here would
   * silently disarm speculative echo for a whole class of applications again,
   * which is what each of them did in turn.
   */
  test('no terminal mode withholds prediction on its own', () => {
    expect(TERMINAL_MODE_UNSAFE_FOR_PREDICTION).toBe(0);
    expect(TERMINAL_MODE_UNSAFE_FOR_PREDICTION & TERMINAL_MODE_ALT_SCREEN).toBe(0);
    for (const bit of ROUTING_BITS) expect(TERMINAL_MODE_UNSAFE_FOR_PREDICTION & bit).toBe(0);
  });
});

describe('prediction admission', () => {
  test('a granted prompt on the alternate screen still predicts', () => {
    // Exactly the tmux case: the multiplexer owns the alternate screen for its
    // whole lifetime while the shell inside it has an ordinary line editor.
    const mode = TERMINAL_MODE_PREDICTION_SAFE | TERMINAL_MODE_ALT_SCREEN;
    expect(terminalModePredictionRefusal(mode)).toBeNull();
    expect(terminalModeAllowsPrediction(mode)).toBe(true);
  });

  /**
   * The case that made the alternate-screen removal ineffective. tmux with
   * `mouse on` sets the mouse bits and the alternate screen together, so
   * vetoing on either one withheld prediction from the same users.
   */
  test('pointer and wheel routing do not withhold prediction under a grant', () => {
    for (const bit of ROUTING_BITS) {
      const mode = TERMINAL_MODE_PREDICTION_SAFE | bit;
      expect(terminalModePredictionRefusal(mode)).toBeNull();
      expect(terminalModeAllowsPrediction(mode)).toBe(true);
    }
    // The full multiplexer shape: every routing bit at once.
    const tmux = ROUTING_BITS.reduce<number>(
      (mode, bit) => mode | bit,
      TERMINAL_MODE_PREDICTION_SAFE,
    );
    expect(terminalModeAllowsPrediction(tmux)).toBe(true);
  });

  test('absence of the daemon grant fails closed', () => {
    expect(terminalModePredictionRefusal(0)).toBe('no_prompt_grant');
    expect(terminalModeAllowsPrediction(0)).toBe(false);
  });

  /**
   * The mis-attribution that hid the divergence. A peer with no grant on the
   * alternate screen was reported as `alternate_screen`, so the telemetry
   * blamed a mode that had already been removed from the decision.
   */
  test('a missing grant is named as such, not blamed on a mode proxy', () => {
    expect(terminalModePredictionRefusal(TERMINAL_MODE_ALT_SCREEN)).toBe('no_prompt_grant');
    expect(terminalModePredictionRefusal(TERMINAL_MODE_WHEEL)).toBe('no_prompt_grant');
  });

  test('an unknown future bit fails closed ahead of anything else', () => {
    const mode = TERMINAL_MODE_PREDICTION_SAFE | (TERMINAL_MODE_KNOWN_MASK + 1);
    expect(terminalModePredictionRefusal(mode)).toBe('unknown_mode');
  });

  test('a negative or non-integer mode is uninitialized, never predicted', () => {
    expect(terminalModePredictionRefusal(-1)).toBe('mode_uninitialized');
    expect(terminalModePredictionRefusal(Number.NaN)).toBe('mode_uninitialized');
    expect(terminalModePredictionRefusal(1.5)).toBe('mode_uninitialized');
  });
});
