/** Test-only observer. Its row hashing perturbs work: never use this run for latency claims. */
export const REFERENCE_RENDER_CONTENT_MARKER = '[merkur-reference-render-content]';

export interface ReferenceRenderContent {
  readonly ordinal: number;
  readonly atMs: number;
  readonly observedAtMs: number;
  readonly stateRevision: number;
  readonly changedRows: number;
  readonly cursorChanged: boolean;
  readonly cols: number;
  readonly rows: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly atlasGeneration: number;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
}

/**
 * Instrument the one final GPU submission call in either reference build.
 * Property names are part of the renderer contract; only local minified names
 * vary. Refuse missing or ambiguous matches instead of running uninstrumented.
 * Native GPU calls, buffers and arguments remain untouched. No runtime Merkur
 * flag or production observer is installed.
 */
export function instrumentReferenceRenderContent(source: string): string {
  const identifier = '[$A-Z_a-z][$\\w]*';
  const call = new RegExp(
    `(${identifier})\\.render\\((${identifier})\\.memory\\.buffer,` +
      `(${identifier})\\.bg,\\3\\.glyph,\\3\\.deco,\\3\\.cursor,` +
      '\\3\\.viewport,\\3\\.versions\\)',
    'g',
  );
  const matches = [...source.matchAll(call)];
  const match = matches[0];
  if (
    matches.length !== 1 ||
    match === undefined ||
    source.includes(REFERENCE_RENDER_CONTENT_MARKER)
  )
    throw new Error('reference content observer requires exactly one uninstrumented render call');
  const terminal = match[2];
  const state = match[3];
  if (terminal === undefined || state === undefined) throw new Error('invalid render call capture');
  return `${CONTENT_OBSERVER}\n${source.replace(
    call,
    (original) => `(__merkurReferenceRenderContent(${terminal},${state}),${original})`,
  )}`;
}

// Retain exact words, not a second lossy hash. Equality has precisely the same
// collision boundary as Merkur's authoritative 64-bit row hashes. Only changed
// words are written. Read cursor geometry, never cursorInfo(): the latter also
// updates Merkur's cursor-motion telemetry. Fixed storage is 2 KiB + 32 bytes.
const CONTENT_OBSERVER = `
const __merkurReferenceRenderContent = (() => {
  const previousRows = new Uint32Array(512);
  const previousCursor = new Uint32Array(8);
  let memoryBuffer = null, memoryWords = null, previousCursorWords = -1;
  let previousCols = -1, previousRowCount = -1, previousWidth = -1, previousHeight = -1;
  let previousAtlas = -1, previousAtlasWidth = -1, previousAtlasHeight = -1;
  let ordinal = 0, stateRevision = 0;
  return (terminal, state) => {
    const atMs = performance.timeOrigin + performance.now();
    const cols = terminal.cols(), rows = terminal.rows();
    const hashes = terminal.rowHashes(), cursorWords = state.cursor.count * 8;
    if (rows < 1 || rows > 256 || hashes.length !== rows * 2 ||
        !Number.isInteger(cursorWords) || cursorWords < 0 || cursorWords > 8)
      throw new Error('reference content observer received an invalid grid');
    if (memoryBuffer !== terminal.memory.buffer) {
      memoryBuffer = terminal.memory.buffer; memoryWords = new Uint32Array(memoryBuffer);
    }
    const cursorOffset = state.cursor.ptr >>> 2;
    if (state.cursor.ptr % 4 !== 0 || cursorOffset + cursorWords > memoryWords.length)
      throw new Error('reference content observer received invalid cursor geometry');
    const viewportWidth = state.viewport[0], viewportHeight = state.viewport[1];
    const atlasGeneration = terminal.atlasGeneration();
    const atlasWidth = terminal.atlasWidth(), atlasHeight = terminal.atlasHeight();
    const geometryChanged = cols !== previousCols || rows !== previousRowCount ||
      viewportWidth !== previousWidth || viewportHeight !== previousHeight;
    let changedRows = 0, cursorChanged = geometryChanged || cursorWords !== previousCursorWords;
    for (let row = 0; row < rows; row++) {
      const low = row * 2, high = low + 1;
      if (geometryChanged || hashes[low] !== previousRows[low] || hashes[high] !== previousRows[high]) {
        changedRows++;
        previousRows[low] = hashes[low]; previousRows[high] = hashes[high];
      }
    }
    for (let index = 0; index < cursorWords; index++) {
      const word = memoryWords[cursorOffset + index];
      if (word !== previousCursor[index]) {
        cursorChanged = true; previousCursor[index] = word;
      }
    }
    if (changedRows !== 0 || cursorChanged || atlasGeneration !== previousAtlas ||
        atlasWidth !== previousAtlasWidth || atlasHeight !== previousAtlasHeight) stateRevision++;
    previousCols = cols; previousRowCount = rows;
    previousWidth = viewportWidth; previousHeight = viewportHeight; previousAtlas = atlasGeneration;
    previousCursorWords = cursorWords; previousAtlasWidth = atlasWidth; previousAtlasHeight = atlasHeight;
    if (++ordinal > 16384) throw new Error('reference content observer capacity exceeded');
    console.debug('[merkur-reference-render-content]' + JSON.stringify({ ordinal, atMs,
      observedAtMs: performance.timeOrigin + performance.now(), stateRevision,
      changedRows, cursorChanged, cols, rows, viewportWidth, viewportHeight,
      atlasGeneration, atlasWidth, atlasHeight }));
  };
})();`;

export function parseReferenceRenderContent(text: string): ReferenceRenderContent | null {
  if (!text.startsWith(REFERENCE_RENDER_CONTENT_MARKER)) return null;
  const value: unknown = JSON.parse(text.slice(REFERENCE_RENDER_CONTENT_MARKER.length));
  assertReferenceRenderContent(value);
  return value;
}

export function assertReferenceRenderContent(
  value: unknown,
): asserts value is ReferenceRenderContent {
  if (typeof value !== 'object' || value === null) throw new Error('invalid content observation');
  const entry = value as Record<string, unknown>;
  for (const field of [
    'ordinal',
    'stateRevision',
    'cols',
    'rows',
    'viewportWidth',
    'viewportHeight',
    'atlasWidth',
    'atlasHeight',
  ]) {
    if (!Number.isSafeInteger(entry[field]) || Number(entry[field]) <= 0)
      throw new Error(`invalid content observation ${field}`);
  }
  for (const field of ['changedRows', 'atlasGeneration']) {
    if (!Number.isSafeInteger(entry[field]) || Number(entry[field]) < 0)
      throw new Error(`invalid content observation ${field}`);
  }
  for (const field of ['atMs', 'observedAtMs']) {
    if (typeof entry[field] !== 'number' || !Number.isFinite(entry[field]))
      throw new Error(`invalid content observation ${field}`);
  }
  if (
    typeof entry.cursorChanged !== 'boolean' ||
    Number(entry.changedRows) > Number(entry.rows) ||
    Number(entry.rows) > 256 ||
    Number(entry.ordinal) > 16384 ||
    Number(entry.stateRevision) > Number(entry.ordinal) ||
    Number(entry.observedAtMs) < Number(entry.atMs)
  )
    throw new Error('inconsistent content observation');
}
