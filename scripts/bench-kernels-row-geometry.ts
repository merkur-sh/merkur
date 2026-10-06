// Production full-screen row geometry inside terminal WASM.
//
// `build_row_geometry_into` asks `builtin_cell_glyph` and then
// `GlyphAtlas::get_or_rasterize` for every printable cell of every dirty row.
// The atlas profile in `packages/term-wasm/src/atlas_profile.rs` times those
// kernels natively; this script times the shipped artifact's `build_geometry`
// under Bun/JSC over two deterministic 200x50 screens (source-code text and a
// mixed screen with box drawing, Powerline and block elements across all four
// styles), after first paint, so every lookup is an atlas hit. Each sample
// applies one full-screen delta outside the timed region and times only
// `build_geometry`.
//
// `BENCH_CANDIDATE_PKG=<dir>` names a second term-wasm pkg directory (for
// example a prototype built with `scripts/build-term-wasm.ts` and copied out).
// Both builds then run in this one process in ABBA order, the candidate must
// produce byte-identical geometry and atlas pixels, and the paired ratio is
// printed: on a shared machine separate-process baselines drift more than the
// effects this measures.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  GEOMETRY_STATE_BG_OFFSET,
  GEOMETRY_STATE_DECO_OFFSET,
  GEOMETRY_STATE_GLYPH_OFFSET,
} from '../apps/web/src/terminal/geometry-render-state';
import {
  DISPLAY_CHUNK_COUNT_OFFSET,
  DISPLAY_COLUMNS_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_GRID_ROWS_OFFSET,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_ROW_COUNT_OFFSET,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  DISPLAY_VERSION_OFFSET,
  MESSAGE_TYPE_DISPLAY_PATCH,
  writeU32BE,
} from '../packages/shared/src';
import { emitPerfMetric, summarizeSamples } from './perf/harness';

const ROOT = path.resolve(import.meta.dir, '..');
const COLS = 200;
const ROWS = 50;
const GLYPH_FLOATS = 14;
const RECT_FLOATS = 7;
const TAG_BOLD = 1 << 3;
const TAG_ITALIC = 1 << 4;
const CURSOR_VISIBLE_BLOCK = 0x10;
// The envelope's body-length field runs from its offset up to the sequence number, so
// its width follows the shared layout constants rather than a width fixed here.
const BODY_LENGTH_BYTES = DISPLAY_SEQUENCE_OFFSET - DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET;
const samples = readCount('BENCH_SAMPLES', process.env.BENCH_SAMPLES, 201, 20);
const candidateDirectory = process.env.BENCH_CANDIDATE_PKG;

type Content = 'text' | 'mixed';
const CONTENTS: readonly Content[] = ['text', 'mixed'];

interface GeometryTerminal {
  set_style_font_bytes(bold: Uint8Array, italic: Uint8Array, boldItalic: Uint8Array): void;
  resize(cols: number, rows: number): void;
  apply_state_seq(data: Uint8Array, seq: number): boolean;
  apply_delta_seq(data: Uint8Array, seq: number): boolean;
  commit_presentation_state(): number;
  build_geometry(): void;
  finish_missing_pass(): void;
  take_last_error(): string | undefined;
  geometry_state_ptr(): number;
  geometry_state_len(): number;
  atlas_pixels_ptr(): number;
  atlas_width(): number;
  atlas_height(): number;
}

interface TermWasmModule {
  initSync(options: { module: Uint8Array }): { memory: WebAssembly.Memory };
  init_regular(
    viewportWidth: number,
    viewportHeight: number,
    normal: Uint8Array,
    pxPerEm: number,
    lineHeight: number,
    dpr: number,
  ): GeometryTerminal;
}

interface Arm {
  readonly label: string;
  readonly terminal: GeometryTerminal;
  readonly memory: WebAssembly.Memory;
  readonly frames: readonly [Uint8Array, Uint8Array];
  sequence: number;
  phase: 0 | 1;
}

const fontBytes = async (face: string) =>
  new Uint8Array(
    await readFile(
      path.join(ROOT, 'apps', 'web', 'public', 'fonts', `JetBrainsMonoNF-${face}.ttf`),
    ),
  );
const [regular, bold, italic, boldItalic] = await Promise.all(
  ['Regular', 'Bold', 'Italic', 'BoldItalic'].map(fontBytes),
);
if (
  regular === undefined ||
  bold === undefined ||
  italic === undefined ||
  boldItalic === undefined
) {
  throw new Error('missing bundled terminal face');
}
const shippedDirectory = path.join(ROOT, 'apps', 'web', 'src', 'term-wasm', 'pkg');
const modules = [await loadModule(shippedDirectory, 'shipped')];
if (candidateDirectory !== undefined && candidateDirectory.length > 0) {
  modules.push(await loadModule(path.resolve(candidateDirectory), 'candidate'));
}

process.stdout.write(
  `terminal WASM build_geometry: ${COLS}x${ROWS} full-screen rebuilds, samples=${samples}` +
    `${modules.length > 1 ? ` candidate=${candidateDirectory}` : ''}\n`,
);
for (const content of CONTENTS) {
  const frames = [screenFrame(content, 0), screenFrame(content, 1)] as const;
  const arms = modules.map(({ label, module, memory }) => openArm(label, module, memory, frames));
  const fingerprints = new Set<string>();
  for (const arm of arms) {
    // Two rebuilds, so both phases have been laid out once before checking.
    rebuild(arm);
    rebuild(arm);
    fingerprints.add(geometryFingerprint(arm));
  }
  if (fingerprints.size !== 1) {
    throw new Error(`${content}: candidate geometry or atlas pixels differ from the shipped build`);
  }
  const [shipped, candidate] = arms;
  if (shipped === undefined) throw new Error('missing shipped terminal');
  for (let warmup = 0; warmup < 20; warmup += 1) {
    rebuild(shipped);
    if (candidate !== undefined) rebuild(candidate);
  }
  const shippedSamples: number[] = [];
  const candidateSamples: number[] = [];
  const ratios: number[] = [];
  for (let round = 0; round < samples; round += 1) {
    if (candidate === undefined) {
      shippedSamples.push(rebuild(shipped));
      continue;
    }
    const shippedFirst = rebuild(shipped);
    const candidateFirst = rebuild(candidate);
    const candidateSecond = rebuild(candidate);
    const shippedSecond = rebuild(shipped);
    shippedSamples.push(shippedFirst, shippedSecond);
    candidateSamples.push(candidateFirst, candidateSecond);
    ratios.push((candidateFirst + candidateSecond) / (shippedFirst + shippedSecond));
  }
  const summary = summarizeSamples(shippedSamples);
  process.stdout.write(
    `${content}: glyphs=${geometryBuffer(shipped, GEOMETRY_STATE_GLYPH_OFFSET).count} ` +
      `decorations=${geometryBuffer(shipped, GEOMETRY_STATE_DECO_OFFSET).count} ` +
      `p50=${summary.median.toFixed(1)}us p95=${summary.p95.toFixed(1)}us\n`,
  );
  if (candidate !== undefined) {
    const candidateSummary = summarizeSamples(candidateSamples);
    const ratio = summarizeSamples(ratios);
    process.stdout.write(
      `${content}: candidate p50=${candidateSummary.median.toFixed(1)}us ` +
        `p95=${candidateSummary.p95.toFixed(1)}us paired candidate/shipped ` +
        `p50=${ratio.median.toFixed(3)} p95=${ratio.p95.toFixed(3)} (identical geometry)\n`,
    );
  }
  for (const [suffix, value, percentile] of [
    ['p50', summary.median, 0.5],
    ['p95', summary.p95, 0.95],
  ] as const) {
    emitPerfMetric({
      name: `terminal-wasm-row-geometry-${content}-${suffix}`,
      value,
      unit: 'us/screen',
      direction: 'lower',
      percentile,
      sampleSize: shippedSamples.length,
    });
  }
}

async function loadModule(directory: string, label: string) {
  // A query string gives each build its own module instance and memory.
  const module = (await import(
    `${path.join(directory, 'term_wasm.js')}?build=${label}`
  )) as TermWasmModule;
  const { memory } = module.initSync({
    module: new Uint8Array(await readFile(path.join(directory, 'term_wasm_bg.wasm'))),
  });
  return { label, module, memory };
}

function openArm(
  label: string,
  module: TermWasmModule,
  memory: WebAssembly.Memory,
  frames: readonly [Uint8Array, Uint8Array],
): Arm {
  if (
    regular === undefined ||
    bold === undefined ||
    italic === undefined ||
    boldItalic === undefined
  ) {
    throw new Error('missing bundled terminal face');
  }
  // 14 px text at DPR 2, the retina cell the native atlas profile uses.
  const terminal = module.init_regular(COLS * 17, ROWS * 34, regular, 14, 1.2, 2);
  terminal.set_style_font_bytes(bold, italic, boldItalic);
  terminal.resize(COLS, ROWS);
  const snapshot = frames[0].slice();
  snapshot[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
  writeU32BE(snapshot, DISPLAY_SEQUENCE_OFFSET, 1);
  if (!terminal.apply_state_seq(snapshot, 1)) {
    throw new Error(`${label}: ${terminal.take_last_error()}`);
  }
  terminal.commit_presentation_state();
  terminal.build_geometry();
  // Close the Canvas 2D pass as declined, so later rebuilds are all hits,
  // as after first paint.
  terminal.finish_missing_pass();
  return { label, terminal, memory, frames, sequence: 2, phase: 1 };
}

/** Apply the other phase's full-screen delta, then time only the rebuild. */
function rebuild(arm: Arm): number {
  const frame = arm.frames[arm.phase];
  writeU32BE(frame, DISPLAY_SEQUENCE_OFFSET, arm.sequence);
  if (!arm.terminal.apply_delta_seq(frame, arm.sequence)) {
    throw new Error(`${arm.label}: ${arm.terminal.take_last_error()}`);
  }
  arm.sequence += 1;
  arm.phase = arm.phase === 0 ? 1 : 0;
  arm.terminal.commit_presentation_state();
  const start = Bun.nanoseconds();
  arm.terminal.build_geometry();
  return (Bun.nanoseconds() - start) / 1_000;
}

/** One buffer's pointer and instance count, read the way the renderer reads them. */
function geometryBuffer(
  arm: Arm,
  base: number,
): { readonly pointer: number; readonly count: number } {
  const state = new Uint32Array(
    arm.memory.buffer,
    arm.terminal.geometry_state_ptr() >>> 0,
    arm.terminal.geometry_state_len(),
  );
  return { pointer: state[base] ?? 0, count: state[base + 1] ?? 0 };
}

function geometryFingerprint(arm: Arm): string {
  const { terminal, memory } = arm;
  const view = (pointer: number, length: number) =>
    new Uint8Array(memory.buffer, pointer >>> 0, length);
  const hash = new Bun.CryptoHasher('sha256');
  const glyphs = geometryBuffer(arm, GEOMETRY_STATE_GLYPH_OFFSET);
  const decorations = geometryBuffer(arm, GEOMETRY_STATE_DECO_OFFSET);
  const backgrounds = geometryBuffer(arm, GEOMETRY_STATE_BG_OFFSET);
  hash.update(view(glyphs.pointer, glyphs.count * GLYPH_FLOATS * 4));
  hash.update(view(decorations.pointer, decorations.count * RECT_FLOATS * 4));
  hash.update(view(backgrounds.pointer, backgrounds.count * RECT_FLOATS * 4));
  hash.update(view(terminal.atlas_pixels_ptr(), terminal.atlas_width() * terminal.atlas_height()));
  return hash.digest('hex');
}

/** Deterministic cells of one row as `[tag, codepoint]`, default colours. */
function rowCells(content: Content, row: number, phase: number): Array<readonly [number, number]> {
  const next = generator(row * 7919 + phase * 104729 + (content === 'text' ? 1 : 2));
  const cells: Array<readonly [number, number]> = [];
  if (content === 'text') {
    // Indented identifiers and punctuation, trailing spaces, italic comments.
    const tag = next(6) === 0 ? TAG_ITALIC : 0;
    const indent = 4 * next(4);
    const width = indent + 20 + next(70);
    const punctuation = '(){}[].,;:=&<>!?-+*/#\'"';
    for (let col = 0; col < indent; col += 1) cells.push([tag, 0x20]);
    while (cells.length < width) {
      const letters = 2 + next(8);
      for (let index = 0; index < letters; index += 1) cells.push([tag, 0x61 + next(26)]);
      if (next(3) === 0) cells.push([tag, punctuation.charCodeAt(next(punctuation.length))]);
      cells.push([tag, 0x20]);
    }
    while (cells.length < COLS) cells.push([tag, 0x20]);
    cells.length = COLS;
    return cells;
  }
  for (let col = 0; col < COLS; col += 1) {
    const kind = next(100);
    const codepoint =
      kind < 38
        ? 0x20
        : kind < 92
          ? 0x21 + next(94)
          : kind < 96
            ? 0x2500 + next(0x80)
            : kind < 98
              ? ([0xe0b0, 0xe0b2, 0xe0a0][next(3)] ?? 0xe0b0)
              : 0x2580 + next(0x20);
    const style = next(100);
    const tag =
      style < 75 ? 0 : style < 90 ? TAG_BOLD : style < 97 ? TAG_ITALIC : TAG_BOLD | TAG_ITALIC;
    cells.push([tag, codepoint]);
  }
  return cells;
}

function screenFrame(content: Content, phase: number): Uint8Array {
  const bodies: number[][] = [];
  for (let row = 0; row < ROWS; row += 1) {
    // Row color mode byte, then per cell: tag and codepoint varint.
    const body = [0];
    for (const [tag, codepoint] of rowCells(content, row, phase)) {
      body.push(tag);
      let value = codepoint;
      while (value >= 0x80) {
        body.push((value & 0x7f) | 0x80);
        value >>>= 7;
      }
      body.push(value);
    }
    bodies.push(body);
  }
  const length = bodies.reduce((total, body) => total + 8 + body.length, DISPLAY_ROWS_OFFSET);
  const bodyLength = length - DISPLAY_STREAM_HEADER_BYTES;
  if (bodyLength >= 2 ** (8 * BODY_LENGTH_BYTES)) {
    throw new Error('screen exceeds one wire record');
  }
  const frame = new Uint8Array(length);
  const view = new DataView(frame.buffer);
  frame[0] = MESSAGE_TYPE_DISPLAY_PATCH;
  for (let index = 0; index < BODY_LENGTH_BYTES; index += 1) {
    const shift = 8 * (BODY_LENGTH_BYTES - 1 - index);
    frame[DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET + index] =
      Math.floor(bodyLength / 2 ** shift) & 0xff;
  }
  writeU32BE(frame, DISPLAY_GENERATION_OFFSET, 1);
  frame[DISPLAY_VERSION_OFFSET] = DISPLAY_PROTOCOL_VERSION;
  view.setUint16(DISPLAY_COLUMNS_OFFSET, COLS);
  view.setUint16(DISPLAY_GRID_ROWS_OFFSET, ROWS);
  frame[DISPLAY_STREAM_HEADER_BYTES + 10] = CURSOR_VISIBLE_BLOCK;
  view.setUint16(DISPLAY_CHUNK_COUNT_OFFSET, 1);
  view.setUint16(DISPLAY_ROW_COUNT_OFFSET, ROWS);
  let offset = DISPLAY_ROWS_OFFSET;
  bodies.forEach((body, row) => {
    view.setUint16(offset, row);
    view.setUint16(offset + 2, 0);
    view.setUint16(offset + 4, COLS);
    view.setUint16(offset + 6, body.length);
    frame.set(body, offset + 8);
    offset += 8 + body.length;
  });
  return frame;
}

function generator(seed: number): (bound: number) => number {
  let state = seed >>> 0;
  return (bound) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 8) % bound;
  };
}

function readCount(name: string, raw: string | undefined, fallback: number, minimum: number) {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer of at least ${minimum}`);
  }
  return value;
}
