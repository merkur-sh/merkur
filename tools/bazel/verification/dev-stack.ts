import { watch } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { runDevelopmentStack } from '../../../scripts/dev';
import { loadDevelopmentEnvironment } from '../../../scripts/dev-environment';
import { probeRedis } from '../../../scripts/dev-redis';
import {
  type BunRuntimeManifest,
  materializeBunRuntime,
  runtimeMember,
} from '../bun/runtime-materializer';
import { readDeclaredInput, readEngineArtifact, targetArtifacts } from './artifacts';
import { BazelVerificationEngine } from './bazel-engine';
import { admittedInputs, declaredTools } from './cli';
import type { DeclaredEngineTools } from './engine-process';
import { readBuildEvents } from './events';

export const DEVELOPMENT_NATIVE_PRODUCERS = {
  edge: '//apps/edge:merkur_edge',
  dataplane: '//apps/daemon/dataplane:merkur_dataplane',
  imageWorker: '//packages/merkur-image-worker:bin_merkur_image_worker',
  tui: '//apps/tui:bin_merkur_tui',
} as const;

interface DevelopmentRuntimeManifest extends BunRuntimeManifest {
  readonly workspace: readonly string[];
  readonly vite: string;
  readonly preload: string;
  readonly workspacePackages: Readonly<Record<string, string>>;
  readonly execFiles: Readonly<Record<string, string>>;
}

export function devStackArguments(args: readonly string[]): {
  modes: readonly string[];
  credentialFile: string;
  admitFile?: string;
} {
  const modes: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--server-only' || arg === '--web-only' || arg === '--with-daemon') {
      if (modes.includes(arg)) throw new Error('Duplicate development mode');
      modes.push(arg);
    } else if (arg === '--credential-file' || arg === '--admit-file') {
      const value = args[++index];
      if (value === undefined || !path.isAbsolute(value) || values.has(arg))
        throw new Error('Development File arguments require distinct absolute paths');
      values.set(arg, value);
    } else throw new Error(`Unknown development argument: ${arg}`);
  }
  if (modes.includes('--web-only') && modes.length !== 1)
    throw new Error('Web-only development cannot select other services');
  const credentialFile = values.get('--credential-file');
  if (credentialFile === undefined) throw new Error('Explicit declared credential File required');
  return {
    modes,
    credentialFile,
    ...(values.has('--admit-file') ? { admitFile: values.get('--admit-file') } : {}),
  };
}

export function developmentManifest(value: unknown): DevelopmentRuntimeManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Configured development runtime manifest required');
  const manifest = value as Record<string, unknown>;
  if (
    Object.keys(manifest).sort().join(',') !==
      'config,cwd,execFiles,files,preload,vite,workspace,workspacePackages' ||
    manifest.cwd !== '' ||
    typeof manifest.config !== 'string' ||
    typeof manifest.vite !== 'string' ||
    typeof manifest.preload !== 'string' ||
    typeof manifest.files !== 'object' ||
    manifest.files === null ||
    Array.isArray(manifest.files) ||
    !Array.isArray(manifest.workspace) ||
    !manifest.workspace.every((file) => typeof file === 'string') ||
    new Set(manifest.workspace).size !== manifest.workspace.length
  )
    throw new Error('Incomplete configured development runtime');
  const narrowed = value as DevelopmentRuntimeManifest;
  validateWorkspacePackages(narrowed);
  validateConfiguredInputs(narrowed);
  validateRuntimeFiles(narrowed);
  validateWorkspaceFiles(narrowed);
  const files = manifest.files;
  runtimeMember('/', manifest.vite);
  runtimeMember('/', manifest.preload);
  if (
    !Object.hasOwn(files, manifest.config) ||
    !Object.hasOwn(files, manifest.preload) ||
    !Object.hasOwn(files, '.merkur-dev/vite') ||
    !manifest.vite.startsWith('.merkur-dev/vite/')
  )
    throw new Error('Declared Bun configuration or typed Vite package is absent');
  return value as DevelopmentRuntimeManifest;
}

function validateWorkspacePackages(manifest: DevelopmentRuntimeManifest): void {
  if (
    typeof manifest.workspacePackages !== 'object' ||
    manifest.workspacePackages === null ||
    Array.isArray(manifest.workspacePackages)
  )
    throw new Error('Typed authored npm mappings are absent');
  for (const [runfile, namespace] of Object.entries(manifest.workspacePackages)) {
    runtimeMember('/', runfile);
    if (typeof namespace !== 'string' || namespace.split('/').includes('node_modules'))
      throw new Error('Authored npm package namespace is invalid');
    runtimeMember('/', namespace);
    if (!manifest.workspace.some((file) => file.startsWith(`${namespace}/`)))
      throw new Error('Authored npm package lacks actual mapped SourceFiles');
  }
}

function validateConfiguredInputs(manifest: DevelopmentRuntimeManifest): void {
  if (
    typeof manifest.execFiles !== 'object' ||
    manifest.execFiles === null ||
    Array.isArray(manifest.execFiles)
  )
    throw new Error('Configured development input Files are absent');
  for (const [runfile, input] of Object.entries(manifest.execFiles)) {
    runtimeMember('/', runfile);
    if (typeof input !== 'string') throw new Error('Configured development input path is invalid');
    runtimeMember('/', input);
  }
}

function validateRuntimeFiles(manifest: DevelopmentRuntimeManifest): void {
  const files = manifest.files as Record<string, unknown>;
  for (const [name, entry] of Object.entries(files)) {
    runtimeMember('/', name);
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== 'link,runfile' ||
      !('runfile' in entry) ||
      typeof entry.runfile !== 'string' ||
      !('link' in entry) ||
      typeof entry.link !== 'boolean'
    )
      throw new Error('Invalid configured development File mapping');
    runtimeMember('/', entry.runfile);
    if (!Object.hasOwn(manifest.execFiles, entry.runfile))
      throw new Error('Runtime File has no actual configured input');
  }
}

function validateWorkspaceFiles(manifest: DevelopmentRuntimeManifest): void {
  const files = manifest.files;
  for (const file of manifest.workspace) {
    const entry = files[file] as { link?: boolean } | undefined;
    if (file.split('/').includes('node_modules') || entry?.link !== false)
      throw new Error('Development watch mapping must name an original authored File');
  }
}

/** Only exact declared authored mappings are refreshed; npm remains in the configured runtime. */
export async function refreshDevelopmentSource(
  manifest: DevelopmentRuntimeManifest,
  workspace: string,
  runtime: string,
  relative: string,
): Promise<boolean> {
  if (!manifest.workspace.includes(relative)) return false;
  const original = await readDeclaredInput(workspace, relative);
  await writeFile(runtimeMember(runtime, relative), original.bytes);
  return true;
}

/** Select native executable Files from actual completed configured producer output groups. */
export async function developmentNativeFiles(options: {
  executionRoot: string;
  events: string;
  exitCode: number | null;
  labels: readonly string[];
  destination: string;
}): Promise<ReadonlyMap<string, string>> {
  const report = readBuildEvents(
    options.events,
    options.labels.map((label) => ({ label, kind: 'build', fresh: false })),
  );
  if (
    options.exitCode !== 0 ||
    report.exitCode !== 0 ||
    !report.complete ||
    report.buildToolVersion !== '9.2.0' ||
    report.problems.length !== 0 ||
    report.checks.some((check) => check.status !== 'passed' || check.configuration === null)
  )
    throw new Error('Development binaries require complete pinned-engine build evidence');
  const outputs = new Map<string, string>();
  for (const check of report.checks) {
    if (check.configuration === null)
      throw new Error('Development producer configuration is absent');
    const artifacts = targetArtifacts(options.events, {
      label: check.label,
      configuration: check.configuration,
      group: 'default',
    });
    const artifact = artifacts[0];
    if (artifacts.length !== 1 || artifact === undefined)
      throw new Error('Development native producer must expose exactly one executable File');
    const info = await lstat(path.join(options.executionRoot, artifact.path));
    if (!info.isFile() || (info.mode & 0o111) === 0)
      throw new Error('Development native output is not executable');
    const bytes = await readEngineArtifact(options.executionRoot, artifact);
    const names: Readonly<Record<string, string>> = {
      [DEVELOPMENT_NATIVE_PRODUCERS.edge]: 'merkur-edge',
      [DEVELOPMENT_NATIVE_PRODUCERS.dataplane]: 'merkur-dataplane',
      [DEVELOPMENT_NATIVE_PRODUCERS.imageWorker]: 'merkur-image-worker',
      [DEVELOPMENT_NATIVE_PRODUCERS.tui]: 'merkur-tui',
    };
    const name = names[check.label];
    if (name === undefined) throw new Error('Foreign development native producer');
    const destination = path.join(options.destination, name);
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o555 });
    outputs.set(check.label, destination);
  }
  return outputs;
}

async function nativeBuild(options: {
  root: string;
  directory: string;
  tools: DeclaredEngineTools;
  signal: AbortSignal;
  admittedUntracked: readonly string[];
  labels: readonly string[];
}): Promise<ReadonlyMap<string, string>> {
  const directory = await mkdtemp(path.join(options.directory, 'engine-'));
  const destination = await mkdtemp(path.join(options.directory, 'binaries-'));
  const engine = new BazelVerificationEngine({ ...options, directory, all: false });
  try {
    await engine.initialize();
    return await developmentNativeFiles({
      ...(await engine.buildArtifacts(options.labels)),
      labels: options.labels,
      destination,
    });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
}

interface PreparedDevelopmentRuntime {
  readonly manifest: DevelopmentRuntimeManifest;
  readonly runtime: string;
  readonly native: ReadonlyMap<string, string>;
  readonly close: () => Promise<void>;
}

const DEVELOPMENT_RUNTIME_PRODUCER = '//dev:runtime_inputs';

async function prepareDevelopmentRuntime(options: {
  root: string;
  directory: string;
  tools: DeclaredEngineTools;
  signal: AbortSignal;
  admittedUntracked: readonly string[];
  nativeLabels: readonly string[];
}): Promise<PreparedDevelopmentRuntime> {
  const directory = await mkdtemp(path.join(options.directory, 'generation-'));
  const runtime = path.join(directory, 'runtime');
  const destination = path.join(directory, 'binaries');
  await mkdir(runtime);
  await mkdir(destination);
  const engineDirectory = path.join(directory, 'engine');
  await mkdir(engineDirectory);
  const engine = new BazelVerificationEngine({
    ...options,
    directory: engineDirectory,
    all: false,
  });
  try {
    await engine.initialize();
    const built = await engine.buildArtifacts(
      [...options.nativeLabels, DEVELOPMENT_RUNTIME_PRODUCER],
      ['default', 'development_runtime'],
    );
    const report = readBuildEvents(built.events, [
      { label: DEVELOPMENT_RUNTIME_PRODUCER, kind: 'build', fresh: false },
    ]);
    const check = report.checks[0];
    if (
      built.exitCode !== 0 ||
      !report.complete ||
      report.problems.length !== 0 ||
      report.buildToolVersion !== '9.2.0' ||
      check?.status !== 'passed' ||
      check.configuration === null
    )
      throw new Error('Development runtime requires its complete actual configured producer');
    const descriptors = targetArtifacts(built.events, {
      label: DEVELOPMENT_RUNTIME_PRODUCER,
      configuration: check.configuration,
      group: 'default',
    });
    const descriptor = descriptors[0];
    if (descriptor === undefined || descriptors.length !== 1)
      throw new Error('Development runtime producer must emit its one actual configured manifest');
    const manifest = developmentManifest(
      JSON.parse((await readEngineArtifact(built.executionRoot, descriptor)).toString()),
    );
    await materializeBunRuntime(manifest, '', runtime, manifest.workspacePackages, {
      root: built.executionRoot,
      files: manifest.execFiles,
    });
    for (const file of manifest.workspace)
      await refreshDevelopmentSource(manifest, options.root, runtime, file);
    await access(runtimeMember(runtime, manifest.vite));
    const native =
      options.nativeLabels.length === 0
        ? new Map<string, string>()
        : await developmentNativeFiles({ ...built, labels: options.nativeLabels, destination });
    await engine.close();
    return {
      manifest,
      runtime,
      native,
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    try {
      await engine.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}

function requiredNative(files: ReadonlyMap<string, string>, label: string): string {
  const file = files.get(label);
  if (file === undefined) throw new Error(`Required development binary is absent: ${label}`);
  return file;
}

async function daemonEnvironment(
  files: ReadonlyMap<string, string>,
  runtime: string,
): Promise<Readonly<Record<string, string>>> {
  const destination = path.join(runtime, 'apps/daemon/dist');
  await mkdir(destination, { recursive: true });
  const tui = path.join(destination, 'merkur-tui');
  await copyFile(requiredNative(files, DEVELOPMENT_NATIVE_PRODUCERS.tui), tui);
  await chmod(tui, 0o555);
  return { MERKUR_DATAPLANE_BIN: requiredNative(files, DEVELOPMENT_NATIVE_PRODUCERS.dataplane) };
}

export function sourceGraphChange(manifest: DevelopmentRuntimeManifest, relative: string): boolean {
  const parent = path.posix.dirname(relative);
  // Only directories containing declared SourceFiles can propose a graph refresh.
  // The next configured Bazel manifest, rather than this event, decides admission.
  return manifest.workspace.some((file) => {
    const directory = path.posix.dirname(file);
    return directory === '.' ? parent === '.' : relative.startsWith(`${directory}/`);
  });
}

export function runtimeGraphIdentity(manifest: DevelopmentRuntimeManifest): string {
  return JSON.stringify({
    files: Object.keys(manifest.files).sort(),
    workspace: manifest.workspace,
    packages: manifest.workspacePackages,
    vite: manifest.vite,
    preload: manifest.preload,
  });
}

async function runDevelopmentRuntime(
  options: {
    root: string;
    directory: string;
    tools: DeclaredEngineTools;
    signal: AbortSignal;
    admittedUntracked: readonly string[];
    nativeLabels: readonly string[];
    modes: readonly string[];
  },
  prepared: PreparedDevelopmentRuntime,
): Promise<{ status: number; next?: PreparedDevelopmentRuntime }> {
  const { manifest, runtime } = prepared;
  let initial = prepared.native;
  const bun = [
    process.execPath,
    '--no-install',
    '--no-env-file',
    `--config=${runtimeMember(runtime, manifest.config)}`,
  ];
  const stack = await runDevelopmentStack({
    root: runtime,
    sourceRoot: options.root,
    arguments: options.modes,
    serverEnvironmentFile: path.join(options.root, 'apps/server/.env'),
    configurationEnvironment: {},
    environment: {
      ...options.tools.sdkEnvironment,
      PATH: path.join(options.tools.sdkEnvironment.MERKUR_BAZEL_NATIVE_SDK_PREFIX ?? '', 'bin'),
      HOME: homedir(),
      TMPDIR: options.directory,
    },
    daemonConfigPath: path.join(homedir(), '.merkur', 'config.json'),
    edgeIdentityDirectory: path.join(options.root, 'target', 'edge-dev-identity'),
    commands: {
      server: [...bun, '--watch', 'src/index.ts'],
      web: (port) => [
        ...bun,
        `--preload=${runtimeMember(runtime, manifest.preload)}`,
        runtimeMember(runtime, manifest.vite),
        '--port',
        port,
      ],
      daemon: [...bun, '--watch', 'src/index.ts', 'daemon'],
    },
    doctor: async () => {
      const environment = await Effect.runPromise(
        loadDevelopmentEnvironment(path.join(options.root, 'apps/server/.env'), {}),
      );
      await Effect.runPromise(probeRedis(environment.config.redisUrl));
    },
    buildEdge: async () => requiredNative(initial, DEVELOPMENT_NATIVE_PRODUCERS.edge),
    buildDaemon: async (signal) => {
      if (initial.has(DEVELOPMENT_NATIVE_PRODUCERS.dataplane)) {
        const result = await daemonEnvironment(initial, runtime);
        initial = new Map();
        return result;
      }
      return daemonEnvironment(
        await nativeBuild({
          ...options,
          signal,
          labels: [
            DEVELOPMENT_NATIVE_PRODUCERS.dataplane,
            DEVELOPMENT_NATIVE_PRODUCERS.imageWorker,
            DEVELOPMENT_NATIVE_PRODUCERS.tui,
          ],
        }),
        runtime,
      );
    },
  });
  let next: PreparedDevelopmentRuntime | undefined;
  let refresh = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const watcher = watch(options.root, { recursive: true }, (_event, filename) => {
    if (filename === null || stopped) return;
    const relative = filename.toString();
    const mapped = manifest.workspace.includes(relative);
    if (!mapped && !sourceGraphChange(manifest, relative)) return;
    if (mapped && path.posix.basename(relative) !== 'package.json') {
      refresh = refresh.then(async () => {
        try {
          await refreshDevelopmentSource(manifest, options.root, runtime, relative);
        } catch {
          await replaceGraph();
        }
      });
    } else {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        refresh = refresh.then(() => replaceGraph(mapped));
      }, 200);
    }
  });
  async function replaceGraph(force = false): Promise<void> {
    if (stopped || next !== undefined) return;
    let candidate: PreparedDevelopmentRuntime | undefined;
    try {
      candidate = await prepareDevelopmentRuntime(options);
      if (!force && runtimeGraphIdentity(candidate.manifest) === runtimeGraphIdentity(manifest)) {
        await candidate.close();
        return;
      }
      options.signal.throwIfAborted();
      if (stopped) {
        await candidate.close();
        return;
      }
      next = candidate;
      await stack.stop(0);
    } catch (error) {
      await candidate?.close();
      process.stderr.write(
        `Development graph rebuild failed; running services retain their previous inputs: ${String(error)}\n`,
      );
    }
  }
  try {
    const status = await stack.done;
    stopped = true;
    return { status, ...(next === undefined ? {} : { next }) };
  } finally {
    stopped = true;
    watcher.close();
    if (timer !== undefined) clearTimeout(timer);
    await refresh;
    await stack.stop(1);
    if (options.signal.aborted) await next?.close();
  }
}

export async function developmentMain(args: readonly string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'bazel run //dev:stack -- [--server-only|--web-only|--with-daemon] [--admit-file ABS_JSON] --credential-file ABS_BAZELRC\n',
    );
    return 0;
  }
  const parsed = devStackArguments(args);
  const workspace = process.env.BUILD_WORKSPACE_DIRECTORY;
  if (workspace === undefined || !path.isAbsolute(workspace))
    throw new Error('Run the declared //dev:stack entrypoint from its workspace');
  const root = await realpath(workspace);
  await access(path.join(root, 'apps/server/.env'));
  const tools = declaredTools(parsed.credentialFile);
  const admittedUntracked = await admittedInputs(parsed.admitFile);
  const directory = await mkdtemp(path.join(tmpdir(), 'merkur-development-'));
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error('Development build interrupted'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const nativeLabels = parsed.modes.includes('--web-only')
    ? []
    : [
        DEVELOPMENT_NATIVE_PRODUCERS.edge,
        ...(parsed.modes.includes('--with-daemon')
          ? [
              DEVELOPMENT_NATIVE_PRODUCERS.dataplane,
              DEVELOPMENT_NATIVE_PRODUCERS.imageWorker,
              DEVELOPMENT_NATIVE_PRODUCERS.tui,
            ]
          : []),
      ];
  const options = {
    root,
    directory,
    tools,
    admittedUntracked,
    signal: cancellation.signal,
    nativeLabels,
    modes: parsed.modes,
  };
  let prepared: PreparedDevelopmentRuntime | undefined;
  try {
    prepared = await prepareDevelopmentRuntime(options);
    while (true) {
      const result = await runDevelopmentRuntime(options, prepared);
      await prepared.close();
      prepared = result.next;
      if (prepared === undefined) return result.status;
      cancellation.signal.throwIfAborted();
    }
  } finally {
    cancellation.abort();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await prepared?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await developmentMain(process.argv.slice(2)));
