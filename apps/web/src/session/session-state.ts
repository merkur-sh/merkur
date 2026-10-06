import {
  canTransitionTerminalLifecycle,
  TERMINAL_LIFECYCLE_CLOSED,
  TERMINAL_LIFECYCLE_IDLE,
  TERMINAL_LIFECYCLE_READY,
  TERMINAL_LIFECYCLE_RECONNECTING,
  type TerminalLifecycleState,
  transitionTerminalLifecycleOrThrow,
} from '@merkur/shared';

export type LinkPath = 'direct' | 'relay' | 'unknown';

export type LinkState =
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'dormant'
  | 'closed'
  | 'relay-paused'
  | 'relay-stopped';

/** Connection-quality snapshot shared by transport diagnostics and the status readout. */
export interface ConnectionQuality {
  /** Latest heartbeat RTT sample (ms), or null before the first measurement. */
  readonly rttMs: number | null;
  /**
   * Best observed heartbeat RTT in the recent window on this path. Kept beside
   * the latest sample for diagnostics; the header reports the sample itself.
   */
  readonly rttFloorMs: number | null;
  /**
   * Latest input-to-daemon-acknowledgement sample and its observation counter.
   * Includes PTY write completion, so it must not replace heartbeat RTT in the
   * link-delay readout. The counter distinguishes a fresh sample from a held one.
   */
  readonly inputAckMs: number | null;
  readonly inputAckSeq: number;
  readonly path: LinkPath;
  readonly state: LinkState;
  /** Recent display recovery — folds into the health colour even at low RTT. */
  readonly degraded: boolean;
  /** Monotonic session count of display snapshot requests, not packet loss. */
  readonly resyncCount: number;
  /** Increments only on a fresh heartbeat RTT measurement. */
  readonly seq: number;
}

// Display recovery marks the waveform and readout amber even when RTT is low.
// Spans ~2 heartbeats (2s each).
const RESYNC_DEGRADE_WINDOW_MS = 5_000;

/**
 * How far back the RTT floor looks. Four heartbeats: long enough that one
 * scheduling spike under heavy output cannot raise the floor, short enough that
 * a genuinely slower path is reflected within a couple of samples.
 */
const RTT_FLOOR_WINDOW_MS = 8_000;

interface SessionStateStoreContext {
  onDormantChange?(isDormant: boolean): void;
  hasLiveDirectPath?(): boolean;
  /** Monotonic duration clock. Defaults to `performance.now()`. */
  now?(): number;
}

export interface SessionStateStore {
  getState(): TerminalLifecycleState;
  /**
   * Apply a lifecycle transition. Same-state is a no-op success; an invalid
   * transition returns false without side effects. Valid transitions notify
   * connection-quality listeners.
   */
  tryTransition(nextState: TerminalLifecycleState): boolean;
  currentLinkState(): LinkState;
  setRelayDataState(state: 'open' | 'paused' | 'stopped'): void;
  isRelayDataPaused(): boolean;
  enterDormant(): void;
  exitDormant(): void;
  isDormant(): boolean;
  /** Clear dormancy without notifying the closing owner. */
  clearDormant(): void;
  /** Record recent display loss/resync so quality reads degraded for a window. */
  markResyncDegraded(): void;
  /**
   * Record a heartbeat RTT outcome for the labeled path. A null RTT updates
   * the path label only (no fresh sample); both cases notify listeners.
   */
  recordRtt(rttMs: number | null, path: LinkPath): void;
  /**
   * Record one keystroke-to-acknowledgement sample. Deliberately does not
   * notify: this fires per input run, and the tick that carries it to main is
   * already scheduled by the byte flow that produced it.
   */
  recordInputAckSample(sampleMs: number): void;
  getQuality(): ConnectionQuality;
  addTxBytes(byteLength: number): void;
  addRxBytes(byteLength: number): void;
  getThroughput(): { readonly txBytes: number; readonly rxBytes: number };
  onConnectionQualityChange(listener: () => void): () => void;
  notifyConnectionQuality(): void;
}

/**
 * Whether signaling recovery should project a dormant terminal.
 *
 * Signaling rides the edge carrier alone, so losing it always starts a
 * reconnect — but a direct WebTransport path survives that loss and keeps
 * carrying input and display, because `onProviderDisconnected` removes only the
 * edge provider from the mux. Entering dormancy there would cover a working terminal.
 *
 * The daemon encodes the same asymmetry at detach time:
 * `classify_counterpart_detach` returns `Ignore` while a direct path is
 * available. A rebind that was already admitted may retain that incumbent
 * direct/Noise pair transactionally until its successor commits; that does not
 * make a signaling-only reconnect dormant. This is the browser's half of it.
 */
export function shouldEnterDormantOnReconnect(
  state: TerminalLifecycleState,
  hasLiveAlternatePath: boolean,
): boolean {
  return state === TERMINAL_LIFECYCLE_READY && !hasLiveAlternatePath;
}

export function createSessionStateStore(context: SessionStateStoreContext): SessionStateStore {
  const now = context.now ?? (() => performance.now());
  let sessionState: TerminalLifecycleState = TERMINAL_LIFECYCLE_IDLE;
  let dormant = false;
  let relayDataState: 'open' | 'paused' | 'stopped' = 'open';
  // Connection-quality state surfaced for the status-bar link strip.
  let lastMeasuredRttMs: number | null = null;
  let lastPathLabel: LinkPath = 'unknown';
  let rttSampleSeq = 0;
  let lastResyncAtMs: number | null = null;
  let resyncCount = 0;
  let lastInputAckMs: number | null = null;
  let inputAckSeq = 0;
  // The floor window, oldest first. A path change starts it over: a new path
  // has a different floor, and reporting the new path's latency under the old
  // path's minimum is how a relay hand-off used to read as a direct link.
  const rttFloorSamples: { atMs: number; rttMs: number }[] = [];
  let rttFloorPath: LinkPath = 'unknown';
  let rttFloorMs: number | null = null;
  // Cumulative WIRE bytes across every transport connection (framing, Noise
  // overhead, signaling, heartbeats, fan-out duplicates included), fed by the
  // providers' wire counters and surfaced as the waveform's session total.
  let txWireBytes = 0;
  let rxWireBytes = 0;
  const connectionQualityListeners = new Set<() => void>();

  function notifyConnectionQuality(): void {
    if (connectionQualityListeners.size === 0) return;
    for (const listener of connectionQualityListeners) {
      listener();
    }
  }

  function currentLinkState(): LinkState {
    if (sessionState === TERMINAL_LIFECYCLE_CLOSED || sessionState === TERMINAL_LIFECYCLE_IDLE) {
      return 'closed';
    }
    if (!context.hasLiveDirectPath?.()) {
      if (relayDataState === 'paused') return 'relay-paused';
      if (relayDataState === 'stopped') return 'relay-stopped';
    }
    if (dormant) return 'dormant';
    if (sessionState === TERMINAL_LIFECYCLE_RECONNECTING) return 'reconnecting';
    if (sessionState === TERMINAL_LIFECYCLE_READY) return 'ready';
    return 'connecting';
  }

  return {
    getState(): TerminalLifecycleState {
      return sessionState;
    },

    tryTransition(nextState: TerminalLifecycleState): boolean {
      if (sessionState === nextState) {
        return true;
      }
      if (!canTransitionTerminalLifecycle(sessionState, nextState)) {
        return false;
      }
      sessionState = transitionTerminalLifecycleOrThrow(sessionState, nextState);
      notifyConnectionQuality();
      return true;
    },

    currentLinkState,
    setRelayDataState(state): void {
      relayDataState = state;
      notifyConnectionQuality();
    },
    isRelayDataPaused: () => relayDataState === 'paused',

    enterDormant(): void {
      if (dormant) return;
      dormant = true;
      context.onDormantChange?.(true);
      notifyConnectionQuality();
    },

    exitDormant(): void {
      if (!dormant) return;
      dormant = false;
      context.onDormantChange?.(false);
      notifyConnectionQuality();
    },

    isDormant(): boolean {
      return dormant;
    },

    clearDormant(): void {
      dormant = false;
    },

    markResyncDegraded(): void {
      lastResyncAtMs = now();
      resyncCount += 1;
    },

    recordRtt(rttMs: number | null, path: LinkPath): void {
      lastPathLabel = path;
      if (rttFloorPath !== path) {
        rttFloorPath = path;
        rttFloorSamples.length = 0;
      }
      if (rttMs !== null) {
        lastMeasuredRttMs = rttMs;
        rttSampleSeq += 1;
        rttFloorSamples.push({ atMs: now(), rttMs });
      }
      const cutoff = now() - RTT_FLOOR_WINDOW_MS;
      while (rttFloorSamples.length > 0) {
        const head = rttFloorSamples[0];
        if (head === undefined || head.atMs >= cutoff) break;
        rttFloorSamples.shift();
      }
      let min: number | null = null;
      for (const sample of rttFloorSamples) {
        if (min === null || sample.rttMs < min) min = sample.rttMs;
      }
      rttFloorMs = min;
      notifyConnectionQuality();
    },

    recordInputAckSample(sampleMs: number): void {
      lastInputAckMs = sampleMs;
      inputAckSeq += 1;
    },

    getQuality(): ConnectionQuality {
      return {
        rttMs: lastMeasuredRttMs,
        rttFloorMs,
        inputAckMs: lastInputAckMs,
        inputAckSeq,
        path: lastPathLabel,
        state: currentLinkState(),
        degraded: lastResyncAtMs !== null && now() - lastResyncAtMs < RESYNC_DEGRADE_WINDOW_MS,
        resyncCount,
        seq: rttSampleSeq,
      };
    },

    addTxBytes(byteLength: number): void {
      txWireBytes += byteLength;
    },

    addRxBytes(byteLength: number): void {
      rxWireBytes += byteLength;
    },

    getThroughput(): { readonly txBytes: number; readonly rxBytes: number } {
      return { txBytes: txWireBytes, rxBytes: rxWireBytes };
    },

    onConnectionQualityChange(listener: () => void): () => void {
      connectionQualityListeners.add(listener);
      return () => {
        connectionQualityListeners.delete(listener);
      };
    },

    notifyConnectionQuality,
  };
}
