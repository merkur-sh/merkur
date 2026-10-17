/**
 * What the vendored transport crates' own tests compile from under Bazel: a crate hub of their
 * own, `@vendored_crates`, over the workspace this script writes into `tools/bazel/vendored`.
 *
 * The vendored crates replace crates.io's through `[patch.crates-io]`, and the release workspace
 * excludes them (`Cargo.toml`'s `exclude`), so neither it nor its crate hub holds their
 * dev-dependencies. Their workspace holds each as a member: the vendored manifest, its library at
 * the vendored source and no other target, with every vendored crate name patched to its member,
 * so a crate is tested against the vendored crates it links. Its lock is the release lock with
 * the dev-dependencies added, so every crate the release links keeps its version; `crates.bzl`
 * declares each member's library with the features Cargo resolves for the workspace's tests on
 * each platform, and `//tools/bazel/vendored` declares the tests.
 *
 *   bun run build:vendored-workspace                rewrite the workspace, `crates.bzl` and the hub
 *   bun run build:vendored-workspace --update-lock  relock from the release lock first
 */

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Schema } from 'effect';
import {
  fromCargo,
  MEMBERS,
  type MemberEdge,
  Metadata,
  memberEdges as memberEdgesOf,
  NATIVE_TRIPLES,
  type NativeTriple,
  perPlatform,
  runCargo,
  TREE_FORMAT,
  treeCrates,
  writeWorkspace,
} from './cargo-graph';
import { cargoEnvironment, manifestText, root as ROOT } from './generated-cargo-workspace';

export const VENDORED_WORKSPACE = 'tools/bazel/vendored';
const HUB = 'vendored_crates';
/** Cargo's target directory for resolving: outside the checkout, and never built into. */
const TARGET = mkdtempSync(path.join(tmpdir(), 'merkur-vendored-target-'));

const Workspace = Schema.Struct({
  workspace: Schema.Struct({ exclude: Schema.Array(Schema.String) }),
});

/** A dependency: its version alone, or its detailed table. */
const Dependency = Schema.Union([
  Schema.String,
  Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Boolean, Schema.Array(Schema.String)]),
  ),
]);
const Dependencies = Schema.Record(Schema.String, Dependency);
type Dependencies = typeof Dependencies.Type;

const Tables = Schema.Struct({
  dependencies: Schema.optionalKey(Dependencies),
  'dev-dependencies': Schema.optionalKey(Dependencies),
  'build-dependencies': Schema.optionalKey(Dependencies),
});
type Tables = typeof Tables.Type;

/** The manifest tables this script reads or rewrites; every other table is carried over as is. */
const Manifest = Schema.StructWithRest(
  Schema.Struct({
    ...Tables.fields,
    package: Schema.StructWithRest(
      Schema.Struct({
        name: Schema.String,
        version: Schema.String,
        edition: Schema.String,
        build: Schema.optionalKey(Schema.Union([Schema.String, Schema.Boolean])),
      }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
    lib: Schema.Struct({ name: Schema.String, path: Schema.String }),
    target: Schema.optionalKey(Schema.Record(Schema.String, Tables)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
type Manifest = typeof Manifest.Type;

interface Vendored {
  /** The crate's checkout directory, `packages/quinn-proto-patch`. */
  readonly directory: string;
  readonly name: string;
  readonly version: string;
  readonly edition: string;
  readonly library: string;
  readonly libraryPath: string;
  /** The build script, by its path in the crate, when the crate has one. */
  readonly buildScript: string | null;
  /** The repository `MODULE.bazel` mounts the crate's files as. */
  readonly repository: string;
  /** The vendored manifest, which the member's manifest is made from. */
  readonly manifest: Manifest;
}

/** The vendored crates: the directories the release workspace excludes. */
export function vendoredDirectories(root = ROOT): string[] {
  return [
    ...Schema.decodeUnknownSync(Workspace)(
      Bun.TOML.parse(readFileSync(path.join(root, 'Cargo.toml'), 'utf8')),
    ).workspace.exclude,
  ].sort();
}

function vendored(directory: string): Vendored {
  const manifest = Schema.decodeUnknownSync(Manifest)(
    Bun.TOML.parse(readFileSync(path.join(ROOT, directory, 'Cargo.toml'), 'utf8')),
  );
  const build = manifest.package.build;
  return {
    directory,
    name: manifest.package.name,
    version: manifest.package.version,
    edition: manifest.package.edition,
    library: manifest.lib.name,
    libraryPath: manifest.lib.path,
    buildScript:
      build === undefined || build === false ? null : build === true ? 'build.rs' : build,
    repository: `vendored_${path.basename(directory).replaceAll('-', '_')}`,
    manifest,
  };
}

/** A member's directory in the workspace: its crate name. */
function memberPath(crate: Vendored): string {
  return `${MEMBERS}/${crate.name}`;
}

const isVersion = Schema.is(Schema.String);

/**
 * A dependency table with each path to another vendored crate pointing at that crate's member. A
 * path anywhere else is outside the workspace this script can write.
 */
function memberDependencies(
  dependencies: Dependencies,
  crate: Vendored,
  members: ReadonlyMap<string, Vendored>,
): Dependencies {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, declared]) => {
      if (isVersion(declared) || declared.path === undefined) return [name, declared];
      const target = members.get(path.posix.join(crate.directory, String(declared.path)));
      if (target === undefined)
        throw new Error(
          `${crate.directory} depends on ${String(declared.path)}, no vendored crate`,
        );
      return [name, { ...declared, path: `../${target.name}` }];
    }),
  );
}

/** A member's dependency tables, each through `memberDependencies`. */
function memberTables(tables: Tables, crate: Vendored, members: ReadonlyMap<string, Vendored>) {
  return Object.fromEntries(
    (['dependencies', 'dev-dependencies', 'build-dependencies'] as const).flatMap((kind) => {
      const dependencies = tables[kind];
      return dependencies === undefined
        ? []
        : [[kind, memberDependencies(dependencies, crate, members)]];
    }),
  );
}

type MemberTables = ReturnType<typeof memberTables>;

/** The member's `target` table, when the vendored manifest has one, as its one entry. */
function memberTargets(
  target: Manifest['target'],
  crate: Vendored,
  members: ReadonlyMap<string, Vendored>,
): [string, Record<string, MemberTables>][] {
  if (target === undefined) return [];
  return [
    [
      'target',
      Object.fromEntries(
        Object.entries(target).map(([key, tables]) => [key, memberTables(tables, crate, members)]),
      ),
    ],
  ];
}

/** What a member leaves out: other targets, and what the workspace root sets for every member. */
const DROPPED = new Set(['bin', 'bench', 'example', 'test', 'patch', 'profile', 'workspace']);

/**
 * One member's manifest: the vendored manifest with its library and build script at the vendored
 * source, its paths to other vendored crates at their members, and every other target table left
 * out.
 */
function memberManifest(crate: Vendored, members: ReadonlyMap<string, Vendored>): string {
  const fromMember = (relative: string) =>
    path.posix.join('../../../../..', crate.directory, relative);
  const { target } = crate.manifest;
  const manifest = {
    ...Object.fromEntries(Object.entries(crate.manifest).filter(([key]) => !DROPPED.has(key))),
    ...memberTables(crate.manifest, crate, members),
    ...Object.fromEntries(memberTargets(target, crate, members)),
    package: {
      ...crate.manifest.package,
      build: crate.buildScript === null ? false : fromMember(crate.buildScript),
      publish: false,
    },
    lib: { name: crate.library, path: fromMember(crate.libraryPath) },
  };
  return [
    `# Generated from ${crate.directory}/Cargo.toml by scripts/vendored-workspace.ts: edit that`,
    '# manifest and rerun the script.',
    manifestText(manifest).trimEnd(),
    '',
  ].join('\n');
}

function rootManifest(crates: readonly Vendored[]): string {
  return [
    '# Generated by scripts/vendored-workspace.ts: the vendored crates, each patched to its member.',
    manifestText({
      workspace: { resolver: '3', members: crates.map(memberPath) },
      patch: {
        'crates-io': Object.fromEntries(
          crates.map((crate) => [crate.name, { path: memberPath(crate) }]),
        ),
      },
    }).trimEnd(),
    '',
  ].join('\n');
}

function cargo(cwd: string, args: readonly string[]): string {
  return runCargo(cwd, args, cargoEnvironment('', TARGET));
}

interface Platform {
  readonly metadata: Metadata;
  readonly features: Map<string, readonly string[]>;
}

/** The crates a normal build of `packages` links on `triple`, each name with its versions. */
function linked(
  directory: string,
  packages: readonly string[],
  triple: NativeTriple,
): Map<string, string> {
  const tree = cargo(directory, [
    'tree',
    '--locked',
    ...packages.flatMap((name) => ['-p', name]),
    '--target',
    triple,
    '-e',
    'normal',
    ...TREE_FORMAT,
  ]);
  const versions = new Map<string, Set<string>>();
  for (const crate of treeCrates(tree).values())
    versions.set(crate.name, new Set([...(versions.get(crate.name) ?? []), crate.version]));
  return new Map([...versions].map(([name, set]) => [name, [...set].sort().join(' ')]));
}

/**
 * What Cargo resolves for the workspace's tests on each platform, after checking that every crate
 * a normal build of the vendored crates links is at the version the release links: the tests
 * build them with their default features and add the dev-dependencies, which move no version.
 */
function resolvePlatforms(
  directory: string,
  crates: readonly Vendored[],
): Map<NativeTriple, Platform> {
  const names = crates.map((crate) => crate.name);
  const platforms = new Map<NativeTriple, Platform>();
  for (const triple of NATIVE_TRIPLES) {
    const here = linked(directory, names, triple);
    const release = linked(ROOT, names, triple);
    const moved = [...here].filter(([name, versions]) => {
      const pinned = release.get(name);
      return pinned !== undefined && pinned !== versions;
    });
    if (moved.length > 0)
      throw new Error(
        `on ${triple} the vendored crates link other versions than the release: ${moved
          .map(([name, versions]) => `${name} ${versions} (release ${release.get(name)})`)
          .join(', ')}; run with --update-lock`,
      );
    const tree = cargo(directory, [
      'tree',
      '--locked',
      '--workspace',
      '--target',
      triple,
      '-e',
      'normal,dev,no-proc-macro',
      ...TREE_FORMAT,
    ]);
    const metadata = Schema.decodeUnknownSync(Metadata)(
      JSON.parse(
        cargo(directory, [
          'metadata',
          '--format-version',
          '1',
          '--locked',
          '--filter-platform',
          triple,
        ]),
      ),
    );
    platforms.set(triple, {
      metadata,
      features: new Map([...treeCrates(tree)].map(([key, crate]) => [key, crate.features])),
    });
  }
  return platforms;
}

function cratesBzl(
  crates: readonly Vendored[],
  platforms: ReadonlyMap<NativeTriple, Platform>,
): string {
  // The vendored crates each depends on, on each platform. A crate imports one under a name of
  // its own (quinn's `proto`), which the same edge carries on every platform.
  const memberEdges = (crate: Vendored) =>
    new Map(
      NATIVE_TRIPLES.map((triple): [NativeTriple, readonly MemberEdge[]] => {
        const metadata = platforms.get(triple)?.metadata;
        if (metadata === undefined) return [triple, []];
        const ids = new Map<string, Vendored>();
        let id: string | undefined;
        for (const entry of metadata.packages) {
          if (entry.source !== null) continue;
          if (entry.name === crate.name) id = entry.id;
          for (const candidate of crates)
            if (entry.name === candidate.name) ids.set(entry.id, candidate);
        }
        return [triple, memberEdgesOf(metadata, ids, id, false) ?? []];
      }),
    );
  const renames = (edges: ReadonlyMap<NativeTriple, readonly MemberEdge[]>) => {
    const renamed = new Map<string, string>();
    for (const list of edges.values())
      for (const edge of list)
        if (edge.name !== edge.label.slice(1)) renamed.set(edge.label, edge.name);
    return [...renamed].sort(([a], [b]) => a.localeCompare(b));
  };
  const output = [
    '"""Generated by scripts/vendored-workspace.ts: the vendored crates, compiled with the features',
    "Cargo resolves for their workspace's tests on each platform.",
    '"""',
    '',
    `load("@${HUB}//:defs.bzl", "aliases", "all_crate_deps")`,
    'load("@rules_rust//cargo:defs.bzl", "cargo_build_script")',
    'load("@rules_rust//rust:defs.bzl", "rust_library")',
    '',
    "# Each vendored crate's package in the hub, by its library, for its test's dependencies.",
    'PACKAGES = {',
    ...crates.map(
      (crate) => `    "${crate.library}": "${VENDORED_WORKSPACE}/${memberPath(crate)}",`,
    ),
    '}',
    '',
    "# Each vendored crate's features, which its library and its test compile with.",
    'FEATURES = {',
    ...crates.map((crate) => {
      const features = new Map(
        NATIVE_TRIPLES.map((triple) => [
          triple,
          platforms.get(triple)?.features.get(`${crate.name} ${crate.version}`) ?? [],
        ]),
      );
      return `    "${crate.library}": ${perPlatform(features, '    ')},`;
    }),
    '}',
    '',
    'def vendored_crates():',
    '    """Declares each vendored crate\'s library."""',
  ];
  for (const crate of crates) {
    const packageName = `${VENDORED_WORKSPACE}/${memberPath(crate)}`;
    if (crate.buildScript !== null) {
      output.push(
        '    cargo_build_script(',
        `        name = "${crate.library}_build_script",`,
        `        srcs = ["@${crate.repository}//:${crate.buildScript}"],`,
        `        crate_root = "@${crate.repository}//:${crate.buildScript}",`,
        `        edition = "${crate.edition}",`,
        `        version = "${crate.version}",`,
        `        deps = all_crate_deps(build = True, package_name = "${packageName}"),`,
        '    )',
      );
    }
    const buildScript = crate.buildScript === null ? '' : ` + [":${crate.library}_build_script"]`;
    const edges = memberEdges(crate);
    const renamed = renames(edges);
    const aliasSuffix =
      renamed.length === 0
        ? ''
        : ` | {${renamed.map(([label, name]) => `"${label}": "${name}"`).join(', ')}}`;
    const deps = new Map(
      [...edges].map(([triple, list]) => [triple, list.map((edge) => edge.label)]),
    );
    output.push(
      '    rust_library(',
      `        name = "${crate.library}",`,
      `        srcs = ["@${crate.repository}//:srcs"],`,
      `        aliases = aliases(package_name = "${packageName}")${aliasSuffix},`,
      `        crate_features = FEATURES["${crate.library}"],`,
      `        crate_root = "@${crate.repository}//:${crate.libraryPath}",`,
      `        edition = "${crate.edition}",`,
      `        proc_macro_deps = all_crate_deps(proc_macro = True, package_name = "${packageName}"),`,
      '        tags = ["noclippy"],',
      `        version = "${crate.version}",`,
      `        deps = ${perPlatform(deps, '        ')} + all_crate_deps(normal = True, package_name = "${packageName}")${buildScript},`,
      '    )',
    );
  }
  output.push('');
  return output.join('\n');
}

function hub(crates: readonly Vendored[]): string {
  return [
    "# Generated by scripts/vendored-workspace.ts: the vendored crates' crate hub, over their own",
    '# workspace.',
    '',
    'crate = use_extension("@rules_rust//crate_universe:extensions.bzl", "crate")',
    '',
    ...fromCargo(
      HUB,
      VENDORED_WORKSPACE,
      crates.map((crate) => crate.name),
      NATIVE_TRIPLES,
    ),
    '',
    `use_repo(crate, "${HUB}")`,
    '',
  ].join('\n');
}

if (import.meta.main) {
  const crates = vendoredDirectories().map(vendored);
  const byDirectory = new Map(crates.map((crate) => [crate.directory, crate]));
  const directory = path.join(ROOT, VENDORED_WORKSPACE);
  const lock = path.join(directory, 'Cargo.lock');
  try {
    writeWorkspace(
      directory,
      rootManifest(crates),
      new Map(crates.map((crate) => [crate.name, memberManifest(crate, byDirectory)])),
    );
    if (process.argv.includes('--update-lock') || !existsSync(lock)) {
      // The release lock pins every crate the vendored crates link; Cargo adds the rest.
      copyFileSync(path.join(ROOT, 'Cargo.lock'), lock);
      cargo(directory, ['metadata', '--format-version', '1']);
    }
    writeFileSync(
      path.join(directory, 'crates.bzl'),
      cratesBzl(crates, resolvePlatforms(directory, crates)),
    );
    writeFileSync(path.join(directory, 'hub.MODULE.bazel'), hub(crates));
  } finally {
    rmSync(TARGET, { recursive: true, force: true });
  }
}
