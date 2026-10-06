import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type GlueInputs,
  materializeGlueInputs,
  publishRolldownGlue,
  requireTypeRecords,
  workspaceSelfLink,
} from './rolldown-glue';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merkur-glue-control-'));
  roots.push(root);
  const source = path.join(root, 'source');
  const cli = path.join(root, 'original-cli');
  const dependency = path.join(root, 'original-dependency');
  await mkdir(source);
  await mkdir(cli);
  await mkdir(dependency);
  await writeFile(path.join(source, 'original.ts'), 'export const value = 1;');
  await writeFile(
    path.join(cli, 'package.json'),
    JSON.stringify({ name: '@napi-rs/cli', version: '3.8.6' }),
  );
  await writeFile(path.join(dependency, 'value.js'), 'export const singleton = {};');
  const declarations = {
    'node_modules/.store/cli': {
      input: '_main/cli',
      link: true,
      owner: '//dependencies:cli',
      canonical: 'node_modules/.store/cli',
    },
    'node_modules/.store/dependency': {
      input: '_main/dependency',
      link: true,
      owner: '//dependencies:dependency',
      canonical: 'node_modules/.store/dependency',
    },
    'upstream/node_modules/dependency': {
      input: '_main/alias',
      link: true,
      owner: '//dependencies:alias',
      canonical: 'node_modules/.store/dependency',
    },
  };
  const manifest = path.join(root, 'declarations.json');
  await writeFile(manifest, JSON.stringify(declarations));
  const inputs: GlueInputs = {
    sources: source,
    native: path.join(root, 'native.node'),
    type_defs: path.join(root, 'types.jsonl'),
    compiler_context: path.join(root, 'context.json'),
    platform: 'aarch64-apple-darwin',
    declarations: manifest,
    original_files: { '_main/cli': cli, '_main/dependency': dependency, '_main/alias': dependency },
    dependency_namespace: 'upstream',
    napi_cli: '_main/cli',
    workspace_source: {
      input: '_main/workspace-source',
      owner: '@@original//packages/rolldown:npm_package',
      namespace: 'upstream/original/packages/rolldown',
      canonical: 'upstream/original/node_modules/workspace-store',
    },
    node: '/declared/node',
    output: path.join(root, 'output'),
    generated_declarations: path.join(root, 'generated.d.cts'),
  };
  return { root, inputs, declarations };
}

test('original source and canonical dependency aliases are private physical copies', async () => {
  const { root, inputs } = await fixture();
  const directory = path.join(root, 'work');
  const { workspace } = await materializeGlueInputs(inputs, directory);
  expect(await readFile(path.join(workspace, 'original.ts'), 'utf8')).toBe(
    'export const value = 1;',
  );
  const canonical = path.join(directory, 'node_modules/.store/dependency/value.js');
  const alias = path.join(workspace, 'node_modules/dependency/value.js');
  expect(await readFile(alias, 'utf8')).toBe(await readFile(canonical, 'utf8'));
  await writeFile(canonical, 'private changed bytes');
  expect(
    await readFile(path.join(inputs.original_files['_main/dependency'] ?? '', 'value.js'), 'utf8'),
  ).toBe('export const singleton = {};');
});

test('missing original dependency refuses despite an adjacent package with the same bytes', async () => {
  const { root, inputs } = await fixture();
  delete inputs.original_files['_main/dependency'];
  await expect(materializeGlueInputs(inputs, path.join(root, 'work'))).rejects.toThrow(
    'original declared File',
  );
});

test('read-only original package trees remain unchanged while their private copies can be removed', async () => {
  const { root, inputs } = await fixture();
  const original = inputs.original_files['_main/dependency'];
  if (original === undefined) throw new Error('Fixture has no original dependency');
  await mkdir(path.join(original, 'nested'));
  await writeFile(path.join(original, 'nested/member'), 'declared');
  await chmod(path.join(original, 'nested'), 0o555);
  await chmod(original, 0o555);
  const directory = path.join(root, 'work');
  const canonical = path.join(directory, 'node_modules/.store/dependency');
  try {
    await materializeGlueInputs(inputs, directory);
    expect((await stat(original)).mode & 0o777).toBe(0o555);
    expect((await stat(path.join(original, 'nested'))).mode & 0o777).toBe(0o555);
    await rm(canonical, { recursive: true });
  } finally {
    await chmod(original, 0o755);
    await chmod(path.join(original, 'nested'), 0o755);
    if (await Bun.file(path.join(canonical, 'nested/member')).exists()) {
      await chmod(canonical, 0o755);
      await chmod(path.join(canonical, 'nested'), 0o755);
    }
  }
});

test('old declarations and escaped canonical destinations refuse', async () => {
  const { root, inputs, declarations } = await fixture();
  const first = declarations['node_modules/.store/cli'];
  const { canonical: _canonical, ...old } = first;
  await writeFile(inputs.declarations, JSON.stringify({ cli: old }));
  await expect(materializeGlueInputs(inputs, path.join(root, 'old'))).rejects.toThrow('four-field');
  await writeFile(
    inputs.declarations,
    JSON.stringify({ cli: { ...first, canonical: '../outside' } }),
  );
  await expect(materializeGlueInputs(inputs, path.join(root, 'escaped'))).rejects.toThrow(
    'closed declared logical',
  );
});

test('source collision and noncanonical CLI alias cannot substitute original generator', async () => {
  const { root, inputs, declarations } = await fixture();
  await writeFile(
    inputs.declarations,
    JSON.stringify({
      ...declarations,
      'upstream/original.ts': {
        input: '_main/dependency',
        owner: '//dependencies:foreign',
        link: false,
        canonical: 'upstream/original.ts',
      },
    }),
  );
  await expect(materializeGlueInputs(inputs, path.join(root, 'collision'))).rejects.toThrow();
  await writeFile(inputs.declarations, JSON.stringify(declarations));
  inputs.napi_cli = '_main/alias';
  await expect(materializeGlueInputs(inputs, path.join(root, 'alias'))).rejects.toThrow(
    'original canonical npm package',
  );
});

test('empty and malformed compiler records refuse; ordinary engine carrier retains JSONL', async () => {
  const { root, inputs } = await fixture();
  await writeFile(inputs.type_defs, '');
  await expect(requireTypeRecords(inputs.type_defs)).rejects.toThrow('empty');
  await writeFile(inputs.type_defs, '{"kind":"struct","name":"BindingModuleInfo"}\n');
  await expect(requireTypeRecords(inputs.type_defs)).rejects.toThrow('malformed');
  await writeFile(
    inputs.type_defs,
    '{"kind":"struct","name":"BindingModuleInfo","def":"readonly id: string"}\n',
  );
  const carrier = path.join(root, 'carrier.jsonl');
  await symlink(inputs.type_defs, carrier);
  await requireTypeRecords(carrier);
  expect(await readFile(inputs.type_defs, 'utf8')).toBe(
    '{"kind":"struct","name":"BindingModuleInfo","def":"readonly id: string"}\n',
  );
});

test('publication retains package member bytes in an engine-precreated empty directory', async () => {
  const { root, inputs } = await fixture();
  const packageRoot = path.join(root, 'built-package');
  await mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  await mkdir(path.join(packageRoot, 'src'));
  const files = {
    'dist/index.mjs': 'export const value = 1;\n',
    'dist/member.bin': new Uint8Array([0, 255, 13, 10]),
    'package.json': '{"name":"rolldown","version":"1.2.5"}\n',
    'src/binding.d.cts': 'export declare const value: number;\n',
  };
  for (const [relative, bytes] of Object.entries(files))
    await writeFile(path.join(packageRoot, relative), bytes);
  await mkdir(inputs.output);
  await publishRolldownGlue(packageRoot, inputs.output, inputs.generated_declarations);
  for (const relative of ['dist/index.mjs', 'dist/member.bin', 'package.json'])
    expect(await readFile(path.join(inputs.output, relative))).toEqual(
      await readFile(path.join(packageRoot, relative)),
    );
  expect(await readFile(inputs.generated_declarations)).toEqual(
    await readFile(path.join(packageRoot, 'src/binding.d.cts')),
  );
  await expect(
    publishRolldownGlue(packageRoot, inputs.output, inputs.generated_declarations),
  ).rejects.toThrow('empty ordinary output');
  const alias = path.join(root, 'outside-alias');
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, alias);
  await expect(
    publishRolldownGlue(packageRoot, alias, inputs.generated_declarations),
  ).rejects.toThrow('empty ordinary output');
  expect(await Bun.file(path.join(outside, 'package.json')).exists()).toBe(false);
});

async function workspaceFixture() {
  const fixtureInputs = await fixture();
  const { root, inputs, declarations } = fixtureInputs;
  inputs.dependency_namespace = 'upstream/original';
  const sourcePackage = path.join(inputs.sources, 'packages/rolldown');
  await mkdir(path.join(sourcePackage, 'src'), { recursive: true });
  await writeFile(path.join(sourcePackage, 'src/binding.cjs'), 'original source binding');
  await writeFile(
    path.join(inputs.sources, 'pnpm-lock.yaml'),
    "importers:\n  packages/rolldown:\n    devDependencies:\n      rolldown:\n        specifier: workspace:*\n        version: 'link:'\n",
  );
  const store = path.join(root, 'original-workspace-store');
  await mkdir(path.join(store, 'src'), { recursive: true });
  await writeFile(path.join(store, 'src/binding.cjs'), 'original copied binding');
  inputs.original_files['_main/workspace-source'] = sourcePackage;
  inputs.original_files['_main/workspace-store'] = store;
  const originalAlias = path.join(root, 'original-workspace-self');
  await symlink(store, originalAlias);
  inputs.original_files['_main/workspace-self'] = originalAlias;
  const canonical = inputs.workspace_source.canonical;
  const self = `${inputs.workspace_source.namespace}/node_modules/rolldown`;
  await writeFile(
    inputs.declarations,
    JSON.stringify({
      ...declarations,
      [canonical]: {
        input: '_main/workspace-store',
        link: true,
        owner: '@@original//:.aspect_rules_js/node_modules/rolldown@0.0.0',
        canonical,
      },
      [self]: {
        input: '_main/workspace-self',
        link: true,
        owner: '@@original//packages/rolldown:node_modules/rolldown',
        canonical,
      },
    }),
  );
  const directory = path.join(root, 'work');
  const { workspace } = await materializeGlueInputs(inputs, directory);
  return {
    root,
    inputs,
    directory,
    workspace,
    packageRoot: path.join(workspace, 'packages/rolldown'),
  };
}

test('declared original workspace self-link rebinds to authored generated binding only', async () => {
  const { inputs, workspace, packageRoot, directory } = await workspaceFixture();
  const self = path.join(packageRoot, 'node_modules/rolldown/src/binding.cjs');
  expect(await readFile(self, 'utf8')).toBe('original copied binding');
  await workspaceSelfLink(workspace, inputs);
  await writeFile(path.join(packageRoot, 'src/binding.cjs'), 'same-build generated binding');
  expect(await readFile(self, 'utf8')).toBe('same-build generated binding');
  expect(
    await readFile(
      path.join(directory, inputs.workspace_source.canonical, 'src/binding.cjs'),
      'utf8',
    ),
  ).toBe('original copied binding');
  expect(
    await readFile(
      path.join(inputs.original_files['_main/workspace-source'] ?? '', 'src/binding.cjs'),
      'utf8',
    ),
  ).toBe('original source binding');
});

test('foreign self-link replacement is refused without unlinking foreign authority', async () => {
  const { root, inputs, workspace, packageRoot } = await workspaceFixture();
  const destination = path.join(packageRoot, 'node_modules/rolldown');
  const foreign = path.join(root, 'foreign-package');
  await mkdir(foreign);
  await rm(destination);
  await symlink(foreign, destination);
  await expect(workspaceSelfLink(workspace, inputs)).rejects.toThrow('materialized original');
  expect((await stat(destination)).ino).toBe((await stat(foreign)).ino);
});

test('changed source owner, namespace or copied-package relation cannot authorize a self-link', async () => {
  for (const changes of [
    { owner: '@@foreign//packages/rolldown:npm_package' },
    { namespace: 'upstream/original/packages/foreign' },
    { canonical: 'upstream/original/node_modules/foreign-package' },
  ]) {
    const { inputs, workspace, packageRoot } = await workspaceFixture();
    inputs.workspace_source = { ...inputs.workspace_source, ...changes };
    await expect(workspaceSelfLink(workspace, inputs)).rejects.toThrow();
    expect(
      await readFile(path.join(packageRoot, 'node_modules/rolldown/src/binding.cjs'), 'utf8'),
    ).toBe('original copied binding');
  }
});

test('missing declared self-link and ordinary directory replacement refuse before mutation', async () => {
  for (const replacement of ['missing', 'directory']) {
    const { inputs, workspace, packageRoot } = await workspaceFixture();
    const destination = path.join(packageRoot, 'node_modules/rolldown');
    await rm(destination);
    if (replacement === 'directory') await mkdir(destination);
    await expect(workspaceSelfLink(workspace, inputs)).rejects.toThrow();
  }
});

test('changed original workspace lock refuses despite a declared exact copied package', async () => {
  const { inputs, workspace, packageRoot } = await workspaceFixture();
  await writeFile(
    path.join(workspace, 'pnpm-lock.yaml'),
    "importers:\n  packages/rolldown:\n    devDependencies:\n      rolldown:\n        specifier: workspace:*\n        version: 'link:../foreign'\n",
  );
  await expect(workspaceSelfLink(workspace, inputs)).rejects.toThrow('original lock');
  expect(
    await readFile(path.join(packageRoot, 'node_modules/rolldown/src/binding.cjs'), 'utf8'),
  ).toBe('original copied binding');
});
