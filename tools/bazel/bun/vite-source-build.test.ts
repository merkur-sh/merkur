import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildViteSource,
  extractPublishedViteChunk,
  materializeViteBuild,
  observedViteConfiguration,
  observeViteSourceBuild,
  requireViteOutputParity,
  retainSourceSelection,
  type ViteBuildInputs,
} from './vite-source-build';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vite-source-control-'));
  roots.push(root);
  return root;
}
async function file(root: string, name: string, bytes: string) {
  const target = path.join(root, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}
const sourcePackage = {
  name: 'vite',
  version: '8.2.2',
  dependencies: { rolldown: '~1.2.4' },
  scripts: {
    'build-bundle': 'rolldown --config rolldown.config.ts',
    'build-types-roll': 'rolldown --config rolldown.dts.config.ts',
    'build-types-check': 'tsc --project tsconfig.check.json',
  },
};
async function fixture() {
  const root = await directory();
  const originals: Record<string, string> = {};
  const declarations: Record<
    string,
    { input: string; owner: string; link: boolean; canonical: string }
  > = {};
  async function authored(logical: string, bytes: string) {
    const input = 'original/' + logical;
    originals[input] = await file(root, input, bytes);
    declarations[logical] = {
      input,
      owner: '@@original//:' + logical,
      link: false,
      canonical: logical,
    };
  }
  async function pkg(logical: string, name: string, version: string) {
    const input = 'original/' + logical;
    originals[input] = path.join(root, input);
    await file(
      root,
      input + '/package.json',
      JSON.stringify({
        name,
        version,
        bin: name === 'typescript' ? { tsc: './bin/tsc' } : undefined,
      }),
    );
    declarations[logical] = { input, owner: '@@npm//:' + logical, link: true, canonical: logical };
  }
  await authored('upstream/vite/packages/vite/package.json', JSON.stringify(sourcePackage));
  await authored(
    'upstream/vite/package.json',
    JSON.stringify({ devDependencies: { rolldown: '~1.2.4' } }),
  );
  await authored(
    'upstream/vite/pnpm-lock.yaml',
    JSON.stringify({
      importers: {
        '.': { devDependencies: { rolldown: { specifier: '~1.2.4', version: '1.2.4' } } },
        'packages/vite': { dependencies: { rolldown: { specifier: '~1.2.4', version: '1.2.4' } } },
      },
    }),
  );
  await pkg('stores/rolldown', 'rolldown', '1.2.4');
  await pkg('stores/typescript', 'typescript', '6.0.3');
  for (const logical of [
    'upstream/vite/node_modules/rolldown',
    'upstream/vite/packages/vite/node_modules/rolldown',
  ])
    declarations[logical] = {
      ...declarations['stores/rolldown'],
      canonical: 'stores/rolldown',
    } as (typeof declarations)[string];
  declarations['upstream/vite/node_modules/typescript'] = {
    ...declarations['stores/typescript'],
    canonical: 'stores/typescript',
  } as (typeof declarations)[string];
  const rolldown = path.join(root, 'rebuilt');
  await file(root, 'rebuilt/package.json', JSON.stringify({ name: 'rolldown', version: '1.2.4' }));
  await file(root, 'rebuilt/dist/actual.node', 'native fixture bytes; never executed');
  const native = await file(root, 'actual.node', 'native fixture bytes; never executed');
  const sources = path.join(root, 'rolldown-source');
  await file(root, 'rolldown-source/packages/rolldown/bin/cli.mjs', "import '../dist/cli.mjs';");
  const spec = await file(root, 'declarations.json', JSON.stringify(declarations));
  const inputs: ViteBuildInputs = {
    operation: 'build',
    declarations: spec,
    original_files: originals,
    source_namespace: 'upstream/vite',
    source_patch: await file(root, 'source.patch', 'patch input'),
    rolldown,
    rolldown_sources: sources,
    native,
    compiler_context: await file(root, 'compiler-context.json', 'original compiler context'),
    preload: await file(root, 'preload.js', 'original prepared generator'),
    git: '/declared-sdk/bin/git',
    git_sdk: '/declared-sdk',
    bun_config: '/declared/config',
    output: path.join(root, 'output'),
    selection: path.join(root, 'selection.json'),
  };
  return { root, inputs, declarations };
}

async function publishedArchive(root: string, bytes: string, version = '8.2.2') {
  const archive = new Bun.Archive(
    {
      'package/package.json': JSON.stringify({ name: 'vite', version }),
      'package/dist/node/chunks/node.js': bytes,
    },
    { compress: 'gzip' },
  );
  const output = path.join(root, 'published.tgz');
  await writeFile(output, await archive.bytes());
  return output;
}

test('extracts exact original published Vite member and refuses replacement', async () => {
  const root = await directory();
  const pkg = path.join(root, 'package');
  await file(root, 'package/package.json', JSON.stringify({ name: 'vite', version: '8.2.2' }));
  const bytes = 'original published chunk bytes\n';
  await file(root, 'package/dist/node/chunks/node.js', bytes);
  const archive = await publishedArchive(root, bytes);
  const output = path.join(root, 'node.js');
  await extractPublishedViteChunk(pkg, archive, output);
  expect(await readFile(output, 'utf8')).toBe(bytes);
  await expect(extractPublishedViteChunk(pkg, archive, output)).rejects.toThrow();
  expect(await readFile(output, 'utf8')).toBe(bytes);
});
test('published original member rejects an outside package alias', async () => {
  const root = await directory();
  await file(root, 'package/package.json', JSON.stringify({ name: 'vite', version: '8.2.2' }));
  const outside = await file(root, 'outside.js', 'foreign');
  await mkdir(path.join(root, 'package/dist/node/chunks'), { recursive: true });
  await symlink(outside, path.join(root, 'package/dist/node/chunks/node.js'));
  const archive = await publishedArchive(root, 'original');
  const output = path.join(root, 'out');
  await expect(
    extractPublishedViteChunk(path.join(root, 'package'), archive, output),
  ).rejects.toThrow('store differs from its original archive');
  expect(await readFile(outside, 'utf8')).toBe('foreign');
  await expect(readFile(output)).rejects.toThrow();
});
test('published archive owns bytes through a per-member sandbox carrier', async () => {
  const root = await directory();
  const bytes = 'original published chunk bytes\n';
  const manifest = await file(
    root,
    'original/package.json',
    JSON.stringify({ name: 'vite', version: '8.2.2' }),
  );
  const member = await file(root, 'original/dist/node/chunks/node.js', bytes);
  const carrier = path.join(root, 'carrier');
  await mkdir(path.join(carrier, 'dist/node/chunks'), { recursive: true });
  await symlink(manifest, path.join(carrier, 'package.json'));
  await symlink(member, path.join(carrier, 'dist/node/chunks/node.js'));
  const archive = await publishedArchive(root, bytes);
  const output = path.join(root, 'out');
  await extractPublishedViteChunk(carrier, archive, output);
  expect(await readFile(output, 'utf8')).toBe(bytes);
  expect(await readFile(member, 'utf8')).toBe(bytes);
});
test('published archive and store byte or version disagreement refuses', async () => {
  const root = await directory();
  const pkg = path.join(root, 'package');
  await file(root, 'package/package.json', JSON.stringify({ name: 'vite', version: '8.2.2' }));
  await file(root, 'package/dist/node/chunks/node.js', 'original');
  const output = path.join(root, 'out');
  const archive = await publishedArchive(root, 'other original');
  await expect(extractPublishedViteChunk(pkg, archive, output)).rejects.toThrow(
    'store differs from its original archive',
  );
  await expect(readFile(output)).rejects.toThrow();
  const wrongVersion = await publishedArchive(root, 'original', '8.2.1');
  await expect(extractPublishedViteChunk(pkg, wrongVersion, output)).rejects.toThrow(
    'package identity differs',
  );
  await expect(readFile(output)).rejects.toThrow();
});
test('published extraction requires the original archive regular member', async () => {
  const root = await directory();
  const pkg = path.join(root, 'package');
  await file(root, 'package/package.json', JSON.stringify({ name: 'vite', version: '8.2.2' }));
  await file(root, 'package/dist/node/chunks/node.js', 'original');
  const archive = path.join(root, 'missing-member.tgz');
  await writeFile(
    archive,
    await new Bun.Archive({ 'package/package.json': '{}' }, { compress: 'gzip' }).bytes(),
  );
  const output = path.join(root, 'out');
  await expect(extractPublishedViteChunk(pkg, archive, output)).rejects.toThrow(
    'archive members are missing',
  );
  await expect(readFile(output)).rejects.toThrow();
});
test('rebuild package preserves one declared alias identity and original bytes', async () => {
  const { inputs } = await fixture();
  const original = await readFile(
    inputs.original_files['original/stores/rolldown'] + '/package.json',
  );
  const prepared = await materializeViteBuild(inputs);
  expect(
    await readFile(
      path.join(inputs.output, 'upstream/vite/node_modules/rolldown/dist/actual.node'),
      'utf8',
    ),
  ).toBe('native fixture bytes; never executed');
  expect(await readFile(prepared.cli, 'utf8')).toBe("import '../dist/cli.mjs';");
  expect(
    await readFile(inputs.original_files['original/stores/rolldown'] + '/package.json'),
  ).toEqual(original);
  expect(prepared.packageRoot).toBe(path.join(inputs.output, 'upstream/vite/packages/vite'));
});
test('missing original File and divergent declared alias refuse', async () => {
  const first = await fixture();
  delete first.inputs.original_files['original/upstream/vite/packages/vite/package.json'];
  await expect(materializeViteBuild(first.inputs)).rejects.toThrow(
    'lacks its original declared File',
  );
  const second = await fixture();
  const alias = second.declarations['upstream/vite/packages/vite/node_modules/rolldown'];
  if (!alias) throw new Error('fixture alias missing');
  alias.canonical = 'stores/typescript';
  await writeFile(second.inputs.declarations, JSON.stringify(second.declarations));
  await expect(materializeViteBuild(second.inputs)).rejects.toThrow(
    'one actual declared Rolldown package identity',
  );
});
test('dependency interior alias cannot copy undeclared member', async () => {
  const { root, inputs } = await fixture();
  const outside = await file(root, 'outside', 'foreign');
  const store = inputs.original_files['original/stores/rolldown'];
  if (!store) throw new Error('fixture store missing');
  await symlink(outside, path.join(store, 'foreign'));
  await expect(materializeViteBuild(inputs)).rejects.toThrow('escaped its original declared tree');
  expect(await readFile(outside, 'utf8')).toBe('foreign');
});
test('upstream build commands are checked before native or compiler execution', async () => {
  const { inputs } = await fixture();
  const original = inputs.original_files['original/upstream/vite/packages/vite/package.json'];
  if (!original) throw new Error('fixture File missing');
  await writeFile(
    original,
    JSON.stringify({
      ...sourcePackage,
      scripts: { ...sourcePackage.scripts, 'build-bundle': 'other' },
    }),
  );
  await expect(materializeViteBuild(inputs)).rejects.toThrow('original upstream build commands');
});

test('original optional native alias is removed while local File bytes remain', async () => {
  const { root, inputs, declarations } = await fixture();
  const packageDirectory = inputs.original_files['original/stores/rolldown'];
  if (!packageDirectory) throw new Error('fixture store missing');
  await writeFile(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: 'rolldown',
      version: '1.2.4',
      optionalDependencies: { '@rolldown/binding-darwin-arm64': '1.2.4' },
    }),
  );
  const input = 'original/stores/prebuilt';
  inputs.original_files[input] = path.join(root, input);
  await file(
    root,
    `${input}/package.json`,
    JSON.stringify({ name: '@rolldown/binding-darwin-arm64', version: '1.2.4' }),
  );
  declarations['stores/prebuilt'] = {
    input,
    owner: '@@npm//:prebuilt',
    link: true,
    canonical: 'stores/prebuilt',
  };
  declarations['stores/node_modules/@rolldown/binding-darwin-arm64'] = {
    ...declarations['stores/prebuilt'],
    canonical: 'stores/prebuilt',
  } as (typeof declarations)[string];
  await writeFile(inputs.declarations, JSON.stringify(declarations));
  const prepared = await materializeViteBuild(inputs);
  await expect(
    readFile(
      path.join(inputs.output, 'stores/node_modules/@rolldown/binding-darwin-arm64/package.json'),
    ),
  ).rejects.toThrow();
  expect(
    await readFile(path.join(path.dirname(path.dirname(prepared.cli)), 'dist/actual.node'), 'utf8'),
  ).toBe('native fixture bytes; never executed');
});

test('source patch executable must be the original declared SDK member', async () => {
  const { inputs } = await fixture();
  inputs.git = '/other/bin/git';
  await expect(buildViteSource(inputs)).rejects.toThrow('declared Git SDK executable');
  await expect(readFile(path.join(inputs.output, 'package.json'))).rejects.toThrow();
});

test('rebuilt package must match both original Vite lock selections and manifest specifiers', async () => {
  const replacement = await fixture();
  await writeFile(
    path.join(replacement.inputs.rolldown, 'package.json'),
    JSON.stringify({ name: 'rolldown', version: '1.2.5' }),
  );
  await expect(materializeViteBuild(replacement.inputs)).rejects.toThrow(
    'Rebuilt Rolldown differs from the original selected dependency',
  );
  const changedLock = await fixture();
  const lock = changedLock.inputs.original_files['original/upstream/vite/pnpm-lock.yaml'];
  if (!lock) throw new Error('fixture original lock missing');
  await writeFile(
    lock,
    JSON.stringify({
      importers: {
        '.': { devDependencies: { rolldown: { specifier: '~1.2.4', version: '1.2.4' } } },
        'packages/vite': { dependencies: { rolldown: { specifier: '~1.2.4', version: '1.2.5' } } },
      },
    }),
  );
  await expect(materializeViteBuild(changedLock.inputs)).rejects.toThrow(
    'Rebuilt Rolldown differs from the original selected dependency',
  );
  const changedManifest = await fixture();
  const manifest = changedManifest.inputs.original_files['original/upstream/vite/package.json'];
  if (!manifest) throw new Error('fixture original manifest missing');
  await writeFile(manifest, JSON.stringify({ devDependencies: { rolldown: '^1.2.5' } }));
  await expect(materializeViteBuild(changedManifest.inputs)).rejects.toThrow(
    'Rebuilt Rolldown differs from the original selected dependency',
  );
});

test('source observer retains original Files and leaves generated modules explicitly unmatched', async () => {
  const { root, inputs } = await fixture();
  await materializeViteBuild(inputs);
  const declarationId = path.join(
    inputs.output,
    inputs.source_namespace,
    'packages/vite/package.json',
  );
  const generatedId = '\0native-generated';
  const record = path.join(root, 'observed.json');
  const original = await readFile(
    inputs.original_files['original/upstream/vite/packages/vite/package.json'] ?? 'missing',
  );
  const graph = new Map([
    [
      declarationId,
      {
        id: declarationId,
        isExternal: false,
        importedIds: [generatedId],
        dynamicallyImportedIds: [],
        code: 'transformed compiler code',
      },
    ],
    [
      generatedId,
      {
        id: generatedId,
        isExternal: false,
        importedIds: [],
        dynamicallyImportedIds: [],
        code: 'generated compiler code',
      },
    ],
  ]);
  const plugin = observeViteSourceBuild(inputs, record);
  await plugin.generateBundle.call(
    {
      getModuleIds: () => graph.keys(),
      getModuleInfo: (id) => graph.get(id) ?? null,
    },
    { dir: path.join(inputs.output, inputs.source_namespace, 'packages/vite/dist') },
    {
      'index.js': {
        type: 'chunk',
        fileName: 'index.js',
        code: 'raw original chunk',
        modules: { [declarationId]: {} },
        map: null,
      },
    },
  );
  const selected = JSON.parse(await readFile(record, 'utf8'));
  expect(selected.inputs[inputs.source_namespace + '/packages/vite/package.json'].bytes).toBe(
    original.length,
  );
  expect(selected.inputs[inputs.source_namespace + '/packages/vite/package.json'].sha256).toBe(
    new Bun.CryptoHasher('sha256').update(original).digest('hex'),
  );
  expect(selected.modules[1].original).toBeNull();
  expect(selected.outputs['dist/index.js'].map).toBeNull();
  expect(selected.outputs['dist/index.js'].generated.bytes).toBe('raw original chunk'.length);
  expect(
    await readFile(
      inputs.original_files['original/upstream/vite/packages/vite/package.json'] ?? 'missing',
    ),
  ).toEqual(original);
});

test('observer adds only diagnostic hooks while preserving original configuration options and plugins', async () => {
  const { root, inputs } = await fixture();
  const plugin = { name: 'original-plugin' };
  const output = { dir: 'dist', sourcemap: false, minify: { mangle: false } };
  const original = { input: 'src/index.ts', output, plugins: [plugin] };
  const observed = await observedViteConfiguration([original], inputs, root);
  if (!Array.isArray(observed)) throw new Error('Original array shape changed');
  expect(observed[0]?.output).toBe(output);
  expect(observed[0]?.input).toBe(original.input);
  expect(observed[0]?.plugins[0]).toBe(plugin);
  expect(original.plugins).toEqual([plugin]);
  expect(observed[0]?.plugins).toHaveLength(2);
  const singleton = observedViteConfiguration(original, inputs, root);
  expect(Array.isArray(singleton)).toBe(false);
});

test('observer refuses a selected package member whose original File escaped its declared tree', async () => {
  const { root, inputs } = await fixture();
  await materializeViteBuild(inputs);
  const original = inputs.original_files['original/stores/typescript'];
  if (!original) throw new Error('fixture original store missing');
  const foreign = await file(root, 'foreign.ts', 'foreign bytes');
  await symlink(foreign, path.join(original, 'foreign.ts'));
  const id = path.join(inputs.output, 'stores/typescript/foreign.ts');
  const plugin = observeViteSourceBuild(inputs, path.join(root, 'observed.json'));
  await expect(
    plugin.generateBundle.call(
      {
        getModuleIds: () => [id],
        getModuleInfo: () => ({
          id,
          isExternal: false,
          importedIds: [],
          dynamicallyImportedIds: [],
          code: 'foreign bytes',
        }),
      },
      { dir: path.join(inputs.output, inputs.source_namespace, 'packages/vite/dist') },
      {},
    ),
  ).rejects.toThrow('escaped its original declared tree');
  expect(await readFile(foreign, 'utf8')).toBe('foreign bytes');
});

test('diagnostic join retains actual output bytes and causal tool facts without claiming runtime completion', async () => {
  const { root, inputs } = await fixture();
  const prepared = await materializeViteBuild(inputs);
  const emitted = path.join(prepared.packageRoot, 'dist/index.js');
  await mkdir(path.dirname(emitted), { recursive: true });
  await writeFile(emitted, 'actual final compiler bytes');
  await writeFile(path.join(prepared.packageRoot, 'dist/__proto__'), 'unmatched real artifact');
  const directory = path.join(inputs.output, '.merkur-source-selection/rolldown.config.ts');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, '0.json'),
    JSON.stringify({
      inputs: {},
      modules: [],
      outputs: {
        'dist/index.js': {
          type: 'chunk',
          generated: { bytes: 1, sha256: 'compiler metadata fact' },
        },
      },
    }),
  );
  await retainSourceSelection(inputs, prepared.packageRoot);
  const selection = JSON.parse(await readFile(inputs.selection, 'utf8'));
  expect(selection.artifacts['dist/index.js'].bytes).toBe('actual final compiler bytes'.length);
  expect(selection.artifacts['dist/index.js'].sha256).toBe(
    new Bun.CryptoHasher('sha256').update('actual final compiler bytes').digest('hex'),
  );
  expect(selection.outputs['dist/index.js'].generated.bytes).toBe(1);
  expect(selection.artifacts['dist/__proto__'].bytes).toBe('unmatched real artifact'.length);
  expect(selection.unmatched_artifacts).toEqual(['dist/__proto__']);
  expect(selection.build_tool.version).toBe('1.2.4');
  expect(selection.build_tool.compiler_context.sha256).toBe(
    new Bun.CryptoHasher('sha256').update(await readFile(inputs.compiler_context)).digest('hex'),
  );
  expect(selection.pending).toHaveLength(2);
  expect(Object.hasOwn(selection, 'runtime')).toBe(false);
  const second = path.join(root, 'missing-selection.json');
  await writeFile(
    path.join(directory, '0.json'),
    JSON.stringify({ inputs: {}, modules: [], outputs: { 'dist/missing.js': {} } }),
  );
  await expect(
    retainSourceSelection({ ...inputs, selection: second }, prepared.packageRoot),
  ).rejects.toThrow('missing its actual emitted member');
  await expect(readFile(second)).rejects.toThrow();
});

test('observer keeps output.file entry and asset facts distinct across genuine output invocations', async () => {
  const { root, inputs } = await fixture();
  const prepared = await materializeViteBuild(inputs);
  const record = path.join(root, 'multiple-observation.json');
  const plugin = observeViteSourceBuild(inputs, record);
  const context = { getModuleIds: () => [], getModuleInfo: () => null };
  const bundle = {
    'index.js': {
      type: 'chunk' as const,
      fileName: 'index.js',
      code: 'original entry',
      modules: {},
      map: null,
    },
    'extra.txt': {
      type: 'asset' as const,
      fileName: 'extra.txt',
      source: 'original asset',
      originalFileNames: [],
    },
  };
  await plugin.generateBundle.call(
    context,
    { file: path.join(prepared.packageRoot, 'dist/index.js') },
    bundle,
  );
  const first = await readFile(record);
  const firstFacts = JSON.parse(first.toString());
  expect(Object.keys(firstFacts.outputs).sort()).toEqual(['dist/extra.txt', 'dist/index.js']);
  expect(firstFacts.outputs['dist/index.js'].type).toBe('chunk');
  expect(firstFacts.outputs['dist/extra.txt'].type).toBe('asset');
  await plugin.generateBundle.call(
    context,
    { dir: path.join(prepared.packageRoot, 'dist-other') },
    bundle,
  );
  const secondFacts = JSON.parse(await readFile(record + '.1.json', 'utf8'));
  expect(Object.keys(secondFacts.outputs).sort()).toEqual([
    'dist-other/extra.txt',
    'dist-other/index.js',
  ]);
  expect(await readFile(record)).toEqual(first);
});

test('output parity compares complete emitted paths and actual byte facts', () => {
  const fact = (bytes: string) => ({
    bytes: Buffer.byteLength(bytes),
    sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
  });
  const original = { 'dist/node/index.js': fact('entry'), 'dist/node/index.d.ts': fact('types') };
  expect(() => requireViteOutputParity(original, { ...original })).not.toThrow();
  expect(() =>
    requireViteOutputParity(original, { 'dist/node/index.js': original['dist/node/index.js'] }),
  ).toThrow('output paths differ');
  expect(() =>
    requireViteOutputParity(original, { ...original, 'dist/extra.js': fact('extra') }),
  ).toThrow('output paths differ');
  expect(() =>
    requireViteOutputParity(original, { ...original, 'dist/node/index.js': fact('other') }),
  ).toThrow('output bytes differ');
  expect(() => requireViteOutputParity({}, {})).toThrow('requires emitted dist artifacts');
});

test('parity join keeps unresolved native/runtime custody mandatory and refuses changed final bytes', async () => {
  const { inputs } = await fixture();
  const prepared = await materializeViteBuild(inputs);
  const emitted = path.join(prepared.packageRoot, 'dist/index.js');
  await mkdir(path.dirname(emitted), { recursive: true });
  await writeFile(emitted, 'actual final fixture bytes');
  const original = {
    'dist/index.js': {
      bytes: Buffer.byteLength('actual final fixture bytes'),
      sha256: new Bun.CryptoHasher('sha256').update('actual final fixture bytes').digest('hex'),
    },
  };
  const records = path.join(inputs.output, '.merkur-source-selection/rolldown.config.ts');
  await mkdir(records, { recursive: true });
  await writeFile(
    path.join(records, '0.json'),
    JSON.stringify({ inputs: {}, modules: [], outputs: {} }),
  );
  await retainSourceSelection(inputs, prepared.packageRoot, original);
  const selection = JSON.parse(await readFile(inputs.selection, 'utf8'));
  expect(selection.output_parity).toBe('qualified');
  expect(selection.original_artifacts).toEqual(original);
  expect(selection.artifacts).toEqual(original);
  expect(selection.pending).toContain('Native/generated source custody remains unqualified');
  expect(selection.pending).toContain(
    'Shipped frontend runtime Files are not joined by this causal source-build observation',
  );
  expect(Object.hasOwn(selection, 'runtime')).toBe(false);
  await writeFile(emitted, 'changed final fixture bytes');
  const rejected = `${inputs.selection}.rejected`;
  await expect(
    retainSourceSelection({ ...inputs, selection: rejected }, prepared.packageRoot, original),
  ).rejects.toThrow('output bytes differ');
  await expect(readFile(rejected)).rejects.toThrow();
});
