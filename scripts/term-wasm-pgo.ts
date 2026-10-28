// The training run of the profile-guided terminal (`//tools/bazel/wasm/term-wasm:profile`).
//
// Bazel builds the terminal instrumented, with its in-crate training entry points and minicov's
// profile runtime, and the frame stream `term-wasm-pgo-stream.ts` writes, and runs this over
// them:
//
//   term-wasm-pgo.ts <instrumented module> <font> <stream> <raw profile out>
//
// It replays the stream's frames, raw and MZ-coded, through the production staging and apply
// paths and writes the raw profile the module captures; Bazel merges it for `-Cprofile-use`.

import { writeFileSync } from 'node:fs';

const TRAINING_ROUNDS = 30;
/** A stream record's header: frame length (u32), columns, rows (u16 each), snapshot (u8). */
const RECORD_HEADER_BYTES = 9;

const [driver, font, streamPath, output] = process.argv.slice(2);
if (driver === undefined || font === undefined || streamPath === undefined || output === undefined)
  throw new Error('usage: term-wasm-pgo.ts <module> <font> <stream> <raw profile>');
const stream = await Bun.file(streamPath).bytes();
writeFileSync(output, await train(driver, font, stream, recordCount(stream)));

/** The frames in a training stream, each behind its record header. */
function recordCount(stream: Uint8Array): number {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let records = 0;
  for (let offset = 0; offset < stream.byteLength; records++) {
    offset += RECORD_HEADER_BYTES + view.getUint32(offset, true);
  }
  return records;
}

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
