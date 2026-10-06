import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function makeWritableIfPresent(directory: string): Promise<void> {
  try {
    await chmod(directory, 0o755);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}

async function relocatedPackageFixture(root: string) {
  const one = 'node_modules/.aspect_rules_js/one@1.0.0/node_modules/one';
  const parent = 'node_modules/.aspect_rules_js/parent@1.0.0/node_modules/parent';
  const workspace = 'packages/workspace';
  const declarations: Record<
    string,
    { input: string; link: boolean; owner: string; canonical: string }
  > = {};
  const authored = {
    'entry.ts':
      'import { token } from "one"; import { token as parent } from "parent"; import { token as workspace } from "workspace"; console.log(token === parent && token === workspace);',
    'bunfig.toml': '',
    'packages/workspace/package.json':
      '{"name":"workspace","type":"module","exports":"./index.ts"}',
    'packages/workspace/index.ts': 'export { token } from "one";',
  };
  for (const [logical, bytes] of Object.entries(authored)) {
    const input = path.join(root, 'original', logical);
    await mkdir(path.dirname(input), { recursive: true });
    await writeFile(input, bytes);
    declarations[logical] = {
      input,
      link: false,
      owner: `//fixture:${logical}`,
      canonical: logical,
    };
  }
  for (const [logical, name, source] of [
    [one, 'one', 'export const token = {};'],
    [parent, 'parent', 'export { token } from "one";'],
  ]) {
    if (logical === undefined || name === undefined || source === undefined)
      throw new Error('Package fixture disappeared');
    const input = path.join(root, 'original', logical);
    await mkdir(input, { recursive: true });
    await writeFile(
      path.join(input, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './index.js' }),
    );
    await writeFile(path.join(input, 'index.js'), source);
    declarations[logical] = { input, link: true, owner: `@npm//:${name}`, canonical: logical };
  }
  const aliases = {
    'node_modules/one': one,
    'node_modules/parent': parent,
    'node_modules/.aspect_rules_js/parent@1.0.0/node_modules/one': one,
    'node_modules/workspace': workspace,
    'node_modules/.aspect_rules_js/workspace@0.0.0/node_modules/workspace': workspace,
    'packages/workspace/node_modules/one': one,
  };
  for (const [logical, canonical] of Object.entries(aliases)) {
    const input = path.join(root, 'original', logical);
    await mkdir(path.dirname(input), { recursive: true });
    await symlink(path.join(root, 'original', canonical), input);
    declarations[logical] = { input, link: true, owner: `//fixture:${logical}`, canonical };
  }
  await writeFile(
    path.join(root, 'original/packages/workspace/ambient.ts'),
    'export const outside = true;',
  );
  const manifest = path.join(root, 'inputs.json');
  await writeFile(manifest, JSON.stringify(declarations));
  return { root, manifest };
}

async function bundleRelocatedFixture(fixture: { root: string; manifest: string }) {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-install',
      '--no-env-file',
      `--config=${path.join(fixture.root, 'original/bunfig.toml')}`,
      new URL('./build.ts', import.meta.url).pathname,
      fixture.manifest,
      'bundle',
      'entry.ts',
      path.join(fixture.root, 'bundle'),
      'bunfig.toml',
      '--root=.',
      '--metafile=inventory.json',
    ],
    { cwd: fixture.root, stdout: 'pipe', stderr: 'pipe' },
  );
  const [status, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { status, stderr };
}

test('bundle bytes and selected original facts survive relocated typed npm aliases without workspace ambient files', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'bundle-relocation-'));
  try {
    const first = await relocatedPackageFixture(path.join(scratch, 'first-execroot'));
    const second = await relocatedPackageFixture(path.join(scratch, 'different-second-execroot'));
    for (const fixture of [first, second]) {
      expect(await bundleRelocatedFixture(fixture)).toEqual({ status: 0, stderr: '' });
      const child = Bun.spawn(
        [
          process.execPath,
          '--no-install',
          '--no-env-file',
          `--config=${path.join(fixture.root, 'original/bunfig.toml')}`,
          path.join(fixture.root, 'bundle/entry.js'),
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: 'true\n', stderr: '' });
    }
    const firstBytes = await readFile(path.join(first.root, 'bundle/entry.js'));
    const secondBytes = await readFile(path.join(second.root, 'bundle/entry.js'));
    expect(firstBytes.equals(secondBytes)).toBe(true);
    const firstInventory = JSON.parse(
      await readFile(path.join(first.root, 'inventory.json'), 'utf8'),
    );
    const secondInventory = JSON.parse(
      await readFile(path.join(second.root, 'inventory.json'), 'utf8'),
    );
    expect(firstInventory).toEqual(secondInventory);
    expect(Object.keys(firstInventory.inputs).sort()).toEqual(
      [
        'entry.ts',
        'packages/workspace/index.ts',
        'node_modules/.aspect_rules_js/one@1.0.0/node_modules/one/index.js',
        'node_modules/.aspect_rules_js/parent@1.0.0/node_modules/parent/index.js',
      ].sort(),
    );
    expect(firstBytes.toString()).not.toContain(scratch);
    await writeFile(
      path.join(first.root, 'original/packages/workspace/index.ts'),
      'export { outside } from "./ambient"; export { token } from "one";',
    );
    const failed = await bundleRelocatedFixture(first);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('Could not resolve: "./ambient"');
    expect(await readFile(path.join(first.root, 'bundle/entry.js'))).toEqual(firstBytes);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('migration bundles retain selected input and nested output facts outside the copied tree', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'migration-bundle-'));
  try {
    await mkdir(path.join(scratch, 'migrations/nested'), { recursive: true });
    const files = {
      'migrations/a.ts': 'import { value } from "./shared"; export default value;',
      'migrations/nested/b.ts': 'import { value } from "../shared"; export default value + "b";',
      'migrations/shared.ts': 'export const value = "migration";',
      'migrations/unused.ts': 'export const unused = "unused";',
      'bunfig.toml': '',
    };
    for (const [name, content] of Object.entries(files))
      await writeFile(path.join(scratch, name), content);
    const manifest = path.join(scratch, 'inputs.json');
    await writeFile(
      manifest,
      JSON.stringify(
        Object.fromEntries(
          Object.keys(files).map((name) => [
            name,
            {
              input: path.join(scratch, name),
              link: false,
              owner: `//fixture:${name}`,
              canonical: name,
            },
          ]),
        ),
      ),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        '--no-env-file',
        `--config=${path.join(scratch, 'bunfig.toml')}`,
        new URL('./build.ts', import.meta.url).pathname,
        manifest,
        'bundle',
        'migrations/a.ts',
        path.join(scratch, 'bundle'),
        'bunfig.toml',
        'migrations/nested/b.ts',
        '--root=migrations',
        '--metafile=inventory.json',
      ],
      { cwd: scratch, stdout: 'pipe', stderr: 'pipe' },
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
    expect(stdout).toContain('a.js');
    const inventory = JSON.parse(await readFile(path.join(scratch, 'inventory.json'), 'utf8'));
    expect(Object.keys(inventory.inputs)).toEqual([
      'migrations/a.ts',
      'migrations/nested/b.ts',
      'migrations/shared.ts',
    ]);
    expect(Object.keys(inventory.outputs)).toEqual(['a.js', 'nested/b.js']);
    expect(inventory.inputs['migrations/shared.ts'].owner).toBe('//fixture:migrations/shared.ts');
    for (const [name, facts] of Object.entries(inventory.artifacts)) {
      const content = await readFile(path.join(scratch, 'bundle', name));
      expect(facts).toMatchObject({
        bytes: content.byteLength,
        sha256: new Bun.CryptoHasher('sha256').update(content).digest('hex'),
      });
    }
    expect(JSON.stringify(inventory)).not.toContain(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('compilation resolves only ordinary copied first-party files even beside ambient sources', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'build-isolation-'));
  try {
    const entry = path.join(scratch, 'entry.ts');
    const declared = path.join(scratch, 'declared.ts');
    const ambient = path.join(scratch, 'ambient.ts');
    const config = path.join(scratch, 'bunfig.toml');
    const manifest = path.join(scratch, 'inputs.json');
    const output = path.join(scratch, 'compiled');
    const inventoryFile = path.join(scratch, 'compiler.json');
    await writeFile(config, '');
    await writeFile(declared, 'export const value = "DECLARED_SOURCE";');
    const readOnlyTree = path.join(scratch, 'readonly');
    await mkdir(readOnlyTree);
    await writeFile(
      path.join(readOnlyTree, 'declared.ts'),
      'export const extra = "_READONLY_TREE";',
    );
    await chmod(readOnlyTree, 0o555);
    await writeFile(ambient, 'export const value = "AMBIENT_SOURCE";');
    await writeFile(
      manifest,
      JSON.stringify({
        'entry.ts': {
          input: entry,
          link: false,
          owner: '//fixture:entry.ts',
          canonical: 'entry.ts',
        },
        'declared.ts': {
          input: declared,
          link: false,
          owner: '//fixture:declared.ts',
          canonical: 'declared.ts',
        },
        readonly: {
          input: readOnlyTree,
          link: false,
          owner: '//fixture:readonly',
          canonical: 'readonly',
        },
        'bunfig.toml': {
          input: config,
          link: false,
          owner: '//fixture:bunfig.toml',
          canonical: 'bunfig.toml',
        },
      }),
    );
    async function compile() {
      const child = Bun.spawn(
        [
          process.execPath,
          '--no-env-file',
          `--config=${config}`,
          new URL('./build.ts', import.meta.url).pathname,
          manifest,
          'compile',
          'entry.ts',
          output,
          'bunfig.toml',
          `--target=bun-${process.platform}-${process.arch}`,
          `--compile-executable-path=${process.execPath}`,
          `--metafile=${inventoryFile}`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { status, stdout, stderr };
    }
    await writeFile(
      entry,
      'import { value } from "./declared"; import { extra } from "./readonly/declared"; process.stdout.write(value + extra);',
    );
    expect((await compile()).status).toBe(0);
    const inventory = JSON.parse(await readFile(inventoryFile, 'utf8'));
    const emitted = await readFile(output);
    expect(Object.keys(inventory.artifacts)).toEqual(['compiled']);
    expect(inventory.artifacts.compiled).toEqual({
      bytes: emitted.byteLength,
      sha256: new Bun.CryptoHasher('sha256').update(emitted).digest('hex'),
    });
    expect(inventory.artifacts.compiled.bytes).toBeGreaterThan(inventory.outputs.compiled.bytes);
    const executable = Bun.spawn([output], { stdout: 'pipe', stderr: 'pipe' });
    expect(await new Response(executable.stdout).text()).toBe('DECLARED_SOURCE_READONLY_TREE');
    expect((await stat(readOnlyTree)).mode & 0o777).toBe(0o555);
    expect(await executable.exited).toBe(0);
    // Previous output and a real adjacent ambient module must not authorize an import.
    expect((await readFile(output)).byteLength).toBeGreaterThan(0);
    await writeFile(entry, 'import { value } from "./ambient"; process.stdout.write(value);');
    const rejected = await compile();
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('./ambient');
  } finally {
    const readOnlyTree = path.join(scratch, 'readonly');
    await makeWritableIfPresent(readOnlyTree);
    await rm(scratch, { recursive: true, force: true });
  }
});

async function makeViteFixture(scratch: string) {
  const declaredInputs = process.env.MERKUR_VITE_BUILD_INPUTS;
  const runfilesRoot = process.env.MERKUR_BAZEL_RUNFILES_ROOT;
  if (declaredInputs === undefined || runfilesRoot === undefined)
    throw new Error('Vite isolation requires its declared typed build inputs and runfiles root');
  const closure: Record<
    string,
    { input: string; link: boolean; owner: string; canonical: string }
  > = JSON.parse(await readFile(declaredInputs, 'utf8'));
  const project = path.join(scratch, 'web');
  await mkdir(project);
  const files = {
    'apps/web/index.html': path.join(project, 'index.html'),
    'apps/web/vite.config.ts': path.join(project, 'vite.config.ts'),
    'apps/web/main.ts': path.join(project, 'main.ts'),
    'apps/web/declared.ts': path.join(project, 'declared.ts'),
    'bunfig.toml': path.join(scratch, 'bunfig.toml'),
    'apps/web/public/nested/declared.txt': path.join(project, 'public/nested/declared.txt'),
  };
  await mkdir(path.dirname(files['apps/web/public/nested/declared.txt']), { recursive: true });
  await writeFile(files['apps/web/public/nested/declared.txt'], 'DECLARED_PUBLIC_BYTES\n');
  await writeFile(files['bunfig.toml'], '');
  await writeFile(files['apps/web/main.ts'], 'document.body.textContent = "declared-vite-source";');
  await writeFile(files['apps/web/index.html'], '<script type="module" src="/main.ts"></script>');
  await writeFile(files['apps/web/vite.config.ts'], 'export default {};');
  await writeFile(files['apps/web/declared.ts'], 'export const value = "declared-vite-source";');
  await writeFile(path.join(project, 'ambient.ts'), 'export const value = "ambient-vite-source";');
  const manifest = path.join(scratch, 'inputs.json');
  const output = path.join(scratch, 'dist');
  const selection = path.join(scratch, 'frontend-selection.json');
  await writeFile(
    manifest,
    JSON.stringify({
      ...Object.fromEntries(
        Object.entries(closure).map(([relative, entry]) => [
          relative,
          { ...entry, input: path.join(runfilesRoot, entry.input) },
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(files).map(([relative, input]) => [
          relative,
          { input, link: false, owner: `//fixture:${relative}`, canonical: relative },
        ]),
      ),
    }),
  );
  async function build() {
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        '--no-env-file',
        `--config=${files['bunfig.toml']}`,
        new URL('./build.ts', import.meta.url).pathname,
        manifest,
        'vite',
        'tools/bazel/bun/vite-build.ts',
        output,
        'bunfig.toml',
        'apps/web',
        '11111111-1111-4111-8111-111111111111',
        '',
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'dev',
        '',
        selection,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [status, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    return { status, stderr };
  }
  return { project, files, output, selection, build };
}

test('Vite rejects an undeclared source beside the previous successful bundle', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'vite-isolation-'));
  try {
    const { files, output, build } = await makeViteFixture(scratch);
    await writeFile(
      files['apps/web/main.ts'],
      'import { value } from "./declared"; document.body.textContent = value;',
    );
    const accepted = await build();
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(await readFile(path.join(output, 'index.html'), 'utf8')).toContain('script');
    expect(await readFile(path.join(output, 'nested/declared.txt'), 'utf8')).toBe(
      'DECLARED_PUBLIC_BYTES\n',
    );
    await writeFile(
      files['apps/web/main.ts'],
      'import { value } from "./ambient"; document.body.textContent = value;',
    );
    const rejected = await build();
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('./ambient');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('Vite retains selected original modules, worker, CSS, assets and public output bytes', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'vite-source-selection-'));
  try {
    const fixture = await makeViteFixture(scratch);
    const manifestFile = path.join(scratch, 'inputs.json');
    const declarations = JSON.parse(await readFile(manifestFile, 'utf8'));
    const additions = {
      'apps/web/worker.ts': 'import { value } from "./worker-value"; postMessage(value);',
      'apps/web/worker-value.ts': 'export const value = "worker-source-selected";',
      'apps/web/style.css': 'body { color: red; }',
      'apps/web/font.woff2': 'declared-raw-font-fixture-bytes',
    };
    for (const [relative, content] of Object.entries(additions)) {
      const input = path.join(fixture.project, path.basename(relative));
      await writeFile(input, content);
      declarations[relative] = {
        input,
        canonical: relative,
        owner: `//fixture:${relative}`,
        link: false,
      };
    }
    await writeFile(manifestFile, JSON.stringify(declarations));
    await writeFile(
      fixture.files['apps/web/main.ts'],
      'import "./style.css"; import { value } from "./declared"; new Worker(new URL("./worker.ts", import.meta.url),{type:"module"}); document.body.textContent=value;',
    );
    await writeFile(
      fixture.files['apps/web/vite.config.ts'],
      'import {readFileSync} from "node:fs";import {fileURLToPath} from "node:url";export default {plugins:[{name:"fixture-raw-font",generateBundle(){const original=fileURLToPath(new URL("./font.woff2",import.meta.url));this.emitFile({type:"asset",fileName:"font.woff2",originalFileName:original,source:readFileSync(original)})}}]};',
    );
    const result = await fixture.build();
    expect(result.status, result.stderr).toBe(0);
    const selected = JSON.parse(await readFile(fixture.selection, 'utf8'));
    for (const relative of [
      'apps/web/main.ts',
      'apps/web/declared.ts',
      'apps/web/worker.ts',
      'apps/web/worker-value.ts',
      'apps/web/style.css',
      'apps/web/font.woff2',
      'apps/web/public/nested/declared.txt',
    ]) {
      const original = await readFile(declarations[relative].input);
      expect(selected.inputs[relative].owner).toBe(`//fixture:${relative}`);
      expect(selected.inputs[relative].bytes).toBe(original.byteLength);
      expect(selected.inputs[relative].sha256).toBe(
        createHash('sha256').update(original).digest('hex'),
      );
    }
    expect(Object.keys(selected.outputs).sort()).toEqual(Object.keys(selected.artifacts).sort());
    for (const [relative, fact] of Object.entries(selected.artifacts) as [
      string,
      { bytes: number; sha256: string },
    ][]) {
      const raw = await readFile(path.join(fixture.output, relative));
      expect(fact.bytes).toBe(raw.byteLength);
      expect(fact.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
    }
    expect(selected.outputs['nested/declared.txt'].public_input).toBe(
      'apps/web/public/nested/declared.txt',
    );
    expect(
      Object.values(selected.outputs).some((output: unknown) =>
        JSON.stringify(output).includes('"environment":"worker"'),
      ),
    ).toBe(true);
    expect(
      selected.unmatched_generated_modules.some(
        (module: { source: string | null }) => module.source === null,
      ),
    ).toBe(true);
    expect(selected.unmatched_generated_assets.length).toBeGreaterThan(0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('Vite refuses external public directories and their ordinary directory aliases', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'vite-public-selection-'));
  try {
    const fixture = await makeViteFixture(scratch);
    const external = path.join(scratch, 'outside-public');
    const alias = path.join(scratch, 'alias/nested/public');
    await mkdir(external);
    await mkdir(path.dirname(alias), { recursive: true });
    await writeFile(path.join(external, 'external.txt'), 'UNDECLARED_PUBLIC_BYTES\n');
    await symlink(external, alias);
    for (const directory of [external, alias]) {
      await writeFile(
        fixture.files['apps/web/vite.config.ts'],
        `export default {publicDir:${JSON.stringify(directory)}};`,
      );
      const rejected = await fixture.build();
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('Vite publicDir escaped its declared materialization');
      expect(await Bun.file(path.join(fixture.output, 'external.txt')).exists()).toBe(false);
    }
    expect(await readFile(path.join(external, 'external.txt'), 'utf8')).toBe(
      'UNDECLARED_PUBLIC_BYTES\n',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('Vite checks the actual public copy selector after plugin mutations', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'vite-public-mutation-'));
  try {
    const fixture = await makeViteFixture(scratch);
    const external = path.join(scratch, 'outside-public');
    await mkdir(external);
    await writeFile(path.join(external, 'external.txt'), 'UNDECLARED_PUBLIC_BYTES\n');
    const mutations = [
      `selected.publicDir=${JSON.stringify(external)}`,
      `this.environment.config.publicDir=${JSON.stringify(external)}`,
      `symlinkSync(${JSON.stringify(external)}, selected.publicDir+'/nested/alias')`,
    ];
    for (const mutation of mutations) {
      await writeFile(
        fixture.files['apps/web/vite.config.ts'],
        `import {symlinkSync} from 'node:fs';let selected;export default {plugins:[{name:'fixture-public-copy-mutation',configResolved(config){selected=config},renderStart:{order:'pre',handler(){${mutation}}}}]};`,
      );
      const rejected = await fixture.build();
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('Vite publicDir escaped its declared materialization');
      expect(await Bun.file(path.join(fixture.output, 'external.txt')).exists()).toBe(false);
      expect(await Bun.file(path.join(fixture.output, 'nested/alias/external.txt')).exists()).toBe(
        false,
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
