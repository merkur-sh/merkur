import { expect, test } from 'bun:test';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModuleInfo, OutputBundle } from 'rolldown';
import { frontendSourceSelection } from './frontend-source-provider';

type NativeContext = {
  getModuleIds(): string[];
  getModuleInfo(id: string): unknown | null;
};
type NativeChunk = { getCode(): string; getModules(): unknown; getFileName(): string };
type NativeOutputs = { chunks: NativeChunk[]; assets: unknown[] };
type Chunk = Extract<OutputBundle[string], { type: 'chunk' }>;
type NativeBundle = {
  write(options: unknown): Promise<NativeOutputs | { errors: { field0: unknown }[] }>;
  close(): Promise<void>;
};
type OriginalDeclaration = { input: string; link: boolean; owner: string; canonical: string };
const generator = 'crates/rolldown_plugin_vite_module_preload_polyfill/src/';
const generatorPaths = [`${generator}module-preload-polyfill.js`, `${generator}lib.rs`] as const;

function declared(name: string): string {
  const value = process.env[name];
  if (value === undefined || !path.isAbsolute(value))
    throw new Error('Frontend origin controls require genuine declared native and source Files');
  return value;
}

async function fixture() {
  const sourceFiles: Record<string, string> = {
    [generatorPaths[0]]: declared('MERKUR_FRONTEND_POLYFILL_TEMPLATE'),
    [generatorPaths[1]]: declared('MERKUR_FRONTEND_POLYFILL_IMPLEMENTATION'),
  };
  const native = declared('MERKUR_FRONTEND_ROLLDOWN_NATIVE');
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'merkur-frontend-native-origin-')),
  );
  const root = path.join(directory, 'materialized');
  const originals = path.join(directory, 'originals');
  const output = path.join(directory, 'dist');
  await mkdir(root);
  await mkdir(originals);
  const declarations: Record<string, OriginalDeclaration> = {};
  for (const file of generatorPaths) {
    const canonical = `upstream/original-rolldown/${file}`;
    const original = path.join(originals, file);
    const copied = path.join(root, canonical);
    await mkdir(path.dirname(original), { recursive: true });
    await mkdir(path.dirname(copied), { recursive: true });
    const source = sourceFiles[file];
    if (source === undefined) throw new Error('Original generator File role absent');
    await cp(source, original);
    await cp(original, copied);
    declarations[canonical] = {
      input: original,
      link: false,
      owner:
        '@@original_rolldown//crates/rolldown_plugin_vite_module_preload_polyfill:src/' +
        path.basename(file),
      canonical,
    };
    declarations[file] = { ...declarations[canonical], canonical };
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await symlink(copied, path.join(root, file));
  }
  const entry = 'import "vite/modulepreload-polyfill"; export const value=1;';
  await writeFile(path.join(root, 'entry.js'), entry);
  await writeFile(path.join(originals, 'entry.js'), entry);
  declarations['entry.js'] = {
    input: path.join(originals, 'entry.js'),
    link: false,
    owner: '//fixture:entry.js',
    canonical: 'entry.js',
  };
  await writeFile(path.join(root, 'unused-generator.js'), 'export const unused=true;');
  await writeFile(path.join(originals, 'unused-generator.js'), 'export const unused=true;');
  declarations['unused-generator.js'] = {
    input: path.join(originals, 'unused-generator.js'),
    link: false,
    owner: '//fixture:unused-generator.js',
    canonical: 'unused-generator.js',
  };
  const declarationFile = path.join(directory, 'declarations.json');
  const binding = require(native) as {
    BindingBundler: new () => NativeBundle;
    BindingLogLevel: { Silent: number };
  };
  const usage = (await import(pathToFileURL(declared('MERKUR_FRONTEND_HOOK_USAGE')).href)) as {
    extractHookUsage(plugin: unknown): { inner(): number };
  };
  const bridge = (await import(pathToFileURL(declared('MERKUR_FRONTEND_MODULE_BRIDGE')).href)) as {
    transformModuleInfo(info: unknown, options: unknown): ModuleInfo;
  };
  const outputs = (await import(pathToFileURL(declared('MERKUR_FRONTEND_CHUNK_BRIDGE')).href)) as {
    transformChunkModules(modules: unknown): Chunk['modules'];
  };
  async function run(shadow = false, observed = true, captureModules = true) {
    await writeFile(declarationFile, JSON.stringify(declarations));
    const selection = await frontendSourceSelection(root, directory, declarationFile);
    const configResolved = selection.plugin.configResolved;
    if (typeof configResolved !== 'function')
      throw new Error('Original collector config hook absent');
    await Reflect.apply(configResolved, undefined, [
      {
        publicDir: '',
        build: { write: true, copyPublicDir: false },
        worker: { plugins: async () => ({ environments: { client: { plugins: [] } } }) },
      },
    ]);
    const context = (nativeContext: NativeContext) => ({
      getModuleIds: () => nativeContext.getModuleIds(),
      getModuleInfo: (id: string) => {
        const info = nativeContext.getModuleInfo(id);
        return info === null
          ? null
          : bridge.transformModuleInfo(info, { isExternal: false, meta: {} });
      },
    });
    const observer = {
      name: 'genuine-native-frontend-collector',
      async buildEnd(ctx: NativeContext, error: unknown) {
        if (error) throw new Error('Original native fixture build failed');
        if (!captureModules) return;
        const hook = selection.plugin.buildEnd;
        if (typeof hook !== 'function') throw new Error('Original collector build hook absent');
        await Reflect.apply(hook, context(ctx), [undefined]);
      },
      async generateBundle(ctx: NativeContext, bundle: NativeOutputs) {
        const hook = selection.plugin.generateBundle;
        if (hook === undefined || typeof hook === 'function' || typeof hook.handler !== 'function')
          throw new Error('Original collector output hook absent');
        if (bundle.assets.length !== 0)
          throw new Error('Original polyfill fixture unexpectedly emitted assets');
        const outputBundle = Object.fromEntries(
          bundle.chunks.map((item) => [
            item.getFileName(),
            {
              type: 'chunk',
              code: item.getCode(),
              modules: outputs.transformChunkModules(item.getModules()),
            },
          ]),
        );
        await Reflect.apply(hook.handler, context(ctx), [{}, outputBundle]);
        return { changes: {}, deleted: new Set<string>() };
      },
    };
    const shadowPlugin = {
      name: 'builtin:vite-module-preload-polyfill',
      async load(_ctx: NativeContext, id: string) {
        if (id === '\0vite/modulepreload-polyfill.js')
          return {
            code: await readFile(declared('MERKUR_FRONTEND_POLYFILL_TEMPLATE'), 'utf8'),
            nativeGeneratorInputs: [{ path: 'forged.js', content: 'forged' }],
          };
      },
    };
    const transformPlugin = {
      name: 'genuine-fixture-transform',
      transform(_ctx: NativeContext, code: string, id: string) {
        return id === path.join(root, 'entry.js')
          ? { code: `// original transform fixture\n${code}` }
          : undefined;
      },
    };
    const plugins = [
      ...(shadow
        ? [{ ...shadowPlugin, hookUsage: usage.extractHookUsage(shadowPlugin).inner() }]
        : []),
      { __name: 'builtin:vite-module-preload-polyfill', options: { isServer: false } },
      { ...transformPlugin, hookUsage: usage.extractHookUsage(transformPlugin).inner() },
      ...(observed ? [{ ...observer, hookUsage: usage.extractHookUsage(observer).inner() }] : []),
    ];
    const bundle = new binding.BindingBundler();
    const emitted: Record<string, string> = {};
    try {
      const result = await bundle.write({
        inputOptions: {
          cwd: root,
          input: [{ import: 'entry.js' }],
          plugins,
          logLevel: binding.BindingLogLevel.Silent,
          onLog() {},
        },
        outputOptions: { dir: output, format: 'es', plugins: [] },
      });
      if ('errors' in result) {
        for (const error of result.errors) if (error.field0 instanceof Error) throw error.field0;
        throw new Error(`Original native fixture failed: ${JSON.stringify(result)}`);
      }
      if (!Array.isArray(result.chunks) || !Array.isArray(result.assets))
        throw new Error(
          `Original native binding did not produce compiler outputs: ${JSON.stringify(result)}`,
        );
      for (const chunk of result.chunks)
        emitted[chunk.getFileName()] = (
          await readFile(path.join(output, chunk.getFileName()))
        ).toString('base64');
    } finally {
      await bundle.close();
    }
    return { ...selection, emitted };
  }
  return { directory, root, originals, output, declarations, run };
}

async function withFixture(body: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const value = await fixture();
  try {
    await body(value);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
}

test('genuine winning native load selects only exact embedded generator Files and preserves pending outputs', async () => {
  await withFixture(async (value) => {
    const originalOutput = (await value.run(false, false)).emitted;
    const selection = await value.run();
    expect(selection.emitted).toEqual(originalOutput);
    const file = path.join(value.directory, 'selection.json');
    await selection.finish(value.output, file);
    const result = JSON.parse(await readFile(file, 'utf8'));
    for (const generatorPath of generatorPaths)
      expect(result.inputs[`upstream/original-rolldown/${generatorPath}`].bytes).toBe(
        (await readFile(path.join(value.originals, generatorPath))).byteLength,
      );
    expect(result.inputs['unused-generator.js']).toBeUndefined();
    const transformed = result.unmatched_generated_modules.find(
      (item: { id: string }) => item.id === path.join(value.root, 'entry.js'),
    );
    expect(transformed.source).toBe('entry.js');
    expect(transformed.native_generators).toEqual([]);
    const generated = result.unmatched_generated_modules.find(
      (item: { id: string }) => item.id === '\0vite/modulepreload-polyfill.js',
    );
    expect(generated.native_generators.map((item: { id: string }) => item.id)).toEqual(
      generatorPaths,
    );
    expect(result.unmatched_generated_assets.length).toBeGreaterThan(0);
    expect(Object.keys(result.outputs)).toEqual(Object.keys(result.artifacts));
  });
});

test('identical winning JS load bytes cannot mint native generator custody', async () => {
  await withFixture(async (value) => {
    const selection = await value.run(true);
    const file = path.join(value.directory, 'selection.json');
    await selection.finish(value.output, file);
    const result = JSON.parse(await readFile(file, 'utf8'));
    for (const generatorPath of generatorPaths)
      expect(result.inputs[`upstream/original-rolldown/${generatorPath}`]).toBeUndefined();
    const generated = result.unmatched_generated_modules.find(
      (item: { id: string }) => item.id === '\0vite/modulepreload-polyfill.js',
    );
    expect(generated.native_generators).toEqual([]);
    expect(result.unmatched_generated_assets.length).toBeGreaterThan(0);
  });
});

for (const [mutation, captureModules] of [
  ['absent-alias', true],
  ['copied-bytes', true],
  ['embedded-bytes', true],
  ['late-source', true],
  ['missing-original', true],
  ['late-output', true],
  ['absent-alias', false],
  ['copied-bytes', false],
  ['embedded-bytes', false],
] as const)
  test(`genuine native ${captureModules ? 'source' : 'retained output'} custody refuses ${mutation}`, async () => {
    await withFixture(async (value) => {
      const original = path.join(value.originals, generatorPaths[0]);
      const copied = path.join(value.root, 'upstream/original-rolldown', generatorPaths[0]);
      if (mutation === 'absent-alias') {
        delete value.declarations[generatorPaths[0]];
        await unlink(path.join(value.root, generatorPaths[0]));
      }
      if (mutation === 'copied-bytes' || mutation === 'embedded-bytes')
        await writeFile(copied, 'mutated original generator');
      if (mutation === 'embedded-bytes') await writeFile(original, 'mutated original generator');
      if (
        mutation === 'absent-alias' ||
        mutation === 'copied-bytes' ||
        mutation === 'embedded-bytes'
      ) {
        const reason =
          mutation === 'absent-alias'
            ? 'exact declared source alias'
            : mutation === 'copied-bytes'
              ? 'differs from its original declared File'
              : 'actual embedded source bytes';
        await expect(value.run(false, true, captureModules)).rejects.toThrow(reason);
        return;
      }
      const selection = await value.run();
      if (mutation === 'late-source') {
        await writeFile(copied, 'late mutated original generator');
        await writeFile(original, 'late mutated original generator');
      } else if (mutation === 'missing-original') await unlink(original);
      else await writeFile(path.join(value.output, 'entry.js'), 'late changed output');
      const reason =
        mutation === 'late-source'
          ? 'changed before output capture'
          : mutation === 'missing-original'
            ? 'ENOENT'
            : 'emitted bytes differ';
      await expect(
        selection.finish(value.output, path.join(value.directory, 'selection.json')),
      ).rejects.toThrow(reason);
    });
  });

type RetainedGenerator = { id: string; path: string; owner: string; bytes: number; sha256: string };
async function retainedOutput(
  value: Awaited<ReturnType<typeof fixture>>,
  selection: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['run']>>,
) {
  const file = path.join(value.directory, 'output-selection.json');
  await selection.finish(value.output, file);
  const result = JSON.parse(await readFile(file, 'utf8'));
  const selected = Object.values(result.outputs).flatMap((output: unknown) => {
    const observations = (output as { observations: { selected: unknown[] }[] }).observations;
    return observations.flatMap((observation) => observation.selected);
  });
  const retained = selected.find(
    (item: unknown) => (item as { id: string }).id === '\0vite/modulepreload-polyfill.js',
  ) as { native_generators: RetainedGenerator[] };
  return { result, retained };
}

test('retained output joins genuine native generators without a prior module observation', async () => {
  await withFixture(async (value) => {
    const originalOutput = (await value.run(false, false)).emitted;
    const selection = await value.run(false, true, false);
    expect(selection.emitted).toEqual(originalOutput);
    const { result, retained } = await retainedOutput(value, selection);
    expect(retained.native_generators.map((item) => item.id)).toEqual([...generatorPaths]);
    for (const generator of retained.native_generators) {
      const input = result.inputs[generator.path];
      expect({ owner: generator.owner, bytes: generator.bytes, sha256: generator.sha256 }).toEqual({
        owner: input.owner,
        bytes: input.bytes,
        sha256: input.sha256,
      });
    }
    expect(result.inputs['unused-generator.js']).toBeUndefined();
    expect(result.unmatched_generated_modules).toEqual([]);
    expect(result.unmatched_generated_assets.length).toBeGreaterThan(0);
  });
});

test('retained identical JS-generated output cannot mint native generator custody', async () => {
  await withFixture(async (value) => {
    const selection = await value.run(true, true, false);
    const { result, retained } = await retainedOutput(value, selection);
    for (const generatorPath of generatorPaths)
      expect(result.inputs[`upstream/original-rolldown/${generatorPath}`]).toBeUndefined();
    expect(retained.native_generators).toEqual([]);
    expect(result.unmatched_generated_assets.length).toBeGreaterThan(0);
  });
});
