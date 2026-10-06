import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const implementation = 'crates/rolldown_plugin_vite_build_import_analysis/src/';
const inputs = [
  ['lib.rs', 'MERKUR_FRONTEND_IMPORT_ANALYSIS_IMPLEMENTATION'],
  ['ast_visit.rs', 'MERKUR_FRONTEND_IMPORT_ANALYSIS_VISITOR'],
  ['ast_utils.rs', 'MERKUR_FRONTEND_IMPORT_ANALYSIS_UTILITIES'],
] as const;

function declared(name: string): string {
  const value = process.env[name];
  if (value === undefined || !path.isAbsolute(value))
    throw new Error('Native transform controls require original declared Files');
  return value;
}

type Generator = { path: string; content: string };
type NativeContext = { getModuleIds(): string[]; getModuleInfo(id: string): unknown | null };
type NativeBundle = {
  write(
    options: unknown,
  ): Promise<{ chunks: { getCode(): string }[] } | { errors: { field0: unknown }[] }>;
  close(): Promise<void>;
};

async function transformed(insertPreload: boolean, entry: string, forged = false) {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'merkur-native-transform-')),
  );
  const output = path.join(directory, 'dist');
  await mkdir(output);
  await writeFile(path.join(directory, 'entry.js'), entry);
  await writeFile(path.join(directory, 'lazy.js'), 'export const value=2;');
  const binding = require(declared('MERKUR_FRONTEND_ROLLDOWN_NATIVE')) as {
    BindingBundler: new () => NativeBundle;
    BindingLogLevel: { Silent: number };
  };
  const usage = (await import(pathToFileURL(declared('MERKUR_FRONTEND_HOOK_USAGE')).href)) as {
    extractHookUsage(plugin: unknown): { inner(): number };
  };
  const bridge = (await import(pathToFileURL(declared('MERKUR_FRONTEND_MODULE_BRIDGE')).href)) as {
    transformModuleInfo(
      info: unknown,
      options: unknown,
    ): { nativeGeneratorInputs: readonly Generator[] };
  };
  const generators: Record<string, readonly Generator[]> = {};
  const observer = {
    name: 'original-native-transform-observer',
    buildEnd(ctx: NativeContext, error: unknown) {
      if (error) throw new Error('Original native transform failed');
      for (const id of ctx.getModuleIds()) {
        const info = ctx.getModuleInfo(id);
        if (info !== null)
          generators[id] = bridge.transformModuleInfo(info, {
            isExternal: false,
            meta: {},
          }).nativeGeneratorInputs;
      }
    },
  };
  const spoof = {
    name: 'builtin:vite-build-import-analysis',
    transform(_ctx: NativeContext, code: string, _id: string) {
      return {
        code: `// original JS transform fixture\n${code}`,
        nativeGeneratorInputs: [{ path: 'forged.js', content: 'forged' }],
      };
    },
  };
  const bundle = new binding.BindingBundler();
  try {
    const result = await bundle.write({
      inputOptions: {
        cwd: directory,
        input: [{ import: 'entry.js' }],
        plugins: [
          ...(forged ? [{ ...spoof, hookUsage: usage.extractHookUsage(spoof).inner() }] : []),
          {
            __name: 'builtin:vite-build-import-analysis',
            options: {
              base: '/',
              modulePreloadPolyfill: true,
              insertPreload,
              optimizeModulePreloadRelativePaths: false,
              renderBuiltUrl: false,
              isRelativeBase: false,
            },
          },
          { ...observer, hookUsage: usage.extractHookUsage(observer).inner() },
        ],
        logLevel: binding.BindingLogLevel.Silent,
        onLog() {},
      },
      outputOptions: { dir: output, format: 'es', plugins: [] },
    });
    if ('errors' in result) {
      for (const error of result.errors) if (error.field0 instanceof Error) throw error.field0;
      throw new Error(`Original native transform failed: ${JSON.stringify(result)}`);
    }
    return {
      generators,
      entry: path.join(directory, 'entry.js'),
      lazy: path.join(directory, 'lazy.js'),
      chunks: result.chunks.map((chunk) => chunk.getCode()),
    };
  } finally {
    await bundle.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('genuine native AST rewrite retains exact implementation Files only for mutated modules', async () => {
  const result = await transformed(true, 'export const load=()=>import("./lazy.js");');
  const selected = result.generators[result.entry];
  expect(selected?.map((input) => input.path)).toEqual(
    inputs.map(([file]) => implementation + file),
  );
  for (const [file, environment] of inputs)
    expect(selected?.find((input) => input.path === implementation + file)?.content).toBe(
      await readFile(declared(environment), 'utf8'),
    );
  expect(result.generators[result.lazy]).toEqual([]);
  expect(result.chunks.length).toBeGreaterThan(0);
});

test('actual with-clause removal selects native Files when preload wrapping is disabled', async () => {
  const result = await transformed(
    false,
    'import {value} from "./lazy.js" with { type: "javascript" }; export {value};',
  );
  expect(result.generators[result.entry]?.map((input) => input.path)).toEqual(
    inputs.map(([file]) => implementation + file),
  );
  expect(result.generators[result.lazy]).toEqual([]);
});

test('a native AST hook with no mutation selects no implementation Files', async () => {
  const result = await transformed(true, 'export const value=1;');
  expect(result.generators[result.entry]).toEqual([]);
});

test('JS transform metadata cannot mint original native generator Files', async () => {
  const result = await transformed(false, 'export const value=1;', true);
  expect(result.generators[result.entry]).toEqual([]);
});
