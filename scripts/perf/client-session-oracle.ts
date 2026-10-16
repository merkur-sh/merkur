import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ignored = new Set(['node_modules', 'target', '.git', 'pkg', 'dist']);
export const CLIENT_SESSION_ORACLE_BUILD = [
  'cargo',
  'build',
  '--locked',
  '-p',
  'merkur-client',
  '--example',
  'browser_session_oracle',
  '--message-format=json',
] as const;
export const CLIENT_SESSION_ORACLE_MANIFEST = 'target/rust/client-session-oracle.json';

function hash(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Exact checkout bytes, including untracked Rust inputs, never file timestamps. */
export function clientSessionOracleSource(root: string): string {
  const files = new Set(['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml']);
  function collect(directory: string, crate: boolean): void {
    const entries = readdirSync(path.join(root, directory), { withFileTypes: true });
    const owned = crate || entries.some((entry) => entry.name === 'Cargo.toml');
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(relative, owned);
      else if (entry.isFile() && owned) files.add(relative);
    }
  }
  collect('.cargo', true);
  collect('apps', false);
  collect('packages', false);
  return hash(
    JSON.stringify(
      [...files].sort().map((file) => [file, hash(readFileSync(path.join(root, file)))]),
    ),
  );
}

export interface ClientSessionOracleManifest {
  readonly source: string;
  readonly executable: string;
  readonly sha256: string;
  readonly command: readonly string[];
}

/** The Cargo preparer's evidence: the checkout's crate inputs and the retained binary. */
function cargoOracleExecutable(root: string, manifest: ClientSessionOracleManifest): string {
  const executable = manifest.executable;
  if (
    manifest.source !== clientSessionOracleSource(root) ||
    JSON.stringify(manifest.command) !== JSON.stringify(CLIENT_SESSION_ORACLE_BUILD) ||
    executable !==
      path.join(
        root,
        'target/rust/client-session-oracle',
        manifest.sha256,
        'browser_session_oracle',
      ) ||
    hash(readFileSync(executable)) !== manifest.sha256
  )
    throw new Error(
      'native Session oracle evidence changed; run bun run scripts/prepare-client-session-oracle.ts',
    );
  return executable;
}

/** A benchmark consumes a proven artifact; it never compiles in its timed test. */
export function clientSessionOracleExecutable(root: string): string {
  return cargoOracleExecutable(
    root,
    JSON.parse(
      readFileSync(path.join(root, CLIENT_SESSION_ORACLE_MANIFEST), 'utf8'),
    ) as ClientSessionOracleManifest,
  );
}

export function clientSessionOracleManifest(
  root: string,
  executable: string,
): ClientSessionOracleManifest {
  return {
    source: clientSessionOracleSource(root),
    executable,
    sha256: hash(readFileSync(executable)),
    command: CLIENT_SESSION_ORACLE_BUILD,
  };
}

/** Cargo may replace its public output in another profile while Bun runs. */
export function retainClientSessionOracle(root: string, compiled: string): string {
  const bytes = readFileSync(compiled);
  const digest = hash(bytes);
  const retained = path.join(
    root,
    'target/rust/client-session-oracle',
    digest,
    'browser_session_oracle',
  );
  mkdirSync(path.dirname(retained), { recursive: true });
  if (!existsSync(retained)) writeFileSync(retained, bytes, { mode: 0o555, flag: 'wx' });
  if (hash(readFileSync(retained)) !== digest)
    throw new Error('retained Session oracle bytes differ from compiler artifact');
  return retained;
}
