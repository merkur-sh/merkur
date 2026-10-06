import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * Children are awaited, never run synchronously: Bun's synchronous spawn can lose a child's
 * exit and leave every later one in the process without it (oven-sh/bun#34069).
 */
const execFileAsync = promisify(execFile);

export const EDGE_HARNESS_NATIVE_MANIFEST_ENV = 'MERKUR_EDGE_HARNESS_NATIVE_ARTIFACT_MANIFEST';
export const EDGE_HARNESS_NATIVE_MANIFEST_OWNER = 'merkur-edge-harness-prebuilt-native-artifacts';
export const EDGE_HARNESS_NATIVE_BUILD_COMMANDS = [
  [
    'cargo',
    'build',
    '--manifest-path',
    'Cargo.toml',
    '--bins',
    '-p',
    'merkur-edge',
    '-p',
    'merkur-dataplane',
    '-p',
    'merkur-image-worker',
    '-p',
    'merkur-tui',
    '--release',
    '--locked',
    ...(process.env.MERKUR_TPM_SIM_ADDR === undefined
      ? []
      : ['--features', 'merkur-dataplane/tpm-sim']),
  ],
] as const;

const MANIFEST_BYTE_LIMIT = 1024 * 1024;
const SOURCE_FILE_LIMIT = 4096;
const ARTIFACT_BYTE_LIMIT = 128 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const NATIVE_SOURCE_PATHS = [
  '.cargo',
  'Cargo.lock',
  'Cargo.toml',
  'rust-toolchain.toml',
  'apps/daemon/dataplane',
  'apps/edge',
  'apps/tui',
  'packages/alacritty-terminal-patch',
  'packages/merkur-authorization',
  'packages/merkur-client',
  'packages/merkur-client-native',
  'packages/merkur-codec',
  'packages/merkur-e2e',
  'packages/merkur-edge-protocol',
  'packages/merkur-fec',
  'packages/merkur-graphics',
  'packages/merkur-image-worker',
  'packages/merkur-wire',
  'packages/quinn-patch',
  'packages/quinn-proto-patch',
  'packages/term-wasm',
  'packages/vte-patch',
  'packages/wtransport-patch',
] as const;
const BUILD_OVERRIDE_NAMES = new Set([
  'AR',
  'CC',
  'CFLAGS',
  'CPPFLAGS',
  'LDFLAGS',
  'MACOSX_DEPLOYMENT_TARGET',
  'RUSTC',
  'RUSTC_WRAPPER',
  'RUSTC_WORKSPACE_WRAPPER',
  'RUSTFLAGS',
  'SDKROOT',
]);
const INSTALL_PATHS = {
  dataplane: ['target/rust/release/merkur-dataplane', 'apps/daemon/dist/merkur-dataplane'],
  imageWorker: ['target/rust/release/merkur-image-worker', 'apps/daemon/dist/merkur-image-worker'],
  edge: ['target/rust/release/merkur-edge'],
  proxy: ['target/rust/release/delay_proxy'],
  tui: ['target/rust/release/merkur-tui'],
} as const;
const NATIVE_BUILD_ARTIFACT_NAMES = [
  'merkur-dataplane',
  'merkur-image-worker',
  'merkur-edge',
  'delay_proxy',
  'merkur-tui',
] as const;

type ArtifactName = keyof typeof INSTALL_PATHS;
export type NativeBuildArtifactName = (typeof NATIVE_BUILD_ARTIFACT_NAMES)[number];

export interface NativeSourceClosureEntry {
  readonly path: string;
  readonly kind: 'file';
  readonly byteLength: number;
  readonly sha256: string;
}

export interface NativeSourceClosure {
  readonly sha256: string;
  readonly entries: readonly NativeSourceClosureEntry[];
}

export interface NativeToolEvidence {
  readonly invokedPath: string;
  readonly resolvedPath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly versionVerbose: string;
}

export interface NativeToolchainEvidence {
  readonly cargo: NativeToolEvidence;
  readonly rustc: NativeToolEvidence;
}

export interface NativeArtifactEvidence {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

type InstalledNativeArtifactEvidence = NativeArtifactEvidence & {
  readonly installedPaths: readonly string[];
};

export interface EdgeHarnessNativeArtifactManifest {
  readonly schemaVersion: 1;
  readonly owner: typeof EDGE_HARNESS_NATIVE_MANIFEST_OWNER;
  readonly source: NativeSourceClosure;
  readonly toolchain: NativeToolchainEvidence;
  readonly build: {
    readonly commands: typeof EDGE_HARNESS_NATIVE_BUILD_COMMANDS;
    readonly environmentOverrides: readonly { readonly name: string; readonly value: string }[];
  };
  readonly artifacts: Readonly<Record<ArtifactName, NativeArtifactEvidence>>;
}

export type EdgeHarnessNativeArtifactProvenance =
  | {
      readonly mode: 'built-in-worktree';
      readonly buildCommands: typeof EDGE_HARNESS_NATIVE_BUILD_COMMANDS;
      readonly artifacts: Readonly<Record<ArtifactName, InstalledNativeArtifactEvidence>>;
    }
  | {
      readonly mode: 'verified-prebuilt';
      readonly manifestPath: string;
      readonly manifestSha256: string;
      readonly sourceClosureSha256: string;
      readonly toolchain: NativeToolchainEvidence;
      readonly buildCommands: typeof EDGE_HARNESS_NATIVE_BUILD_COMMANDS;
      readonly buildEnvironmentOverrides: readonly {
        readonly name: string;
        readonly value: string;
      }[];
      readonly artifacts: Readonly<Record<ArtifactName, InstalledNativeArtifactEvidence>>;
    };

export async function computeNativeSourceClosure(root: string): Promise<NativeSourceClosure> {
  const resolvedRoot = realpathSync(root);
  const status = await git(resolvedRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    ...NATIVE_SOURCE_PATHS,
  ]);
  if (status.length !== 0) {
    throw new Error('native source closure is dirty or contains untracked files');
  }
  const files = (await git(resolvedRoot, ['ls-files', '-z', '--', ...NATIVE_SOURCE_PATHS]))
    .split('\0')
    .filter((entry) => entry.length > 0)
    .sort(compareCodeUnits);
  if (files.length === 0 || files.length > SOURCE_FILE_LIMIT) {
    throw new Error(`native source closure has invalid file count ${files.length}`);
  }
  const entries = files.map((relativePath): NativeSourceClosureEntry => {
    requireSafeRelativePath(relativePath, 'native source');
    const absolute = path.join(resolvedRoot, relativePath);
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`native source closure refuses symbolic links: ${relativePath}`);
    }
    if (!metadata.isFile()) throw new Error(`native source is not a file: ${relativePath}`);
    const body = readFileSync(absolute);
    return {
      path: relativePath,
      kind: 'file',
      byteLength: body.byteLength,
      sha256: hash(body),
    };
  });
  return { sha256: hash(JSON.stringify(entries)), entries };
}

export async function collectNativeToolchainEvidence(
  root: string,
): Promise<NativeToolchainEvidence> {
  const resolvedRoot = realpathSync(root);
  return {
    cargo: await collectTool('cargo', resolvedRoot),
    rustc: await collectTool('rustc', resolvedRoot),
  };
}

export function collectNativeBuildEnvironmentOverrides(
  environment: NodeJS.ProcessEnv = process.env,
): readonly { readonly name: string; readonly value: string }[] {
  return Object.entries(environment)
    .filter(
      ([name, value]) =>
        value !== undefined &&
        (BUILD_OVERRIDE_NAMES.has(name) ||
          name === 'CARGO_BUILD_TARGET' ||
          name === 'CARGO_ENCODED_RUSTFLAGS' ||
          name === 'CARGO_TARGET_DIR' ||
          name.startsWith('CARGO_PROFILE_') ||
          (name.startsWith('CARGO_TARGET_') && name.endsWith('_RUSTFLAGS'))),
    )
    .map(([name, value]) => ({ name, value: value ?? '' }))
    .sort((left, right) => compareCodeUnits(left.name, right.name));
}

/**
 * Validates Cargo's repository-local release output chain before a benchmark
 * preflight build can write through it.
 */
export function ensureCanonicalNativeBuildOutputDirectory(root: string): string {
  const resolvedRoot = realpathSync(root);
  const relativeDirectory = 'target/rust/release';
  ensureCanonicalDirectory(resolvedRoot, relativeDirectory);
  return path.join(resolvedRoot, relativeDirectory);
}

export function validateCanonicalNativeBuildArtifact(
  root: string,
  name: NativeBuildArtifactName,
): string {
  if (!NATIVE_BUILD_ARTIFACT_NAMES.includes(name)) {
    throw new Error(`unknown native build artifact: ${name}`);
  }
  const artifactPath = path.join(ensureCanonicalNativeBuildOutputDirectory(root), name);
  // Cargo hard-links top-level executables to its deps directory on Linux.
  // The preparation script copies these into independently owned retained files.
  return collectArtifact(artifactPath, 'cargo-output').path;
}

export async function createEdgeHarnessNativeArtifactManifest(
  root: string,
  artifactPaths: Readonly<Record<ArtifactName, string>>,
): Promise<EdgeHarnessNativeArtifactManifest> {
  return {
    schemaVersion: 1,
    owner: EDGE_HARNESS_NATIVE_MANIFEST_OWNER,
    source: await computeNativeSourceClosure(root),
    toolchain: await collectNativeToolchainEvidence(root),
    build: {
      commands: EDGE_HARNESS_NATIVE_BUILD_COMMANDS,
      environmentOverrides: collectNativeBuildEnvironmentOverrides(),
    },
    artifacts: {
      dataplane: collectArtifact(artifactPaths.dataplane),
      imageWorker: collectArtifact(artifactPaths.imageWorker),
      edge: collectArtifact(artifactPaths.edge),
      proxy: collectArtifact(artifactPaths.proxy),
      tui: collectArtifact(artifactPaths.tui),
    },
  };
}

export async function provisionEdgeHarnessNativeArtifacts(
  root: string,
  manifestPath: string | undefined,
  build: () => Promise<void>,
): Promise<EdgeHarnessNativeArtifactProvenance> {
  if (manifestPath !== undefined) {
    return installVerifiedPrebuiltArtifacts(root, manifestPath);
  }
  await build();
  return {
    mode: 'built-in-worktree',
    buildCommands: EDGE_HARNESS_NATIVE_BUILD_COMMANDS,
    artifacts: collectInstalledArtifacts(root),
  };
}

export function verifyProvisionedNativeArtifacts(
  provenance: EdgeHarnessNativeArtifactProvenance,
): void {
  for (const name of artifactNames()) {
    const artifact = provenance.artifacts[name];
    for (const [index, artifactPath] of artifact.installedPaths.entries()) {
      const collected = collectArtifact(artifactPath, index === 0 ? 'cargo-output' : 'retained');
      if (
        collected.path !== realpathSync(artifactPath) ||
        collected.byteLength !== artifact.byteLength ||
        collected.sha256 !== artifact.sha256
      ) {
        throw new Error(`${name} artifact changed after native preflight`);
      }
    }
  }
}

export async function verifyInstalledPrebuiltNativeArtifacts(
  root: string,
  manifestPath: string,
): Promise<Extract<EdgeHarnessNativeArtifactProvenance, { mode: 'verified-prebuilt' }>> {
  const verified = await loadVerifiedPrebuiltManifest(root, manifestPath);
  const installed = collectInstalledArtifacts(root);
  for (const name of artifactNames()) {
    const expected = verified.manifest.artifacts[name];
    const actual = installed[name];
    if (actual.byteLength !== expected.byteLength || actual.sha256 !== expected.sha256) {
      throw new Error(`${name} installed artifact does not match the prebuilt manifest`);
    }
  }
  return prebuiltProvenance(verified, installed);
}

export async function resolveVerifiedPrebuiltDataplanePath(
  root: string,
  manifestPath: string,
): Promise<string> {
  const provenance = await verifyInstalledPrebuiltNativeArtifacts(root, manifestPath);
  const expected = path.join(realpathSync(root), INSTALL_PATHS.dataplane[1]);
  if (!provenance.artifacts.dataplane.installedPaths.includes(expected)) {
    throw new Error('prebuilt manifest did not install the candidate-local daemon dataplane');
  }
  return expected;
}

async function installVerifiedPrebuiltArtifacts(
  root: string,
  manifestPath: string,
): Promise<Extract<EdgeHarnessNativeArtifactProvenance, { mode: 'verified-prebuilt' }>> {
  const verified = await loadVerifiedPrebuiltManifest(root, manifestPath);
  const { manifest, artifactBodies } = verified;
  const resolvedRoot = realpathSync(root);
  const sourcePaths = new Set(artifactNames().map((name) => manifest.artifacts[name].path));
  const installPlan: Array<{
    readonly name: ArtifactName;
    readonly destination: string;
    readonly body: Buffer;
    readonly sha256: string;
  }> = [];

  // Validate every destination before replacing the first one. A late bad
  // ancestor or target must not leave a candidate worktree with a mixture of
  // old and prebuilt native executables.
  for (const name of artifactNames()) {
    const source = manifest.artifacts[name];
    const sourceBody = artifactBodies.get(name);
    if (sourceBody === undefined) throw new Error(`native artifact ${name} was not retained`);
    for (const relativePath of INSTALL_PATHS[name]) {
      requireSafeRelativePath(relativePath, 'native artifact install');
      const destination = path.join(resolvedRoot, relativePath);
      ensureCanonicalDirectory(resolvedRoot, path.dirname(relativePath));
      if (sourcePaths.has(destination)) {
        throw new Error(`${name} manifest source cannot also be a native install target`);
      }
      validateInstallDestination(resolvedRoot, relativePath, name);
      installPlan.push({ name, destination, body: sourceBody, sha256: source.sha256 });
    }
  }

  for (const item of installPlan) {
    // Repeat the path/type check immediately before the atomic rename. This
    // closes accidental changes between the all-target preflight and install;
    // the post-install collector independently rechecks canonical paths/bytes.
    const relativePath = path.relative(resolvedRoot, item.destination);
    validateInstallDestination(resolvedRoot, relativePath, item.name);
    installRetainedArtifact(item.destination, item.body, item.sha256);
  }
  return verifyInstalledPrebuiltNativeArtifacts(root, manifestPath);
}

interface VerifiedPrebuiltManifest {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifest: EdgeHarnessNativeArtifactManifest;
  readonly artifactBodies: ReadonlyMap<ArtifactName, Buffer>;
}

async function loadVerifiedPrebuiltManifest(
  root: string,
  manifestPath: string,
): Promise<VerifiedPrebuiltManifest> {
  if (!path.isAbsolute(manifestPath)) {
    throw new Error(`${EDGE_HARNESS_NATIVE_MANIFEST_ENV} must be an absolute path`);
  }
  const resolvedManifestPath = realpathSync(manifestPath);
  if (resolvedManifestPath !== manifestPath) {
    throw new Error('native artifact manifest path must already be fully resolved');
  }
  const manifestMetadata = lstatSync(resolvedManifestPath);
  if (
    manifestMetadata.isSymbolicLink() ||
    !manifestMetadata.isFile() ||
    manifestMetadata.nlink !== 1 ||
    manifestMetadata.size <= 0 ||
    manifestMetadata.size > MANIFEST_BYTE_LIMIT
  ) {
    throw new Error('native artifact manifest has invalid size');
  }
  const manifestBody = readFileSync(resolvedManifestPath);
  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestBody.toString('utf8'));
  } catch {
    throw new Error('native artifact manifest is not valid JSON');
  }
  const manifest = parseManifest(decoded);
  const currentSource = await computeNativeSourceClosure(root);
  if (JSON.stringify(manifest.source) !== JSON.stringify(currentSource)) {
    throw new Error('native artifact manifest source closure does not match this worktree');
  }
  const currentToolchain = await collectNativeToolchainEvidence(root);
  if (JSON.stringify(manifest.toolchain) !== JSON.stringify(currentToolchain)) {
    throw new Error('native artifact manifest toolchain does not match this host');
  }
  const currentEnvironment = collectNativeBuildEnvironmentOverrides();
  if (JSON.stringify(manifest.build.environmentOverrides) !== JSON.stringify(currentEnvironment)) {
    throw new Error('native artifact manifest build environment does not match this process');
  }

  const artifactBodies = new Map<ArtifactName, Buffer>();
  const sourcePaths = new Set<string>();
  for (const name of artifactNames()) {
    const artifact = manifest.artifacts[name];
    if (!path.isAbsolute(artifact.path)) throw new Error(`${name} artifact path is not absolute`);
    const resolved = realpathSync(artifact.path);
    if (resolved !== artifact.path || sourcePaths.has(resolved)) {
      throw new Error(`${name} artifact path is unresolved or reused`);
    }
    const sourceMetadata = lstatSync(resolved);
    if (!sourceMetadata.isFile() || sourceMetadata.nlink !== 1) {
      throw new Error(`${name} artifact is not a singly linked regular file`);
    }
    sourcePaths.add(resolved);
    accessSync(resolved, constants.R_OK | constants.X_OK);
    const body = readFileSync(resolved);
    if (
      body.byteLength <= 0 ||
      body.byteLength > ARTIFACT_BYTE_LIMIT ||
      body.byteLength !== artifact.byteLength ||
      hash(body) !== artifact.sha256
    ) {
      throw new Error(`${name} artifact bytes do not match the manifest`);
    }
    artifactBodies.set(name, body);
  }
  return {
    manifestPath: resolvedManifestPath,
    manifestSha256: hash(manifestBody),
    manifest,
    artifactBodies,
  };
}

function prebuiltProvenance(
  verified: VerifiedPrebuiltManifest,
  installed: Readonly<Record<ArtifactName, InstalledNativeArtifactEvidence>>,
): Extract<EdgeHarnessNativeArtifactProvenance, { mode: 'verified-prebuilt' }> {
  return {
    mode: 'verified-prebuilt',
    manifestPath: verified.manifestPath,
    manifestSha256: verified.manifestSha256,
    sourceClosureSha256: verified.manifest.source.sha256,
    toolchain: verified.manifest.toolchain,
    buildCommands: EDGE_HARNESS_NATIVE_BUILD_COMMANDS,
    buildEnvironmentOverrides: verified.manifest.build.environmentOverrides,
    artifacts: installed,
  };
}

function parseManifest(value: unknown): EdgeHarnessNativeArtifactManifest {
  const manifest = record(value, 'native artifact manifest');
  exactKeys(manifest, ['schemaVersion', 'owner', 'source', 'toolchain', 'build', 'artifacts']);
  if (manifest.schemaVersion !== 1 || manifest.owner !== EDGE_HARNESS_NATIVE_MANIFEST_OWNER) {
    throw new Error('native artifact manifest identity is invalid');
  }
  const source = parseSourceClosure(manifest.source);
  const toolchainValue = record(manifest.toolchain, 'native toolchain');
  exactKeys(toolchainValue, ['cargo', 'rustc']);
  const toolchain = {
    cargo: parseTool(toolchainValue.cargo, 'cargo'),
    rustc: parseTool(toolchainValue.rustc, 'rustc'),
  };
  const build = record(manifest.build, 'native build');
  exactKeys(build, ['commands', 'environmentOverrides']);
  if (JSON.stringify(build.commands) !== JSON.stringify(EDGE_HARNESS_NATIVE_BUILD_COMMANDS)) {
    throw new Error('native artifact manifest build commands are not exact');
  }
  if (!Array.isArray(build.environmentOverrides)) {
    throw new Error('native artifact manifest environment overrides are invalid');
  }
  const environmentOverrides = build.environmentOverrides.map((entry, index) => {
    const item = record(entry, `native build environment override ${index}`);
    exactKeys(item, ['name', 'value']);
    if (typeof item.name !== 'string' || item.name.length === 0 || typeof item.value !== 'string') {
      throw new Error(`native build environment override ${index} is invalid`);
    }
    return { name: item.name, value: item.value };
  });
  if (
    environmentOverrides.some(
      (entry, index) =>
        index > 0 && compareCodeUnits(environmentOverrides[index - 1]?.name ?? '', entry.name) >= 0,
    )
  ) {
    throw new Error('native build environment overrides are not uniquely sorted');
  }
  const artifactsValue = record(manifest.artifacts, 'native artifacts');
  exactKeys(artifactsValue, artifactNames());
  return {
    schemaVersion: 1,
    owner: EDGE_HARNESS_NATIVE_MANIFEST_OWNER,
    source,
    toolchain,
    build: { commands: EDGE_HARNESS_NATIVE_BUILD_COMMANDS, environmentOverrides },
    artifacts: {
      dataplane: parseArtifact(artifactsValue.dataplane, 'dataplane'),
      imageWorker: parseArtifact(artifactsValue.imageWorker, 'imageWorker'),
      edge: parseArtifact(artifactsValue.edge, 'edge'),
      proxy: parseArtifact(artifactsValue.proxy, 'proxy'),
      tui: parseArtifact(artifactsValue.tui, 'tui'),
    },
  };
}

function parseSourceClosure(value: unknown): NativeSourceClosure {
  const source = record(value, 'native source closure');
  exactKeys(source, ['sha256', 'entries']);
  if (!SHA256.test(source.sha256 as string) || !Array.isArray(source.entries)) {
    throw new Error('native source closure is invalid');
  }
  if (source.entries.length === 0 || source.entries.length > SOURCE_FILE_LIMIT) {
    throw new Error('native source closure file count is invalid');
  }
  const entries = source.entries.map((entry, index): NativeSourceClosureEntry => {
    const item = record(entry, `native source entry ${index}`);
    exactKeys(item, ['path', 'kind', 'byteLength', 'sha256']);
    if (typeof item.path !== 'string')
      throw new Error(`native source entry ${index} path is invalid`);
    requireSafeRelativePath(item.path, 'native source');
    if (
      item.kind !== 'file' ||
      !Number.isSafeInteger(item.byteLength) ||
      (item.byteLength as number) < 0 ||
      typeof item.sha256 !== 'string' ||
      !SHA256.test(item.sha256)
    ) {
      throw new Error(`native source entry ${index} is invalid`);
    }
    return {
      path: item.path,
      kind: item.kind,
      byteLength: item.byteLength as number,
      sha256: item.sha256,
    };
  });
  if (
    entries.some(
      (entry, index) =>
        index > 0 && compareCodeUnits(entries[index - 1]?.path ?? '', entry.path) >= 0,
    )
  ) {
    throw new Error('native source closure paths are not uniquely sorted');
  }
  const sha256 = source.sha256 as string;
  if (hash(JSON.stringify(entries)) !== sha256) {
    throw new Error('native source closure digest is invalid');
  }
  return { sha256, entries };
}

function parseTool(value: unknown, name: string): NativeToolEvidence {
  const tool = record(value, `${name} tool`);
  exactKeys(tool, ['invokedPath', 'resolvedPath', 'byteLength', 'sha256', 'versionVerbose']);
  if (
    typeof tool.invokedPath !== 'string' ||
    !path.isAbsolute(tool.invokedPath) ||
    typeof tool.resolvedPath !== 'string' ||
    !path.isAbsolute(tool.resolvedPath) ||
    !Number.isSafeInteger(tool.byteLength) ||
    (tool.byteLength as number) <= 0 ||
    typeof tool.sha256 !== 'string' ||
    !SHA256.test(tool.sha256) ||
    typeof tool.versionVerbose !== 'string' ||
    tool.versionVerbose.length === 0
  ) {
    throw new Error(`${name} tool evidence is invalid`);
  }
  return {
    invokedPath: tool.invokedPath,
    resolvedPath: tool.resolvedPath,
    byteLength: tool.byteLength as number,
    sha256: tool.sha256,
    versionVerbose: tool.versionVerbose,
  };
}

function parseArtifact(value: unknown, name: string): NativeArtifactEvidence {
  const artifact = record(value, `${name} artifact`);
  exactKeys(artifact, ['path', 'byteLength', 'sha256']);
  if (
    typeof artifact.path !== 'string' ||
    !path.isAbsolute(artifact.path) ||
    !Number.isSafeInteger(artifact.byteLength) ||
    (artifact.byteLength as number) <= 0 ||
    typeof artifact.sha256 !== 'string' ||
    !SHA256.test(artifact.sha256)
  ) {
    throw new Error(`${name} artifact evidence is invalid`);
  }
  return {
    path: artifact.path,
    byteLength: artifact.byteLength as number,
    sha256: artifact.sha256,
  };
}

function collectInstalledArtifacts(
  root: string,
): Readonly<Record<ArtifactName, InstalledNativeArtifactEvidence>> {
  const result = {} as Record<ArtifactName, InstalledNativeArtifactEvidence>;
  for (const name of artifactNames()) {
    const installedPaths = INSTALL_PATHS[name].map((relativePath) =>
      path.join(realpathSync(root), relativePath),
    );
    const primary = collectArtifact(installedPaths[0] ?? '', 'cargo-output');
    for (const installedPath of installedPaths.slice(1)) {
      const sibling = collectArtifact(installedPath);
      if (sibling.byteLength !== primary.byteLength || sibling.sha256 !== primary.sha256) {
        throw new Error(`${name} installed artifact copies do not match`);
      }
    }
    result[name] = { ...primary, installedPaths };
  }
  return result;
}

function collectArtifact(
  artifactPath: string,
  ownership: 'retained' | 'cargo-output' = 'retained',
): NativeArtifactEvidence {
  const absolute = path.resolve(artifactPath);
  const resolved = realpathSync(absolute);
  const metadata = lstatSync(absolute);
  if (
    resolved !== absolute ||
    !metadata.isFile() ||
    (ownership === 'retained' && metadata.nlink !== 1)
  ) {
    throw new Error(`native artifact is not a canonical singly linked file: ${absolute}`);
  }
  accessSync(resolved, constants.R_OK | constants.X_OK);
  const body = readFileSync(resolved);
  if (body.byteLength <= 0 || body.byteLength > ARTIFACT_BYTE_LIMIT) {
    throw new Error(`native artifact has invalid size: ${resolved}`);
  }
  return { path: resolved, byteLength: body.byteLength, sha256: hash(body) };
}

async function collectTool(name: 'cargo' | 'rustc', root: string): Promise<NativeToolEvidence> {
  const executable = resolveExecutableOnPath(name, root);
  if (executable === null) throw new Error(`${name} is unavailable`);
  const invokedPath = executable;
  const resolved = realpathSync(invokedPath);
  accessSync(resolved, constants.R_OK | constants.X_OK);
  const body = readFileSync(resolved);
  // Invoke through the selected command path. A rustup shim chooses cargo vs
  // rustc from argv[0], while the resolved shim bytes are still hashed below.
  const versionVerbose = (
    await execFileAsync(invokedPath, ['--version', '--verbose'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
  if (versionVerbose.length === 0) throw new Error(`${name} returned no version evidence`);
  return {
    invokedPath,
    resolvedPath: resolved,
    byteLength: body.byteLength,
    sha256: hash(body),
    versionVerbose,
  };
}

function resolveExecutableOnPath(name: string, root: string): string | null {
  const pathName =
    process.platform === 'win32'
      ? Object.keys(process.env).find((entry) => entry.toUpperCase() === 'PATH')
      : 'PATH';
  const searchPath = pathName === undefined ? undefined : process.env[pathName];
  if (searchPath === undefined) return null;
  const extensions =
    process.platform === 'win32' && path.extname(name).length === 0
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((entry) => entry.length > 0)
      : [''];
  for (const entry of searchPath.split(path.delimiter)) {
    const directory = path.resolve(root, entry.length === 0 ? '.' : entry);
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        accessSync(candidate, constants.R_OK | constants.X_OK);
        if (!lstatSync(realpathSync(candidate)).isFile()) continue;
        return candidate;
      } catch {
        // Match PATH lookup: an absent or non-executable candidate advances to
        // the next directory without weakening the selected-path evidence.
      }
    }
  }
  return null;
}

let installSequence = 0;

function installRetainedArtifact(destination: string, body: Buffer, expectedSha256: string): void {
  installSequence += 1;
  const temporary = `${destination}.merkur-prebuilt-${process.pid}-${installSequence}`;
  try {
    writeFileSync(temporary, body, { flag: 'wx', mode: 0o555 });
    chmodSync(temporary, 0o555);
    const retained = readFileSync(temporary);
    if (retained.byteLength !== body.byteLength || hash(retained) !== expectedSha256) {
      throw new Error('retained native artifact changed before installation');
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function artifactNames(): readonly ArtifactName[] {
  return ['dataplane', 'imageWorker', 'edge', 'proxy', 'tui'];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    throw new Error(`unexpected ${expected.join('/')} object keys`);
  }
}

function requireSafeRelativePath(value: string, label: string): void {
  if (
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`${label} path is unsafe: ${value}`);
  }
}

function ensureCanonicalDirectory(root: string, relativeDirectory: string): void {
  requireSafeRelativePath(relativeDirectory, 'native artifact directory');
  let current = root;
  for (const part of relativeDirectory.split('/')) {
    current = path.join(current, part);
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o755 });
      continue;
    }
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(current) !== current) {
      throw new Error(`native artifact directory is not canonical: ${current}`);
    }
  }
}

function validateInstallDestination(root: string, relativePath: string, name: ArtifactName): void {
  requireSafeRelativePath(relativePath, 'native artifact install');
  const parentRelative = path.dirname(relativePath);
  ensureCanonicalDirectory(root, parentRelative);
  const parent = path.join(root, parentRelative);
  if (realpathSync(parent) !== parent) {
    throw new Error(`${name} artifact install parent is not canonical`);
  }
  const destination = path.join(root, relativePath);
  let targetMetadata: ReturnType<typeof lstatSync>;
  try {
    targetMetadata = lstatSync(destination);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (
    targetMetadata.isSymbolicLink() ||
    !targetMetadata.isFile() ||
    // Replacing Cargo's directory entry atomically leaves its deps inode intact.
    (relativePath !== INSTALL_PATHS[name][0] && targetMetadata.nlink !== 1) ||
    realpathSync(destination) !== destination
  ) {
    throw new Error(`${name} artifact install target is not a canonical singly linked file`);
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
