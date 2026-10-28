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

/** One column of the strip: its bars at `x`. */
export interface StripColumn extends StripBar {
  readonly x: number;
}

/** The columns a strip `width` by `height` starts with, the same for its seed every time. */
export function stripColumns(seed: string, width: number, height: number): StripColumn[] {
  const random = stripRandom(seed);
  const span = Math.floor((height - 1) / 2);
  return Array.from({ length: Math.floor(width / STRIP_PITCH) }, (_, index) => ({
    x: index * STRIP_PITCH,
    ...stripStep(random, span),
  }));
}

/**
 * Every bar of `columns` as one path: sent above the baseline at `middle`,
 * received below it. One element draws the whole strip.
 */
export function stripPath(columns: readonly StripColumn[], middle: number): string {
  const width = STRIP_PITCH - 1;
  let path = '';
  for (const { x, sent, received } of columns) {
    if (sent > 0) path += `M${x} ${middle - sent}h${width}v${sent}h-${width}z`;
    if (received > 0) path += `M${x} ${middle + 1}h${width}v${received}h-${width}z`;
  }
  return path;
}

/**
 * The strip `width` by `height` shows: its baseline, then its bars as one
 * path, which the page's script slides along as traffic arrives.
 */
export function stripStill(seed: string, width: number, height: number): string {
  const middle = Math.floor(height / 2);
  const bars = stripPath(stripColumns(seed, width, height), middle);
  return `<rect class="base" x="0" y="${middle}" width="${width}" height="1"/><path d="${bars}"/>`;
}
