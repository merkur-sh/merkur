import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface OriginalConfiguration extends Record<string, unknown> {
  readonly os: string;
  readonly arch: string;
  readonly vendorDir: string;
  readonly cacheDir: string;
}
interface OriginalDependency {
  readonly name: string;
  readonly enabled?: (configuration: OriginalConfiguration) => boolean;
  readonly source: (configuration: OriginalConfiguration) => Record<string, unknown>;
  readonly patches?:
    | readonly string[]
    | ((configuration: OriginalConfiguration) => readonly string[]);
}
interface OriginalEngine {
  readonly resolveToolchain: () => Readonly<Record<string, unknown>>;
  readonly configure: (input: unknown) => Promise<{
    readonly cfg: OriginalConfiguration;
    readonly output: Record<string, unknown> & {
      readonly exe?: string;
      readonly strippedExe?: string;
    };
  }>;
}
interface Request {
  readonly source: string;
  readonly sysroot: string;
  readonly llvm: string;
  readonly nightly: string;
  readonly tools: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly commit: string;
  readonly report: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameFile(actual: unknown, expected: string | undefined, name: string): void {
  if (
    typeof actual !== 'string' ||
    expected === undefined ||
    realpathSync(actual) !== realpathSync(expected)
  )
    throw new Error(`Original Bun selected an undeclared ${name}`);
}

/** Validate the original resolved facts before any native build runs. */
export function validateOriginalConfiguration(
  configuration: Readonly<Record<string, unknown>>,
  request: Request,
): void {
  if (
    configuration.version !== '1.4.2' ||
    configuration.revision !== request.commit ||
    configuration.clangVersion !== '21.1.8' ||
    configuration.ci !== true ||
    configuration.buildkite !== false ||
    configuration.lto !== true ||
    configuration.mode !== 'full' ||
    configuration.ccache !== undefined
  )
    throw new Error('Original Bun configuration differs from the declared native release build');
  for (const [field, tool] of Object.entries({
    cc: 'clang',
    cxx: 'clang++',
    hostCc: 'clang',
    hostCxx: 'clang++',
    ar: 'llvm-ar',
    ranlib: 'llvm-ranlib',
    nm: 'llvm-nm',
  }))
    sameFile(configuration[field], path.join(request.llvm, 'bin', tool), field);
  sameFile(configuration.cmake, request.tools.cmake, 'CMake');
  sameFile(configuration.bun, request.tools.bun, 'Bun code generator');
  sameFile(configuration.cargo, path.join(request.nightly, 'bin/cargo'), 'Cargo');
  sameFile(configuration.nasm, request.tools.nasm, 'Nasm');
  sameFile(
    configuration.strip,
    configuration.os === 'linux' ? request.tools.strip : path.join(request.llvm, 'bin/llvm-strip'),
    'strip',
  );
  if (configuration.os === 'darwin') {
    sameFile(configuration.dsymutil, path.join(request.llvm, 'bin/dsymutil'), 'dsymutil');
    sameFile(configuration.osxSysroot, request.sysroot, 'macOS SDK');
  } else if (configuration.os === 'linux') {
    sameFile(configuration.sysroot, request.sysroot, 'Linux sysroot');
  } else throw new Error('Original Bun native runtime requires Linux or macOS');
  if (typeof configuration.rustLld !== 'string' || typeof configuration.ld !== 'string')
    throw new Error('Original nightly linker is absent');
  const relative = path.relative(request.nightly, realpathSync(configuration.rustLld));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))
    throw new Error('Original Bun selected a linker outside the declared nightly SDK');
  sameFile(configuration.ld, configuration.rustLld, 'native nightly linker');
  for (const name of ['perl', 'ninja', 'bash', 'git', 'tar', 'env'])
    sameFile(Bun.which(name), request.tools[name], name);
  sameFile(Bun.which('sh'), request.tools.bash, 'POSIX shell');
  sameFile(process.env.MERKUR_NINJA_SHELL, request.tools.bash, 'Ninja shell');
  sameFile(process.env.MERKUR_NINJA_PYTHON, request.tools.python, 'Ninja Python');
}

interface OriginalModules {
  readonly engine: OriginalEngine;
  readonly config: { readonly resolveConfig: (profile: unknown, toolchain: unknown) => unknown };
  readonly profiles: { readonly getProfile: (name: string) => Record<string, unknown> };
  readonly flags: {
    readonly linkerMapOutputs: (configuration: OriginalConfiguration) => unknown;
    readonly computeFlags: (configuration: OriginalConfiguration) => unknown;
  };
  readonly rust: {
    readonly cargoBuildInvocation: (configuration: OriginalConfiguration) => unknown;
  };
  readonly dependencies: readonly unknown[];
}

async function originalModules(sourceRoot: string): Promise<OriginalModules> {
  const originalEngine: unknown = await import(path.join(sourceRoot, 'scripts/build/configure.ts'));
  const configModule: unknown = await import(path.join(sourceRoot, 'scripts/build/config.ts'));
  const profiles: unknown = await import(path.join(sourceRoot, 'scripts/build/profiles.ts'));
  const flagsModule: unknown = await import(path.join(sourceRoot, 'scripts/build/flags.ts'));
  const rustModule: unknown = await import(path.join(sourceRoot, 'scripts/build/rust.ts'));
  const dependencyModule: unknown = await import(
    path.join(sourceRoot, 'scripts/build/deps/index.ts')
  );
  if (
    !record(originalEngine) ||
    typeof originalEngine.resolveToolchain !== 'function' ||
    typeof originalEngine.configure !== 'function' ||
    !record(configModule) ||
    typeof configModule.resolveConfig !== 'function' ||
    !record(profiles) ||
    typeof profiles.getProfile !== 'function' ||
    !record(flagsModule) ||
    typeof flagsModule.linkerMapOutputs !== 'function' ||
    typeof flagsModule.computeFlags !== 'function' ||
    !record(rustModule) ||
    typeof rustModule.cargoBuildInvocation !== 'function' ||
    !record(dependencyModule) ||
    !Array.isArray(dependencyModule.allDeps)
  )
    throw new Error('Pinned original Bun native configure engine is absent');
  return {
    engine: originalEngine as unknown as OriginalEngine,
    config: configModule as unknown as OriginalModules['config'],
    profiles: profiles as unknown as OriginalModules['profiles'],
    flags: flagsModule as unknown as OriginalModules['flags'],
    rust: rustModule as unknown as OriginalModules['rust'],
    dependencies: dependencyModule.allDeps,
  };
}

function nativeOverrides(request: Request) {
  if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch))
    throw new Error('Original Bun native runtime requires the declared four platform families');
  return {
    os: process.platform === 'darwin' ? 'darwin' : 'linux',
    arch: process.arch === 'arm64' ? 'aarch64' : 'x64',
    abi: process.platform === 'linux' ? 'gnu' : undefined,
    ci: true,
    buildkite: false,
    mode: 'full',
    lto: true,
    packageManager: 'bun',
    buildDir: path.join(request.source, 'build/release'),
    cacheDir: path.join(request.source, 'cache'),
    linuxSysroot: request.sysroot,
  };
}

interface AcquiredDependency {
  readonly name: string;
  readonly kind: string;
  readonly url: string;
  readonly directory: string;
}

function originalArchive(
  dependency: OriginalDependency,
  source: Readonly<Record<string, unknown>>,
  cfg: OriginalConfiguration,
  sourceRoot: string,
): {
  readonly url: string;
  readonly kind: string;
  readonly directory: string;
  readonly arguments_: string[];
} {
  let arguments_: string[];
  let url: string;
  let directory: string;
  let kind: string;
  if (
    source.kind === 'github-archive' &&
    typeof source.repo === 'string' &&
    typeof source.commit === 'string'
  ) {
    kind = 'github-archive';
    url = `https://github.com/${source.repo}/archive/${source.commit}.tar.gz`;
    const patches =
      typeof dependency.patches === 'function'
        ? dependency.patches(cfg)
        : (dependency.patches ?? []);
    directory = path.join(cfg.vendorDir, dependency.name);
    arguments_ = [
      'dep',
      dependency.name,
      source.repo,
      source.commit,
      directory,
      path.join(cfg.cacheDir, 'tarballs'),
      ...patches.map((file) => path.resolve(sourceRoot, file)),
    ];
  } else if (
    source.kind === 'prebuilt' &&
    typeof source.url === 'string' &&
    typeof source.identity === 'string'
  ) {
    kind = 'prebuilt';
    url = source.url;
    if (source.destDir !== undefined && typeof source.destDir !== 'string')
      throw new Error('Original prebuilt destination changed');
    const removal = source.rmAfterExtract ?? [];
    if (!Array.isArray(removal) || !removal.every((file) => typeof file === 'string'))
      throw new Error('Original prebuilt removal changed');
    directory = source.destDir ?? path.join(cfg.vendorDir, dependency.name);
    arguments_ = ['prebuilt', dependency.name, url, directory, source.identity, ...removal];
  } else throw new Error('Original dependency has no declared archive acquisition');
  return { url, kind, directory, arguments_ };
}

function acquireOriginalDependencies(
  request: Request,
  cfg: OriginalConfiguration,
  dependencies: readonly unknown[],
): AcquiredDependency[] {
  const consumed = new Set<string>();
  const acquired: AcquiredDependency[] = [];
  for (const value of dependencies) {
    if (!record(value) || typeof value.name !== 'string' || typeof value.source !== 'function')
      throw new Error('Original native dependency definition changed');
    const dependency = value as unknown as OriginalDependency;
    if (dependency.enabled !== undefined && !dependency.enabled(cfg)) continue;
    const source = dependency.source(cfg);
    if (source.kind === 'in-tree') continue;
    const { url, kind, directory, arguments_ } = originalArchive(
      dependency,
      source,
      cfg,
      request.source,
    );
    if (request.dependencies[dependency.name] !== url || consumed.has(dependency.name))
      throw new Error('Original dependency differs from its declared offline archive');
    consumed.add(dependency.name);
    const bun = request.tools.bun;
    if (bun === undefined) throw new Error('Declared Bun code generator is absent');
    const result = spawnSync(
      bun,
      [path.join(request.source, 'scripts/build/fetch-cli.ts'), ...arguments_],
      { cwd: request.source, env: process.env, stdio: 'inherit' },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) throw new Error('Original offline dependency acquisition failed');
    acquired.push({ name: dependency.name, kind, url, directory });
  }
  if (consumed.size !== Object.keys(request.dependencies).length)
    throw new Error(
      'Declared native dependency closure differs from the original configured graph',
    );
  return acquired;
}

function writeOriginalReport(
  request: Request,
  result: Awaited<ReturnType<OriginalEngine['configure']>>,
  flagsModule: OriginalModules['flags'],
  rustModule: OriginalModules['rust'],
  dependencySources: readonly AcquiredDependency[],
): void {
  const runtime = result.output.strippedExe ?? result.output.exe;
  if (runtime === undefined) throw new Error('Original configure emitted no runtime');
  // These are the pinned engine's actual configured edges and side-products.
  // The link map/DWARF, not this configured inventory, determine retained code.
  writeFileSync(
    request.report,
    `${JSON.stringify(
      {
        cfg: result.cfg,
        runtime,
        output: result.output,
        linkerMaps: flagsModule.linkerMapOutputs(result.cfg),
        flags: flagsModule.computeFlags(result.cfg),
        cargo: rustModule.cargoBuildInvocation(result.cfg),
        dependencySources,
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  );
}

export async function configureOriginal(request: Request): Promise<void> {
  const modules = await originalModules(request.source);
  const engine = modules.engine;
  const overrides = nativeOverrides(request);
  const configuration: unknown = modules.config.resolveConfig(
    { ...modules.profiles.getProfile('release'), ...overrides },
    engine.resolveToolchain(),
  );
  if (!record(configuration)) throw new Error('Original Bun resolved no native configuration');
  validateOriginalConfiguration(configuration, request);
  const cfg = configuration as OriginalConfiguration;
  const acquired = acquireOriginalDependencies(request, cfg, modules.dependencies);
  const result = await engine.configure({ profile: 'release', overrides });
  validateOriginalConfiguration(result.cfg, request);
  writeOriginalReport(request, result, modules.flags, modules.rust, acquired);
}

if (import.meta.main) {
  const request = process.argv[2];
  if (request === undefined) throw new Error('Declared native Bun action request is required');
  await configureOriginal(JSON.parse(readFileSync(request, 'utf8')) as Request);
}
