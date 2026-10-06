// The page-lifetime asset worker owns this instance, separately from terminal and crypto memory.
import { buildWasmCrate } from './wasm-toolchain';

await buildWasmCrate('packages/graphics-wasm');
