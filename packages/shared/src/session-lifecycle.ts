export const TERMINAL_LIFECYCLE_IDLE = 'idle';
export const TERMINAL_LIFECYCLE_CONNECTING = 'connecting';
export const TERMINAL_LIFECYCLE_AUTHENTICATING = 'authenticating';
export const TERMINAL_LIFECYCLE_READY = 'ready';
export const TERMINAL_LIFECYCLE_RECONNECTING = 'reconnecting';
export const TERMINAL_LIFECYCLE_CLOSED = 'closed';

export type TerminalLifecycleState =
  | typeof TERMINAL_LIFECYCLE_IDLE
  | typeof TERMINAL_LIFECYCLE_CONNECTING
  | typeof TERMINAL_LIFECYCLE_AUTHENTICATING
  | typeof TERMINAL_LIFECYCLE_READY
  | typeof TERMINAL_LIFECYCLE_RECONNECTING
  | typeof TERMINAL_LIFECYCLE_CLOSED;

const TERMINAL_LIFECYCLE_TRANSITIONS: Readonly<
  Record<TerminalLifecycleState, readonly TerminalLifecycleState[]>
> = {
  idle: ['connecting', 'closed'],
  connecting: ['authenticating', 'reconnecting', 'closed'],
  authenticating: ['ready', 'reconnecting', 'closed'],
  ready: ['reconnecting', 'closed'],
  reconnecting: ['connecting', 'closed'],
  closed: ['connecting'],
};

export function canTransitionTerminalLifecycle(
  current: TerminalLifecycleState,
  next: TerminalLifecycleState,
): boolean {
  if (current === next) {
    return true;
  }

  const allowedTransitions = TERMINAL_LIFECYCLE_TRANSITIONS[current];
  return allowedTransitions.includes(next);
}

export function transitionTerminalLifecycleOrThrow(
  current: TerminalLifecycleState,
  next: TerminalLifecycleState,
): TerminalLifecycleState {
  if (!canTransitionTerminalLifecycle(current, next)) {
    throw new Error(`Invalid lifecycle transition: ${current} -> ${next}`);
  }

  return next;
}
