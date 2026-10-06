import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { FIGURES, type Figure } from '../apps/site/src/content/figures';
import {
  LATENCY_MODELS,
  type LatencyCell,
  type LatencyModel,
} from '../apps/site/src/content/latency-model';
import { createFigureRenderer, validateFigures } from '../apps/site/src/vite/figures';
import { NOT_FOUND, ROUTES } from '../apps/site/src/vite/site-manifest';

/**
 * `bun run check:figures`: every measured number merkur.sh prints, against
 * the ledger entry it cites.
 *
 * `apps/site/src/content/figures.ts` names, for each figure, a line of a ledger
 * entry in the private `merkur-private-docs` repository. This check holds the
 * list to both of its ends:
 *
 * - each figure's `text` is a verbatim substring of one line of its entry, and
 *   every number in its caption's version, sample and date appears in that
 *   entry;
 * - every figure, and every value of it, is named by one of the site's pages;
 * - every cell of the latency grids the pages' screens play from
 *   (`apps/site/src/content/latency-model.ts`) stands on its link's row of its
 *   entry's table.
 *
 * The ledger is the checkout beside this one, `../merkur-private-docs`, or the
 * directory `MERKUR_PRIVATE_DOCS` names: the private repository's own gate finds
 * this checkout the same way (`MERKUR_ROOT`). Without it the check cannot run,
 * so it fails and says which directory it looked for. CI has no private
 * checkout and does not run it; `bun run gates` selects it for a change to the
 * figures or to a page that names them. What needs no ledger (ids, tokens,
 * every name filled) the site build and `apps/site/src/vite/figures.test.ts`
 * check everywhere.
 */
const ROOT = path.resolve(import.meta.dir, '..');
const PAGES = [...new Set([...Object.values(ROUTES), NOT_FOUND])].map(
  (page) => `apps/site/${page}`,
);
const NUMBER = /\d+(?:[.,]\d+)*(?:-\d+)*/g;

export function privateDocsRoot(env: Readonly<Record<string, string | undefined>>): string {
  return path.resolve(ROOT, env.MERKUR_PRIVATE_DOCS ?? '../merkur-private-docs');
}

/** What is wrong with the figures against their ledger entries and the pages, one line each. */
export function findFigureViolations(
  figures: readonly Figure[],
  readLedger: (entry: string) => string | undefined,
  pages: ReadonlyArray<readonly [name: string, html: string]>,
): string[] {
  const violations: string[] = [];
  try {
    validateFigures(figures);
    const renderer = createFigureRenderer(figures);
    for (const [name, html] of pages) renderer.render(html, name);
    renderer.assertAllUsed();
  } catch (error) {
    violations.push(error instanceof Error ? error.message : String(error));
  }
  for (const figure of figures) {
    const ledger = readLedger(figure.ledger);
    if (ledger === undefined) {
      violations.push(`${figure.id}: ${figure.ledger} does not exist`);
      continue;
    }
    if (!ledger.split('\n').some((line) => line.includes(figure.text))) {
      violations.push(`${figure.id}: no line of ${figure.ledger} contains "${figure.text}"`);
    }
    const { version, sample, date } = figure.caption;
    for (const number of `${version} ${sample} ${date}`.match(NUMBER) ?? []) {
      if (!ledger.includes(number)) {
        violations.push(`${figure.id}: its caption's ${number} is not in ${figure.ledger}`);
      }
    }
  }
  return violations;
}

/** How a latency cell's link is named in its ledger table. */
export function latencyCellLabel(cell: LatencyCell): string {
  return cell.rtt === 0 ? 'loopback' : `${cell.rtt} ms, ${cell.loss} %`;
}

/**
 * What is wrong with a latency grid the pages' screens play from, against the
 * ledger table it was taken from: every cell's four quantiles stand on the
 * table row that names its link, and the entry names the release measured.
 */
export function findLatencyModelViolations(
  model: LatencyModel,
  readLedger: (entry: string) => string | undefined,
): string[] {
  const name = `latency of ${model.measures}`;
  const ledger = readLedger(model.ledger);
  if (ledger === undefined) return [`${name}: ${model.ledger} does not exist`];
  const violations: string[] = [];
  if (!ledger.includes(model.release)) {
    violations.push(`${name}: ${model.ledger} does not name ${model.release}`);
  }
  const rows = ledger.split('\n');
  for (const cell of model.cells) {
    const label = latencyCellLabel(cell);
    if (!rows.some((row) => row.includes(`| ${label} |`) && row.includes(cell.fence))) {
      violations.push(`${name}: no row of ${model.ledger} for ${label} contains "${cell.fence}"`);
    }
  }
  return violations;
}

if (import.meta.main) {
  const ledgerRoot = privateDocsRoot(process.env);
  if (!existsSync(ledgerRoot)) {
    process.stderr.write(
      `check:figures: the private docs checkout ${ledgerRoot} does not exist; set MERKUR_PRIVATE_DOCS to it.\n`,
    );
    process.exit(1);
  }
  const readLedger = (entry: string): string | undefined => {
    const file = path.join(ledgerRoot, entry);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  };
  const violations = [
    ...findFigureViolations(
      FIGURES,
      readLedger,
      PAGES.map((page) => [page, readFileSync(path.join(ROOT, page), 'utf8')] as const),
    ),
    ...LATENCY_MODELS.flatMap((model) => findLatencyModelViolations(model, readLedger)),
  ];
  if (violations.length > 0) {
    for (const violation of violations) process.stderr.write(`${violation}\n`);
    process.stderr.write(`\n${violations.length} figure violation(s).\n`);
    process.exit(1);
  }
  process.stdout.write(
    `check:figures: pass (${FIGURES.length} figures and ${LATENCY_MODELS.reduce((sum, model) => sum + model.cells.length, 0)} latency cells against ${ledgerRoot})\n`,
  );
}
