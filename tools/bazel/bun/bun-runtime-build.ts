import { writeFileSync } from 'node:fs';
import path from 'node:path';

interface SourceDependency {
  readonly name: string;
  readonly enabled?: (configuration: Readonly<Record<string, unknown>>) => boolean;
  readonly source: (configuration: Readonly<Record<string, unknown>>) => unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Evaluate the pinned original dependency definitions, without invoking fetch/build tools. */
export async function originalSourceRequirements(sourceRoot: string): Promise<unknown> {
  const dependencies: unknown = await import(path.join(sourceRoot, 'scripts/build/deps/index.ts'));
  const webkit: unknown = await import(path.join(sourceRoot, 'scripts/build/deps/webkit.ts'));
  const nodejs: unknown = await import(
    path.join(sourceRoot, 'scripts/build/deps/nodejs-headers.ts')
  );
  if (
    !record(dependencies) ||
    !Array.isArray(dependencies.allDeps) ||
    !record(webkit) ||
    typeof webkit.WEBKIT_VERSION !== 'string' ||
    !record(nodejs) ||
    typeof nodejs.NODEJS_VERSION !== 'string'
  )
    throw new Error('Original Bun dependency definitions are absent');
  const configured = [];
  for (const os of ['darwin', 'linux']) {
    for (const arch of ['aarch64', 'x64']) {
      const configuration = {
        os,
        arch,
        abi: os === 'linux' ? 'gnu' : undefined,
        linux: os === 'linux',
        darwin: os === 'darwin',
        windows: false,
        freebsd: false,
        unix: true,
        x64: arch === 'x64',
        arm64: arch === 'aarch64',
        asan: false,
        lto: true,
        tinycc: true,
        staticSqlite: true,
        webkit: 'prebuilt',
        webkitVersion: webkit.WEBKIT_VERSION,
        nodejsVersion: nodejs.NODEJS_VERSION,
        cwd: sourceRoot,
        buildDir: path.join(sourceRoot, 'build/release'),
        cacheDir: path.join(sourceRoot, 'cache'),
        vendorDir: path.join(sourceRoot, 'vendor'),
        localDeps: {},
      };
      const sources = [];
      const names = new Set<string>();
      for (const value of dependencies.allDeps) {
        if (!record(value) || typeof value.name !== 'string' || typeof value.source !== 'function')
          throw new Error('Original Bun dependency definition changed');
        if (names.has(value.name)) throw new Error('Original Bun dependency name repeats');
        names.add(value.name);
        if (value.enabled !== undefined && typeof value.enabled !== 'function')
          throw new Error('Original Bun dependency condition changed');
        const dependency = value as unknown as SourceDependency;
        if (dependency.enabled !== undefined && !dependency.enabled(configuration)) continue;
        const source = dependency.source(configuration);
        if (!record(source)) throw new Error('Original Bun dependency source is absent');
        let acquisition: Readonly<Record<string, unknown>>;
        if (
          source.kind === 'github-archive' &&
          typeof source.repo === 'string' &&
          typeof source.commit === 'string'
        ) {
          // This URL grammar is the original scripts/build/fetch-cli.ts fetchDep.
          acquisition = {
            kind: source.kind,
            repository: source.repo,
            revision: source.commit,
            url: `https://github.com/${source.repo}/archive/${source.commit}.tar.gz`,
          };
        } else if (
          source.kind === 'prebuilt' &&
          typeof source.url === 'string' &&
          typeof source.identity === 'string'
        ) {
          acquisition = { kind: source.kind, url: source.url, identity: source.identity };
        } else if (source.kind === 'in-tree' && typeof source.path === 'string') {
          acquisition = { kind: source.kind, path: source.path };
        } else
          throw new Error(`Original Bun dependency requires an undeclared source: ${value.name}`);
        sources.push({ name: value.name, ...acquisition });
      }
      configured.push({ os, arch, abi: configuration.abi, lto: true, sources });
    }
  }
  return {
    kind: 'original-bun-source-acquisition-requirements',
    // This candidate build-input configuration grants no compiler/link source selection.
    configuration: 'native-release-lto-build-inputs',
    configured,
  };
}

if (import.meta.main) {
  const [sourceRoot, output] = process.argv.slice(2);
  if (sourceRoot === undefined || output === undefined)
    throw new Error('Explicit original Bun source and acquisition output required');
  writeFileSync(
    output,
    `${JSON.stringify(await originalSourceRequirements(sourceRoot), null, 2)}\n`,
    {
      flag: 'wx',
    },
  );
}
