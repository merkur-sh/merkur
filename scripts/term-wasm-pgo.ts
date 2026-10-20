// The training run of the profile-guided terminal (`//tools/bazel/wasm/term-wasm:profile`).
//
// Bazel builds the terminal instrumented, with its in-crate training entry points and minicov's
// profile runtime, and runs this over it:
//
//   term-wasm-pgo.ts <instrumented module> <display-fixture> <font> <raw profile out>
//
// It replays the ingress benchmark's frames, raw and MZ-coded, through the production staging and
// apply paths and writes the raw profile the module captures; Bazel merges it for
// `-Cprofile-use`.

import { writeFileSync } from 'node:fs';
import { writeU32BE } from '../packages/shared/src/binary';
import {
  DISPLAY_COMPRESSED_LENGTH_OFFSET,
  DISPLAY_COMPRESSED_PAYLOAD_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_HEADER_FLAG_COMPRESSED_MZ,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
} from '../packages/shared/src/display-stream';
import { ingressFixture } from './term-wasm-ingress-fixture';

const COLS = 120;
const TRAINING_ROUNDS = 30;

const [driver, displayFixture, font, output] = process.argv.slice(2);
if (
  driver === undefined ||
  displayFixture === undefined ||
  font === undefined ||
  output === undefined
)
  throw new Error('usage: term-wasm-pgo.ts <module> <display-fixture> <font> <raw profile>');
const { stream, frames } = trainingFixtures(displayFixture);
writeFileSync(output, await train(driver, font, stream, frames));

async function train(
  driver: string,
  fontPath: string,
  stream: Uint8Array,
  frames: number,
): Promise<Uint8Array> {
  const module = new WebAssembly.Module(await Bun.file(driver).bytes());
  // term-wasm's wasm-bindgen imports are never called on the paths trained here.
  const imports: Record<string, Record<string, () => never>> = {};
  for (const { module: owner, name } of WebAssembly.Module.imports(module)) {
    imports[owner] ??= {};
    const table = imports[owner];
    if (table !== undefined) {
      table[name] = () => {
        throw new Error(`training reached the unexpected import ${owner}.${name}`);
      };
    }
  }
  const instance = new WebAssembly.Instance(module, imports);
  const exports = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    merkur_pgo_alloc(len: number): number;
    merkur_pgo_train(
      font: number,
      fontLen: number,
      frames: number,
      framesLen: number,
      rounds: number,
    ): number;
    merkur_pgo_capture_profile(): number;
    merkur_pgo_profile_ptr(): number;
  };
  const place = (bytes: Uint8Array): number => {
    const pointer = exports.merkur_pgo_alloc(bytes.byteLength);
    new Uint8Array(exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
    return pointer;
  };
  const font = await Bun.file(fontPath).bytes();
  const fontPointer = place(font);
  const streamPointer = place(stream);
  const applied = exports.merkur_pgo_train(
    fontPointer,
    font.byteLength,
    streamPointer,
    stream.byteLength,
    TRAINING_ROUNDS,
  );
  if (applied !== frames * TRAINING_ROUNDS) {
    throw new Error(
      `term-wasm PGO training applied ${applied} of ${frames * TRAINING_ROUNDS} frames`,
    );
  }
  const length = exports.merkur_pgo_capture_profile();
  return new Uint8Array(exports.memory.buffer, exports.merkur_pgo_profile_ptr(), length).slice();
}

/**
 * The ingress benchmark's frames (plain and styled rows, 1 to 256 dirty rows, eight
 * content phases), each followed by its `display-fixture`-coded MZ twin, behind one
 * snapshot per grid height.
 */
function trainingFixtures(displayFixture: string): { stream: Uint8Array; frames: number } {
  const parts: Uint8Array[] = [];
  const push = (frame: Uint8Array, rows: number, snapshot: boolean) => {
    const record = new Uint8Array(9);
    const view = new DataView(record.buffer);
    view.setUint32(0, frame.byteLength, true);
    view.setUint16(4, COLS, true);
    view.setUint16(6, rows, true);
    record[8] = snapshot ? 1 : 0;
    parts.push(record, frame);
  };
  for (const rows of [36, 256]) {
    const snapshot = ingressFixture(COLS, rows, Math.min(rows, 36), 0, false);
    snapshot[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
    push(snapshot, rows, true);
    for (const styled of [false, true]) {
      for (const dirty of rows === 36 ? [1, 8, 36] : [64, 256]) {
        for (let phase = 0; phase < 8; phase++) {
          const frame = ingressFixture(COLS, rows, dirty, phase, styled, 0, phase);
          writeU32BE(frame, DISPLAY_SEQUENCE_OFFSET, 1);
          push(frame, rows, false);
          push(compressed(displayFixture, frame), rows, false);
        }
      }
    }
  }
  const stream = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    stream.set(part, offset);
    offset += part.byteLength;
  }
  return { stream, frames: parts.length / 2 };
}

/** The same frame with its row region MZ-coded, as the daemon sends it. */
function compressed(displayFixture: string, frame: Uint8Array): Uint8Array {
  const rows = frame.subarray(DISPLAY_ROWS_OFFSET);
  const result = Bun.spawnSync([displayFixture], {
    stdin: rows,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) throw new Error('display-fixture failed');
  const payload = new Uint8Array(result.stdout);
  const wire = new Uint8Array(DISPLAY_COMPRESSED_PAYLOAD_OFFSET + payload.byteLength);
  wire.set(frame.subarray(0, DISPLAY_ROWS_OFFSET));
  wire[1] = (wire[1] ?? 0) | DISPLAY_HEADER_FLAG_COMPRESSED_MZ;
  writeU32BE(
    wire,
    DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
    wire.byteLength - DISPLAY_STREAM_HEADER_BYTES,
  );
  writeU32BE(wire, DISPLAY_COMPRESSED_LENGTH_OFFSET, rows.byteLength);
  wire.set(payload, DISPLAY_COMPRESSED_PAYLOAD_OFFSET);
  return wire;
}
