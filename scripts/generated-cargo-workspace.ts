/**
 * Isolated Cargo workspaces that tooling generates: they compile production
 * source with dependencies (Bolero, turmoil) and flags that must never reach the
 * production workspace or its lockfile.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Schema } from 'effect';
import { runCargo } from './cargo-graph';

export const root = path.resolve(import.meta.dir, '..');

const LockedPackages = Schema.Struct({
  package: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      source: Schema.optionalKey(Schema.String),
    }),
  ),
});
type LockedPackage = (typeof LockedPackages.Type)['package'][number];

/**
 * A crate's semver line, the versions Cargo resolves to one: the major version, else the first
 * nonzero component.
 */
function semverLine({ name, version, source }: LockedPackage): string {
  const [major = '', minor = '', patch = ''] = (version.split(/[+-]/)[0] ?? '').split('.');
  const line = major !== '0' ? major : minor !== '0' ? `0.${minor}` : `0.0.${patch}`;
  return `${name} ${source ?? ''} ${line}`;
}

/** A lock's text before its first `[[package]]`, and each entry with its text. */
function lockBlocks(text: string) {
  const [header = '', ...rest] = text.split(/^(?=\[\[package\]\]$)/m);
  return {
    header,
    blocks: rest.map((block) => {
      const [entry] = Schema.decodeUnknownSync(LockedPackages)(Bun.TOML.parse(block)).package;
      if (entry === undefined) throw new Error(`Unreadable lock entry:\n${block}`);
      return { entry, text: block };
    }),
  };
}

const Graph = Schema.Struct({
  packages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      version: Schema.String,
      source: Schema.NullOr(Schema.String),
      dependencies: Schema.Array(Schema.Struct({ name: Schema.String, req: Schema.String })),
    }),
  ),
  resolve: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        deps: Schema.Array(Schema.Struct({ pkg: Schema.String })),
      }),
    ),
  }),
});
type GraphPackage = (typeof Graph.Type)['packages'][number];

function graph(directory: string, args: readonly string[], env: Record<string, string>) {
  return Schema.decodeUnknownSync(Graph)(
    JSON.parse(runCargo(directory, ['metadata', '--format-version', '1', ...args], env)),
  );
}

/**
 * Whether a Cargo requirement admits `version`. A bare version is a caret requirement, and build
 * metadata takes no part in precedence (Bun's parser rejects it with a hyphen, as in toml_edit's
 * `+spec-1.1.0`).
 */
function admits(requirement: string, version: string): boolean {
  const range = requirement
    .split(',')
    .map((comparator) => comparator.trim())
    .map((comparator) => (/^\d/.test(comparator) ? `^${comparator}` : comparator))
    .join(' ');
  return Bun.semver.satisfies(version.split('+')[0] ?? version, range);
}

function lockedOf({ name, version, source }: GraphPackage): LockedPackage {
  return source === null ? { name, version } : { name, version, source };
}

/**
 * Seeds `directory`'s lock for re-resolving its generated workspace, from the workspace's own
 * lock there: every crate the workspace shares with the release lock takes the release's version,
 * so the workspace builds what a shipped build links, and every other crate keeps its own.
 *
 * A crate the workspace keeps at its own version can require another at a version the release
 * does not have (Bolero's exact `indexmap`): that crate is held at the workspace's version, and
 * with it every release crate that requires the release's version of a held crate, directly or
 * through another. A held crate keeps the workspace's version, or Cargo resolves it when the
 * workspace has none. Cargo then drops what the workspace no longer reaches.
 */
export function seedLock(directory: string, env: Record<string, string>): void {
  const lock = path.join(directory, 'Cargo.lock');
  const present = existsSync(lock);
  // Unlocked, so a manifest that moved since the lock was written still resolves.
  const workspace = present ? graph(directory, [], env).packages : [];
  const own = new Map(
    lockBlocks(present ? readFileSync(lock, 'utf8') : '').blocks.map((block) => [
      semverLine(block.entry),
      block,
    ]),
  );
  const release = lockBlocks(readFileSync(path.join(root, 'Cargo.lock'), 'utf8'));
  const releaseLines = new Set(release.blocks.map(({ entry }) => semverLine(entry)));
  const releaseByName = Map.groupBy(release.blocks, ({ entry }) => entry.name);
  const releaseGraph = graph(root, ['--locked'], env);
  const byId = new Map(releaseGraph.packages.map((entry) => [entry.id, entry]));

  // The semver lines held: each with the workspace's version, or undefined for a line
  // Cargo resolves.
  const held = new Map<string, string | undefined>();
  const hold = (key: string): boolean => {
    if (held.has(key)) return false;
    held.set(key, own.get(key)?.entry.version);
    return true;
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const entry of workspace) {
      const key = semverLine(lockedOf(entry));
      if (releaseLines.has(key) && held.get(key) !== entry.version) continue;
      for (const { name, req } of entry.dependencies)
        for (const { entry: shipped } of releaseByName.get(name) ?? []) {
          const kept = own.get(semverLine(shipped))?.entry.version;
          if (kept !== undefined && admits(req, kept) && !admits(req, shipped.version))
            grew = hold(semverLine(shipped)) || grew;
        }
    }
    for (const { id, deps } of releaseGraph.resolve.nodes) {
      const dependent = byId.get(id);
      if (dependent === undefined || held.has(semverLine(lockedOf(dependent)))) continue;
      const displaced = deps.some(({ pkg }) => {
        const dependency = byId.get(pkg);
        if (dependency === undefined || !held.has(semverLine(lockedOf(dependency)))) return false;
        const replacement = held.get(semverLine(lockedOf(dependency)));
        return dependent.dependencies.some(
          ({ name, req }) =>
            name === dependency.name &&
            admits(req, dependency.version) &&
            (replacement === undefined || !admits(req, replacement)),
        );
      });
      if (displaced) grew = hold(semverLine(lockedOf(dependent))) || grew;
    }
  }

  const blocks = release.blocks.flatMap((block) => {
    const key = semverLine(block.entry);
    const kept = own.get(key);
    own.delete(key);
    if (!held.has(key)) return [block];
    return kept === undefined ? [] : [kept];
  });
  writeFileSync(
    lock,
    `${[release.header.trimEnd(), ...[...blocks, ...own.values()].map((block) => block.text.trimEnd())].join('\n\n')}\n`,
  );
}

export function table(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a Cargo manifest table');
  }
  return value as Record<string, unknown>;
}

export function manifestText(value: unknown): string {
  const text = Bun.TOML.stringify(value);
  if (text === undefined) throw new Error('Cargo manifest could not be serialized');
  return text;
}

/** Cargo paths are relative to the table's original manifest, including target tables. */
export function absoluteCargoPaths(value: unknown, directory: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => absoluteCargoPaths(entry, directory));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === 'path' && typeof entry === 'string'
        ? path.resolve(directory, entry)
        : absoluteCargoPaths(entry, directory),
    ]),
  );
}

/** The production workspace's lints and `[patch.crates-io]` table, with absolute paths. */
export async function productionWorkspaceTables(): Promise<{ lints: unknown; patch: unknown }> {
  const production = table(Bun.TOML.parse(await Bun.file(path.join(root, 'Cargo.toml')).text()));
  return {
    lints: table(production.workspace).lints,
    patch: absoluteCargoPaths(production.patch, root),
  };
}

/**
 * Cargo's environment without the ambient toolchain or flag overrides: the
 * pinned toolchain applies, and encoded flags would take precedence over the
 * `RUSTFLAGS` a generated workspace sets. `RUSTFLAGS` also replaces the
 * rustflags of the workspace `.cargo/config.toml`, so the x86_64 CPU floor
 * that file sets is repeated here.
 */
export function cargoEnvironment(
  rustflags: string,
  targetDir: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides };
  delete env.RUSTUP_TOOLCHAIN;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  env.RUSTFLAGS = process.arch === 'x64' ? `${rustflags} -C target-feature=+ssse3` : rustflags;
  env.CARGO_TARGET_DIR = targetDir;
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
