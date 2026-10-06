import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('declared tsconfig discovery preserves aliases and JSX through symlinks and nested cwd', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-bun-config-'));
  try {
    await mkdir(path.join(directory, 'nested'));
    await writeFile(path.join(directory, 'alias.ts'), 'export const value = 42;');
    await writeFile(
      path.join(directory, 'runtime.ts'),
      'export function jsx(tag,props){return {tag,props,marker:"custom-runtime"};} export const jsxs=jsx;',
    );
    await writeFile(
      path.join(directory, 'entry.tsx'),
      'import {value} from "alias"; const node=<probe>{value}</probe>; if(node.marker!=="custom-runtime"||node.props.children!==42)throw new Error("configuration semantics"); process.stdout.write("jsx-alias-ok\\n");',
    );
    await writeFile(
      path.join(directory, 'base.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { alias: ['./alias.ts'], 'jsx-test/jsx-runtime': ['./runtime.ts'] },
          jsx: 'react-jsx',
          jsxImportSource: 'jsx-test',
        },
      }),
    );
    await writeFile(path.join(directory, 'real.json'), '{"extends":"./base.json"}');
    await symlink(path.join(directory, 'real.json'), path.join(directory, 'tsconfig.json'));
    await writeFile(path.join(directory, 'nested/tsconfig.json'), '{"extends":"../tsconfig.json"}');
    for (const cwd of [directory, path.join(directory, 'nested')]) {
      const result = Bun.spawnSync(
        [process.execPath, '--no-env-file', path.join(directory, 'entry.tsx')],
        { cwd, stdout: 'pipe', stderr: 'pipe' },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe('jsx-alias-ok\n');
      expect(result.stderr.toString()).toBe('');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('msgpackr uses the declared native optional prebuild without lifecycle installation', async () => {
  const effect = Bun.resolveSync('effect', process.cwd());
  const entry = Bun.resolveSync('msgpackr', path.dirname(effect));
  // msgpackr catches native bootstrap errors and silently selects JavaScript.
  // Load its exact optional extractor first so qualification retains the cause.
  const extractor = Bun.resolveSync('msgpackr-extract', path.dirname(entry));
  await import(extractor);
  const native = (await import(entry)) as {
    isNativeAccelerationEnabled: boolean;
    pack(value: unknown): Uint8Array;
    unpack(bytes: Uint8Array): unknown;
  };
  expect(native.isNativeAccelerationEnabled).toBe(true);
  const payload = { text: 'native extractor: λ🚀漢字'.repeat(100), values: [1, 2, 3] };
  expect(native.unpack(native.pack(payload))).toEqual(payload);
});
