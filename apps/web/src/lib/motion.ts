import { type MotionEase, OUT_EASE } from '@merkur/quicksilver/motion';
import { spring } from 'motion';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * `will-change` is a transient hint, not a decoration: held after the animation
 * it pins a compositor layer for the element's whole life. Set it for the
 * duration of `animation` only, and drop it however the animation ends.
 */
export function hintMotion(
  elements: readonly HTMLElement[],
  animation: { readonly finished: Promise<unknown> },
  properties = 'transform, opacity',
): void {
  if (elements.length === 0) return;
  for (const element of elements) element.style.willChange = properties;

  const release = (): void => {
    for (const element of elements) element.style.willChange = '';
  };
  animation.finished.then(release, release);
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function motionDuration(seconds: number, reducedSeconds = 0.01): number {
  return prefersReducedMotion() ? reducedSeconds : seconds;
}

/**
 * A spring, described the way it is perceived rather than the way it is
 * integrated. `visualDuration` is how long the movement *looks* like it takes
 * — the moment it first reaches its target — and `bounce` is how far past it
 * goes. The stiffness/damping/mass triple describes the same curve but cannot
 * be reasoned about without simulating it, which is why every spring here is
 * stated in these terms instead.
 *
 * Springs, not tweens, are what separates native motion from web motion: a
 * spring is defined by where it is going, so an interrupted one continues from
 * its current position *and velocity*, while a tween restarts its curve. Every
 * transition below can be reversed mid-flight, and that is when the difference
 * is visible.
 */
export interface SpringSpec {
  readonly visualDuration: number;
  readonly bounce: number;
}

/**
 * Screen push and pop. No bounce whatsoever: navigation that springs past its
 * resting place reads as a toy, and the overshoot lands on text the reader is
 * already trying to fix their eyes on. Short, because screens move in depth
 * rather than across the window and so have very little distance to cover.
 */
export const NAV_SPRING: SpringSpec = { visualDuration: 0.28, bounce: 0 };

/**
 * The whole app being replaced — splash to login to shell. Slower than a push
 * because more of the screen changes at once, and still bounce-free because
 * what moves is a full-bleed surface rather than an object.
 */
export const PHASE_SPRING: SpringSpec = { visualDuration: 0.34, bounce: 0 };

/**
 * Surfaces that arrive on top of the app: dialogs, the command palette, the
 * update banner. A trace of overshoot is the whole difference between a panel
 * that *lands* and one that was merely faded in.
 */
export const SURFACE_SPRING: SpringSpec = { visualDuration: 0.26, bounce: 0.22 };

/**
 * Sheets rising from the bottom edge. No bounce: the sheet's lower edge is the
 * screen's, so any overshoot lifts it clear and shows the scrim through the
 * gap. Longer than a push because a sheet travels its own height, which on a
 * phone is most of the screen.
 */
export const SHEET_SPRING: SpringSpec = { visualDuration: 0.36, bounce: 0 };

/**
 * Spring options for `animate`, collapsed to an instant settle under reduced
 * motion. One shape either way, so a caller never has to branch on the media
 * query to keep the option object's type stable.
 */
export function springTransition(spec: SpringSpec): {
  type: typeof spring;
  visualDuration: number;
  bounce: number;
} {
  const reduced = prefersReducedMotion();
  return {
    type: spring,
    visualDuration: reduced ? 0.01 : spec.visualDuration,
    bounce: reduced ? 0 : spec.bounce,
  };
}

/**
 * Opacity is never a spring. Alpha carries no momentum, so a spring on it is
 * just a fade with a strange middle; and a cross-fade must finish well before
 * the movement it accompanies, or two screens paint over each other through
 * the whole travel.
 */
export function fadeTransition(seconds: number): {
  duration: number;
  ease: MotionEase;
} {
  return { duration: motionDuration(seconds), ease: OUT_EASE };
}

/**
 * A cross-dissolve between two full-bleed surfaces, one leaving as the other
 * arrives. Linear on purpose. `OUT_EASE` spends most of a fade in its first
 * frames, which is right for a surface arriving over a stable one and wrong
 * for a swap: the leaving screen is three-quarters gone two frames in, so the
 * swap reads as a cut with a smear after it. The view-transition root
 * cross-fade is set to the same linear ramp in `uno.config.ts`, so where
 * that move is unavailable the dissolve that stands in for it is the same
 * shape.
 */
export function dissolveTransition(seconds: number): {
  duration: number;
  ease: 'linear';
} {
  return { duration: motionDuration(seconds), ease: 'linear' };
}
