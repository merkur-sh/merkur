/**
 * A terminal's rows as a figure's model writes them: text in the colours of
 * the palette every post shares (`tk-*` in `blog.css`). No drawing here, so a
 * model and its test need nothing of Solid.
 */

/** A colour of the terminal palette, by the name its class goes by. */
export type Tone = 'text' | 'blue' | 'mauve' | 'green' | 'yellow' | 'red' | 'overlay1';

export interface Segment {
  readonly text: string;
  readonly tone: Tone;
  /** A mark the mono face lacks, set in the terminal's own face (`.tg`). */
  readonly mark?: true;
}

export type Line = readonly Segment[];

export function seg(text: string, tone: Tone = 'text'): Segment {
  return { text, tone };
}

/** The prompt every figure's shell shows, and the same as plain text. */
export const PROMPT: Line = [
  seg('~/mercury', 'blue'),
  seg(' main ', 'mauve'),
  { text: '❯', tone: 'green', mark: true },
  seg(' '),
];
export const PROMPT_TEXT = '~/mercury main ❯ ';

export function lineText(line: Line): string {
  return line.map((segment) => segment.text).join('');
}
