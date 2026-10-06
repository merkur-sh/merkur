import { createLogger } from '@merkur/logger';
import { OUT_EASE } from '@merkur/quicksilver/motion';
import { computeTerminalGrid } from '@merkur/shared';
import { Effect } from 'effect';
import { animate } from 'motion';
import {
  type Accessor,
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onSettled,
  Show,
} from 'solid-js';
import LinkStatus from '../components/LinkStatus';
import { ariaBool } from '../lib/aria';
import type { TerminalModifierState } from '../lib/key-record';
import { motionDuration } from '../lib/motion';
import { createOwnedAnimationFrame } from '../lib/owned-scheduled-callback';
import { createWakeLockAcquisitionGate } from '../lib/wake-lock-acquisition';
import { terminalElapsedMsSince, terminalPerfNowMs } from '../perf/terminal-latency';
import {
  type AccessibilityMirror,
  createAccessibilityMirror,
} from '../terminal/accessibility-mirror';
import { TERMINAL_LINE_HEIGHT, type TerminalAppearance } from '../terminal/appearance';
import { createEditingSurface, type EditingSurface } from '../terminal/editing-surface';
import { TERMINAL_FONTS } from '../terminal/fonts';
import {
  createTerminalInputController,
  type TerminalInputController,
} from '../terminal/input-controller';
import { recordKeyboardBreak } from '../terminal/keyboard-diagnostics-store';
import type { TerminalRingBundle } from '../terminal/ring-bundle';
import type { TerminalStage, TerminalStatusMode } from '../terminal/status-presentation';
import { rgbCss, TERMINAL_THEMES } from '../terminal/themes';
import {
  createTerminalKeyboardLayout,
  DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
  isTouchKeyboardEligible,
  loadVirtualKeyboardPreferences,
  observeVirtualKeyboardPreferences,
  saveVirtualKeyboardPreferences,
  VIRTUAL_KEY_DEFINITIONS,
  type VirtualKeyboardPreferences,
  type VirtualKeyDefinition,
} from '../terminal/virtual-keyboard';
import {
  type CursorRect,
  createTerminalWorkerClient,
  type TerminalWorkerClient,
} from '../terminal-worker-client';
import type { TerminalWorkerDiagnostics } from '../terminal-worker-protocol';
import type { TerminalSession } from '../transport-worker-client';
import TerminalStatusOverlay from './TerminalStatusOverlay';
import VirtualTerminalKeyboard from './VirtualTerminalKeyboard';

const logger = createLogger('web-terminal');
// Fast enough that the panel's "…ms ago" figures read as a live clock, slow
// enough to stay far off the render path.
const DIAGNOSTICS_POLL_INTERVAL_MS = 500;
/**
 * Selection intent is Shift held *alone*, and it is deliberately not the same
 * thing as the Shift key being down.
 *
 * Shift is pressed for every capital letter, so gating directly on the key would
 * fetch the viewport and rebuild the layer on each one, and drop a
 * `pointer-events: auto` surface over the grid mid-sentence. Enabling is
 * therefore deferred briefly and any other key cancels it, which is exactly the
 * difference between "shift-H" and "reaching for a selection". Disabling stays
 * immediate: letting go must never leave the layer over the terminal.
 *
 * One rule covers both platforms. A selectable DOM text layer and a custom
 * touch-gesture terminal cannot share the same pixels, so touch needs an
 * explicit mode; on desktop the same gate already overrides an application's
 * mouse reporting. `TouchEvent.shiftKey` reports only a hardware modifier, which
 * is why the custom keyboard's virtual Shift is read from its own state here.
 */
const SELECTION_INTENT_DELAY_MS = 200;

function wireSelectionMode(client: TerminalWorkerClient, virtualShift: () => boolean): void {
  let hardwareShift = false;
  let intentTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelPendingIntent = (): void => {
    if (intentTimer === null) return;
    clearTimeout(intentTimer);
    intentTimer = null;
  };

  const sync = (): void => {
    cancelPendingIntent();
    if (!(hardwareShift || virtualShift())) {
      client.setSelectionEnabled(false);
      return;
    }
    intentTimer = setTimeout(() => {
      intentTimer = null;
      client.setSelectionEnabled(true);
    }, SELECTION_INTENT_DELAY_MS);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Shift') {
      // Shift plus another key is capitalisation, not a reach for a selection.
      cancelPendingIntent();
      return;
    }
    if (hardwareShift) return;
    hardwareShift = true;
    sync();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== 'Shift' || !hardwareShift) return;
    hardwareShift = false;
    sync();
  };
  // A tab switch mid-drag never delivers the keyup, which would strand the layer
  // over the grid and swallow every touch that followed.
  const onBlur = (): void => {
    if (!hardwareShift) return;
    hardwareShift = false;
    sync();
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  onCleanup(() => {
    cancelPendingIntent();
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  });
  createEffect(
    () => virtualShift(),
    () => sync(),
  );
}

const EMPTY_VIRTUAL_MODIFIERS: TerminalModifierState = {
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
};

export interface TerminalSize {
  /** Cell dimensions in unsigned 16.16 logical pixels, measured by the renderer. */
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalPanelHandle {
  focus(): void;
  syncSize(): TerminalSize | null;
  /** Drop input buffered but never admitted. See `discardPendingInput`. */
  discardPendingInput(): void;
  /** Release input parked while the session would not admit it. */
  drainPendingInput(): void;
}

interface Props {
  deviceName: string;
  status: string;
  statusMode: TerminalStatusMode;
  stage: TerminalStage;
  diagnostics: TerminalWorkerDiagnostics | null;
  terminalAppearance: TerminalAppearance;
  session: Accessor<TerminalSession | null>;
  rings: TerminalRingBundle;
  /**
   * Chrome-free terminal. Owned by the app rather than this panel: the panel is
   * keyed on its ring bundle, so switching machines from the palette replaces
   * it, and panel-local state would drop the user out of focus mode on a
   * switch they made *from inside* it.
   */
  focusMode: boolean;
  onToggleFocusMode: () => void;
  onBack: () => void;
  onRetry: () => void;
  onDisplayFrameReceived: () => void;
  onDisplayFrameApplied: (displayKind: 'display_snapshot' | 'display_delta') => void;
  onFirstDisplayGpuComplete: (
    displayKind: 'display_snapshot' | 'display_delta' | 'display_resume',
  ) => void;
  /** Receives the worker client once the terminal worker is ready. */
  onWorkerReady: (client: TerminalWorkerClient) => void;
  /** Called on cleanup so App can clear its workerClient reference. */
  onWorkerClose: () => void;
  onWorkerDiagnostics: (diagnostics: TerminalWorkerDiagnostics) => void;
  onWorkerFatal: (message: string) => void;
  onRegisterTerminalPanel: (handle: TerminalPanelHandle | null) => void;
  onTerminalResize: (size: TerminalSize) => void;
  /** The URI the connected daemon defined for an OSC 8 link id. */
  resolveLink: (id: number) => string | undefined;
}

const TerminalPanel: Component<Props> = (props) => {
  let panelEl!: HTMLElement;
  let containerEl!: HTMLDivElement;
  let headerEl!: HTMLElement;
  const touchKeyboardEligible = isTouchKeyboardEligible();
  const [nativeKeyboardActive, setNativeKeyboardActive] = createSignal(false);
  const [terminalViewportHeight, setTerminalViewportHeight] = createSignal<number | null>(null);
  const [virtualKeyboardPreferences, setVirtualKeyboardPreferences] =
    createSignal<VirtualKeyboardPreferences>(
      touchKeyboardEligible
        ? loadVirtualKeyboardPreferences()
        : {
            visible: false,
            toolbarExpanded: false,
            toolbarKeys: [],
            macros: [],
            layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
            keyPreview: true,
          },
    );
  const virtualKeyboardLayout = createMemo(() =>
    createTerminalKeyboardLayout(virtualKeyboardPreferences().layerKeyOrder),
  );
  // The preferences screen is not the only writer: the account's arrangement
  // arrives from another device after sign-in, and a terminal is often already
  // open by then. Seeding at mount alone left this panel drawing the previous
  // layout until it was next remounted.
  if (touchKeyboardEligible) {
    onSettled(() => observeVirtualKeyboardPreferences(setVirtualKeyboardPreferences));
  }
  const [virtualModifiers, setVirtualModifiers] =
    createSignal<TerminalModifierState>(EMPTY_VIRTUAL_MODIFIERS);

  // Non-reactive char metrics — only affect col/row computation.
  let charW = 0;
  let charH = 0;
  // Local ref so syncSize and paste can reach the worker without going through a signal.
  let workerClient: TerminalWorkerClient | null = null;
  // Owns every input path (keydown fast path, paste, composition, predictions).
  let inputController: TerminalInputController | null = null;
  // IME input surface: cursor-anchored EditContext/textarea on desktop and the
  // existing pinned textarea tier on touch.
  let editingSurface: EditingSurface | null = null;
  let lastCursorRect: CursorRect | null = null;
  // True while the browser owns a selection over the grid. Focus must not move
  // while it does: focusing the editing surface moves the document selection
  // into its `EditContext`, which collapses the selection the user just made —
  // every mouse selection died on the click that ended its own drag.
  let selectionActive = false;
  let accessibilityMirror: AccessibilityMirror | null = null;
  let lastSyncedCols = 0;
  let lastSyncedRows = 0;
  let lastSyncedCellWidth = 0;
  let lastSyncedCellHeight = 0;
  const geometryFrame = createOwnedAnimationFrame(
    (callback) => requestAnimationFrame(callback),
    (handle) => cancelAnimationFrame(handle),
  );
  let geometryDirty = false;
  const viewportHeightFrame = createOwnedAnimationFrame(
    (callback) => requestAnimationFrame(callback),
    (handle) => cancelAnimationFrame(handle),
  );
  let viewportHeightPrevious: number | null = null;
  let terminalExitPending = false;

  // ── Viewport sizing ────────────────────────────────────────────────────────

  function syncSize(): TerminalSize | null {
    if (!workerClient || terminalExitPending) return null;

    const rect = containerEl.getBoundingClientRect();
    if (!rect.width || !rect.height || !charW || !charH) return null;

    const { columns: cols, rows } = computeTerminalGrid(rect.width, rect.height, charW, charH);
    workerClient.resize(cols, rows);
    const cellWidth = Math.round(charW * 65536);
    const cellHeight = Math.round(charH * 65536);
    const size = { cols, rows, cellWidth, cellHeight };
    if (
      cols === lastSyncedCols &&
      rows === lastSyncedRows &&
      cellWidth === lastSyncedCellWidth &&
      cellHeight === lastSyncedCellHeight
    ) {
      return size;
    }
    lastSyncedCols = cols;
    lastSyncedRows = rows;
    lastSyncedCellWidth = cellWidth;
    lastSyncedCellHeight = cellHeight;
    // The grid re-indexes every row, so the screen-reader mirror's row-keyed
    // baseline no longer describes the same lines.
    accessibilityMirror?.noteResized();
    props.onTerminalResize(size);
    return size;
  }

  /**
   * Marks the terminal geometry dirty; the commit lands on the first animation
   * frame that no further edge arrived on.
   *
   * This replaced a loop that re-read layout every frame and committed once two
   * consecutive reads matched. That read the DOM once per frame for the whole
   * duration of a window drag, decided settlement by comparing seven floats,
   * and committed at every pause in pointer motion — each commit rewriting the
   * canvas geometry and, whenever the grid changed, starting a 36-frame
   * refresh-rate burst. Every input that can move the grid already arrives as
   * an event, so counting edges is exact and costs no layout reads.
   */
  function markGeometryDirty(): void {
    if (terminalExitPending) return;
    geometryDirty = true;
    geometryFrame.arm(commitGeometryWhenSettled);
  }

  function commitGeometryWhenSettled(): void {
    if (terminalExitPending) return;
    if (geometryDirty) {
      geometryDirty = false;
      geometryFrame.arm(commitGeometryWhenSettled);
      return;
    }
    syncSize();
  }

  // ── Mount — worker + resize observer ──────────────────────────────────────

  onSettled(() => {
    const headerMotion = animate(
      headerEl,
      {
        opacity: [0, 1],
        transform: ['translateY(-8px)', 'translateY(0px)'],
      },
      {
        duration: motionDuration(0.16),
        ease: OUT_EASE,
      },
    );

    const appearance = props.terminalAppearance;
    const client = createTerminalWorkerClient(
      containerEl,
      appearance.fontSize,
      TERMINAL_LINE_HEIGHT,
      {
        onReady(cols, rows, w, h) {
          charW = w;
          charH = h;
          lastSyncedCols = cols;
          lastSyncedRows = rows;
          lastSyncedCellWidth = Math.round(w * 65536);
          lastSyncedCellHeight = Math.round(h * 65536);
          props.onTerminalResize({
            cols,
            rows,
            cellWidth: lastSyncedCellWidth,
            cellHeight: lastSyncedCellHeight,
          });
          markGeometryDirty();
          props.onWorkerReady(client);
        },
        onDisplayFrameReceived() {
          // The first frame of an output burst. The mirror takes its silent
          // baseline here; announcements wait for the worker's settle below.
          accessibilityMirror?.noteOutputChanged();
          props.onDisplayFrameReceived();
        },
        onDisplayOutputSettled() {
          accessibilityMirror?.noteOutputSettled();
        },
        onDisplayFrameApplied(displayKind) {
          props.onDisplayFrameApplied(displayKind);
        },
        onFirstDisplayGpuComplete(displayKind) {
          props.onFirstDisplayGpuComplete(displayKind);
        },
        onDisplayStateReady() {
          logger.info('display_state_ready');
        },
        onDisplayStateApplied() {
          logger.info('display_state_applied');
        },
        onDisplaySnapshotRequest() {
          props.session()?.requestDisplaySnapshot();
        },
        onWorkerHealth(diagnostics) {
          props.onWorkerDiagnostics(diagnostics);
        },
        onMetrics(w, h) {
          charW = w;
          charH = h;
          // Font promotion changes cell metrics without changing the container's
          // content box, so there is no layout animation to settle here. Commit
          // the matching grid immediately: leaving the old rows/columns active
          // until a later ResizeObserver edge can make startup render against
          // mismatched CSS/backing geometry, which a top-bar toggle only happens
          // to repair by forcing another resize.
          syncSize();
        },
        onFatal(message) {
          logger.error('terminal_worker_fatal');
          props.onWorkerFatal(message);
        },
        onMouseInput(record) {
          inputController?.sendPointerRecord(record);
        },
        onInputReportsRaised() {
          props.session()?.releaseDeferredInput();
        },
        onCursorMove(rect) {
          lastCursorRect = rect;
          editingSurface?.setCursorRect(rect);
        },
        onSelectionActive(active) {
          selectionActive = active;
          if (active) return;
          // Nothing is selected any more, so the editing surface takes the
          // caret back: IME composition, the emoji picker and dead keys all
          // anchor on it. Ordinary keys never needed it — the input controller
          // listens on the window.
          //
          // Only if the caret never left the panel, though. The layer also
          // comes down when the user clicks into something else on the page,
          // and pulling focus out of whatever they just clicked is the same
          // theft this rule exists to stop.
          if (panelEl.contains(document.activeElement)) focus();
        },
        resolveLink(id) {
          return props.resolveLink(id);
        },
        onLinkActivated() {
          clearVirtualModifiers();
        },
      },
      props.rings.frameRing,
      props.rings.viewerOutputRing,
      props.rings.predictionAdmission,
      props.rings.predictionFastPath,
      props.rings.presentationCadence,
      props.rings.displayReceiverProfile,
      props.rings.terminalPerfRing,
      props.rings.terminalRingWakePort,
      props.rings.displayRingWakeMode,
      {
        fontFamily: TERMINAL_FONTS[appearance.fontFamilyId],
        theme: TERMINAL_THEMES[appearance.themeId],
      },
    );

    workerClient = client;

    wireSelectionMode(client, () => virtualModifiers().shift);
    // The touch keyboard's Ctrl or Cmd latch turns the next tap on a link into
    // opening it, as holding the key does for a mouse.
    createEffect(
      () => virtualModifiers().ctrl || virtualModifiers().meta,
      (latched) => client.setLinkModifierLatched(latched),
    );

    // Screen-reader mirror: the WebGL canvas is opaque to assistive tech, so
    // new output is announced through a hidden polite live region.
    const mirror = createAccessibilityMirror({
      getViewportText: (cb) => client.getViewportText(cb),
      getCursorRow: () => lastCursorRect?.row ?? null,
      isSuppressed: () => client.isAltScreenActive(),
    });
    containerEl.appendChild(mirror.element);
    accessibilityMirror = mirror;
    onCleanup(() => {
      mirror.destroy();
      if (accessibilityMirror === mirror) accessibilityMirror = null;
    });

    // Desktop gets a cursor-anchored EditContext/textarea surface; touch gets
    // a pinned textarea tier with soft-keyboard delete-intent dedup.
    // Virtual-keyboard visibility policy stays here in the panel.
    const surface = createEditingSurface(
      {
        onInsertText: (text) => inputController?.sendNativeText(text),
        onPreedit: (text, caret) => renderPreedit(text, caret),
        onCompositionStart: () => inputController?.notifyCompositionStart(),
        onCompositionEnd: () => inputController?.notifyCompositionEnd(),
        // The native keyboard's own keys: none of them is an on-screen keyboard
        // commit, so each ends the line the correction analysis holds.
        onDeleteBackward: () => {
          inputController?.sendVirtualKey(VIRTUAL_KEY_DEFINITIONS.backspace);
          recordKeyboardBreak();
        },
        onDeleteForward: () => {
          inputController?.sendVirtualKey(VIRTUAL_KEY_DEFINITIONS.delete);
          recordKeyboardBreak();
        },
        onEnter: () => {
          inputController?.sendVirtualKey(VIRTUAL_KEY_DEFINITIONS.enter);
          recordKeyboardBreak();
        },
        onPaste: (text) => inputController?.sendPaste(text),
        onFocusChange: (focused) => {
          if (!touchKeyboardEligible) return;
          if (focused) {
            setNativeKeyboardActive(true);
            return;
          }
          setNativeKeyboardActive(false);
          clearVirtualModifiers();
        },
      },
      containerEl,
      { touch: touchKeyboardEligible },
    );
    // Touch keeps the JSX textarea's DOM placement (panel level); desktop
    // anchors inside the terminal container.
    (touchKeyboardEligible ? panelEl : containerEl).appendChild(surface.element);
    editingSurface = surface;
    if (lastCursorRect !== null) surface.setCursorRect(lastCursorRect);
    onCleanup(() => {
      surface.destroy();
      if (editingSurface === surface) editingSurface = null;
    });

    // Narrow per-field effects (initial values were applied at client
    // creation): a theme-only change must not re-fetch fonts or resize,
    // and a size change must not re-send the font family. Memos provide
    // the value comparison so a wholesale appearance-object swap only
    // triggers the effects whose field actually changed.
    const appearanceFontFamilyId = createMemo(() => props.terminalAppearance.fontFamilyId);
    const appearanceFontSize = createMemo(() => props.terminalAppearance.fontSize);
    const appearanceThemeId = createMemo(() => props.terminalAppearance.themeId);
    createEffect(
      appearanceFontFamilyId,
      (fontFamilyId) => {
        client.updateFontFamily(TERMINAL_FONTS[fontFamilyId]);
        markGeometryDirty();
      },
      { defer: true },
    );
    createEffect(
      appearanceFontSize,
      (fontSize) => {
        client.updateFont(fontSize, TERMINAL_LINE_HEIGHT);
        markGeometryDirty();
      },
      { defer: true },
    );
    createEffect(
      appearanceThemeId,
      (themeId) => {
        client.updateTheme(TERMINAL_THEMES[themeId]);
      },
      { defer: true },
    );

    const ro = new ResizeObserver(() => markGeometryDirty());
    ro.observe(containerEl);

    return () => {
      ro.disconnect();
      geometryDirty = false;
      geometryFrame.cancel();
      client.close();
      workerClient = null;
      props.onWorkerClose();
      headerMotion.stop();
    };
  });

  // ── Mount — document scroll lock ───────────────────────────────────────────

  onSettled(() => {
    const html = document.documentElement;
    const body = document.body;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const previousHtmlOverflow = html.style.overflow;
    const previousHtmlOverscrollBehaviorY = html.style.overscrollBehaviorY;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyOverscrollBehaviorY = body.style.overscrollBehaviorY;

    html.style.overflow = 'hidden';
    html.style.overscrollBehaviorY = 'none';
    // PhaseHost already pins the shell to the viewport. Do not pin its body
    // ancestor as well: a saved pre-rotation offset must not become a second
    // coordinate system for the terminal's layout and touch targets.
    body.style.overflow = 'hidden';
    body.style.overscrollBehaviorY = 'none';

    onCleanup(() => {
      html.style.overflow = previousHtmlOverflow;
      html.style.overscrollBehaviorY = previousHtmlOverscrollBehaviorY;
      body.style.overflow = previousBodyOverflow;
      body.style.overscrollBehaviorY = previousBodyOverscrollBehaviorY;
      window.scrollTo(scrollX, scrollY);
    });
  });

  // ── Mount — screen wake lock ───────────────────────────────────────────────

  onSettled(() => {
    const wakeLockApi = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock;
    if (!wakeLockApi) return;

    const acquisitionGate = createWakeLockAcquisitionGate(document.visibilityState === 'visible');
    let sentinel: WakeLockSentinel | null = null;

    const acquireWakeLockEffect = Effect.tryPromise({
      try: () => wakeLockApi.request('screen'),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
    const releaseWakeLockEffect = (lock: WakeLockSentinel) =>
      Effect.tryPromise({
        try: () => lock.release(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.catch(() => Effect.void));

    const startAcquire = (): void => {
      if (!acquisitionGate.beginAcquire()) return;

      Effect.runFork(
        acquireWakeLockEffect.pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.sync(() => {
                const disposition = acquisitionGate.denied();
                if (disposition === 'ignored') return;
                logger.warn('wake_lock_request_failed', { err: String(error) });
                if (disposition === 'lifecycle-reset') startAcquire();
              }),
            onSuccess: (nextSentinel) =>
              Effect.gen(function* () {
                const visible = document.visibilityState === 'visible';
                acquisitionGate.visibilityChanged(visible);
                if (!acquisitionGate.acquired()) {
                  yield* releaseWakeLockEffect(nextSentinel);
                  return;
                }
                if (!visible) {
                  yield* releaseWakeLockEffect(nextSentinel);
                  if (acquisitionGate.released()) startAcquire();
                  return;
                }

                sentinel = nextSentinel;
                nextSentinel.addEventListener(
                  'release',
                  () => {
                    if (sentinel !== nextSentinel) return;
                    sentinel = null;
                    if (acquisitionGate.released()) startAcquire();
                  },
                  { once: true },
                );
              }),
          }),
        ),
      );
    };

    const onVisibility = (): void => {
      if (acquisitionGate.visibilityChanged(document.visibilityState === 'visible')) {
        startAcquire();
      }
    };

    startAcquire();
    document.addEventListener('visibilitychange', onVisibility);

    onCleanup(() => {
      acquisitionGate.dispose();
      document.removeEventListener('visibilitychange', onVisibility);
      const heldSentinel = sentinel;
      sentinel = null;
      if (heldSentinel !== null) Effect.runFork(releaseWakeLockEffect(heldSentinel));
    });
  });

  // ── Mount — input controller (keyboard, paste, composition, predictions) ───

  onSettled(() => {
    const controller = createTerminalInputController({
      touchKeyboardEligible,
      ownerEl: panelEl,
      getSession: () => props.session(),
      getWorkerClient: () => workerClient,
      getTouchSurfaceEl: () => (touchKeyboardEligible ? (editingSurface?.element ?? null) : null),
      getVirtualModifiers: () => virtualModifiers(),
      clearVirtualModifiers,
      focusTerminal: focus,
      onToggleFocusMode: () => props.onToggleFocusMode(),
      onInputOverflow: () => logger.warn('input_queue_overflow'),
      onNonKeyboardInput: recordKeyboardBreak,
    });
    inputController = controller;
    controller.attach();
    onCleanup(() => {
      controller.destroy();
      if (inputController === controller) inputController = null;
    });
  });

  // ── Mount — diagnostics polling ────────────────────────────────────────────
  // The worker posts health once, when it becomes ready, and never again on its
  // own — so every figure below (queue depth, pending frames, frame ages) was
  // frozen at startup. Health is a pull, and the only thing that reads it is
  // the diagnostics panel, so the poll lives and dies with that panel rather
  // than costing production builds a periodic worker round-trip.
  onSettled(() => {
    if (!import.meta.env.DEV) return;

    const interval = window.setInterval(() => {
      workerClient?.requestHealth();
    }, DIAGNOSTICS_POLL_INTERVAL_MS);
    onCleanup(() => window.clearInterval(interval));
  });

  // ── Focus ──────────────────────────────────────────────────────────────────

  function focus(): void {
    // The selection layer is up: the gesture owns focus until it is done.
    if (selectionActive) return;
    if (touchKeyboardEligible) {
      if (virtualKeyboardPreferences().visible && document.activeElement !== panelEl) {
        panelEl.focus({ preventScroll: true });
      }
      return;
    }
    // Desktop: focus the editing surface so IME composition (CJK, emoji
    // picker, dead keys) has an editable element to attach to. Normal keys
    // still flow through the window keydown fast path.
    if (editingSurface !== null) {
      editingSurface.focus();
      return;
    }
    panelEl.focus();
  }

  // Register imperative terminal actions for session lifecycle boundaries.
  onSettled(() => {
    props.onRegisterTerminalPanel({
      focus,
      syncSize,
      discardPendingInput: () => inputController?.discardPendingInput(),
      drainPendingInput: () => inputController?.drainPendingInput(),
    });
    return () => props.onRegisterTerminalPanel(null);
  });

  // Any of these changing alters the space the grid has to fill.
  createEffect(
    () =>
      [
        props.focusMode,
        nativeKeyboardActive(),
        terminalViewportHeight(),
        virtualKeyboardPreferences().visible,
      ] as const,
    () => markGeometryDirty(),
  );

  onSettled(() => {
    if (!touchKeyboardEligible) return;
    const visualViewport = window.visualViewport;

    const readViewportHeight = (): number =>
      Math.round(visualViewport?.height ?? window.innerHeight);

    const checkViewportHeight = (): void => {
      const height = readViewportHeight();
      if (viewportHeightPrevious === height) {
        viewportHeightPrevious = null;
        // The terminal and its touch editing surface are viewport-pinned. iOS
        // can move the document origin during rotation, including after the
        // orientation event, so normalize on settled resize AND scroll edges.
        if (window.scrollX !== 0 || window.scrollY !== 0) {
          window.scrollTo(0, 0);
          markGeometryDirty();
        }
        setTerminalViewportHeight(height);
        return;
      }
      viewportHeightPrevious = height;
      viewportHeightFrame.arm(checkViewportHeight);
    };

    const scheduleViewportHeightSync = (): void => {
      viewportHeightPrevious = null;
      viewportHeightFrame.arm(checkViewportHeight);
    };

    const syncKeyboardActive = (): void => {
      scheduleViewportHeightSync();
      setNativeKeyboardActive(document.activeElement === editingSurface?.element);
    };

    visualViewport?.addEventListener('resize', syncKeyboardActive);
    visualViewport?.addEventListener('scroll', scheduleViewportHeightSync);
    window.addEventListener('resize', syncKeyboardActive);
    window.addEventListener('scroll', scheduleViewportHeightSync);
    window.addEventListener('orientationchange', syncKeyboardActive);
    setTerminalViewportHeight(readViewportHeight());

    onCleanup(() => {
      visualViewport?.removeEventListener('resize', syncKeyboardActive);
      visualViewport?.removeEventListener('scroll', scheduleViewportHeightSync);
      window.removeEventListener('resize', syncKeyboardActive);
      window.removeEventListener('scroll', scheduleViewportHeightSync);
      window.removeEventListener('orientationchange', syncKeyboardActive);
      viewportHeightPrevious = null;
      viewportHeightFrame.cancel();
    });
  });

  onSettled(() => {
    const refreshTerminalSurface = (): void => {
      markGeometryDirty();
      workerClient?.refreshLayout();
      workerClient?.refreshRender();
      workerClient?.updateDisplayEnv(true);
      const s = props.session();
      s?.notifyResumed();
      s?.requestDisplaySnapshot();
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') refreshTerminalSurface();
      else workerClient?.updateDisplayEnv(false);
    };

    window.addEventListener('pageshow', refreshTerminalSurface);
    document.addEventListener('visibilitychange', onVisibilityChange);

    onCleanup(() => {
      window.removeEventListener('pageshow', refreshTerminalSurface);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });
  });

  // ── IME preedit rendering ──────────────────────────────────────────────────
  // In-progress composition text is rendered, never sent to the PTY. The
  // worker renders it inline through the WASM/WebGL glyph pipeline.

  function renderPreedit(text: string, caret: number): void {
    workerClient?.setPreedit(text, caret);
  }

  function setKeyboardEnabled(visible: boolean): void {
    updateVirtualKeyboardPreferences({
      ...virtualKeyboardPreferences(),
      visible,
    });
    if (!touchKeyboardEligible) return;
    editingSurface?.blur();
    setNativeKeyboardActive(false);
    if (visible) panelEl.focus({ preventScroll: true });
    else clearVirtualModifiers();
  }

  function updateVirtualKeyboardPreferences(next: VirtualKeyboardPreferences): void {
    if (!touchKeyboardEligible) return;
    setVirtualKeyboardPreferences(next);
    saveVirtualKeyboardPreferences(next);
  }

  function toggleVirtualModifier(modifier: keyof TerminalModifierState): void {
    setVirtualModifiers((current) => ({
      ...current,
      [modifier]: !current[modifier],
    }));
    focus();
  }

  function clearVirtualModifiers(): void {
    setVirtualModifiers((current) =>
      current.shift || current.ctrl || current.alt || current.meta
        ? EMPTY_VIRTUAL_MODIFIERS
        : current,
    );
  }

  function handleVirtualKeyPress(
    definition: VirtualKeyDefinition,
    touchStartedAtMs?: number,
    repeat = false,
  ): void {
    if (definition.action === 'paste') {
      inputController?.pasteFromClipboard();
      return;
    }
    if (definition.action === 'fit-window') {
      props.session()?.takeGeometryControl();
      return;
    }
    inputController?.sendVirtualKey(definition, touchStartedAtMs, repeat);
  }

  function handleVirtualKeyPreview(
    definition: VirtualKeyDefinition | null,
    pointerId: number,
  ): void {
    inputController?.previewVirtualKey(definition, pointerId);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <section
      ref={panelEl}
      id="terminal"
      class="terminal-shell relative"
      role="application"
      aria-label="Terminal panel"
      tabindex="0"
      // The visual viewport sizes the shell only while the native keyboard is
      // up, which is exactly while the editing surface holds focus. Without the
      // keyboard `h-app` is already the right height, and an installed iOS app
      // can keep reporting the keyboard-shrunk visual viewport after the
      // keyboard has gone: sizing from it then left a black strip where the
      // keyboard had been, and nothing short of relaunching removed it.
      style={
        touchKeyboardEligible && nativeKeyboardActive()
          ? { height: `${terminalViewportHeight() ?? window.innerHeight}px` }
          : {}
      }
      onClick={focus}
      onPointerDown={(e) => {
        if (e.target instanceof HTMLElement && e.target.closest('button')) return;
        focus();
      }}
      onKeyDown={(e) => {
        if (e.key === ' ' && e.target === e.currentTarget && props.session() === null) {
          e.preventDefault();
          focus();
        }
      }}
    >
      <header
        ref={headerEl}
        class="flex h-12 shrink-0 items-center gap-3 border-b border-solid border-line1 pl-[10px] pr-3"
        // Focus mode hides the chrome, but an error card's only way out is the
        // arrow in this header — so an error brings the header back rather than
        // the card growing a second exit of its own.
        style={{ display: props.focusMode && props.statusMode !== 'error' ? 'none' : 'flex' }}
      >
        <button
          type="button"
          aria-label="Back to machines"
          onPointerDown={() => {
            terminalExitPending = true;
            geometryDirty = false;
            geometryFrame.cancel();
          }}
          onClick={() => void props.onBack()}
          class="btn-icon h-[30px] w-[30px]"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            class="h-[14px] w-[14px]"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M10 3 5 8l5 5" />
          </svg>
        </button>
        <div class="min-w-0 flex-1">
          <p class="truncate text-[13px] font-medium text-ink">{props.deviceName || 'Terminal'}</p>
        </div>
        <div class="ml-auto flex min-w-0 items-center gap-3 sm:ml-0">
          <Show when={!props.focusMode}>
            <LinkStatus session={props.session} />
          </Show>
          {touchKeyboardEligible ? (
            <button
              type="button"
              aria-label={
                virtualKeyboardPreferences().visible ? 'Disable keyboard' : 'Enable keyboard'
              }
              aria-pressed={ariaBool(virtualKeyboardPreferences().visible)}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setKeyboardEnabled(!virtualKeyboardPreferences().visible);
              }}
              // Drawn pressed rather than merely focused while the keyboard is
              // up: it is a latch, and the quick-access row below it exists only
              // while this is on.
              class={[
                'btn-icon h-[30px] w-[30px]',
                {
                  'border-accentline bg-accentsoft text-accentink':
                    virtualKeyboardPreferences().visible,
                },
              ]}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                class="h-4 w-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="3" y="6" width="18" height="12" rx="2.5" />
                <path d="M7 10h.01M10.5 10h.01M14 10h.01M17.5 10h.01M7 13.5h.01M10.5 13.5h7M8 16.5h8" />
              </svg>
            </button>
          ) : null}
        </div>
      </header>

      {props.focusMode && (
        <div class="shrink-0 h-[var(--terminal-edge-inset)] bg-[var(--terminal-bg)]" />
      )}
      <div id="terminal-viewport" class="relative flex-1 min-h-0 bg-[var(--terminal-bg)]">
        <div
          ref={containerEl}
          id="terminal-output"
          class="relative h-full w-full block overflow-hidden"
          style={{
            'background-color': rgbCss(
              TERMINAL_THEMES[props.terminalAppearance.themeId].background,
            ),
          }}
        />
        <TerminalStatusOverlay
          deviceName={props.deviceName}
          mode={props.statusMode}
          stage={props.stage}
          status={props.status}
          onRetry={props.onRetry}
        />
      </div>
      <Show when={import.meta.env.DEV && props.diagnostics !== null}>
        <TerminalDiagnosticsPanel diagnostics={props.diagnostics} status={props.status} />
      </Show>
      {touchKeyboardEligible ? (
        <VirtualTerminalKeyboard
          visible={virtualKeyboardPreferences().visible}
          modifiers={virtualModifiers()}
          toolbarKeys={virtualKeyboardPreferences().toolbarKeys}
          macros={virtualKeyboardPreferences().macros}
          layout={virtualKeyboardLayout()}
          keyPreview={virtualKeyboardPreferences().keyPreview}
          onKeyPress={handleVirtualKeyPress}
          onProvisionalKey={handleVirtualKeyPreview}
          onModifierToggle={toggleVirtualModifier}
        />
      ) : null}
    </section>
  );
};

const TerminalDiagnosticsPanel: Component<{
  diagnostics: TerminalWorkerDiagnostics | null;
  status: string;
}> = (props) => {
  const entries = () => {
    const diagnostics = props.diagnostics;
    if (diagnostics === null) return [];
    const diagnosticsNowMs = terminalPerfNowMs();
    return [
      ['status', props.status],
      ['worker', diagnostics.ready ? 'ready' : 'starting'],
      ['size', `${diagnostics.cols}x${diagnostics.rows}`],
      ['pixels', `${diagnostics.pixelWidth}x${diagnostics.pixelHeight}`],
      ['cell', `${diagnostics.charWidth.toFixed(2)}x${diagnostics.charHeight.toFixed(2)}`],
      ['dpr', diagnostics.devicePixelRatio.toFixed(2)],
      ['queue', String(diagnostics.queuedDisplayFrames)],
      [
        'last frame',
        diagnostics.lastDisplayFrameAtMs === null
          ? 'never'
          : `${terminalElapsedMsSince(diagnostics.lastDisplayFrameAtMs, diagnosticsNowMs)}ms ago`,
      ],
      [
        'last snapshot',
        diagnostics.lastSnapshotAtMs === null
          ? 'never'
          : `${terminalElapsedMsSince(diagnostics.lastSnapshotAtMs, diagnosticsNowMs)}ms ago`,
      ],
    ];
  };

  return (
    <details class="absolute bottom-3 right-3 z-10 max-w-[min(460px,calc(100vw-24px))] rounded-md border border-solid border-line2 bg-black/75 px-3 py-2 font-mono text-[11px] text-meta backdrop-blur">
      <summary class="cursor-pointer select-none text-body">Terminal diagnostics</summary>
      <dl class="mt-2 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1">
        <For each={entries()}>
          {([key, value]) => (
            <>
              <dt class="text-faint">{key}</dt>
              <dd class="truncate text-body">{value}</dd>
            </>
          )}
        </For>
      </dl>
    </details>
  );
};

export default TerminalPanel;
