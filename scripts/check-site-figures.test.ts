import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import type { Figure } from '../apps/site/src/content/figures';
import {
  findFigureViolations,
  findLatencyModelViolations,
  privateDocsRoot,
} from './check-site-figures';

const figure: Figure = {
  id: 'direct-drawn',
  text: '| local direct (rtt < 5) | 364 | 4 | 0.4 | 6.0 | 7.5 | 10.9 | 29.9 / 101.9 |',
  ledger: 'ledger/2026-09-20-mosh-side-by-side.md',
  values: { drawn: '10.9' },
  caption: {
    measurement: 'p50 keystroke → drawn',
    environment: 'production',
    version: 'v0.60.2',
    sample: '364 keystrokes, 4 sessions',
    date: '2026-09-20',
  },
};

const LEDGER = `# 2026-09-20: Mosh side by side\n\nBuild v0.60.2.\n\n${figure.text}\n`;
const PAGE: readonly [string, string] = ['index.html', '<p>[[fig:direct-drawn.drawn]] ms</p>'];

describe('check:figures', () => {
  test('a figure whose line and caption numbers are in its entry, named by a page, passes', () => {
    expect(findFigureViolations([figure], () => LEDGER, [PAGE])).toEqual([]);
  });

  test('a line the entry does not hold, a caption number it does not state, or a missing entry fails', () => {
    expect(
      findFigureViolations(
        [{ ...figure, text: '| local direct | 365 |', values: { n: '365' } }],
        () => LEDGER,
        [['index.html', '[[fig:direct-drawn.n]]']],
      ),
    ).toEqual([
      'direct-drawn: no line of ledger/2026-09-20-mosh-side-by-side.md contains "| local direct | 365 |"',
    ]);
    expect(
      findFigureViolations(
        [{ ...figure, caption: { ...figure.caption, version: 'v0.61.0' } }],
        () => LEDGER,
        [PAGE],
      ),
    ).toEqual([
      "direct-drawn: its caption's 0.61.0 is not in ledger/2026-09-20-mosh-side-by-side.md",
    ]);
    expect(findFigureViolations([figure], () => undefined, [PAGE])).toEqual([
      'direct-drawn: ledger/2026-09-20-mosh-side-by-side.md does not exist',
    ]);
  });

  test('a figure no page names fails', () => {
    expect(findFigureViolations([figure], () => LEDGER, [['index.html', '<p></p>']])).toEqual([
      'figures: no page names direct-drawn, direct-drawn.drawn',
    ]);
  });

  test('a latency grid whose every cell stands on its link’s row of the entry passes', () => {
    const model = {
      measures: 'a key',
      ledger: 'ledger/2026-10-04-grid.md',
      release: 'v0.70.1',
      cells: [
        { rtt: 0, loss: 0, fence: '1.56 / 2.03 / 2.85 / 8.91' },
        { rtt: 0, loss: 3, fence: '1.56 / 2.03 / 2.85 / 8.91' },
        { rtt: 120, loss: 3, fence: '130.1 / 145.9 / 161.8 / 165.4' },
      ],
    };
    const entry = [
      '# 2026-10-04 grid, v0.70.1',
      '| loopback | a | b | c | 1.56 / 2.03 / 2.85 / 8.91 |',
      '| 120 ms, 3 % | a | b | c | 130.1 / 145.9 / 161.8 / 165.4 |',
      '| 120 ms, 9 % | a | b | c | 138.6 / 160.9 / 173.0 / 173.1 |',
    ].join('\n');
    expect(findLatencyModelViolations(model, () => entry)).toEqual([]);

    // The right numbers on another link's row are not this link's numbers.
    expect(
      findLatencyModelViolations(
        { ...model, cells: [{ rtt: 120, loss: 3, fence: '138.6 / 160.9 / 173.0 / 173.1' }] },
        () => entry,
      ),
    ).toEqual([
      'latency of a key: no row of ledger/2026-10-04-grid.md for 120 ms, 3 % contains "138.6 / 160.9 / 173.0 / 173.1"',
    ]);
    expect(findLatencyModelViolations({ ...model, release: 'v0.71.0' }, () => entry)).toEqual([
      'latency of a key: ledger/2026-10-04-grid.md does not name v0.71.0',
    ]);
    expect(findLatencyModelViolations(model, () => undefined)).toEqual([
      'latency of a key: ledger/2026-10-04-grid.md does not exist',
    ]);
  });

  test('the ledger is the checkout beside this one unless MERKUR_PRIVATE_DOCS names another', () => {
    const repository = path.resolve(import.meta.dir, '..');
    expect(privateDocsRoot({})).toBe(path.resolve(repository, '../merkur-private-docs'));
    expect(privateDocsRoot({ MERKUR_PRIVATE_DOCS: '/srv/ledger' })).toBe('/srv/ledger');
  });
});
