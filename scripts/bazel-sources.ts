/**
 * The packages `//:sources` gathers (`tools/bazel/sources.bzl`), and the files each Bun test
 * loads (`tools/bazel/modules.bzl`, `scripts/bazel-modules.ts`).
 *
 * The tests that read the checkout as a whole (the static gates) take every package's `:files`,
 * which `package_files()` declares in each `BUILD.bazel`. Bazel cannot list its own packages, so
 * this script does, from the `BUILD.bazel` files Git sees, and checks each declares its files.
 * Each pnpm importer's dependencies come from `pnpm-lock.yaml`.
 *
 *   bun run scripts/bazel-sources.ts           rewrite both files
 *   bun run scripts/bazel-sources.ts --check   fail when either or a package is stale
 */

import { readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Schema } from 'effect';
import { bazelModules, MODULES } from './bazel-modules';

const ROOT = path.resolve(import.meta.dir, '..');
export const SOURCES = 'tools/bazel/sources.bzl';

/** Every package below the root, by directory, as Git sees its `BUILD.bazel`. */
export function bazelPackages(root = ROOT): string[] {
  const listing = Bun.spawnSync(
    ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '*BUILD.bazel'],
    { cwd: root, stdout: 'pipe', stderr: 'inherit' },
  );
  if (listing.exitCode !== 0) throw new Error('git ls-files failed');
  return listing.stdout
    .toString()
    .split('\n')
    .filter((file) => file.endsWith('/BUILD.bazel'))
    .map((file) => path.posix.dirname(file))
    .sort();
}

/** The pnpm workspace's packages, which each hold a `package.json`. */
function workspacePackages(packages: readonly string[], root: string): string[] {
  return packages.filter(
    (directory) =>
      /^(apps|packages)\/[^/]+$/.test(directory) &&
      Bun.file(path.join(root, directory, 'package.json')).size > 0,
  );
}

const Manifest = Schema.Struct({ name: Schema.String });

/** Each workspace package's npm name, with its directory. */
function workspaceNames(directories: readonly string[], root: string): [string, string][] {
  return directories
    .map((directory): [string, string] => [
      Schema.decodeUnknownSync(Manifest)(
        JSON.parse(readFileSync(path.join(root, directory, 'package.json'), 'utf8')),
      ).name,
      directory,
    ])
    .sort(([a], [b]) => a.localeCompare(b));
}

const Importer = Schema.Struct({
  dependencies: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ version: Schema.String })),
  ),
  devDependencies: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ version: Schema.String })),
  ),
  optionalDependencies: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ version: Schema.String })),
  ),
});
const Lockfile = Schema.Struct({ importers: Schema.Record(Schema.String, Importer) });

/**
 * Each pnpm importer's direct dependencies, by its directory (the root's is ''): the third-party
 * ones, which its `:node_modules` links from the store, and the workspace packages it links.
 */
function importerDependencies(root: string): [string, string[], string[]][] {
  const { importers } = Schema.decodeUnknownSync(Lockfile)(
    Bun.YAML.parse(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')),
    { onExcessProperty: 'ignore' },
  );
  return Object.entries(importers)
    .map(([directory, importer]): [string, string[], string[]] => {
      const dependencies = Object.entries({
        ...importer.dependencies,
        ...importer.devDependencies,
        ...importer.optionalDependencies,
      });
      const workspace = ({ version }: { version: string }) => version.startsWith('link:');
      return [
        directory === '.' ? '' : directory,
        dependencies
          .filter(([, spec]) => !workspace(spec))
          .map(([name]) => name)
          .sort(),
        dependencies
          .filter(([, spec]) => workspace(spec))
          .map(([name]) => name)
          .sort(),
      ];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

/** The checkout's tracked symlinks, by path, with their targets. */
function trackedSymlinks(root: string): [string, string][] {
  const listing = Bun.spawnSync(['git', 'ls-files', '-s'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  if (listing.exitCode !== 0) throw new Error('git ls-files failed');
  const links: [string, string][] = [];
  for (const line of listing.stdout.toString().split('\n')) {
    const match = line.match(/^120000 \S+ \d\t(.+)$/);
    if (match?.[1] !== undefined) links.push([match[1], readlinkSync(path.join(root, match[1]))]);
  }
  return links.sort(([a], [b]) => a.localeCompare(b));
}

export function bazelSources(root = ROOT): string {
  const packages = bazelPackages(root);
  const workspace = workspacePackages(packages, root);
  const list = (directories: readonly string[]) =>
    directories.map((directory) => `    "//${directory}",`);
  const importers = importerDependencies(root);
  const byImporter = (pick: (entry: [string, string[], string[]]) => string[]) =>
    importers
      .filter((entry) => pick(entry).length > 0)
      .flatMap((entry) => [
        `    "${entry[0]}": [`,
        ...pick(entry).map((name) => `        "${name}",`),
        '    ],',
      ]);
  return [
    '"""Generated by scripts/bazel-sources.ts: the packages `//:sources` gathers."""',
    '',
    '# Every package below the root.',
    'PACKAGES = [',
    ...list(packages),
    ']',
    '',
    "# The checkout's symlinks, which a checkout of `//:sources` recreates.",
    'SYMLINKS = {',
    ...trackedSymlinks(root).map(([link, target]) => `    "${link}": "${target}",`),
    '}',
    '',
    "# Each workspace package's directory, by the name a checkout's `node_modules` links it under.",
    'WORKSPACE_LINKS = {',
    ...workspaceNames(workspace, root).map(([name, directory]) => `    "${name}": "${directory}",`),
    '}',
    '',
    "# Each pnpm importer's third-party dependencies, by its directory, which its `:node_modules`",
    '# links from the store.',
    'THIRD_PARTY_DEPENDENCIES = {',
    ...byImporter(([, thirdParty]) => thirdParty),
    '}',
    '',
    '# The workspace packages each pnpm importer depends on, by its directory.',
    'WORKSPACE_DEPENDENCIES = {',
    ...byImporter(([, , workspaceDependencies]) => workspaceDependencies),
    '}',
    '',
  ].join('\n');
}

/** The packages whose `BUILD.bazel` declares no `package_files()`. */
export function packagesWithoutFiles(root = ROOT): string[] {
  return bazelPackages(root).filter(
    (directory) =>
      !/^package_files\(/m.test(readFileSync(path.join(root, directory, 'BUILD.bazel'), 'utf8')),
  );
}

if (import.meta.main) {
  const expected: [string, string][] = [
    [SOURCES, bazelSources()],
    [MODULES, bazelModules(ROOT, ['', ...bazelPackages()])],
  ];
  const missing = packagesWithoutFiles();
  if (process.argv.includes('--check')) {
    const stale = expected.filter(
      ([file, content]) => readFileSync(path.join(ROOT, file), 'utf8') !== content,
    );
    for (const [file] of stale)
      process.stderr.write(`${file} is stale: bun run scripts/bazel-sources.ts\n`);
    for (const directory of missing)
      process.stderr.write(`${directory}/BUILD.bazel declares no package_files()\n`);
    process.exitCode = stale.length > 0 || missing.length > 0 ? 1 : 0;
  } else {
    for (const [file, content] of expected) writeFileSync(path.join(ROOT, file), content);
    for (const directory of missing)
      process.stderr.write(`${directory}/BUILD.bazel declares no package_files()\n`);
  }
}
