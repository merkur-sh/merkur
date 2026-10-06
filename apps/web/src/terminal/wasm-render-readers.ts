export const CURSOR_INFO_LENGTH = 11;

export interface RowHashExports {
  refresh_row_hashes(): number;
  row_hashes_len(): number;
}

/**
 * Read the live per-row grid hashes as dense little-endian (lo, hi) `u32`
 * pairs.
 *
 * Two integer loads per row, against one `BigInt` allocation per row for the
 * per-call `row_hash` export this replaces — and the digest comparison runs
 * over every row of every heartbeat, so that allocation was the recurring cost.
 * Going through `refresh_row_hashes` is required: it is the export that brings
 * the vector up to date before handing back its address.
 */
export function createRowHashReader(
  memory: WebAssembly.Memory,
  terminal: RowHashExports,
): () => Uint32Array {
  let boundBuffer: ArrayBufferLike | null = null;
  let boundPtr = -1;
  let boundWords = -1;
  let view: Uint32Array | null = null;
  return (): Uint32Array => {
    const ptr = terminal.refresh_row_hashes() >>> 0;
    const words = (terminal.row_hashes_len() >>> 0) * 2;
    const buffer = memory.buffer;
    if (view === null || boundBuffer !== buffer || boundPtr !== ptr || boundWords !== words) {
      boundBuffer = buffer;
      boundPtr = ptr;
      boundWords = words;
      // A zero-row grid still has to yield a valid empty view rather than throw.
      view = words === 0 ? new Uint32Array(0) : new Uint32Array(buffer, ptr, words);
    }
    return view;
  };
}

export interface CursorInfoExports {
  cursor_info_ptr(): number;
  cursor_info_len(): number;
}

/**
 * Read the mutable, fixed-size cursor snapshot without allocating a new view
 * for every frame. Calling `cursor_info_ptr` is still required because that
 * export refreshes the snapshot before returning its address.
 */
export function createCursorInfoReader(
  memory: WebAssembly.Memory,
  terminal: CursorInfoExports,
): () => Uint16Array {
  const len = terminal.cursor_info_len() >>> 0;
  if (len !== CURSOR_INFO_LENGTH) {
    throw new RangeError(`invalid terminal cursor info length ${len}`);
  }
  let boundBuffer: ArrayBufferLike | null = null;
  let boundPtr = -1;
  let view: Uint16Array | null = null;
  return (): Uint16Array => {
    const ptr = terminal.cursor_info_ptr() >>> 0;
    const buffer = memory.buffer;
    if (view === null || boundBuffer !== buffer || boundPtr !== ptr) {
      boundBuffer = buffer;
      boundPtr = ptr;
      view = new Uint16Array(buffer, ptr, len);
    }
    return view;
  };
}
