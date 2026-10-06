import { DISPLAY_COLOR_MODE_INDEXED, DISPLAY_ROW_PREFIX_BYTES } from '../../packages/shared/src';

/**
 * A display row body of `rows` plain text rows, `cols` cells each, as
 * merkur-codec encodes them: the row prefix, the indexed colour mode, then one
 * default-style cell per column (tag 0 and a one-byte codepoint). `next` yields
 * each cell's printable ASCII codepoint. The zstd fixture refuses anything that
 * is not a row body, because a compressed frame carries the rows' split layout.
 */
export function createTextRowBody(rows: number, cols: number, next: () => number): Uint8Array {
  const cellBytes = 1 + cols * 2;
  const body = new Uint8Array(rows * (DISPLAY_ROW_PREFIX_BYTES + cellBytes));
  const view = new DataView(body.buffer);
  let offset = 0;
  for (let row = 0; row < rows; row += 1) {
    view.setUint16(offset, row);
    view.setUint16(offset + 4, cols);
    view.setUint16(offset + 6, cellBytes);
    offset += DISPLAY_ROW_PREFIX_BYTES;
    body[offset++] = DISPLAY_COLOR_MODE_INDEXED;
    for (let col = 0; col < cols; col += 1) {
      const codepoint = next();
      if (codepoint < 0x20 || codepoint > 0x7e) {
        throw new RangeError(`text row codepoint ${codepoint} is not printable ASCII`);
      }
      body[offset++] = 0;
      body[offset++] = codepoint;
    }
  }
  return body;
}

/** Text rows of a seeded generator's printable ASCII; equal seeds give equal rows. */
export function createSeededTextRows(rows: number, cols: number, seed: number): Uint8Array {
  let state = seed >>> 0;
  return createTextRowBody(rows, cols, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return 0x20 + ((state >>> 25) & 0x3f);
  });
}

/**
 * A display dictionary capped at `maxBytes`, trained by the zstd fixture binary
 * on seeded text rows several times the cap, as the daemon's screen is. The
 * terminal refuses a dictionary its decoder cannot parse, so benchmarks cannot
 * hand it arbitrary bytes.
 */
export function trainFixtureDictionary(
  fixture: string,
  cwd: string,
  cols: number,
  maxBytes: number,
  seed: number,
): Uint8Array {
  const rowBytes = DISPLAY_ROW_PREFIX_BYTES + 1 + cols * 2;
  const result = Bun.spawnSync(
    [fixture, '--make-dictionary', `--max-dictionary-bytes=${maxBytes}`],
    {
      cwd,
      stdin: createSeededTextRows(Math.ceil((4 * maxBytes) / rowBytes), cols, seed),
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );
  if (result.exitCode !== 0 || result.stdout.byteLength === 0) {
    throw new Error(`zstd fixture failed to build a ${maxBytes}-byte dictionary`);
  }
  return new Uint8Array(result.stdout);
}
