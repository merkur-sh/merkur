/**
 * The traffic strip in a mock terminal's header, as the app's LinkStatus draws
 * it: sent above the baseline, received below, one bar every 3px.
 *
 * The page carries a still of it, drawn at build time from a seed
 * (`page-facts.ts`), so it is there before any script and for a reader who
 * asked for no motion.
 */
export const STRIP_PITCH = 3;

export interface StripBar {
  readonly sent: number;
  readonly received: number;
}

/** The Lehmer generator the strip's traffic comes from, seeded by a name. */
export function stripRandom(seed: string): () => number {
  let state = [...seed].reduce((sum, character) => sum + character.charCodeAt(0), 7);
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

/** One more bar: mostly typing, sometimes a burst of output, sometimes nothing. */
export function stripStep(random: () => number, span: number): StripBar {
  const burst = random() < 0.18;
  const typing = random() < 0.55;
  const sent = typing ? 1 + Math.round(random() * span * 0.35) : 0;
  const received = burst
    ? Math.round(span * (0.55 + random() * 0.45))
    : typing
      ? 1 + Math.round(random() * span * 0.3)
      : random() < 0.3
        ? 1
        : 0;
  return { sent, received };
}

/**
 * The strip `width` by `height` shows: its baseline, then its bars in one
 * group, which the page's script slides along as traffic arrives.
 */
export function stripStill(seed: string, width: number, height: number): string {
  const random = stripRandom(seed);
  const span = Math.floor((height - 1) / 2);
  const middle = Math.floor(height / 2);
  const rects: string[] = [];
  for (let index = 0; index < Math.floor(width / STRIP_PITCH); index += 1) {
    const { sent, received } = stripStep(random, span);
    const x = index * STRIP_PITCH;
    if (sent > 0) {
      rects.push(
        `<rect x="${x}" y="${middle - sent}" width="${STRIP_PITCH - 1}" height="${sent}"/>`,
      );
    }
    if (received > 0) {
      rects.push(
        `<rect x="${x}" y="${middle + 1}" width="${STRIP_PITCH - 1}" height="${received}"/>`,
      );
    }
  }
  return `<rect class="base" x="0" y="${middle}" width="${width}" height="1"/><g>${rects.join('')}</g>`;
}
