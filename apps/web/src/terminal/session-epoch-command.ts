import type { WorkerCommand } from '../terminal-worker-protocol';

type SessionEpochCommand = Extract<WorkerCommand, { kind: 'session_epoch' }>;

const SESSION_EPOCH: SessionEpochCommand = Object.freeze({ kind: 'session_epoch' });

export interface SessionEpochCommandGate {
  notify(displayRingFenceToken: number | null): void;
  /** Mark the worker ready and deliver one fence for every epoch it missed. */
  markReady(): void;
  /** The transport's display-ring fence of the newest epoch, which the worker also holds. */
  currentFenceToken(): number | null;
}

/**
 * Level-triggered session-epoch fencing for a starting terminal: epochs that
 * arrive before the worker is ready collapse into the one fence it receives
 * once it is, and the transport's fence token is kept for matching the
 * worker's first-display reports.
 */
export function createSessionEpochCommandGate(
  post: (command: SessionEpochCommand) => void,
): SessionEpochCommandGate {
  let ready = false;
  let pending = false;
  let requestedFenceToken: number | null = null;

  return {
    notify(displayRingFenceToken): void {
      requestedFenceToken = displayRingFenceToken;
      if (!ready) {
        pending = true;
        return;
      }
      post(SESSION_EPOCH);
    },

    markReady(): void {
      ready = true;
      if (!pending) return;
      pending = false;
      post(SESSION_EPOCH);
    },

    currentFenceToken(): number | null {
      return requestedFenceToken;
    },
  };
}
