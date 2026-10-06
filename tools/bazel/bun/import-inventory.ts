import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { discoverTests } from '../../../scripts/test-inventory';
import { moduleRequests, type RuntimeOutputDirectory } from './module-requests';

interface ModuleInputs {
  readonly files: readonly string[];
  readonly artifacts: readonly string[];
  readonly packages: readonly { directory: string; name: string }[];
  readonly unresolved: readonly string[];
  readonly sourceSha256: string;
}

if (Bun.version !== '1.4.2')
  throw new Error('Import inventory requires the pinned Bun 1.4.2 runtime');
const root = realpathSync(path.resolve(import.meta.dir, '../../..'));
const parsed = new Map<string, ModuleInputs>();
const runtimeContracts = JSON.parse(
  readFileSync(path.join(root, 'tools/bazel/bun/runtime-inputs.json'), 'utf8'),
) as Record<
  string,
  {
    readonly moduleSeeds: readonly string[];
    readonly runtimeOutputs?: readonly RuntimeOutputDirectory[];
    readonly files: readonly string[];
    readonly directories?: readonly string[];
    readonly artifacts: readonly string[];
    readonly tools: Readonly<Record<string, string>>;
    readonly toolEnvironment?: Readonly<Record<string, string>>;
    readonly environmentFiles?: Readonly<Record<string, string>>;
  }
>;
const runtimeOutputDirectories = new Map(
  Object.entries(runtimeContracts).map(([file, contract]) => [file, contract.runtimeOutputs]),
);
const directoryInputs = new Map<string, readonly string[]>();
function runtimeFiles(directory: string): readonly string[] {
  const previous = directoryInputs.get(directory);
  if (previous !== undefined) return previous;
  if (directory.startsWith('/') || directory.split('/').includes('..'))
    throw new Error(`Runtime directory escaped repository: ${directory}`);
  const files: string[] = [];
  function walk(relative: string) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
      else throw new Error(`Runtime directory contains non-regular input: ${file}`);
    }
  }
  walk(directory);
  files.sort();
  directoryInputs.set(directory, files);
  return files;
}
const builtins = new Set(builtinModules);
const generatedPackages = new Map([
  ['packages/e2e-wasm/pkg', '//packages/e2e-wasm:wasm_artifacts'],
  ['packages/graphics-wasm/pkg', '//packages/graphics-wasm:wasm_artifacts'],
  ['packages/graphics-codec-probe/pkg', '//packages/graphics-codec-probe:wasm_artifacts'],
  ['packages/term-wasm/pkg', '//packages/term-wasm:wasm_artifacts'],
  ['apps/web/src/term-wasm/pkg', '//apps/web:term_wasm_runtime'],
  ['apps/web/src/e2e-wasm/pkg', '//apps/web:e2e_wasm_runtime'],
  ['apps/web/src/graphics-wasm/pkg', '//apps/web:graphics_wasm_runtime'],
]);

function dependencyInventory(file: string): ModuleInputs {
  const previous = parsed.get(file);
  if (previous !== undefined) return previous;
  const absolute = path.join(root, file);
  const source = readFileSync(absolute, 'utf8');
  const contract = runtimeContracts[file];
  const { requests, relativeFiles, programFiles, computedImports, computedFiles } = moduleRequests(
    file,
    source,
    runtimeOutputDirectories.get(file),
  );
  const files: string[] = [];
  const artifacts: string[] = [];
  const packages: { directory: string; name: string }[] = [];
  const unresolved: string[] =
    computedImports === 0 ? [] : ['computed module requests require declared runtime inputs'];
  if (computedFiles !== 0) unresolved.push('computed file reads require declared runtime inputs');
  for (const [request, directory] of [
    ...relativeFiles.map((request) => [request, path.dirname(absolute)] as const),
    ...programFiles.map((request) => [request, root] as const),
  ]) {
    const resolved = path.resolve(directory, request);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(`Runtime source reference escaped repository: ${file}: ${request}`);
    const producer = generatedPackages.get(path.dirname(relative));
    if (producer !== undefined) artifacts.push(producer);
    else if (existsSync(resolved) && statSync(resolved).isFile()) files.push(relative);
    else unresolved.push(`runtime file reference requires explicit inputs: ${request}`);
  }
  for (const request of requests) {
    if (
      request.startsWith('node:') ||
      builtins.has(request) ||
      request === 'bun' ||
      request === 'bun:test'
    )
      continue;
    if (request.startsWith('.')) {
      const requested = path.relative(root, path.resolve(path.dirname(absolute), request));
      const producer = generatedPackages.get(path.dirname(requested));
      if (producer !== undefined) {
        artifacts.push(producer);
        continue;
      }
    }
    let resolved: string;
    try {
      resolved = realpathSync(Bun.resolveSync(request, path.dirname(absolute)));
    } catch {
      unresolved.push(request);
      continue;
    }
    const relative = path.relative(root, resolved);
    if (
      relative.split(path.sep).includes('node_modules') ||
      (relative.startsWith('..') && !request.startsWith('.') && !request.startsWith('@merkur/'))
    ) {
      const name = request.startsWith('@')
        ? request.split('/').slice(0, 2).join('/')
        : request.split('/')[0];
      if (name === undefined) throw new Error(`Invalid package request ${request}`);
      let directory = path.dirname(absolute);
      while (directory !== root && !existsSync(path.join(directory, 'package.json'))) {
        directory = path.dirname(directory);
      }
      packages.push({ directory: path.relative(root, directory), name });
    } else {
      if (relative.startsWith('..'))
        throw new Error(`Source import escaped declared repository: ${file} -> ${request}`);
      files.push(relative);
    }
  }
  if (contract !== undefined) {
    files.push(...contract.moduleSeeds, ...contract.files);
    for (const directory of contract.directories ?? []) files.push(...runtimeFiles(directory));
    artifacts.push(...contract.artifacts);
  }
  const result = {
    files,
    artifacts,
    packages,
    unresolved,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
  };
  parsed.set(file, result);
  return result;
}

function mergeRuntimeBindings(
  destination: Record<string, string>,
  bindings: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(bindings)) {
    const previous = destination[key];
    if (previous !== undefined && previous !== value) {
      throw new Error(`Conflicting runtime binding: ${key}: ${previous} vs ${value}`);
    }
    destination[key] = value;
  }
}
const tests: Record<
  string,
  {
    files: string[];
    artifacts: string[];
    packages: { directory: string; name: string }[];
    unresolved: string[];
    tools: Readonly<Record<string, string>>;
    toolEnvironment: Readonly<Record<string, string>>;
    environmentFiles: Readonly<Record<string, string>>;
  }
> = {};
const sourceTests = discoverTests(root).filter((test) => {
  const [area, workspace, entry] = test.split('/');
  return !(
    (area === 'apps' || area === 'packages') &&
    workspace !== undefined &&
    entry === 'npm_package' &&
    existsSync(path.join(root, area, workspace, 'package.json'))
  );
});
for (const test of [...sourceTests, 'scripts/test-preload.ts']) {
  const files = new Set<string>();
  const artifacts = new Set<string>();
  const packages = new Map<string, { directory: string; name: string }>();
  const unresolved = new Set<string>();
  const tools: Record<string, string> = {};
  const toolEnvironment: Record<string, string> = {};
  const environmentFiles: Record<string, string> = {};
  function visit(file: string) {
    if (files.has(file)) return;
    files.add(file);
    const runtime = runtimeContracts[file];
    mergeRuntimeBindings(tools, runtime?.tools ?? {});
    mergeRuntimeBindings(toolEnvironment, runtime?.toolEnvironment ?? {});
    mergeRuntimeBindings(environmentFiles, runtime?.environmentFiles ?? {});
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    const inputs = dependencyInventory(file);
    for (const artifact of inputs.artifacts) artifacts.add(artifact);
    for (const item of inputs.packages) packages.set(`${item.directory}:${item.name}`, item);
    for (const request of inputs.unresolved) unresolved.add(`${file}: ${request}`);
    for (const dependency of inputs.files) visit(dependency);
  }
  visit(test);
  const contract = runtimeContracts[test];
  if (contract !== undefined) {
    for (const seed of contract.moduleSeeds) visit(seed);
    for (const file of contract.files) {
      if (file.startsWith('/') || file.split('/').includes('..'))
        throw new Error(`Runtime input escaped repository: ${test}: ${file}`);
      if (!existsSync(path.join(root, file))) throw new Error(`Missing runtime input: ${file}`);
      files.add(file);
    }
    for (const artifact of contract.artifacts) artifacts.add(artifact);
  }
  tests[test] = {
    files: [...files].sort(),
    artifacts: [...artifacts].sort(),
    packages: [...packages.values()].sort((a, b) =>
      `${a.directory}:${a.name}`.localeCompare(`${b.directory}:${b.name}`),
    ),
    unresolved: [...unresolved].sort(),
    tools,
    toolEnvironment,
    environmentFiles,
  };
}
/** The projects `scripts/check-types.ts` checks: every workspace, and the standalone three. */
const typeProjects = [
  ...['apps', 'packages'].flatMap((area) =>
    readdirSync(path.join(root, area))
      .map((workspace) => path.join(area, workspace, 'tsconfig.json'))
      .filter((project) => existsSync(path.join(root, project))),
  ),
  'scripts/tsconfig.json',
  'tests/tsconfig.json',
  'apps/server/scripts/tsconfig.json',
  'tools/bazel/bun/tsconfig.json',
  'tools/bazel/verification/tsconfig.json',
].sort();
const lock = JSON.parse(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')) as {
  readonly importers: Readonly<
    Record<
      string,
      Readonly<
        Partial<
          Record<
            'dependencies' | 'devDependencies' | 'optionalDependencies',
            Readonly<Record<string, { readonly version: string }>>
          >
        >
      >
    >
  >;
};

/** The lock importer whose `node_modules` a file's bare imports resolve in first. */
function importer(file: string): string {
  let directory = path.dirname(file);
  while (directory !== '.' && lock.importers[directory] === undefined)
    directory = path.dirname(directory);
  return directory;
}

/** An importer's registry packages; a workspace link resolves through the path aliases. */
function registryPackages(directory: string): readonly { directory: string; name: string }[] {
  const entry = lock.importers[directory];
  if (entry === undefined) throw new Error(`Lock has no importer for ${directory}`);
  return [entry.dependencies, entry.devDependencies, entry.optionalDependencies].flatMap((group) =>
    Object.entries(group ?? {})
      .filter(([, dependency]) => !dependency.version.startsWith('link:'))
      .map(([name]) => ({ directory: directory === '.' ? '' : directory, name })),
  );
}

function configurationChain(project: string): readonly string[] {
  const configuration = Bun.JSONC.parse(readFileSync(path.join(root, project), 'utf8')) as {
    readonly extends?: string | readonly string[];
  };
  const parents = configuration.extends === undefined ? [] : [configuration.extends].flat();
  return [
    project,
    ...parents.flatMap((parent) => {
      if (!parent.startsWith('.'))
        throw new Error(`Type project extends a configuration it does not hold: ${project}`);
      return configurationChain(
        path.relative(root, path.resolve(root, path.dirname(project), parent)),
      );
    }),
  ];
}

/**
 * What a type check of `project` reads: the files the compiler itself lists for it (the
 * project's own and everything they import), its configuration chain, the manifests the
 * compiler consults above each file, and the registry packages of every importer involved.
 */
async function typeInputs(project: string) {
  const compiler = Bun.spawn(
    [
      process.execPath,
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '-p',
      project,
      '--listFilesOnly',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  const [listing, diagnostics, exitCode] = await Promise.all([
    new Response(compiler.stdout).text(),
    new Response(compiler.stderr).text(),
    compiler.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Compiler listed no files for ${project}: ${diagnostics}`);
  const files = new Set(configurationChain(project));
  const artifacts = new Set<string>();
  const importers = new Set(['.', importer(project)]);
  for (const listed of listing.split('\n')) {
    if (listed === '') continue;
    const relative = path.relative(root, listed);
    if (!path.isAbsolute(listed) || relative.startsWith('..'))
      throw new Error(`Compiler listed a file outside the repository for ${project}: ${listed}`);
    if (relative.split(path.sep).includes('node_modules')) continue;
    const producer = generatedPackages.get(path.dirname(relative));
    if (producer !== undefined) {
      artifacts.add(producer);
      continue;
    }
    files.add(relative);
    importers.add(importer(relative));
    for (let directory = path.dirname(relative); ; directory = path.dirname(directory)) {
      const manifest = path.join(directory, 'package.json');
      if (existsSync(path.join(root, manifest))) files.add(manifest);
      if (directory === '.') break;
    }
  }
  return {
    files: [...files].sort(),
    artifacts: [...artifacts].sort(),
    packages: [...importers]
      .sort()
      .flatMap(registryPackages)
      .sort((a, b) => `${a.directory}:${a.name}`.localeCompare(`${b.directory}:${b.name}`)),
  };
}
const types = Object.fromEntries(
  await Promise.all(
    typeProjects.map(async (project) => [project, await typeInputs(project)] as const),
  ),
);
const typeHashes = [...new Set(Object.values(types).flatMap((project) => project.files))].map(
  (file) =>
    [
      file,
      createHash('sha256')
        .update(readFileSync(path.join(root, file)))
        .digest('hex'),
    ] as const,
);

const output = process.argv[2];
if (output === undefined) throw new Error('Import inventory requires a declared output path');
const preload = tests['scripts/test-preload.ts'];
delete tests['scripts/test-preload.ts'];
const resolverInputs = [
  'tsconfig.json',
  'tsconfig.base.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'tools/bazel/bun/runtime-inputs.json',
  'tools/bazel/bun/import-inventory.ts',
  'tools/bazel/bun/module-requests.ts',
  'tools/bazel/bun/generate_graph.py',
  'tools/bazel/bun/scripts.BUILD.template',
  'tools/bazel/bun/runtime_sources.bzl',
];
for (const directory of new Set(
  Object.values(tests).flatMap((test) => test.packages.map((item) => item.directory)),
)) {
  if (directory !== '') resolverInputs.push(`${directory}/package.json`);
}
const temporaryOutput = path.join(
  path.dirname(output),
  `.${path.basename(output)}.${process.pid}.tmp`,
);
await Bun.write(
  temporaryOutput,
  `${JSON.stringify(
    {
      tests,
      preload,
      types,
      sourceHashes: Object.fromEntries(
        [
          ...typeHashes,
          ...[...parsed].map(([file, inputs]) => [file, inputs.sourceSha256] as const),
        ].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      ),
      directoryInputs: Object.fromEntries([...directoryInputs].sort()),
      resolverHashes: Object.fromEntries(
        resolverInputs.sort().map((file) => [
          file,
          createHash('sha256')
            .update(readFileSync(path.join(root, file)))
            .digest('hex'),
        ]),
      ),
    },
    null,
    2,
  )}\n`,
);
await rename(temporaryOutput, output);
