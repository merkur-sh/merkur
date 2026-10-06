import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { FIGURES, type Figure } from '../content/figures';
import { createFigureRenderer, provenanceLine, validateFigures } from './figures';
import { keepWhole } from './html';
import { NOT_FOUND, ROUTES } from './site-manifest';

const figure: Figure = {
  id: 'direct-drawn',
  text: '| local direct (rtt < 5) | 364 | 4 | 0.4 | 6.0 | 7.5 | 10.9 | 29.9 / 101.9 |',
  ledger: 'ledger/2026-09-20-mosh-side-by-side.md',
  values: { drawn: '10.9', rtt: '0.4' },
  caption: {
    measurement: 'p50 keystroke → drawn',
    environment: 'production',
    version: 'v0.60.2',
    sample: '364 keystrokes, 4 sessions',
    date: '2026-09-20',
  },
};

describe('figures()', () => {
  test('fills values, whole provenance lines and single caption parts', () => {
    const renderer = createFigureRenderer([figure]);
    expect(
      renderer.render('<p>[[fig:direct-drawn.drawn]] ms at [[fig:direct-drawn.rtt]]</p>', '/'),
    ).toBe('<p>10.9 ms at 0.4</p>');
    expect(
      renderer.render('[[figcap:direct-drawn.entry]] · [[figcap:direct-drawn.sample]]', '/'),
    ).toBe('<span class="nw">2026-09-20-mosh-side-by-side</span> · 364 keystrokes, 4 sessions');
    expect(renderer.render('[[figcap:direct-drawn]]', '/')).toBe(
      'p50 keystroke → drawn · production, v0.60.2 · 364 keystrokes, 4 sessions · <span class="nw">2026-09-20</span> · lab notes (private): <span class="nw">2026-09-20-mosh-side-by-side</span>',
    );
    renderer.assertAllUsed();
  });

  test('a name with no figure, value or part behind it stops the build', () => {
    const renderer = createFigureRenderer([figure]);
    expect(() => renderer.render('[[fig:nothing.drawn]]', '/index.html')).toThrow(
      '/index.html names [[fig:nothing.drawn]], no such figure',
    );
    expect(() => renderer.render('[[fig:direct-drawn.p99]]', '/')).toThrow('no such value');
    expect(() => renderer.render('[[fig:direct-drawn]]', '/')).toThrow('no such value');
    expect(() => renderer.render('[[figcap:direct-drawn.author]]', '/')).toThrow('no such part');
  });

  test('a figure, or one of its values, that no page names stops the build', () => {
    const unused = createFigureRenderer([figure, { ...figure, id: 'spare' }]);
    unused.render('[[fig:direct-drawn.drawn]] [[fig:direct-drawn.rtt]]', '/');
    expect(() => unused.assertAllUsed()).toThrow('no page names spare, spare.drawn, spare.rtt');
    const half = createFigureRenderer([figure]);
    half.render('[[fig:direct-drawn.drawn]]', '/');
    expect(() => half.assertAllUsed()).toThrow('no page names direct-drawn.rtt');
  });

  test('a value must be a whole token of its ledger line', () => {
    expect(() => validateFigures([{ ...figure, values: { drawn: '10' } }])).toThrow(
      'direct-drawn.drawn "10" is not a token of its ledger line',
    );
    expect(() => validateFigures([{ ...figure, values: { share: '.9' } }])).toThrow('not a token');
    expect(() => validateFigures([figure, figure])).toThrow('direct-drawn is listed twice');
  });

  test('what it writes is escaped', () => {
    const renderer = createFigureRenderer([
      { ...figure, text: 'a <b> c', values: { tag: '<b>' }, caption: { ...figure.caption } },
    ]);
    expect(renderer.render('[[fig:direct-drawn.tag]]', '/')).toBe('&lt;b&gt;');
  });

  test('the site’s pages name every figure and every value, and only real ones', () => {
    const renderer = createFigureRenderer(FIGURES);
    for (const page of [...Object.values(ROUTES), NOT_FOUND]) {
      renderer.render(readFileSync(new URL(`../../${page}`, import.meta.url), 'utf8'), page);
    }
    renderer.assertAllUsed();
  });

  test('no caption can break a date, an entry id or an algorithm name at its own hyphen', () => {
    const renderer = createFigureRenderer(FIGURES);
    for (const entry of FIGURES) {
      for (const part of ['', '.environment', '.version', '.sample', '.date', '.entry']) {
        const html = renderer.render(`[[figcap:${entry.id}${part}]]`, '/');
        // With every kept-whole span taken out, no hyphen is left between digits.
        const outside = html.replace(/<span class="nw">[^<]*<\/span>/g, '');
        expect({ id: entry.id, part, outside }).not.toMatchObject({
          outside: expect.stringMatching(/\d-\d|\d{4}-/),
        });
      }
    }
    expect(keepWhole('ML-KEM-1024 and ChaCha20-Poly1305, linux-x64, 09-26')).toBe(
      '<span class="nw">ML-KEM-1024</span> and <span class="nw">ChaCha20-Poly1305</span>, <span class="nw">linux-x64</span>, <span class="nw">09-26</span>',
    );
  });

  test('a whole provenance line reads as one line', () => {
    for (const entry of FIGURES) expect(provenanceLine(entry)).not.toContain('\n');
  });
});
