/**
 * The site's cut of Quicksilver's faces, and the check that it still covers
 * every character the built pages set.
 *
 * `scripts/subset-fonts.ts` cuts the faces and records each one's characters
 * in `src/fonts/subset.json`; `uno.config.ts` declares them from that record;
 * `fontCoverage()` reads the built pages after every build and stops it when a
 * character is missing from its face, or when a cut no longer matches the face
 * Quicksilver ships, so a copy edit or a new font can never render in a
 * fallback face unnoticed.
 *
 * Geist and JetBrains Mono carry every character of the pages' text. The marks
 * a terminal draws that neither has (prompt chevrons, tool bullets, key caps)
 * are set one to a `<span class="tg">`, in `Merkur Terminal`: the face the
 * app's own terminal draws with, cut to exactly those marks.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

import { afterBuild } from './after-build';

export interface FontSubset {
  readonly file: string;
  readonly family: string;
  /** The face it is cut from, from the repository root. */
  readonly source: string;
  /** The weight range the cut keeps, for a variable face. */
  readonly weight?: string;
  readonly style?: 'italic';
  /** The optical size the cut is drawn at, for a face with that axis; the cut loses the axis. */
  readonly opticalSize?: number;
}

export const TERMINAL_FACE = 'MerkurTerminal.woff2';
export const SERIF_FACE = 'InstrumentSerif-latin.woff2';
export const SERIF_ITALIC_FACE = 'InstrumentSerif-Italic-latin.woff2';

export const FONT_SUBSETS: readonly FontSubset[] = [
  {
    file: 'Geist-latin.woff2',
    family: 'Geist',
    source: 'packages/quicksilver/fonts/Geist-latin.woff2',
    weight: '400 600',
  },
  {
    file: 'JetBrainsMono-latin.woff2',
    family: 'JetBrains Mono',
    source: 'packages/quicksilver/fonts/JetBrainsMono-latin.woff2',
    weight: '400 700',
  },
  {
    file: SERIF_FACE,
    family: 'Instrument Serif',
    source: 'packages/quicksilver/fonts/InstrumentSerif-latin.woff2',
  },
  {
    // Google Fonts' own latin subset of the italic, fetched 2026-10-04 from
    // fonts.gstatic.com/s/instrumentserif/v5/jizHRFtNs2ka5fXjeivQ4LroWlx-6zAjjH7Motmp5g.woff2;
    // the family's licence ships with Quicksilver's upright cut.
    file: SERIF_ITALIC_FACE,
    family: 'Instrument Serif',
    source: 'apps/site/src/fonts/source/InstrumentSerif-Italic-latin.woff2',
    style: 'italic',
  },
  {
    file: TERMINAL_FACE,
    family: 'Merkur Terminal',
    source: 'apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf',
  },
];

/** The classes that set text in the upright serif: the wordmark. */
export const SERIF_CLASSES = ['wordmark-sm', 'wordmark', 'serif'] as const;
/** The class that sets a headline's closing phrase in the serif italic. */
export const SERIF_ITALIC_CLASSES = ['serif-i'] as const;

/** The class of a span that holds one terminal mark. */
export const TERMINAL_GLYPH_CLASS = 'tg';

/**
 * The blog's reading face, roman and italic: Google Fonts' own latin subsets
 * of Literata, fetched 2026-10-04 from fonts.gstatic.com/s/literata/v40/, with
 * the family's licence beside them. Only the blog's pages set it, so it is cut
 * to their characters alone and declared in `src/blog/blog.css`, not in the
 * sheet every page carries. What its source lacks is recorded as `lacking` and
 * drawn in the stack's next face.
 *
 * The source carries an optical-size axis from 7 to 72. The blog reads at 17
 * to 23 pixels, so the cut is drawn at one size in that range and drops the
 * axis, which is most of the file.
 */
export const READING_FACE = 'Literata-latin.woff2';
export const READING_ITALIC_FACE = 'Literata-Italic-latin.woff2';
const READING_OPTICAL_SIZE = 18;
export const BLOG_FONT_SUBSETS: readonly FontSubset[] = [
  {
    file: READING_FACE,
    family: 'Literata',
    source: 'apps/site/src/fonts/source/Literata-latin.woff2',
    weight: '400 500',
    opticalSize: READING_OPTICAL_SIZE,
  },
  {
    file: READING_ITALIC_FACE,
    family: 'Literata',
    source: 'apps/site/src/fonts/source/Literata-Italic-latin.woff2',
    weight: '400 400',
    style: 'italic',
    opticalSize: READING_OPTICAL_SIZE,
  },
];

/** Every document of a build, from its root: all of them are pages. */
export function builtPages(dist: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(dist, directory), { withFileTypes: true })) {
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.html')) found.push(path);
    }
  };
  walk('');
  return found.sort();
}

/** The blog's documents among `pages`. */
export function blogPagesOf(pages: readonly string[]): string[] {
  return pages.filter((page) => page.startsWith('blog/'));
}

export interface SubsetRecord {
  readonly family: string;
  readonly weight: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly characters: string;
  /**
   * The terminal face only: the marks its source lacks too, which the page
   * draws from the platform's fonts, as the live renderer does.
   */
  readonly platform?: string;
  /** The reading face only: the characters of the blog's pages its source has no glyph for. */
  readonly lacking?: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    const named = ENTITIES[name];
    if (named === undefined) throw new Error(`font-coverage: unknown entity ${whole}`);
    return named;
  });
}

function characters(text: string): Set<string> {
  return new Set([...text].filter((character) => (character.codePointAt(0) ?? 0) >= 0x20));
}

const TERMINAL_GLYPH = new RegExp(
  `<span class="${TERMINAL_GLYPH_CLASS}"(?: aria-hidden="true")?>([^<]*)</span>`,
  'g',
);

/** Every terminal mark the built pages set, each in its own span. */
export function terminalCharacters(dist: string): string {
  const found = new Set<string>();
  for (const page of builtPages(dist)) {
    for (const match of readFileSync(join(dist, page), 'utf8').matchAll(TERMINAL_GLYPH)) {
      for (const character of characters(decodeEntities(match[1] ?? ''))) found.add(character);
    }
  }
  return [...found].sort().join('');
}

/**
 * Every character one of `pages` or its script can put on screen, markup and
 * the terminal marks aside.
 */
export function pageCharacters(dist: string, pages: readonly string[]): string {
  const found = new Set<string>();
  for (const page of pages) {
    const html = readFileSync(join(dist, page), 'utf8').replace(TERMINAL_GLYPH, '');
    const visible = html
      .replace(/<style>[\s\S]*?<\/style>/g, '')
      .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\/?[a-zA-Z][^>]*?>/g, (tag) =>
        // Attribute values stay: alt, aria-label and title text reach a reader too.
        [...tag.matchAll(/="([^"]*)"/g)].map((match) => ` ${match[1] ?? ''} `).join(''),
      );
    for (const character of characters(decodeEntities(visible))) found.add(character);
    for (const script of html.matchAll(/<script type="module"[^>]*\ssrc="\/([^"]+)"/g)) {
      const source = readFileSync(join(dist, script[1] ?? ''), 'utf8').replace(
        /\\u([0-9a-fA-F]{4})|\\u\{([0-9a-fA-F]+)\}/g,
        (_whole, short?: string, long?: string) =>
          String.fromCodePoint(Number.parseInt(short ?? long ?? '0', 16)),
      );
      for (const character of characters(source)) found.add(character);
    }
  }
  return [...found].sort().join('');
}

/** Every character a built page sets directly in an element of one of `names`. */
export function classCharacters(dist: string, names: readonly string[]): string {
  const found = new Set<string>([' ']);
  const classes = names.join('|');
  const element = new RegExp(`class="(?:[^"]*\\s)?(?:${classes})(?:\\s[^"]*)?"[^>]*>([^<]*)<`, 'g');
  for (const page of builtPages(dist)) {
    for (const match of readFileSync(join(dist, page), 'utf8').matchAll(element)) {
      for (const character of characters(decodeEntities(match[1] ?? ''))) found.add(character);
    }
  }
  return [...found].sort().join('');
}

export function readSubsets(fontsDirectory: string): Readonly<Record<string, SubsetRecord>> {
  const path = join(fontsDirectory, 'subset.json');
  if (!existsSync(path))
    throw new Error('font-coverage: src/fonts/subset.json is missing; run subset-fonts');
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, SubsetRecord>;
  for (const face of FONT_SUBSETS) {
    if (record[face.file] === undefined)
      throw new Error(`font-coverage: subset.json has no ${face.file}`);
  }
  return record;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** What is wrong with the cut for this build, or nothing. */
export function coverageProblems(siteRoot: string, dist: string): string[] {
  const fonts = join(siteRoot, 'src/fonts');
  const record = readSubsets(fonts);
  const problems: string[] = [];
  for (const face of [...FONT_SUBSETS, ...BLOG_FONT_SUBSETS]) {
    const entry = record[face.file];
    if (entry === undefined) continue;
    if (sha256(readFileSync(join(fonts, face.file))) !== entry.sha256) {
      problems.push(`src/fonts/${face.file} is not the cut subset.json records`);
    }
    if (entry.source !== face.source) {
      problems.push(`${face.file} was cut from ${entry.source}, not ${face.source}`);
    }
    if (sha256(readFileSync(resolve(siteRoot, '../..', entry.source))) !== entry.sourceSha256) {
      problems.push(`${entry.source} changed since ${face.file} was cut from it`);
    }
  }
  const missing = (have: string, need: string): string =>
    [...need].filter((character) => !have.includes(character)).join('');
  const ui = record['Geist-latin.woff2']?.characters ?? '';
  const mono = record['JetBrainsMono-latin.woff2']?.characters ?? '';
  const terminal = record[TERMINAL_FACE];
  const pages = builtPages(dist);
  const text = pageCharacters(dist, pages);
  for (const [face, have] of [
    ['Geist', ui],
    ['JetBrains Mono', mono],
  ] as const) {
    const lost = missing(have, text);
    if (lost !== '') problems.push(`${face} lacks ${JSON.stringify(lost)}`);
  }
  const reading = pageCharacters(dist, blogPagesOf(pages));
  for (const face of BLOG_FONT_SUBSETS) {
    const entry = record[face.file];
    const lost = missing(`${entry?.characters ?? ''}${entry?.lacking ?? ''}`, reading);
    if (lost !== '') problems.push(`${face.file} was cut without ${JSON.stringify(lost)}`);
  }
  for (const [file, names] of [
    [SERIF_FACE, SERIF_CLASSES],
    [SERIF_ITALIC_FACE, SERIF_ITALIC_CLASSES],
  ] as const) {
    const lost = missing(record[file]?.characters ?? '', classCharacters(dist, names));
    if (lost !== '') problems.push(`${file} lacks ${JSON.stringify(lost)}`);
  }
  // The cut is made from the build that has the blog's harness pages, so a
  // build without them sets fewer marks than it holds; none may be missing.
  const lostMarks = missing(
    `${terminal?.characters ?? ''}${terminal?.platform ?? ''}`,
    terminalCharacters(dist),
  );
  if (lostMarks !== '') problems.push(`Merkur Terminal lacks ${JSON.stringify(lostMarks)}`);
  return problems;
}

/** Stops the build when the pages set a character their face was not cut with. */
export function fontCoverage(siteRoot: string): Plugin {
  return afterBuild('merkur-site-font-coverage', (outDir) => {
    const problems = coverageProblems(siteRoot, outDir);
    if (problems.length > 0) {
      throw new Error(
        `font-coverage: ${problems.join('; ')}. Re-cut the faces from this build with \`bun run --cwd apps/site subset-fonts\`, then build again.`,
      );
    }
  });
}
