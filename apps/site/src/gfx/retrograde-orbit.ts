/**
 * The line the orb follows across the page for an address with nothing at it:
 * level from one edge to the other, with one loop in the middle where it
 * rises, backs up and carries on, the way Mercury seems to in the sky.
 *
 * The line is laid out without a width. Each sample says how far across it
 * is, as a share of the line's whole run, and how far it has risen, as a share
 * of the loop's height, so the build draws the still from it at any width
 * (`vite/retrograde-still.ts`) and the render worker draws the same line at
 * the width it is given (`gfx/retrograde.ts`). Pure: no DOM, no clock.
 */

/** The line's parameter runs from `-SPAN` at its start to `SPAN` at the far edge. */
const SPAN = 3 * Math.PI;
/** How far back the loop reaches, in units of the line's level pace. */
const REACH = 2.6;
/** Samples from the line's start to the far edge. */
const SAMPLES = 700;
/** Samples past the far edge, level, so the tail leaves the page behind the orb. */
const RUN_OFF = 200;
/** Seconds the orb spends on a third of the line at the loop's own pace. */
const LOOP_SECONDS = 3;
/** How much faster than the loop's pace the orb crosses the level stretches. */
const LEVEL_HASTE = 2.2;

/** How many samples behind the orb its tail still shows. */
export const TAIL_SAMPLES = 170;

const smooth = (from: number, to: number, value: number): number => {
  const share = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return share * share * (3 - 2 * share);
};

const count = SAMPLES + RUN_OFF + 1;
const across = new Float64Array(count);
const lift = new Float64Array(count);
const time = new Float64Array(count);
let loopFrom = count;
let loopTo = 0;
let firstBackwards = count;
for (let index = 0; index < count; index += 1) {
  const s = -SPAN + (2 * SPAN * index) / SAMPLES;
  const inLoop = Math.abs(s) < Math.PI;
  const rise = inLoop ? (1 + Math.cos(s)) / 2 : 0;
  across[index] = (s + SPAN - REACH * Math.sin(s) * rise) / (2 * SPAN);
  lift[index] = rise;
  if (inLoop) {
    loopFrom = Math.min(loopFrom, index);
    loopTo = index;
  }
  if (index === 0) continue;
  if ((across[index] ?? 0) < (across[index - 1] ?? 0)) {
    firstBackwards = Math.min(firstBackwards, index);
  }
  // The orb crosses the level stretches quickly and takes the loop slowly.
  const pace = 1 + LEVEL_HASTE * smooth(0.85 * Math.PI, 1.5 * Math.PI, Math.abs(s));
  time[index] = (time[index - 1] ?? 0) + (LOOP_SECONDS / (SAMPLES / 3)) * (1 / pace);
}

export const ORBIT = {
  /** How far across each sample is: 0 at the line's start, 1 at the far edge, more past it. */
  across,
  /** How far each sample has risen: 0 on the level, 1 at the top of the loop. */
  lift,
  /** When the orb reaches each sample, in seconds from the line's start. */
  time,
  /** The first and last samples of the loop, which lights as the orb passes. */
  loopFrom,
  loopTo,
  /** The first sample the orb reaches going backwards. */
  firstBackwards,
  /** The top of the loop, mid-page: where the still holds the orb. */
  top: SAMPLES / 2,
  /** Seconds from the line's start to the end of its run-off, after which it starts again. */
  duration: time[count - 1] ?? 0,
} as const;

/** The last sample the orb has reached `seconds` into its run. */
export function sampleAt(seconds: number): number {
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((time[middle] ?? 0) <= seconds) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** How bright and how wide the tail is `behind` samples back from its faint end, 0 to 1. */
export function tailWeight(behind: number): number {
  return (behind / TAIL_SAMPLES) ** 1.6;
}

/**
 * The stars behind the line: where each is, as shares of the sky's width and
 * height, and how bright. The same stars on every visit.
 */
export function stars(): readonly (readonly [x: number, y: number, light: number])[] {
  let seed = 41;
  const next = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  return Array.from({ length: 120 }, () => [next(), next(), next()] as const);
}
