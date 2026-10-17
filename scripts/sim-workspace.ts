/**
 * What the network simulator (`tools/sim`) compiles from under Bazel: a crate hub of its own,
 * `@sim_crates`, over the workspace this script writes into `tools/bazel/sim`.
 *
 * The simulator links the production crates against turmoil and tokio's `test-util`, which must
 * never reach a shipped build, so it resolves apart from the release workspace, from its own
 * `tools/sim/Cargo.lock`. Its workspace holds the simulator as the root package and, as
 * members, every checkout crate it reaches by path or through a patch: crate_universe renders
 * nothing for a member into the checkout, and `crates.bzl` declares their targets with the
 * features Cargo resolves for the simulator on each platform. A member's manifest keeps its own
 * dependency tables but no dev-dependencies, and no default features, which its dependents name
 * instead, so no member resolves with features the simulator does not ask of it. The vendored
 * transport crates stay patches, as in the release workspace (`REPO.bazel`).
 *
 * Generating checks that Cargo resolves every crate with exactly the features it resolves them
 * with in the workspace `scripts/sim-tests.ts` builds, where the checkout's crates are path
 * dependencies, on every platform.
 *
 *   bun run build:sim-workspace    rewrite the workspace, its lock, `crates.bzl` and the hub
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Schema } from 'effect';
import {
  type Dependencies,
  DependencyTables,
  fromCargo,
  MEMBERS,
  Metadata,
  memberLabels,
  NATIVE_TRIPLES,
  type NativeTriple,
  perPlatform,
  requireSameResolution,
  runCargo,
  TREE_FORMAT,
  treeCrates,
  writeWorkspace,
} from './cargo-graph';
import {
  absoluteCargoPaths,
  cargoEnvironment,
  manifestText,
  productionWorkspaceTables,
  root as ROOT,
  table,
} from './generated-cargo-workspace';

export const SIM_WORKSPACE = 'tools/bazel/sim';
const SIM_SOURCE = 'tools/sim';
const HUB = 'sim_crates';
/** Cargo's target directory for resolving: outside the checkout, and never built into. */
const TARGET = mkdtempSync(path.join(tmpdir(), 'merkur-sim-target-'));

/** The cfgs every crate of the simulator compiles with: its hooks, and turmoil's scheduler seed. */
export const SIM_CFGS = ['merkur_sim', 'tokio_unstable'] as const;

/**
 * Patches that stay patches: Bazel never loads their directories as packages. The workspace
 * names each through `tools/bazel/sim/vendored`, symlinks crate_universe follows when it copies
 * the workspace elsewhere to resolve it.
 */
const VENDORED_PATCHES = new Set([
  'packages/quinn-patch',
  'packages/quinn-proto-patch',
  'packages/wtransport-patch',
]);

const TRIPLES = NATIVE_TRIPLES;
type Triple = NativeTriple;

const Manifest = Schema.Struct({
  ...DependencyTables.fields,
  package: Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    edition: Schema.String,
    links: Schema.optionalKey(Schema.String),
  }),
  lib: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      path: Schema.optionalKey(Schema.String),
    }),
  ),
  target: Schema.optionalKey(Schema.Record(Schema.String, DependencyTables)),
  features: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  lints: Schema.optionalKey(Schema.Struct({ workspace: Schema.optionalKey(Schema.Boolean) })),
});
type Manifest = typeof Manifest.Type;

interface Member {
  /** The crate's checkout directory, `apps/edge` or `packages/merkur-wire`. */
  readonly directory: string;
  readonly manifest: Manifest;
  readonly library: string;
  readonly libraryPath: string;
  readonly buildScript: boolean;
}

/** A member's directory in the workspace: its checkout path, flattened. */
function memberDirectory(directory: string): string {
  return directory.replaceAll('/', '-');
}

function readManifest(file: string): Manifest {
  return Schema.decodeUnknownSync(Manifest)(
    Bun.TOML.parse(readFileSync(path.join(ROOT, file), 'utf8')),
  );
}

function member(directory: string): Member {
  const manifest = readManifest(`${directory}/Cargo.toml`);
  return {
    directory,
    manifest,
    library: manifest.lib?.name ?? manifest.package.name.replaceAll('-', '_'),
    libraryPath: manifest.lib?.path ?? 'src/lib.rs',
    buildScript: Bun.file(path.join(ROOT, directory, 'build.rs')).size > 0,
  };
}

/** Cargo's standard output in `cwd`, with the simulator's flags and the pinned toolchain. */
function cargo(cwd: string, args: readonly string[]): string {
  return runCargo(
    cwd,
    args,
    cargoEnvironment(SIM_CFGS.map((cfg) => `--cfg ${cfg}`).join(' '), TARGET),
  );
}

/** Each crate of the simulator's graph on `triple`, by `name version`, with its features. */
function treeFeatures(
  cwd: string,
  triple: Triple,
  lock: '--locked' | '--offline',
): Map<string, readonly string[]> {
  const output = cargo(cwd, [
    'tree',
    lock,
    '-p',
    'merkur-sim',
    '--target',
    triple,
    '-e',
    'normal,dev,no-proc-macro',
    ...TREE_FORMAT,
  ]);
  return new Map([...treeCrates(output)].map(([key, crate]) => [key, crate.features]));
}

/**
 * The simulator's workspace with the checkout's crates as path dependencies, as Cargo resolves
 * it from `lock`: the reference the members workspace is held to, and what re-locking updates.
 */
export async function writePathWorkspace(
  scratch: string,
  lock = path.join(ROOT, SIM_SOURCE, 'Cargo.lock'),
): Promise<void> {
  const { lints, patch } = await productionWorkspaceTables();
  const crate = table(
    absoluteCargoPaths(
      Bun.TOML.parse(readFileSync(path.join(ROOT, SIM_SOURCE, 'manifest.toml'), 'utf8')),
      path.join(ROOT, SIM_SOURCE),
    ),
  );
  crate.package = { ...table(crate.package), autotests: false, build: false };
  crate.lib = { path: path.join(ROOT, SIM_SOURCE, 'src/lib.rs') };
  mkdirSync(path.join(scratch, 'merkur-sim'), { recursive: true });
  writeFileSync(
    path.join(scratch, 'Cargo.toml'),
    manifestText({ workspace: { resolver: '3', members: ['merkur-sim'], lints }, patch }),
  );
  writeFileSync(path.join(scratch, 'merkur-sim', 'Cargo.toml'), manifestText(crate));
  copyFileSync(lock, path.join(scratch, 'Cargo.lock'));
}

/** The checkout crates the simulator reaches by path or through a patch, apart from the vendored patches. */
function reachedMembers(metadata: Metadata): Member[] {
  const directories = new Set<string>();
  for (const entry of metadata.packages) {
    if (entry.source !== null || entry.name === 'merkur-sim') continue;
    const directory = path.relative(ROOT, path.dirname(entry.manifest_path));
    if (directory.startsWith('..')) throw new Error(`the simulator reaches ${entry.manifest_path}`);
    if (!VENDORED_PATCHES.has(directory)) directories.add(directory);
  }
  return [...directories].sort().map(member);
}

type Value = string | boolean | readonly string[];

const toml = (value: Value): string => JSON.stringify(value);

type Fields = { [key: string]: Value };

const isString = Schema.is(Schema.String);

/**
 * A dependency as its workspace declares it, with a path or patched member placed at `placed`
 * and the member's default features named in place of `default`.
 */
function dependencyLine(
  name: string,
  declared: Dependencies[string],
  owner: string,
  plan: Layout,
  placed: (directory: string) => string,
): string {
  const dependency: Fields = isString(declared) ? { version: declared } : { ...declared };
  const { path: relative, package: renamed } = dependency;
  const target = isString(relative)
    ? path.posix.join(owner, relative)
    : plan.patchedMembers.get(isString(renamed) ? renamed : name);
  const own = target === undefined ? undefined : plan.members.get(target);
  if (own === undefined) {
    if (isString(relative))
      throw new Error(`${owner} depends on ${relative}, outside the simulator's members`);
    return `${name} = ${inlineTable(dependency)}`;
  }
  const defaults =
    (dependency['default-features'] ?? dependency.default_features) === false
      ? []
      : (own.manifest.features?.default ?? []);
  const requested = dependency.features;
  delete dependency.default_features;
  dependency.path = placed(own.directory);
  dependency['default-features'] = false;
  dependency.features = [...new Set([...defaults, ...(Array.isArray(requested) ? requested : [])])];
  return `${name} = ${inlineTable(dependency)}`;
}

function inlineTable(fields: Fields): string {
  return `{ ${Object.entries(fields)
    .map(([key, value]) => `${key.includes('-') ? `"${key}"` : key} = ${toml(value)}`)
    .join(', ')} }`;
}

type Kind = 'dependencies' | 'build-dependencies' | 'dev-dependencies';

/**
 * Every dependency table of `manifest`, by its header, `kinds` of each. A table for one of the
 * simulator's own cfgs holds in every build of this workspace, so it joins the unconditional
 * table, where crate_universe, which cannot judge a custom cfg, resolves it.
 */
function tables(manifest: Manifest, kinds: readonly Kind[]): [string, Dependencies][] {
  const found = new Map<string, Record<string, Dependencies[string]>>();
  const add = (header: string, dependencies: Dependencies) =>
    found.set(header, { ...found.get(header), ...dependencies });
  for (const kind of kinds) if (manifest[kind] !== undefined) add(`[${kind}]`, manifest[kind]);
  for (const [key, table] of Object.entries(manifest.target ?? {}))
    for (const kind of kinds) {
      const dependencies = table[kind];
      if (dependencies === undefined) continue;
      const simulator = SIM_CFGS.some((cfg) => key === `cfg(${cfg})`);
      add(simulator ? `[${kind}]` : `[target.'${key}'.${kind}]`, dependencies);
    }
  return [...found];
}

interface Layout {
  readonly members: ReadonlyMap<string, Member>;
  /** The checkout directory patching each crate name. */
  readonly patched: ReadonlyMap<string, string>;
  /** The member directory patching each crate name a member patches. */
  readonly patchedMembers: ReadonlyMap<string, string>;
}

async function layout(members: readonly Member[]): Promise<Layout> {
  const { patch } = await productionWorkspaceTables();
  const patched = new Map<string, string>();
  for (const [name, declared] of Object.entries(table(table(patch)['crates-io'])))
    patched.set(name, path.relative(ROOT, String(table(declared).path)));
  const byDirectory = new Map(members.map((entry) => [entry.directory, entry]));
  return {
    members: byDirectory,
    patched,
    patchedMembers: new Map([...patched].filter(([, directory]) => byDirectory.has(directory))),
  };
}

/** One member's manifest: its own tables but no dev-dependencies, and no default features. */
function memberManifest(entry: Member, plan: Layout): string {
  const manifest = entry.manifest;
  const fromMember = (relative: string) => path.posix.join('../../../..', relative);
  const output = [
    `# Generated from ${entry.directory}/Cargo.toml by scripts/sim-workspace.ts: edit that manifest`,
    '# and rerun the script.',
    '[package]',
    `name = ${toml(manifest.package.name)}`,
    `version = ${toml(manifest.package.version)}`,
    `edition = ${toml(manifest.package.edition)}`,
    'publish = false',
    ...(entry.buildScript ? [`build = ${toml(fromMember(`../${entry.directory}/build.rs`))}`] : []),
    ...(manifest.package.links === undefined ? [] : [`links = ${toml(manifest.package.links)}`]),
    '',
    '[lib]',
    ...(manifest.lib?.name === undefined ? [] : [`name = ${toml(manifest.lib.name)}`]),
    `path = ${toml(fromMember(`../${entry.directory}/${entry.libraryPath}`))}`,
  ];
  const kept = new Set<string>();
  for (const [header, dependencies] of tables(manifest, ['dependencies', 'build-dependencies'])) {
    output.push('', header);
    for (const [name, declared] of Object.entries(dependencies)) {
      kept.add(name);
      output.push(
        dependencyLine(
          name,
          declared,
          entry.directory,
          plan,
          (directory) => `../${memberDirectory(directory)}`,
        ),
      );
    }
  }
  const features = Object.entries(manifest.features ?? {}).filter(([name]) => name !== 'default');
  if (features.length > 0 || manifest.features?.default !== undefined) {
    output.push('', '[features]', 'default = []');
    for (const [name, enables] of features) {
      const reachable = enables.filter((enable) => {
        const target = enable.startsWith('dep:') ? enable.slice(4) : enable.split(/\??\//)[0];
        return (
          target === undefined ||
          !target.length ||
          kept.has(target) ||
          manifest.features?.[target] !== undefined
        );
      });
      output.push(`${name} = ${toml(reachable)}`);
    }
  }
  if (manifest.lints?.workspace === true) output.push('', '[lints]', 'workspace = true');
  return `${output.join('\n')}\n`;
}

/** The workspace root's manifest: the simulator's package, its members and the patches. */
async function rootManifest(plan: Layout): Promise<string> {
  const { lints } = await productionWorkspaceTables();
  const sim = readManifest(`${SIM_SOURCE}/manifest.toml`);
  const simPackage = sim.package;
  const output = [
    `# Generated from ${SIM_SOURCE}/manifest.toml by scripts/sim-workspace.ts: edit that manifest`,
    '# and rerun the script.',
    '[package]',
    `name = ${toml(simPackage.name)}`,
    `version = ${toml(simPackage.version)}`,
    `edition = ${toml(simPackage.edition)}`,
    'publish = false',
    '',
    '[lib]',
    `path = ${toml(`../../../${SIM_SOURCE}/src/lib.rs`)}`,
  ];
  for (const kind of ['dependencies', 'dev-dependencies'] as const) {
    const dependencies = sim[kind];
    if (dependencies === undefined) continue;
    output.push('', `[${kind}]`);
    for (const [name, declared] of Object.entries(dependencies))
      output.push(
        dependencyLine(
          name,
          declared,
          SIM_SOURCE,
          plan,
          (directory) => `${MEMBERS}/${memberDirectory(directory)}`,
        ),
      );
  }
  output.push(
    '',
    manifestText({
      workspace: {
        resolver: '3',
        members: [...plan.members.keys()].map(
          (directory) => `${MEMBERS}/${memberDirectory(directory)}`,
        ),
        lints,
      },
    }).trimEnd(),
    '',
    '[patch.crates-io]',
    ...[...plan.patched].map(([name, directory]) =>
      plan.members.has(directory)
        ? `${name} = { path = ${toml(`${MEMBERS}/${memberDirectory(directory)}`)} }`
        : `${name} = { path = ${toml(`vendored/${path.basename(directory)}`)} }`,
    ),
  );
  return `${output.join('\n')}\n`;
}

interface Resolution {
  readonly plan: Layout;
  readonly root: string;
  readonly members: ReadonlyMap<string, string>;
  readonly lock: string;
  /** Each platform's metadata and features. */
  readonly platforms: ReadonlyMap<
    Triple,
    { metadata: Metadata; features: Map<string, readonly string[]> }
  >;
}

function describe(
  features: ReadonlyMap<string, readonly string[]>,
  names: ReadonlySet<string>,
): string[] {
  // A member's dependents name its default features rather than `default` itself.
  return [...features]
    .map(([key, list]) => {
      const name = key.split(' ')[0] ?? key;
      return `${key} [${(names.has(name) ? list.filter((feature) => feature !== 'default') : list).join(',')}]`;
    })
    .sort();
}

async function resolve(): Promise<Resolution> {
  const pathScratch = mkdtempSync(path.join(tmpdir(), 'merkur-sim-path-'));
  // The workspace resolves where it lives, so its paths to the vendored patches hold.
  const memberScratch = path.join(ROOT, SIM_WORKSPACE);
  rmSync(path.join(memberScratch, MEMBERS), { recursive: true, force: true });
  try {
    await writePathWorkspace(pathScratch);
    const pathMetadata = Schema.decodeUnknownSync(Metadata)(
      JSON.parse(cargo(pathScratch, ['metadata', '--format-version', '1', '--locked'])),
    );
    const plan = await layout(reachedMembers(pathMetadata));
    const root = await rootManifest(plan);
    const members = new Map(
      [...plan.members.values()].map((entry) => [
        memberDirectory(entry.directory),
        memberManifest(entry, plan),
      ]),
    );
    writeWorkspace(memberScratch, root, members);
    copyFileSync(path.join(ROOT, SIM_SOURCE, 'Cargo.lock'), path.join(memberScratch, 'Cargo.lock'));
    const names = new Set([...plan.members.values()].map((entry) => entry.manifest.package.name));
    const platforms = new Map<
      Triple,
      { metadata: Metadata; features: Map<string, readonly string[]> }
    >();
    for (const triple of TRIPLES) {
      // Members lock their optional dependencies too, which the release lock pins already.
      const features = treeFeatures(memberScratch, triple, '--offline');
      const got = describe(features, names);
      const want = describe(treeFeatures(pathScratch, triple, '--locked'), names);
      requireSameResolution(
        got,
        want,
        `on ${triple} the simulator's workspace resolves differently from scripts/sim-tests.ts's`,
      );
      const metadata = Schema.decodeUnknownSync(Metadata)(
        JSON.parse(
          cargo(memberScratch, [
            'metadata',
            '--format-version',
            '1',
            '--offline',
            '--filter-platform',
            triple,
          ]),
        ),
      );
      platforms.set(triple, { metadata, features });
    }
    return {
      plan,
      root,
      members,
      lock: readFileSync(path.join(memberScratch, 'Cargo.lock'), 'utf8'),
      platforms,
    };
  } finally {
    rmSync(pathScratch, { recursive: true, force: true });
    rmSync(TARGET, { recursive: true, force: true });
  }
}

function cratesBzl(resolution: Resolution): string {
  const { plan, platforms } = resolution;
  // The checkout crate `name` depends on, on each platform: normal edges, and dev for the root.
  // A crate a platform never reaches depends on nothing there.
  const memberDeps = (name: string, dev: boolean) =>
    new Map(
      TRIPLES.map((triple) => {
        const metadata = platforms.get(triple)?.metadata;
        if (metadata === undefined) return [triple, []];
        const ids = new Map<string, Member>();
        let id: string | undefined;
        for (const entry of metadata.packages) {
          if (entry.source !== null) continue;
          if (entry.name === name) id = entry.id;
          for (const candidate of plan.members.values())
            if (entry.name === candidate.manifest.package.name) ids.set(entry.id, candidate);
        }
        return [triple, memberLabels(metadata, ids, id, dev) ?? []];
      }),
    );
  const rootDeps = memberDeps('merkur-sim', true);
  const output = [
    '"""Generated by scripts/sim-workspace.ts: the checkout crates the simulator reaches, compiled',
    'with the features Cargo resolves for it on each platform.',
    '"""',
    '',
    `load("@${HUB}//:defs.bzl", "aliases", "all_crate_deps")`,
    'load("@rules_rust//rust:defs.bzl", "rust_library")',
    'load(":defs.bzl", "SIMULATING")',
    '',
    "# The checkout's crates the simulator itself depends on.",
    `SIM_DEPS = ${perPlatform(rootDeps, '')}`,
    '',
    'def sim_crates():',
    '    """Declares each checkout crate the simulator reaches."""',
  ];
  for (const entry of [...plan.members.values()].sort((a, b) =>
    a.library.localeCompare(b.library),
  )) {
    const name = entry.manifest.package.name;
    const key = `${name} ${entry.manifest.package.version}`;
    const features = new Map(
      TRIPLES.map((triple) => [triple, platforms.get(triple)?.features.get(key) ?? []]),
    );
    const deps = memberDeps(name, false);
    const packageName = `${SIM_WORKSPACE}/${MEMBERS}/${memberDirectory(entry.directory)}`;
    output.push(
      '    rust_library(',
      `        name = "${entry.library}",`,
      `        srcs = ["//${entry.directory}:srcs"],`,
      `        aliases = aliases(package_name = "${packageName}"),`,
      `        compile_data = ["//${entry.directory}:files"],`,
      `        crate_features = ${perPlatform(features, '        ')},`,
      `        crate_root = "//${entry.directory}:${entry.libraryPath}",`,
      `        edition = "${entry.manifest.package.edition}",`,
      `        proc_macro_deps = all_crate_deps(proc_macro = True, package_name = "${packageName}"),`,
      `        rustc_env = {"CARGO_MANIFEST_DIR": "$\${pwd}/${entry.directory}"},`,
      '        tags = ["noclippy"],',
      '        target_compatible_with = SIMULATING,',
      `        version = "${entry.manifest.package.version}",`,
      `        deps = ${perPlatform(deps, '        ')} + all_crate_deps(normal = True, package_name = "${packageName}")${entry.buildScript ? ` + ["//${entry.directory}:build_script"]` : ''},`,
      '    )',
    );
  }
  output.push('');
  return output.join('\n');
}

function hub(resolution: Resolution): string {
  return [
    "# Generated by scripts/sim-workspace.ts: the network simulator's crate hub, over its own",
    '# workspace.',
    '',
    'crate = use_extension("@rules_rust//crate_universe:extensions.bzl", "crate")',
    '',
    ...fromCargo(HUB, SIM_WORKSPACE, [...resolution.members.keys()], TRIPLES),
    '',
    `use_repo(crate, "${HUB}")`,
    '',
  ].join('\n');
}

if (import.meta.main) {
  const resolution = await resolve();
  const directory = path.join(ROOT, SIM_WORKSPACE);
  writeWorkspace(directory, resolution.root, resolution.members);
  writeFileSync(path.join(directory, 'Cargo.lock'), resolution.lock);
  writeFileSync(path.join(directory, 'crates.bzl'), cratesBzl(resolution));
  writeFileSync(path.join(directory, 'hub.MODULE.bazel'), hub(resolution));
}
