import { realpathSync } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Declaration = { input: string; owner: string; link: boolean; canonical: string };
export interface ViteBuildInputs {
  operation: 'build' | 'qualify';
  declarations: string;
  original_files: Record<string, string>;
  source_namespace: string;
  source_patch: string;
  rolldown: string;
  rolldown_sources: string;
  native: string;
  compiler_context: string;
  preload: string;
  git: string;
  git_sdk: string;
  bun_config: string;
  output: string;
  selection: string;
}

function relative(value: string): string {
  if (
    !value ||
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Vite source build requires closed declared destinations');
  return value;
}

async function copyPackage(source: string, destination: string): Promise<void> {
  const root = await realpath(source);
  await cp(root, destination, {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: true,
    filter: (member) => {
      const resolved = realpathSync(member);
      if (resolved !== root && !resolved.startsWith(root + path.sep))
        throw new Error('Vite dependency member escaped its original declared tree');
      return true;
    },
  });
}

async function writable(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory()) return;
  await chmod(directory, info.mode | 0o700);
  for (const member of await readdir(directory, { withFileTypes: true }))
    if (member.isDirectory()) await writable(path.join(directory, member.name));
}

async function copyOriginalViteFiles(
  inputs: ViteBuildInputs,
): Promise<Record<string, Declaration>> {
  relative(inputs.source_namespace);
  await mkdir(inputs.output, { recursive: true });
  if (!(await lstat(inputs.output)).isDirectory() || (await readdir(inputs.output)).length)
    throw new Error('Vite source build requires an empty ordinary output tree');
  const declarations: Record<string, Declaration> = JSON.parse(
    await readFile(inputs.declarations, 'utf8'),
  );
  for (const [logical, value] of Object.entries(declarations)) {
    relative(logical);
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'canonical,input,link,owner' ||
      typeof value.input !== 'string' ||
      typeof value.owner !== 'string' ||
      !value.owner ||
      typeof value.link !== 'boolean' ||
      typeof value.canonical !== 'string'
    )
      throw new Error('Vite source build requires original four-field Files');
    relative(value.canonical);
    const original = Object.hasOwn(inputs.original_files, value.input)
      ? inputs.original_files[value.input]
      : undefined;
    if (original === undefined || !path.isAbsolute(original))
      throw new Error('Vite source build lacks its original declared File');
    if (logical !== value.canonical) continue;
    const target = path.join(inputs.output, logical);
    await mkdir(path.dirname(target), { recursive: true });
    if ((await stat(original)).isDirectory()) await copyPackage(original, target);
    else await copyFile(original, target);
  }
  for (const [logical, value] of Object.entries(declarations)) {
    if (logical === value.canonical) continue;
    const target = path.join(inputs.output, value.canonical);
    await lstat(target);
    const alias = path.join(inputs.output, logical);
    await mkdir(path.dirname(alias), { recursive: true });
    await symlink(path.relative(path.dirname(alias), target), alias);
  }
  return declarations;
}

async function originalVitePackage(workspace: string): Promise<string> {
  const packageRoot = path.join(workspace, 'packages/vite');
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (
    packageJson.name !== 'vite' ||
    packageJson.version !== '8.2.2' ||
    packageJson.scripts?.['build-bundle'] !== 'rolldown --config rolldown.config.ts' ||
    packageJson.scripts?.['build-types-roll'] !== 'rolldown --config rolldown.dts.config.ts' ||
    packageJson.scripts?.['build-types-check'] !== 'tsc --project tsconfig.check.json'
  )
    throw new Error('Vite source build differs from the original upstream build commands');
  const lock = Bun.YAML.parse(await readFile(path.join(workspace, 'pnpm-lock.yaml'), 'utf8'));
  if (
    !lock ||
    typeof lock !== 'object' ||
    !('importers' in lock) ||
    !lock.importers ||
    typeof lock.importers !== 'object' ||
    !Object.hasOwn(lock.importers, '.') ||
    !Object.hasOwn(lock.importers, 'packages/vite')
  )
    throw new Error('Vite source build lacks its original importer lock');
  return packageRoot;
}

async function originalRolldownVersion(workspace: string): Promise<string> {
  const lock = Bun.YAML.parse(await readFile(path.join(workspace, 'pnpm-lock.yaml'), 'utf8')) as {
    importers?: Record<
      string,
      {
        dependencies?: Record<string, { specifier?: string; version?: string }>;
        devDependencies?: Record<string, { specifier?: string; version?: string }>;
      }
    >;
  };
  const rootSelection = lock.importers?.['.']?.devDependencies?.rolldown;
  const viteSelection = lock.importers?.['packages/vite']?.dependencies?.rolldown;
  const rootManifest = JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8'));
  const viteManifest = JSON.parse(
    await readFile(path.join(workspace, 'packages/vite/package.json'), 'utf8'),
  );
  if (
    rootSelection?.version !== '1.2.4' ||
    typeof rootSelection.specifier !== 'string' ||
    typeof viteSelection?.specifier !== 'string' ||
    viteSelection?.version !== rootSelection.version ||
    rootSelection.specifier !== rootManifest.devDependencies?.rolldown ||
    viteSelection.specifier !== viteManifest.dependencies?.rolldown
  )
    throw new Error('Rebuilt Rolldown differs from the original selected dependency');
  return rootSelection.version;
}

async function bindRebuiltRolldown(
  inputs: ViteBuildInputs,
  declarations: Record<string, Declaration>,
): Promise<string> {
  const aliases = [
    `${inputs.source_namespace}/node_modules/rolldown`,
    `${inputs.source_namespace}/packages/vite/node_modules/rolldown`,
  ];
  const selected = aliases.map((alias) => declarations[alias]);
  const first = selected[0];
  if (
    !first ||
    selected.some((value) => !value?.link || value.canonical !== first.canonical) ||
    !declarations[first.canonical]?.link ||
    declarations[first.canonical]?.canonical !== first.canonical
  )
    throw new Error('Vite source build requires one actual declared Rolldown package identity');
  const target = path.join(inputs.output, first.canonical);
  const originalPackage = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
  const rebuiltPackage = JSON.parse(
    await readFile(path.join(inputs.rolldown, 'package.json'), 'utf8'),
  );
  const version = await originalRolldownVersion(path.join(inputs.output, inputs.source_namespace));
  if (
    originalPackage.name !== 'rolldown' ||
    originalPackage.version !== version ||
    rebuiltPackage.name !== originalPackage.name ||
    rebuiltPackage.version !== originalPackage.version
  )
    throw new Error('Rebuilt Rolldown differs from the original selected dependency');
  await writable(target);
  await rm(target, { recursive: true });
  await copyPackage(inputs.rolldown, target);
  await writable(target);
  // The rebuilt local addon is the sole native implementation. Close only the
  // original selected package's explicit optional dependency resolution paths.
  for (const name of Object.keys(originalPackage.optionalDependencies ?? {})) {
    relative(name);
    let parent: string = first.canonical;
    for (;;) {
      const logical = parent === '.' ? `node_modules/${name}` : `${parent}/node_modules/${name}`;
      if (declarations[logical] !== undefined) {
        if (!declarations[logical]?.link)
          throw new Error('Original Rolldown optional dependency is not a declared alias');
        await rm(path.join(inputs.output, logical));
        break;
      }
      if (parent === '.') break;
      parent = path.posix.dirname(parent);
    }
  }
  const nativeName = path.basename(inputs.native);
  if (
    !(await readFile(path.join(target, 'dist', nativeName))).equals(await readFile(inputs.native))
  )
    throw new Error('Rebuilt Rolldown does not carry its exact declared native File');
  await mkdir(path.join(target, 'bin'));
  await copyFile(
    path.join(inputs.rolldown_sources, 'packages/rolldown/bin/cli.mjs'),
    path.join(target, 'bin/cli.mjs'),
  );
  return path.join(target, 'bin/cli.mjs');
}

async function originalTypeScript(
  inputs: ViteBuildInputs,
  declarations: Record<string, Declaration>,
): Promise<string> {
  const tsAlias = declarations[`${inputs.source_namespace}/node_modules/typescript`];
  if (!tsAlias?.link || !declarations[tsAlias.canonical]?.link)
    throw new Error('Vite source build lacks its original TypeScript package');
  const ts = path.join(inputs.output, tsAlias.canonical);
  const tsPackage = JSON.parse(await readFile(path.join(ts, 'package.json'), 'utf8'));
  if (
    tsPackage.name !== 'typescript' ||
    tsPackage.version !== '6.0.3' ||
    tsPackage.bin?.tsc !== './bin/tsc'
  )
    throw new Error('Vite source build requires its original locked TypeScript6.0.3');
  return path.join(ts, 'bin/tsc');
}

export async function materializeViteBuild(
  inputs: ViteBuildInputs,
): Promise<{ workspace: string; packageRoot: string; cli: string; typescript: string }> {
  const declarations = await copyOriginalViteFiles(inputs);
  const workspace = path.join(inputs.output, inputs.source_namespace);
  const packageRoot = await originalVitePackage(workspace);
  const cli = await bindRebuiltRolldown(inputs, declarations);
  const typescript = await originalTypeScript(inputs, declarations);
  await readFile(inputs.preload);
  return { workspace, packageRoot, cli, typescript };
}

type SourceFact = { bytes: number; sha256: string; owner: string };
type ObservedModule = {
  id: string;
  isExternal: boolean;
  importedIds: readonly string[];
  dynamicallyImportedIds: readonly string[];
  code: string | null;
  nativeGeneratorInputs?: readonly { path: string; content: string }[];
};
type ObservedOutput =
  | {
      type: 'chunk';
      fileName: string;
      code: string;
      modules: Record<string, unknown>;
      map: unknown;
    }
  | {
      type: 'asset';
      fileName: string;
      source: string | Uint8Array;
      originalFileNames: readonly string[];
    };
type ObservationContext = {
  getModuleIds(): Iterable<string>;
  getModuleInfo(id: string): ObservedModule | null;
};

function byteFact(bytes: Uint8Array): { bytes: number; sha256: string } {
  return {
    bytes: bytes.length,
    sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
  };
}

async function originalSelectedFile(
  id: string,
  inputs: ViteBuildInputs,
  declarations: Record<string, Declaration>,
): Promise<{ logical: string; fact: SourceFact } | undefined> {
  if (!path.isAbsolute(id)) return undefined;
  const logical = path.relative(inputs.output, id).split(path.sep).join('/');
  if (logical.startsWith('../') || logical === '..') return undefined;
  const matches = Object.values(declarations).filter(
    (row) => logical === row.canonical || (row.link && logical.startsWith(row.canonical + '/')),
  );
  const row = matches[0];
  if (!row) return undefined;
  if (matches.some((value) => value.input !== row.input || value.owner !== row.owner))
    throw new Error('Selected Vite module has ambiguous original File custody');
  const root = inputs.original_files[row.input];
  if (!root) throw new Error('Selected Vite module lacks its original declared File');
  const member = logical.slice(row.canonical.length);
  const originalRoot = await realpath(root);
  const original = await realpath(member ? path.join(root, relative(member.slice(1))) : root);
  if (member && !original.startsWith(originalRoot + path.sep))
    throw new Error('Selected Vite module escaped its original declared tree');
  if (!(await lstat(original)).isFile())
    throw new Error('Selected Vite module is not an original regular File');
  const bytes = await readFile(original);
  // Original Files, rather than transformed code or private compiler copies, own
  // the source facts. Their relation comes only from the declared canonical row.
  return { logical, fact: { ...byteFact(bytes), owner: row.owner } };
}

export function observeViteSourceBuild(inputs: ViteBuildInputs, record: string) {
  let invocation = 0;
  return {
    name: 'merkur-original-vite-selection',
    async generateBundle(
      this: ObservationContext,
      options: { dir?: string; file?: string },
      bundle: Record<string, ObservedOutput>,
    ): Promise<void> {
      const outputRecord = invocation === 0 ? record : `${record}.${invocation}.json`;
      invocation += 1;
      const declarations: Record<string, Declaration> = JSON.parse(
        await readFile(inputs.declarations, 'utf8'),
      );
      const facts: Record<string, SourceFact> = Object.create(null);
      const modules = [];
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id);
        if (!info) throw new Error('Selected Vite module disappeared from the compiler graph');
        const selected = info.isExternal
          ? undefined
          : await originalSelectedFile(id, inputs, declarations);
        if (selected) facts[selected.logical] = selected.fact;
        modules.push({
          id,
          external: info.isExternal,
          original: selected?.logical ?? null,
          unmatched: selected
            ? null
            : info.isExternal
              ? 'External runtime edge has no selected build-source File'
              : 'Generated or unmatched module has no qualified original generator File relation',
          imports: [...info.importedIds],
          dynamic_imports: [...info.dynamicallyImportedIds],
          transformed: info.code === null ? null : byteFact(Buffer.from(info.code)),
          native_generator_inputs:
            info.nativeGeneratorInputs?.map((input) => ({
              path: input.path,
              ...byteFact(Buffer.from(input.content)),
            })) ?? [],
        });
      }
      const outputs: Record<string, unknown> = Object.create(null);
      for (const output of Object.values(bundle)) {
        const outputDirectory = options.dir ?? (options.file ? path.dirname(options.file) : '.');
        const emitted = path.resolve(outputDirectory, relative(output.fileName));
        const logical = path
          .relative(path.join(inputs.output, inputs.source_namespace, 'packages/vite'), emitted)
          .split(path.sep)
          .join('/');
        relative(logical);
        outputs[logical] = {
          type: output.type,
          fileName: output.fileName,
          generated: byteFact(
            output.type === 'chunk' ? Buffer.from(output.code) : Buffer.from(output.source),
          ),
          modules: output.type === 'chunk' ? Object.keys(output.modules) : [],
          originalFileNames: output.type === 'asset' ? [...output.originalFileNames] : [],
          // Preserve the original source-map fact without requesting a map.
          map: output.type === 'chunk' ? output.map : null,
        };
      }
      await writeFile(outputRecord, JSON.stringify({ inputs: facts, modules, outputs }) + '\n', {
        flag: 'wx',
      });
    },
  };
}

export function observedViteConfiguration<T extends { plugins?: unknown[] }>(
  configurations: T | T[],
  inputs: ViteBuildInputs,
  recordDirectory: string,
) {
  const observe = (configuration: T, index: number) => ({
    ...configuration,
    plugins: [
      ...(configuration.plugins ?? []),
      observeViteSourceBuild(inputs, path.join(recordDirectory, String(index) + '.json')),
    ],
  });
  return Array.isArray(configurations) ? configurations.map(observe) : observe(configurations, 0);
}

async function prepareObservedConfiguration(
  configuration: string,
  inputs: ViteBuildInputs,
  packageRoot: string,
): Promise<string> {
  const records = path.join(inputs.output, '.merkur-source-selection', configuration);
  await mkdir(records, { recursive: true });
  const wrapper = path.join(packageRoot, '.merkur-selection-' + configuration);
  await writeFile(
    wrapper,
    `import original from ${JSON.stringify('./' + configuration)};\n` +
      `import { observedViteConfiguration } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};\n` +
      `export default await observedViteConfiguration(original, ${JSON.stringify(inputs)}, ${JSON.stringify(records)});\n`,
    { flag: 'wx' },
  );
  return wrapper;
}

async function selectedArtifacts(
  root: string,
  relativeRoot = '',
): Promise<Record<string, { bytes: number; sha256: string }>> {
  const facts: Record<string, { bytes: number; sha256: string }> = Object.create(null);
  for (const entry of await readdir(path.join(root, relativeRoot), { withFileTypes: true })) {
    const member = relativeRoot ? relativeRoot + '/' + entry.name : entry.name;
    if (entry.isDirectory()) Object.assign(facts, await selectedArtifacts(root, member));
    else if (entry.isFile()) facts[member] = byteFact(await readFile(path.join(root, member)));
    else throw new Error('Original Vite emitted an unsupported output member');
  }
  return facts;
}

type ArtifactFacts = Record<string, { bytes: number; sha256: string }>;

export function requireViteOutputParity(original: ArtifactFacts, observed: ArtifactFacts): void {
  const members = Object.keys(original).sort();
  if (!members.length)
    throw new Error('Original Vite output parity requires emitted dist artifacts');
  if (JSON.stringify(members) !== JSON.stringify(Object.keys(observed).sort()))
    throw new Error('Observed Vite output paths differ from the original build');
  for (const member of members) {
    const before = original[member];
    const after = observed[member];
    if (!before || !after || before.bytes !== after.bytes || before.sha256 !== after.sha256)
      throw new Error(`Observed Vite output bytes differ from the original build: ${member}`);
  }
}

export async function retainSourceSelection(
  inputs: ViteBuildInputs,
  packageRoot: string,
  originalArtifacts?: ArtifactFacts,
): Promise<void> {
  const facts: Record<string, SourceFact> = Object.create(null);
  const outputs: Record<string, unknown> = Object.create(null);
  const modules: unknown[] = [];
  const directory = path.join(inputs.output, '.merkur-source-selection');
  for (const configuration of await readdir(directory))
    for (const record of await readdir(path.join(directory, configuration))) {
      const observation = JSON.parse(
        await readFile(path.join(directory, configuration, record), 'utf8'),
      );
      for (const [logical, fact] of Object.entries(observation.inputs)) {
        if (
          Object.hasOwn(facts, logical) &&
          JSON.stringify(facts[logical]) !== JSON.stringify(fact)
        )
          throw new Error('Original selected Vite File changed between build configurations');
        facts[logical] = fact as SourceFact;
      }
      Object.assign(outputs, observation.outputs);
      modules.push({ configuration, modules: observation.modules });
    }
  const artifacts = await selectedArtifacts(packageRoot, 'dist');
  if (originalArtifacts !== undefined) requireViteOutputParity(originalArtifacts, artifacts);
  for (const member of Object.keys(outputs))
    if (!Object.hasOwn(artifacts, member))
      throw new Error('Observed original Vite output is missing its actual emitted member');
  const unmatchedArtifacts = Object.keys(artifacts).filter(
    (member) => !Object.hasOwn(outputs, member),
  );
  await writeFile(
    inputs.selection,
    JSON.stringify({
      inputs: facts,
      outputs,
      artifacts,
      modules,
      unmatched_artifacts: unmatchedArtifacts,
      output_parity: originalArtifacts === undefined ? 'pending' : 'qualified',
      original_artifacts: originalArtifacts ?? null,
      build_tool: {
        version: await originalRolldownVersion(path.join(inputs.output, inputs.source_namespace)),
        native: byteFact(await readFile(inputs.native)),
        compiler_context: byteFact(await readFile(inputs.compiler_context)),
        preload: byteFact(await readFile(inputs.preload)),
        source_patch: byteFact(await readFile(inputs.source_patch)),
        declarations: byteFact(await readFile(inputs.declarations)),
      },
      pending: [
        originalArtifacts === undefined
          ? 'Native/generated source custody and observed/unobserved output parity remain unqualified'
          : 'Native/generated source custody remains unqualified',
        'Shipped frontend runtime Files are not joined by this causal source-build observation',
      ],
    }) + '\n',
    { flag: 'wx' },
  );
}

export async function buildViteSource(inputs: ViteBuildInputs): Promise<void> {
  await executeViteSourceBuild(inputs, false);
}

export async function qualifyViteSource(inputs: ViteBuildInputs): Promise<void> {
  await executeViteSourceBuild(inputs, true);
}

async function executeViteSourceBuild(inputs: ViteBuildInputs, qualify: boolean): Promise<void> {
  if (!path.isAbsolute(inputs.git_sdk) || inputs.git !== path.join(inputs.git_sdk, 'bin/git'))
    throw new Error('Vite source patch requires its declared Git SDK executable');
  const prepared = await materializeViteBuild(inputs);
  const env = {
    HOME: inputs.output,
    TMPDIR: inputs.output,
    PATH: '/__no_ambient_path__',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    DYLD_FALLBACK_LIBRARY_PATH: path.join(inputs.git_sdk, 'lib'),
    GIT_EXEC_PATH: path.join(inputs.git_sdk, 'libexec/git-core'),
    GIT_TEMPLATE_DIR: path.join(inputs.git_sdk, 'share/git-core/templates'),
    GIT_CEILING_DIRECTORIES: path.dirname(prepared.workspace),
  };
  async function run(argv: string[], cwd: string): Promise<void> {
    const status = await Bun.spawn(argv, { cwd, env, stdout: 'inherit', stderr: 'inherit' }).exited;
    if (status !== 0) throw new Error(`Original Vite build command failed with status ${status}`);
  }
  await run([inputs.git, 'apply', '--check', inputs.source_patch], prepared.workspace);
  await run([inputs.git, 'apply', inputs.source_patch], prepared.workspace);
  async function compile(observed: boolean): Promise<void> {
    for (const configuration of ['rolldown.config.ts', 'rolldown.dts.config.ts'])
      await run(
        [
          process.execPath,
          '--no-install',
          '--no-env-file',
          '--config=' + inputs.bun_config,
          prepared.cli,
          '--config',
          observed
            ? await prepareObservedConfiguration(configuration, inputs, prepared.packageRoot)
            : configuration,
        ],
        prepared.packageRoot,
      );
    await run(
      [
        process.execPath,
        '--no-install',
        '--no-env-file',
        '--config=' + inputs.bun_config,
        prepared.typescript,
        '--project',
        'tsconfig.check.json',
      ],
      prepared.packageRoot,
    );
  }
  let originalArtifacts: ArtifactFacts | undefined;
  if (qualify) {
    await compile(false);
    originalArtifacts = await selectedArtifacts(prepared.packageRoot, 'dist');
    // This directory was emitted inside this invocation's private owned workspace.
    // Reuse all original source/dependency inputs without copying them again.
    const dist = path.join(prepared.packageRoot, 'dist');
    await writable(dist);
    await rm(dist, { recursive: true });
  }
  await compile(true);
  for (const member of ['dist/node/index.js', 'dist/node/index.d.ts', 'dist/client/client.mjs'])
    if (!(await lstat(path.join(prepared.packageRoot, member))).isFile())
      throw new Error('Original Vite build is missing its actual output');
  await retainSourceSelection(inputs, prepared.packageRoot, originalArtifacts);
}

export async function extractPublishedViteChunk(
  packageRoot: string,
  sourceArchive: string,
  output: string,
): Promise<void> {
  const archiveBytes = await readFile(sourceArchive);
  const files = await new Bun.Archive(archiveBytes).files();
  const packageJson = files.get('package/package.json');
  const originalMember = files.get('package/dist/node/chunks/node.js');
  if (packageJson === undefined || originalMember === undefined || originalMember.size === 0)
    throw new Error('Original published Vite archive members are missing');
  const originalManifest = JSON.parse(await packageJson.text());
  const manifestBytes = await readFile(path.join(packageRoot, 'package.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (
    originalManifest.name !== 'vite' ||
    originalManifest.version !== '8.2.2' ||
    manifest.name !== originalManifest.name ||
    manifest.version !== originalManifest.version
  )
    throw new Error('Published Vite generator package identity differs');
  const member = path.join(packageRoot, 'dist/node/chunks/node.js');
  const bytes = Buffer.from(await originalMember.arrayBuffer());
  // The original npm source File owns the bytes. The store can have per-member
  // sandbox carrier aliases, so its physical directory is not an origin root.
  if (
    !manifestBytes.equals(Buffer.from(await packageJson.arrayBuffer())) ||
    !(await readFile(member)).equals(bytes)
  )
    throw new Error('Published Vite store differs from its original archive');
  await writeFile(output, bytes, { flag: 'wx' });
  if (
    !(await readFile(sourceArchive)).equals(archiveBytes) ||
    !(await readFile(member)).equals(bytes)
  )
    throw new Error('Original published Vite generator changed while being captured');
}

if (import.meta.main) {
  const specification = process.argv[2];
  if (specification === undefined || process.argv.length !== 3)
    throw new Error('Vite source actions require their declared specification File');
  const input = JSON.parse(await readFile(specification, 'utf8'));
  if (input.operation === 'extract')
    await extractPublishedViteChunk(
      path.resolve(input.package),
      path.resolve(input.source_archive),
      path.resolve(input.output),
    );
  else if (input.operation === 'build' || input.operation === 'qualify') {
    for (const key of [
      'declarations',
      'source_patch',
      'rolldown',
      'rolldown_sources',
      'native',
      'compiler_context',
      'preload',
      'git',
      'git_sdk',
      'bun_config',
      'output',
      'selection',
    ])
      input[key] = path.resolve(input[key]);
    for (const [key, value] of Object.entries(input.original_files)) {
      if (typeof value !== 'string') throw new Error('Original Vite File path is malformed');
      input.original_files[key] = path.resolve(value);
    }
    if (input.operation === 'qualify') await qualifyViteSource(input);
    else await buildViteSource(input);
  } else throw new Error('Unknown original Vite source action');
}
