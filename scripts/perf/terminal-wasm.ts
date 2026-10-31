import { readFile } from 'node:fs/promises';
import path from 'node:path';

const WASM_PATH = path.resolve(
  import.meta.dir,
  '../../apps/web/src/term-wasm/pkg/term_wasm_bg.wasm',
);

/** Read the terminal artifact before benchmark sampling. */
export function readTerminalWasm() {
  return readFile(WASM_PATH);
}
