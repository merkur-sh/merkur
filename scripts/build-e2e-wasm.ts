// Builds the browser binding for the shared E2E Noise implementation.
//
// The transport worker loads this module; the terminal worker loads
// `term-wasm`. They are separate crates on purpose — folding the E2E code into
// term-wasm would make the transport worker download and instantiate the whole
// terminal grid and font rasterizer to encrypt a keystroke.

import { buildWasmCrate } from './wasm-toolchain';

await buildWasmCrate('packages/e2e-wasm');
