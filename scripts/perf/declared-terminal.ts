import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_TERMINAL_FONT } from '../../apps/web/src/terminal/fonts';

/** Consume the configured terminal artifact before any benchmark sampling. */
export async function loadBenchmarkTerminal(width: number, height: number) {
  const root = path.resolve(import.meta.dir, '../..');
  const fontUrl = new URL(DEFAULT_TERMINAL_FONT.regular, 'https://merkur.local');
  const [fontBytes, termWasmBytes] = await Promise.all([
    readFile(path.join(root, 'apps/web/public', fontUrl.pathname)),
    readFile(path.join(root, 'apps/web/src/term-wasm/pkg/term_wasm_bg.wasm')),
  ]);
  const wasm = await import('../../apps/web/src/term-wasm/pkg/term_wasm.js');
  const runtime = wasm.initSync({ module: termWasmBytes });
  const terminal = wasm.init_regular(width, height, fontBytes, 14, 1.2, 1);
  return { wasm, runtime, terminal, fontBytes };
}
