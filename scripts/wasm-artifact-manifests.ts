/**
 * What the browser's WebAssembly modules, and the tests that run inside wasm32, compile from:
 * one crate hub per workspace (`tools/bazel/wasm/hubs.MODULE.bazel`), each resolving one build's
 * crates alone.
 *
 * Cargo resolves features for what one build compiles. A hub over the whole workspace unifies
 * every member's features, test-only features and native backends included, so each module's
 * hub resolves a workspace of its own (`tools/bazel/wasm/<module>`): a root package with the
 * module crate's dependencies and every one of its features on, so the hub holds each crate a
 * build of the module may link, and as members every crate the module reaches by path or
 * through the workspace's patches. Members are what crate_universe leaves to the caller, so it
 * renders nothing into the checkout; their targets are generated here (`crates.bzl`), with the
 * features Cargo resolves for the module. A member's manifest holds what Cargo resolves for
 * wasm32 and nothing else: its browser dependency tables, no dev-dependencies, and no default
 * features, which its dependents name instead, so a member is never resolved with features the
 * module does not ask of it. A test's workspace is its crate's, dev-dependencies included, with
 * exactly the features the test builds with.
 *
 * Each hub's `Cargo.lock` is the workspace's, pruned by Cargo to the module's crates;
 * crate_universe writes back the lock of the graph it resolves, and every crate keeps the
 * version the workspace pins. Generating checks Cargo resolves every crate of each build with
 * exactly the features it resolves them with in the checkout's workspace.
 *
 *   bun run build:wasm-workspaces    rewrite every workspace and the hubs
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Schema } from 'effect';

const ROOT = path.resolve(import.meta.dir, '..');

export interface WasmWorkspace {
  /** Its directory under `tools/bazel/wasm`. */
  readonly name: string;
  /** The `packages/` crate at its root. */
  readonly crate: string;
  /**
   * The root's features: every one, so a module's hub holds the crates each build of it links,
   * or exactly those a test builds with.
   */
  readonly features: 'all' | readonly string[];
  /** Whether the root's dev-dependencies resolve too, for its tests. */
  readonly dev: boolean;
}

export const WASM_WORKSPACES: readonly WasmWorkspace[] = [
  { name: 'e2e-wasm', crate: 'e2e-wasm', features: 'all', dev: false },
  { name: 'graphics-codec-probe', crate: 'graphics-codec-probe', features: 'all', dev: false },
  { name: 'graphics-wasm', crate: 'graphics-wasm', features: 'all', dev: false },
  // The browser cipher's tests, which compile only for wasm32 with SIMD.
  { name: 'merkur-e2e-cipher', crate: 'merkur-e2e', features: ['wasm'], dev: true },
  { name: 'term-wasm', crate: 'term-wasm', features: 'all', dev: false },
];

/** Where workspace `name`'s manifests and `BUILD.bazel` live. */
export function wasmArtifactDirectory(name: string): string {
  return `tools/bazel/wasm/${name}`;
}

/** The members' directory in a workspace. */
export const MEMBERS = 'crates';

/** The hub declarations `MODULE.bazel` includes. */
export const WASM_HUBS = 'tools/bazel/wasm/hubs.MODULE.bazel';

const BROWSER = 'wasm32-unknown-unknown';

const TRIPLES = [
  'aarch64-apple-darwin',
  'aarch64-unknown-linux-gnu',
  BROWSER,
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu',
];

export function wasmArtifactHub(name: string): string {
  return `${name.replaceAll('-', '_')}_crates`;
}

const Detailed = Schema.Struct({
  version: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  'default-features': Schema.optionalKey(Schema.Boolean),
  default_features: Schema.optionalKey(Schema.Boolean),
  features: Schema.optionalKey(Schema.Array(Schema.String)),
  optional: Schema.optionalKey(Schema.Boolean),
  package: Schema.optionalKey(Schema.String),
});
type Detailed = typeof Detailed.Type;

const Dependencies = Schema.Record(Schema.String, Schema.Union([Schema.String, Detailed]));

const Table = Schema.Struct({
  dependencies: Schema.optionalKey(Dependencies),
  'build-dependencies': Schema.optionalKey(Dependencies),
  'dev-dependencies': Schema.optionalKey(Dependencies),
});
type Table = typeof Table.Type;

const Manifest = Schema.Struct({
  ...Table.fields,
  package: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      edition: Schema.String,
      build: Schema.optionalKey(Schema.Union([Schema.String, Schema.Boolean])),
      links: Schema.optionalKey(Schema.String),
    }),
  ),
  lib: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      path: Schema.optionalKey(Schema.String),
      'proc-macro': Schema.optionalKey(Schema.Boolean),
    }),
  ),
  target: Schema.optionalKey(Schema.Record(Schema.String, Table)),
  features: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  lints: Schema.optionalKey(Schema.Struct({ workspace: Schema.optionalKey(Schema.Boolean) })),
  workspace: Schema.optionalKey(Schema.Struct({ resolver: Schema.optionalKey(Schema.String) })),
  patch: Schema.optionalKey(Schema.Record(Schema.String, Dependencies)),
});
type Manifest = typeof Manifest.Type;

const Lock = Schema.Struct({
  package: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      source: Schema.optionalKey(Schema.String),
      checksum: Schema.optionalKey(Schema.String),
    }),
  ),
});
type Locked = (typeof Lock.Type)['package'][number];

const Metadata = Schema.Struct({
  packages: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, manifest_path: Schema.String }),
  ),
  resolve: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        deps: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            pkg: Schema.String,
            dep_kinds: Schema.Array(Schema.Struct({ kind: Schema.NullOr(Schema.String) })),
          }),
        ),
      }),
    ),
  }),
});
type Metadata = typeof Metadata.Type;

const isVersion = Schema.is(Schema.String);

/** A dependency declared by its version alone, in the form every other declaration takes. */
function detailed(declared: string | Detailed): Detailed {
  return isVersion(declared) ? { version: declared } : declared;
}

function read(file: string, root: string): Manifest {
  return Schema.decodeUnknownSync(Manifest)(
    Bun.TOML.parse(readFileSync(path.join(root, file), 'utf8')),
  );
}

const BROWSER_FACTS = new Map([
  ['target_arch', 'wasm32'],
  ['target_os', 'unknown'],
  ['target_family', 'wasm'],
]);

/** Whether `cfg(...)` holds for wasm32-unknown-unknown, the browser's target. */
export function holdsForBrowser(expression: string): boolean {
  let at = 0;
  const skip = () => {
    while (expression[at] === ' ') at += 1;
  };
  const fail = (): never => {
    throw new Error(`unreadable cfg: ${expression}`);
  };
  const word = (): string => {
    skip();
    const match = expression.slice(at).match(/^[a-z_][a-z0-9_]*/);
    if (match === null) return fail();
    at += match[0].length;
    return match[0];
  };
  const expect = (character: string) => {
    skip();
    if (expression[at] !== character) fail();
    at += 1;
  };
  const list = (): boolean[] => {
    expect('(');
    const values: boolean[] = [];
    skip();
    while (expression[at] !== ')') {
      values.push(predicate());
      skip();
      if (expression[at] === ',') at += 1;
      skip();
    }
    expect(')');
    return values;
  };
  const predicate = (): boolean => {
    const name = word();
    if (name === 'all') return list().every(Boolean);
    if (name === 'any') return list().some(Boolean);
    if (name === 'not') {
      const [inner, ...rest] = list();
      if (inner === undefined || rest.length > 0) return fail();
      return !inner;
    }
    skip();
    if (expression[at] !== '=') {
      if (name === 'unix' || name === 'windows') return false;
      throw new Error(`cfg names ${name}, which this generator cannot judge`);
    }
    at += 1;
    skip();
    const match = expression.slice(at).match(/^"([^"]*)"/);
    if (match?.[1] === undefined) return fail();
    at += match[0].length;
    const fact = BROWSER_FACTS.get(name);
    if (fact === undefined) throw new Error(`cfg names ${name}, which this generator cannot judge`);
    return fact === match[1];
  };
  if (word() !== 'cfg') fail();
  const [result, ...rest] = list();
  skip();
  if (result === undefined || rest.length > 0 || at !== expression.length) return fail();
  return result;
}

/** A target table's key, `cfg(...)` or a triple, holds for the browser. */
function appliesToBrowser(key: string): boolean {
  return key.startsWith('cfg(') ? holdsForBrowser(key) : key === BROWSER;
}

/** The `packages/` directory a path names, from the directory `owner`. */
function packageDirectory(owner: string, relative: string, file: string): string {
  const match = path.posix.join(owner, relative).match(/^packages\/([^/]+)$/);
  if (match?.[1] === undefined)
    throw new Error(`${file} depends on ${relative}, outside packages/`);
  return match[1];
}

type Kind = 'dependencies' | 'build-dependencies' | 'dev-dependencies';

function kinds(dev: boolean): Kind[] {
  return dev
    ? ['dependencies', 'build-dependencies', 'dev-dependencies']
    : ['dependencies', 'build-dependencies'];
}

/** The tables a crate's browser graph resolves from, by header: unconditional and browser ones. */
function browserTables(manifest: Manifest, dev = false): [string, Map<string, Detailed>][] {
  const found: [string, Map<string, Detailed>][] = [];
  const add = (prefix: string, table: Table) => {
    for (const kind of kinds(dev)) {
      const dependencies = table[kind];
      if (dependencies === undefined) continue;
      found.push([
        `[${prefix}${kind}]`,
        new Map(Object.entries(dependencies).map(([name, entry]) => [name, detailed(entry)])),
      ]);
    }
  };
  add('', manifest);
  for (const [key, table] of Object.entries(manifest.target ?? {}))
    if (appliesToBrowser(key)) add(`target.'${key}'.`, table);
  return found;
}

/** Every dependency name the crate declares anywhere, browser or not. */
function declaredNames(manifest: Manifest, dev: boolean): Set<string> {
  const names = new Set<string>();
  const add = (table: Table) => {
    for (const kind of kinds(dev))
      for (const name of Object.keys(table[kind] ?? {})) names.add(name);
  };
  add(manifest);
  for (const table of Object.values(manifest.target ?? {})) add(table);
  return names;
}

interface Crate {
  readonly directory: string;
  readonly manifest: Manifest;
  readonly name: string;
  readonly version: string;
  readonly edition: string;
  readonly library: string;
  readonly libraryPath: string;
}

function crate(directory: string, root: string): Crate {
  const file = `packages/${directory}/Cargo.toml`;
  const manifest = read(file, root);
  if (manifest.package === undefined) throw new Error(`${file} declares no package`);
  const { name, version, edition, build, links } = manifest.package;
  const script =
    build === undefined
      ? existsSync(path.join(root, 'packages', directory, 'build.rs'))
      : build !== false;
  if (script) throw new Error(`${file} has a build script; give it a cargo_build_script here`);
  if (links !== undefined) throw new Error(`${file} links a native library`);
  if (manifest.lib?.['proc-macro'] === true) throw new Error(`${file} is a proc-macro`);
  return {
    directory,
    manifest,
    name,
    version,
    edition,
    library: manifest.lib?.name ?? name.replaceAll('-', '_'),
    libraryPath: manifest.lib?.path ?? 'src/lib.rs',
  };
}

/** Cargo's standard output, with the toolchain `rust-toolchain.toml` pins. */
function cargo(cwd: string, root: string, args: readonly string[]): string {
  const channel = readFileSync(path.join(root, 'rust-toolchain.toml'), 'utf8').match(
    /^channel = "([^"]+)"$/m,
  )?.[1];
  if (channel === undefined) throw new Error('rust-toolchain.toml names no channel');
  const result = Bun.spawnSync(['cargo', ...args], {
    cwd,
    env: { ...process.env, RUSTUP_TOOLCHAIN: channel },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0)
    throw new Error(`cargo ${args.join(' ')} failed:\n${result.stderr.toString()}`);
  return result.stdout.toString();
}

const TREE_LINE = /^(\S+) v(\S+)(?: \(([^)]+)\))?\|(.*?)(?: \(\*\))?$/;

interface Resolved {
  readonly name: string;
  readonly version: string;
  readonly location: string | undefined;
  readonly features: readonly string[];
}

/** `cargo tree` over the browser graph, proc-macro subtrees aside: each crate's features. */
function browserFeatures(
  cwd: string,
  root: string,
  packageName: string,
  dev: boolean,
  extra: readonly string[],
): Map<string, Resolved> {
  const resolved = new Map<string, Resolved>();
  const output = cargo(cwd, root, [
    'tree',
    '--locked',
    '-p',
    packageName,
    '--target',
    BROWSER,
    '-e',
    dev ? 'normal,dev,no-proc-macro' : 'normal,no-proc-macro',
    '--prefix',
    'none',
    '-f',
    '{p}|{f}',
    ...extra,
  ]);
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const match = line.match(TREE_LINE);
    if (match?.[1] === undefined || match[2] === undefined || match[4] === undefined)
      throw new Error(`unreadable cargo tree line: ${line}`);
    resolved.set(`${match[1]} ${match[2]}`, {
      name: match[1],
      version: match[2],
      location: match[3],
      features: match[4] === '' ? [] : match[4].split(',').sort(),
    });
  }
  return resolved;
}

/** How the checkout's own workspace builds the spec's crate for wasm32. */
function checkoutFeatures(spec: WasmWorkspace, root: string): Map<string, Resolved> {
  return browserFeatures(
    root,
    root,
    spec.crate,
    spec.dev,
    spec.features === 'all' ? [] : ['--no-default-features', '--features', spec.features.join(',')],
  );
}

/** The checkout's crates the build reaches on wasm32, by `packages/` directory. */
function members(spec: WasmWorkspace, root: string): string[] {
  const found = new Set<string>();
  for (const { location } of checkoutFeatures(spec, root).values()) {
    if (location === undefined) continue;
    const relative = path.relative(path.join(root, 'packages'), location);
    if (relative.startsWith('..') || relative.includes('/'))
      throw new Error(`${spec.name} reaches ${location}, outside packages/`);
    if (relative !== spec.crate) found.add(relative);
  }
  return [...found].sort();
}

/** One dependency as an inline TOML table, at `placed` when a member. */
function inline(name: string, dependency: Detailed, file: string, placed?: string): string {
  const unknown = Object.keys(dependency).find((key) => !Object.hasOwn(Detailed.fields, key));
  if (unknown !== undefined) throw new Error(`${file} dependency ${name} sets ${unknown}`);
  const fields: string[] = [];
  if (dependency.package !== undefined)
    fields.push(`package = ${JSON.stringify(dependency.package)}`);
  if (dependency.version !== undefined)
    fields.push(`version = ${JSON.stringify(dependency.version)}`);
  if (placed !== undefined) fields.push(`path = ${JSON.stringify(placed)}`);
  const defaults = dependency['default-features'] ?? dependency.default_features;
  if (defaults !== undefined) fields.push(`default-features = ${defaults}`);
  if (dependency.features !== undefined && dependency.features.length > 0)
    fields.push(`features = ${JSON.stringify(dependency.features).replaceAll(',', ', ')}`);
  if (dependency.optional !== undefined) fields.push(`optional = ${dependency.optional}`);
  return `{ ${fields.join(', ')} }`;
}

interface Layout {
  readonly module: Crate;
  readonly members: ReadonlyMap<string, Crate>;
  /** Patched crate names, by the member directory that patches them. */
  readonly patched: ReadonlyMap<string, string>;
  /** The member directory patching each crate name. */
  readonly patchedBy: ReadonlyMap<string, string>;
}

/** The workspace around the crate in `packages/<module>`. */
function layout(module: string, memberDirectories: readonly string[], root: string): Layout {
  const patched = new Map<string, string>();
  const directories = new Set(memberDirectories);
  for (const [name, declared] of Object.entries(
    read('Cargo.toml', root).patch?.['crates-io'] ?? {},
  )) {
    const target = detailed(declared).path;
    if (target === undefined) continue;
    const directory = packageDirectory('.', target, 'Cargo.toml');
    if (directories.has(directory)) patched.set(directory, name);
  }
  return {
    module: crate(module, root),
    members: new Map(memberDirectories.map((directory) => [directory, crate(directory, root)])),
    patched,
    patchedBy: new Map([...patched].map(([directory, name]) => [name, directory])),
  };
}

/**
 * A dependency of `own` as its workspace declares it: unchanged, or a member it reaches by path
 * or through a patch, whose default features it then names itself. Undefined when it reaches a
 * crate the build never turns on.
 */
function dependencyLine(
  own: Crate,
  plan: Layout,
  name: string,
  dependency: Detailed,
  pathTo: (directory: string) => string,
): string | undefined {
  const file = `packages/${own.directory}/Cargo.toml`;
  let member: Crate | undefined;
  let placed: string | undefined;
  if (dependency.path !== undefined) {
    const directory = packageDirectory(`packages/${own.directory}`, dependency.path, file);
    member = plan.members.get(directory);
    if (member === undefined) return undefined;
    placed = pathTo(directory);
  } else {
    const patched = plan.patchedBy.get(dependency.package ?? name);
    member = patched === undefined ? undefined : plan.members.get(patched);
  }
  if (member === undefined) return `${name} = ${inline(name, dependency, file)}`;
  const defaults =
    (dependency['default-features'] ?? dependency.default_features) === false
      ? []
      : (member.manifest.features?.default ?? []);
  const { default_features: _, ...declared } = dependency;
  return `${name} = ${inline(
    name,
    {
      ...declared,
      'default-features': false,
      features: [...new Set([...defaults, ...(dependency.features ?? [])])],
    },
    file,
    placed,
  )}`;
}

/** The `[features]` table: the root's `default` turns on the spec's features, a member's none. */
function featureLines(own: Crate, spec: WasmWorkspace | undefined, dropped: Set<string>): string[] {
  const file = `packages/${own.directory}/Cargo.toml`;
  const features = Object.entries(own.manifest.features ?? {}).filter(
    ([name]) => name !== 'default',
  );
  if (features.length === 0 && own.manifest.features?.default === undefined) return [];
  // A feature that reaches a crate the build drops keeps everything else it turns on.
  const kept = (entry: string) => {
    const target = entry.startsWith('dep:') ? entry.slice(4) : entry.split(/\??\//)[0];
    return target === undefined || !dropped.has(target);
  };
  const defaults =
    spec === undefined
      ? []
      : spec.features === 'all'
        ? features.map(([name]) => name)
        : spec.features;
  const lines = ['', '[features]', `default = ${JSON.stringify(defaults)}`];
  for (const [name, enables] of features) {
    if (enables.includes('default'))
      throw new Error(`${file} feature ${name} enables the default features`);
    lines.push(`${name} = ${JSON.stringify(enables.filter(kept))}`);
  }
  return lines;
}

/**
 * One crate's manifest in a workspace. `pathTo` places a member by directory; `spec` is set for
 * the root's own, which turns on the spec's features, while a member's turns none on.
 */
function manifest(
  own: Crate,
  plan: Layout,
  spec: WasmWorkspace | undefined,
  pathTo: (directory: string) => string,
  libraryPath: string,
): string {
  const kept = new Set<string>();
  const output = [
    `# Generated from packages/${own.directory}/Cargo.toml by scripts/wasm-artifact-manifests.ts:`,
    '# edit that manifest and rerun the script.',
    '[package]',
    `name = "${spec === undefined ? own.name : `${own.name}-artifact`}"`,
    `version = "${spec === undefined ? own.version : '0.0.0'}"`,
    `edition = "${own.edition}"`,
    'publish = false',
    '',
    '[lib]',
    ...(own.manifest.lib?.name === undefined ? [] : [`name = "${own.manifest.lib.name}"`]),
    `path = "${libraryPath}"`,
  ];
  for (const [header, dependencies] of browserTables(own.manifest, spec?.dev ?? false)) {
    const lines: string[] = [];
    for (const [name, dependency] of dependencies) {
      const line = dependencyLine(own, plan, name, dependency, pathTo);
      if (line === undefined) continue;
      lines.push(line);
      kept.add(name);
    }
    if (lines.length > 0) output.push('', header, ...lines);
  }
  const dropped = new Set(
    [...declaredNames(own.manifest, spec?.dev ?? false)].filter((name) => !kept.has(name)),
  );
  output.push(...featureLines(own, spec, dropped));
  if (own.manifest.lints?.workspace === true) output.push('', '[lints]', 'workspace = true');
  return output.join('\n');
}

function workspaceLints(root: string): string[] {
  const output: string[] = [];
  let copying = false;
  for (const line of readFileSync(path.join(root, 'Cargo.toml'), 'utf8').split('\n')) {
    if (line.startsWith('[')) {
      copying = line.startsWith('[workspace.lints');
      if (copying) output.push('');
    }
    if (copying && line.trim() !== '' && !line.trimStart().startsWith('#')) output.push(line);
  }
  return output;
}

interface Workspace {
  readonly root: string;
  readonly members: ReadonlyMap<string, string>;
}

/** The workspace's manifests: the root's, and each member's by directory. */
function workspaceManifests(
  spec: WasmWorkspace,
  memberDirectories: readonly string[],
  root: string,
) {
  const plan = layout(spec.crate, memberDirectories, root);
  const resolver = read('Cargo.toml', root).workspace?.resolver;
  if (resolver === undefined) throw new Error('Cargo.toml names no workspace resolver');
  const memberPaths = [...plan.members.keys()].map((directory) => `${MEMBERS}/${directory}`);
  const rootManifest = [
    manifest(
      plan.module,
      plan,
      spec,
      (directory) => `${MEMBERS}/${directory}`,
      `../../../../packages/${spec.crate}/${plan.module.libraryPath}`,
    ),
    '',
    '[workspace]',
    `resolver = "${resolver}"`,
    `members = ${JSON.stringify(memberPaths)}`,
    ...workspaceLints(root),
  ];
  if (plan.patched.size > 0) {
    rootManifest.push('', '[patch.crates-io]');
    for (const [directory, name] of plan.patched)
      rootManifest.push(`${name} = { path = "${MEMBERS}/${directory}" }`);
  }
  rootManifest.push('');
  const memberManifests = new Map<string, string>();
  for (const member of plan.members.values())
    memberManifests.set(
      member.directory,
      `${manifest(
        member,
        plan,
        undefined,
        (directory) => `../${directory}`,
        `../../../../../../packages/${member.directory}/${member.libraryPath}`,
      )}\n`,
    );
  const workspace: Workspace = { root: rootManifest.join('\n'), members: memberManifests };
  return { plan, workspace };
}

/** The member directories the workspace holds in the checkout. */
export function writtenMembers(spec: WasmWorkspace, root = ROOT): string[] {
  const directory = path.join(root, wasmArtifactDirectory(spec.name), MEMBERS);
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

/** The workspace as written, its members read from the checkout's `crates/`. */
export function currentWasmArtifactWorkspace(spec: WasmWorkspace, root = ROOT): Workspace {
  return workspaceManifests(spec, writtenMembers(spec, root), root).workspace;
}

/** Each member's path dependencies on the browser are members too. */
export function wasmArtifactMembersClosed(spec: WasmWorkspace, root = ROOT): string[] {
  const memberDirectories = new Set(writtenMembers(spec, root));
  const missing: string[] = [];
  for (const owner of [spec.crate, ...memberDirectories]) {
    const own = read(`packages/${owner}/Cargo.toml`, root);
    for (const [, dependencies] of browserTables(own, owner === spec.crate && spec.dev))
      for (const [name, dependency] of dependencies) {
        if (dependency.path === undefined || dependency.optional === true) continue;
        const target = packageDirectory(`packages/${owner}`, dependency.path, owner);
        if (!memberDirectories.has(target)) missing.push(`${owner} -> ${name}`);
      }
  }
  return missing;
}

/** Crates and their features, as the feature check compares them. */
function describe(map: Map<string, Resolved>, excluded: readonly string[]): string[] {
  const lines: string[] = [];
  for (const entry of map.values()) {
    if (excluded.includes(entry.name)) continue;
    // A member's dependents name its default features rather than `default` itself, the one
    // feature name that differs; the members compile with the workspace's names.
    const features =
      entry.location === undefined
        ? entry.features
        : entry.features.filter((feature) => feature !== 'default');
    lines.push(`${entry.name} ${entry.version} [${features.join(',')}]`);
  }
  return lines.sort();
}

interface Resolution {
  readonly plan: Layout;
  readonly workspace: Workspace;
  readonly lock: string;
  readonly metadata: Metadata;
  readonly features: Map<string, Resolved>;
}

/** Writes the workspace into a scratch directory and has Cargo resolve it there. */
function resolveWorkspace(
  spec: WasmWorkspace,
  memberDirectories: readonly string[],
  root: string,
): Resolution {
  const { plan, workspace } = workspaceManifests(spec, memberDirectories, root);
  const own = `${plan.module.name}-artifact`;
  // A module's root turns every feature on for its hub; its build turns none on.
  const builds = spec.features === 'all' ? ['--no-default-features'] : [];
  const scratch = mkdtempSync(path.join(tmpdir(), `merkur-${spec.name}-`));
  try {
    writeFileSync(path.join(scratch, 'Cargo.toml'), workspace.root);
    for (const [directory, text] of workspace.members) {
      mkdirSync(path.join(scratch, MEMBERS, directory), { recursive: true });
      writeFileSync(path.join(scratch, MEMBERS, directory, 'Cargo.toml'), text);
    }
    copyFileSync(path.join(root, 'Cargo.lock'), path.join(scratch, 'Cargo.lock'));
    const metadata = Schema.decodeUnknownSync(Metadata)(
      JSON.parse(
        cargo(scratch, root, [
          'metadata',
          '--format-version',
          '1',
          '--filter-platform',
          BROWSER,
          ...builds,
        ]),
      ),
    );
    const lock = readFileSync(path.join(scratch, 'Cargo.lock'), 'utf8');
    const expected = checkoutFeatures(spec, root);
    const excluded = [plan.module.name, own];
    const got = describe(browserFeatures(scratch, root, own, spec.dev, builds), excluded);
    const want = describe(expected, excluded);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      const only = (from: string[], other: string[]) => {
        const missing: string[] = [];
        for (const entry of from) if (!other.includes(entry)) missing.push(entry);
        return missing;
      };
      throw new Error(
        `${spec.name}'s workspace resolves differently from the checkout's:\n` +
          `  only here: ${only(got, want).join('\n             ')}\n` +
          `  only there: ${only(want, got).join('\n              ')}`,
      );
    }
    return { plan, workspace, lock, metadata, features: expected };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The members a resolved node depends on, as labels: normal, and dev for a test's root. */
function memberLabels(
  metadata: Metadata,
  memberIds: ReadonlyMap<string, Crate>,
  id: string | undefined,
  dev: boolean,
): string[] {
  const node = metadata.resolve.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`cargo resolved no node ${id}`);
  const labels: string[] = [];
  for (const dep of node.deps) {
    const member = memberIds.get(dep.pkg);
    if (member === undefined) continue;
    if (!dep.dep_kinds.some(({ kind }) => kind === null || (dev && kind === 'dev'))) continue;
    if (dep.name !== member.library) throw new Error(`${member.name} is renamed to ${dep.name}`);
    labels.push(`":${member.library}"`);
  }
  return labels.sort();
}

/** `crates.bzl`: each member's library, compiled for the browser with Cargo's features. */
function cratesBzl(spec: WasmWorkspace, resolution: Resolution): string {
  const { plan, metadata, features } = resolution;
  const memberIds = new Map<string, Crate>();
  for (const entry of metadata.packages) {
    const member = plan.members.get(path.basename(path.dirname(entry.manifest_path)));
    if (member !== undefined && entry.name === member.name) memberIds.set(entry.id, member);
  }
  const rootId = metadata.packages.find(
    (entry) => entry.name === `${plan.module.name}-artifact`,
  )?.id;
  const output = [
    `"""Generated by scripts/wasm-artifact-manifests.ts: the crates ${spec.name} reaches in the`,
    'checkout, compiled for the browser with the features Cargo resolves for it.',
    '"""',
    '',
    `load("@${wasmArtifactHub(spec.name)}//:defs.bzl", "aliases", "all_crate_deps")`,
    'load("@rules_rust//rust:defs.bzl", "rust_library")',
    '',
    `# The checkout's crates ${plan.module.name} itself depends on.`,
    `MODULE_DEPS = [${memberLabels(metadata, memberIds, rootId, spec.dev).join(', ')}]`,
    '',
    'def module_crates():',
    `    """Declares each crate ${spec.name} reaches in the checkout."""`,
  ];
  const ordered = [...memberIds].sort(([, a], [, b]) => a.library.localeCompare(b.library));
  for (const [id, member] of ordered) {
    const resolved = features.get(`${member.name} ${member.version}`);
    if (resolved === undefined) throw new Error(`cargo resolved no features for ${member.name}`);
    const packageName = `${wasmArtifactDirectory(spec.name)}/${MEMBERS}/${member.directory}`;
    const deps = memberLabels(metadata, memberIds, id, false);
    output.push(
      '    rust_library(',
      `        name = "${member.library}",`,
      `        srcs = ["//packages/${member.directory}:srcs"],`,
      `        aliases = aliases(package_name = "${packageName}"),`,
      `        crate_features = ${JSON.stringify(resolved.features).replaceAll(',', ', ')},`,
      `        crate_root = "//packages/${member.directory}:${member.libraryPath}",`,
      `        edition = "${member.edition}",`,
      `        proc_macro_deps = all_crate_deps(proc_macro = True, package_name = "${packageName}"),`,
      `        rustc_env = {"CARGO_MANIFEST_DIR": "$\${pwd}/packages/${member.directory}"},`,
      '        target_compatible_with = ["@platforms//cpu:wasm32"],',
      `        version = "${member.version}",`,
      `        deps = [${deps.join(', ')}] + all_crate_deps(normal = True, package_name = "${packageName}"),`,
      '    )',
    );
  }
  output.push('');
  return output.join('\n');
}

/** The hubs `MODULE.bazel` includes. */
export function wasmArtifactHubs(root = ROOT): string {
  const output = [
    '# Generated by scripts/wasm-artifact-manifests.ts: one crate hub per WebAssembly build, each',
    "# resolving that build's own workspace.",
    '',
    'crate = use_extension("@rules_rust//crate_universe:extensions.bzl", "crate")',
  ];
  for (const spec of WASM_WORKSPACES) {
    const directory = wasmArtifactDirectory(spec.name);
    output.push(
      '',
      'crate.from_cargo(',
      `    name = "${wasmArtifactHub(spec.name)}",`,
      `    cargo_lockfile = "//${directory}:Cargo.lock",`,
      '    manifests = [',
      `        "//${directory}:Cargo.toml",`,
      ...writtenMembers(spec, root).map(
        (member) => `        "//${directory}:${MEMBERS}/${member}/Cargo.toml",`,
      ),
      '    ],',
      '    supported_platform_triples = [',
      ...TRIPLES.map((triple) => `        "${triple}",`),
      '    ],',
      ')',
    );
  }
  output.push(
    '',
    'use_repo(',
    '    crate,',
    ...WASM_WORKSPACES.map((spec) => `    "${wasmArtifactHub(spec.name)}",`),
    ')',
    '',
  );
  return output.join('\n');
}

/** The workspace lock's crates the checkout's lock does not pin identically. */
export function wasmArtifactLockDrift(spec: WasmWorkspace, root = ROOT): string[] {
  const packages = (file: string) =>
    Schema.decodeUnknownSync(Lock)(Bun.TOML.parse(readFileSync(path.join(root, file), 'utf8')))
      .package;
  const key = (entry: Locked) =>
    [entry.name, entry.version, entry.source ?? '', entry.checksum ?? ''].join(' ');
  const workspace = new Set(packages('Cargo.lock').map(key));
  const own = `${crate(spec.crate, root).name}-artifact`;
  const drift: string[] = [];
  for (const entry of packages(`${wasmArtifactDirectory(spec.name)}/Cargo.lock`))
    if (entry.name !== own && !workspace.has(key(entry))) drift.push(key(entry));
  return drift;
}

if (import.meta.main) {
  for (const spec of WASM_WORKSPACES) {
    const resolution = resolveWorkspace(spec, members(spec, ROOT), ROOT);
    const directory = path.join(ROOT, wasmArtifactDirectory(spec.name));
    rmSync(path.join(directory, MEMBERS), { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    for (const [member, text] of resolution.workspace.members) {
      mkdirSync(path.join(directory, MEMBERS, member), { recursive: true });
      writeFileSync(path.join(directory, MEMBERS, member, 'Cargo.toml'), text);
    }
    writeFileSync(path.join(directory, 'Cargo.toml'), resolution.workspace.root);
    writeFileSync(path.join(directory, 'Cargo.lock'), resolution.lock);
    writeFileSync(path.join(directory, 'crates.bzl'), cratesBzl(spec, resolution));
  }
  writeFileSync(path.join(ROOT, WASM_HUBS), wasmArtifactHubs());
}
