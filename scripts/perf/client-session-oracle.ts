import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

interface ConfiguredOracleManifest extends ClientSessionOracleManifest {
  readonly sourceInputs: Readonly<Record<string, string>>;
  readonly configuredUnit: string;
}

interface OracleCompilerContext {
  readonly roots: readonly string[];
  readonly compiler_label: string;
  readonly packages: Readonly<Record<string, unknown>>;
  readonly macro_inputs: Readonly<Record<string, readonly string[]>>;
  readonly source_membership: readonly string[];
}

const compilerDescriptor =
  'tools/bazel/rust/native_protocol/provenance/browser_session_oracle_native.json';
const compilerSources = 'tools/bazel/rust/source_inputs.json';

function oracleSourceInputs(manifest: ConfiguredOracleManifest): Readonly<Record<string, string>> {
  const inputs = manifest.sourceInputs;
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs))
    throw new Error('native Session oracle requires declared compiler source facts');
  const required = ['Cargo.lock', 'rust-toolchain.toml', compilerSources, compilerDescriptor];
  if (
    !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    !required.every((file) => Object.hasOwn(inputs, file))
  )
    throw new Error('native Session oracle lacks its selected compiler context');
  return inputs;
}

function verifySourceFacts(root: string, facts: readonly (readonly [string, string])[]): void {
  for (const [relative, expected] of facts) {
    if (
      relative.startsWith('/') ||
      relative.split('/').includes('..') ||
      typeof expected !== 'string' ||
      hash(readFileSync(path.join(root, relative))) !== expected
    )
      throw new Error(`native Session oracle source facts changed: ${relative}`);
  }
}

function packageRustSources(root: string, directory: string): string[] {
  const sources: string[] = [];
  function collect(relative: string): void {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (file === `${directory}/target`) continue;
      if (entry.isDirectory()) collect(file);
      else if (entry.name.endsWith('.rs') && statSync(path.join(root, file)).isFile())
        sources.push(file);
    }
  }
  collect(directory);
  return sources.sort();
}

function verifySelectedPackage(
  root: string,
  directory: string,
  inputs: Readonly<Record<string, string>>,
  sources: Readonly<Record<string, string>>,
): void {
  if (
    directory.startsWith('/') ||
    directory.split('/').some((part) => part === '..' || part === '')
  )
    throw new Error('native Session oracle compiler package escapes its source tree');
  for (const file of [`${directory}/Cargo.toml`, `${directory}/BUILD.bazel`])
    if (!Object.hasOwn(inputs, file))
      throw new Error('native Session oracle compiler declaration membership changed');
  const expected = Object.keys(sources)
    .filter((file) => file.startsWith(`${directory}/`) && file.endsWith('.rs'))
    .sort();
  if (JSON.stringify(packageRustSources(root, directory)) !== JSON.stringify(expected))
    throw new Error('native Session oracle selected Rust source membership changed');
  for (const file of expected)
    if (!Object.hasOwn(inputs, file) || inputs[file] !== sources[file])
      throw new Error('native Session oracle selected Rust source facts changed');
}

function verifyCompilerFixtures(
  descriptor: OracleCompilerContext,
  inputs: Readonly<Record<string, string>>,
): void {
  for (const name of Object.keys(descriptor.packages)) {
    const fixtures = descriptor.macro_inputs[name];
    if (
      !Array.isArray(fixtures) ||
      fixtures.some((file) => typeof file !== 'string' || !Object.hasOwn(inputs, file))
    )
      throw new Error('native Session oracle literal compiler fixture membership changed');
  }
}

function verifyCompilerSources(
  root: string,
  descriptor: OracleCompilerContext,
  inputs: Readonly<Record<string, string>>,
  facts: readonly (readonly [string, string])[],
): void {
  if (
    !Array.isArray(descriptor.source_membership) ||
    descriptor.source_membership.some((file) => typeof file !== 'string') ||
    JSON.stringify(descriptor.source_membership) !== JSON.stringify(facts.map(([file]) => file))
  )
    throw new Error('native Session oracle compiler source membership changed');
  const inventory = JSON.parse(readFileSync(path.join(root, compilerSources), 'utf8')) as {
    readonly sources: Readonly<Record<string, string>>;
  };
  if (
    typeof descriptor.packages !== 'object' ||
    descriptor.packages === null ||
    typeof inventory.sources !== 'object' ||
    inventory.sources === null
  )
    throw new Error('native Session oracle lacks its compiler source inventory');
  const packages = Object.keys(descriptor.packages)
    .filter((name) => name.startsWith('workspace:'))
    .map((name) => name.slice('workspace:'.length));
  if (packages.length === 0)
    throw new Error('native Session oracle lacks its selected firstparty compiler packages');
  for (const directory of packages)
    verifySelectedPackage(root, directory, inputs, inventory.sources);
  verifyCompilerFixtures(descriptor, inputs);
}

function retainedOracle(
  root: string,
  manifest: ConfiguredOracleManifest,
  facts: readonly (readonly [string, string])[],
  compilerLabel: string,
  bytes: Uint8Array,
): string {
  const relative = `target/rust/client-session-oracle/${manifest.sha256}/browser_session_oracle`;
  const executable = path.join(root, relative);
  if (
    manifest.source !== hash(JSON.stringify(facts)) ||
    JSON.stringify(manifest.command) !== JSON.stringify(['bazel', 'build', compilerLabel]) ||
    manifest.executable !== relative ||
    hash(bytes) !== manifest.sha256
  )
    throw new Error(
      'native Session oracle evidence changed; build //tools/bazel/bun:client_session_oracle',
    );
  return executable;
}

/** Validate the actual package action bytes against the selected compiler source Files. */
export function clientSessionOracleArtifact(
  root: string,
  value: unknown,
  bytes: Uint8Array,
): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('native Session oracle requires its configured manifest');
  const manifest = value as ConfiguredOracleManifest;
  const inputs = oracleSourceInputs(manifest);
  const facts = Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  verifySourceFacts(root, facts);
  const descriptor = JSON.parse(
    readFileSync(path.join(root, compilerDescriptor), 'utf8'),
  ) as OracleCompilerContext;
  verifyCompilerSources(root, descriptor, inputs, facts);
  if (
    descriptor.roots.length !== 1 ||
    descriptor.roots[0] !== manifest.configuredUnit ||
    descriptor.compiler_label !== `//tools/bazel/rust/native_protocol:u_${manifest.configuredUnit}`
  )
    throw new Error('native Session oracle compiler root changed');
  return retainedOracle(root, manifest, facts, descriptor.compiler_label, bytes);
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

/**
 * A benchmark consumes a proven artifact; it never compiles in its timed test. A manifest that
 * carries configured source facts is the declared engine's; one without them is the Cargo
 * preparer's. Each is validated whole by its own rule, its command included.
 */
export function clientSessionOracleExecutable(root: string): string {
  const manifest = JSON.parse(
    readFileSync(path.join(root, CLIENT_SESSION_ORACLE_MANIFEST), 'utf8'),
  ) as ConfiguredOracleManifest;
  if (typeof manifest === 'object' && manifest !== null && !('sourceInputs' in manifest))
    return cargoOracleExecutable(root, manifest);
  oracleSourceInputs(manifest);
  const relative = `target/rust/client-session-oracle/${manifest.sha256}/browser_session_oracle`;
  return clientSessionOracleArtifact(root, manifest, readFileSync(path.join(root, relative)));
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
