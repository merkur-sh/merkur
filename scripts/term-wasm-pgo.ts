// Profile for the profile-guided term-wasm build.
//
// Trains `packages/term-wasm-pgo` (term-wasm linked as a library, instrumented)
// on the production staging and apply paths and returns a merged `.profdata`
// for `-Cprofile-use`. Measured against the plain build, alternated on an idle
// machine: compressed staging of terminal text -7.7% to -15.0% and of random
// content -3.3% to -7.6% (faster in 10-12 of 12 rounds at every size), and the
// apply path -4% to -9% (6 of 6).
//
// The instrumented build needs `-Zno-profiler-runtime`, because wasm32 has no
// profiler runtime and minicov supplies one. `RUSTC_BOOTSTRAP=1` allows that
// flag on the pinned stable compiler for this throwaway build only, so the
// function hashes match the shipped stable build. Value profiling is off:
// minicov's bare-metal runtime cannot allocate its value-profile nodes.
//
// Cargo runs from `packages/term-wasm`, so the driver sees exactly the cargo
// config the shipped crate builds with (its `+simd128` among it); the flags join
// that config through `--config`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DISPLAY_COMPRESSED_LENGTH_OFFSET,
  DISPLAY_COMPRESSED_PAYLOAD_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  writeU32BE,
} from '../packages/shared/src';
import { ingressFixture } from './term-wasm-ingress-fixture';
import { REPO_ROOT, resolvePinnedRustToolchain, runOrThrow } from './wasm-toolchain';

const PGO_DIRECTORY = path.join(REPO_ROOT, 'target/rust/term-wasm-pgo');
const FONT = path.join(REPO_ROOT, 'apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf');
const ZSTD_FIXTURE = path.join(REPO_ROOT, 'target/rust/release/zstd-fixture');
const COLS = 120;
const TRAINING_ROUNDS = 30;

/** Builds, trains and merges; returns the `.profdata` path for `-Cprofile-use`. */
export async function trainTermWasmProfile(): Promise<string> {
  const toolchain = await resolvePinnedRustToolchain();
  const rawProfiles = path.join(PGO_DIRECTORY, 'profiles');
  await fs.rm(rawProfiles, { recursive: true, force: true });
  await fs.mkdir(rawProfiles, { recursive: true });

  await runOrThrow(
    ['cargo', 'build', '--release', '--locked', '-p', 'zstd-fixture'],
    REPO_ROOT,
    toolchain,
  );
  const { stream, frames } = trainingFixtures();

  const generateDirectory = path.join(PGO_DIRECTORY, 'generate');
  await runOrThrow(
    [
      'cargo',
      'build',
      '--release',
      '--locked',
      '-p',
      'term-wasm-pgo',
      '--target',
      'wasm32-unknown-unknown',
      '--target-dir',
      generateDirectory,
      '--config',
      `target.wasm32-unknown-unknown.rustflags=${JSON.stringify([
        `-Cprofile-generate=${path.join(rawProfiles, 'unused.profraw')}`,
        '-Zno-profiler-runtime',
        '-Cllvm-args=-disable-vp=true',
      ])}`,
    ],
    path.join(REPO_ROOT, 'packages/term-wasm'),
    toolchain,
    { RUSTC_BOOTSTRAP: '1' },
  );
  const profile = await train(
    path.join(generateDirectory, 'wasm32-unknown-unknown/release/term_wasm_pgo.wasm'),
    stream,
    frames,
  );
  const raw = path.join(rawProfiles, 'term-wasm.profraw');
  await Bun.write(raw, profile);

  const merged = path.join(PGO_DIRECTORY, 'term-wasm.profdata');
  await runOrThrow(
    [await llvmProfdata(toolchain), 'merge', '-o', merged, raw],
    REPO_ROOT,
    toolchain,
  );
  return merged;
}

async function train(driver: string, stream: Uint8Array, frames: number): Promise<Uint8Array> {
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
    alloc(len: number): number;
    train(font: number, fontLen: number, frames: number, framesLen: number, rounds: number): number;
    capture_profile(): number;
    profile_ptr(): number;
  };
  const place = (bytes: Uint8Array): number => {
    const pointer = exports.alloc(bytes.byteLength);
    new Uint8Array(exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
    return pointer;
  };
  const font = await Bun.file(FONT).bytes();
  const fontPointer = place(font);
  const streamPointer = place(stream);
  const applied = exports.train(
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
  const length = exports.capture_profile();
  return new Uint8Array(exports.memory.buffer, exports.profile_ptr(), length).slice();
}

/**
 * The ingress benchmark's frames (plain and styled rows, 1 to 256 dirty rows, eight
 * content phases), each followed by its `zstd-fixture`-compressed twin, behind one
 * snapshot per grid height. This is the set the PGO measurement trained on.
 */
function trainingFixtures(): { stream: Uint8Array; frames: number } {
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
          push(compressed(frame), rows, false);
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

/** The same frame with its row region zstd-compressed, as the daemon sends it. */
function compressed(frame: Uint8Array): Uint8Array {
  const rows = frame.subarray(DISPLAY_ROWS_OFFSET);
  const result = Bun.spawnSync([ZSTD_FIXTURE], { stdin: rows, stdout: 'pipe', stderr: 'inherit' });
  if (result.exitCode !== 0) throw new Error('zstd-fixture failed');
  const payload = new Uint8Array(result.stdout);
  const wire = new Uint8Array(DISPLAY_COMPRESSED_PAYLOAD_OFFSET + payload.byteLength);
  wire.set(frame.subarray(0, DISPLAY_ROWS_OFFSET));
  wire[1] = (wire[1] ?? 0) | DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD;
  writeU32BE(
    wire,
    DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
    wire.byteLength - DISPLAY_STREAM_HEADER_BYTES,
  );
  writeU32BE(wire, DISPLAY_COMPRESSED_LENGTH_OFFSET, rows.byteLength);
  wire.set(payload, DISPLAY_COMPRESSED_PAYLOAD_OFFSET);
  return wire;
}

/** rustup's `llvm-tools` copy, which matches rustc's LLVM exactly. */
async function llvmProfdata(toolchain: string): Promise<string> {
  const run = (args: string[]) =>
    Bun.spawnSync(['rustc', ...args], {
      env: { ...process.env, RUSTUP_TOOLCHAIN: toolchain },
      stdout: 'pipe',
    });
  const sysroot = new TextDecoder().decode(run(['--print', 'sysroot']).stdout).trim();
  const host = new TextDecoder().decode(run(['-vV']).stdout).match(/^host: (\S+)$/m)?.[1];
  if (sysroot.length === 0 || host === undefined)
    throw new Error('rustc reported no sysroot or host');
  const tool = path.join(sysroot, 'lib/rustlib', host, 'bin/llvm-profdata');
  if (!(await Bun.file(tool).exists())) {
    throw new Error(`${tool} is missing; rust-toolchain.toml lists llvm-tools for it`);
  }
  return tool;
}
