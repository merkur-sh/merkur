import { animate } from 'motion';
import { type Component, onSettled } from 'solid-js';

import { fadeTransition, hintMotion, SURFACE_SPRING, springTransition } from '../lib/motion';

/**
 * A program in the terminal asked to open a URL (`merkur open`, reached through
 * `$BROWSER` or the opener stand-in) while the user was not interacting with the
 * page. With no recent user activation behind it a browser would block the tab,
 * and a tab opening unasked at the end of a long build is not what anyone wants
 * either, so it is offered. The Open click is the gesture.
 *
 * The host is what a person checks, so it leads; the full URL follows so a
 * lookalike path or query is not hidden behind it.
 */
const OpenUrlToast: Component<{
  url: string;
  pending: number;
  onOpen(): void;
  onDismiss(): void;
}> = (props) => {
  let toastEl!: HTMLDivElement;

  onSettled(() => {
    const toastMotion = animate(
      toastEl,
      { opacity: [0, 1], y: [-24, 0] },
      { y: springTransition(SURFACE_SPRING), opacity: fadeTransition(0.12) },
    );
    hintMotion([toastEl], toastMotion);
    return () => toastMotion.stop();
  });

  const host = (): string => new URL(props.url).host;
  // The second click of a double-click lands on whatever replaced this toast;
  // a request is answered only by a click aimed at it.
  const single =
    (answer: () => void) =>
    (e: MouseEvent): void => {
      if (e.detail <= 1) answer();
    };

  return (
    <div
      ref={toastEl}
      role="status"
      aria-label={`Open ${host()}`}
      data-open-url-toast=""
      class="pointer-events-auto flex min-w-0 max-w-[640px] items-center gap-3 rounded-sm border border-solid border-line2 bg-raised py-[7px] pl-[14px] pr-[7px] text-[13px] text-ink shadow-float"
    >
      <div class="min-w-0 flex-1">
        <p class="truncate">
          Open <span class="font-medium">{host()}</span>?
          {props.pending > 0 ? ` ${props.pending} more waiting.` : ''}
        </p>
        <p class="truncate font-mono text-[11px] text-meta">{props.url}</p>
      </div>
      <button type="button" class="btn-ghost btn-sm" onClick={single(props.onDismiss)}>
        Dismiss
      </button>
      <button type="button" class="btn-primary btn-sm" onClick={single(props.onOpen)}>
        Open
      </button>
    </div>
  );
};

export default OpenUrlToast;
