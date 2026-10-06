/**
 * The page's three idle loops: an orb that floats, a caret that blinks, a bar
 * that squeezes. Each is one Motion animation of a transform or an opacity,
 * handed to the browser whole (`animateMini`), so no script runs while it
 * plays, and each plays only while what it moves is on screen.
 */
import { animateMini } from 'motion';

import { onScreen } from './clock';

type Playing = ReturnType<typeof animateMini>;

/** Plays `playing` only while `anchor` is on screen. */
function whileOnScreen(anchor: Element, playing: Playing): void {
  playing.pause();
  onScreen(anchor, (on) => (on ? playing.play() : playing.pause()));
}

/** The orb rises 6 px and settles, for as long as it is looked at. */
export function float(element: HTMLElement): void {
  whileOnScreen(
    element,
    animateMini(
      element,
      { transform: ['translateY(0px)', 'translateY(-6px)', 'translateY(0px)'] },
      { duration: 5, ease: 'easeInOut', repeat: Number.POSITIVE_INFINITY },
    ),
  );
}

/** A caret shows for six tenths of every second and hides for the rest. */
export function blink(caret: HTMLElement): void {
  whileOnScreen(
    caret,
    animateMini(
      caret,
      { opacity: [1, 1, 0, 0] },
      { duration: 1, times: [0, 0.6, 0.6, 1], ease: 'linear', repeat: Number.POSITIVE_INFINITY },
    ),
  );
}

/** The bar on the wire holds its full width, then squeezes to a quarter of it. */
export function squeeze(bar: HTMLElement): void {
  whileOnScreen(
    bar,
    animateMini(
      bar,
      { transform: ['scaleX(1)', 'scaleX(1)', 'scaleX(0.24)', 'scaleX(0.24)'] },
      {
        duration: 3.4,
        times: [0, 0.22, 0.55, 1],
        ease: 'easeInOut',
        repeat: Number.POSITIVE_INFINITY,
      },
    ),
  );
}
