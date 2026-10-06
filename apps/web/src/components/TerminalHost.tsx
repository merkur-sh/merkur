import { type Accessor, type Component, createEffect, createSignal, For } from 'solid-js';
import TerminalPanel, {
  type TerminalPanelHandle,
  type TerminalSize,
} from '../screens/TerminalPanel';
import type { TerminalAppearance } from '../terminal/appearance';
import type { TerminalRingBundle } from '../terminal/ring-bundle';
import type { TerminalStage, TerminalStatusMode } from '../terminal/status-presentation';
import type { TerminalWorkerClient } from '../terminal-worker-client';
import type { TerminalWorkerDiagnostics } from '../terminal-worker-protocol';
import type { TerminalSession } from '../transport-worker-client';
import { reconcileTerminalView } from './terminal-view-lifetime';
import ViewLayer from './ViewLayer';

/**
 * The terminal route: its layer, and the lifetime of the panel inside it.
 *
 * The layer itself is permanent, because every other route exists from the
 * moment the shell mounts and that is what gives it a resting state to move out
 * of. A layer created by the ring bundle instead came into being at the same
 * moment the session did, so when the two landed in one flush it mounted
 * already showing, with nowhere to have come from — entering a terminal had no
 * transition at all.
 *
 * The panel's lifetime is the harder half. It is keyed on the ring bundle
 * because its worker is handed those SharedArrayBuffers once, at mount, and
 * never re-reads the prop; and leaving the terminal drops the bundle in the
 * same flush as the route change, so the panel used to vanish instantly and the
 * layer animated an empty box. What the user saw was the terminal cut to black
 * and the machine list scale up behind it.
 *
 * So the departing panel is kept here, and only here, until the layer reports
 * it has finished leaving — the same trick `OverlayHost` plays with dialogs.
 * App state never waits on that: the session is already closed, the worker
 * already terminated, the rings already released. What survives is a picture.
 *
 * Two things make holding a dead panel safe, and both are load-bearing:
 *
 * - **It cannot talk back.** A retired panel's cleanup still runs — that is how
 *   its ResizeObserver, its worker handle, and the document scroll lock are
 *   released — and that cleanup calls `onWorkerClose` and
 *   `onRegisterTerminalPanel(null)`. Arriving late, those would tear down a
 *   session the user has already started. Every callback is therefore gated on
 *   the entry still being current.
 * - **It stops reading the app.** Its props are frozen at the moment it
 *   retires. Left live they would report a terminal that no longer exists —
 *   `stage` falling to idle, the status overlay reappearing, `LinkStatus`
 *   dropping to its not-ready pulse — which is a screen the user never saw,
 *   playing itself out as the panel fades.
 */

/**
 * The panel's value props, as of one moment. `session` is frozen to the object
 * rather than to a rendered state: the accessor going null is the loud change
 * (`LinkStatus` swaps to a grey not-ready band), and holding the last session
 * keeps the widget showing the link it had while it leaves.
 */
interface PanelFrame {
  readonly deviceName: string;
  readonly status: string;
  readonly statusMode: TerminalStatusMode;
  readonly stage: TerminalStage;
  readonly diagnostics: TerminalWorkerDiagnostics | null;
  readonly terminalAppearance: TerminalAppearance;
  readonly focusMode: boolean;
  readonly session: Accessor<TerminalSession | null>;
}

interface Entry {
  readonly rings: TerminalRingBundle;
  readonly frozen: Accessor<PanelFrame | null>;
  retire(frame: PanelFrame): void;
  /**
   * Synchronously-visible mirror of `frozen() !== null`.
   *
   * A Solid 2 signal write is not visible to a read until the next flush, and
   * the callback gate has to hold in the same turn as the write it guards: the
   * entry retires and the panel's cleanup fires while that flush is still in
   * progress. Read through the accessor, the gate would still see the stale
   * `false` and let a dead panel deregister the live one. `OverlayHost` keeps
   * `busyNow`/`exitingNow` for exactly this reason.
   */
  retiredNow: boolean;
}

interface Props {
  readonly active: boolean;
  readonly rings: TerminalRingBundle | null;
  readonly deviceName: string;
  readonly status: string;
  readonly statusMode: TerminalStatusMode;
  readonly stage: TerminalStage;
  readonly diagnostics: TerminalWorkerDiagnostics | null;
  readonly terminalAppearance: TerminalAppearance;
  readonly session: Accessor<TerminalSession | null>;
  readonly focusMode: boolean;
  onToggleFocusMode(): void;
  onBack(): void;
  onRetry(): void;
  onDisplayFrameReceived(): void;
  onDisplayFrameApplied(displayKind: 'display_snapshot' | 'display_delta'): void;
  onFirstDisplayGpuComplete(
    displayKind: 'display_snapshot' | 'display_delta' | 'display_resume',
  ): void;
  onWorkerReady(client: TerminalWorkerClient): void;
  onWorkerClose(): void;
  onWorkerDiagnostics(diagnostics: TerminalWorkerDiagnostics): void;
  onWorkerFatal(message: string): void;
  onRegisterTerminalPanel(handle: TerminalPanelHandle | null): void;
  onTerminalResize(size: TerminalSize): void;
  resolveLink(id: number): string | undefined;
}

const TerminalHost: Component<Props> = (props) => {
  const [entries, setEntries] = createSignal<readonly Entry[]>([]);

  /**
   * Whether the layer is on screen, which is not the same question as whether
   * the terminal is the current route: between the two lies the exit. Held as a
   * plain value because the reconciliation below reads it in the same turn the
   * route changes.
   */
  let showing = false;

  function currentFrame(): PanelFrame {
    const session = props.session();
    return {
      deviceName: props.deviceName,
      status: props.status,
      statusMode: props.statusMode,
      stage: props.stage,
      diagnostics: props.diagnostics,
      terminalAppearance: props.terminalAppearance,
      focusMode: props.focusMode,
      session: () => session,
    };
  }

  function createEntry(rings: TerminalRingBundle): Entry {
    const [frozen, setFrozen] = createSignal<PanelFrame | null>(null);
    const entry: Entry = {
      rings,
      frozen,
      retire: (frame) => {
        entry.retiredNow = true;
        setFrozen(frame);
      },
      retiredNow: false,
    };
    return entry;
  }

  function dropRetired(): void {
    setEntries((current) => {
      const kept = current.filter((entry) => !entry.retiredNow);
      return kept.length === current.length ? current : kept;
    });
  }

  createEffect(
    () => props.active,
    (active) => {
      if (active) showing = true;
    },
  );

  createEffect(
    () => props.rings,
    (rings) => {
      switch (reconcileTerminalView({ hasRings: rings !== null, active: props.active, showing })) {
        case 'replace':
          // Supersedes everything at once. Nothing is retained across a new
          // bundle: a panel left painting the previous machine while the new
          // session waits on a display frame is the exact failure the keying
          // exists to prevent, and it is worse than a missing exit animation.
          if (rings !== null) setEntries([createEntry(rings)]);
          return;
        case 'retire':
          for (const entry of entries()) entry.retire(currentFrame());
          return;
        case 'clear':
          setEntries([]);
          return;
      }
    },
  );

  return (
    <ViewLayer
      active={props.active}
      depth="terminal"
      onHidden={() => {
        showing = false;
        dropRetired();
      }}
    >
      <For each={entries()}>
        {(entry) => {
          // Frozen frame if the entry has retired, the live props if not. One
          // accessor rather than a conditional per prop: the frame carries the
          // panel's whole value surface, so a prop wired to only one of the two
          // is a compile error rather than a field that quietly stays live and
          // reports a terminal that no longer exists.
          const view = (): PanelFrame | Props => entry.frozen() ?? props;
          return (
            <TerminalPanel
              deviceName={view().deviceName}
              status={view().status}
              statusMode={view().statusMode}
              stage={view().stage}
              diagnostics={view().diagnostics}
              terminalAppearance={view().terminalAppearance}
              session={view().session}
              rings={entry.rings}
              focusMode={view().focusMode}
              onToggleFocusMode={() => {
                if (!entry.retiredNow) props.onToggleFocusMode();
              }}
              onBack={() => {
                if (!entry.retiredNow) props.onBack();
              }}
              onRetry={() => {
                if (!entry.retiredNow) props.onRetry();
              }}
              onDisplayFrameReceived={() => {
                if (!entry.retiredNow) props.onDisplayFrameReceived();
              }}
              onDisplayFrameApplied={(kind) => {
                if (!entry.retiredNow) props.onDisplayFrameApplied(kind);
              }}
              onFirstDisplayGpuComplete={(kind) => {
                if (!entry.retiredNow) props.onFirstDisplayGpuComplete(kind);
              }}
              onWorkerReady={(client) => {
                if (!entry.retiredNow) props.onWorkerReady(client);
              }}
              onWorkerClose={() => {
                if (!entry.retiredNow) props.onWorkerClose();
              }}
              onWorkerDiagnostics={(diagnostics) => {
                if (!entry.retiredNow) props.onWorkerDiagnostics(diagnostics);
              }}
              onWorkerFatal={(message) => {
                if (!entry.retiredNow) props.onWorkerFatal(message);
              }}
              onRegisterTerminalPanel={(handle) => {
                if (!entry.retiredNow) props.onRegisterTerminalPanel(handle);
              }}
              onTerminalResize={(size) => {
                if (!entry.retiredNow) props.onTerminalResize(size);
              }}
              // A retired panel is animating out over a session that is gone;
              // its links resolve to nothing rather than to the next session's.
              resolveLink={(id) => (entry.retiredNow ? undefined : props.resolveLink(id))}
            />
          );
        }}
      </For>
    </ViewLayer>
  );
};

export default TerminalHost;
