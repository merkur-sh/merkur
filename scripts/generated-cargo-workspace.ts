/**
 * Isolated Cargo workspaces that tooling generates under `test-results/`: they
 * compile production source with dependencies (Bolero, turmoil) and flags that
 * must never reach the production workspace or its lockfile.
 */
import path from 'node:path';

export const root = path.resolve(import.meta.dir, '..');

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
 * `RUSTFLAGS` a generated workspace sets.
 */
export function cargoEnvironment(
  rustflags: string,
  targetDir: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides };
  delete env.RUSTUP_TOOLCHAIN;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  env.RUSTFLAGS = rustflags;
  env.CARGO_TARGET_DIR = targetDir;
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
