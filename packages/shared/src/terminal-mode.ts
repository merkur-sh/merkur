/**
 * Terminal mode bits and the speculative-echo admission predicate.
 *
 * These bits are a cross-language contract: the routing decisions the daemon
 * derives from its own terminal (`encode_terminal_mode` in the dataplane,
 * mirrored by `DISPLAY_MODE_*` and `mouse_mode()` in
 * `packages/term-wasm/src/lib.rs`) and reports in `mode_flags`. They are not
 * raw xterm modes, and the browser never recombines modes into a decision of
 * its own. They only gate what the browser sends: the daemon encodes every
 * input record against the terminal's real modes. Nothing at runtime detects
 * drift, so `terminal-mode.test.ts` pins the exact numbers against the Rust
 * definitions and `term-wasm`'s own suite pins the same ones from the other
 * side.
 *
 * They live in one module because they did not, and the copies diverged. The
 * alternate-screen veto was removed from the Rust model and from
 * `terminal-worker.ts` but survived in the main-thread input gate, which is the
 * copy that decides whether a keystroke is predicted at all — so speculative
 * echo stayed disarmed for every alternate-screen application while the code
 * read as though it had been fixed. One definition, three consumers.
 */

/** Pointer presses and releases belong to the application, not to selection. */
export const TERMINAL_MODE_POINTER_CLICKS = 1;
/** Motion with a button held is reported. */
export const TERMINAL_MODE_POINTER_DRAG = 1 << 1;
/** Motion with no button held is reported (any-motion tracking). */
export const TERMINAL_MODE_POINTER_HOVER = 1 << 2;
/**
 * The wheel belongs to the application: wheel buttons under mouse tracking,
 * or cursor keys on an alternate screen with alternate scroll.
 */
export const TERMINAL_MODE_WHEEL = 1 << 3;
/** The alternate screen, which resizes without reflow. */
export const TERMINAL_MODE_ALT_SCREEN = 1 << 4;

/**
 * The daemon's authenticated grant that local edits at the cursor can be
 * predicted. Absence is unsafe, so an old daemon or a failed lookup fails
 * closed.
 *
 * This is the *real* signal the mode proxies were standing in for: the daemon
 * sets it only inside an authenticated `OSC 133;B;merkur=<token>` prompt
 * boundary and clears it on command start, on unmodelled input, and on reset.
 * A full-screen program cannot inherit a prompt's grant because `133;C` closes
 * the boundary before it runs.
 */
export const TERMINAL_MODE_PREDICTION_SAFE = 1 << 5;

/**
 * Key releases reach the application (Kitty flag 2). The next two bits and
 * this one say when input nothing waits on (`reportedWhen` on a key record)
 * produces bytes at all; until it would, the browser holds it in the input
 * ring and it leaves with the next input instead of on its own datagram.
 */
export const TERMINAL_MODE_KEY_RELEASES = 1 << 6;
/** Bare modifier keys reach the application (Kitty flag 8). */
export const TERMINAL_MODE_MODIFIER_KEYS = 1 << 7;
/** Focus changes reach the application (DECSET 1004). */
export const TERMINAL_MODE_FOCUS = 1 << 8;
/** The bits whose rising edge releases held input. */
export const TERMINAL_MODE_INPUT_REPORTS =
  TERMINAL_MODE_KEY_RELEASES | TERMINAL_MODE_MODIFIER_KEYS | TERMINAL_MODE_FOCUS;

/** Every bit this build understands. A bit outside it is a future mode. */
export const TERMINAL_MODE_KNOWN_MASK = 0x1ff;

/**
 * No terminal mode withholds speculative echo on its own.
 *
 * There were two proxies here — the alternate screen and mouse tracking — both
 * standing in for "there is no line editor at the cursor". A multiplexer breaks
 * both at once: tmux holds the alternate screen for its entire lifetime and
 * sets mouse tracking whenever `mouse on` is configured, while the shell inside
 * it has an ordinary line editor. The screen proxy was removed first, but
 * because tmux sets both bits the mouse proxy kept withholding prediction from
 * exactly the users that removal was meant to serve.
 *
 * Neither is one of the three gates in `docs/security.md`; mouse tracking
 * governs pointer-event encoding and says nothing about whether the shell
 * echoes typed characters. What decides is `TERMINAL_MODE_PREDICTION_SAFE`.
 *
 * Kept as a named export rather than deleted so `prediction_mode_is_unsafe` in
 * `packages/term-wasm/src/lib.rs` and this module stay legibly the same shape,
 * and so re-adding a mode proxy is a visible edit here rather than a bitmask
 * quietly widening in one of several copies.
 */
export const TERMINAL_MODE_UNSAFE_FOR_PREDICTION = 0;

/**
 * Why `mode` forbids prediction, or `null` when the mode itself permits it.
 *
 * Ordered by precedence so the answer names the *binding* constraint. The
 * missing-grant case is reported before the mode proxies: a peer with no
 * `OSC 133` grant is not being refused because of its screen or its mouse
 * tracking, and reporting a proxy there sends every reader chasing the wrong
 * cause. That mis-ordering is why the divergence above went unnoticed —
 * telemetry attributed missing grants to `alternate_screen` for months.
 */
export function terminalModePredictionRefusal(
  mode: number,
): 'mode_uninitialized' | 'unknown_mode' | 'no_prompt_grant' | 'unsafe_mode' | null {
  if (!Number.isInteger(mode) || mode < 0) return 'mode_uninitialized';
  if ((mode & ~TERMINAL_MODE_KNOWN_MASK) !== 0) return 'unknown_mode';
  if ((mode & TERMINAL_MODE_PREDICTION_SAFE) === 0) return 'no_prompt_grant';
  if ((mode & TERMINAL_MODE_UNSAFE_FOR_PREDICTION) !== 0) return 'unsafe_mode';
  return null;
}

/** Whether `mode` alone permits speculative echo. */
export function terminalModeAllowsPrediction(mode: number): boolean {
  return terminalModePredictionRefusal(mode) === null;
}
