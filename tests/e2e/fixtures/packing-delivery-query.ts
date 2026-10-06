/** Test-only response observer. It performs no work on display/apply/render callbacks. */
export const PACKING_QUERY_MARKER = '[merkur-packing-semantic-query]';

export interface PackingSemanticQuery {
  readonly ordinal: number;
  readonly atMs: number;
  readonly observedAtMs: number;
  readonly cols: number;
  readonly rows: number;
  /** Fresh hashes of canonical cells via rowHash(row), not sender metadata/cache. */
  readonly rowHashes: readonly string[];
  readonly wrapBits: readonly number[];
  /** Exact last-submitted cursor instance: x,y,width,height,r,g,b,shape. */
  readonly cursor: readonly number[];
  readonly versions: {
    readonly bg: number;
    readonly glyph: number;
    readonly deco: number;
    readonly cursor: number;
  };
}

/**
 * Resolve the stable renderer/viewport property contracts in the compiled
 * worker, then instrument ONLY its viewport read. Ambiguous/drifted bundles
 * fail closed. No production flag, hot callback, or geometry rebuild exists.
 */
export function instrumentPackingSemanticQuery(source: string): string {
  const identifier = '[$A-Z_a-z][$\\w]*';
  const render = new RegExp(
    `(${identifier})\\.render\\((${identifier})\\.memory\\.buffer,` +
      `(${identifier})\\.bg,\\3\\.glyph,\\3\\.deco,\\3\\.cursor,` +
      '\\3\\.viewport,\\3\\.versions\\)',
    'g',
  );
  const viewport = new RegExp(
    `(${identifier})\\?\\.viewportRows\\(\\)\\s*\\?\\?\\s*(?:""|'')`,
    'g',
  );
  const renders = [...source.matchAll(render)];
  const queries = [...source.matchAll(viewport)];
  const terminal = renders[0]?.[2];
  const state = renders[0]?.[3];
  if (
    source.includes(PACKING_QUERY_MARKER) ||
    renders.length !== 1 ||
    queries.length !== 1 ||
    terminal === undefined ||
    state === undefined ||
    queries[0]?.[1] !== terminal
  )
    throw new Error('packing query requires one matching uninstrumented render/viewport contract');
  return `${QUERY_OBSERVER}\n${source.replace(
    viewport,
    (original) => `(__merkurPackingSemanticQuery(${terminal},${state}),${original})`,
  )}`;
}

const QUERY_OBSERVER = `
const __merkurPackingSemanticQuery = (() => {
  let ordinal = 0;
  return (terminal, state) => {
    if (terminal == null) throw new Error('packing semantic query has no terminal');
    const atMs = performance.timeOrigin + performance.now();
    const cols = terminal.cols(), rows = terminal.rows();
    if (!Number.isInteger(cols) || cols < 1 || cols > 512 ||
        !Number.isInteger(rows) || rows < 1 || rows > 256 || ++ordinal > 512)
      throw new Error('packing semantic query exceeds fixed geometry/query bounds');
    const rowHashes = [];
    // rowHash recomputes XXH3 from canonical applied cells. It deliberately
    // avoids the incremental vector so a stale dirty bit cannot certify state.
    for (let row = 0; row < rows; row++) rowHashes.push(terminal.rowHash(row).toString(16).padStart(16,'0'));
    const count = state.cursor.count, ptr = state.cursor.ptr;
    if (!Number.isInteger(count) || count < 0 || count > 1 || !Number.isInteger(ptr) || ptr < 0 || ptr % 4 !== 0 ||
        ptr + count * 32 > terminal.memory.buffer.byteLength)
      throw new Error('packing semantic query has invalid cursor ownership');
    // Bind after all hashing calls: WASM memory may have grown while hashing.
    const cursor = Array.from(new Float32Array(terminal.memory.buffer, ptr, count * 8));
    const wrapBits = Array.from(terminal.viewportWrapBits());
    const versions = { bg:state.versions.bg, glyph:state.versions.glyph, deco:state.versions.deco, cursor:state.versions.cursor };
    console.debug('[merkur-packing-semantic-query]' + JSON.stringify({ ordinal, atMs,
      observedAtMs:performance.timeOrigin + performance.now(), cols, rows, rowHashes, wrapBits, cursor, versions }));
  };
})();`;

export function parsePackingSemanticQuery(text: string): PackingSemanticQuery | null {
  if (!text.startsWith(PACKING_QUERY_MARKER)) return null;
  const value: unknown = JSON.parse(text.slice(PACKING_QUERY_MARKER.length));
  if (typeof value !== 'object' || value === null) throw new Error('invalid packing query');
  const entry = value as Record<string, unknown>;
  const integer = (key: string, min: number, max: number): boolean => {
    const number = entry[key];
    return (
      typeof number === 'number' && Number.isSafeInteger(number) && number >= min && number <= max
    );
  };
  if (
    !integer('ordinal', 1, 512) ||
    !integer('cols', 1, 512) ||
    !integer('rows', 1, 256) ||
    typeof entry.atMs !== 'number' ||
    !Number.isFinite(entry.atMs) ||
    typeof entry.observedAtMs !== 'number' ||
    !Number.isFinite(entry.observedAtMs) ||
    entry.observedAtMs < entry.atMs ||
    !Array.isArray(entry.rowHashes) ||
    entry.rowHashes.length !== entry.rows ||
    entry.rowHashes.some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{16}$/u.test(hash)) ||
    !Array.isArray(entry.wrapBits) ||
    entry.wrapBits.length !== Math.ceil(Number(entry.rows) / 8) ||
    entry.wrapBits.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255) ||
    !Array.isArray(entry.cursor) ||
    ![0, 8].includes(entry.cursor.length) ||
    entry.cursor.some((number) => typeof number !== 'number' || !Number.isFinite(number)) ||
    typeof entry.versions !== 'object' ||
    entry.versions === null ||
    !['bg', 'glyph', 'deco', 'cursor'].every((key) => {
      const number = (entry.versions as Record<string, unknown>)[key];
      return (
        typeof number === 'number' &&
        Number.isSafeInteger(number) &&
        number >= 0 &&
        number <= 0xffff_ffff
      );
    })
  )
    throw new Error('invalid packing query dimensions, canonical rows or cursor');
  return value as PackingSemanticQuery;
}
