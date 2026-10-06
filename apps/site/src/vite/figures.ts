/**
 * `figures()`: fills the pages' figure names from `src/content/figures.ts`.
 *
 * A page never types a measured number. It names one, `[[fig:<id>.<value>]]`,
 * or a provenance line, `[[figcap:<id>]]`, or one part of it,
 * `[[figcap:<id>.<part>]]`, and this plugin writes the text in before Vite reads
 * the page. A name that is not in the figure list stops the build, and so does
 * a figure or a value that no page names, so the list and the pages cannot
 * drift apart in either direction.
 *
 * Loaded by Vite's config bundler, so it imports only relatively and from
 * builtins and types.
 */
import { basename } from 'node:path';
import type { Plugin } from 'vite';

import type { Figure, FigureCaption } from '../content/figures';
import { escapeHtml, keepWhole } from './html';

const FIGURE_NAME = /\[\[(fig|figcap):([^\].]+)(?:\.([^\]]+))?\]\]/g;
const CAPTION_PARTS = ['measurement', 'environment', 'version', 'sample', 'date', 'entry'] as const;
type CaptionPart = (typeof CAPTION_PARTS)[number];

/** Whether `value` stands in `text` as a whole token, not inside a longer number or word. */
function standsAlone(text: string, value: string): boolean {
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
    const before = text.slice(Math.max(0, at - 2), at);
    const after = text.slice(at + value.length, at + value.length + 2);
    const joinsBefore = /[\p{L}\p{N}]$|\d[.,]$/u.test(before);
    const joinsAfter = /^[\p{L}\p{N}]|^[.,]\d/u.test(after);
    if (!joinsBefore && !joinsAfter) return true;
  }
  return false;
}

/** The checks that need no ledger: unique ids, and every value a whole token of its line. */
export function validateFigures(figures: readonly Figure[]): void {
  const ids = new Set<string>();
  for (const figure of figures) {
    if (ids.has(figure.id)) throw new Error(`figures: ${figure.id} is listed twice`);
    ids.add(figure.id);
    const keys = Object.keys(figure.values);
    if (keys.length === 0) throw new Error(`figures: ${figure.id} shows no value`);
    for (const [key, value] of Object.entries(figure.values)) {
      if (!standsAlone(figure.text, value)) {
        throw new Error(
          `figures: ${figure.id}.${key} "${value}" is not a token of its ledger line`,
        );
      }
    }
    for (const part of CAPTION_PARTS) {
      if (part !== 'entry' && figure.caption[part].trim() === '') {
        throw new Error(`figures: ${figure.id} has no caption ${part}`);
      }
    }
  }
}

function captionPart(figure: Figure, part: CaptionPart): string {
  if (part === 'entry') return basename(figure.ledger, '.md');
  return figure.caption[part satisfies keyof FigureCaption];
}

/** The whole provenance line: what, where, which build, how much, when, and the entry. */
export function provenanceLine(figure: Figure): string {
  const { measurement, environment, version, sample, date } = figure.caption;
  return `${measurement} · ${environment}, ${version} · ${sample} · ${date} · lab notes (private): ${captionPart(figure, 'entry')}`;
}

export interface FigureRenderer {
  /** Fills every figure name in `html`; throws on a name that is not in the list. */
  render(html: string, page: string): string;
  /** Throws unless every figure and every value has been named by some page. */
  assertAllUsed(): void;
}

export function createFigureRenderer(figures: readonly Figure[]): FigureRenderer {
  validateFigures(figures);
  const byId = new Map(figures.map((figure) => [figure.id, figure]));
  const used = new Set<string>();

  return {
    render(html, page) {
      return html.replace(FIGURE_NAME, (name, kind: string, id: string, key?: string) => {
        const figure = byId.get(id);
        if (figure === undefined) throw new Error(`figures: ${page} names ${name}, no such figure`);
        used.add(id);
        if (kind === 'fig') {
          const value = key === undefined ? undefined : figure.values[key];
          if (key === undefined || value === undefined) {
            throw new Error(`figures: ${page} names ${name}, no such value`);
          }
          used.add(`${id}.${key}`);
          return escapeHtml(value);
        }
        // A caption keeps its dates, ids and algorithm names whole on a line.
        if (key === undefined) return keepWhole(escapeHtml(provenanceLine(figure)));
        const part = CAPTION_PARTS.find((candidate) => candidate === key);
        if (part === undefined) throw new Error(`figures: ${page} names ${name}, no such part`);
        return keepWhole(escapeHtml(captionPart(figure, part)));
      });
    },
    assertAllUsed() {
      const unused: string[] = [];
      for (const figure of figures) {
        if (!used.has(figure.id)) unused.push(figure.id);
        for (const key of Object.keys(figure.values)) {
          if (!used.has(`${figure.id}.${key}`)) unused.push(`${figure.id}.${key}`);
        }
      }
      if (unused.length > 0) throw new Error(`figures: no page names ${unused.join(', ')}`);
    },
  };
}

export function figures(list: readonly Figure[]): Plugin {
  let renderer = createFigureRenderer(list);
  let building = false;
  return {
    name: 'merkur-site-figures',
    configResolved(config) {
      building = config.command === 'build';
    },
    buildStart() {
      renderer = createFigureRenderer(list);
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        return renderer.render(html, context.path);
      },
    },
    generateBundle() {
      // Every page has been through `transformIndexHtml` by now; a dev server
      // sees one page at a time, so only a build can say what went unused.
      if (building) renderer.assertAllUsed();
    },
  };
}
