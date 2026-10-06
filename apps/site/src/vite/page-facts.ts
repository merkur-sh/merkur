/**
 * `pageFacts()`: fills every non-figure name in the pages from the file that
 * states it, so no page types a fact that has a source.
 *
 * - `release.fingerprint`: the release key's fingerprint from `SECURITY.md`.
 * - `limit.*`: the machine limit as the server enforces it.
 * - `site.origin`, `site.host`, `app.origin`, `app.host`, `rybbit.siteId`: the
 *   build's environment (`site-environment.ts`).
 * - `strip.*`: the still of a mock terminal's traffic strip (`link-strip.ts`).
 * - `sim.*`: the commands the "Feels local" terminal types (`sim-script.ts`).
 * - `part.header`, `part.footer`, `part.blogFooter`: the markup pages share
 *   (`src/parts/`).
 * - `blog.link`: the header's link to the blog, in a build that has one.
 * - `legal.privacy`, `legal.terms`: the text of the app's own legal pages.
 * - `color.ground`: the ground token, for the `theme-color` meta.
 * - `retrograde.*`: the still of the sky on the page for an address with
 *   nothing at it (`retrograde-still.ts`).
 *
 * A name with no fact stops the build, and so does a fact whose source is
 * missing or malformed. Loaded by Vite's config bundler: relative imports,
 * builtins and the workspace's own packages only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLORS } from '@merkur/quicksilver/tokens';
import type { Plugin } from 'vite';

import { stripStill } from '../link-strip';
import { simScriptMarkup } from '../sim-script';
import { escapeHtml } from './html';
import { retrogradeStill } from './retrograde-still';
import type { SiteEnvironment } from './site-environment';
import { STRUCTURED_DATA_MARK, structuredData } from './structured-data';

/** A fact is text (escaped where it lands) or markup the build drew itself. */
type Fact = { readonly text: string } | { readonly html: string };

/** The release key's fingerprint, the one `SECURITY.md` asks a first install to compare. */
export function readReleaseFingerprint(securityMarkdown: string): string {
  const section = securityMarkdown.split(/^## /m).find((part) => part.startsWith('Release key'));
  const fingerprint =
    section === undefined ? undefined : /```\n([0-9a-f ]+)\n```/.exec(section)?.[1];
  if (fingerprint === undefined || !/^[0-9a-f]{8}( [0-9a-f]{8}){7}$/.test(fingerprint)) {
    throw new Error(
      'page facts: SECURITY.md has no release-key fingerprint under "## Release key"',
    );
  }
  return fingerprint;
}

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
];

/** The machine limit, read from the line the server enforces it with. */
export function readMachineLimit(serviceSource: string): {
  line: string;
  value: number;
  word: string;
} {
  const match = /^export const MAX_LINKED_MACHINES = (\d+);$/m.exec(serviceSource);
  const value = match === null ? undefined : Number(match[1]);
  const word = value === undefined ? undefined : NUMBER_WORDS[value];
  if (match === null || value === undefined || word === undefined) {
    throw new Error('page facts: no single-digit MAX_LINKED_MACHINES in machine-usage.ts');
  }
  return { line: match[0], value, word };
}

/**
 * The text of one of the app's legal pages: its `<main>`, less that page's own
 * footer. The app serves these pages to its users; the site sets the same text
 * in its own layout, so the two cannot say different things.
 */
export function readLegalBody(html: string): string {
  const main = /<main>([\s\S]*?)<\/main>/.exec(html)?.[1];
  if (main === undefined) throw new Error('page facts: a legal page has no <main>');
  return main.replace(/<footer>[\s\S]*?<\/footer>/, '').trim();
}

export interface PageFactPaths {
  /** `apps/site`. */
  readonly siteRoot: string;
  /** The repository root. */
  readonly repoRoot: string;
  /** Whether the build has a blog, so the header links to it. */
  readonly blog: boolean;
}

/** The markup pages share, by the name a page asks for it with, to its file in `src/parts/`. */
const PARTS = {
  header: 'header.html',
  footer: 'footer.html',
  blogFooter: 'blog-footer.html',
} as const;

/** The header's link to the blog; a build with no blog has nothing to link to. */
const BLOG_LINK =
  '<a href="/blog" data-rybbit-event="nav_click" data-rybbit-prop-to="blog">Blog</a>';

export function collectPageFacts(
  paths: PageFactPaths,
  environment: SiteEnvironment,
): Map<string, Fact> {
  const fingerprint = readReleaseFingerprint(
    readFileSync(join(paths.repoRoot, 'SECURITY.md'), 'utf8'),
  );
  const limit = readMachineLimit(
    readFileSync(join(paths.repoRoot, 'apps/server/src/services/machine-usage.ts'), 'utf8'),
  );
  const legal = (page: string): Fact => ({
    html: readLegalBody(
      readFileSync(join(paths.repoRoot, 'apps/web/public/legal', `${page}.html`), 'utf8'),
    ),
  });
  const sky = retrogradeStill();
  const facts = new Map<string, Fact>([
    ['retrograde.stars', { html: sky.stars }],
    ['retrograde.line', { text: sky.line }],
    ['retrograde.lit', { text: sky.lit }],
    ['retrograde.tail', { html: sky.tail }],
    ['legal.privacy', legal('privacy')],
    ['legal.terms', legal('terms')],
    ['site.origin', { text: environment.siteOrigin }],
    ['site.host', { text: new URL(environment.siteOrigin).host }],
    ['app.origin', { text: environment.appOrigin }],
    ['app.host', { text: new URL(environment.appOrigin).host }],
    ['strip.desk', { html: stripStill('Mac.bbrouter', 104, 22) }],
    ['strip.phone', { html: stripStill('phone', 72, 22) }],
    ['sim.wide', { html: simScriptMarkup('wide') }],
    ['sim.narrow', { html: simScriptMarkup('narrow') }],
    ['rybbit.siteId', { text: environment.rybbitSiteId }],
    ['color.ground', { text: COLORS.ground }],
    ['release.fingerprint', { text: fingerprint }],
    ['limit.line', { text: limit.line }],
    ['limit.value', { text: String(limit.value) }],
    ['limit.word', { text: limit.word }],
    ['blog.link', { html: paths.blog ? BLOG_LINK : '' }],
  ]);
  // A part names facts of its own, so it is filled before any page asks for it.
  for (const [part, name] of Object.entries(PARTS)) {
    const file = `src/parts/${name}`;
    facts.set(`part.${part}`, {
      html: fillPageFacts(readFileSync(join(paths.siteRoot, file), 'utf8'), facts, file),
    });
  }
  return facts;
}

const FACT_NAME = /\[\[([a-z]+(?:\.[A-Za-z0-9]+)+)\]\]/g;

/** Fills every fact name in `html`; any name left over, known or not, stops the build. */
export function fillPageFacts(
  html: string,
  facts: ReadonlyMap<string, Fact>,
  page: string,
): string {
  const filled = html.replace(FACT_NAME, (whole, name: string) => {
    const fact = facts.get(name);
    if (fact === undefined) throw new Error(`page facts: ${page} names ${whole}, no such fact`);
    return 'html' in fact ? fact.html : escapeHtml(fact.text);
  });
  const leftover = /\[\[[^\]]*\]\]/.exec(filled);
  if (leftover !== null)
    throw new Error(`page facts: ${page} names ${leftover[0]}, which is not a fact`);
  return filled;
}

export function pageFacts(paths: PageFactPaths, environment: SiteEnvironment): Plugin {
  let facts: Map<string, Fact> | null = null;
  return {
    name: 'merkur-site-page-facts',
    buildStart() {
      facts = null;
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        facts ??= collectPageFacts(paths, environment);
        const named = fillPageFacts(html, facts, context.path);
        // On a page of the blog the header's link to it is the current one.
        const filled = context.path.startsWith('/blog')
          ? named.replace(BLOG_LINK, BLOG_LINK.replace('>', ' aria-current="page">'))
          : named;
        return filled.includes(STRUCTURED_DATA_MARK)
          ? filled.replace(STRUCTURED_DATA_MARK, structuredData(filled, environment.siteOrigin))
          : filled;
      },
    },
  };
}
