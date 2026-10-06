import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertCurrentTermWasmGlue } from './term-wasm-current-glue';

export const TERM_WASM_BUILD_MANIFEST = '.merkur-build.json';

/** Inputs that fix the declared compiler, profile, binding, and packaging pipeline. */
export const TERM_WASM_BAZEL_PIPELINE_INPUTS = [
  '.bazelversion',
  '.bazelrc',
  'MODULE.bazel',
  '.cargo/config.toml',
  'tsconfig.json',
  'tsconfig.base.json',
  'tools/bazel/bun/bun.MODULE.bazel',
  'tools/bazel/bun/extensions.bzl',
  'tools/bazel/bun/rules.bzl',
  'tools/bazel/rust/rust.MODULE.bazel',
  'tools/bazel/rust/defs.bzl',
  'tools/bazel/rust/generate.py',
  'tools/bazel/rust/contexts.py',
  'tools/bazel/wasm/wasm.MODULE.bazel',
  'tools/bazel/wasm/BUILD.bazel',
  'tools/bazel/wasm/extensions.bzl',
  'tools/bazel/wasm/rules.bzl',
  'tools/bazel/wasm/train-profile.ts',
  'tools/bazel/wasm/package.ts',
  'tools/bazel/wasm/optimize.ts',
  'tools/bazel/wasm/input-tree.ts',
  'tools/bazel/rust/units.bzl',
  'tools/bazel/rust/units.py',
  'tools/bazel/rust/llvm_tools.bzl',
  'tools/bazel/rust/units/provenance/term_wasm_profile_use.json',
  'tools/bazel/rust/units/provenance/term_wasm_instrumented.json',
  'packages/term-wasm/wasm_artifacts.bzl',
  'tools/bazel/cc/cc.MODULE.bazel',
  'tools/bazel/cc/wasm_config.bzl',
  'tools/bazel/cc/sdk.BUILD.bazel',
  'apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf',
] as const;

export const TERM_WASM_ARTIFACT_FILES = [
  'package.json',
  'term_wasm.js',
  'term_wasm.d.ts',
  'term_wasm_bg.wasm',
  'term_wasm_bg.wasm.d.ts',
] as const;

export const TERM_WASM_PACKAGE_FILES = [
  ...TERM_WASM_ARTIFACT_FILES,
  '.gitignore',
  TERM_WASM_BUILD_MANIFEST,
] as const;

interface TermWasmBuildManifest {
  readonly schemaVersion: 3;
  readonly sourceSha256: string;
  readonly artifactSha256: Readonly<Record<(typeof TERM_WASM_ARTIFACT_FILES)[number], string>>;
}

export async function calculateTermWasmSourceSha256(repoRoot: string): Promise<string> {
  const closure = await resolveTermWasmCrateClosure(repoRoot);
  const crateFiles = await Promise.all(
    closure.localCrateDirectories.map(async (directory) => [
      path.join(repoRoot, directory, 'Cargo.toml'),
      ...(await sourceFiles(path.join(repoRoot, directory, 'src'))),
    ]),
  );
  const inputs = [
    ...TERM_WASM_BAZEL_PIPELINE_INPUTS.map((input) => path.join(repoRoot, input)),
    path.join(repoRoot, 'Cargo.toml'),
    path.join(repoRoot, 'rust-toolchain.toml'),
    path.join(repoRoot, 'scripts', 'build-term-wasm.ts'),
    // The profile-guided build: its training, the frames it trains on, and
    // the toolchain wiring that passes the profile to the compiler.
    path.join(repoRoot, 'scripts', 'term-wasm-pgo.ts'),
    path.join(repoRoot, 'scripts', 'term-wasm-ingress-fixture.ts'),
    path.join(repoRoot, 'scripts', 'wasm-toolchain.ts'),
    path.join(repoRoot, 'scripts', 'sync-term-wasm.ts'),
    path.join(repoRoot, 'scripts', 'term-wasm-current-glue.ts'),
    path.join(repoRoot, 'scripts', 'term-wasm-provenance.ts'),
    path.join(repoRoot, 'packages', 'term-wasm', '.cargo', 'config.toml'),
    ...crateFiles.flat(),
  ].sort();
  const digest = createHash('sha256');
  for (const input of inputs) {
    digest.update(path.relative(repoRoot, input));
    digest.update('\0');
    digest.update(await fs.readFile(input));
    digest.update('\0');
  }
  // Registry crates are pinned by the lockfile checksum, which fixes their
  // contents exactly, so their sources never need to be present to hash them.
  digest.update('registry');
  digest.update('\0');
  for (const pin of closure.registryPins) {
    digest.update(pin);
    digest.update('\0');
  }
  return digest.digest('hex');
}

export async function writeTermWasmBuildManifest(
  repoRoot: string,
  artifactDirectory: string,
): Promise<void> {
  const manifest: TermWasmBuildManifest = {
    schemaVersion: 3,
    sourceSha256: await calculateTermWasmSourceSha256(repoRoot),
    artifactSha256: await calculateTermWasmArtifactHashes(artifactDirectory),
  };
  await fs.writeFile(
    path.join(artifactDirectory, TERM_WASM_BUILD_MANIFEST),
    `${JSON.stringify(manifest)}\n`,
  );
}

export async function termWasmArtifactsMatchSource(
  repoRoot: string,
  artifactDirectory: string,
): Promise<boolean> {
  try {
    if (!(await hasExactTermWasmArtifactSet(artifactDirectory))) return false;
    const manifest: unknown = JSON.parse(
      await fs.readFile(path.join(artifactDirectory, TERM_WASM_BUILD_MANIFEST), 'utf8'),
    );
    if (
      typeof manifest === 'object' &&
      manifest !== null &&
      Object.keys(manifest).length === 3 &&
      'schemaVersion' in manifest &&
      manifest.schemaVersion === 3 &&
      'sourceSha256' in manifest &&
      typeof manifest.sourceSha256 === 'string' &&
      manifest.sourceSha256 === (await calculateTermWasmSourceSha256(repoRoot)) &&
      'artifactSha256' in manifest
    ) {
      const artifactSha256 = manifest.artifactSha256;
      if (!isTermWasmArtifactHashes(artifactSha256)) return false;
      const actualHashes = await calculateTermWasmArtifactHashes(artifactDirectory);
      return TERM_WASM_ARTIFACT_FILES.every((file) => artifactSha256[file] === actualHashes[file]);
    }
    return false;
  } catch {
    return false;
  }
}

export async function hasExactTermWasmArtifactSet(artifactDirectory: string): Promise<boolean> {
  try {
    const directory = await fs.lstat(artifactDirectory);
    if (!directory.isDirectory()) return false;
    const entries = await fs.readdir(artifactDirectory, { withFileTypes: true });
    if (entries.length !== TERM_WASM_PACKAGE_FILES.length) return false;
    const allowedFiles = new Set<string>(TERM_WASM_PACKAGE_FILES);
    return entries.every((entry) => entry.isFile() && allowedFiles.has(entry.name));
  } catch {
    return false;
  }
}

export async function termWasmArtifactSetsEqual(
  leftDirectory: string,
  rightDirectory: string,
): Promise<boolean> {
  try {
    const [leftIsExact, rightIsExact] = await Promise.all([
      hasExactTermWasmArtifactSet(leftDirectory),
      hasExactTermWasmArtifactSet(rightDirectory),
    ]);
    if (!leftIsExact || !rightIsExact) return false;
    for (const file of TERM_WASM_PACKAGE_FILES) {
      const [left, right] = await Promise.all([
        fs.readFile(path.join(leftDirectory, file)),
        fs.readFile(path.join(rightDirectory, file)),
      ]);
      if (!left.equals(right)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function assertRepositoryTermWasmArtifactsCurrent(repoRoot: string): Promise<void> {
  const sourceDirectory = path.join(repoRoot, 'packages', 'term-wasm', 'pkg');
  const deployedDirectory = path.join(repoRoot, 'apps', 'web', 'src', 'term-wasm', 'pkg');
  const [sourceExists, deployedExists] = await Promise.all([
    pathExists(sourceDirectory),
    pathExists(deployedDirectory),
  ]);

  // Generated terminal WASM is intentionally ignored. A clean checkout has
  // neither tree, while any checkout/build containing one tree must contain
  // the complete, current, synchronized pair.
  if (!sourceExists && !deployedExists) return;

  const violations: string[] = [];
  if (!sourceExists) {
    violations.push('source artifact tree is missing');
  }
  if (!deployedExists) {
    violations.push('deployed web artifact tree is missing');
  }

  if (sourceExists && !(await hasExactTermWasmArtifactSet(sourceDirectory))) {
    violations.push('source artifact tree is not the exact generated package');
  }
  if (deployedExists && !(await hasExactTermWasmArtifactSet(deployedDirectory))) {
    violations.push('deployed web artifact tree is not the exact generated package');
  }

  if (violations.length === 0) {
    const [sourceIsCurrent, deployedIsCurrent, copiesAreEqual] = await Promise.all([
      termWasmArtifactsMatchSource(repoRoot, sourceDirectory),
      termWasmArtifactsMatchSource(repoRoot, deployedDirectory),
      termWasmArtifactSetsEqual(sourceDirectory, deployedDirectory),
    ]);
    if (!sourceIsCurrent) {
      violations.push('source artifacts do not match the current Rust/build inputs');
    }
    if (!deployedIsCurrent) {
      violations.push('deployed web artifacts do not match the current Rust/build inputs');
    }
    if (!copiesAreEqual) {
      violations.push('deployed web artifacts are not an exact copy of source artifacts');
    }

    for (const [label, directory] of [
      ['source', sourceDirectory],
      ['deployed web', deployedDirectory],
    ] as const) {
      try {
        assertCurrentTermWasmGlue({
          javascript: await fs.readFile(path.join(directory, 'term_wasm.js'), 'utf8'),
          declarations: await fs.readFile(path.join(directory, 'term_wasm.d.ts'), 'utf8'),
        });
      } catch {
        violations.push(`${label} artifacts expose retired generated WASM glue`);
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `terminal WASM repository artifacts are stale or incomplete:\n${violations.join(
        '\n',
      )}\nrebuild and synchronize with: bun run build:wasm && bun run sync:wasm`,
    );
  }
}

async function calculateTermWasmArtifactHashes(
  artifactDirectory: string,
): Promise<Record<(typeof TERM_WASM_ARTIFACT_FILES)[number], string>> {
  const entries = await Promise.all(
    TERM_WASM_ARTIFACT_FILES.map(async (file) => {
      const digest = createHash('sha256')
        .update(await fs.readFile(path.join(artifactDirectory, file)))
        .digest('hex');
      return [file, digest] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<(typeof TERM_WASM_ARTIFACT_FILES)[number], string>;
}

function isTermWasmArtifactHashes(
  value: unknown,
): value is Record<(typeof TERM_WASM_ARTIFACT_FILES)[number], string> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === TERM_WASM_ARTIFACT_FILES.length &&
    TERM_WASM_ARTIFACT_FILES.every(
      (file) =>
        Object.hasOwn(record, file) &&
        typeof record[file] === 'string' &&
        /^[0-9a-f]{64}$/.test(record[file]),
    )
  );
}

/** The crate whose dependency closure defines what the WASM build compiles. */
const TERM_WASM_CRATE = 'term-wasm';

interface CargoLockPackage {
  readonly name: string;
  readonly version: string;
  /** Absent for workspace and patched path crates, present for registry crates. */
  readonly source: string | undefined;
  readonly checksum: string | undefined;
  readonly dependencies: readonly string[];
}

interface TermWasmCrateClosure {
  /** Repo-relative directories of the local crates the build compiles from source. */
  readonly localCrateDirectories: readonly string[];
  /** `name version checksum` for every registry crate the build resolves. */
  readonly registryPins: readonly string[];
}

/**
 * Walks Cargo.lock outward from `term-wasm` so the hash covers exactly the
 * crates this WASM build compiles.
 *
 * Both alternatives are wrong in opposite directions. A hand-written list of
 * crate paths drifts silently: the one this replaced omitted
 * `packages/vte-patch`, which `alacritty_terminal` patches in, so edits to the
 * vendored VTE left stale artifacts passing the check. Hashing the whole
 * lockfile instead invalidates the artifacts whenever any workspace dependency
 * moves, including ones no WASM code links.
 *
 * The closure still spans every target platform and includes local crates'
 * dev-dependencies, because Cargo.lock records neither. That errs toward
 * rebuilding, which is the safe direction for a staleness gate.
 */
async function resolveTermWasmCrateClosure(repoRoot: string): Promise<TermWasmCrateClosure> {
  const packages = await readCargoLockPackages(repoRoot);
  const byName = new Map<string, CargoLockPackage[]>();
  for (const entry of packages) {
    const bucket = byName.get(entry.name);
    if (bucket === undefined) byName.set(entry.name, [entry]);
    else bucket.push(entry);
  }

  // Lockfile edges are `name` when unambiguous and `name version` when a crate
  // is resolved at several versions.
  const resolveEdge = (edge: string): CargoLockPackage => {
    const boundary = edge.indexOf(' ');
    const name = boundary === -1 ? edge : edge.slice(0, boundary);
    const version = boundary === -1 ? undefined : edge.slice(boundary + 1);
    const candidates = byName.get(name) ?? [];
    const matches =
      version === undefined ? candidates : candidates.filter((entry) => entry.version === version);
    const [match] = matches;
    if (match === undefined || matches.length !== 1) {
      throw new Error(`Cargo.lock dependency "${edge}" does not resolve to exactly one package`);
    }
    return match;
  };

  const localDirectories = await readLocalCrateDirectories(repoRoot);
  const localCrateDirectories: string[] = [];
  const registryPins: string[] = [];
  const visited = new Set<CargoLockPackage>();
  // Both the active Cargo preparer's driver and same-crate Bazel training hooks
  // shape terminal artifacts. The fixture compressor also shapes their profile.
  const pending = [TERM_WASM_CRATE, 'term-wasm-pgo', 'zstd-fixture'].map(resolveEdge);
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined || visited.has(entry)) continue;
    visited.add(entry);
    if (entry.source === undefined) {
      const directory = localDirectories.get(entry.name);
      if (directory === undefined) {
        throw new Error(
          `Cargo.lock package "${entry.name}" resolves to a local path, but no workspace member ` +
            'or [patch.crates-io] entry declares it, so its sources cannot be hashed',
        );
      }
      localCrateDirectories.push(directory);
    } else {
      if (entry.checksum === undefined) {
        throw new Error(`Cargo.lock registry package "${entry.name}" has no checksum`);
      }
      registryPins.push(`${entry.name} ${entry.version} ${entry.checksum}`);
    }
    for (const edge of entry.dependencies) pending.push(resolveEdge(edge));
  }

  return {
    localCrateDirectories: localCrateDirectories.sort(),
    registryPins: registryPins.sort(),
  };
}

async function readCargoLockPackages(repoRoot: string): Promise<readonly CargoLockPackage[]> {
  const parsed: unknown = Bun.TOML.parse(
    await fs.readFile(path.join(repoRoot, 'Cargo.lock'), 'utf8'),
  );
  if (!isRecord(parsed) || !Array.isArray(parsed.package)) {
    throw new Error('Cargo.lock does not declare a [[package]] array');
  }
  return parsed.package.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.version !== 'string') {
      throw new Error('Cargo.lock contains a package without a name and version');
    }
    const { source, checksum, dependencies } = entry;
    if (source !== undefined && typeof source !== 'string') {
      throw new Error(`Cargo.lock package "${entry.name}" has a non-string source`);
    }
    if (checksum !== undefined && typeof checksum !== 'string') {
      throw new Error(`Cargo.lock package "${entry.name}" has a non-string checksum`);
    }
    if (dependencies !== undefined && !isStringArray(dependencies)) {
      throw new Error(`Cargo.lock package "${entry.name}" has non-string dependencies`);
    }
    return {
      name: entry.name,
      version: entry.version,
      source,
      checksum,
      dependencies: dependencies ?? [],
    };
  });
}

/**
 * Maps crate name to repo-relative directory for every crate that can appear in
 * the closure without a registry source. Patched crates are included by path
 * because their directory name need not match the crate name they replace —
 * `packages/alacritty-terminal-patch` supplies `alacritty_terminal`.
 */
async function readLocalCrateDirectories(repoRoot: string): Promise<ReadonlyMap<string, string>> {
  const manifest: unknown = Bun.TOML.parse(
    await fs.readFile(path.join(repoRoot, 'Cargo.toml'), 'utf8'),
  );
  if (!isRecord(manifest)) throw new Error('root Cargo.toml is not a table');
  const directories = new Set<string>();
  const { workspace, patch } = manifest;
  if (isRecord(workspace) && isStringArray(workspace.members)) {
    for (const member of workspace.members) directories.add(member);
  }
  if (isRecord(patch) && isRecord(patch['crates-io'])) {
    for (const entry of Object.values(patch['crates-io'])) {
      if (isRecord(entry) && typeof entry.path === 'string') directories.add(entry.path);
    }
  }
  const crates = await Promise.all(
    [...directories].map(async (directory) => {
      const crate: unknown = Bun.TOML.parse(
        await fs.readFile(path.join(repoRoot, directory, 'Cargo.toml'), 'utf8'),
      );
      if (!isRecord(crate) || !isRecord(crate.package) || typeof crate.package.name !== 'string') {
        throw new Error(`${directory}/Cargo.toml does not declare a [package] name`);
      }
      return [crate.package.name, directory] as const;
    }),
  );
  return new Map(crates);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
