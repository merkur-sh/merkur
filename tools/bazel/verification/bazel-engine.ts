import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { OwnedDirectory } from '../bun/owned-files';
import type { PreparedCiArtifactInputs } from '../packaging/ci-preparation';
import {
  type ConfiguredArtifactProducers,
  captureConfiguredArtifactProducers,
  configuredUnsignedSelection,
  loadConfiguredCiArtifactInputs,
  UNSIGNED_CONTRACT_OUTPUT_GROUP,
} from '../packaging/configured-artifacts';
import { declaredSourcePaths, testNonceInputPaths } from './action-inputs';
import { readDeclaredInput } from './artifacts';
import { coverageObligations } from './configured-catalog';
import { CONFIGURED_POLICY_PRODUCERS, loadConfiguredPolicyInputs } from './configured-inputs';
import {
  checkSetExpression,
  configuredCheckExpression,
  configuredCheckKinds,
} from './configured-kinds';
import type { ControllerEngine, RecordedPass, TestEpochs } from './controller';
import { type CoverageCatalog, type CoveragePlan, coveragePlan, unitCoverage } from './coverage';
import {
  type EngineQueryResult,
  SOURCE_TEST_QUERY,
  type SourceInventory,
  sourceInventory,
} from './engine-catalog';
import {
  DeclaredEngineProcess,
  type DeclaredEngineTools,
  engineQueryReceipt,
  validateEngineTools,
} from './engine-process';
import { type RequiredCheck, readBuildEvents } from './events';
import {
  type ExecutorPolicy,
  type ExecutorPool,
  executorFlags,
  NATIVE_EXECUTION_PLATFORMS,
  type NativeExecutionPlatform,
  parseExecutorPolicy,
} from './executor-policy';
import type { EnginePlan, FrontEndEngine } from './front-end';
import { captureGitContext, type GitContext } from './git-context';
import { acquireGitInputs, capturedSource } from './git-inputs';
import { loadingFacts } from './loading-inputs';
import { PlanCache } from './plan-cache';
import { pendingQualifications, QUALIFICATION_GROUPS } from './qualifications';
import type { TestReservation } from './revocation';
import {
  GitRevocationStore,
  ledgerCredentialHelperCommand,
  ledgerGitEnvironment,
  ledgerGitTransportArguments,
  ledgerProvisioningConfiguration,
} from './revocation-git';
import { nonceRepositoryFiles, publishNonceRepository } from './revocation-inputs';
import { retainSimulationOutputs } from './simulation-outputs';
import { manifestFromInventory, type SourceManifest } from './snapshot';
import { materializeStagedSnapshot } from './staged-snapshot';
import { timed } from './stages';
import {
  assuranceWorkflowSelection,
  extendedWorkflowSelection,
  extendedWorkflowsSelection,
} from './workflow-selection';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Structural validation only: the adapter binds this to its owned completed aquery. */
export function configuredExecutionPlacement(
  text: string,
  testLabels: readonly string[],
  executionPlatform: string,
): readonly string[] {
  const graph: unknown = JSON.parse(text);
  if (!record(graph) || !Array.isArray(graph.targets) || !Array.isArray(graph.actions))
    throw new Error('Configured execution placement requires a complete action graph');
  const targets = new Map<number, string>();
  for (const target of graph.targets) {
    if (
      !record(target) ||
      !Number.isSafeInteger(target.id) ||
      typeof target.id !== 'number' ||
      typeof target.label !== 'string' ||
      targets.has(target.id)
    )
      throw new Error('Configured execution placement contains an invalid target table');
    targets.set(target.id, target.label);
  }
  const selected = new Set(testLabels);
  const seen = new Set<string>();
  const remote = new Set<string>();
  for (const action of graph.actions) {
    if (!record(action))
      throw new Error('Configured execution placement contains an invalid action');
    if (action.mnemonic !== 'TestRunner') continue;
    const label = typeof action.targetId === 'number' ? targets.get(action.targetId) : undefined;
    if (label === undefined) throw new Error('Configured test has no target identity');
    if (!selected.has(label)) continue;
    seen.add(label);
    const requirements = action.executionInfo ?? [];
    if (!Array.isArray(requirements) || !requirements.every(record))
      throw new Error('Configured test has invalid execution requirements');
    const names = requirements.map((item) => item.key);
    if (names.some((name) => typeof name !== 'string') || new Set(names).size !== names.length)
      throw new Error('Configured test has invalid execution requirements');
    if (names.some((name) => ['no-remote', 'no-remote-exec', 'local'].includes(String(name))))
      continue;
    if (
      typeof action.executionPlatform !== 'string' ||
      action.executionPlatform.replace(/^@@(?=\/\/)/, '') !== executionPlatform
    )
      throw new Error(`Configured test selected another execution platform: ${label}`);
    remote.add(label);
  }
  if (testLabels.some((label) => !seen.has(label)))
    throw new Error('Configured execution placement omits a selected test');
  return Object.freeze([...remote].sort());
}

/** Bazel 9.2 JSON execution logs are a stream of protobuf JSON objects, not JSON Lines. */
export function executionLogRecords(text: string): readonly Record<string, unknown>[] {
  return [...parseExecutionLogChunks([text])];
}

function* parseExecutionLogChunks(chunks: Iterable<string>): Generator<Record<string, unknown>> {
  const pieces: string[] = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const text of chunks) {
    let start = depth === 0 ? -1 : 0;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (start === -1) {
        if (character?.trim() === '') continue;
        if (character !== '{')
          throw new Error('Execution log requires complete protobuf JSON objects');
        start = index;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}') {
        depth--;
        if (depth === 0) {
          pieces.push(text.slice(start, index + 1));
          const value: unknown = JSON.parse(pieces.join(''));
          if (!record(value)) throw new Error('Invalid execution log object');
          pieces.length = 0;
          start = -1;
          yield value;
        }
      }
    }
    if (start !== -1) pieces.push(text.slice(start));
  }
  if (pieces.length !== 0 || quoted || depth !== 0) throw new Error('Execution log is truncated');
}

/** Keep one spawn in memory; the original complete log remains in command evidence. */
export function* executionLogFileRecords(file: string): Generator<Record<string, unknown>> {
  function* chunks(): Generator<string> {
    const descriptor = openSync(file, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      while (true) {
        const length = readSync(descriptor, buffer);
        if (length === 0) break;
        yield decoder.decode(buffer.subarray(0, length), { stream: true });
      }
      yield decoder.decode();
    } finally {
      closeSync(descriptor);
    }
  }
  yield* parseExecutionLogChunks(chunks());
}

/** Observed runner/properties prove placement only, never physical worker/OS/SDK authority. */
export function validateExecutionPlacement(
  records: Iterable<Record<string, unknown>>,
  testLabels: readonly string[],
  pool: ExecutorPool,
): void {
  const expected = new Map([
    ['OSFamily', pool.platform.startsWith('linux-') ? 'linux' : 'darwin'],
    ['Arch', pool.platform.endsWith('arm64') ? 'arm64' : 'amd64'],
    ['Pool', pool.pool],
    ['use-self-hosted-executors', pool.provider === 'registered' ? 'true' : 'false'],
  ]);
  if (pool.containerImage !== null) expected.set('container-image', pool.containerImage);
  const selected = new Set(testLabels);
  const seen = new Set<string>();
  for (const spawn of records) {
    if (spawn.mnemonic !== 'TestRunner' || !selected.has(String(spawn.targetLabel))) continue;
    const label = String(spawn.targetLabel);
    if (
      spawn.runner !== 'remote' ||
      spawn.cacheHit !== false ||
      spawn.remotable !== true ||
      spawn.status !== '' ||
      spawn.exitCode !== 0 ||
      !record(spawn.platform) ||
      !Array.isArray(spawn.platform.properties)
    )
      throw new Error(`Native execution placement lacks a successful fresh remote test: ${label}`);
    const properties = new Map<string, string>();
    for (const property of spawn.platform.properties) {
      if (
        !record(property) ||
        typeof property.name !== 'string' ||
        typeof property.value !== 'string' ||
        properties.has(property.name)
      )
        throw new Error('Observed execution platform properties are invalid');
      properties.set(property.name, property.value);
    }
    if ([...expected].some(([name, value]) => properties.get(name) !== value))
      throw new Error(`Native test ran with another executor placement: ${label}`);
    seen.add(label);
  }
  if (testLabels.length === 0 || testLabels.some((label) => !seen.has(label)))
    throw new Error('Native qualification execution log omits selected remote tests');
}

function fullCoverage(changed: readonly string[], catalog: CoverageCatalog): CoveragePlan {
  const plan = coveragePlan(changed, catalog, true);
  const obligations = coverageObligations();
  for (const name of obligations.operations)
    if (!catalog.operations.has(name))
      throw new Error(`Full coverage has an unimplemented required operation: ${name}`);
  for (const name of obligations.crates)
    if (!catalog.crates.has(name))
      throw new Error(`Full coverage has an unimplemented required crate: ${name}`);
  const checks = [
    ...plan.required,
    ...catalog.tests.map((test) => test.check),
    ...[...catalog.operations.values()].flat(),
    ...[...catalog.crates.values()].flat(),
  ];
  const required = new Map(plan.required.map((check) => [check.label, check]));
  for (const check of checks) {
    const previous = required.get(check.label);
    if (previous !== undefined && previous.kind !== check.kind)
      throw new Error('Conflicting full coverage target kinds');
    required.set(check.label, { ...check, fresh: check.fresh || previous?.fresh === true });
  }
  return {
    ...plan,
    required: [...required.values()].sort((a, b) => a.label.localeCompare(b.label)),
    reasons: [...plan.reasons, 'Complete source, configured policy and crate inventory required'],
  };
}

const DEPENDENCY_AUDIT = '//tools/bazel/verification:dependency_audit';

/**
 * What the engine answers about a configured graph. A test epoch enters only the context
 * digest, which is bound from these parts each time a plan is handed out.
 */
interface ConfiguredPlan {
  readonly coverage: CoveragePlan;
  readonly actionSources: readonly string[];
  readonly analysisSources: readonly string[];
  readonly pendingQualifications: readonly string[];
  readonly context: {
    readonly inventory: string;
    readonly policy: string;
    readonly qualification: string;
  };
  readonly configurations: readonly (readonly [string, string])[];
  readonly simulations: readonly {
    label: string;
    configuration: string;
    mode: 'replay' | 'sweep';
  }[];
}

interface SourceFacts {
  readonly actions: EngineQueryResult;
  readonly inventory: SourceInventory;
  readonly configured: Awaited<ReturnType<typeof loadConfiguredPolicyInputs>>;
}

function requiredChecks(value: unknown): readonly RequiredCheck[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (check) =>
        record(check) &&
        typeof check.label === 'string' &&
        (check.kind === 'test' || check.kind === 'build') &&
        typeof check.fresh === 'boolean',
    )
  )
    return undefined;
  return value as readonly RequiredCheck[];
}

/** The slot holds what this engine wrote; anything of another shape is a miss. */
function cachedPlan(value: unknown): ConfiguredPlan | undefined {
  if (
    !record(value) ||
    !record(value.coverage) ||
    !Array.isArray(value.coverage.required) ||
    !Array.isArray(value.actionSources) ||
    !Array.isArray(value.analysisSources) ||
    !Array.isArray(value.pendingQualifications) ||
    !record(value.context) ||
    typeof value.context.inventory !== 'string' ||
    typeof value.context.policy !== 'string' ||
    typeof value.context.qualification !== 'string' ||
    !Array.isArray(value.configurations) ||
    !Array.isArray(value.simulations)
  )
    return undefined;
  return value as unknown as ConfiguredPlan;
}

function recordedPass(value: unknown): RecordedPass | undefined {
  if (
    !record(value) ||
    !record(value.expectation) ||
    typeof value.expectation.invocation !== 'string' ||
    !Array.isArray(value.expectation.required) ||
    !record(value.evidence) ||
    value.evidence.invocation !== value.expectation.invocation
  )
    return undefined;
  return value as unknown as RecordedPass;
}

/** Declared hosted-cache adapter. Shared nonce admission still requires qualification. */
export class BazelVerificationEngine implements ControllerEngine {
  readonly version = '9.2.0';
  readonly platform: NativeExecutionPlatform;
  private readonly process: DeclaredEngineProcess;
  private readonly contextDirectory: string;
  private source: SourceManifest | undefined;
  private stagedSnapshot: ReturnType<typeof materializeStagedSnapshot> | undefined;
  private engineDigest: string | undefined;
  private configurations: ReadonlyMap<string, string> | undefined;
  private sequence = 0;
  private unsignedProducers: ConfiguredArtifactProducers | undefined;
  private unsignedArtifacts: PreparedCiArtifactInputs | undefined;
  private nonceSequence = 0;
  private revocations: SourceManifest | undefined;
  private reservation: TestReservation | undefined;
  private audit: SourceManifest | undefined;
  private base = '';
  private candidate = '';
  private readonly executionPolicy: ExecutorPolicy | undefined;
  private readonly qualifyExecution: boolean;
  private remoteTests: readonly string[] = [];
  private simulationSelections: readonly {
    label: string;
    configuration: string;
    mode: 'replay' | 'sweep';
  }[] = [];
  private diagnosticFiles: readonly string[] = [];
  private diagnosticProblems: readonly string[] = [];
  private plans: PlanCache | undefined;
  private acquire: (() => Promise<void>) | undefined;
  private acquiring: Promise<void> | undefined;
  private facts: { readonly key: string; readonly value: SourceFacts } | undefined;
  pending: readonly string[] = [];

  constructor(
    private readonly options: {
      readonly signal: AbortSignal;
      readonly root: string;
      readonly directory: string;
      readonly tools: DeclaredEngineTools;
      readonly base?: string;
      readonly candidate?: string;
      readonly admittedUntracked: readonly string[];
      readonly all: boolean;
      readonly unit?: boolean;
      readonly staged?: boolean;
      readonly unsigned?: boolean;
      readonly completeUnsigned?: boolean;
      readonly executionPolicy?: ExecutorPolicy;
      readonly qualifyExecution?: boolean;
      /**
       * Where an ordinary run keeps its engine between runs. With a home the engine server
       * stays up and planning answers for identical inputs are reused; without one the
       * engine is private to the run and every question is asked.
       */
      readonly home?: string;
      readonly platform?: NativeExecutionPlatform;
      readonly assuranceEvent?: string;
      readonly extendedSuite?: string;
      readonly extendedSuites?: boolean;
      readonly diagnostics?: { readonly root: string; readonly directory: OwnedDirectory };
    },
  ) {
    const hostPlatform = `${process.platform}-${process.arch === 'x64' ? 'x86_64' : process.arch}`;
    const platform = options.platform ?? hostPlatform;
    if (!NATIVE_EXECUTION_PLATFORMS.includes(platform as NativeExecutionPlatform))
      throw new Error('Verification requires a supported native platform');
    if (platform !== hostPlatform && options.executionPolicy === undefined)
      throw new Error('A different native platform requires its declared executor policy');
    this.platform = platform as NativeExecutionPlatform;
    this.executionPolicy =
      options.executionPolicy === undefined
        ? undefined
        : parseExecutorPolicy(options.executionPolicy);
    this.qualifyExecution = options.qualifyExecution === true;
    if (this.qualifyExecution && this.executionPolicy === undefined)
      throw new Error('Native execution qualification requires an explicit executor policy');
    if (
      options.home !== undefined &&
      (options.executionPolicy !== undefined || options.unsigned || options.qualifyExecution)
    )
      throw new Error('A placed, qualifying or artifact-producing run requires a private engine');
    this.process = new DeclaredEngineProcess(
      options.tools,
      options.directory,
      options.signal,
      options.home,
    );
    if (this.executionPolicy !== undefined)
      this.process.bindExecutionPolicy(
        this.executionPolicy,
        this.platform as NativeExecutionPlatform,
      );
    this.contextDirectory = path.join(options.directory, 'git-inputs');
  }

  get verificationRoot(): string {
    return this.stagedSnapshot?.manifest.root ?? this.options.root;
  }

  async initialize(): Promise<void> {
    const resolve = (identity: string) =>
      this.process
        .git(this.options.root, ['rev-parse', '--verify', `${identity}^{commit}`])
        .toString()
        .trim();
    for (const identity of [this.options.base, this.options.candidate])
      if (identity !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(identity))
        throw new Error('Explicit base and candidate require full immutable Git identities');
    this.base = resolve(this.options.base ?? (this.options.staged ? 'HEAD' : 'refs/heads/main'));
    this.candidate = resolve(this.options.candidate ?? 'HEAD');
    const context = this.capture();
    if (this.options.staged) {
      if (this.options.admittedUntracked.length !== 0)
        throw new Error('Staged verification cannot admit working-tree source');
      this.stagedSnapshot = materializeStagedSnapshot({
        sourceRoot: this.options.root,
        destination: path.join(this.options.directory, 'index-source'),
        head: context.head,
        index: context.index,
        indexTree: this.process.git(this.options.root, ['write-tree']).toString().trim(),
        runGit: (args) => this.process.git(this.options.root, args),
      });
    }
    // Beside the checkout's other pinned downloads; Bazel checks every entry by digest.
    const tools = path.join(
      this.process
        .git(this.options.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
        .toString()
        .trim(),
      'merkur-tools',
    );
    const source = timed('source capture', () =>
      capturedSource({
        root: this.verificationRoot,
        context,
        admittedUntracked: this.options.admittedUntracked,
        read: (args, input) => this.process.git(this.options.root, args, input),
      }),
    );

    this.source = source;
    const identity = await validateEngineTools(this.options.tools, source);
    this.engineDigest = identity.digest;

    // What an earlier answer is keyed by is known now. The engine's own inputs, and the engine
    // itself, are made when the run first has a question no earlier answer holds.
    this.acquire = async () => {
      timed('git inputs', () =>
        acquireGitInputs({
          root: this.verificationRoot,
          destination: this.contextDirectory,
          context,
          source,
          read: (args, input) => this.process.git(this.options.root, args, input),
          recapture: () => this.capture(),
          ...(this.options.home === undefined
            ? {}
            : { packs: path.join(tools, 'bazel-object-pack') }),
        }),
      );
      this.process.bind(identity, this.contextDirectory);
      const version = await this.process.run(this.verificationRoot, '--version', []);

      if (version.exitCode !== 0 || version.stdout !== `bazel ${this.version}\n`)
        throw new Error(`The declared executable did not identify as Bazel ${this.version}`);
    };

    this.process.bindRepositoryCache(path.join(tools, 'bazel-repository-cache'));
    this.process.bindDiskCache(path.join(tools, 'bazel-disk-cache'));
    // A placed test runs on another host, which has no use for this one's stub store.
    if (this.executionPolicy === undefined)
      this.process.bindExecutableRoot(path.join(tools, 'bazel-test-executables'));
    // A kept engine reads the answers of earlier runs. One without a home starts with none
    // and keeps its own only for this run: it asks each question once, and its later plans of
    // the same bytes read that answer.
    this.plans = new PlanCache(
      this.options.home === undefined
        ? path.join(this.options.directory, 'plans')
        : path.join(tools, 'bazel-plan-cache'),
    );
  }

  /**
   * The engine with its Git inputs acquired and its identity bound, made on first use. An
   * engine that was never initialized has nothing to acquire, and its process refuses commands.
   */
  private acquired(): Promise<void> {
    this.acquiring ??= this.acquire?.() ?? Promise.resolve();

    return this.acquiring;
  }

  private async run(
    ...command: Parameters<DeclaredEngineProcess['run']>
  ): ReturnType<DeclaredEngineProcess['run']> {
    await this.acquired();

    return this.process.run(...command);
  }

  private async query(
    ...command: Parameters<DeclaredEngineProcess['query']>
  ): ReturnType<DeclaredEngineProcess['query']> {
    await this.acquired();

    return this.process.query(...command);
  }

  ledgerStore(directory: string): GitRevocationStore {
    if (!path.isAbsolute(directory) || realpathSync(directory) !== directory)
      throw new Error('Explicit physical bare ledger provisioning client required');
    const file = path.join(directory, 'config');
    const descriptor = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      const held = fstatSync(descriptor);
      if (!held.isFile()) throw new Error('Ledger provisioning config requires an ordinary File');
      bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      const current = lstatSync(file);
      if (
        current.dev !== held.dev ||
        current.ino !== held.ino ||
        current.mode !== held.mode ||
        after.size !== held.size ||
        after.mtimeMs !== held.mtimeMs ||
        after.ctimeMs !== held.ctimeMs ||
        realpathSync(directory) !== directory
      )
        throw new Error('Ledger provisioning config changed while captured');
    } finally {
      closeSync(descriptor);
    }
    // Git's ordinary commands cannot suppress local config. Parse the captured File
    // through stdin with includes disabled, then give transport its own bare metadata.
    const configuration = ledgerProvisioningConfiguration(
      this.process
        .git(
          this.options.directory,
          ['config', '--file', '-', '--no-includes', '--null', '--list'],
          bytes,
        )
        .toString(),
    );
    const client = mkdtempSync(path.join(this.options.directory, 'ledger-client-'));
    const environment = { ...this.process.environment, ...ledgerGitEnvironment() };
    const git = (args: readonly string[], input?: Uint8Array) => {
      const result = Bun.spawnSync(
        [this.options.tools.git, ...ledgerGitTransportArguments(configuration.origin, args)],
        { cwd: client, env: environment, stdin: input ?? 'ignore', stdout: 'pipe', stderr: 'pipe' },
      );
      if (result.signalCode) throw new Error('Declared ledger Git was cancelled');
      return { stdout: result.stdout.toString(), exitCode: result.exitCode };
    };
    function checked(args: readonly string[]): void {
      if (git(args).exitCode !== 0)
        throw new Error('Cannot initialize private declared ledger client');
    }
    checked([
      'init',
      '--bare',
      '--template=',
      `--object-format=${configuration.objectFormat}`,
      '.',
    ]);
    for (const [key, value] of [
      ['core.fsync', 'all'],
      ['core.fsyncMethod', 'fsync'],
      ['credential.helper', ''],
      ['credential.helper', ledgerCredentialHelperCommand(configuration.helper)],
      ['credential.useHttpPath', 'true'],
      ['credential.interactive', 'false'],
      ['http.sslVerify', 'true'],
      ['http.sslBackend', 'openssl'],
      ['http.sslCAInfo', this.process.environment.GIT_SSL_CAINFO],
      ['http.followRedirects', 'false'],
    ]) {
      if (key === undefined || value === undefined)
        throw new Error('Missing private ledger configuration');
      checked(['config', '--local', '--add', key, value]);
    }
    checked(['remote', 'add', 'origin', configuration.origin]);
    return new GitRevocationStore(git);
  }

  /**
   * The digest of everything a planning answer depends on: the engine, the selection, which
   * captured paths `root` holds, the bytes of the files the engine reads while it loads and
   * analyses, and the caller's facts. Any other source file reaches the engine only as an
   * action input, and a planning answer holds no action's result.
   *
   * The engine records a repository's inputs when it fetches it, so a key read before an
   * answer can lack an input the answer depended on. An answer is stored under the key read
   * after it.
   */
  private planKey(root: string, facts: unknown): string | undefined {
    const source = this.source;
    if (this.plans === undefined || source === undefined || this.engineDigest === undefined)
      return undefined;
    const loading = timed('plan key', () =>
      loadingFacts({
        root,
        paths: source.inputs.map((input) => input.path),
        engineRoot: this.process.engineRoot,
      }),
    );
    if (loading === undefined) return undefined;
    return createHash('sha256')
      .update(
        JSON.stringify({
          engine: this.engineDigest,
          platform: this.platform,
          selection: this.selection,
          // A test's configuration carries this path, so a plan belongs to it.
          executables: this.process.executableRootFlags(),
          ...loading,
          facts,
        }),
      )
      .digest('hex');
  }

  /**
   * The digest of everything a run's verdict depends on: the engine, the selection, every
   * captured byte, the Git facts and the epoch of each selected test.
   */
  private async passKey(epochs: TestEpochs): Promise<string | undefined> {
    const source = this.source;
    // A pass is kept for later runs, and an engine without a home has none.
    if (
      this.options.home === undefined ||
      source === undefined ||
      this.engineDigest === undefined ||
      this.audit !== undefined
    )
      return undefined;
    const git = await this.readGit();
    return createHash('sha256')
      .update(
        JSON.stringify({
          engine: this.engineDigest,
          platform: this.platform,
          selection: this.selection,
          executables: this.process.executableRootFlags(),
          content: manifestFromInventory(
            this.verificationRoot,
            source.inputs.map((input) => input.path),
            source.commit,
          ).digest,
          git: git.digest,
          admittedUntracked: this.options.admittedUntracked,
          epochs,
        }),
      )
      .digest('hex');
  }

  async recordedPass(epochs: TestEpochs): Promise<RecordedPass | undefined> {
    const key = await this.passKey(epochs);
    return key === undefined
      ? undefined
      : recordedPass(this.plans?.read(`pass:${this.platform}:${this.selection}`, key));
  }

  async recordPass(epochs: TestEpochs, pass: RecordedPass): Promise<void> {
    const key = await this.passKey(epochs);
    if (key !== undefined) this.plans?.write(`pass:${this.platform}:${this.selection}`, key, pass);
  }

  /** Whether the selection reads which paths Git reports as changed. */
  private get selectsChanged(): boolean {
    return !(
      this.options.unit ||
      this.options.extendedSuites ||
      this.options.extendedSuite !== undefined ||
      this.options.assuranceEvent !== undefined
    );
  }

  private get selection(): string {
    return JSON.stringify([
      this.options.all,
      this.options.unit ?? false,
      this.options.staged ?? false,
      this.options.extendedSuite ?? null,
      this.options.extendedSuites ?? false,
      this.options.assuranceEvent ?? null,
    ]);
  }

  async completeTestInventory(): Promise<readonly string[]> {
    const slot = `inventory:${this.platform}`;
    const key = this.planKey(this.verificationRoot, 'inventory');
    const cached = key === undefined ? undefined : this.plans?.read(slot, key);
    if (Array.isArray(cached) && cached.every((label) => typeof label === 'string')) return cached;
    const query = await this.query(
      this.verificationRoot,
      'query',
      'tests(//...)',
      'streamed_jsonproto',
      ['--enable_bzlmod', `--override_repository=verification_context=${this.contextDirectory}`],
    );
    const labels = query.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const value: { rule?: { name?: unknown } } = JSON.parse(line);
        const label = value.rule?.name;
        if (typeof label !== 'string' || !/^\/\/[^:\s]*:[^:\s]+$/.test(label))
          throw new Error('Complete test query contains a foreign target');
        return label;
      })
      .sort();
    if (labels.length === 0 || new Set(labels).size !== labels.length)
      throw new Error('Complete test inventory is empty or duplicated');
    const answered = this.planKey(this.verificationRoot, 'inventory');
    if (answered !== undefined) this.plans?.write(slot, answered, labels);
    return labels;
  }

  bindTestReservation(reservation: TestReservation): void {
    const directory = path.join(this.options.directory, `nonces-${++this.nonceSequence}`);
    mkdirSync(directory, { mode: 0o700 });
    publishNonceRepository(directory, reservation);
    this.revocations = manifestFromInventory(
      directory,
      [...nonceRepositoryFiles(reservation).keys()].sort(),
      this.candidate,
    );
    this.process.bindRevocations(this.revocations);
    this.reservation = structuredClone(reservation);
    this.audit = undefined;
    this.process.bindAudit(undefined);
  }

  /**
   * The checks to reserve epochs for. They follow from the source and the Git changes, so a
   * run that keeps its engine reads the last answer for the same bytes and asks otherwise.
   */
  async selectedChecks(): Promise<readonly RequiredCheck[]> {
    const root = this.verificationRoot;
    const git = await this.readGit();
    const facts = { changed: this.selectsChanged ? git.changed : null };
    const key = this.planKey(root, facts);
    if (this.plans === undefined || key === undefined)
      return (await this.plan(root, git, false)).coverage.required;
    const slot = `checks:${this.platform}:${this.selection}`;
    const cached = requiredChecks(this.plans.read(slot, key));
    if (cached !== undefined) return cached;
    const { coverage } = await this.selectCoverage(root, git);
    const answered = this.planKey(root, facts);
    if (this.audit === undefined && answered !== undefined)
      this.plans.write(slot, answered, coverage.required);
    return coverage.required;
  }

  testConfigurations(): ReadonlyMap<string, string> {
    if (this.configurations === undefined) throw new Error('Configured test inventory is absent');
    return new Map(this.configurations);
  }

  private capture(): GitContext {
    this.stagedSnapshot?.assertCurrent();
    return captureGitContext(
      (args) => this.process.git(this.options.root, args).toString(),
      this.base,
      this.candidate,
      this.options.staged ?? false,
    );
  }

  async readGit(): Promise<GitContext> {
    return this.capture();
  }

  private async readCaptured(root: string, name: string): Promise<unknown> {
    const input = this.source?.inputs.find((input) => input.path === name);
    if (input?.kind !== 'file')
      throw new Error(`Required captured configuration File is absent: ${name}`);
    const captured = await readDeclaredInput(root, name);
    if (captured.artifact.digest !== input.digest)
      throw new Error(`Captured configuration changed: ${name}`);
    return JSON.parse(captured.bytes.toString());
  }

  private queryFlags(): readonly string[] {
    return this.flags(false, this.process.queryBackendFlags());
  }

  private flags(execute = false, backend = this.process.backendFlags()): readonly string[] {
    const placement =
      this.executionPolicy === undefined
        ? []
        : executorFlags(this.executionPolicy, this.platform as NativeExecutionPlatform);
    return [
      '--enable_bzlmod',
      `--platforms=//tools/bazel/platforms:${
        {
          'darwin-arm64': 'macos_arm64',
          'darwin-x86_64': 'macos_x64',
          'linux-arm64': 'linux_arm64',
          'linux-x86_64': 'linux_x64',
        }[this.platform]
      }`,
      '--incompatible_strict_action_env',
      '--remote_verify_downloads',
      '--guard_against_concurrent_changes',
      '--remote_download_outputs=all',
      '--symlink_prefix=/',
      ...backend,
      ...(execute && this.executionPolicy !== undefined
        ? placement
        : [
            '--remote_executor=',
            ...placement.filter((flag) => !flag.startsWith('--remote_executor=')),
          ]),
      ...this.process.diskCacheFlags(),
      ...this.process.executableRootFlags(),
      `--override_repository=verification_context=${this.contextDirectory}`,
      ...(this.revocations === undefined
        ? []
        : [`--override_repository=verification_revocations=${this.revocations.root}`]),
      ...(this.audit === undefined
        ? []
        : [`--override_repository=verification_audit=${this.audit.root}`]),
      ...(this.qualifyExecution && this.platform.startsWith('darwin-')
        ? ['--experimental_sandbox_async_tree_delete_idle_threads=0']
        : []),
      '--keep_going',
      '--cache_test_results=auto',
      '--test_output=errors',
    ];
  }

  private async executionRoot(root: string): Promise<string> {
    const result = await this.run(root, 'info', ['execution_root', ...this.flags()]);
    const directory = result.stdout.trim();
    if (result.exitCode !== 0 || !path.isAbsolute(directory) || directory.includes('\n'))
      throw new Error('Pinned engine did not provide its materialized execution root');
    return directory;
  }

  private async acquireAudit(root: string): Promise<void> {
    const source = this.source;
    const reservation = this.reservation;
    if (source === undefined || reservation === undefined)
      throw new Error('Fresh audit requires reserved test nonces and captured source');
    const directory = mkdtempSync(path.join(this.options.directory, 'audit-'));
    const request = `${JSON.stringify({
      invocation: randomUUID(),
      source: source.digest,
      platform: this.platform,
      nonces: reservation.labels.map((label) => [label, reservation.snapshot.ledger[label]?.nonce]),
    })}\n`;
    const requestFile = path.join(directory, 'request');
    const snapshotFile = path.join(directory, 'snapshot');
    writeFileSync(requestFile, request, { flag: 'wx', mode: 0o600 });
    const capturedRequest = await readDeclaredInput(directory, 'request');
    const result = await this.run(root, 'run', [
      '//tools/bazel/verification:dependency_audit_capture',
      ...this.flags(),
      '--',
      '--request',
      requestFile,
      '--snapshot',
      snapshotFile,
    ]);
    const currentRequest = await readDeclaredInput(directory, 'request');
    if (currentRequest.artifact.digest !== capturedRequest.artifact.digest)
      throw new Error('Fresh audit acquisition request changed');
    if (result.exitCode !== 0)
      throw new Error('Fresh dependency audit failed; see retained private acquisition evidence');
    const capturedSnapshot = await readDeclaredInput(directory, 'snapshot');
    const snapshot: unknown = JSON.parse(capturedSnapshot.bytes.toString());
    if (!record(snapshot) || snapshot.request !== capturedRequest.artifact.digest)
      throw new Error('Audit snapshot belongs to another acquisition request');
    writeFileSync(
      path.join(directory, 'BUILD.bazel'),
      'package(default_visibility = ["//visibility:public"])\nexports_files(["request", "snapshot"])\n',
      { flag: 'wx', mode: 0o600 },
    );
    writeFileSync(path.join(directory, 'REPO.bazel'), '', { flag: 'wx', mode: 0o600 });
    const audit = manifestFromInventory(
      directory,
      ['BUILD.bazel', 'REPO.bazel', 'request', 'snapshot'],
      this.candidate,
    );
    for (const [name, captured] of [
      ['request', capturedRequest],
      ['snapshot', capturedSnapshot],
    ] as const) {
      const input = audit.inputs.find((input) => input.path === name);
      if (input?.kind !== 'file' || input.digest !== captured.artifact.digest)
        throw new Error('Fresh audit acquisition bytes changed before binding');
    }
    this.process.bindAudit(audit);
    this.audit = audit;
  }

  private selectedCoverage(catalog: CoverageCatalog, changed: readonly string[]): CoveragePlan {
    return this.options.unit
      ? unitCoverage(catalog)
      : this.options.extendedSuites
        ? extendedWorkflowsSelection(catalog)
        : this.options.extendedSuite !== undefined
          ? extendedWorkflowSelection(this.options.extendedSuite, catalog)
          : this.options.assuranceEvent !== undefined
            ? assuranceWorkflowSelection(this.options.assuranceEvent, catalog).coverage
            : this.options.all
              ? fullCoverage(changed, catalog)
              : coveragePlan(changed, catalog, false);
  }

  /**
   * The configured plan for `root`. An unforced run reads the last configured graph whose
   * digest covers the same loading inputs, captured paths, selection, engine and test
   * inventory, and asks the engine only when one of them differs. The epochs it binds are
   * always the reserved ones.
   */
  async plan(root: string, git: GitContext, acquireFreshAudit = true): Promise<EnginePlan> {
    const reservation = this.reservation;
    // A run asks twice: once to select its checks, bound to every test's epoch, and again
    // once those are reserved, bound to the selected ones. Each question has its own slot.
    const slot = `plan:${this.platform}:${this.selection}:${acquireFreshAudit ? 'reserved' : 'selecting'}`;
    // The nonce repository declares one file for each test in the ledger and the plan checks
    // the selected ones; a nonce is that file's bytes, which the configured graph never holds.
    const facts =
      reservation === undefined
        ? undefined
        : {
            changed: this.selectsChanged ? git.changed : null,
            selected: reservation.labels,
            ledger: Object.keys(reservation.snapshot.ledger).sort(),
          };
    // An audit binds a fresh acquisition into the plan, so such a plan is never reused.
    const key =
      facts === undefined || this.audit !== undefined ? undefined : this.planKey(root, facts);
    const cached = key === undefined ? undefined : cachedPlan(this.plans?.read(slot, key));
    if (cached !== undefined) {
      this.pending = cached.pendingQualifications;
      this.configurations = new Map(cached.configurations);
      this.simulationSelections = cached.simulations;
      return this.boundPlan(cached);
    }
    const configured = await this.configuredPlan(root, git, acquireFreshAudit);
    const answered =
      facts === undefined || this.audit !== undefined ? undefined : this.planKey(root, facts);
    if (
      answered !== undefined &&
      !configured.coverage.required.some((check) => check.label === DEPENDENCY_AUDIT)
    )
      this.plans?.write(slot, answered, configured);
    return this.boundPlan(configured);
  }

  /** The plan a configured graph makes with the epochs reserved now. */
  private boundPlan(configured: ConfiguredPlan): EnginePlan {
    const reservation = this.reservation;
    if (reservation === undefined) throw new Error('Declared engine is not initialized');
    return {
      coverage: configured.coverage,
      actionSources: configured.actionSources,
      analysisSources: configured.analysisSources,
      contextDigest: createHash('sha256')
        .update(
          JSON.stringify({
            engine: this.engineDigest,
            audit: this.audit?.digest,
            unsignedProducers: this.unsignedProducers?.producers,
            inventory: configured.context.inventory,
            policy: configured.context.policy,
            qualification: configured.context.qualification,
            executionPolicy: this.executionPolicy,
            nonces: reservation.labels.map((label) => [
              label,
              reservation.snapshot.ledger[label]?.nonce,
            ]),
            configurations: configured.configurations,
          }),
        )
        .digest('hex'),
      pendingQualifications: configured.pendingQualifications,
    };
  }

  /**
   * The source-test inventory, its action inputs and the configured policy descriptors. They
   * follow from the captured source alone, never from a test epoch, so a run that keeps its
   * engine asks for them once and both of its plans read the same answers.
   */
  private async sourceFacts(root: string): Promise<SourceFacts> {
    const key = this.planKey(root, { audit: this.audit?.digest ?? null });
    if (key !== undefined && this.facts?.key === key) return this.facts.value;
    const query = await this.query(root, 'query', SOURCE_TEST_QUERY, 'streamed_jsonproto', [
      '--enable_bzlmod',
      `--override_repository=verification_context=${this.contextDirectory}`,
      ...(this.revocations === undefined
        ? []
        : [`--override_repository=verification_revocations=${this.revocations.root}`]),
      ...(this.audit === undefined
        ? []
        : [`--override_repository=verification_audit=${this.audit.root}`]),
    ]);
    // The exact complete queried source inventory determines the full action query.
    const labels = query.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const value: { rule?: { name?: unknown } } = JSON.parse(line);
        if (typeof value.rule?.name !== 'string' || !/^\/\/[^:\s]*:[^:\s]+$/.test(value.rule.name))
          throw new Error('Source query contains an invalid target identity');
        return value.rule.name;
      })
      .sort();
    const actions = await this.query(
      root,
      'aquery',
      `deps(set(${labels.join(' ')}))`,
      'jsonproto',
      this.queryFlags(),
    );
    const inventory = sourceInventory(query, actions);
    const eventsFile = path.join(this.options.directory, `planning-${++this.sequence}.bep.json`);
    const built = await this.run(root, 'build', [
      ...CONFIGURED_POLICY_PRODUCERS,
      ...this.flags(),
      '--output_groups=descriptor',
      `--build_event_json_file=${eventsFile}`,
    ]);
    const configured = await loadConfiguredPolicyInputs({
      root: await this.executionRoot(root),
      events: readFileSync(eventsFile, 'utf8'),
      exitCode: built.exitCode,
      inventory,
    });
    const value = { actions, inventory, configured };
    const answered = this.planKey(root, { audit: this.audit?.digest ?? null });
    if (answered !== undefined) this.facts = { key: answered, value };
    return value;
  }

  /** The checks this run requires: the source facts, the Git changes and the selection. */
  private async selectCoverage(root: string, git: GitContext) {
    if (
      this.engineDigest === undefined ||
      this.revocations === undefined ||
      this.reservation === undefined
    )
      throw new Error('Declared engine is not initialized');
    const obligations = await this.readCaptured(root, '.github/bazel/qualification.json');
    this.pending = pendingQualifications(obligations, QUALIFICATION_GROUPS);
    const facts = await this.sourceFacts(root);
    const { configured } = facts;
    this.pending = [...new Set([...this.pending, ...configured.pendingQualifications])].sort();
    let coverage = this.selectedCoverage(configured.catalog, git.changed);
    if (this.options.staged) {
      const ratchet = {
        label: '//tools/bazel/verification:staged_ratchet',
        kind: 'test' as const,
        fresh: true,
      };
      const secrets = {
        label: '//tools/bazel/verification:staged_secrets',
        kind: 'test' as const,
        fresh: true,
      };
      const replaced = new Set(
        coverage.staticOperations
          .filter((operation) => operation.name === 'check:ratchet')
          .flatMap((operation) => operation.checks.map((check) => check.label)),
      );
      coverage = {
        ...coverage,
        required: [
          ...coverage.required.filter((check) => !replaced.has(check.label)),
          ratchet,
          secrets,
        ].sort((left, right) => left.label.localeCompare(right.label)),
        staticOperations: coverage.staticOperations.map((operation) =>
          operation.name === 'check:ratchet' ? { ...operation, checks: [ratchet] } : operation,
        ),
        reasons: [
          ...coverage.reasons,
          'Exact staged index secret scanning and HEAD ratchet required',
        ],
      };
    }
    if (this.options.unsigned) {
      const labels = configuredUnsignedSelection(
        this.platform,
        this.options.completeUnsigned ?? false,
      );
      const invocation = randomUUID();
      const descriptorEvents = path.join(this.options.directory, `${invocation}.unsigned.bep.json`);
      const descriptorBuild = await this.run(root, 'build', [
        ...labels,
        ...this.flags(),
        `--output_groups=${UNSIGNED_CONTRACT_OUTPUT_GROUP}`,
        `--invocation_id=${invocation}`,
        `--build_event_json_file=${descriptorEvents}`,
      ]);
      this.unsignedProducers = await captureConfiguredArtifactProducers({
        invocation,
        root: await this.executionRoot(root),
        events: readFileSync(descriptorEvents, 'utf8'),
        exitCode: descriptorBuild.exitCode,
        labels,
      });
      coverage = {
        ...coverage,
        required: [
          ...coverage.required.filter((check) => !labels.includes(check.label)),
          ...labels.map((label) => ({ label, kind: 'build' as const, fresh: false })),
        ].sort((left, right) => left.label.localeCompare(right.label)),
        reasons: [...coverage.reasons, 'Configured unsigned producer bytes required'],
      };
    }
    return { ...facts, coverage };
  }

  private async configuredPlan(
    root: string,
    git: GitContext,
    acquireFreshAudit: boolean,
  ): Promise<ConfiguredPlan> {
    const source = this.source;
    if (source === undefined || this.reservation === undefined)
      throw new Error('Declared engine is not initialized');
    const { actions, inventory, configured, coverage } = await this.selectCoverage(root, git);
    if (
      acquireFreshAudit &&
      this.audit === undefined &&
      coverage.required.some((check) => check.label === DEPENDENCY_AUDIT)
    ) {
      await this.acquireAudit(root);
      // Recapture the whole configured inventory with the same immutable pair that
      // selected TestRunner inputs and the frozen-source plan will consume.
      return this.configuredPlan(root, git, acquireFreshAudit);
    }
    const expression = configuredCheckExpression(coverage.required);
    const all = await this.query(root, 'cquery', expression, 'jsonproto', this.queryFlags());
    const tests = await this.query(
      root,
      'cquery',
      `tests(${expression})`,
      'jsonproto',
      this.queryFlags(),
    );
    const configurations = configuredCheckKinds(coverage.required, all, tests);
    const selected = await this.query(
      root,
      'aquery',
      `deps(${checkSetExpression(coverage.required)})`,
      'jsonproto',
      this.queryFlags(),
    );
    const testLabels = coverage.required
      .filter((check) => check.kind === 'test')
      .map((check) => check.label);
    if (this.executionPolicy !== undefined) {
      const receipt = engineQueryReceipt(selected);
      if (receipt.command !== 'aquery')
        throw new Error('Execution placement requires an owned aquery');
      const pool = this.executionPolicy.pools.find((item) => item.platform === this.platform);
      if (pool === undefined) throw new Error('Native execution pool is absent');
      this.remoteTests = configuredExecutionPlacement(
        selected.stdout,
        testLabels,
        pool.executionPlatform,
      );
      if (this.qualifyExecution)
        this.pending = [
          ...new Set([
            ...this.pending,
            'Native executor worker identity, observed OS/image and matched SDK authority are unqualified',
          ]),
        ].sort();
    }
    const mapping = await this.run(root, 'mod', ['dump_repo_mapping', '', '--enable_bzlmod']);
    const repositories: unknown = JSON.parse(mapping.stdout);
    if (
      mapping.exitCode !== 0 ||
      repositories === null ||
      typeof repositories !== 'object' ||
      !('verification_revocations' in repositories) ||
      typeof repositories.verification_revocations !== 'string'
    )
      throw new Error('Pinned engine did not identify the nonce repository mapping');
    testNonceInputPaths(
      selected.stdout,
      testLabels,
      `external/${repositories.verification_revocations}`,
    );
    this.configurations = configurations;
    const selectedLabels = new Set(coverage.required.map((check) => check.label));
    const emitters = new Map<string, 'replay' | 'sweep'>();
    for (const outputs of configured.simulationOutputs.values())
      for (const output of outputs) {
        if (!selectedLabels.has(output.label)) continue;
        const previous = emitters.get(output.label);
        if (previous !== undefined && previous !== output.mode)
          throw new Error('Conflicting configured simulation output modes');
        emitters.set(output.label, output.mode);
      }
    this.simulationSelections = [...emitters].map(([label, mode]) => {
      const configuration = configurations.get(label);
      if (configuration === undefined)
        throw new Error('Simulation emitter configuration is absent');
      return { label, configuration, mode };
    });
    const firstParty = [
      ...new Set([
        ...source.inputs.map((input) => input.path),
        ...declaredSourcePaths(actions.stdout),
        ...declaredSourcePaths(selected.stdout),
      ]),
    ].sort();
    // Bind configuration bytes on both the original and copied plan, even for unchanged paths.
    const qualificationFile = await readDeclaredInput(root, '.github/bazel/qualification.json');
    return {
      coverage,
      actionSources: firstParty,
      analysisSources: source.inputs.map((input) => input.path),
      pendingQualifications: this.pending,
      context: {
        inventory: inventory.digest,
        policy: configured.inputDigest,
        qualification: qualificationFile.artifact.digest,
      },
      configurations: [...configurations],
      simulations: this.simulationSelections,
    };
  }

  close(): Promise<void> {
    return this.process.close();
  }

  get developmentEnvironment(): NodeJS.ProcessEnv {
    return { ...this.process.environment };
  }

  async buildArtifacts(
    labels: readonly string[],
    outputGroups: readonly string[] = [],
  ): Promise<{
    executionRoot: string;
    events: string;
    exitCode: number | null;
  }> {
    if (
      labels.length === 0 ||
      new Set(labels).size !== labels.length ||
      labels.some((label) => !/^\/\/[^:\s]*:[^:\s]+$/.test(label))
    )
      throw new Error('Development builds require distinct declared target labels');
    if (
      new Set(outputGroups).size !== outputGroups.length ||
      outputGroups.some((group) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(group))
    )
      throw new Error('Development builds require distinct named output groups');
    const invocation = randomUUID();
    const file = path.join(this.options.directory, `development-${invocation}.bep.json`);
    const result = await this.run(this.verificationRoot, 'build', [
      ...labels,
      ...this.flags(),
      ...(outputGroups.length === 0 ? [] : [`--output_groups=${outputGroups.join(',')}`]),
      `--invocation_id=${invocation}`,
      `--build_event_json_file=${file}`,
    ]);
    return {
      executionRoot: await this.executionRoot(this.verificationRoot),
      events: readFileSync(file, 'utf8'),
      exitCode: result.exitCode,
    };
  }

  simulationDiagnostics() {
    return {
      root: this.options.diagnostics?.root,
      files: [...this.diagnosticFiles],
      problems: [...this.diagnosticProblems],
    };
  }

  private async retainSimulationDiagnostics(
    file: string,
    invocation: string,
    executionRoot: string,
  ): Promise<void> {
    const diagnostics = this.options.diagnostics;
    if (diagnostics === undefined)
      throw new Error('Simulation outputs require an owned retained directory');
    const retained = await retainSimulationOutputs({
      events: readFileSync(file, 'utf8'),
      invocation,
      executionRoot,
      outputRoot: diagnostics.root,
      directory: diagnostics.directory,
      selections: this.simulationSelections,
      assertCurrent: () => diagnostics.directory.verifyCreated(diagnostics.root),
    });
    this.diagnosticFiles = retained.files;
    this.diagnosticProblems = retained.problems;
    if (retained.problems.length !== 0) {
      this.pending = [...new Set([...this.pending, ...retained.problems])].sort();
      throw new Error(`Simulation diagnostics incomplete: ${retained.problems.join('; ')}`);
    }
  }

  async execute(
    request: Parameters<FrontEndEngine['execute']>[0],
  ): Promise<{ events: string; exitCode: number | null }> {
    const configurations = this.configurations;
    if (configurations === undefined)
      throw new Error('Execution requires a complete configured target plan');
    if (
      manifestFromInventory(
        request.root,
        request.source.inputs.map((input) => input.path),
        request.git.head,
      ).digest !== request.source.digest
    )
      throw new Error('Frozen execution source differs from admitted inputs');
    const file = path.join(this.options.directory, `${request.invocation}.bep.json`);
    const executionLog = path.join(this.options.directory, `${request.invocation}.execution.json`);
    const simulationRoot =
      this.simulationSelections.length === 0 ? undefined : await this.executionRoot(request.root);
    if (simulationRoot !== undefined && this.options.diagnostics === undefined)
      throw new Error('Simulation outputs require an owned retained directory');
    let result: Awaited<ReturnType<DeclaredEngineProcess['run']>>;
    try {
      result = await this.run(request.root, 'test', [
        ...request.required.map((check) => check.label),
        ...this.flags(true),
        ...(this.options.unsigned
          ? [`--output_groups=default,${UNSIGNED_CONTRACT_OUTPUT_GROUP}`]
          : []),
        // Preserve every spawn record without sorting the complete log in JVM memory.
        ...(this.qualifyExecution
          ? [`--execution_log_json_file=${executionLog}`, '--noexecution_log_sort']
          : []),
        `--invocation_id=${request.invocation}`,
        `--build_event_json_file=${file}`,
        ...(simulationRoot === undefined ? [] : ['--nozip_undeclared_test_outputs']),
      ]);
    } catch (error) {
      if (simulationRoot !== undefined) {
        try {
          await this.retainSimulationDiagnostics(file, request.invocation, simulationRoot);
        } catch (retentionFailure) {
          throw new AggregateError(
            [error, retentionFailure],
            'Simulation execution and diagnostic retention failed',
          );
        }
      }
      throw error;
    }
    if (simulationRoot !== undefined)
      await this.retainSimulationDiagnostics(file, request.invocation, simulationRoot);
    const events = readFileSync(file, 'utf8');
    const report = readBuildEvents(events, request.required);
    if (this.qualifyExecution) {
      const pool = this.executionPolicy?.pools.find((item) => item.platform === this.platform);
      if (pool === undefined) throw new Error('Native execution pool is absent');
      validateExecutionPlacement(executionLogFileRecords(executionLog), this.remoteTests, pool);
    }
    for (const check of report.checks)
      if (check.configuration !== configurations.get(check.label))
        throw new Error(`Executed check differs from planned target configuration: ${check.label}`);
    this.unsignedArtifacts = undefined;
    if (this.options.unsigned && result.exitCode === 0) {
      if (this.unsignedProducers === undefined) throw new Error('Unsigned producer plan is absent');
      this.unsignedArtifacts = await loadConfiguredCiArtifactInputs({
        invocation: request.invocation,
        executionRoot: await this.executionRoot(request.root),
        events,
        exitCode: result.exitCode,
        configured: this.unsignedProducers,
      });
    }
    return { events, exitCode: result.exitCode };
  }

  unsignedArtifactInputs(): PreparedCiArtifactInputs {
    if (this.unsignedArtifacts === undefined)
      throw new Error('Unsigned execution outputs are absent or incomplete');
    return structuredClone(this.unsignedArtifacts);
  }
}
