/**
 * The still of the sky on the page for an address with nothing at it: the
 * stars, the dotted line with its loop, and the moment the orb is held at the
 * top of it, with half the loop lit and its tail behind it.
 *
 * It is drawn from the line the render worker follows (`gfx/retrograde-orbit.ts`),
 * so the worker's first frame is the still, and it is all a reader with script
 * off or motion turned down gets. Every path is set in a box one unit wide
 * and one high, which the stylesheet stretches over the sky: a point's x is its
 * share of the line's run and its y its drop from the top of the loop. The
 * stars are not stretched: Gecko stretches a point's cap with its drawing, so
 * each is a pixel placed by percentage.
 */
import { ORBIT, stars, TAIL_SAMPLES, tailWeight } from '../gfx/retrograde-orbit';

/** Tail samples drawn as one stroke, at one brightness and width. */
const TAIL_STEP = 10;
/** Brightnesses the stars are sorted into, each one group. */
const STAR_LEVELS = 5;

const number = (value: number, digits: number): string => {
  const text = Number(value.toFixed(digits)).toString();
  return text.startsWith('0.') ? text.slice(1) : text;
};

const point = (index: number): string =>
  `${number(ORBIT.across[index] ?? 0, 4)} ${number(1 - (ORBIT.lift[index] ?? 0), 3)}`;

/** The samples `from` to `to` as one open path. */
function stroke(from: number, to: number): string {
  const points: string[] = [];
  for (let index = from; index <= to; index += 1) points.push(point(index));
  return `M${points.join('L')}`;
}

export interface RetrogradeStill {
  /** The whole line, edge to edge: path data. */
  readonly line: string;
  /** The loop from where it leaves the level to its top: path data. */
  readonly lit: string;
  /** The tail behind the orb at the top of the loop, faint end first: paths. */
  readonly tail: string;
  /** The stars, a pixel each, grouped by brightness and placed by share of the sky. */
  readonly stars: string;
}

export function retrogradeStill(): RetrogradeStill {
  const tail: string[] = [];
  const faintEnd = ORBIT.top - TAIL_SAMPLES;
  for (let from = faintEnd; from < ORBIT.top; from += TAIL_STEP) {
    const weight = tailWeight(from + TAIL_STEP / 2 - faintEnd);
    tail.push(
      `<path d="${stroke(from, from + TAIL_STEP)}" stroke-opacity="${number(weight * 0.95, 3)}" stroke-width="${number(0.6 + weight * 2.2, 2)}"/>`,
    );
  }
  const levels = Array.from({ length: STAR_LEVELS }, (): string[] => []);
  for (const [x, y, light] of stars()) {
    levels[Math.min(STAR_LEVELS - 1, Math.floor(light * STAR_LEVELS))]?.push(
      `<rect x="${number(x * 100, 2)}%" y="${number(y * 100, 2)}%" width="1" height="1"/>`,
    );
  }
  return {
    line: `M0 1H${number(ORBIT.across[ORBIT.loopFrom - 1] ?? 0, 4)}L${stroke(ORBIT.loopFrom, ORBIT.loopTo).slice(1)}H1`,
    lit: stroke(ORBIT.loopFrom - 1, ORBIT.top),
    tail: tail.join(''),
    stars: levels
      .map(
        (dots, level) =>
          `<g fill-opacity="${number(0.03 + (0.14 * (level + 0.5)) / STAR_LEVELS, 3)}">${dots.join('')}</g>`,
      )
      .join(''),
  };
}
