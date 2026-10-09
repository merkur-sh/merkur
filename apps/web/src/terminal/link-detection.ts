// Resolve the link under a grid cell from one viewport read.
//
// Two sources, in a fixed order. An OSC 8 link is the program's own statement of
// what a span of cells points at, so a cell that carries one never falls through
// to text matching. A cell without one is matched as text: the logical line it
// sits in goes through a URL matcher, and the match that covers the cell wins.
// Only `http:` and `https:` targets open — terminal output is untrusted, and an
// OSC 8 target is not shown on screen at all.
//
// A link spans rows only where the grid says so, never where the layout
// suggests it:
// - A row the terminal wrapped continues onto the next: its wrap bit joins them.
// - Runs of one OSC 8 id on adjacent rows, with nothing but blank unlinked cells
//   between them, are one link: a link text wrapped with its indentation left
//   outside the link. An id names exactly one URI, so the join cannot change
//   where a click goes.
// A program that breaks a line itself (a TUI's word wrap, an editor) writes a
// row break the grid cannot tell from the end of the URL, so its text ends the
// link there. Joining by the row's shape would open a different page whenever
// a URL merely ends at the edge of its text.
//
// Box-drawing and block characters are a TUI's frame, never text: they end a
// URL and count as blank.
//
// Pure, and free of the matcher library, so the whole policy is unit-testable
// and the library loads only when a user first holds the link modifier.

/** One authoritative viewport read, taken while the link modifier is held. */
export interface LinkViewport {
  readonly cols: number;
  readonly rows: number;
  /** Untrimmed rows joined by `\n`, wide-character spacers skipped. */
  readonly text: string;
  /** LSB-first, one bit per row: set when the row continues onto the next. */
  readonly wrapBits: Uint8Array;
  /** Grid column of every UTF-16 unit of `text`, newlines excluded. */
  readonly columns: Uint16Array;
  /** OSC 8 link id per cell, row-major, 0 for none. */
  readonly links: Uint32Array;
}

export interface UrlMatch {
  readonly index: number;
  readonly lastIndex: number;
  readonly url: string;
}

export type UrlMatcher = (text: string) => readonly UrlMatch[];

/** Inclusive cell range of a link on one row. */
export interface LinkRowSpan {
  readonly row: number;
  readonly left: number;
  readonly right: number;
}

export interface LinkHit {
  readonly url: string;
  /** Row-major, one entry per row the link covers. */
  readonly spans: readonly LinkRowSpan[];
}

/** An `http:` or `https:` URL in canonical form, or null. */
export function openableUrl(candidate: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
}

const SPACE = 0x20;
// U+2500..U+259F: box drawing and block elements, one UTF-16 unit each.
const FRAME_FIRST = 0x2500;
const FRAME_LAST = 0x259f;
const FRAME_UNITS = /[\u2500-\u259f]/g;

function isBlankUnit(code: number): boolean {
  return code === SPACE || (code >= FRAME_FIRST && code <= FRAME_LAST);
}

function rowWraps(wrapBits: Uint8Array, row: number): boolean {
  return ((wrapBits[row >> 3] ?? 0) & (1 << (row & 7))) !== 0;
}

/** Split a cell-index range into per-row inclusive spans. */
function spansBetween(cols: number, first: number, last: number): LinkRowSpan[] {
  const spans: LinkRowSpan[] = [];
  for (let row = Math.floor(first / cols); row <= Math.floor(last / cols); row++) {
    const rowStart = row * cols;
    spans.push({
      row,
      left: Math.max(first, rowStart) - rowStart,
      right: Math.min(last, rowStart + cols - 1) - rowStart,
    });
  }
  return spans;
}

interface LogicalLine {
  readonly matcher: UrlMatcher;
  /** Existing viewport row boundaries, rebased by the logical line's first unit. */
  readonly columnStarts: Int32Array;
  readonly columnOffset: number;
  /** First cell of every UTF-16 unit of the line's text. */
  readonly cells: readonly number[];
  /** Last cell of every unit: the spacer of a wide character, the margin at a row's end. */
  readonly ends: readonly number[];
  readonly matches: readonly UrlMatch[];
}

interface RowIndex {
  readonly texts: readonly string[];
  /** Row starts in `LinkViewport.columns`, followed by the viewport's final unit offset. */
  readonly columnStarts: Int32Array;
  /** Unit index of each row's first and last text unit, -1 for a row without text. */
  readonly firstInk: Int32Array;
  readonly lastInk: Int32Array;
  /** Matched logical lines, by first row, built on first use. */
  readonly lines: Map<number, LogicalLine>;
}

// One index per viewport read, however many pointer moves resolve against it.
const rowIndexes = new WeakMap<LinkViewport, RowIndex>();

function rowIndexOf(viewport: LinkViewport): RowIndex {
  const cached = rowIndexes.get(viewport);
  if (cached !== undefined) return cached;
  const { rows } = viewport;
  const texts = viewport.text.split('\n');
  const columnStarts = new Int32Array(rows + 1);
  const firstInk = new Int32Array(rows).fill(-1);
  const lastInk = new Int32Array(rows).fill(-1);
  let columnStart = 0;
  for (let row = 0; row < rows; row++) {
    const rowText = texts[row] ?? '';
    columnStarts[row] = columnStart;
    columnStart += rowText.length;
    let first = 0;
    while (first < rowText.length && isBlankUnit(rowText.charCodeAt(first))) first++;
    if (first === rowText.length) continue;
    let last = rowText.length - 1;
    while (isBlankUnit(rowText.charCodeAt(last))) last--;
    firstInk[row] = first;
    lastInk[row] = last;
  }
  columnStarts[rows] = columnStart;
  const index = { texts, columnStarts, firstInk, lastInk, lines: new Map() };
  rowIndexes.set(viewport, index);
  return index;
}

/** Grid column of a row's text unit. */
function unitColumn(viewport: LinkViewport, index: RowIndex, row: number, unit: number): number {
  return viewport.columns[(index.columnStarts[row] ?? 0) + unit] ?? 0;
}

/**
 * The logical line holding `row`, rows joined without a separator exactly where
 * they wrap, with its URL matches.
 */
function logicalLineAt(
  viewport: LinkViewport,
  index: RowIndex,
  row: number,
  matchUrls: UrlMatcher,
): LogicalLine {
  let start = row;
  while (start > 0 && rowWraps(viewport.wrapBits, start - 1)) start--;
  const cached = index.lines.get(start);
  if (cached !== undefined && cached.matcher === matchUrls) return cached;
  const { cols } = viewport;
  let text = '';
  const cells: number[] = [];
  const ends: number[] = [];
  for (let line = start; line < viewport.rows; line++) {
    const rowText = index.texts[line] ?? '';
    const columnStart = index.columnStarts[line] ?? 0;
    text += rowText;
    for (let unit = 0; unit < rowText.length; unit++) {
      const column = viewport.columns[columnStart + unit] ?? 0;
      // A unit covers the cells up to the next unit, so a wide character's
      // spacer belongs to it; a row's last unit reaches the margin. The two
      // units of a surrogate pair share one cell.
      const end =
        unit + 1 < rowText.length
          ? Math.max(column, (viewport.columns[columnStart + unit + 1] ?? 0) - 1)
          : cols - 1;
      cells.push(line * cols + column);
      ends.push(line * cols + end);
    }
    if (!rowWraps(viewport.wrapBits, line)) break;
  }
  const logical = {
    matcher: matchUrls,
    columnStarts: index.columnStarts,
    columnOffset: index.columnStarts[start] ?? 0,
    cells,
    ends,
    // A frame unit is one UTF-16 unit, so blanking it keeps every offset.
    matches: matchUrls(text.replace(FRAME_UNITS, ' ')),
  };
  index.lines.set(start, logical);
  return logical;
}

/** Per-row spans of the cells under text units `[first, end)`. */
function textSpans(line: LogicalLine, cols: number, first: number, end: number): LinkRowSpan[] {
  const spans: LinkRowSpan[] = [];
  const { cells, ends, columnStarts, columnOffset } = line;
  let unit = first;
  while (unit < end) {
    const cell = cells[unit] ?? 0;
    const row = Math.floor(cell / cols);
    const rowEnd = (columnStarts[row + 1] ?? 0) - columnOffset;
    const next = rowEnd < end ? rowEnd : end;
    spans.push({
      row,
      left: cell - row * cols,
      right: (ends[next - 1] ?? cell) - row * cols,
    });
    unit = next;
  }
  return spans;
}

/**
 * Whether the cells `[from, to)` of a row hold no link and no text. The range
 * starts at the row's left edge or ends at its right edge, so the row's outermost
 * text units decide it.
 */
function blankUnlinked(
  viewport: LinkViewport,
  index: RowIndex,
  row: number,
  from: number,
  to: number,
): boolean {
  for (let col = from; col < to; col++) {
    if ((viewport.links[row * viewport.cols + col] ?? 0) !== 0) return false;
  }
  const first = index.firstInk[row] ?? -1;
  if (first < 0) return true;
  const last = index.lastInk[row] ?? -1;
  return (
    unitColumn(viewport, index, row, last) < from || unitColumn(viewport, index, row, first) >= to
  );
}

function osc8LinkAt(
  viewport: LinkViewport,
  cell: number,
  id: number,
  resolve: (id: number) => string | undefined,
): LinkHit | null {
  const uri = resolve(id);
  const url = uri === undefined ? null : openableUrl(uri);
  if (url === null) return null;
  const { cols, rows, links } = viewport;
  const runOf = (at: number): [number, number] => {
    let first = at;
    while (first > 0 && links[first - 1] === id) first--;
    let last = at;
    while (last + 1 < links.length && links[last + 1] === id) last++;
    return [first, last];
  };
  const index = rowIndexOf(viewport);
  const runs = [runOf(cell)];

  // Earlier rows: the run starts after blank cells only, and the row above ends
  // in this id followed by blank cells only.
  for (;;) {
    const [first] = runs[0] ?? [cell, cell];
    const row = Math.floor(first / cols);
    if (row === 0 || !blankUnlinked(viewport, index, row, 0, first - row * cols)) break;
    let before = row * cols - 1;
    while (before >= (row - 1) * cols && links[before] === 0) before--;
    if (before < (row - 1) * cols || links[before] !== id) break;
    if (!blankUnlinked(viewport, index, row - 1, before - (row - 1) * cols + 1, cols)) break;
    runs.unshift(runOf(before));
  }
  // Later rows, the same test mirrored.
  for (;;) {
    const [, last] = runs.at(-1) ?? [cell, cell];
    const row = Math.floor(last / cols);
    if (row + 1 >= rows || !blankUnlinked(viewport, index, row, last - row * cols + 1, cols)) break;
    let after = (row + 1) * cols;
    while (after < (row + 2) * cols && links[after] === 0) after++;
    if (after === (row + 2) * cols || links[after] !== id) break;
    if (!blankUnlinked(viewport, index, row + 1, 0, after - (row + 1) * cols)) break;
    runs.push(runOf(after));
  }
  return { url, spans: runs.flatMap(([first, last]) => spansBetween(cols, first, last)) };
}

export function findLinkAt(
  viewport: LinkViewport,
  row: number,
  col: number,
  resolve: (id: number) => string | undefined,
  matchUrls: UrlMatcher | null,
): LinkHit | null {
  if (row < 0 || row >= viewport.rows || col < 0 || col >= viewport.cols) return null;
  const cell = row * viewport.cols + col;
  const id = viewport.links[cell] ?? 0;
  // A cell the program linked is the program's link even when its target cannot
  // open or its definition is still in flight: it never degrades into a text
  // match that could point somewhere the program did not.
  if (id !== 0) return osc8LinkAt(viewport, cell, id, resolve);
  if (matchUrls === null) return null;

  const line = logicalLineAt(viewport, rowIndexOf(viewport), row, matchUrls);
  for (const match of line.matches) {
    const first = line.cells[match.index];
    const last = line.ends[match.lastIndex - 1];
    if (first === undefined || last === undefined || cell < first || cell > last) continue;
    const url = openableUrl(match.url);
    return url === null
      ? null
      : { url, spans: textSpans(line, viewport.cols, match.index, match.lastIndex) };
  }
  return null;
}
