export type MotionEase = readonly [number, number, number, number];

/**
 * Entrances and exits. Quicksilver's `--ease-out`: decelerating, with almost no
 * tail, so a surface that arrives is finished arriving rather than still
 * settling once it looks still.
 */
export const OUT_EASE: MotionEase = [0.23, 1, 0.32, 1];

/**
 * Travel — sheets and screens moving across or through the window. Quicksilver's
 * `--ease`, the iOS drawer curve, whose long settling tail is what makes a
 * surface feel weighted. Deliberately not used for anything that only changes
 * colour, where the same tail reads as a smear.
 */
export const TRAVEL_EASE: MotionEase = [0.32, 0.72, 0, 1];

/**
 * The same curves as a CSS value, so the preset can seed `theme.easing` from
 * this module instead of restating the control points. JS and CSS motion must
 * decelerate identically or transitions read as two different systems.
 */
export function cssEase(ease: MotionEase): string {
  return `cubic-bezier(${ease.join(', ')})`;
}
