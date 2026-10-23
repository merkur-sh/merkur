/**
 * Every measured number the site prints, with where it was measured.
 *
 * `text` is a verbatim substring of one line of `ledger`, a path in the
 * private `merkur-private-docs` checkout; `values` are the strings a page
 * shows, and each one is a whole token of `text`. The pages name a value as
 * `[[fig:<id>.<key>]]`, its whole provenance line as `[[figcap:<id>]]` and one
 * part of it as `[[figcap:<id>.<part>]]`, and the `figures()` plugin fills them
 * at build time: a name that is not here, or a figure or value no page names,
 * stops the build. `bun run check:figures` (`scripts/check-site-figures.ts`)
 * checks `text` against the ledger itself, so a figure cannot drift from its
 * source.
 *
 * Caption parts name the conditions a reader needs to judge the number; every
 * number in `version`, `sample` and `date` also appears in the ledger entry.
 */
export interface FigureCaption {
  /** What was measured, as a reader would name it. */
  readonly measurement: string;
  /** Where: `production` or `lab`. */
  readonly environment: 'production' | 'lab';
  /** The builds measured. */
  readonly version: string;
  /** How much was measured. */
  readonly sample: string;
  /** When, as the entry states it. */
  readonly date: string;
}

export interface Figure {
  readonly id: string;
  readonly text: string;
  readonly ledger: string;
  readonly values: Readonly<Record<string, string>>;
  readonly caption: FigureCaption;
}

export const FIGURES: readonly Figure[] = [
  {
    id: 'mz',
    text: 'raw 79.6 MB, zstd 25.1 MB (3.2× smaller), MZ 14.0 MB (5.7× smaller)',
    ledger: 'ledger/2026-10-23-mz-site-figure.md',
    // `rawMb`, `zstdMb` and `mzMb` size the squares that draw the three
    // (`.mz-squares` in `index.html`), so the picture moves with the figure.
    values: {
      rawMb: '79.6',
      zstdMb: '25.1',
      mzMb: '14.0',
      raw: '79.6 MB',
      zstd: '25.1 MB',
      zstdTimes: '3.2×',
      mz: '14.0 MB',
      mzTimes: '5.7×',
    },
    caption: {
      measurement: 'Display bytes of recorded terminal sessions MZ never trained on',
      environment: 'lab',
      version: 'main 48066b34, zstd from v0.74.8',
      sample: '36 recordings at 0% loss',
      date: '2026-10-23',
    },
  },
];
