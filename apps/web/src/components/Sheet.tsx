import { TRAVEL_EASE } from '@merkur/quicksilver/motion';
import { Portal } from '@solidjs/web';
import { animate } from 'motion';
import {
  type Component,
  createEffect,
  createSignal,
  createUniqueId,
  type Element,
  onSettled,
  Show,
} from 'solid-js';

import { suspendKeybinds } from '../hooks/createKeybinds';
import { trapTabKey } from '../lib/focus-trap';
import {
  fadeTransition,
  hintMotion,
  motionDuration,
  SHEET_SPRING,
  springTransition,
} from '../lib/motion';
import { claimPress } from '../lib/press-claim';

/**
 * A modal sheet that rises from the bottom edge.
 *
 * It owns its presence: `open` turning false starts the way out, and the sheet
 * stays mounted until it has slid away, so an owner drops `open` the moment the
 * user dismisses it and never waits on an animation. While leaving it shows
 * whatever its children still render, so an owner that swaps the content by
 * kind keeps the kind the sheet was dismissed from.
 */

/** The scrim is solid well before the sheet has landed. */
const SCRIM_FADE_S = 0.2;

/**
 * The way out is a tween, not the spring. A bounce-free spring spends as long
 * again settling as it took to look finished, and this exit is what hands the
 * screen back: the sheet unmounts when it ends, and until then its scrim still
 * takes every press. It has to end when it looks finished.
 */
const EXIT_S = 0.3;

interface Props {
  readonly open: boolean;
  readonly title: string;
  readonly onDismiss: () => void;
  readonly children: Element;
}

const Sheet: Component<Props> = (props) => {
  // On screen: open, or still leaving.
  const [present, setPresent] = createSignal(props.open);
  createEffect(
    () => props.open,
    (open) => {
      if (!open) return;
      setPresent(true);
      // A modal sheet owns the keyboard: the screen under it must not read a
      // bare `l` or `q` as its own. Handed back the moment the sheet is
      // dismissed, not when it has finished sliding away, like focus.
      return suspendKeybinds();
    },
  );

  return (
    <Show when={present()}>
      <SheetLayer
        open={props.open}
        title={props.title}
        onDismiss={props.onDismiss}
        onExited={() => setPresent(false)}
      >
        {props.children}
      </SheetLayer>
    </Show>
  );
};

interface LayerProps extends Props {
  readonly onExited: () => void;
}

const SheetLayer: Component<LayerProps> = (props) => {
  let scrimEl!: HTMLDivElement;
  let panelEl!: HTMLDivElement;
  let doneEl!: HTMLButtonElement;
  const titleId = createUniqueId();
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let scrimMotion: ReturnType<typeof animate> | null = null;
  let panelMotion: ReturnType<typeof animate> | null = null;
  /**
   * Bumped by every transition, so an exit that was turned back mid-flight
   * never unmounts the sheet it no longer describes.
   */
  let transition = 0;

  onSettled(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Capture, so Escape closes the sheet before the screen under it reads the
    // same press as its own way back.
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      scrimMotion?.stop();
      panelMotion?.stop();
    };
  });

  createEffect(
    () => props.open,
    (open) => {
      const generation = ++transition;
      scrimMotion?.stop();
      panelMotion?.stop();
      // Its own height is exactly as far as it has to travel to clear the edge.
      const travel = panelEl.offsetHeight;

      if (open) {
        // The first entrance rises from below the edge. A sheet turned back
        // mid-exit re-targets from wherever it is, and the spring carries the
        // velocity it had on the way down.
        const first = generation === 1;
        scrimMotion = animate(
          scrimEl,
          { opacity: first ? [0, 1] : 1 },
          fadeTransition(SCRIM_FADE_S),
        );
        panelMotion = animate(
          panelEl,
          { y: first ? [travel, 0] : 0 },
          springTransition(SHEET_SPRING),
        );
        hintMotion([panelEl], panelMotion, 'transform');
        queueMicrotask(() => doneEl.focus({ preventScroll: true }));
        return;
      }

      // Closed in the same turn it opened: there is nothing on screen to move.
      if (generation === 1) {
        props.onExited();
        return;
      }

      // Focus goes back now rather than at unmount: the panel turns inert as
      // it leaves, and a keyboard user should not wait out the slide.
      const active = document.activeElement;
      if (
        previouslyFocused?.isConnected === true &&
        (active === document.body || panelEl.contains(active))
      ) {
        previouslyFocused.focus();
      }
      const exit = { duration: motionDuration(EXIT_S), ease: TRAVEL_EASE };
      const scrimExit = animate(scrimEl, { opacity: 0 }, exit);
      const panelExit = animate(panelEl, { y: travel }, exit);
      scrimMotion = scrimExit;
      panelMotion = panelExit;
      hintMotion([panelEl], panelExit, 'transform');
      const exited = (): void => {
        if (generation === transition) props.onExited();
      };
      void Promise.allSettled([scrimExit.finished, panelExit.finished]).then(exited, exited);
    },
  );

  function onKeyDown(event: KeyboardEvent): void {
    if (!props.open) return;
    // Ctrl+[ is Escape, as it is for every other surface over the app.
    if (event.key === 'Escape' || (event.ctrlKey && event.key === '[')) {
      event.preventDefault();
      props.onDismiss();
      return;
    }
    trapTabKey(event, panelEl);
  }

  function onPointerDown(event: PointerEvent): void {
    // A press inside a sheet that is up belongs to the sheet. Everything else
    // — the scrim, or anywhere at all once the sheet is leaving — is a press
    // on the scrim, and its click must not reach what the scrim covers.
    if (props.open && event.target !== scrimEl) return;
    claimPress();
    if (props.open) props.onDismiss();
  }

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[100] flex items-end justify-center overflow-hidden"
        onPointerDown={onPointerDown}
      >
        <div
          ref={scrimEl}
          aria-hidden="true"
          class="absolute inset-0 bg-black/62 backdrop-blur-[3px]"
        />
        <div
          ref={panelEl}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          inert={!props.open}
          class="relative flex max-h-[calc(100dvh-12px)] w-full max-w-[760px] flex-col overflow-hidden rounded-t-lg border border-b-0 border-solid border-line2 bg-panel text-body shadow-over"
        >
          <header class="shrink-0 border-b border-solid border-line1 px-4 pt-2">
            <div aria-hidden="true" class="mx-auto h-1 w-9 rounded-full bg-line3" />
            <div class="flex h-13 items-center gap-3">
              <span class="w-12 shrink-0" />
              <h2
                id={titleId}
                class="min-w-0 flex-1 truncate text-center text-[15px] font-semibold text-ink"
              >
                {props.title}
              </h2>
              <button
                ref={doneEl}
                type="button"
                onClick={() => props.onDismiss()}
                class="focusable w-12 shrink-0 cursor-pointer rounded-xs border-none bg-transparent text-right text-[13px] font-medium text-accentink active:opacity-60"
              >
                Done
              </button>
            </div>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-[max(20px,env(safe-area-inset-bottom))]">
            {props.children}
          </div>
        </div>
      </div>
    </Portal>
  );
};

export default Sheet;
