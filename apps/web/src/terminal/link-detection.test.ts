import { describe, expect, test } from 'bun:test';
import { findLinkAt, type LinkViewport, openableUrl } from './link-detection';
import { createUrlMatcher } from './url-matcher';

/** A viewport of single-width ASCII rows, padded to `cols`. */
function viewport(
  rows: readonly string[],
  cols: number,
  options: { readonly wrapped?: readonly number[]; readonly links?: Uint32Array } = {},
): LinkViewport {
  const padded = rows.map((row) => row.padEnd(cols, ' '));
  const columns: number[] = [];
  for (const row of padded) {
    for (let col = 0; col < row.length; col++) columns.push(col);
  }
  const wrapBits = new Uint8Array(Math.ceil(rows.length / 8));
  for (const row of options.wrapped ?? []) {
    wrapBits[row >> 3] = (wrapBits[row >> 3] ?? 0) | (1 << (row & 7));
  }
  return {
    cols,
    rows: rows.length,
    text: padded.join('\n'),
    wrapBits,
    columns: Uint16Array.from(columns),
    links: options.links ?? new Uint32Array(rows.length * cols),
  };
}

const matcher = createUrlMatcher();
const noDefinitions = (): string | undefined => undefined;

describe('findLinkAt', () => {
  test('a plain URL is found under any of its cells and nowhere else', () => {
    const screen = viewport(['  VITE ready: http://127.0.0.1:5173/ now'], 40);
    const hit = findLinkAt(screen, 0, 20, noDefinitions, matcher);
    expect(hit).toEqual({
      url: 'http://127.0.0.1:5173/',
      spans: [{ row: 0, left: 14, right: 35 }],
    });
    expect(findLinkAt(screen, 0, 13, noDefinitions, matcher)).toBeNull();
    expect(findLinkAt(screen, 0, 37, noDefinitions, matcher)).toBeNull();
  });

  test('a URL wrapped across rows is one link spanning both', () => {
    const screen = viewport(['see https://example.com/a/very/', 'long/path done'], 31, {
      wrapped: [0],
    });
    const hit = findLinkAt(screen, 1, 2, noDefinitions, matcher);
    expect(hit?.url).toBe('https://example.com/a/very/long/path');
    expect(hit?.spans).toEqual([
      { row: 0, left: 4, right: 30 },
      { row: 1, left: 0, right: 8 },
    ]);
  });

  test('a row break the terminal did not make ends the URL, even at the margin', () => {
    // A TUI's own word wrap looks exactly like this, and so does a URL that ends
    // at the margin with more output below: only the wrap bit tells them apart.
    const screen = viewport(['see https://example.com/a/very/', '  long/path done'], 31);
    expect(findLinkAt(screen, 0, 10, noDefinitions, matcher)).toEqual({
      url: 'https://example.com/a/very/',
      spans: [{ row: 0, left: 4, right: 30 }],
    });
    expect(findLinkAt(screen, 1, 4, noDefinitions, matcher)).toBeNull();
  });
  test('a frame character ends a URL', () => {
    const screen = viewport(['│https://example.com/path│ next'], 40);
    expect(findLinkAt(screen, 0, 5, noDefinitions, matcher)).toEqual({
      url: 'https://example.com/path',
      spans: [{ row: 0, left: 1, right: 24 }],
    });
  });

  test('trailing punctuation is not part of the link', () => {
    const screen = viewport(['(open https://example.com/docs).'], 40);
    expect(findLinkAt(screen, 0, 10, noDefinitions, matcher)?.url).toBe('https://example.com/docs');
    expect(findLinkAt(screen, 0, 30, noDefinitions, matcher)).toBeNull();
  });

  test('file names and schemaless hosts are not links', () => {
    const screen = viewport(['main.py example.com ftp://files.example.com'], 44);
    for (const col of [2, 10, 25]) {
      expect(findLinkAt(screen, 0, col, noDefinitions, matcher)).toBeNull();
    }
  });

  test('columns map text back to cells past a wide character', () => {
    // 界 occupies columns 0-1; its spacer is absent from the text.
    const text = '界 https://example.com  ';
    const columns = Uint16Array.from([0, 2, ...Array.from({ length: 21 }, (_, i) => 3 + i)]);
    const screen: LinkViewport = {
      cols: 24,
      rows: 1,
      text,
      wrapBits: new Uint8Array(1),
      columns,
      links: new Uint32Array(24),
    };
    expect(findLinkAt(screen, 0, 3, noDefinitions, matcher)?.spans).toEqual([
      { row: 0, left: 3, right: 21 },
    ]);
    expect(findLinkAt(screen, 0, 2, noDefinitions, matcher)).toBeNull();
  });

  test('an OSC 8 link resolves through its definition and wins over the text', () => {
    const links = new Uint32Array(30);
    links.fill(7, 0, 4);
    const screen = viewport(['docs https://text.example'], 30, { links });
    const definitions = (id: number) => (id === 7 ? 'https://osc8.example/target' : undefined);
    expect(findLinkAt(screen, 0, 1, definitions, matcher)).toEqual({
      url: 'https://osc8.example/target',
      spans: [{ row: 0, left: 0, right: 3 }],
    });
    expect(findLinkAt(screen, 0, 10, definitions, matcher)?.url).toBe('https://text.example/');
  });

  test('an OSC 8 link that cannot open, or is not yet defined, is inert', () => {
    const links = new Uint32Array(30);
    links.fill(3, 0, 20);
    const screen = viewport(['https://looks.example/ok'], 30, { links });
    expect(findLinkAt(screen, 0, 5, () => 'javascript:alert(1)', matcher)).toBeNull();
    expect(findLinkAt(screen, 0, 5, noDefinitions, matcher)).toBeNull();
  });

  test('a wide character at the end of a link is underlined across both its cells', () => {
    const text = 'https://example.com/界 ';
    const columns = Uint16Array.from([...Array.from({ length: 21 }, (_, i) => i), 22]);
    const screen: LinkViewport = {
      cols: 23,
      rows: 1,
      text,
      wrapBits: new Uint8Array(1),
      columns,
      links: new Uint32Array(23),
    };
    expect(findLinkAt(screen, 0, 21, noDefinitions, matcher)?.spans).toEqual([
      { row: 0, left: 0, right: 21 },
    ]);
  });

  test('an OSC 8 link wrapped with its indentation outside the link is one link', () => {
    const cols = 20;
    const links = new Uint32Array(cols * 3);
    links.fill(5, 6, 16); // row 0 "read the d" ... ends before the margin
    links.fill(5, cols + 2, cols + 11); // row 1 "ocs page."
    links.fill(5, 2 * cols + 2, 2 * cols + 6); // row 2, same URI later on
    const screen = viewport(['  see read the d', '  ocs page.', '  docs'], cols, { links });
    const definitions = (id: number) => (id === 5 ? 'https://docs.example/' : undefined);
    expect(findLinkAt(screen, 1, 4, definitions, matcher)).toEqual({
      url: 'https://docs.example/',
      spans: [
        { row: 0, left: 6, right: 15 },
        { row: 1, left: 2, right: 10 },
        { row: 2, left: 2, right: 5 },
      ],
    });
  });

  test('OSC 8 runs with text between them stay separate links', () => {
    const cols = 12;
    const links = new Uint32Array(cols * 2);
    links.fill(5, 0, 4);
    links.fill(5, cols + 4, cols + 8);
    const screen = viewport(['docs  more', '->  docs'], cols, { links });
    const definitions = (id: number) => (id === 5 ? 'https://docs.example/' : undefined);
    expect(findLinkAt(screen, 0, 1, definitions, matcher)?.spans).toEqual([
      { row: 0, left: 0, right: 3 },
    ]);
    expect(findLinkAt(screen, 1, 5, definitions, matcher)?.spans).toEqual([
      { row: 1, left: 4, right: 7 },
    ]);
  });

  test('out-of-grid cells find nothing', () => {
    const screen = viewport(['https://example.com'], 20);
    expect(findLinkAt(screen, 1, 0, noDefinitions, matcher)).toBeNull();
    expect(findLinkAt(screen, 0, 20, noDefinitions, matcher)).toBeNull();
  });

  test('a long wrapped URL keeps exact row spans at every cell', () => {
    const url = `https://example.com/${'segment/'.repeat(30)}end`;
    const text = `see ${url} done`;
    for (const cols of [1, 2, 8, 31, 120]) {
      const rows: string[] = [];
      const wrapped: number[] = [];
      for (let offset = 0; offset < text.length; offset += cols) {
        rows.push(text.slice(offset, offset + cols));
        if (offset + cols < text.length) wrapped.push(rows.length - 1);
      }
      const screen = viewport(rows, cols, { wrapped });
      const spans = [];
      const first = 4;
      const last = first + url.length - 1;
      const firstRow = Math.floor(first / cols);
      for (let row = firstRow; row <= Math.floor(last / cols); row += 1) {
        spans.push({
          row,
          left: row === firstRow ? first % cols : 0,
          right: row === Math.floor(last / cols) ? last % cols : cols - 1,
        });
      }
      for (let cell = first; cell <= last; cell += 1) {
        expect(
          findLinkAt(screen, Math.floor(cell / cols), cell % cols, noDefinitions, matcher),
        ).toEqual({
          url,
          spans,
        });
      }
    }
  });

  test('surrogate units and wide spacers preserve each wrapped row extent', () => {
    const screen: LinkViewport = {
      cols: 6,
      rows: 3,
      text: 'a😀界\n\nb界',
      wrapBits: Uint8Array.of(3),
      columns: Uint16Array.of(0, 1, 1, 2, 0, 1),
      links: new Uint32Array(18),
    };
    const matchAll = (text: string) => [
      { index: 0, lastIndex: text.length, url: 'https://example.com/' },
    ];
    const expected = {
      url: 'https://example.com/',
      spans: [
        { row: 0, left: 0, right: 5 },
        { row: 2, left: 0, right: 5 },
      ],
    };
    expect(findLinkAt(screen, 0, 3, noDefinitions, matchAll)).toEqual(expected);
    expect(findLinkAt(screen, 2, 2, noDefinitions, matchAll)).toEqual(expected);
  });

  test('every subrange keeps the first and last cell on each nonempty row', () => {
    const screen: LinkViewport = {
      cols: 6,
      rows: 4,
      text: 'abcd\n\nef\nghi',
      wrapBits: Uint8Array.of(7),
      columns: Uint16Array.of(0, 1, 2, 3, 0, 1, 0, 1, 2),
      links: new Uint32Array(24),
    };
    const cells = [0, 1, 2, 3, 12, 13, 18, 19, 20];
    const ends = [0, 1, 2, 5, 12, 17, 18, 19, 23];
    for (let first = 0; first < cells.length; first += 1) {
      for (let end = first + 1; end <= cells.length; end += 1) {
        const match = () => [{ index: first, lastIndex: end, url: 'https://example.com/' }];
        const spans = [];
        for (let row = 0; row < screen.rows; row += 1) {
          const units = cells.slice(first, end).filter((cell) => Math.floor(cell / 6) === row);
          if (units.length === 0) continue;
          const last = cells.indexOf(units.at(-1) ?? 0);
          spans.push({
            row,
            left: (units[0] ?? 0) - row * 6,
            right: (ends[last] ?? 0) - row * 6,
          });
        }
        const cell = cells[first] ?? 0;
        expect(
          findLinkAt(screen, Math.floor(cell / 6), cell % 6, noDefinitions, match)?.spans,
        ).toEqual(spans);
      }
    }
  });
});

describe('openableUrl', () => {
  test('only http and https open', () => {
    expect(openableUrl('https://example.com')).toBe('https://example.com/');
    expect(openableUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x');
    for (const refused of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'x']) {
      expect(openableUrl(refused)).toBeNull();
    }
  });
});
