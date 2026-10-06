import type { DisplayLinkDefinition, TerminalUiEffect } from '@merkur/protocol';
import type { BrowserUpgradeReport, RecoveryOutcome, SignalingStatus } from '@merkur/shared';
import type { TransportToMain } from '../transport-worker-protocol';

type Metrics = Omit<Extract<TransportToMain, { kind: 'metrics' }>, 'kind' | 'startId'>;
type LinkTick = Omit<Extract<TransportToMain, { kind: 'link_tick' }>, 'kind' | 'startId'>;

/**
 * Immutable worker→main publication boundary for one start invocation.
 *
 * Every callback closes over the start id it was created for. Retaining an old
 * callback therefore remains safe after a replacement starts: it can at worst
 * emit an event labeled with its own obsolete id, which main rejects.
 */
export interface TransportStartEvents {
  recoveryEvent(outcome: RecoveryOutcome, ended: boolean, atMs: number): void;
  inputReady(): void;
  connected(
    preserveDisplay: boolean,
    displayRingFenceToken: number,
    // The server-issued session id. Main cannot learn it any other way: only
    // main may intern profiling strings (the string table is single-writer by
    // design), so the id has to cross this boundary for `session_bound` to be
    // emitted with it.
    sessionId: string,
  ): void;
  disconnected(reason: string): void;
  metrics(metrics: Metrics): void;
  linkTick(tick: LinkTick): void;
  signalingStatus(status: SignalingStatus): void;
  dormant(isDormant: boolean): void;
  upgradeOutcome(report: BrowserUpgradeReport): void;
  /** The committed signaling carrier proved `address`: main's network visit follows it. */
  observedPath(address: string): void;
  /** OSC 8 link definitions: main resolves link ids when the user points at one. */
  displayLinkTable(reset: boolean, links: readonly DisplayLinkDefinition[]): void;
  /** `merkur open`: main opens or offers the URL; `(epoch, seq)` names the request. */
  openUrl(epoch: number, seq: number, url: string): void;
  terminalUi(effect: TerminalUiEffect): void;
}

export function createTransportStartEvents(
  startId: number,
  post: (message: TransportToMain) => void,
): TransportStartEvents {
  return {
    recoveryEvent(outcome, ended, atMs): void {
      post({ kind: 'recovery_event', startId, outcome, ended, atMs });
    },
    inputReady(): void {
      post({ kind: 'input_ready', startId });
    },
    connected(preserveDisplay, displayRingFenceToken, sessionId): void {
      post({
        kind: 'connected',
        startId,
        preserveDisplay,
        displayRingFenceToken,
        sessionId,
      });
    },
    disconnected(reason): void {
      post({ kind: 'disconnected', startId, reason });
    },
    metrics(metrics): void {
      post({ kind: 'metrics', startId, ...metrics });
    },
    linkTick(tick): void {
      post({ kind: 'link_tick', startId, ...tick });
    },
    signalingStatus(status): void {
      post({ kind: 'signaling_status', startId, status });
    },
    dormant(isDormant): void {
      post({ kind: 'dormant', startId, isDormant });
    },
    upgradeOutcome(report): void {
      post({ kind: 'upgrade_outcome', startId, report });
    },
    observedPath(address): void {
      post({ kind: 'observed_path', startId, address });
    },
    displayLinkTable(reset, links): void {
      post({ kind: 'display_link_table', startId, reset, links });
    },
    terminalUi(effect): void {
      post({ kind: 'terminal_ui', startId, effect });
    },
    openUrl(epoch, seq, url): void {
      post({ kind: 'open_url', startId, epoch, seq, url });
    },
  };
}
