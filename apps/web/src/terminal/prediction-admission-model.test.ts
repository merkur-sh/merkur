import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  DISPLAY_COLOR_MODE_INDEXED,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_PATCH_BODY_HEADER_BYTES,
  DISPLAY_PATCH_FLAG_RESET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_ROW_PREFIX_BYTES,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  MESSAGE_TYPE_DISPLAY_PATCH,
  TERMINAL_MODE_PREDICTION_SAFE,
  writeU32BE,
} from '@merkur/shared';
import { installE2eWasm } from '@merkur/shared/e2e-wasm-runtime';
import * as clientWasm from '../../../../packages/e2e-wasm/pkg/e2e_wasm.js';
import {
  init_regular as initTerminal,
  initSync as initTerminalWasm,
  type Terminal,
} from '../term-wasm/pkg/term_wasm.js';
import type { LocalPredictionOp, PredictionModelSnapshot } from './prediction-admission-model';
import { type CaptureOp, PredictionCapture } from './prediction-capture';
import {
  createPredictionFastPathBuffer,
  createPredictionFastPathConsumer,
  createPredictionFastPathWriter,
  createPredictionFastStateReader,
} from './prediction-fast-path';

const clientMemory = clientWasm.initSync({
  module: readFileSync(
    new URL('../../../../packages/e2e-wasm/pkg/e2e_wasm_bg.wasm', import.meta.url),
  ),
}).memory;
installE2eWasm(clientWasm);
const captures: PredictionCapture[] = [];
afterEach(() => {
  for (const capture of captures) capture.close();
  captures.length = 0;
});

function createCapture(snapshot: PredictionModelSnapshot): {
  prepare(op: LocalPredictionOp, inputSeq: number): boolean;
  publish(snapshot: PredictionModelSnapshot): void;
  capture: PredictionCapture;
} {
  const sab = createPredictionFastPathBuffer();
  const writer = createPredictionFastPathWriter(sab);
  const consumer = createPredictionFastPathConsumer(sab);
  writer.beginEpoch();
  consumer.adoptRequiredEpoch();
  const capture = new PredictionCapture(clientMemory, createPredictionFastStateReader(sab));
  captures.push(capture);
  const publish = (next: PredictionModelSnapshot): void => {
    consumer.publishModel(
      next.armed,
      next.flags,
      next.startCol,
      next.cursorCol,
      next.endCol,
      next.opsRemaining,
      next.cols,
      next.throughInputSeq,
    );
  };
  publish(snapshot);
  const operations: Record<LocalPredictionOp, CaptureOp> = {
    printable: 0,
    backspace: 1,
    delete: 2,
    cursor_left: 3,
    cursor_right: 4,
  };
  return { prepare: (op, seq) => capture.prepare(operations[op], seq), publish, capture };
}

const COLS = 16;
const ROWS = 4;
/** `DISPLAY_MODE_PREDICTION_SAFE`: the daemon's authenticated prompt grant. */
const MODE_PREDICTION_SAFE = TERMINAL_MODE_PREDICTION_SAFE;

function writeU16BE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = (value >>> 8) & 0xff;
  buffer[offset + 1] = value & 0xff;
}

function encodeDefaultCells(text: string): Uint8Array {
  const encoded: number[] = [DISPLAY_COLOR_MODE_INDEXED];
  for (const cell of text) {
    encoded.push(0);
    let codepoint = cell.codePointAt(0) ?? 0;
    while (codepoint >= 0x80) {
      encoded.push((codepoint & 0x7f) | 0x80);
      codepoint >>>= 7;
    }
    encoded.push(codepoint);
  }
  return Uint8Array.from(encoded);
}

interface FrameSpec {
  readonly seq: number;
  readonly rows: readonly { readonly row: number; readonly text: string }[];
  readonly cursorCol: number;
  readonly cursorRow: number;
  readonly modeFlags: number;
}

function buildSnapshot(spec: FrameSpec): Uint8Array {
  const encoded = spec.rows.map((row) => encodeDefaultCells(row.text));
  const rowBytes = encoded.reduce(
    (total, cells) => total + DISPLAY_ROW_PREFIX_BYTES + cells.byteLength,
    0,
  );
  const bodyBytes = DISPLAY_PATCH_BODY_HEADER_BYTES + rowBytes;
  const frame = new Uint8Array(DISPLAY_STREAM_HEADER_BYTES + bodyBytes);
  frame[0] = MESSAGE_TYPE_DISPLAY_PATCH;
  writeU32BE(frame, DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET, bodyBytes);
  writeU32BE(frame, DISPLAY_SEQUENCE_OFFSET, spec.seq);
  writeU32BE(frame, DISPLAY_GENERATION_OFFSET, 1);
  const b = DISPLAY_STREAM_HEADER_BYTES;
  frame[b] = DISPLAY_PROTOCOL_VERSION;
  frame[b + 1] = DISPLAY_PATCH_FLAG_RESET;
  writeU16BE(frame, b + 2, COLS);
  writeU16BE(frame, b + 4, ROWS);
  writeU16BE(frame, b + 6, spec.cursorCol);
  writeU16BE(frame, b + 8, spec.cursorRow);
  // Low nibble is the shape and 0 is HIDDEN, which withholds prediction; high
  // bit is visibility. 0x11 is a visible block cursor.
  frame[b + 10] = 0x11;
  writeU16BE(frame, b + 11, spec.modeFlags);
  writeU16BE(frame, b + 23, 1); // chunk_count
  writeU16BE(frame, b + 25, spec.rows.length); // row_count

  let offset = DISPLAY_ROWS_OFFSET;
  for (const [index, row] of spec.rows.entries()) {
    const cells = encoded[index] ?? new Uint8Array(0);
    writeU16BE(frame, offset, row.row);
    writeU16BE(frame, offset + 2, 0);
    writeU16BE(frame, offset + 4, row.text.length);
    writeU16BE(frame, offset + 6, cells.byteLength);
    frame.set(cells, offset + DISPLAY_ROW_PREFIX_BYTES);
    offset += DISPLAY_ROW_PREFIX_BYTES + cells.byteLength;
  }
  return frame;
}

let wasmReady: Promise<void> | null = null;
let fontBytes: Uint8Array | null = null;
let wasmMemory: WebAssembly.Memory | null = null;

async function createTerminal(): Promise<Terminal> {
  wasmReady ??= (async () => {
    const wasmBytes = await readFile(
      new URL('../term-wasm/pkg/term_wasm_bg.wasm', import.meta.url),
    );
    const wasmBuffer = wasmBytes.buffer.slice(
      wasmBytes.byteOffset,
      wasmBytes.byteOffset + wasmBytes.byteLength,
    ) as ArrayBuffer;
    wasmMemory = initTerminalWasm({ module: new WebAssembly.Module(wasmBuffer) }).memory;
    fontBytes = await readFile(
      new URL('../../public/fonts/JetBrainsMonoNF-Regular.ttf', import.meta.url),
    );
  })();
  await wasmReady;
  const font = fontBytes;
  if (font === null) throw new Error('font was not loaded');
  const terminal = initTerminal(120, 24, font, 14, 1.2, 1);
  terminal.resize(COLS, ROWS);
  return terminal;
}

/**
 * Re-seed `terminal` with a prompt-safe grid whose cursor sits just past
 * `prompt` on row 0.
 *
 * A reset snapshot restores the grid AND clears the speculative model, so this
 * is a complete per-trial reset. It is deliberately separate from terminal
 * construction: `init_regular` parses and rasterizes the font, which is by far
 * the most expensive thing in this file, and building one terminal per trial
 * made the suite slow enough to be sensitive to machine load.
 */
function seedPrompt(terminal: Terminal, prompt: string, seq: number): void {
  expect(
    terminal.apply_state_seq(
      buildSnapshot({
        seq,
        rows: [{ row: 0, text: prompt.padEnd(COLS, ' ') }],
        cursorCol: prompt.length,
        cursorRow: 0,
        modeFlags: MODE_PREDICTION_SAFE,
      }),
      seq,
    ),
  ).toBe(true);
  // Admission starts from a prompt that the worker has made presentation-eligible,
  // not merely a received snapshot still held behind a presentation transaction.
  terminal.commit_presentation_state();
}

/**
 * The one terminal this file uses, freshly seeded.
 *
 * `init_regular` parses and rasterizes the font, and `bun test` runs a whole
 * shard in one process — so building a terminal per test would block that
 * process's event loop several times over, which is enough to starve a
 * concurrently-scheduled timer-based test elsewhere in the shard. A reset
 * snapshot restores both the grid and the speculative model, so one terminal is
 * as isolated as one per test.
 */
let sharedTerminal: Terminal | null = null;
let promptSeq = 0;

async function promptTerminal(prompt: string): Promise<Terminal> {
  sharedTerminal ??= await createTerminal();
  promptSeq += 1;
  seedPrompt(sharedTerminal, prompt, promptSeq);
  return sharedTerminal;
}

function readSnapshot(terminal: Terminal, throughInputSeq: number): PredictionModelSnapshot {
  const memory = wasmMemory;
  if (memory === null) throw new Error('wasm memory was not captured');
  const published = new Uint32Array(
    memory.buffer,
    terminal.prediction_model_ptr() >>> 0,
    terminal.prediction_model_len() >>> 0,
  );
  return {
    armed: true,
    flags: published[0] ?? 0,
    startCol: published[1] ?? 0,
    cursorCol: published[2] ?? 0,
    endCol: published[3] ?? 0,
    opsRemaining: published[4] ?? 0,
    cols: published[5] ?? 0,
    throughInputSeq,
  };
}

/** Run one op through the real model. Returns whether it was accepted. */
function applyToWasm(terminal: Terminal, op: LocalPredictionOp, inputSeq: number): boolean {
  switch (op) {
    case 'printable':
      return terminal.predict_printable('x'.codePointAt(0) ?? 0, 0, inputSeq, true) !== 0;
    case 'backspace':
      return terminal.predict_backspace(0, inputSeq) !== 0;
    case 'delete':
      return terminal.predict_delete(0, inputSeq) !== 0;
    case 'cursor_left':
      return terminal.predict_cursor_shift(-1, 0, inputSeq) !== 0;
    case 'cursor_right':
      return terminal.predict_cursor_shift(1, 0, inputSeq) !== 0;
  }
}

const ALL_OPS: readonly LocalPredictionOp[] = [
  'printable',
  'backspace',
  'delete',
  'cursor_left',
  'cursor_right',
];

describe('main-thread admission mirrors the real WASM model', () => {
  test('a printable burst stays admissible right up to the column bound', async () => {
    const terminal = await promptTerminal('$ ');
    // The worker has drained nothing yet, so the first snapshot is current.
    const model = createCapture(readSnapshot(terminal, 0));

    // Main never refreshes again: this is the burst case, where key N+1 must be
    // decided before the worker has processed key N.
    let inputSeq = 0;
    let admitted = 0;
    for (let index = 0; index < COLS + 4; index += 1) {
      inputSeq += 1;
      const predicted = model.prepare('printable', inputSeq);
      const actual = applyToWasm(terminal, 'printable', inputSeq);
      expect(predicted).toBe(actual);
      if (!predicted) break;
      admitted += 1;
    }
    // `$ ` leaves columns 2..14 usable before the model's `endCol + 1 < cols`
    // bound bites at the last column. Asserted exactly so this test can never
    // pass by admitting nothing.
    expect(admitted).toBe(COLS - 3);
    expect(model.prepare('printable', inputSeq)).toBe(false);
  });

  test('every op sequence agrees with the model, op for op', async () => {
    // A deterministic walk over the op alphabet: fixed so a divergence is
    // reproducible, and long enough to reach both column ends and the empty
    // line in the middle.
    let cursor = 1;
    const nextOp = (): LocalPredictionOp => {
      cursor = (cursor * 1_103_515_245 + 12_345) & 0x7fff_ffff;
      return ALL_OPS[cursor % ALL_OPS.length] ?? 'printable';
    };

    const terminal = await promptTerminal('user@host:~$ ');
    for (let trial = 0; trial < 8; trial += 1) {
      promptSeq += 1;
      seedPrompt(terminal, 'user@host:~$ ', promptSeq);
      const model = createCapture(readSnapshot(terminal, 0));

      let inputSeq = 0;
      for (let step = 0; step < 24; step += 1) {
        const op = nextOp();
        inputSeq += 1;
        const predicted = model.prepare(op, inputSeq);
        const actual = applyToWasm(terminal, op, inputSeq);
        // Main may only ever be at least as strict as the model. Granting the
        // wire bit for an op the model refuses is the failure that matters, so
        // it is asserted separately from the exact-equality expectation.
        expect(predicted && !actual).toBe(false);
        expect(predicted).toBe(actual);
        if (!predicted) {
          // A refusal flushes the shadow line in WASM; re-adopt like main does.
          model.publish(readSnapshot(terminal, inputSeq));
        }
      }
    }
  });

  test('a seed-only snapshot admits a printable and refuses every editing op', async () => {
    const terminal = await promptTerminal('$ ');
    const snapshot = readSnapshot(terminal, 0);
    // No shadow line has been created yet, so the model is seedable, not ready.
    expect(snapshot.flags & 0b1).toBe(0);
    expect(snapshot.flags & 0b10).not.toBe(0);

    for (const op of ALL_OPS) {
      if (op === 'printable') continue;
      const model = createCapture(snapshot);
      expect(model.prepare(op, 1)).toBe(false);
      expect(applyToWasm(terminal, op, 1)).toBe(false);
    }
    const model = createCapture(snapshot);
    expect(model.prepare('printable', 2)).toBe(true);
    expect(applyToWasm(terminal, 'printable', 2)).toBe(true);
  });

  test('a disarmed worker denies the bit whatever the model bounds say', () => {
    const model = createCapture({
      armed: false,
      flags: 0b11,
      startCol: 0,
      cursorCol: 2,
      endCol: 2,
      opsRemaining: 256,
      cols: 80,
      throughInputSeq: 0,
    });
    for (const op of ALL_OPS) expect(model.prepare(op, 1)).toBe(false);
  });

  test('an exhausted op budget denies every op', () => {
    const model = createCapture({
      armed: true,
      flags: 0b11,
      startCol: 0,
      cursorCol: 2,
      endCol: 4,
      opsRemaining: 0,
      cols: 80,
      throughInputSeq: 0,
    });
    for (const op of ALL_OPS) expect(model.prepare(op, 1)).toBe(false);
  });
});

describe('Rust capture boundary ownership', () => {
  const seed: PredictionModelSnapshot = {
    armed: true,
    flags: 2,
    startCol: 0,
    cursorCol: 2,
    endCol: 0,
    opsRemaining: 256,
    cols: 16,
    throughInputSeq: 0,
  };

  test('an owner behind input cannot reseed after a failed publication', () => {
    const model = createCapture(seed);
    expect(model.prepare('printable', 1)).toBe(true);
    model.capture.invalidate();
    expect(model.prepare('printable', 2)).toBe(false);
    model.publish({ ...seed, throughInputSeq: 1 });
    expect(model.prepare('printable', 3)).toBe(false);
    model.publish({ ...seed, throughInputSeq: 3 });
    expect(model.prepare('printable', 4)).toBe(true);
  });

  test('flush fences the exact input frontier, while authentication resets it', () => {
    const model = createCapture(seed);
    model.capture.flush(100);
    model.publish({ ...seed, throughInputSeq: 99 });
    expect(model.prepare('printable', 101)).toBe(false);
    model.publish({ ...seed, throughInputSeq: 101 });
    expect(model.prepare('printable', 102)).toBe(true);
    model.capture.reset();
    model.publish(seed);
    expect(model.prepare('printable', 1)).toBe(true);
  });

  test('authorization memory growth refreshes the copy without losing the projection', () => {
    const model = createCapture(seed);
    expect(model.prepare('printable', 1)).toBe(true);
    clientMemory.grow(1);
    expect(model.prepare('cursor_left', 2)).toBe(true);
    expect(model.prepare('delete', 3)).toBe(true);
    expect(model.prepare('cursor_right', 4)).toBe(false);
  });

  test('late callbacks after close cannot access freed Rust memory', () => {
    const model = createCapture(seed);
    model.capture.close();
    model.capture.close();
    model.capture.flush(100);
    model.capture.reset();
    model.capture.invalidate();
    expect(model.prepare('printable', 1)).toBe(false);
  });
});
