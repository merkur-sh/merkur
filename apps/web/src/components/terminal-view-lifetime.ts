/**
 * What should happen to the rendered panel, given the session and the layer.
 *
 * Pulled out of the effect because it is the whole of the interesting
 * behaviour and none of the DOM: three inputs, and a wrong answer to any of
 * them is either a dead terminal left on screen or a live one torn off it.
 */
export type TerminalViewAction =
  /** A new session: render it, dropping anything held for the old one. */
  | 'replace'
  /** The session ended while the layer is leaving: freeze what is on screen. */
  | 'retire'
  /** The session ended with nothing to animate out: drop it now. */
  | 'clear';

export function reconcileTerminalView(input: {
  readonly hasRings: boolean;
  /** Is the terminal the current route? */
  readonly active: boolean;
  /** Is the layer on screen — still true throughout the exit, unlike `active`. */
  readonly showing: boolean;
}): TerminalViewAction {
  if (input.hasRings) return 'replace';
  // `showing && !active` is precisely "leaving". Not `showing` alone: a session
  // that ends while the terminal is still the route — a fatal worker, a refused
  // reconnect — has no exit to wait for, and freezing the panel there would
  // leave a picture of a terminal in place of the status the user has to read.
  // Not `!active` alone either: a connect that fails before the route is pushed
  // never showed anything, and would otherwise strand a panel nobody can see.
  if (input.showing && !input.active) return 'retire';
  return 'clear';
}
