import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { readDeclaredInput } from './artifacts';
import type { EngineQueryResult } from './engine-catalog';
import {
  type ExecutorPolicy,
  executorFlags,
  type NativeExecutionPlatform,
  parseExecutorPolicy,
} from './executor-policy';
import {
  manifestFromInventory,
  type SourceInput,
  type SourceManifest,
  validSourceManifest,
} from './snapshot';
import { timed, timedAsync } from './stages';

export interface DeclaredEngineTools {
  readonly bazel: string;
  readonly acquisition: string;
  readonly git: string;
  readonly credentialHelper: string;
  readonly credentialFile: string;
  readonly runfiles: string;
  readonly sdkEnvironment: Readonly<Record<string, string>>;
  /** Darwin only: the directory holding the pinned Apple compiler/SDK export by digest. */
  readonly darwinCompilerStore?: string;
}

export interface EngineCommandResult {
  readonly stdout: string;
  readonly exitCode: number | null;
}

export interface ValidatedEngineIdentity {
  readonly executable: string;
  readonly digest: string;
}

interface EngineOrigin {
  readonly tools: DeclaredEngineTools;
  readonly source: SourceManifest;
}

export interface EngineQueryReceipt {
  readonly executableDigest: string;
  readonly sourceDigest: string;
  readonly verificationContextDigest: string;
  readonly root: string;
  readonly command: 'query' | 'cquery' | 'aquery';
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

const identities = new WeakMap<ValidatedEngineIdentity, EngineOrigin>();
const queries = new WeakMap<EngineQueryResult, EngineQueryReceipt>();
// A heap failure must return to the controller, not deadlock in BEP crash cleanup.
const ENGINE_JVM_FAILURE_EXIT = '--host_jvm_args=-XX:+ExitOnOutOfMemoryError';

// Several days of this checkout's changed inputs: a day of full re-executions added about 4 GB.
const DISK_CACHE_BYTES = '16G';

/** Copies and serialized query objects never inherit a completed engine command's origin. */
export function engineQueryReceipt(query: EngineQueryResult): EngineQueryReceipt {
  const receipt = queries.get(query);
  if (receipt === undefined) throw new Error('Query has no owned completed engine receipt');
  return receipt;
}

function captureTools(tools: DeclaredEngineTools): DeclaredEngineTools {
  return Object.freeze({ ...tools, sdkEnvironment: Object.freeze({ ...tools.sdkEnvironment }) });
}

function unchangedSource(root: string, source: SourceManifest): void {
  if (
    manifestFromInventory(
      root,
      source.inputs.map((input) => input.path),
      source.commit,
    ).digest !== source.digest
  )
    throw new Error('Engine command source differs from its captured origin');
}

function unchangedContext(context: SourceManifest): void {
  if (
    JSON.stringify(readdirSync(context.root).sort()) !==
    JSON.stringify(context.inputs.map((input) => input.path))
  )
    throw new Error('Verification context File inventory changed');
  unchangedSource(context.root, context);
}

/** The acquired context is ordinary Files plus the flat `payload` directory of captured Files. */
function regularContextInput(input: SourceInput): boolean {
  return (
    input.kind === 'file' ||
    (input.path === 'payload' &&
      input.kind === 'directory' &&
      input.children?.every((child) => child.kind === 'file') === true)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Git's relocated OpenSSL trust bundle is an original member of the declared SDK. */
export function declaredGitCaBundle(prefix: string): string {
  if (!path.isAbsolute(prefix) || realpathSync(prefix) !== prefix)
    throw new Error('Declared Git trust requires a physical SDK prefix');
  const bundle = realpathSync(path.join(prefix, 'ssl', 'cert.pem'));
  const relative = path.relative(prefix, bundle);
  if (
    relative === '' ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    !lstatSync(bundle).isFile()
  )
    throw new Error('Declared Git trust bundle must be an ordinary SDK member');
  return bundle;
}

/** Resolve Bazel's per-File runfiles view through its exact declared native Git member. */
export function declaredGitSdkEnvironment(
  prefix: string,
  git: string,
): Readonly<Record<string, string>> {
  if (!path.isAbsolute(prefix) || !path.isAbsolute(git))
    throw new Error('Declared Git SDK requires absolute input carriers');
  const binary = realpathSync(git);
  if (
    realpathSync(path.join(prefix, 'bin', 'git')) !== binary ||
    path.basename(binary) !== 'git' ||
    path.basename(path.dirname(binary)) !== 'bin' ||
    !lstatSync(binary).isFile()
  )
    throw new Error('Declared Git executable differs from its exact SDK member');
  const physical = path.dirname(path.dirname(binary));
  declaredGitCaBundle(physical);
  return Object.freeze({
    MERKUR_BAZEL_NATIVE_SDK_PREFIX: physical,
    DYLD_FALLBACK_LIBRARY_PATH: path.join(physical, 'lib'),
    GIT_EXEC_PATH: path.join(physical, 'libexec', 'git-core'),
    GIT_TEMPLATE_DIR: path.join(physical, 'share', 'git-core', 'templates'),
    OPENSSL_CONF: path.join(physical, 'ssl', 'openssl.cnf'),
    OPENSSL_MODULES: path.join(physical, 'lib', 'ossl-modules'),
  });
}

/** An exact native SDK payload, never a launcher discovered through PATH or a user cache. */
export async function validateEngineTools(
  tools: DeclaredEngineTools,
  source: SourceManifest,
): Promise<ValidatedEngineIdentity> {
  tools = captureTools(tools);
  if (
    ![
      tools.bazel,
      tools.acquisition,
      tools.git,
      tools.runfiles,
      tools.credentialHelper,
      tools.credentialFile,
    ].every(path.isAbsolute)
  )
    throw new Error('Absolute declared engine, acquisition, Git and runfiles paths required');
  if (!validSourceManifest(source)) throw new Error('Captured engine source manifest required');
  source = structuredClone(source);
  unchangedSource(source.root, source);
  const pinsInput = source.inputs.find((input) => input.path === '.github/bazel/engine-pins.json');
  const pinsFile = await readDeclaredInput(source.root, '.github/bazel/engine-pins.json');
  if (pinsInput?.kind !== 'file' || pinsFile.artifact.digest !== pinsInput.digest)
    throw new Error('Engine pins differ from the captured source File');
  const pins: unknown = JSON.parse(pinsFile.bytes.toString());
  const platform = `${process.platform}-${process.arch === 'x64' ? 'x86_64' : process.arch}`;
  if (!['darwin-arm64', 'darwin-x86_64', 'linux-arm64', 'linux-x86_64'].includes(platform))
    throw new Error('Verification requires one of the four native platforms');
  const metadataPath = realpathSync(tools.acquisition);
  const metadata = await readDeclaredInput(path.dirname(metadataPath), path.basename(metadataPath));
  const acquisition: unknown = JSON.parse(metadata.bytes.toString());
  if (
    !record(pins) ||
    pins.version !== '9.2.0' ||
    !record(pins.binaries) ||
    !record(acquisition) ||
    Object.keys(acquisition).sort().join(',') !== 'pins,platform,sha256,url,version' ||
    acquisition.version !== '9.2.0' ||
    acquisition.platform !== platform ||
    acquisition.pins !== '//:.github/bazel/engine-pins.json' ||
    acquisition.url !==
      `https://github.com/bazelbuild/bazel/releases/download/9.2.0/bazel-9.2.0-${platform}` ||
    acquisition.sha256 !== pins.binaries[platform] ||
    typeof acquisition.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(acquisition.sha256)
  )
    throw new Error('Declared Bazel acquisition differs from captured engine pins');
  const executable = realpathSync(tools.bazel);
  const payload = await readDeclaredInput(path.dirname(executable), path.basename(executable));
  if (payload.artifact.digest !== acquisition.sha256)
    throw new Error('Declared Bazel executable differs from its acquisition');
  unchangedSource(source.root, source);
  const identity = Object.freeze({ executable, digest: payload.artifact.digest });
  identities.set(identity, { tools, source });
  return identity;
}

/** Serial planning and one merged execution; all execution scheduling belongs to Bazel. */
export class DeclaredEngineProcess {
  #sequence = 0;
  readonly #serverRoots = new Set<string>();
  readonly #active = new Set<Promise<EngineCommandResult>>();
  #closing: Promise<void> | undefined;
  readonly #signal: AbortSignal;
  readonly #checkCancellation: () => void;
  #identity: ValidatedEngineIdentity | undefined;
  #origin: EngineOrigin | undefined;
  #context: SourceManifest | undefined;
  #revocations: SourceManifest | undefined;
  #audit: SourceManifest | undefined;
  #executionFlags: readonly string[] | undefined;
  #repositoryCache: string | undefined;
  #diskCache: string | undefined;
  #executableRoot: string | undefined;
  readonly #persistent: boolean;
  readonly #engineRoot: string;
  /** Where this engine's output bases live. */
  get engineRoot(): string {
    return this.#engineRoot;
  }
  readonly environment: Readonly<Record<string, string>>;
  readonly tools: DeclaredEngineTools;
  readonly directory: string;

  /**
   * `home`, when given, is where the engine lives between runs: its output base, and the
   * HOME and TMPDIR its server keeps. Without one the engine is private to `directory` and
   * shut down with it.
   */
  constructor(tools: DeclaredEngineTools, directory: string, signal: AbortSignal, home?: string) {
    this.#signal = signal;
    this.#checkCancellation = AbortSignal.prototype.throwIfAborted.bind(signal);
    this.#checkCancellation();
    tools = captureTools(tools);
    this.tools = tools;
    this.directory = directory;
    const prefix = tools.sdkEnvironment.MERKUR_BAZEL_NATIVE_SDK_PREFIX;
    const permitted = new Set([
      'DYLD_LIBRARY_PATH',
      'DYLD_FALLBACK_LIBRARY_PATH',
      'GIT_EXEC_PATH',
      'GIT_TEMPLATE_DIR',
      'OPENSSL_CONF',
      'OPENSSL_MODULES',
      'MERKUR_BAZEL_NATIVE_SDK_PREFIX',
    ]);
    if (
      !path.isAbsolute(directory) ||
      (home !== undefined && !path.isAbsolute(home)) ||
      ![
        tools.bazel,
        tools.acquisition,
        tools.git,
        tools.runfiles,
        tools.credentialHelper,
        tools.credentialFile,
      ].every(path.isAbsolute) ||
      prefix === undefined ||
      !path.isAbsolute(prefix) ||
      (tools.darwinCompilerStore !== undefined && !path.isAbsolute(tools.darwinCompilerStore)) ||
      Object.keys(tools.sdkEnvironment).some((key) => !permitted.has(key))
    )
      throw new Error('Private execution directory and typed native SDK environment required');
    const caBundle = declaredGitCaBundle(prefix);
    const state = home ?? directory;
    this.#persistent = home !== undefined;
    this.#engineRoot = path.join(state, 'engine');
    mkdirSync(path.join(state, 'home'), { recursive: home !== undefined, mode: 0o700 });
    mkdirSync(path.join(state, 'tmp'), { recursive: home !== undefined, mode: 0o700 });
    mkdirSync(path.join(directory, 'commands'), { mode: 0o700 });
    this.environment = Object.freeze({
      ...tools.sdkEnvironment,
      HOME: path.join(state, 'home'),
      TMPDIR: path.join(state, 'tmp'),
      PATH: path.join(prefix, 'bin'),
      USER: 'verification',
      LOGNAME: 'verification',
      LC_ALL: 'C',
      RUNFILES_DIR: tools.runfiles,
      TEST_SRCDIR: tools.runfiles,
      MERKUR_BUILDBUDDY_AUTH_FILE: tools.credentialFile,
      ...(tools.darwinCompilerStore === undefined
        ? {}
        : { MERKUR_DARWIN_COMPILER_STORE: tools.darwinCompilerStore }),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSL_CAINFO: caBundle,
      GIT_SSL_CAPATH: '',
      GIT_OPTIONAL_LOCKS: '0',
    });
    Object.defineProperties(this, {
      tools: { writable: false, configurable: false },
      directory: { writable: false, configurable: false },
      environment: { writable: false, configurable: false },
    });
  }

  bind(identity: ValidatedEngineIdentity, contextDirectory: string): void {
    const origin = identities.get(identity);
    if (
      this.#identity !== undefined ||
      origin === undefined ||
      JSON.stringify(origin.tools) !== JSON.stringify(this.tools)
    )
      throw new Error('Engine identity must be validated and bound exactly once');
    const root = realpathSync(contextDirectory);
    const context = manifestFromInventory(root, readdirSync(root).sort(), origin.source.commit);
    const source: unknown = JSON.parse(
      readFileSync(path.join(root, 'source-manifest.json'), 'utf8'),
    );
    if (
      !context.inputs.every(regularContextInput) ||
      !validSourceManifest(source) ||
      source.digest !== origin.source.digest
    )
      throw new Error('Verification context must contain the exact captured source manifest');
    unchangedContext(context);
    this.#identity = identity;
    this.#origin = origin;
    this.#context = context;
  }

  bindExecutionPolicy(policy: ExecutorPolicy, platform: NativeExecutionPlatform): void {
    if (this.#executionFlags !== undefined || this.#sequence !== 0)
      throw new Error('Execution policy must be bound once before engine commands');
    this.#executionFlags = Object.freeze([...executorFlags(parseExecutorPolicy(policy), platform)]);
  }

  /** Each run starts a private server; digest-checked downloads still persist across runs. */
  bindRepositoryCache(directory: string): void {
    if (this.#repositoryCache !== undefined || this.#sequence !== 0 || !path.isAbsolute(directory))
      throw new Error('Repository cache must be bound once before engine commands');
    this.#repositoryCache = directory;
  }

  /**
   * Each run's private server starts with an empty output base. Action results, test passes
   * among them, persist here by content digest, so a later run with the same inputs and the
   * same test epoch reads them instead of executing again.
   */
  bindDiskCache(directory: string): void {
    if (this.#diskCache !== undefined || this.#sequence !== 0 || !path.isAbsolute(directory))
      throw new Error('Disk cache must be bound once before engine commands');
    this.#diskCache = directory;
  }

  /**
   * The cache and its bound. Every changed input adds entries and nothing else removes them, so
   * the engine's own collector keeps the least recently used ones within the bound, once its
   * server has been idle; a server that ends with its run never collects.
   */
  diskCacheFlags(): readonly string[] {
    return this.#diskCache === undefined
      ? ['--disk_cache=']
      : [
          `--disk_cache=${this.#diskCache}`,
          `--experimental_disk_cache_gc_max_size=${DISK_CACHE_BYTES}`,
        ];
  }

  /**
   * Tests store their stand-in executables by content digest under this root. It outlives
   * the test and the run, so macOS assesses each distinct stub once; a test's own scratch
   * would make every stub a new file, assessed one at a time system-wide.
   */
  bindExecutableRoot(directory: string): void {
    if (this.#executableRoot !== undefined || this.#sequence !== 0 || !path.isAbsolute(directory))
      throw new Error('Executable root must be bound once before engine commands');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#executableRoot = directory;
  }

  executableRootFlags(): readonly string[] {
    return this.#executableRoot === undefined
      ? []
      : [
          `--sandbox_writable_path=${this.#executableRoot}`,
          `--test_env=MERKUR_BAZEL_EXECUTABLE_ROOT=${this.#executableRoot}`,
        ];
  }

  /** The lockfile is captured source: a command that would rewrite it fails instead. */
  #repositoryFlags(): readonly string[] {
    return [
      '--lockfile_mode=error',
      ...(this.#repositoryCache === undefined
        ? []
        : [`--repository_cache=${this.#repositoryCache}`]),
    ];
  }

  bindRevocations(source: SourceManifest): void {
    if (!validSourceManifest(source) || source.inputs.some((input) => input.kind !== 'file'))
      throw new Error('Nonce repository requires an exact regular File manifest');
    unchangedSource(source.root, source);
    this.#revocations = structuredClone(source);
  }

  bindAudit(source: SourceManifest | undefined): void {
    if (source !== undefined) {
      if (!validSourceManifest(source) || source.inputs.some((input) => input.kind !== 'file'))
        throw new Error('Audit repository requires an exact regular File manifest');
      unchangedContext(source);
    }
    this.#audit = source === undefined ? undefined : structuredClone(source);
  }

  /** Hosted transport uses the declared helper; credentials never become flags or action inputs. */
  backendFlags(): readonly string[] {
    return [...this.#cacheFlags(), ...this.#eventFlags()];
  }

  /**
   * A query's answer is its output, which the controller keeps. An event stream would carry
   * that whole output to the service a second time, so a query has the cache and no stream.
   */
  queryBackendFlags(): readonly string[] {
    return this.#cacheFlags();
  }

  #cacheFlags(): readonly string[] {
    return [
      '--remote_cache=grpcs://remote.buildbuddy.io',
      // The shared service holds what authoritative runs produced. A run that keeps its engine
      // reads the shared cache and writes only this host's disk cache.
      ...(this.#persistent ? ['--noremote_upload_local_results'] : []),
      `--credential_helper=remote.buildbuddy.io=${this.tools.credentialHelper}`,
      '--build_event_json_file_path_conversion=false',
    ];
  }

  /** The hosted event stream of an authoritative run; a kept engine publishes nothing. */
  #eventFlags(): readonly string[] {
    return this.#persistent
      ? []
      : [
          '--bes_backend=grpcs://remote.buildbuddy.io',
          '--bes_results_url=https://app.buildbuddy.io/invocation/',
        ];
  }

  git(root: string, args: readonly string[], input?: Uint8Array): Buffer {
    const result = Bun.spawnSync(
      [this.tools.git, '-c', 'core.fsmonitor=false', '-c', 'core.excludesFile=/dev/null', ...args],
      {
        cwd: root,
        env: this.environment,
        stdin: input === undefined ? 'ignore' : input,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    if (result.exitCode !== 0 || result.signalCode)
      throw new Error(`Declared Git failed: ${result.stderr.toString()}`);
    return result.stdout;
  }

  async run(root: string, command: string, args: readonly string[]): Promise<EngineCommandResult> {
    return this.#run(root, command, args);
  }

  /** Shutdown owns the exact private roots used by this process, including frozen snapshots. */
  close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  async #shutdown(): Promise<void> {
    await Promise.allSettled([...this.#active]);
    const identity = this.#identity;
    // An engine with a home outlives the run: its server stays up for the next one.
    if (this.#serverRoots.size === 0 || this.#persistent) return;
    if (identity === undefined)
      throw new Error('Private engine shutdown lost its declared identity');
    const payload = await readDeclaredInput(
      path.dirname(identity.executable),
      path.basename(identity.executable),
    );
    if (payload.artifact.digest !== identity.digest)
      throw new Error('Declared engine changed before private server shutdown');
    // Cancellation and source changes must not prevent retirement of an already started server.
    const results = await Promise.allSettled(
      [...this.#serverRoots].map(async (root) => {
        const prefix = path.join(this.directory, 'commands', String(++this.#sequence));
        const argv = [
          identity.executable,
          '--ignore_all_rc_files',
          `--output_user_root=${this.#engineRoot}`,
          ENGINE_JVM_FAILURE_EXIT,
          'shutdown',
        ];
        const { exitCode, signalCode } = await this.#command(root, argv, prefix, {
          argv,
          root,
          command: 'shutdown',
        });
        if (exitCode !== 0 || signalCode)
          throw new Error(
            `Private engine shutdown failed for ${root}; see private command evidence`,
          );
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length !== 0)
      throw new AggregateError(failures, 'Private engine server shutdown failed');
  }

  async #command(
    root: string,
    argv: readonly string[],
    prefix: string,
    receipt: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ) {
    const child = Bun.spawn([...argv], {
      ...(signal === undefined ? {} : { signal, killSignal: 'SIGINT' as const }),
      cwd: root,
      env: this.environment,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const result = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const [stdout, stderr, exitCode] = result;
    const signalCode = child.signalCode;
    writeFileSync(`${prefix}.stdout`, stdout, { flag: 'wx', mode: 0o600 });
    writeFileSync(`${prefix}.stderr`, stderr, { flag: 'wx', mode: 0o600 });
    writeFileSync(
      `${prefix}.json`,
      `${JSON.stringify({
        ...receipt,
        exitCode,
        signal: signalCode,
        ...(signal === undefined ? {} : { cancelled: signal.aborted }),
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    return { stdout, exitCode, signalCode };
  }

  #run(root: string, command: string, args: readonly string[]): Promise<EngineCommandResult> {
    if (this.#closing !== undefined)
      return Promise.reject(new Error('Declared engine is closing or closed'));
    const operation = this.#invoke(root, command, args);
    this.#active.add(operation);
    void operation.then(
      () => this.#active.delete(operation),
      () => this.#active.delete(operation),
    );
    return operation;
  }

  #checkExecutionPolicy(command: string, args: readonly string[]): void {
    const scheduling = args.filter((arg) =>
      ['--extra_execution_platforms', '--remote_default_exec_properties'].some(
        (name) => arg === name || arg.startsWith(`${name}=`),
      ),
    );
    const expectedScheduling =
      this.#executionFlags?.filter((flag) => !flag.startsWith('--remote_executor=')) ?? [];
    const executor = args.filter(
      (arg) => arg === '--remote_executor' || arg.startsWith('--remote_executor='),
    );
    if (
      ((scheduling.length !== 0 ||
        (this.#executionFlags !== undefined &&
          ['test', 'build', 'cquery', 'aquery', 'info'].includes(command))) &&
        JSON.stringify([...scheduling].sort()) !==
          JSON.stringify([...expectedScheduling].sort())) ||
      executor.length > 1 ||
      (executor.length === 1 &&
        executor[0] !== '--remote_executor=' &&
        (this.#executionFlags === undefined ||
          executor[0] !==
            this.#executionFlags.find((flag) => flag.startsWith('--remote_executor='))))
    )
      throw new Error('Remote execution requires the exact bound deployment policy');
  }

  #checkAuditOverride(
    command: string,
    args: readonly string[],
    audit: SourceManifest | undefined,
  ): void {
    if (['test', 'build', 'run', 'cquery', 'aquery', 'query', 'info'].includes(command)) {
      const auditFlags = args.filter((arg) =>
        arg.startsWith('--override_repository=verification_audit='),
      );
      if (
        args.includes('--override_repository') ||
        (audit === undefined
          ? auditFlags.length !== 0
          : auditFlags.length !== 1 ||
            auditFlags[0] !== `--override_repository=verification_audit=${audit.root}`)
      )
        throw new Error('Engine command differs from its bound fresh audit repository');
    }
  }

  #unchangedCommandState(
    root: string,
    origin: EngineOrigin,
    context: SourceManifest,
    revocations: SourceManifest | undefined,
    audit: SourceManifest | undefined,
  ): void {
    this.#checkCancellation();
    timed('engine command state', () => {
      unchangedSource(root, origin.source);
      unchangedContext(context);
      if (this.#revocations !== revocations)
        throw new Error('Test nonce binding changed during an engine command');
      if (revocations !== undefined) unchangedSource(revocations.root, revocations);
      if (this.#audit !== audit) throw new Error('Audit binding changed during an engine command');
      if (audit !== undefined) unchangedContext(audit);
    });
  }

  async #invoke(
    root: string,
    command: string,
    args: readonly string[],
  ): Promise<EngineCommandResult> {
    const signal = this.#signal;
    this.#checkCancellation();
    args = Object.freeze([...args]);
    this.#checkExecutionPolicy(command, args);
    const identity = this.#identity;
    const origin = this.#origin;
    const context = this.#context;
    const revocations = this.#revocations;
    const audit = this.#audit;
    this.#checkAuditOverride(command, args, audit);
    if (identity === undefined || origin === undefined || context === undefined)
      throw new Error('Execution requires a validated declared engine identity');
    const payload = await readDeclaredInput(
      path.dirname(identity.executable),
      path.basename(identity.executable),
    );
    if (payload.artifact.digest !== identity.digest)
      throw new Error('Declared engine changed after validation');
    // Every captured byte is read once here, with nothing awaited before the engine starts,
    // and once more the moment it has exited: the two readings bracket exactly the command.
    this.#unchangedCommandState(root, origin, context, revocations, audit);
    const number = ++this.#sequence;
    const prefix = path.join(this.directory, 'commands', String(number));
    if (command === '--version' && args.length !== 0)
      throw new Error('Standalone engine version accepts no command arguments');
    const argv = Object.freeze(
      command === '--version'
        ? [identity.executable, '--version']
        : [
            identity.executable,
            '--ignore_all_rc_files',
            `--output_user_root=${this.#engineRoot}`,
            ENGINE_JVM_FAILURE_EXIT,
            command,
            ...this.#repositoryFlags(),
            ...args,
          ],
    );
    this.#checkCancellation();
    if (this.#closing !== undefined) throw new Error('Declared engine is closing or closed');
    if (command !== '--version') this.#serverRoots.add(root);
    const { stdout, exitCode, signalCode } = await timedAsync(`engine ${command}`, () =>
      this.#command(root, argv, prefix, { argv, command, args }, signal),
    );
    this.#unchangedCommandState(root, origin, context, revocations, audit);
    const completedPayload = await readDeclaredInput(
      path.dirname(identity.executable),
      path.basename(identity.executable),
    );
    if (completedPayload.artifact.digest !== identity.digest)
      throw new Error('Declared engine changed during execution');
    return Object.freeze({ stdout, exitCode: signalCode ? null : exitCode });
  }

  async query(
    root: string,
    command: 'query' | 'cquery' | 'aquery',
    expression: string,
    format: EngineQueryResult['format'],
    flags: readonly string[],
  ): Promise<EngineQueryResult> {
    flags = Object.freeze([...flags]);
    if (flags.some((flag) => typeof flag !== 'string'))
      throw new Error('Engine query flags must contain only strings');
    const fixed = new Set([
      '--enable_bzlmod',
      ...['macos_arm64', 'macos_x64', 'linux_arm64', 'linux_x64'].map(
        (platform) => `--platforms=//tools/bazel/platforms:${platform}`,
      ),
      '--experimental_sandbox_async_tree_delete_idle_threads=0',
      '--incompatible_strict_action_env',
      '--remote_verify_downloads',
      '--guard_against_concurrent_changes',
      '--remote_download_outputs=all',
      '--symlink_prefix=/',
      ...this.#cacheFlags(),
      ...(this.#executionFlags?.filter((flag) => !flag.startsWith('--remote_executor=')) ?? []),
      '--remote_executor=',
      ...this.diskCacheFlags(),
      ...this.executableRootFlags(),
      '--keep_going',
      '--cache_test_results=auto',
      '--test_output=errors',
    ]);
    const revocationFlags = flags.filter((flag) =>
      flag.startsWith('--override_repository=verification_revocations='),
    );
    const revocations = this.#revocations;
    const audit = this.#audit;
    const auditFlags = flags.filter((flag) =>
      flag.startsWith('--override_repository=verification_audit='),
    );
    const contextFlags = flags.filter((flag) =>
      flag.startsWith('--override_repository=verification_context='),
    );
    if (
      !['query', 'cquery', 'aquery'].includes(command) ||
      format !== (command === 'query' ? 'streamed_jsonproto' : 'jsonproto') ||
      (command !== 'query' && !flags.includes('--remote_executor=')) ||
      (command !== 'query' &&
        this.#executionFlags !== undefined &&
        this.#executionFlags
          .filter((flag) => !flag.startsWith('--remote_executor='))
          .some((flag) => !flags.includes(flag))) ||
      expression === '' ||
      expression.startsWith('-') ||
      expression.includes('\0') ||
      new Set(flags).size !== flags.length ||
      contextFlags.length > 1 ||
      revocationFlags.length > 1 ||
      auditFlags.length > 1 ||
      flags.some(
        (flag) =>
          !(command === 'query' ? flag === '--enable_bzlmod' : fixed.has(flag)) &&
          !(
            revocations !== undefined &&
            flag === `--override_repository=verification_revocations=${revocations.root}`
          ) &&
          !(
            audit !== undefined && flag === `--override_repository=verification_audit=${audit.root}`
          ) &&
          !(
            flag.startsWith('--override_repository=verification_context=') &&
            path.isAbsolute(flag.slice('--override_repository=verification_context='.length)) &&
            !flag.includes('\n') &&
            !flag.includes('\0')
          ),
      )
    )
      throw new Error('Engine query requires explicit controlled flags');
    const context = this.#context;
    if (
      context !== undefined &&
      contextFlags[0] !== `--override_repository=verification_context=${context.root}`
    )
      throw new Error('Engine query differs from its bound verification context');
    if (
      revocations !== undefined &&
      revocationFlags[0] !== `--override_repository=verification_revocations=${revocations.root}`
    )
      throw new Error('Engine query differs from its bound test nonce repository');
    if (
      audit !== undefined &&
      auditFlags[0] !== `--override_repository=verification_audit=${audit.root}`
    )
      throw new Error('Engine query differs from its bound fresh audit repository');
    const args = Object.freeze([
      expression,
      `--output=${format}`,
      ...flags,
      ...(command === 'query' ? [] : ['--workspace_status_command=']),
    ]);
    // A public run override cannot supply the private spawn/wait completion receipt.
    const result = await this.#run(root, command, args);
    this.#checkCancellation();
    if (result.exitCode !== 0)
      throw new Error(`Pinned ${command} failed; see private command evidence`);
    const query = Object.freeze({
      expression,
      format,
      buildToolVersion: '9.2.0',
      exitCode: result.exitCode,
      stdout: result.stdout,
    });
    const identity = this.#identity;
    const origin = this.#origin;
    if (identity === undefined || origin === undefined || context === undefined)
      throw new Error('Engine origin was lost');
    queries.set(
      query,
      Object.freeze({
        executableDigest: identity.digest,
        sourceDigest: origin.source.digest,
        verificationContextDigest: context.digest,
        root: realpathSync(root),
        command,
        argv: Object.freeze([
          identity.executable,
          '--ignore_all_rc_files',
          `--output_user_root=${this.#engineRoot}`,
          command,
          ...this.#repositoryFlags(),
          ...args,
        ]),
        environment: this.environment,
      }),
    );
    return query;
  }
}
