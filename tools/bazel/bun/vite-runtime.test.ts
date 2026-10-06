import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeBunRuntime } from './runtime-materializer';
import { sourceBuiltViteModule } from './vite-runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'source Vite execution '));
  roots.push(root);
  const tooling = path.join(root, 'original tooling');
  const packageDirectory = 'upstream/original/packages/vite';
  const module = path.join(tooling, packageDirectory);
  mkdirSync(module, { recursive: true });
  writeFileSync(
    path.join(module, 'package.json'),
    JSON.stringify({
      name: 'vite',
      version: '8.2.2',
      type: 'module',
      exports: './index.js',
    }),
  );
  writeFileSync(
    path.join(module, 'index.js'),
    `
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const identity = 'actual declared source supplier';
export const defineConfig = (value) => value;
export async function build(options) {
  const config = (await import(pathToFileURL(options.configFile).href)).default;
  if (config.direct !== identity || config.peer !== identity) throw new Error('Foreign Vite alias executed');
  const selection = options.plugins.find((plugin) => plugin.name === 'merkur-frontend-source-selection');
  await selection.configResolved({
    worker: { plugins: async () => ({ environments: { client: { plugins: [] } } }) },
    publicDir: '', build: { write: false, copyPublicDir: false },
  });
  await mkdir(options.build.outDir, { recursive: true });
  const emitted = JSON.stringify({ direct: config.direct, peer: config.peer });
  await writeFile(path.join(options.build.outDir, 'index.html'), emitted);
  await selection.generateBundle.handler.call({}, {}, { 'index.html': { type: 'asset', source: emitted, originalFileNames: [] } });
}
`,
  );
  return { root, tooling, packageDirectory, module };
}

test('resolves the exact original-source package even with spaces', () => {
  const value = fixture();
  expect(sourceBuiltViteModule(value.module)).toBe(
    realpathSync(path.join(value.module, 'index.js')),
  );
});

test('refuses a different package version before execution', () => {
  const value = fixture();
  writeFileSync(
    path.join(value.module, 'package.json'),
    JSON.stringify({ name: 'vite', version: '8.2.1', exports: './index.js' }),
  );
  expect(() => sourceBuiltViteModule(value.module)).toThrow('original source-built8.2.2');
});

test('refuses resolution outside the original package', () => {
  const value = fixture();
  rmSync(path.join(value.module, 'package.json'));
  const foreign = path.join(value.root, 'node_modules/vite');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(
    path.join(foreign, 'package.json'),
    JSON.stringify({ name: 'vite', version: '8.2.2', exports: './index.js' }),
  );
  writeFileSync(path.join(foreign, 'index.js'), 'throw new Error("foreign supplier");');
  expect(() => sourceBuiltViteModule(value.module)).toThrow();
});

test('actual materializer and Vite runner execute supplied tooling for direct and peer imports', async () => {
  const value = fixture();
  const files: Record<string, { input: string; owner: string; link: boolean; canonical: string }> =
    {};
  const add = (logical: string, input: string, canonical = logical, link = false) => {
    files[logical] = { input, owner: '//fixture:original', canonical, link };
  };
  for (const name of [
    'build.ts',
    'vite-build.ts',
    'vite-runtime.ts',
    'frontend-source-provider.ts',
    'compiler-inventory.ts',
    'portable-path.ts',
    'empty-bunfig.toml',
  ])
    add(`tools/bazel/bun/${name}`, fileURLToPath(new URL(name, import.meta.url)));
  const runtimeRoot = 'tools/bazel/bun/vite-source-runtime';
  add(runtimeRoot, value.tooling);
  const old = path.join(value.root, 'unselected installed Vite');
  mkdirSync(old);
  writeFileSync(
    path.join(old, 'package.json'),
    JSON.stringify({ name: 'vite', version: '8.2.2', type: 'module', exports: './index.js' }),
  );
  writeFileSync(path.join(old, 'index.js'), 'throw new Error("Installed Vite must not execute");');
  // These are the exact four-field aliases redirected by the typed Starlark graph.
  add('node_modules/vite', old, `${runtimeRoot}/${value.packageDirectory}`, true);
  add('node_modules/peer/node_modules/vite', old, `${runtimeRoot}/${value.packageDirectory}`, true);
  const config = path.join(value.root, 'vite.config.ts');
  writeFileSync(
    config,
    "import { defineConfig, identity } from 'vite'; import { peer } from 'peer'; export default defineConfig({ direct: identity, peer });",
  );
  add('apps/web/vite.config.ts', config);
  const peer = path.join(value.root, 'peer');
  mkdirSync(peer);
  writeFileSync(
    path.join(peer, 'package.json'),
    JSON.stringify({ name: 'peer', type: 'module', exports: './index.js' }),
  );
  writeFileSync(
    path.join(peer, 'index.js'),
    "import { identity } from 'vite'; export const peer = identity;",
  );
  add('node_modules/peer/package.json', path.join(peer, 'package.json'));
  add('node_modules/peer/index.js', path.join(peer, 'index.js'));
  const manifest = path.join(value.root, 'inputs.json');
  writeFileSync(manifest, JSON.stringify(files));
  const output = path.join(value.root, 'frontend');
  const selection = path.join(value.root, 'selection.json');
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-install',
      '--no-env-file',
      `--config=${fileURLToPath(new URL('empty-bunfig.toml', import.meta.url))}`,
      fileURLToPath(new URL('build.ts', import.meta.url)),
      manifest,
      'vite',
      'tools/bazel/bun/vite-build.ts',
      output,
      'tools/bazel/bun/empty-bunfig.toml',
      'apps/web',
      '10000000-0000-0000-0000-000000000001',
      '',
      Buffer.alloc(32).toString('base64url'),
      'dev',
      '',
      selection,
      `${runtimeRoot}/${value.packageDirectory}`,
    ],
    { cwd: value.root, env: { PATH: '', TMPDIR: value.root }, stdout: 'pipe', stderr: 'pipe' },
  );
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
  expect(JSON.parse(readFileSync(path.join(output, 'index.html'), 'utf8'))).toEqual({
    direct: 'actual declared source supplier',
    peer: 'actual declared source supplier',
  });
  const retained = JSON.parse(readFileSync(selection, 'utf8'));
  expect(retained.unmatched_generated_assets).toHaveLength(1);
});

test('development materialization keeps direct and peer Vite imports on its copied supplier', async () => {
  const value = fixture();
  const runtime = path.join(value.root, 'development runtime');
  const original = path.join(value.root, 'original npm Vite');
  mkdirSync(original);
  writeFileSync(
    path.join(original, 'package.json'),
    JSON.stringify({ name: 'vite', type: 'module', exports: './index.js' }),
  );
  writeFileSync(
    path.join(original, 'index.js'),
    "export const identity = 'unselected installed supplier';",
  );
  const peer = path.join(value.root, 'original peer');
  mkdirSync(peer);
  writeFileSync(
    path.join(peer, 'package.json'),
    JSON.stringify({ name: 'peer', type: 'module', exports: './index.js' }),
  );
  writeFileSync(
    path.join(peer, 'index.js'),
    "import { identity } from 'vite'; export const peer = identity;",
  );
  const source = path.join(value.root, 'declared application.ts');
  writeFileSync(
    source,
    "import { identity } from 'vite'; import { peer } from 'peer'; process.stdout.write(JSON.stringify({ identity, peer }));",
  );
  const copiedPackage = `.merkur-dev/vite/${value.packageDirectory}`;
  const files = {
    '.merkur-dev/vite': { runfile: 'supplier', link: false },
    'node_modules/vite': { runfile: 'original-vite', link: true },
    'node_modules/peer/node_modules/vite': { runfile: 'peer-vite', link: true },
    'node_modules/peer/package.json': { runfile: 'peer-manifest', link: false },
    'node_modules/peer/index.js': { runfile: 'peer-code', link: false },
    'application.ts': { runfile: 'application', link: false },
  };
  await materializeBunRuntime(
    { files, cwd: '', config: '' },
    '',
    runtime,
    { 'original-vite': copiedPackage, 'peer-vite': copiedPackage },
    {
      root: value.root,
      files: {
        supplier: path.relative(value.root, value.tooling),
        'original-vite': path.relative(value.root, original),
        'peer-vite': path.relative(value.root, original),
        'peer-manifest': path.relative(value.root, path.join(peer, 'package.json')),
        'peer-code': path.relative(value.root, path.join(peer, 'index.js')),
        application: path.relative(value.root, source),
      },
    },
  );
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-install',
      '--no-env-file',
      `--config=${fileURLToPath(new URL('empty-bunfig.toml', import.meta.url))}`,
      path.join(runtime, 'application.ts'),
    ],
    { cwd: runtime, env: { PATH: '', TMPDIR: value.root }, stdout: 'pipe', stderr: 'pipe' },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({
    identity: 'actual declared source supplier',
    peer: 'actual declared source supplier',
  });
});
