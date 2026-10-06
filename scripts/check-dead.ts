import { readdir } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_ROOTS = ['apps', 'packages', 'scripts', 'spikes', 'tests'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];
const ENTRYPOINT_BASENAMES = new Set([
  'index.ts',
  'main.ts',
  'main.tsx',
  'sw.ts',
  'terminal-worker.ts',
  // Loaded by `bunfig.toml`'s `[test] preload`, not by an import.
  'test-preload.ts',
  'transport-worker.ts',
]);
const IGNORED_PATH_PARTS = new Set(['node_modules', 'dist', 'target', '.git']);
const IGNORED_FILE_SUFFIXES = ['generated-types.ts'];
const IMPORT_SPECIFIER_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const COMMAND_SOURCE_PATH_PATTERN = /(?:scripts|spikes)\/[A-Za-z0-9_./-]+\.ts/g;
const LOCAL_SOURCE_PATH_PATTERN = /['"`](\.{1,2}\/[A-Za-z0-9_./-]+\.tsx?)['"`]/g;
// A `bun_binary` launches its `entry_point`; no package script names that file.
const BAZEL_ENTRY_POINT_PATTERN =
  /\bentry_point = "(?:\/\/([A-Za-z0-9_./-]*):)?([A-Za-z0-9_./-]+\.ts)"/g;

const sourceFiles = await discoverSourceFiles();
const sourceFileSet = new Set(sourceFiles);
const commandEntrypoints = await readCommandEntrypoints(sourceFileSet);
const roots = sourceFiles.filter((filePath) => isEntrypoint(filePath, commandEntrypoints));
const reachable = await collectReachableFiles(roots, sourceFileSet);
const unreachable = sourceFiles
  .filter((filePath) => !reachable.has(filePath))
  .filter((filePath) => !isIgnoredSource(filePath));

if (unreachable.length > 0) {
  process.stderr.write('Unreachable TypeScript source files:\n');
  for (const filePath of unreachable) {
    process.stderr.write(`- ${filePath}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `No unreachable TypeScript source files found (${sourceFiles.length} files checked).\n`,
);

async function discoverSourceFiles(): Promise<string[]> {
  const discovered: string[] = [];
  for (const root of SOURCE_ROOTS) {
    await walk(root, discovered);
  }
  return discovered.sort((left, right) => left.localeCompare(right));
}

async function walk(directory: string, discovered: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_PATH_PARTS.has(entry.name)) {
        await walk(filePath, discovered);
      }
      continue;
    }

    if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
      if (!entry.name.endsWith('.d.ts')) {
        discovered.push(normalizePath(filePath));
      }
    }
  }
}

function isEntrypoint(filePath: string, commandEntrypoints: ReadonlySet<string>): boolean {
  if (commandEntrypoints.has(filePath) || filePath.startsWith('tests/')) {
    return true;
  }

  if (filePath.includes('/scripts/')) {
    return true;
  }

  if (filePath.includes('/migrations/') || filePath.endsWith('.test.ts')) {
    return true;
  }

  if (filePath.endsWith('vite.config.ts') || filePath.endsWith('uno.config.ts')) {
    return true;
  }

  // The site finds a post's figures and cover by their directory (`blogPages()`), not by an import.
  if (filePath.includes('/blog/posts/')) {
    return true;
  }

  return ENTRYPOINT_BASENAMES.has(path.basename(filePath));
}

async function collectReachableFiles(
  roots: readonly string[],
  sourceFileSet: ReadonlySet<string>,
): Promise<Set<string>> {
  const reachable = new Set<string>();
  const pending = [...roots];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || reachable.has(current)) {
      continue;
    }

    reachable.add(current);
    const imports = await readImports(current);
    for (const specifier of imports) {
      const resolved = resolveImport(current, specifier, sourceFileSet);
      if (resolved !== null && !reachable.has(resolved)) {
        pending.push(resolved);
      }
    }
  }

  return reachable;
}

async function readImports(filePath: string): Promise<string[]> {
  const content = await Bun.file(filePath).text();
  const imports: string[] = [];
  for (const match of content.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) {
      imports.push(specifier);
    }
  }
  for (const match of content.matchAll(LOCAL_SOURCE_PATH_PATTERN)) {
    const sourcePath = match[1];
    if (sourcePath !== undefined) imports.push(sourcePath);
  }
  for (const match of content.matchAll(COMMAND_SOURCE_PATH_PATTERN)) {
    const sourcePath = match[0];
    if (sourcePath !== filePath) imports.push(sourcePath);
  }
  return imports;
}

function resolveImport(
  importer: string,
  specifier: string,
  sourceFileSet: ReadonlySet<string>,
): string | null {
  if (specifier.startsWith('.')) {
    return resolveCandidate(path.join(path.dirname(importer), specifier), sourceFileSet);
  }

  if (specifier.startsWith('scripts/') || specifier.startsWith('spikes/')) {
    return sourceFileSet.has(specifier) ? specifier : null;
  }

  const aliasPath = resolveWorkspaceAlias(specifier);
  if (aliasPath !== null) {
    return resolveCandidate(aliasPath, sourceFileSet);
  }

  return null;
}

async function readCommandEntrypoints(sourceFileSet: ReadonlySet<string>): Promise<Set<string>> {
  const entrypoints = new Set<string>();
  for (const manifestPath of await discoverPackageManifests()) {
    const manifest: unknown = await Bun.file(manifestPath).json();
    if (!isRecord(manifest) || !isRecord(manifest.scripts)) continue;
    for (const command of Object.values(manifest.scripts)) {
      if (typeof command !== 'string') continue;
      for (const match of command.matchAll(COMMAND_SOURCE_PATH_PATTERN)) {
        const sourcePath = match[0];
        if (sourceFileSet.has(sourcePath)) entrypoints.add(sourcePath);
      }
    }
  }
  for (const buildPath of await discoverBuildFiles()) {
    const content = await Bun.file(buildPath).text();
    for (const match of content.matchAll(BAZEL_ENTRY_POINT_PATTERN)) {
      const sourcePath = normalizePath(
        path.join(match[1] ?? path.dirname(buildPath), match[2] ?? ''),
      );
      if (sourceFileSet.has(sourcePath)) entrypoints.add(sourcePath);
    }
  }
  return entrypoints;
}

async function discoverBuildFiles(): Promise<string[]> {
  const discovered: string[] = [];
  const pending = [...SOURCE_ROOTS, 'tools'];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_PATH_PARTS.has(entry.name)) pending.push(filePath);
      } else if (entry.name === 'BUILD.bazel') discovered.push(filePath);
    }
  }
  return discovered;
}

async function discoverPackageManifests(): Promise<string[]> {
  const manifests = ['package.json'];
  for (const workspaceRoot of ['apps', 'packages']) {
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(workspaceRoot, entry.name, 'package.json');
      if (await Bun.file(manifestPath).exists()) manifests.push(manifestPath);
    }
  }
  return manifests;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resolveWorkspaceAlias(specifier: string): string | null {
  if (specifier === '@merkur/auth') return 'packages/auth/src/index';
  if (specifier === '@merkur/config') return 'packages/config/src/index';
  if (specifier === '@merkur/config/retry-schedules') return 'packages/config/src/retry-schedules';
  if (specifier === '@merkur/keyboard') return 'packages/keyboard/src/index';
  if (specifier.startsWith('@merkur/keyboard/')) {
    return `packages/keyboard/src/${specifier.slice('@merkur/keyboard/'.length)}`;
  }
  if (specifier === '@merkur/logger') return 'packages/logger/src/index';
  if (specifier === '@merkur/protocol') return 'packages/protocol/src/index';
  if (specifier === '@merkur/protocol/channel') return 'packages/protocol/src/channel';
  if (specifier.startsWith('@merkur/quicksilver/')) {
    return `packages/quicksilver/src/${specifier.slice('@merkur/quicksilver/'.length)}`;
  }
  if (specifier === '@merkur/shared') return 'packages/shared/src/index';
  if (specifier === '@merkur/shared/node-signals') return 'packages/shared/src/node-signals';
  if (specifier.startsWith('@merkur/shared/')) {
    return `packages/shared/src/${specifier.slice('@merkur/shared/'.length)}`;
  }
  return null;
}

function resolveCandidate(candidate: string, sourceFileSet: ReadonlySet<string>): string | null {
  const normalized = normalizePath(candidate);
  for (const extension of SOURCE_EXTENSIONS) {
    const withExtension = `${normalized}${extension}`;
    if (sourceFileSet.has(withExtension)) {
      return withExtension;
    }
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const indexFile = `${normalized}/index${extension}`;
    if (sourceFileSet.has(indexFile)) {
      return indexFile;
    }
  }

  return sourceFileSet.has(normalized) ? normalized : null;
}

function isIgnoredSource(filePath: string): boolean {
  return IGNORED_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}
