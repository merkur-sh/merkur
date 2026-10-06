import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type NativeInput = { readonly path: string; readonly content: string };
type SelectedModule = { id: string; nativeGeneratorInputs: readonly NativeInput[] };

function requiredDirectory(name: string): string {
  const value = process.env[name];
  if (value === undefined || !path.isAbsolute(value))
    throw new Error('Native origin control requires actual declared Rolldown package and sources');
  return value;
}

for (const shadow of [false, true]) {
  test(
    shadow
      ? 'identical JS load bytes do not mint native source custody'
      : 'winning native polyfill retains exact source Files despite JS name and metadata spoof',
    async () => {
      const packageRoot = requiredDirectory('MERKUR_ROLLDOWN_GLUE_PACKAGE');
      const sources = requiredDirectory('MERKUR_ROLLDOWN_GLUE_SOURCES');
      const { rolldown } = await import(
        pathToFileURL(path.join(packageRoot, 'dist/index.mjs')).href
      );
      const { viteModulePreloadPolyfillPlugin } = await import(
        pathToFileURL(path.join(packageRoot, 'dist/experimental-index.mjs')).href
      );
      const generator = 'crates/rolldown_plugin_vite_module_preload_polyfill/src/';
      const template = await readFile(
        path.join(sources, generator, 'module-preload-polyfill.js'),
        'utf8',
      );
      const implementation = await readFile(path.join(sources, generator, 'lib.rs'), 'utf8');
      const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-native-origin-'));
      const captured = new Map<string, readonly NativeInput[]>();
      const forged = [{ path: 'foreign/source.js', content: 'foreign' }];
      try {
        await mkdir(path.join(directory, 'output'));
        await writeFile(
          path.join(directory, 'entry.js'),
          'import "fixture-counterfeit"; import "vite/modulepreload-polyfill"; export const value=1;',
        );
        const observer = {
          name: 'native-origin-observer',
          moduleParsed(info: SelectedModule) {
            expect(Array.isArray(info.nativeGeneratorInputs)).toBe(true);
            expect(Reflect.set(info, 'nativeGeneratorInputs', forged)).toBe(false);
            expect(Object.isFrozen(info.nativeGeneratorInputs)).toBe(true);
            for (const input of info.nativeGeneratorInputs) {
              expect(Object.isFrozen(input)).toBe(true);
              expect(Reflect.set(input, 'path', 'foreign/source.js')).toBe(false);
            }
            captured.set(info.id, info.nativeGeneratorInputs);
          },
        };
        const spoof = {
          name: 'builtin:vite-module-preload-polyfill',
          resolveId(id: string) {
            if (id === 'fixture-counterfeit') return '\0fixture-counterfeit';
          },
          load(id: string) {
            if (
              id === '\0fixture-counterfeit' ||
              (shadow && id === '\0vite/modulepreload-polyfill.js')
            )
              return {
                code: shadow ? template : 'export const counterfeit=true;',
                nativeGeneratorInputs: forged,
                meta: { nativeGeneratorInputs: forged },
              };
          },
        };
        const bundle = await rolldown({
          cwd: directory,
          input: 'entry.js',
          plugins: [spoof, viteModulePreloadPolyfillPlugin({ isServer: false }), observer],
        });
        try {
          await bundle.write({ dir: path.join(directory, 'output'), format: 'esm' });
        } finally {
          await bundle.close();
        }
        expect(captured.get('\0fixture-counterfeit')).toEqual([]);
        expect(captured.get('\0vite/modulepreload-polyfill.js')).toEqual(
          shadow
            ? []
            : [
                { path: `${generator}module-preload-polyfill.js`, content: template },
                { path: `${generator}lib.rs`, content: implementation },
              ],
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
