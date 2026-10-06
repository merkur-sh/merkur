import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  materializeRolldownPackageRuntime,
  type RuntimeDeclaration,
} from './rolldown-package-runtime';

const inputFile = process.env.MERKUR_ROLLDOWN_RUNTIME_INPUTS;
if (inputFile === undefined)
  throw new Error('Rolldown runtime controls require declared original inputs');
const inputs = JSON.parse(readFileSync(inputFile, 'utf8')) as {
  readonly package: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly native: string;
  readonly replacedOptionalDependencies: readonly string[];
};
let directory = '';
let namespaceRoot = '';
let output = '';
let declarations: Record<string, RuntimeDeclaration> = {};
const packageDirectory = 'upstream/packages/rolldown';

beforeEach(() => {
  directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'rolldown-runtime-control-')));
  namespaceRoot = path.join(directory, 'namespace');
  output = path.join(directory, 'output');
  cpSync(inputs.package, path.join(namespaceRoot, packageDirectory), { recursive: true });
  cpSync(path.join(inputs.package, 'dist'), path.join(output, 'dist'), { recursive: true });
  cpSync(path.join(inputs.package, 'package.json'), path.join(output, 'package.json'));
  // This is an explicit declared original artifact. These controls do not qualify native generation.
  cpSync(inputs.native, path.join(output, 'binding.node'));
  declarations = {};
  for (const [name, original] of Object.entries(inputs.dependencies)) {
    const canonical = `upstream/node_modules/.store/${name}`;
    cpSync(original, path.join(namespaceRoot, canonical), { recursive: true });
    const source = { input: original, owner: `declared:${name}`, link: true, canonical };
    declarations[canonical] = source;
    declarations[`${packageDirectory}/node_modules/${name}`] = source;
  }
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function materialize() {
  materializeRolldownPackageRuntime({
    namespaceRoot,
    packageDirectory,
    output,
    declarations,
    localNativeBinding: {
      file: path.join(output, 'binding.node'),
      replaces: inputs.replacedOptionalDependencies,
    },
  });
}

test('original emitted JavaScript cannot resolve its runtime package when copied alone', () => {
  const chunk = new Bun.Glob('bindingify-input-options-*.mjs')
    .scanSync({
      cwd: path.join(output, 'dist/shared'),
    })
    .next().value;
  if (typeof chunk !== 'string') throw new Error('Original Rolldown runtime chunk is missing');
  const result = Bun.spawnSync(
    [
      process.execPath,
      '--no-install',
      '--no-env-file',
      `--config=${path.resolve(import.meta.dir, 'empty-bunfig.toml')}`,
      '-e',
      `await import(${JSON.stringify(path.join(output, 'dist/shared', chunk))})`,
    ],
    { cwd: directory, env: { PATH: '/__no_ambient_path__' } },
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Cannot find module '@rolldown/pluginutils'");
});

test('declared runtime package bytes and confined aliases survive removal of the build namespace', async () => {
  materialize();
  for (const [name, original] of Object.entries(inputs.dependencies)) {
    const installed = path.join(output, 'node_modules', name);
    expect(realpathSync(installed).startsWith(`${output}/`)).toBe(true);
    expect(readFileSync(path.join(installed, 'package.json'))).toEqual(
      readFileSync(path.join(original, 'package.json')),
    );
  }
  expect(readFileSync(path.join(output, 'binding.node'))).toEqual(readFileSync(inputs.native));
  for (const name of inputs.replacedOptionalDependencies)
    expect(existsSync(path.join(output, 'node_modules', name))).toBe(false);
  rmSync(namespaceRoot, { recursive: true });
  const plugin = await import(
    path.join(output, 'node_modules/@rolldown/pluginutils/dist/index.mjs')
  );
  const filter = plugin.exactRegex('source/main.ts');
  expect(filter.test('source/main.ts')).toBe(true);
  expect(filter.test('source/main.test.ts')).toBe(false);
  expect(filter.test('source/main.js')).toBe(false);
  expect(readFileSync(path.join(output, 'node_modules/@oxc-project/types/types.d.ts'))).toEqual(
    readFileSync(path.join(inputs.dependencies['@oxc-project/types'] ?? '', 'types.d.ts')),
  );
});

test('an available package without its declared alias cannot satisfy the required dependency', () => {
  delete declarations[`${packageDirectory}/node_modules/@rolldown/pluginutils`];
  expect(materialize).toThrow(
    'Missing declared runtime dependency: rolldown -> @rolldown/pluginutils',
  );
});

test('an alias without its original typed package and an escaping canonical name are refused', () => {
  const alias = `${packageDirectory}/node_modules/@rolldown/pluginutils`;
  const entry = declarations[alias];
  if (entry === undefined) throw new Error('Original pluginutils declaration is missing');
  delete declarations[entry.canonical];
  expect(materialize).toThrow('lacks its original typed package');
});

test('an escaping canonical dependency name is refused', () => {
  const alias = `${packageDirectory}/node_modules/@rolldown/pluginutils`;
  const entry = declarations[alias];
  if (entry === undefined) throw new Error('Original pluginutils declaration is missing');
  declarations[alias] = { ...entry, canonical: '../ambient/package' };
  expect(materialize).toThrow('namespace escaped');
});

test('an interior package symlink cannot import bytes outside its declared tree', () => {
  const marker = path.join(directory, 'undeclared-marker');
  writeFileSync(marker, 'bytes outside every declared runtime package');
  const original = path.join(namespaceRoot, 'upstream/node_modules/.store/@rolldown/pluginutils');
  symlinkSync(marker, path.join(original, 'undeclared-link'));
  expect(materialize).toThrow('Runtime package input escaped its declared tree');
  expect(existsSync(path.join(output, 'node_modules/@rolldown/pluginutils/undeclared-link'))).toBe(
    false,
  );
});

test('an interior link into another namespace directory is also outside the declared package', () => {
  const original = path.join(namespaceRoot, 'upstream/node_modules/.store/@rolldown/pluginutils');
  symlinkSync(
    path.join(namespaceRoot, packageDirectory, 'package.json'),
    path.join(original, 'foreign-manifest'),
  );
  expect(materialize).toThrow('Runtime package input escaped its declared tree');
});

test('a contained original file link is copied as the original regular bytes', () => {
  const original = path.join(namespaceRoot, 'upstream/node_modules/.store/@rolldown/pluginutils');
  symlinkSync('dist/index.mjs', path.join(original, 'contained-link.mjs'));
  materialize();
  const copied = path.join(output, 'node_modules/@rolldown/pluginutils/contained-link.mjs');
  expect(lstatSync(copied).isFile()).toBe(true);
  expect(readFileSync(copied)).toEqual(readFileSync(path.join(original, 'dist/index.mjs')));
  expect(realpathSync(copied).startsWith(`${output}/`)).toBe(true);
});

test('a package manifest link cannot read undeclared bytes before package copying', () => {
  const original = path.join(namespaceRoot, 'upstream/node_modules/.store/@rolldown/pluginutils');
  const marker = path.join(directory, 'undeclared-package.json');
  cpSync(path.join(original, 'package.json'), marker);
  rmSync(path.join(original, 'package.json'));
  symlinkSync(marker, path.join(original, 'package.json'));
  expect(materialize).toThrow('Runtime package input escaped its declared tree');
});

test('native replacement names must be original optional dependencies and the artifact stays local', () => {
  expect(() =>
    materializeRolldownPackageRuntime({
      namespaceRoot,
      packageDirectory,
      output,
      declarations,
      localNativeBinding: {
        file: path.join(output, 'binding.node'),
        replaces: ['@rolldown/pluginutils'],
      },
    }),
  ).toThrow('does not replace an original optional dependency');
  const foreign = path.join(directory, 'foreign.node');
  writeFileSync(foreign, readFileSync(inputs.native));
  expect(() =>
    materializeRolldownPackageRuntime({
      namespaceRoot,
      packageDirectory,
      output,
      declarations,
      localNativeBinding: { file: foreign, replaces: inputs.replacedOptionalDependencies },
    }),
  ).toThrow('missing from the runtime package');
});
