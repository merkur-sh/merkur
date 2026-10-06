import type { Device } from '@merkur/shared';
import { Portal } from '@solidjs/web';
import { animate } from 'motion';
import {
  type Accessor,
  type Component,
  createEffect,
  createSignal,
  type Element,
  For,
  onCleanup,
  onSettled,
} from 'solid-js';

import type { BoxAccess } from '../api';
import type { Overlay } from '../app/navigation';
import { focusableWithin, trapTabKey } from '../lib/focus-trap';
import { fadeTransition, hintMotion, SURFACE_SPRING, springTransition } from '../lib/motion';
import { claimPress } from '../lib/press-claim';
import CreateBoxDialog from '../screens/CreateBoxDialog';
import DaemonLinkApprovalDialog from '../screens/DaemonLinkApprovalDialog';
import DeviceActionDialog from '../screens/DeviceActionDialog';
import CommandPalette, { type Command } from './CommandPalette';
import KeyboardHelp from './KeyboardHelp';
import { OVERLAY_AUTOFOCUS_ATTRIBUTE, type OverlayControls } from './overlay-controls';

/**
 * The single owner of every modal surface.
 *
 * Before this, each dialog carried its own `Portal`, Escape handler, Tab trap,
 * focus restore, and exit animation. That duplication is where the broken
 * states lived: two open dialogs both answered Escape, and dismissal *awaited*
 * the exit animation before releasing state, so for ~120ms a dialog was
 * invisible but still authoritative.
 *
 * Here dismissal pops navigation state immediately, and the departing node is
 * animated out of a private list only this component can see. State never waits
 * on animation.
 */

/**
 * Panel chrome that varies per dialog. The label ids point at headings the
 * dialog bodies render; the accessible name they produce is what the e2e suite
 * selects dialogs by, so these must match the heading ids exactly.
 */
interface PanelShape {
  readonly labelledBy: string;
  readonly describedBy?: string;
  readonly widthClass: string;
  /**
   * Panel padding. The palette runs its own edge-to-edge rows and separators,
   * so it takes the padding off rather than fighting it from the inside.
   */
  readonly padClass: string;
}

function panelShape(overlay: Overlay): PanelShape {
  switch (overlay.k) {
    case 'device-action':
      return {
        labelledBy: 'device-action-title',
        describedBy: 'device-action-description',
        widthClass: 'max-w-[390px]',
        padClass: 'p-5',
      };
    case 'create-box':
      return { labelledBy: 'create-box-title', widthClass: 'max-w-[420px]', padClass: 'p-5' };
    case 'link-approval':
      return {
        labelledBy: 'daemon-link-approval-title',
        widthClass: 'max-w-[420px]',
        padClass: 'p-5',
      };
    case 'command-palette':
      return {
        labelledBy: 'command-palette-title',
        widthClass: 'max-w-[560px]',
        padClass: 'p-0',
      };
    case 'session-ended':
      // A notice, not a form: narrower than the dialogs that carry fields, and
      // a little more air, so the single button does not crowd the copy.
      return {
        labelledBy: 'session-ended-title',
        describedBy: 'session-ended-description',
        widthClass: 'max-w-[340px]',
        padClass: 'px-6 pt-7 pb-6',
      };
    case 'keyboard-help':
      return {
        labelledBy: 'keyboard-help-title',
        describedBy: 'keyboard-help-description',
        widthClass: 'max-w-[440px]',
        padClass: 'p-5',
      };
  }
}

interface Entry {
  readonly overlay: Overlay;
  readonly exiting: Accessor<boolean>;
  readonly beginExit: () => void;
  readonly busy: Accessor<boolean>;
  readonly setBusy: (busy: boolean) => void;
  /**
   * Synchronously-visible mirrors of `busy` and `exiting`.
   *
   * A Solid 2 signal write is not visible to a read until the next flush, and
   * the dismissal guard runs in the same turn as the write it must observe: a
   * dialog finishes its work, clears busy, and immediately asks to close. Read
   * through the accessor, that guard still sees the stale `true` and silently
   * swallows the dismissal, leaving the dialog on screen forever.
   * `DaemonLinkApprovalDialog` keeps its own `pendingNow` for exactly this
   * reason; the guard needs the same thing.
   */
  busyNow: boolean;
  exitingNow: boolean;
  panel: HTMLElement | null;
}

interface Props {
  readonly boxAccess: BoxAccess | null;
  readonly overlays: readonly Overlay[];
  readonly devices: readonly Device[];
  readonly commands: readonly Command[];
  onDismiss(): void;
  onApproveDaemonLink(
    code: string,
    password: string,
  ): Promise<import('../auth/daemon-link-workflow').DaemonLinkApprovalOutcome>;
  onPreviewDaemonLink(
    code: string,
  ): Promise<{ readonly name: string; readonly platform: string } | null>;
  onCreateBox(boxId: string, password: string): Promise<boolean>;
  onJoinBoxWaitlist(): Promise<boolean>;
  onRemove(device: Device): Promise<boolean>;
  onRename(device: Device, name: string): Promise<boolean>;
}

const OverlayHost: Component<Props> = (props) => {
  const [entries, setEntries] = createSignal<readonly Entry[]>([]);

  function createEntry(overlay: Overlay): Entry {
    const [exiting, setExiting] = createSignal(false);
    const [busy, setBusy] = createSignal(false);
    const entry: Entry = {
      overlay,
      exiting,
      beginExit: () => {
        entry.exitingNow = true;
        setExiting(true);
      },
      busy,
      setBusy: (next) => {
        entry.busyNow = next;
        setBusy(next);
      },
      busyNow: false,
      exitingNow: false,
      panel: null,
    };
    return entry;
  }

  // Reconcile navigation's overlay stack into render entries. Overlays are
  // compared by identity, which is why navigation stores the pushed object
  // rather than rebuilding an equivalent one.
  createEffect(
    () => props.overlays,
    (next) => {
      setEntries((current) => {
        for (const entry of current) {
          if (!entry.exiting() && !next.includes(entry.overlay)) entry.beginExit();
        }
        const added = next
          .filter((overlay) => !current.some((entry) => entry.overlay === overlay))
          .map(createEntry);
        return added.length === 0 ? current : [...current, ...added];
      });
    },
  );

  /**
   * The entry that owns the keyboard: topmost, and not already leaving. Read on
   * every document keydown, so it walks the list without allocating a predicate.
   */
  function activeEntry(): Entry | null {
    const current = entries();
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const entry = current[index];
      if (entry !== undefined && !entry.exiting()) return entry;
    }
    return null;
  }

  onSettled(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const entry = activeEntry();
      if (entry === null) return;

      // Ctrl+[ is Escape — it is the same byte, and on this app's audience's
      // hands it is the more likely one. A terminal client whose dialogs
      // answered only the Escape key would be the one place in their day where
      // that reflex did nothing.
      if (event.key === 'Escape' || (event.ctrlKey && event.key === '[')) {
        if (entry.busy()) return;
        event.preventDefault();
        props.onDismiss();
        return;
      }
      if (entry.panel !== null) trapTabKey(event, entry.panel);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  // Scroll lock spans the whole stack, entries animating out included, so the
  // page cannot shift underneath a dialog mid-dismissal. Tracked with an
  // explicit held value rather than an effect-scoped one: re-reading
  // `overflow` when a second dialog stacks would capture the locked value and
  // "restore" to it once the stack emptied.
  let heldOverflow: string | null = null;
  function releaseScrollLock(): void {
    if (heldOverflow === null) return;
    document.body.style.overflow = heldOverflow;
    heldOverflow = null;
  }
  createEffect(
    () => entries().length > 0,
    (locked) => {
      if (locked) {
        if (heldOverflow !== null) return;
        heldOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return;
      }
      releaseScrollLock();
    },
  );
  onCleanup(releaseScrollLock);

  function renderOverlay(entry: Entry): Element {
    const controls: OverlayControls = {
      dismiss() {
        // The plain mirrors, not the accessors: this runs in the same turn as
        // the `setBusy(false)` that precedes it.
        if (entry.busyNow || entry.exitingNow) return;
        props.onDismiss();
      },
      setBusy: entry.setBusy,
    };
    const overlay = entry.overlay;

    switch (overlay.k) {
      case 'device-action': {
        // Snapshotted at open, like the dialog used to receive it: a device
        // that leaves the list mid-dialog must not blank the panel out from
        // under its own exit animation.
        const device = props.devices.find((candidate) => candidate.id === overlay.deviceId);
        if (device === undefined) return null;
        return (
          <DeviceActionDialog
            action={overlay.action}
            device={device}
            controls={controls}
            onRename={props.onRename}
            onRemove={props.onRemove}
          />
        );
      }
      case 'create-box':
        return (
          <CreateBoxDialog
            access={props.boxAccess}
            controls={controls}
            onCreate={props.onCreateBox}
            onJoinWaitlist={props.onJoinBoxWaitlist}
          />
        );
      case 'link-approval':
        return (
          <DaemonLinkApprovalDialog
            code={overlay.code}
            controls={controls}
            onApprove={props.onApproveDaemonLink}
            onPreview={props.onPreviewDaemonLink}
          />
        );
      case 'command-palette':
        return <CommandPalette commands={props.commands} controls={controls} />;
      case 'keyboard-help':
        return <KeyboardHelp />;
      case 'session-ended':
        // Centred like the terminal's status card, which is the other place
        // the app tells the reader something happened to them rather than
        // asking them for something. One mark, two lines, one way out.
        return (
          <div class="dialog items-center text-center">
            <div
              class="grid h-9 w-9 place-items-center rounded-full border border-solid border-line2 bg-raised text-meta shadow-lift"
              aria-hidden="true"
            >
              {/* The well is the circle; the cross is the only thing drawn in
                  it. Drawn in the header icons' hand: 24 grid, 1.8 stroke,
                  round caps. */}
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                class="h-[22px] w-[22px]"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m7 7 10 10m0-10L7 17" />
              </svg>
            </div>
            <div class="flex flex-col gap-[5px]">
              <h2
                id="session-ended-title"
                class="text-[16px] font-semibold leading-[1.35] tracking-[-0.018em] text-ink"
              >
                Session ended
              </h2>
              <p
                id="session-ended-description"
                class="text-[12.5px] leading-[1.55] text-meta text-balance"
              >
                Your session has expired or been revoked. Sign in again to continue.
              </p>
            </div>
            <button
              type="button"
              class="btn-primary mt-[6px] w-full"
              {...{ [OVERLAY_AUTOFOCUS_ATTRIBUTE]: '' }}
              onClick={() => controls.dismiss()}
            >
              Back to login
            </button>
          </div>
        );
    }
  }

  return (
    <Portal>
      <For each={entries()}>
        {(entry, index) => (
          <OverlayLayer
            entry={entry}
            depth={index()}
            shape={panelShape(entry.overlay)}
            onExited={() => setEntries((current) => current.filter((item) => item !== entry))}
            onDismiss={props.onDismiss}
          >
            {renderOverlay(entry)}
          </OverlayLayer>
        )}
      </For>
    </Portal>
  );
};

export default OverlayHost;

interface LayerProps {
  readonly entry: Entry;
  readonly depth: number;
  readonly shape: PanelShape;
  readonly children: Element;
  onExited(): void;
  onDismiss(): void;
}

/**
 * One backdrop and panel. Owns its entrance, its exit, and focus custody for
 * its own lifetime; it does not decide *whether* it is open — navigation does.
 */
const OverlayLayer: Component<LayerProps> = (props) => {
  let backdropEl!: HTMLDivElement;
  let panelEl!: HTMLDivElement;
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let enterBackdrop: ReturnType<typeof animate> | null = null;
  let enterPanel: ReturnType<typeof animate> | null = null;
  const exitMotion: ReturnType<typeof animate>[] = [];

  onSettled(() => {
    props.entry.panel = panelEl;

    enterBackdrop = animate(backdropEl, { opacity: [0, 1] }, fadeTransition(0.12));
    // The panel lands rather than fades: a spring with a trace of overshoot is
    // the difference between a surface that arrived and one that was drawn.
    // Only its geometry springs — opacity is over in a third of the time, so
    // the panel is solid well before it stops moving.
    enterPanel = animate(
      panelEl,
      { opacity: [0, 1], y: [12, 0], scale: [0.97, 1] },
      {
        y: springTransition(SURFACE_SPRING),
        scale: springTransition(SURFACE_SPRING),
        opacity: fadeTransition(0.1),
      },
    );
    hintMotion([panelEl], enterPanel);

    // Focus the control the dialog nominated, else whatever is first. Deferred
    // a microtask so it runs once the body has rendered its fields.
    queueMicrotask(() => {
      const nominated = panelEl.querySelector<HTMLElement>(`[${OVERLAY_AUTOFOCUS_ATTRIBUTE}]`);
      (nominated ?? focusableWithin(panelEl)[0])?.focus();
    });
  });

  createEffect(
    () => props.entry.exiting(),
    (exiting) => {
      if (!exiting) return;

      enterBackdrop?.stop();
      enterPanel?.stop();
      const backdropExit = animate(backdropEl, { opacity: 0 }, fadeTransition(0.1));
      // Nothing springs on the way out. A dismissal the user asked for should
      // be gone, not negotiated with, and a spring on an already-transparent
      // panel only holds its compositor layer open for the extra frames.
      const panelExit = animate(panelEl, { opacity: 0, y: 6, scale: 0.985 }, fadeTransition(0.12));
      exitMotion.push(backdropExit, panelExit);
      hintMotion([panelEl], panelExit);

      const finish = (): void => props.onExited();
      void Promise.allSettled([backdropExit.finished, panelExit.finished]).then(finish, finish);
    },
  );

  onCleanup(() => {
    props.entry.panel = null;
    enterBackdrop?.stop();
    enterPanel?.stop();
    for (const motion of exitMotion) motion.stop();
    // Reclaim focus only if nothing else has taken it. A dialog that opened
    // another one must not pull focus back out of its replacement.
    if (previouslyFocused?.isConnected === true && document.activeElement === document.body) {
      previouslyFocused.focus();
    }
  });

  return (
    <div
      ref={backdropEl}
      class="fixed inset-0 grid place-items-center bg-black/62 p-5 backdrop-blur-[3px]"
      style={{ 'z-index': 100 + props.depth }}
      onPointerDown={(event) => {
        const onBackdrop = event.target === event.currentTarget;
        // A press inside a dialog that is up belongs to the dialog. A press on
        // the backdrop, or anywhere at all once the layer is leaving, can still
        // be held when the layer is gone, and its click must not reach what the
        // layer covered.
        if (!onBackdrop && !props.entry.exiting()) return;
        claimPress();
        if (!onBackdrop || props.entry.busy() || props.entry.exiting()) return;
        props.onDismiss();
      }}
    >
      <div
        ref={panelEl}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.shape.labelledBy}
        aria-describedby={props.shape.describedBy}
        class={`w-full overflow-hidden rounded-lg border border-solid border-line2 bg-panel text-body shadow-over ${props.shape.widthClass} ${props.shape.padClass}`}
      >
        {props.children}
      </div>
    </div>
  );
};
