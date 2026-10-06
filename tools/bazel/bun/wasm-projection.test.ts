import { expect, test } from 'bun:test';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

test('browser WASM package projection retains the complete bytes as ordinary output files', async () => {
  const root = path.resolve(import.meta.dir, '../../..');
  const source = path.join(root, 'packages/e2e-wasm/pkg');
  const projected = path.join(root, 'apps/web/src/e2e-wasm/pkg');
  const files = (await readdir(source)).sort();
  expect(files).toEqual([
    '.gitignore',
    'e2e_wasm.d.ts',
    'e2e_wasm.js',
    'e2e_wasm_bg.wasm',
    'e2e_wasm_bg.wasm.d.ts',
    'package.json',
  ]);
  expect((await readdir(projected)).sort()).toEqual(files);
  for (const file of files) {
    expect((await lstat(path.join(projected, file))).isFile()).toBe(true);
    expect(await readFile(path.join(projected, file))).toEqual(
      await readFile(path.join(source, file)),
    );
  }
});
