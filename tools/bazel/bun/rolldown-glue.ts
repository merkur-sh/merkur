import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { materializeRolldownPackageRuntime } from './rolldown-package-runtime';

type Declaration = { input: string; link: boolean; owner: string; canonical: string };
export type GlueInputs = {
  sources: string;
  native: string;
  type_defs: string;
  compiler_context: string;
  platform: string;
  declarations: string;
  original_files: Record<string, string>;
  dependency_namespace: string;
  napi_cli: string;
  workspace_source: { input: string; owner: string; namespace: string; canonical: string };
  node: string;
  output: string;
  generated_declarations: string;
};

function portable(value: string): string {
  if (
    !value ||
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Rolldown glue requires closed declared logical paths');
  return value;
}

function original(inputs: GlueInputs, spelling: string): string {
  const value = Object.hasOwn(inputs.original_files, spelling)
    ? inputs.original_files[spelling]
    : undefined;
  if (value === undefined || !path.isAbsolute(value))
    throw new Error('Rolldown glue dependency lacks its original declared File');
  return value;
}

async function writableDirectories(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory()) return;
  await chmod(directory, info.mode | 0o700);
  for (const member of await readdir(directory, { withFileTypes: true })) {
    if (member.isDirectory()) await writableDirectories(path.join(directory, member.name));
  }
}

export async function materializeGlueInputs(
  inputs: GlueInputs,
  directory: string,
): Promise<{ workspace: string; cli: string }> {
  const namespace = portable(inputs.dependency_namespace);
  const workspace = path.join(directory, namespace);
  await cp(inputs.sources, workspace, { recursive: true, dereference: true });
  await writableDirectories(workspace);
  const declarations: Record<string, Declaration> = JSON.parse(
    await readFile(inputs.declarations, 'utf8'),
  );
  for (const [logical, value] of Object.entries(declarations)) {
    portable(logical);
    if (
      value === null ||
      Object.keys(value).sort().join(',') !== 'canonical,input,link,owner' ||
      typeof value.input !== 'string' ||
      typeof value.canonical !== 'string' ||
      typeof value.owner !== 'string' ||
      !value.owner ||
      typeof value.link !== 'boolean'
    )
      throw new Error('Rolldown glue requires original four-field declarations');
    portable(value.canonical);
    original(inputs, value.input);
  }
  for (const [logical, value] of Object.entries(declarations)) {
    if (logical !== value.canonical) continue;
    const destination = path.join(directory, logical);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(original(inputs, value.input), destination, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
    });
    await writableDirectories(destination);
  }
  for (const [logical, value] of Object.entries(declarations)) {
    if (logical === value.canonical) continue;
    const target = path.join(directory, value.canonical);
    await lstat(target);
    const destination = path.join(directory, logical);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(target, destination);
  }
  const cliRows = Object.entries(declarations).filter(
    ([logical, value]) =>
      value.input === inputs.napi_cli && logical === value.canonical && value.link,
  );
  const selected = cliRows[0];
  if (cliRows.length !== 1 || selected === undefined)
    throw new Error('Rolldown glue CLI must be the original canonical npm package File');
  const cli = path.join(directory, selected[0]);
  const packageJson = JSON.parse(await readFile(path.join(cli, 'package.json'), 'utf8'));
  if (packageJson.name !== '@napi-rs/cli' || packageJson.version !== '3.8.6')
    throw new Error('Rolldown glue requires original locked @napi-rs/cli3.8.6');
  return { workspace, cli };
}

export async function workspaceSelfLink(workspace: string, inputs: GlueInputs): Promise<void> {
  const lock = Bun.YAML.parse(await readFile(path.join(workspace, 'pnpm-lock.yaml'), 'utf8'));
  if (typeof lock !== 'object' || lock === null || !('importers' in lock))
    throw new Error('Rolldown glue requires its original upstream workspace lock');
  const importer = (lock.importers as Record<string, unknown>)['packages/rolldown'];
  if (typeof importer !== 'object' || importer === null || !('devDependencies' in importer))
    throw new Error('Rolldown glue has no original package importer');
  const self = (importer.devDependencies as Record<string, unknown>).rolldown;
  if (
    typeof self !== 'object' ||
    self === null ||
    !('specifier' in self) ||
    !('version' in self) ||
    self.specifier !== 'workspace:*' ||
    self.version !== 'link:'
  )
    throw new Error('Rolldown source self-link differs from the original lock');
  const packageRoot = path.join(workspace, 'packages/rolldown');
  const source = inputs.workspace_source;
  const namespace = portable(inputs.dependency_namespace);
  const parts = namespace.split('/');
  const expectedNamespace = `${namespace}/packages/rolldown`;
  const expectedOwner = `@@${parts[1]}//packages/rolldown:npm_package`;
  if (
    source === null ||
    typeof source !== 'object' ||
    Object.keys(source).sort().join(',') !== 'canonical,input,namespace,owner' ||
    typeof source.input !== 'string' ||
    parts.length !== 2 ||
    parts[0] !== 'upstream' ||
    source.owner !== expectedOwner ||
    source.namespace !== expectedNamespace ||
    typeof source.canonical !== 'string'
  )
    throw new Error('Rolldown self-link lacks its original authored source/store ownership');
  portable(source.canonical);
  if (!source.canonical.startsWith(`${namespace}/`))
    throw new Error('Rolldown self-link store belongs to a foreign source namespace');
  const originalSource = original(inputs, source.input);
  if (!(await stat(originalSource)).isDirectory() || !(await lstat(packageRoot)).isDirectory())
    throw new Error('Rolldown self-link requires original and authored package directory Files');
  const declarations: Record<string, Declaration> = JSON.parse(
    await readFile(inputs.declarations, 'utf8'),
  );
  const logical = `${expectedNamespace}/node_modules/rolldown`;
  const declaration = declarations[logical];
  if (
    declaration === undefined ||
    !declaration.link ||
    declaration.canonical !== source.canonical ||
    declarations[source.canonical]?.canonical !== source.canonical
  )
    throw new Error('Rolldown self-link differs from its original declared workspace store');
  original(inputs, declaration.input);
  const namespaceRoot = path.resolve(workspace, ...parts.map(() => '..'));
  const canonical = path.join(namespaceRoot, source.canonical);
  const destination = path.join(packageRoot, 'node_modules/rolldown');
  if (
    !(await lstat(canonical)).isDirectory() ||
    !(await lstat(destination)).isSymbolicLink() ||
    path.resolve(path.dirname(destination), await readlink(destination)) !== canonical
  )
    throw new Error('Rolldown self-link is not its materialized original declared package Tree');
  // Rebind only this exact declared workspace alias. Its copied npm tree is
  // original input; the original build must import the authored package where
  // the same compiler's new NAPI loader/native binding will be generated.
  await unlink(destination);
  await symlink(packageRoot, destination);
}

export async function requireTypeRecords(file: string): Promise<void> {
  // The typed compiler File can have an engine-created sandbox carrier alias.
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Rolldown declarations require compiler-produced JSONL File');
  const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim());
  if (!lines.length) throw new Error('Rolldown compiler type records are empty');
  for (const line of lines) {
    const record = JSON.parse(line);
    if (
      typeof record !== 'object' ||
      record === null ||
      typeof record.kind !== 'string' ||
      typeof record.name !== 'string' ||
      typeof record.def !== 'string'
    )
      throw new Error('Rolldown compiler type records are malformed');
  }
}

async function generateBindings(
  inputs: GlueInputs,
  directory: string,
  workspace: string,
  cliPath: string,
) {
  await requireTypeRecords(inputs.type_defs);
  const packageRoot = path.join(workspace, 'packages/rolldown');
  const cli = await import(pathToFileURL(path.join(cliPath, 'dist/index.js')).href);
  const config = await cli.readNapiConfig(path.join(packageRoot, 'package.json'));
  if (config.binaryName !== 'rolldown-binding' || config.packageName !== '@rolldown/binding')
    throw new Error('Rolldown original NAPI configuration has a different native producer');
  const records = path.join(directory, 'compiler-type-records');
  await mkdir(records);
  await copyFile(inputs.type_defs, path.join(records, 'rolldown_binding'));
  const types = await cli.generateTypeDef({
    typeDefDir: records,
    configDtsHeader: config.dtsHeader,
    configDtsHeaderFile: config.dtsHeaderFile,
    constEnum: false,
    cwd: packageRoot,
  });
  if (!types.dts || !types.exports.length)
    throw new Error('Original NAPI generator produced no native declarations');
  const declaration = path.join(packageRoot, 'src/binding.d.cts');
  await rm(declaration);
  await writeFile(declaration, types.dts, { flag: 'wx' });
  const loader = await cli.writeJsBinding({
    platform: true,
    idents: types.exports,
    jsBinding: 'binding.cjs',
    binaryName: config.binaryName,
    packageName: config.packageName,
    version: config.packageJson.version,
    outputDir: path.join(packageRoot, 'src'),
    wasiFlavors: config.targets
      .filter((target: { platform: string }) => target.platform === 'wasi')
      .map((target: { platformArchABI: string }) => target.platformArchABI),
  });
  if (loader === undefined) throw new Error('Original NAPI generator produced no native loader');
  const target = cli.parseTriple(inputs.platform);
  await copyFile(
    inputs.native,
    path.join(packageRoot, `src/rolldown-binding.${target.platformArchABI}.node`),
  );
  return packageRoot;
}

export async function buildRolldownGlue(inputs: GlueInputs): Promise<void> {
  if (!path.isAbsolute(inputs.node))
    throw new Error('Rolldown requires its declared Node executable');
  await readFile(inputs.compiler_context);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-rolldown-glue-'));
  try {
    const { workspace, cli } = await materializeGlueInputs(inputs, directory);
    await workspaceSelfLink(workspace, inputs);
    const packageRoot = await generateBindings(inputs, directory, workspace, cli);
    const child = Bun.spawn(
      [
        inputs.node,
        '--enable-source-maps',
        '--import',
        '@oxc-node/core/register',
        '-C',
        'dev',
        './build.ts',
      ],
      {
        cwd: packageRoot,
        env: { HOME: directory, TMPDIR: directory, PATH: '/__no_ambient_path__' },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    const status = await child.exited;
    if (status !== 0) throw new Error(`Original Rolldown JS build failed with status ${status}`);
    await publishRolldownGlue(packageRoot, inputs.output, inputs.generated_declarations);
    const native = path.join(inputs.output, 'dist', path.basename(inputs.native));
    if (!(await readFile(native)).equals(await readFile(inputs.native)))
      throw new Error('Original Rolldown build changed its declared native binding bytes');
    materializeRolldownPackageRuntime({
      namespaceRoot: directory,
      packageDirectory: `${inputs.dependency_namespace}/packages/rolldown`,
      output: inputs.output,
      declarations: JSON.parse(await readFile(inputs.declarations, 'utf8')),
      localNativeBinding: { file: native, replaces: [] },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function publishRolldownGlue(
  packageRoot: string,
  output: string,
  declarations: string,
): Promise<void> {
  const members = await readdir(path.join(packageRoot, 'dist'));
  if (!members.includes('index.mjs')) throw new Error('Original Rolldown build emitted no package');
  await mkdir(output, { recursive: true });
  if (!(await lstat(output)).isDirectory() || (await readdir(output)).length !== 0)
    throw new Error('Rolldown publication requires an empty ordinary output directory');
  await cp(path.join(packageRoot, 'dist'), path.join(output, 'dist'), { recursive: true });
  await copyFile(path.join(packageRoot, 'package.json'), path.join(output, 'package.json'));
  await copyFile(path.join(packageRoot, 'src/binding.d.cts'), declarations);
}

if (import.meta.main) {
  const spec = process.argv[2];
  if (spec === undefined)
    throw new Error('Rolldown glue requires its declared input specification');
  const inputs: GlueInputs = JSON.parse(await readFile(spec, 'utf8'));
  for (const name of [
    'sources',
    'native',
    'type_defs',
    'compiler_context',
    'declarations',
    'node',
    'output',
    'generated_declarations',
  ] as const)
    inputs[name] = path.resolve(inputs[name]);
  for (const [logical, physical] of Object.entries(inputs.original_files))
    inputs.original_files[logical] = path.resolve(physical);
  await buildRolldownGlue(inputs);
}
