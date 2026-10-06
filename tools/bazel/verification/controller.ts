import { type RequiredCheck, readBuildEvents } from './events';
import {
  executePreparedVerification,
  type FrontEndEngine,
  type PreparedVerification,
  passedWithDeclaredQualifications,
  prepareVerification,
  publishVerificationExpectations,
  rejectPreparedVerification,
  type VerificationExpectation,
  type VerificationPreparationOptions,
  type VerificationResult,
  validateCompletedVerification,
  validateCompletedVerificationSources,
  validatePassedVerification,
  writeVerificationExpectations,
} from './front-end';
import { type VerificationEvidence, verificationReport } from './report';
import { type ReportOutput, verifyReportOutput } from './report-output';
import {
  admitTestReservation,
  initializeTestInventory,
  type LedgerSnapshot,
  passedTests,
  type RevocationStore,
  rejectTestReservation,
  reserveTests,
  type TestAdmissionExpectation,
  type TestReservation,
} from './revocation';
import { timedAsync } from './stages';

/** Each selected test with the nonce of its epoch, in label order. */
export type TestEpochs = readonly (readonly [string, string])[];

/** One engine's part of a batch that passed: what it expected and the evidence it produced. */
export interface RecordedPass {
  readonly expectation: VerificationExpectation;
  readonly evidence: VerificationEvidence;
}

export interface ControllerEngine extends FrontEndEngine {
  completeTestInventory(): Promise<readonly string[]>;
  bindTestReservation(reservation: TestReservation): void;
  selectedChecks(): Promise<readonly RequiredCheck[]>;
  testConfigurations(): ReadonlyMap<string, string>;
}

/** Where a batch's passes are kept between runs: one entry for each attempt, in order. */
export interface PassRecords {
  /** The pass each engine recorded for exactly its current source, Git facts and these epochs. */
  recorded(epochs: TestEpochs): Promise<readonly (RecordedPass | undefined)[]>;
  /** Keep `passes` as the answer for exactly the current source, Git facts and these epochs. */
  record(epochs: TestEpochs, passes: readonly RecordedPass[]): Promise<void>;
}

export interface ControllerAttempt {
  readonly options: VerificationPreparationOptions;
  readonly engine: ControllerEngine;
}

export interface ControllerResult {
  readonly admitted: boolean;
  /** No engine ran: these are the results of the pass recorded for the same inputs. */
  readonly recorded: boolean;
  readonly results: readonly VerificationResult[];
  readonly problems: readonly string[];
}

const UNQUALIFIED =
  'Declared qualifications are outstanding: the passes are reusable, the batch is not admitted';

interface CapturedBatch {
  readonly expectations: readonly VerificationExpectation[];
  readonly store: RevocationStore;
  readonly nonces: ReadonlyMap<string, string>;
}

const capturedBatches = new WeakMap<ControllerResult, CapturedBatch>();

/** Consumers reuse the controller's actual published batch, never a second expected JSON. */
export function controllerExpectations(
  result: ControllerResult,
): readonly VerificationExpectation[] {
  const captured = capturedBatches.get(result);
  if (captured === undefined) throw new Error('An owned published controller result is required');
  if (result.admitted) {
    const current = captured.store.read();
    for (const [label, nonce] of captured.nonces) {
      const epoch = current.ledger[label];
      if (epoch?.state !== 'ready' || epoch.nonce !== nonce)
        throw new Error('A newer revocation superseded this controller admission');
    }
  }
  return captured.expectations;
}

function completedBatch(
  admitted: boolean,
  results: readonly VerificationResult[],
  problems: readonly string[],
  prepared: readonly PreparedVerification[],
  store: RevocationStore,
  reservation: TestReservation,
): ControllerResult {
  const result = Object.freeze({
    admitted,
    recorded: false,
    results: Object.freeze([...results]),
    problems: Object.freeze([...problems]),
  });
  capturedBatches.set(result, {
    expectations: Object.freeze(prepared.map((item) => item.expectation)),
    store,
    nonces: new Map(
      reservation.labels.map((label) => {
        const epoch = reservation.snapshot.ledger[label];
        if (epoch === undefined) throw new Error('Missing captured test epoch');
        return [label, epoch.nonce];
      }),
    ),
  });
  return result;
}

/**
 * The batch every engine recorded for exactly these checks and epochs, when each of them holds
 * one and its evidence still states a complete pass of unchanged source.
 */
async function recordedBatch(
  records: PassRecords,
  attempts: readonly ControllerAttempt[],
  selections: readonly (readonly RequiredCheck[])[],
  epochs: TestEpochs,
): Promise<
  | {
      readonly expectations: readonly VerificationExpectation[];
      readonly results: readonly VerificationResult[];
    }
  | undefined
> {
  const passes = await records.recorded(epochs);
  if (passes.length !== attempts.length) return undefined;
  const expectations: VerificationExpectation[] = [];
  const results: VerificationResult[] = [];
  for (const [index, pass] of passes.entries()) {
    if (
      pass === undefined ||
      pass.expectation.platform !== attempts[index]?.engine.platform ||
      pass.expectation.sourceDigest !== pass.evidence.snapshot.digest ||
      JSON.stringify(pass.expectation.required) !== JSON.stringify(selections[index]) ||
      JSON.stringify(pass.evidence.required) !== JSON.stringify(selections[index])
    )
      return undefined;
    const report = verificationReport(pass.evidence);
    if (
      !report.snapshotAccepted ||
      report.changedInputs.length !== 0 ||
      pass.evidence.context.git.digest !== pass.evidence.context.currentGit.digest
    )
      return undefined;
    expectations.push(pass.expectation);
    results.push({ ...report, evidence: pass.evidence });
  }
  return { expectations, results };
}

/** A forced run and a check that must run afresh always execute, and their pass is not kept. */
function keptRecords(
  records: PassRecords | undefined,
  force: boolean,
  selections: readonly (readonly RequiredCheck[])[],
): PassRecords | undefined {
  return force || selections.some((checks) => checks.some((check) => check.fresh))
    ? undefined
    : records;
}

async function keepPasses(
  records: PassRecords | undefined,
  epochs: TestEpochs,
  prepared: readonly PreparedVerification[],
  results: readonly VerificationResult[],
): Promise<void> {
  await records?.record(
    epochs,
    prepared.map((item, index) => {
      const evidence = results[index]?.evidence;
      if (evidence === undefined) throw new Error('Missing completed controller result');
      return { expectation: item.expectation, evidence };
    }),
  );
}

/** The epoch `snapshot` holds for each selected test. */
function selectedEpochs(snapshot: LedgerSnapshot, labels: readonly string[]): TestEpochs {
  return labels.map((label) => {
    const epoch = snapshot.ledger[label];
    if (epoch === undefined) throw new Error('Missing captured test epoch');
    return [label, epoch.nonce];
  });
}

/**
 * This run's result when nothing has to execute: every selected epoch is one a pass was
 * admitted for, and `records` holds the record of that pass for exactly these bytes. The
 * recorded expectations and reports are published as this run's; nothing is reserved.
 */
async function recordedResult(options: {
  readonly records: PassRecords | undefined;
  readonly attempts: readonly ControllerAttempt[];
  readonly selections: readonly (readonly RequiredCheck[])[];
  readonly labels: readonly string[];
  readonly snapshot: LedgerSnapshot;
  readonly store: RevocationStore;
  readonly expectationOutputs: readonly ReportOutput[];
  readonly retainReports: (results: readonly VerificationResult[]) => void | Promise<void>;
}): Promise<ControllerResult | undefined> {
  const { records, labels, snapshot } = options;
  if (records === undefined || labels.some((label) => snapshot.ledger[label]?.state !== 'ready'))
    return undefined;
  const epochs = selectedEpochs(snapshot, labels);
  const batch = await recordedBatch(records, options.attempts, options.selections, epochs);
  if (batch === undefined) return undefined;
  const content = `${JSON.stringify(batch.expectations, null, 2)}\n`;
  for (const output of options.expectationOutputs) {
    output.write(content);
    verifyReportOutput(output);
  }
  await options.retainReports(Object.freeze([...batch.results]));
  const result = Object.freeze({
    admitted: false,
    recorded: true,
    results: Object.freeze([...batch.results]),
    problems: Object.freeze([UNQUALIFIED]),
  });
  capturedBatches.set(result, {
    expectations: Object.freeze([...batch.expectations]),
    store: options.store,
    nonces: new Map(epochs),
  });
  return result;
}

const nativePlatforms = ['darwin-arm64', 'darwin-x86_64', 'linux-arm64', 'linux-x86_64'];

/** One lifecycle owns reservation, execution, report retention and terminal nonce authority. */
export async function verifyReservedBatch(options: {
  readonly signal: AbortSignal;
  readonly attempts: readonly ControllerAttempt[];
  readonly store: RevocationStore;
  readonly force: boolean;
  readonly expectationOutputs: readonly ReportOutput[];
  readonly admissionOutputs?: readonly ReportOutput[];
  readonly retainReports: (results: readonly VerificationResult[]) => void | Promise<void>;
  readonly publishAdmission?: (result: ControllerResult) => void | Promise<void>;
  /** Release owned engine resources after final configured reconciliation, before terminal admission. */
  readonly completeExecution?: () => Promise<void>;
  /** Synchronously validate retained published artifacts after the final awaited source checks. */
  readonly validateAdmission?: (result: ControllerResult) => void;
  /** Kept passes of earlier batches; absent, every batch executes and none is kept. */
  readonly passes?: PassRecords;
}): Promise<ControllerResult> {
  const checkCancellation = AbortSignal.prototype.throwIfAborted.bind(options.signal);
  checkCancellation();
  const store = options.store;
  const force = options.force;
  const expectationOutputs = [...options.expectationOutputs];
  const admissionOutputs = [...(options.admissionOutputs ?? [])];
  if (new Set(admissionOutputs).size !== admissionOutputs.length)
    throw new Error('Admission publication requires distinct owned outputs');
  const retainReports = options.retainReports;
  const publishAdmission = options.publishAdmission;
  const validateAdmission = options.validateAdmission;
  const completeExecution = options.completeExecution;
  const attempts = options.attempts.map((attempt) => ({
    engine: attempt.engine,
    options: { ...attempt.options, admittedUntracked: [...attempt.options.admittedUntracked] },
  }));
  if (
    attempts.length === 0 ||
    new Set(attempts.map(({ engine }) => engine.platform)).size !== attempts.length ||
    attempts.some(({ engine }) => !nativePlatforms.includes(engine.platform))
  )
    throw new Error('Controller requires a nonempty unique platform batch');
  const inventory = [
    ...new Set(
      (
        await timedAsync('test inventory', () =>
          Promise.all(attempts.map(({ engine }) => engine.completeTestInventory())),
        )
      ).flat(),
    ),
  ].sort();
  checkCancellation();
  const initial = initializeTestInventory(store, inventory);
  const initialReservation: TestReservation = {
    snapshot: initial,
    labels: inventory,
    fresh: inventory.filter((label) => initial.ledger[label]?.state === 'pending'),
  };
  for (const { engine } of attempts) engine.bindTestReservation(initialReservation);
  const selections = (
    await timedAsync('select checks', () =>
      Promise.all(attempts.map(({ engine }) => engine.selectedChecks())),
    )
  ).map((checks) => checks.map((check) => Object.freeze({ ...check })));
  const labels = [
    ...new Set(
      selections.flatMap((checks) =>
        checks.filter((check) => check.kind === 'test').map((check) => check.label),
      ),
    ),
  ].sort();
  const fresh = [
    ...new Set(
      selections.flatMap((checks) =>
        checks.filter((check) => check.kind === 'test' && check.fresh).map((check) => check.label),
      ),
    ),
  ].sort();
  checkCancellation();
  const records = keptRecords(options.passes, force, selections);
  const recorded = await timedAsync('recorded pass', () =>
    recordedResult({
      records,
      attempts,
      selections,
      labels,
      snapshot: initial,
      store,
      expectationOutputs,
      retainReports,
    }),
  );
  checkCancellation();
  if (recorded !== undefined) return recorded;
  const reservation = reserveTests(store, labels, force, fresh, initial);
  const prepared: PreparedVerification[] = [];
  const configurations: ReadonlyMap<string, string>[] = [];
  const results: VerificationResult[] = [];
  const problems: string[] = [];
  let admitted = false;
  let reusable = false;
  let reported = false;
  let held: readonly string[] = [];
  const expectations = (): TestAdmissionExpectation[] =>
    prepared.map((item, index) => {
      const configured = configurations[index];
      if (configured === undefined) throw new Error('Missing captured controller configuration');
      return {
        platform: item.expectation.platform as TestAdmissionExpectation['platform'],
        invocation: item.expectation.invocation,
        required: item.expectation.required,
        configurations: configured,
      };
    });
  try {
    checkCancellation();
    for (const { engine } of attempts) engine.bindTestReservation(reservation);
    // Serial capture permits rejection of every completed preparation if a later one fails.
    for (let index = 0; index < attempts.length; index++) {
      checkCancellation();
      const attempt = attempts[index];
      const selected = selections[index];
      if (attempt === undefined || selected === undefined)
        throw new Error('Missing controller selection');
      const item = await timedAsync('prepare', () =>
        prepareVerification(attempt.options, attempt.engine),
      );
      prepared.push(item);
      checkCancellation();
      configurations.push(new Map(attempt.engine.testConfigurations()));
      if (JSON.stringify(item.expectation.required) !== JSON.stringify(selected))
        throw new Error('Required coverage changed after nonce reservation');
    }
    const identities = prepared.map(({ expectation }) =>
      JSON.stringify({
        base: expectation.base,
        candidate: expectation.candidate,
        head: expectation.head,
        git: expectation.gitDigest,
        source: expectation.sourceDigest,
      }),
    );
    if (new Set(identities).size !== 1)
      throw new Error(
        'Controller platforms must verify the same captured source and Git candidate',
      );
    await publishVerificationExpectations(prepared, () =>
      writeVerificationExpectations(prepared, expectationOutputs),
    );
    checkCancellation();
    // A rejected sibling never causes retirement while another engine is still running.
    const completed = await timedAsync('execute', () =>
      Promise.allSettled(prepared.map(executePreparedVerification)),
    );
    for (const outcome of completed) {
      if (outcome.status === 'fulfilled') results.push(outcome.value);
      else
        problems.push(
          outcome.reason instanceof Error ? outcome.reason.message : 'Engine execution failed',
        );
    }
    reported = problems.length === 0;
    await retainReports(Object.freeze([...results]));
    checkCancellation();
    const passed = (result: VerificationResult, index: number) => {
      const item = prepared[index];
      return (
        result.currentAccepted ||
        (item !== undefined && passedWithDeclaredQualifications(item, result))
      );
    };
    if (problems.length !== 0 || !results.every(passed)) {
      // Consistent, complete reports state which tests passed. Those passes stand whatever
      // their siblings did; an engine that failed or disagreed with itself states nothing.
      if (reported && results.every((result) => result.problems.length === 0))
        held = passedTests(
          reservation,
          expectations(),
          results.map((result) => ({
            events: result.events,
            processExitCode: result.evidence.processExitCode,
          })),
        );
      problems.push('Every complete current-source report must pass before nonce admission');
      return completedBatch(admitted, results, problems, prepared, store, reservation);
    }
    // Outstanding declared qualifications withhold the batch's admission, never its passes:
    // the epochs of a fully passing run become reusable either way.
    const qualified = results.every((result) => result.currentAccepted);
    await timedAsync('validate', () =>
      Promise.all(
        prepared.map(qualified ? validateCompletedVerification : validatePassedVerification),
      ),
    );
    checkCancellation();
    const expected = expectations();
    await completeExecution?.();
    if (completeExecution !== undefined)
      await Promise.all(prepared.map(validateCompletedVerificationSources));
    checkCancellation();
    admitTestReservation(
      store,
      reservation,
      expected,
      results.map((result) => ({
        events: readBuildEvents(result.evidence.buildEvents, result.evidence.required),
        processExitCode: result.evidence.processExitCode,
      })),
    );
    checkCancellation();
    if (!qualified) {
      reusable = true;
      await timedAsync('keep pass', () =>
        keepPasses(records, selectedEpochs(reservation.snapshot, labels), prepared, results),
      );
      problems.push(UNQUALIFIED);
      return completedBatch(admitted, results, problems, prepared, store, reservation);
    }
    const result = completedBatch(true, results, problems, prepared, store, reservation);
    // Caller report publication is part of this attempt: a failed write or cancellation
    // retires its promoted nonce through the same terminal boundary as execution failures.
    await publishAdmission?.(result);
    if (publishAdmission !== undefined)
      await Promise.all(
        prepared.map(
          completeExecution === undefined
            ? validateCompletedVerification
            : validateCompletedVerificationSources,
        ),
      );
    checkCancellation();
    controllerExpectations(result);
    for (const output of [...expectationOutputs, ...admissionOutputs]) verifyReportOutput(output);
    validateAdmission?.(result);
    admitted = true;
    return result;
  } finally {
    if (!admitted) {
      for (const item of prepared) rejectPreparedVerification(item);
      if (!reusable) rejectTestReservation(store, reservation, held);
    }
  }
}
