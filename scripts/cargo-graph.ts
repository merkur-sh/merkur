/**
 * What the generators of a crate hub's own workspace share, `scripts/wasm-artifact-manifests.ts`
 * and `scripts/sim-workspace.ts`: Cargo's resolved graph as each reads it, the workspace's files
 * and the hub declaration `MODULE.bazel` includes.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Schema } from 'effect';

/** The directory under a hub's workspace holding its members' manifests. */
export const MEMBERS = 'crates';

export const Metadata = Schema.Struct({
  packages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      manifest_path: Schema.String,
      source: Schema.NullOr(Schema.String),
    }),
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
export type Metadata = typeof Metadata.Type;

/** Cargo's standard output in `cwd`. */
export function runCargo(
  cwd: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): string {
  const result = Bun.spawnSync(['cargo', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0)
    throw new Error(`cargo ${args.join(' ')} failed:\n${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** The `cargo tree` flags printing one `{p}|{f}` line per crate, as `treeCrates` reads them. */
export const TREE_FORMAT = ['--prefix', 'none', '-f', '{p}|{f}'] as const;

const TREE_LINE = /^(\S+) v(\S+)(?: \(([^)]+)\))?\|(.*?)(?: \(\*\))?$/;

export interface TreeCrate {
  readonly name: string;
  readonly version: string;
  /** The crate's directory, for a crate Cargo reads from a path. */
  readonly location: string | undefined;
  readonly features: readonly string[];
}

/** Each crate of a `TREE_FORMAT` tree, by `name version`. */
export function treeCrates(output: string): Map<string, TreeCrate> {
  const crates = new Map<string, TreeCrate>();
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const match = line.match(TREE_LINE);
    if (match?.[1] === undefined || match[2] === undefined || match[4] === undefined)
      throw new Error(`unreadable cargo tree line: ${line}`);
    crates.set(`${match[1]} ${match[2]}`, {
      name: match[1],
      version: match[2],
      location: match[3],
      features: match[4] === '' ? [] : match[4].split(',').sort(),
    });
  }
  return crates;
}

/** Fails when a generated workspace resolves crates or features the reference does not. */
export function requireSameResolution(
  got: readonly string[],
  want: readonly string[],
  what: string,
): void {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  const only = (from: readonly string[], other: readonly string[]) =>
    from.filter((entry) => !other.includes(entry));
  throw new Error(
    `${what}:\n` +
      `  only here: ${only(got, want).join('\n             ')}\n` +
      `  only there: ${only(want, got).join('\n              ')}`,
  );
}

/**
 * The members a resolved node depends on, as labels: normal edges, and dev ones too when `dev`.
 * Undefined when Cargo resolved no such node.
 */
export function memberLabels(
  metadata: Metadata,
  members: ReadonlyMap<string, { readonly library: string }>,
  id: string | undefined,
  dev: boolean,
): string[] | undefined {
  const node = metadata.resolve.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) return undefined;
  const labels: string[] = [];
  for (const dep of node.deps) {
    const member = members.get(dep.pkg);
    if (member === undefined) continue;
    if (!dep.dep_kinds.some(({ kind }) => kind === null || (dev && kind === 'dev'))) continue;
    if (dep.name !== member.library) throw new Error(`${dep.pkg} is renamed to ${dep.name}`);
    labels.push(`:${member.library}`);
  }
  return labels.sort();
}

/** Writes a workspace's root manifest and, replacing any earlier ones, its members'. */
export function writeWorkspace(
  directory: string,
  root: string,
  members: ReadonlyMap<string, string>,
): void {
  rmSync(path.join(directory, MEMBERS), { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'Cargo.toml'), root);
  for (const [member, text] of members) {
    mkdirSync(path.join(directory, MEMBERS, member), { recursive: true });
    writeFileSync(path.join(directory, MEMBERS, member, 'Cargo.toml'), text);
  }
}

/** A hub's `crate.from_cargo` over the workspace in `directory`. */
export function fromCargo(
  hub: string,
  directory: string,
  members: readonly string[],
  triples: readonly string[],
): string[] {
  return [
    'crate.from_cargo(',
    `    name = "${hub}",`,
    `    cargo_lockfile = "//${directory}:Cargo.lock",`,
    '    manifests = [',
    `        "//${directory}:Cargo.toml",`,
    ...members.map((member) => `        "//${directory}:${MEMBERS}/${member}/Cargo.toml",`),
    '    ],',
    '    supported_platform_triples = [',
    ...triples.map((triple) => `        "${triple}",`),
    '    ],',
    ')',
  ];
}
