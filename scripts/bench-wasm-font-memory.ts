import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as wasm from '../apps/web/src/term-wasm/pkg/term_wasm';
import { DEFAULT_TERMINAL_FONT } from '../apps/web/src/terminal/fonts';
import { ingressFixture } from './term-wasm-ingress-fixture';

const root = path.resolve(import.meta.dir, '..');
const workload = process.env.FONT_MEMORY_WORKLOAD ?? 'startup';
const workloads = [
  'startup',
  'calibration-first',
  'full-init',
  'family',
  'invalid-style',
  'grown',
  'dpr',
  'recovery',
  'steady',
  'boot-only',
  'regular-only',
  'calibration-only',
  'full-atlas',
];
if (!workloads.includes(workload)) throw new Error(`Unknown font workload: ${workload}`);

const runtime = wasm.initSync({
  module: await readFile(path.join(root, 'apps/web/src/term-wasm/pkg/term_wasm_bg.wasm')),
});
const [boot, regular, bold, italic, boldItalic] = await Promise.all(
  [
    DEFAULT_TERMINAL_FONT.boot,
    DEFAULT_TERMINAL_FONT.regular,
    DEFAULT_TERMINAL_FONT.bold,
    DEFAULT_TERMINAL_FONT.italic,
    DEFAULT_TERMINAL_FONT.boldItalic,
  ].map(async (url) => {
    const asset = new URL(url, 'https://merkur.local');
    return new Uint8Array(await readFile(path.join(root, 'apps/web/public', asset.pathname)));
  }),
);
if (!boot || !regular || !bold || !italic || !boldItalic) throw new Error('Missing font face');
const terminal =
  workload === 'calibration-only'
    ? wasm.init_display_receiver_calibration(120, 40)
    : wasm.init_regular(
        960,
        720,
        workload === 'full-init' || workload === 'regular-only' ? regular : boot,
        14,
        1,
        1,
      );
const frame = ingressFixture(120, 40, 40, 0, true);
if (!terminal.apply_state_seq(frame, 1)) throw new Error('Snapshot refused');
terminal.commit_presentation_state();
terminal.build_geometry();
report('first-frame');
if (workload.endsWith('-only')) {
  terminal.free();
  process.stdout.write(
    `${JSON.stringify({ workload, phase: 'freed', linearBytes: runtime.memory.buffer.byteLength })}\n`,
  );
  process.exit(0);
}
if (workload === 'calibration-first') calibrate();

if (workload !== 'full-init') {
  terminal.set_regular_font_bytes(regular);
  terminal.set_cell_metrics(14, 1, 1);
  terminal.build_geometry();
  report('regular');
}
terminal.set_style_font_bytes(bold, italic, boldItalic);
terminal.set_cell_metrics(14, 1, 1);
terminal.build_geometry();
report('styled');
if (workload !== 'calibration-first') calibrate();

if (workload === 'grown') {
  const pixels = new Uint8Array(1024 * 1024).fill(127);
  for (let index = 0; index < 5; index += 1) {
    if (!terminal.inject_glyph(0x100000 + index, 0, 1024, 1024, 0, 0, pixels)) {
      throw new Error('External glyph refused');
    }
  }
  if (terminal.atlas_width() !== 4096) throw new Error('Atlas did not grow');
  report('grown');
}
if (workload === 'full-atlas') {
  terminal.set_font_bytes(regular, bold, italic, boldItalic);
  const pixels = new Uint8Array(2048 * 2048).fill(127);
  if (!terminal.inject_glyph(0x100000, 0, 2048, 2048, 0, 0, pixels)) {
    throw new Error('Full-atlas glyph refused');
  }
  if (terminal.atlas_width() !== 2048) throw new Error('Full initial atlas grew');
  report('full-atlas');
}
if (workload === 'family' || workload === 'grown' || workload === 'full-atlas') {
  terminal.set_font_bytes(bold, regular, boldItalic, italic);
  terminal.set_cell_metrics(14, 1, 1);
  terminal.build_geometry();
  report('family-changed');
  terminal.set_font_bytes(regular, bold, italic, boldItalic);
  terminal.set_cell_metrics(14, 1, 1);
  terminal.build_geometry();
  report('family-revisited');
}
if (workload === 'invalid-style') {
  terminal.set_style_font_bytes(new Uint8Array(), new Uint8Array([1]), new Uint8Array());
  terminal.set_cell_metrics(14, 1, 1);
  terminal.build_geometry();
  report('invalid-style');
}
if (workload === 'dpr') {
  for (const dpr of [1.25, 2, 3, 1]) {
    terminal.set_cell_metrics(14 * dpr, 1, dpr);
    terminal.build_geometry();
    report(`dpr-${dpr}`);
  }
}
if (workload === 'recovery' || workload === 'steady') {
  for (let index = 0; index < 100; index += 1) {
    terminal.build_geometry();
    terminal.atlas_mark_clean();
  }
  report(workload);
}
terminal.free();
process.stdout.write(
  `${JSON.stringify({ workload, phase: 'freed', linearBytes: runtime.memory.buffer.byteLength })}\n`,
);

function calibrate(): void {
  const calibration = wasm.init_display_receiver_calibration(120, 40);
  if (!calibration.apply_state_seq(frame, 1)) throw new Error('Calibration snapshot refused');
  calibration.free();
  report('calibrated');
}

function report(phase: string): void {
  const memory = runtime.memory.buffer;
  const state = new Uint32Array(
    memory,
    terminal.geometry_state_ptr(),
    terminal.geometry_state_len(),
  );
  const cells = state[0];
  const cellCount = state[1];
  const glyphs = state[15];
  const glyphCount = state[16];
  if (
    cells === undefined ||
    cellCount === undefined ||
    glyphs === undefined ||
    glyphCount === undefined
  ) {
    throw new Error('Incomplete geometry state');
  }
  const hash = (pointer: number, length: number): string =>
    Bun.CryptoHasher.hash('sha256', new Uint8Array(memory, pointer, length), 'hex');
  process.stdout.write(
    `${JSON.stringify({
      workload,
      phase,
      linearBytes: memory.byteLength,
      atlasBytes: terminal.atlas_width() * terminal.atlas_height(),
      pixels: hash(terminal.atlas_pixels_ptr(), terminal.atlas_width() * terminal.atlas_height()),
      cells: hash(cells, cellCount * 12),
      glyphs: hash(glyphs, glyphCount * 12),
      glyphCount,
    })}\n`,
  );
}
