import { createOwnedTimeout } from '../lib/owned-scheduled-callback';

/**
 * Display-output settle: turns authoritative visual submissions into two
 * notices per burst — `onChanged` on the first frame, `onSettled` once the
 * output has been still for `DISPLAY_OUTPUT_SETTLE_MS`.
 *
 * Lives in the terminal worker so that main hears about output twice per burst
 * instead of once per frame: the previous shape posted a `display_frame_received`
 * message for every applied datagram and had main debounce them with a timer,
 * which was one worker message, one main-thread task and one timer re-arm per
 * frame for a screen-reader mirror that only ever read the settled screen.
 *
 * Deadline-check debounce, not a re-armed timer: a frame inside an open burst
 * costs exactly one number store. The timer is armed once per burst; when it
 * fires early (frames kept arriving) it is re-armed for the remainder, never
 * per frame. `reset` on runtime teardown discards the open burst so a settle
 * from a retired runtime cannot announce against the replacement's screen.
 */
export const DISPLAY_OUTPUT_SETTLE_MS = 350;

export interface DisplayOutputSettleOptions<Handle> {
  /** First submitted authoritative visual transaction of a burst. */
  onChanged(): void;
  /** No frame for `DISPLAY_OUTPUT_SETTLE_MS` after the burst's last frame. */
  onSettled(): void;
  now(): number;
  setTimer(callback: () => void, delayMs: number): Handle;
  clearTimer(handle: Handle): void;
}

export interface DisplayOutputSettle {
  /** One submitted authoritative visual transaction. */
  noteFrame(): void;
  /** Runtime teardown: forget the open burst and its deadline. */
  reset(): void;
}

export function createDisplayOutputSettle<Handle>(
  options: DisplayOutputSettleOptions<Handle>,
): DisplayOutputSettle {
  const deadline = createOwnedTimeout(options.setTimer, options.clearTimer);
  let lastFrameAtMs = 0;
  let burstOpen = false;

  function fire(): void {
    const remainingMs = lastFrameAtMs + DISPLAY_OUTPUT_SETTLE_MS - options.now();
    if (remainingMs > 0) {
      // Frames kept arriving after the arm. Re-check at the true deadline
      // rather than having every frame move a timer.
      deadline.arm(fire, remainingMs);
      return;
    }
    burstOpen = false;
    options.onSettled();
  }

  return {
    noteFrame(): void {
      lastFrameAtMs = options.now();
      if (burstOpen) return;
      burstOpen = true;
      options.onChanged();
      deadline.arm(fire, DISPLAY_OUTPUT_SETTLE_MS);
    },
    reset(): void {
      deadline.cancel();
      burstOpen = false;
    },
  };
}
