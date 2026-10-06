import { createHash, randomUUID } from 'node:crypto';
import { admitSourceInputs } from './admission';
import type { CoveragePlan } from './coverage';
import type { RequiredCheck } from './events';
import { type GitContext, validGitContext } from './git-context';
import { type VerificationEvidence, type VerificationReport, verificationReport } from './report';
import { assertReportOutputOutside, type ReportOutput, verifyReportOutput } from './report-output';
import { sanitizeBuildEvents } from './sanitize';
import {
  manifestFromInventory,
  materializeSnapshot,
  materializeStableSnapshot,
  type SourceManifest,
} from './snapshot';
import { timed, timedAsync } from './stages';
import { BAZEL_STATIC_GATES } from './static-gates';

export interface EnginePlan {
  readonly coverage: CoveragePlan;
  /** Source artifacts from the configured planning/action graph. */
  readonly actionSources: readonly string[];
  /** Engine-loaded BUILD/Starlark/module/configuration inputs, including the root module. */
  readonly analysisSources: readonly string[];
  /** Configured inventory and tool/SDK/action policy identity. */
  readonly contextDigest: string;
  readonly pendingQualifications: readonly string[];
}

export interface VerificationResult extends VerificationReport {
  /** Reconstructable engine evidence; downstream consumers must recompute admission. */
  readonly evidence: VerificationEvidence;
}

/** Captured by the trusted controller before execution, independently of submitted evidence. */
export interface VerificationExpectation {
  readonly platform: string;
  readonly invocation: string;
  readonly base: string;
  readonly candidate: string;
  readonly head: string;
  readonly gitDigest: string;
  readonly sourceDigest: string;
  readonly configuredDigest: string;
  readonly required: readonly RequiredCheck[];
  readonly admittedUntracked: readonly string[];
}

export interface FrontEndEngine {
  readonly version: '9.2.0';
  readonly platform: string;
  readGit(): Promise<GitContext>;
  plan(root: string, git: GitContext): Promise<EnginePlan>;
  /** Exactly one merged engine execution; Bazel owns execution and every result. */
  execute(request: {
    readonly root: string;
    readonly invocation: string;
    readonly required: readonly RequiredCheck[];
    readonly git: GitContext;
    readonly source: SourceManifest;
  }): Promise<{ readonly events: string; readonly exitCode: number | null }>;
}

export interface VerificationPreparationOptions {
  readonly root: string;
  readonly destination: string;
  /** A directory that outlives the run: the frozen copy is published there instead. */
  readonly stable?: string;
  readonly admittedUntracked: readonly string[];
}

/** An owned preparation, not a serialized worker-supplied plan. */
export interface PreparedVerification {
  readonly expectation: VerificationExpectation;
}

interface PreparationState {
  readonly options: VerificationPreparationOptions;
  readonly engine: FrontEndEngine;
  readonly platform: string;
  readonly version: '9.2.0';
  readonly git: GitContext;
  readonly plan: EnginePlan;
  readonly identity: string;
  readonly inventory: readonly string[];
  readonly snapshot: SourceManifest;
  readonly frozenRoot: string;
  readonly executionSource: SourceManifest;
  status:
    | 'prepared'
    | 'publishing'
    | 'published'
    | 'validating'
    | 'executing'
    | 'consumed'
    | 'rejected';
}

const preparations = new WeakMap<PreparedVerification, PreparationState>();

function sourceManifest(root: string, inventory: readonly string[], commit: string) {
  return timed('source manifest', () => manifestFromInventory(root, inventory, commit));
}

function readGit(engine: FrontEndEngine): Promise<GitContext> {
  return timedAsync('git facts', () => engine.readGit());
}

function enginePlan(engine: FrontEndEngine, root: string, git: GitContext): Promise<EnginePlan> {
  return timedAsync('plan', () => engine.plan(root, git));
}

export interface PublishedVerificationExpectations {
  readonly sha256: string;
}

interface PublicationState {
  readonly prepared: readonly PreparedVerification[];
  readonly outputs: readonly ReportOutput[];
  consumed: boolean;
}

const publications = new WeakMap<PublishedVerificationExpectations, PublicationState>();

/** Publish the owned complete batch, synchronously flush it, and retain its original output. */
export function writeVerificationExpectations(
  supplied: readonly PreparedVerification[],
  suppliedOutputs: readonly ReportOutput[],
): PublishedVerificationExpectations {
  const prepared = Object.freeze([...supplied]);
  const outputs = Object.freeze([...suppliedOutputs]);
  if (prepared.length === 0 || new Set(prepared).size !== prepared.length)
    throw new Error('Expectation publication requires a nonempty unique preparation batch');
  if (outputs.length === 0 || new Set(outputs).size !== outputs.length)
    throw new Error('Expectation publication requires unique owned outputs');
  for (const item of prepared) {
    const state = preparation(item);
    if (state.status !== 'publishing') throw new Error('Expectation batch is not publishing');
    for (const output of outputs) {
      assertReportOutputOutside(output, state.options.root);
      assertReportOutputOutside(output, state.frozenRoot);
    }
  }
  const content = `${JSON.stringify(
    prepared.map((item) => item.expectation),
    null,
    2,
  )}\n`;
  for (const output of outputs) {
    output.write(content);
    verifyReportOutput(output);
  }
  const receipt = Object.freeze({ sha256: createHash('sha256').update(content).digest('hex') });
  publications.set(receipt, { prepared, outputs, consumed: false });
  return receipt;
}

function confirmPublication(
  prepared: readonly PreparedVerification[],
  receipt: unknown,
): PublicationState {
  if (receipt === null || typeof receipt !== 'object')
    throw new Error('An owned durable expectation publication receipt is required');
  const state = publications.get(receipt as PublishedVerificationExpectations);
  if (
    state === undefined ||
    state.consumed ||
    state.prepared.length !== prepared.length ||
    state.prepared.some((item, index) => item !== prepared[index])
  )
    throw new Error('An owned durable receipt for the exact preparation batch is required');
  for (const output of state.outputs) verifyReportOutput(output);
  return state;
}

function preparation(prepared: PreparedVerification): PreparationState {
  const state = preparations.get(prepared);
  if (state === undefined) throw new Error('Verification requires an owned preparation');
  return state;
}

function immutable<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) immutable(child, seen);
    Object.freeze(value);
  }
  return value;
}

function checkStaticCoverage(plan: EnginePlan): void {
  const operations = plan.coverage.staticOperations;
  if (
    !Array.isArray(operations) ||
    JSON.stringify(operations.map((operation) => operation.name).sort()) !==
      JSON.stringify([...BAZEL_STATIC_GATES].sort())
  )
    throw new Error('The configured engine plan must represent every static policy');
  const owned = new Set<string>();
  for (const operation of operations) {
    if (!Array.isArray(operation.checks) || operation.checks.length === 0)
      throw new Error('A configured static policy has no engine checks');
    for (const check of operation.checks) {
      const required = plan.coverage.required.find((entry) => entry.label === check.label);
      if (
        typeof check.fresh !== 'boolean' ||
        owned.has(check.label) ||
        required === undefined ||
        required.kind !== check.kind ||
        (check.fresh && !required.fresh)
      )
        throw new Error('A configured static policy is absent or ambiguous in required coverage');
      owned.add(check.label);
    }
  }
}

function planIdentity(plan: EnginePlan): string {
  checkStaticCoverage(plan);
  if (
    !/^[a-f0-9]{64}$/.test(plan.contextDigest) ||
    plan.coverage.required.length === 0 ||
    plan.actionSources.length === 0 ||
    !plan.analysisSources.includes('MODULE.bazel') ||
    !plan.analysisSources.includes('BUILD.bazel') ||
    !plan.analysisSources.includes('.bazelversion') ||
    new Set(plan.coverage.required.map((check) => check.label)).size !==
      plan.coverage.required.length
  ) {
    throw new Error('The configured engine plan is incomplete');
  }
  for (const check of plan.coverage.required) {
    if (
      !/^\/\/[^:\s]*:[^:\s]+$/.test(check.label) ||
      !['test', 'build'].includes(check.kind) ||
      typeof check.fresh !== 'boolean'
    ) {
      throw new Error('The configured engine plan contains an invalid required check');
    }
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        coverage: plan.coverage,
        actionSources: [...new Set(plan.actionSources)].sort(),
        analysisSources: [...new Set(plan.analysisSources)].sort(),
        contextDigest: plan.contextDigest,
        pendingQualifications: [...new Set(plan.pendingQualifications)].sort(),
      }),
    )
    .digest('hex');
}

function checkedGit(git: GitContext): GitContext {
  if (!validGitContext(git)) throw new Error('Fresh Git context is invalid');
  return git;
}

/** Capture and reproduce a plan without dispatching any platform execution. */
export async function prepareVerification(
  supplied: VerificationPreparationOptions,
  engine: FrontEndEngine,
): Promise<PreparedVerification> {
  const options = immutable({
    root: supplied.root,
    destination: supplied.destination,
    ...(supplied.stable === undefined ? {} : { stable: supplied.stable }),
    admittedUntracked: [...supplied.admittedUntracked],
  });
  const platform = engine.platform;
  const version = engine.version;
  if (version !== '9.2.0') throw new Error('Verification requires the pinned engine version');
  const git = immutable(structuredClone(checkedGit(await readGit(engine))));
  const plan = immutable(structuredClone(await enginePlan(engine, options.root, git)));
  const identity = planIdentity(plan);
  const inventory = [...new Set([...plan.actionSources, ...plan.analysisSources])].sort();
  const snapshot = immutable(sourceManifest(options.root, inventory, git.head));
  admitSourceInputs(snapshot, git, options.admittedUntracked);
  const stable = options.stable;
  const frozenRoot = timed('frozen copy', () =>
    stable === undefined
      ? materializeSnapshot(snapshot, options.destination)
      : materializeStableSnapshot(snapshot, stable),
  );
  const frozenPlan = await enginePlan(engine, frozenRoot, git);
  if (planIdentity(frozenPlan) !== identity) {
    throw new Error('Copied source does not reproduce its configured engine plan');
  }
  const executionSource = immutable(sourceManifest(frozenRoot, inventory, git.head));
  if (executionSource.digest !== snapshot.digest)
    throw new Error('Copied source changed before snapshot execution');
  if (engine.platform !== platform || engine.version !== version)
    throw new Error('Engine platform or version changed during preparation');
  const prepared = Object.freeze({
    expectation: immutable({
      platform,
      invocation: randomUUID(),
      base: git.base,
      candidate: git.candidate,
      head: git.head,
      gitDigest: git.digest,
      sourceDigest: snapshot.digest,
      configuredDigest: plan.contextDigest,
      required: plan.coverage.required,
      admittedUntracked: options.admittedUntracked,
    }),
  });
  preparations.set(prepared, {
    options,
    engine,
    platform,
    version,
    git,
    plan,
    identity,
    inventory,
    snapshot,
    frozenRoot,
    executionSource,
    status: 'prepared',
  });
  return prepared;
}

/** Confirm the entire batch's independent expectations before any execution can dispatch. */
export async function publishVerificationExpectations(
  supplied: readonly PreparedVerification[],
  publish: (contexts: readonly VerificationExpectation[]) => unknown | Promise<unknown>,
): Promise<void> {
  const prepared = Object.freeze([...supplied]);
  if (prepared.length === 0 || new Set(prepared).size !== prepared.length)
    throw new Error('Expectation publication requires a nonempty unique preparation batch');
  const states = prepared.map(preparation);
  if (states.some((state) => state.status !== 'prepared'))
    throw new Error('A verification preparation can be published only once');
  for (const state of states) state.status = 'publishing';
  try {
    const receipt = await publish(Object.freeze(prepared.map((item) => item.expectation)));
    if (states.some((state) => state.status !== 'publishing'))
      throw new Error('Verification preparation was rejected during publication');
    const publication = confirmPublication(prepared, receipt);
    for (const state of states) await checkBeforeExecution(state);
    if (states.some((state) => state.status !== 'publishing'))
      throw new Error('Verification preparation was rejected during publication');
    for (const output of publication.outputs) verifyReportOutput(output);
    publication.consumed = true;
    for (const state of states) state.status = 'published';
  } catch (error) {
    for (const state of states) state.status = 'rejected';
    throw error;
  }
}

/** Cancellation permanently prevents dispatch; the controller separately retires its ledger. */
export function rejectPreparedVerification(prepared: PreparedVerification): void {
  const state = preparation(prepared);
  if (state.status === 'executing')
    throw new Error('A dispatched engine must complete or cancel before preparation rejection');
  state.status = 'rejected';
}

function unchangedEngine(state: PreparationState): void {
  if (state.engine.platform !== state.platform || state.engine.version !== state.version)
    throw new Error('Engine platform or version differs from its captured preparation');
}

async function checkBeforeExecution(state: PreparationState): Promise<void> {
  const { engine, git, frozenRoot, inventory, snapshot } = state;
  unchangedEngine(state);
  const beforeExecution = checkedGit(await readGit(engine));
  if (beforeExecution.digest !== git.digest)
    throw new Error('Git context changed before snapshot execution');
  if (sourceManifest(frozenRoot, inventory, git.head).digest !== snapshot.digest)
    throw new Error('Copied source changed before snapshot execution');
  unchangedEngine(state);
}

/** Consume exactly once; preparation and publication do not authorize a second dispatch. */
export async function executePreparedVerification(
  prepared: PreparedVerification,
): Promise<VerificationResult> {
  const state = preparation(prepared);
  if (state.status !== 'published')
    throw new Error('Execution requires a confirmed, unused verification preparation');
  state.status = 'validating';
  try {
    await checkBeforeExecution(state);
    if (state.status !== 'validating')
      throw new Error('Verification preparation was rejected before dispatch');
    state.status = 'executing';
    return await executeAndReconcile(prepared, state);
  } finally {
    state.status = 'consumed';
  }
}

async function reconcileCurrent(state: PreparationState) {
  const { options, engine, git, plan, identity, inventory } = state;
  unchangedEngine(state);
  const pending = new Set(plan.pendingQualifications);
  for (const name of plan.coverage.pendingDeferred) pending.add(`Deferred required check: ${name}`);
  let currentGit = git;
  let currentInventory = inventory;
  try {
    currentGit = checkedGit(await readGit(engine));
    if (currentGit.digest !== git.digest) pending.add('Git context changed during execution');
    const currentPlan = await enginePlan(engine, options.root, currentGit);
    if (planIdentity(currentPlan) !== identity) {
      pending.add('Configured graph or required coverage changed during execution');
    }
    currentInventory = [
      ...new Set([...inventory, ...currentPlan.actionSources, ...currentPlan.analysisSources]),
    ].sort();
    for (const name of currentPlan.pendingQualifications) pending.add(name);
    const afterPlanning = checkedGit(await readGit(engine));
    if (afterPlanning.digest !== currentGit.digest)
      pending.add('Git changed during final planning');
  } catch {
    pending.add('Fresh Git and configured coverage reconciliation did not complete');
  }
  let current = sourceManifest(options.root, currentInventory, currentGit.head);
  try {
    admitSourceInputs(current, currentGit, options.admittedUntracked);
    const finalGit = checkedGit(await readGit(engine));
    if (finalGit.digest !== currentGit.digest)
      pending.add('Git changed during final source capture');
    // An already-dirty file can change again without changing any Git path/index fact.
    const finalSource = sourceManifest(options.root, currentInventory, currentGit.head);
    if (finalSource.digest !== current.digest)
      pending.add('Source changed during final Git capture');
    current = finalSource;
    admitSourceInputs(current, currentGit, options.admittedUntracked);
  } catch {
    pending.add('Current source admission did not complete');
  }
  unchangedEngine(state);
  return { pending: [...pending].sort(), current, currentGit };
}

/**
 * Every check passed for unchanged source and Git, and nothing is outstanding except
 * qualifications the captured plan itself declares. Those withhold a batch's admission; they
 * do not make its passes any less real.
 */
export function passedWithDeclaredQualifications(
  prepared: PreparedVerification,
  result: VerificationResult,
): boolean {
  const declared = new Set(preparation(prepared).plan.pendingQualifications);
  return (
    result.snapshotAccepted &&
    result.changedInputs.length === 0 &&
    result.evidence.context.git.digest === result.evidence.context.currentGit.digest &&
    result.pendingLiveChecks.every((name) => declared.has(name))
  );
}

/** Final reporting may await callers; reuse current-tree reconciliation before completion. */
export function validateCompletedVerification(prepared: PreparedVerification): Promise<void> {
  return validateCompleted(prepared, new Set());
}

/** As above for a run that passed with declared qualifications outstanding. */
export function validatePassedVerification(prepared: PreparedVerification): Promise<void> {
  return validateCompleted(prepared, new Set(preparation(prepared).plan.pendingQualifications));
}

async function validateCompleted(
  prepared: PreparedVerification,
  declared: ReadonlySet<string>,
): Promise<void> {
  const state = preparation(prepared);
  if (state.status !== 'consumed') throw new Error('A completed owned preparation is required');
  const copiedUnchanged = () => {
    if (
      sourceManifest(state.frozenRoot, state.inventory, state.git.head).digest !==
      state.snapshot.digest
    )
      throw new Error('Copied source changed before controller completion');
  };
  copiedUnchanged();
  const { pending, current, currentGit } = await reconcileCurrent(state);
  copiedUnchanged();
  if (
    pending.some((name) => !declared.has(name)) ||
    current.digest !== state.snapshot.digest ||
    currentGit.digest !== state.git.digest
  )
    throw new Error('Current source, Git or configured plan changed before controller completion');
}

/** Server shutdown is awaited after final planning; verify source custody without starting it again. */
export async function validateCompletedVerificationSources(
  prepared: PreparedVerification,
): Promise<void> {
  const state = preparation(prepared);
  if (state.status !== 'consumed') throw new Error('A completed owned preparation is required');
  unchangedEngine(state);
  const before = checkedGit(await readGit(state.engine));
  if (before.digest !== state.git.digest)
    throw new Error('Git changed during private engine shutdown');
  for (const root of [state.options.root, state.frozenRoot]) {
    const current = sourceManifest(root, state.inventory, state.git.head);
    if (current.digest !== state.snapshot.digest)
      throw new Error('Source changed during private engine shutdown');
  }
  const after = checkedGit(await readGit(state.engine));
  if (after.digest !== before.digest)
    throw new Error('Git changed during shutdown source reconciliation');
  for (const root of [state.options.root, state.frozenRoot])
    if (sourceManifest(root, state.inventory, state.git.head).digest !== state.snapshot.digest)
      throw new Error('Source changed during shutdown Git capture');
  unchangedEngine(state);
}

async function executeAndReconcile(
  prepared: PreparedVerification,
  state: PreparationState,
): Promise<VerificationResult> {
  const { options, engine, git, plan, inventory, snapshot, frozenRoot, executionSource } = state;
  const { invocation } = prepared.expectation;
  const result = await engine.execute({
    root: frozenRoot,
    invocation,
    required: plan.coverage.required,
    git,
    source: executionSource,
  });
  unchangedEngine(state);
  if (sourceManifest(frozenRoot, inventory, git.head).digest !== snapshot.digest)
    throw new Error('Copied source changed during snapshot execution');
  const { pending, current, currentGit } = await reconcileCurrent(state);
  const evidence: VerificationEvidence = {
    invocation,
    expectedBuildToolVersion: state.version,
    platform: state.platform,
    snapshot,
    current,
    buildEvents: sanitizeBuildEvents(result.events),
    required: plan.coverage.required,
    processExitCode: result.exitCode,
    pendingLiveChecks: pending,
    context: {
      git,
      currentGit,
      configuredDigest: plan.contextDigest,
      admittedUntracked: options.admittedUntracked,
    },
  };
  unchangedEngine(state);
  const report = verificationReport(evidence);
  return immutable({ ...report, evidence });
}

/** Single-platform entry point uses the same owned preparation/publication lifecycle. */
export async function verifySnapshot(
  options: VerificationPreparationOptions & {
    readonly publishExpectation: (
      context: VerificationExpectation,
      prepared: PreparedVerification,
    ) => unknown | Promise<unknown>;
  },
  engine: FrontEndEngine,
): Promise<VerificationResult> {
  const prepared = await prepareVerification(options, engine);
  await publishVerificationExpectations([prepared], async (contexts) => {
    const expected = contexts[0];
    if (expected === undefined) throw new Error('Prepared expectation is absent');
    return await options.publishExpectation(expected, prepared);
  });
  return executePreparedVerification(prepared);
}
