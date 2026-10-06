// Runs the browser transport cipher's tests (`packages/merkur-e2e/src/wasm_chacha.rs`)
// inside wasm32 under Node. That module compiles only for wasm32 with simd128, so a
// native `cargo test` never reaches it.
//
// Cargo runs from `packages/e2e-wasm` so that crate's `.cargo/config.toml` adds
// `+simd128` to the root config's wasm32 flags, exactly as the shipped build does.

import path from 'node:path';
import {
  ensureWasmBindgenCli,
  REPO_ROOT,
  resolvePinnedRustToolchain,
  runOrThrow,
  WASM_BINDGEN_TEST_RUNNER,
} from './wasm-toolchain';

const pinnedRustToolchain = await resolvePinnedRustToolchain();
await ensureWasmBindgenCli(pinnedRustToolchain);
process.env.CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER = WASM_BINDGEN_TEST_RUNNER;
await runOrThrow(
  [
    'cargo',
    'test',
    '--locked',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '-p',
    'merkur-e2e',
    '--no-default-features',
    '--features',
    'wasm',
    '--lib',
  ],
  path.join(REPO_ROOT, 'packages/e2e-wasm'),
  pinnedRustToolchain,
);
