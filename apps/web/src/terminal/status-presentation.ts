import { SIGNALING_RECONNECT_CEIL_MS } from '@merkur/config/retry-schedules';

export type TerminalStage =
  | 'idle'
  | 'signaling'
  | 'connecting'
  | 'authenticating'
  | 'first-frame'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed';

export type TerminalStatusMode = 'hidden' | 'progress' | 'success' | 'error';

/** Keeps the successful connection result readable without delaying terminal input. */
export const TERMINAL_SUCCESS_VISIBLE_MS = 250;

/**
 * How long a signaling reconnect may run before the terminal is covered.
 *
 * A carrier rebind recovers the session in about the time one edge handshake
 * and a round trip take, so covering the terminal the instant signaling
 * reports `reconnecting` would replace a gap the user would not otherwise
 * notice with a visible interruption — the overlay itself becomes the
 * regression. Long enough that a rebind finishes underneath it, short enough
 * that a genuine outage still surfaces well inside a second.
 *
 * Only the transition into recovery progress is delayed. Once the first frame
 * is visible, the overlay changes immediately to the non-blocking success
 * confirmation.
 */
export const RECONNECT_OVERLAY_GRACE_MS = 600;

/**
 * How long a progress overlay may run before it also offers a way out.
 *
 * The overlay is a spinner with no controls — Retry renders only in the error
 * state — so a reconnect that does not resolve leaves the machine list as the
 * user's only exit. That is the workaround this delay exists to make
 * unnecessary, and it was a real one: returning to the list and reconnecting by
 * hand issues a fresh session, which is the one path that clears a wedged
 * carrier. The way back is the header's arrow, on this screen as on every
 * other; the card offers Retry and nothing else.
 *
 * One reconnect ceiling past the grace that decides to cover the terminal at
 * all. A recovery that is going to succeed has had a full backoff cycle to do
 * it, so an ordinary reconnect never flashes controls; a stuck one becomes
 * escapable without leaving the terminal.
 */
export const RECONNECT_ESCAPE_REVEAL_MS = RECONNECT_OVERLAY_GRACE_MS + SIGNALING_RECONNECT_CEIL_MS;

export function terminalStatusModeForStage(
  stage: TerminalStage,
  signalingReconnecting = false,
): TerminalStatusMode {
  if (stage === 'disconnected' || stage === 'failed') return 'error';
  if (signalingReconnecting) return 'progress';
  if (stage === 'idle') return 'hidden';
  if (stage === 'connected') return 'success';
  return 'progress';
}

/**
 * The stage the card describes. A lost carrier is reported as signaling
 * reconnecting while the stage stays `connected`, because the shell and its
 * display are kept; the progress card over a connected stage is that
 * reconnect, and must not read "Connected".
 */
export function terminalStatusCopyStage(
  stage: TerminalStage,
  mode: TerminalStatusMode,
): TerminalStage {
  return mode === 'progress' && stage === 'connected' ? 'reconnecting' : stage;
}

/**
 * Pre-ready disconnects are surfaced synchronously through `onDisconnected`
 * before the matching start promise rejects. That callback owns reconnect/error
 * presentation; the rejection fallback may publish only while no callback has
 * advanced the stage.
 */
export function shouldPublishTerminalStartFailure(stage: TerminalStage): boolean {
  return stage === 'signaling' || stage === 'connecting' || stage === 'authenticating';
}

export function decideTerminalStartFailure(
  stage: TerminalStage,
  ownsStartupTrace: boolean,
): {
  readonly publishFailure: boolean;
  readonly retainStartupTrace: boolean;
} {
  const publishFailure = shouldPublishTerminalStartFailure(stage);
  return {
    publishFailure,
    retainStartupTrace: !publishFailure || !ownsStartupTrace,
  };
}
