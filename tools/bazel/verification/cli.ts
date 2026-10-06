import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type OwnedDirectory, openOwnedDirectory } from '../bun/owned-files';
import { reconstructControllerCiReport } from '../packaging/ci-admission';
import { stageCiArtifacts } from '../packaging/ci-artifact-staging';
import { bindControllerCiArtifacts } from '../packaging/ci-preparation';
import { stageReleaseArtifacts } from '../packaging/release-staging';
import { readDeclaredInput } from './artifacts';
import { BazelVerificationEngine } from './bazel-engine';
import {
  type ControllerResult,
  controllerExpectations,
  type PassRecords,
  verifyReservedBatch,
} from './controller';
import { engineHome, holdEngineHome } from './engine-home';
import { type DeclaredEngineTools, declaredGitSdkEnvironment } from './engine-process';
import { NATIVE_EXECUTION_PLATFORMS, parseExecutorPolicy } from './executor-policy';
import { verifyNativePlatformBatch } from './platform-qualification';
import {
  openReportOutput,
  type ReportOutput,
  reportOutputPublished,
  retireReportOutput,
} from './report-output';
import { stageTimes, timedAsync } from './stages';
import { EXTENDED_SUITES } from './workflow-selection';

export interface VerificationArguments {
  readonly all: boolean;
  readonly unit?: boolean;
  readonly staged?: boolean;
  readonly unsigned?: boolean;
  readonly force: boolean;
  readonly help: boolean;
  readonly base?: string;
  readonly candidate?: string;
  readonly admitFile?: string;
  readonly reportFile?: string;
  readonly ciReportFile?: string;
  readonly expectedContextFile?: string;
  readonly ledgerClient?: string;
  readonly credentialFile?: string;
  readonly unsignedOutputDirectory?: string;
  readonly nativePlatforms?: boolean;
  readonly executorPolicyFile?: string;
  readonly qualifyExecution?: boolean;
  readonly assuranceEvent?: string;
  readonly extendedSuite?: string;
  readonly extendedSuites?: boolean;
}

function validateWorkflowArguments(
  flags: ReadonlySet<string>,
  values: ReadonlyMap<string, string>,
): void {
  const assuranceEvent = values.get('--assurance-event');
  if (
    assuranceEvent !== undefined &&
    (!['pull_request', 'push', 'schedule', 'workflow_dispatch'].includes(assuranceEvent) ||
      !flags.has('--all') ||
      !values.has('--ci-report-file'))
  )
    throw new Error(
      'Assurance event requires a supported workflow event, --all and --ci-report-file',
    );
  if (
    flags.has('--extended-suites') &&
    (!flags.has('--all') ||
      !flags.has('--force') ||
      !values.has('--ci-report-file') ||
      flags.has('--unsigned') ||
      flags.has('--native-platforms') ||
      values.has('--extended-suite') ||
      values.has('--assurance-event'))
  )
    throw new Error(
      'Extended suites require --all, --force and --ci-report-file without another workflow',
    );
  const extendedSuite = values.get('--extended-suite');
  if (
    extendedSuite !== undefined &&
    (!EXTENDED_SUITES.includes(extendedSuite) ||
      !flags.has('--all') ||
      !flags.has('--force') ||
      !values.has('--ci-report-file') ||
      flags.has('--unsigned') ||
      flags.has('--native-platforms') ||
      values.has('--assurance-event'))
  )
    throw new Error(
      'Extended suite requires a supported operation, --all, --force and --ci-report-file without another workflow',
    );
}

function validateVerificationArguments(
  flags: ReadonlySet<string>,
  values: ReadonlyMap<string, string>,
): void {
  if (
    flags.has('--unit') &&
    ([
      '--all',
      '--changed',
      '--staged',
      '--unsigned',
      '--native-platforms',
      '--extended-suites',
    ].some((flag) => flags.has(flag)) ||
      ['--assurance-event', '--extended-suite'].some((name) => values.has(name)))
  )
    throw new Error('Unit verification requires its complete configured source inventory only');
  if (flags.has('--all') && flags.has('--changed')) throw new Error('Choose --changed or --all');
  if (
    flags.has('--unsigned') &&
    (!flags.has('--all') ||
      !values.has('--ci-report-file') ||
      !values.has('--unsigned-output-directory'))
  )
    throw new Error(
      'Unsigned producer binding requires --all, --ci-report-file and --unsigned-output-directory',
    );
  if (values.has('--unsigned-output-directory') && !flags.has('--unsigned'))
    throw new Error('Unsigned output directory requires --unsigned');
  if (
    flags.has('--native-platforms') &&
    (!flags.has('--all') || !values.has('--executor-policy-file'))
  )
    throw new Error('The complete native platform batch requires --all and --executor-policy-file');
  if (values.has('--executor-policy-file') && !flags.has('--native-platforms'))
    throw new Error('Executor policy requires the complete native platform batch');
  validateWorkflowArguments(flags, values);
  if (flags.has('--qualify-execution') && !flags.has('--native-platforms'))
    throw new Error('Execution qualification requires the complete native platform batch');
  if (
    flags.has('--staged') &&
    (flags.has('--all') ||
      flags.has('--changed') ||
      ['--base', '--candidate', '--admit-file'].some((name) => values.has(name)))
  )
    throw new Error('Staged verification uses only the exact index and its HEAD');
  for (const name of ['--base', '--candidate']) {
    const identity = values.get(name);
    if (identity !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(identity))
      throw new Error('Explicit Git identities must be full immutable hashes');
  }
  for (const name of [
    '--admit-file',
    '--report-file',
    '--ci-report-file',
    '--expected-context-file',
    '--ledger-client',
    '--credential-file',
    '--unsigned-output-directory',
    '--executor-policy-file',
  ]) {
    const file = values.get(name);
    if (file !== undefined && !path.isAbsolute(file))
      throw new Error('Admission and report paths must be absolute');
  }
  const outputFiles = ['--report-file', '--expected-context-file', '--ci-report-file']
    .map((name) => values.get(name))
    .filter((file): file is string => file !== undefined)
    .map((file) => path.resolve(file));
  if (new Set(outputFiles).size !== outputFiles.length)
    throw new Error('Report, CI report and expected context require distinct output Files');
}

export function verificationArguments(args: readonly string[]): VerificationArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === undefined) throw new Error('Missing verification argument');
    if (
      [
        '--all',
        '--unit',
        '--changed',
        '--staged',
        '--force',
        '--help',
        '--unsigned',
        '--native-platforms',
        '--qualify-execution',
        '--extended-suites',
      ].includes(argument)
    ) {
      if (flags.has(argument)) throw new Error(`Duplicate verification argument: ${argument}`);
      flags.add(argument);
    } else if (
      [
        '--base',
        '--candidate',
        '--admit-file',
        '--report-file',
        '--ci-report-file',
        '--expected-context-file',
        '--ledger-client',
        '--credential-file',
        '--unsigned-output-directory',
        '--executor-policy-file',
        '--assurance-event',
        '--extended-suite',
      ].includes(argument)
    ) {
      const value = args[++index];
      if (value === undefined || value.startsWith('--') || values.has(argument))
        throw new Error(`Missing or duplicate verification value: ${argument}`);
      values.set(argument, value);
    } else throw new Error(`Unknown verification argument: ${argument}`);
  }
  validateVerificationArguments(flags, values);
  const assuranceEvent = values.get('--assurance-event');
  return {
    all: flags.has('--all'),
    ...(flags.has('--unit') ? { unit: true } : {}),
    ...(flags.has('--staged') ? { staged: true } : {}),
    ...(flags.has('--unsigned') ? { unsigned: true } : {}),
    ...(flags.has('--native-platforms') ? { nativePlatforms: true } : {}),
    ...(flags.has('--qualify-execution') ? { qualifyExecution: true } : {}),
    ...(values.has('--unsigned-output-directory')
      ? { unsignedOutputDirectory: values.get('--unsigned-output-directory') }
      : {}),
    ...(values.has('--executor-policy-file')
      ? { executorPolicyFile: values.get('--executor-policy-file') }
      : {}),
    ...(assuranceEvent === undefined ? {} : { assuranceEvent }),
    ...(values.has('--extended-suite') ? { extendedSuite: values.get('--extended-suite') } : {}),
    ...(flags.has('--extended-suites') ? { extendedSuites: true } : {}),
    force: flags.has('--force'),
    help: flags.has('--help'),
    ...(values.has('--base') ? { base: values.get('--base') } : {}),
    ...(values.has('--candidate') ? { candidate: values.get('--candidate') } : {}),
    ...(values.has('--admit-file') ? { admitFile: values.get('--admit-file') } : {}),
    ...(values.has('--report-file') ? { reportFile: values.get('--report-file') } : {}),
    ...(values.has('--ci-report-file') ? { ciReportFile: values.get('--ci-report-file') } : {}),
    ...(values.has('--ledger-client') ? { ledgerClient: values.get('--ledger-client') } : {}),
    ...(values.has('--credential-file') ? { credentialFile: values.get('--credential-file') } : {}),
    ...(values.has('--expected-context-file')
      ? { expectedContextFile: values.get('--expected-context-file') }
      : {}),
  };
}

export function declaredTools(credentialFile: string): DeclaredEngineTools {
  function absolute(name: string): string {
    const value = process.env[name];
    if (value === undefined || !path.isAbsolute(value))
      throw new Error(`Missing absolute declared tool: ${name}`);
    return value;
  }
  const git = absolute('MERKUR_VERIFICATION_GIT');
  const sdkEnvironment = declaredGitSdkEnvironment(absolute('MERKUR_BAZEL_NATIVE_SDK_PREFIX'), git);
  // Declared on Darwin only: the store holding the pinned Apple compiler/SDK export by digest.
  const compiler =
    process.env.MERKUR_VERIFICATION_DARWIN_COMPILER === undefined
      ? undefined
      : realpathSync(absolute('MERKUR_VERIFICATION_DARWIN_COMPILER'));
  if (compiler !== undefined && !/^[a-f0-9]{64}\.tar\.gz$/.test(path.basename(compiler)))
    throw new Error('Declared Darwin compiler export is not its digest-named store member');
  return {
    ...(compiler === undefined ? {} : { darwinCompilerStore: path.dirname(compiler) }),
    bazel: absolute('MERKUR_VERIFICATION_BAZEL'),
    acquisition: absolute('MERKUR_VERIFICATION_BAZEL_ACQUISITION'),
    git,
    credentialHelper: absolute('MERKUR_VERIFICATION_CREDENTIAL_HELPER'),
    credentialFile,
    runfiles: absolute('MERKUR_BAZEL_RUNFILES_ROOT'),
    sdkEnvironment,
  };
}

export async function admittedInputs(file: string | undefined): Promise<readonly string[]> {
  if (file === undefined) return [];
  const value: unknown = JSON.parse(
    (await readDeclaredInput(path.dirname(file), path.basename(file))).bytes.toString(),
  );
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === 'string') ||
    new Set(value).size !== value.length
  )
    throw new Error('Source admission requires an exact unique JSON list of paths');
  return value;
}

function verificationOutputFiles(options: VerificationArguments): readonly string[] {
  const outputFiles = [
    options.reportFile,
    options.expectedContextFile,
    options.ciReportFile,
  ].filter((file): file is string => file !== undefined);
  const physicalOutputs = outputFiles.map((file) =>
    path.join(realpathSync(path.dirname(file)), path.basename(file)),
  );
  if (new Set(physicalOutputs).size !== physicalOutputs.length)
    throw new Error('Report, CI report and expected context require distinct output Files');
  return outputFiles;
}

function blockedVerificationReport(options: {
  readonly error: unknown;
  readonly publication: readonly { directory: OwnedDirectory; root: string }[];
  readonly written: Set<ReportOutput>;
  readonly expectedOutput: ReportOutput;
  readonly externalExpected: ReportOutput | undefined;
  readonly resultOutput: ReportOutput;
  readonly external: ReportOutput | undefined;
  readonly externalCi: ReportOutput | undefined;
  readonly engines: readonly BazelVerificationEngine[];
  readonly directory: string;
}) {
  const {
    error,
    publication,
    written,
    expectedOutput,
    externalExpected,
    resultOutput,
    external,
    externalCi,
    engines,
    directory,
  } = options;
  const cleanupFailures: unknown[] = [];
  for (const output of publication) {
    try {
      output.directory.removeCreated();
    } catch (failure) {
      cleanupFailures.push(failure);
    }
  }
  const failure =
    cleanupFailures.length === 0
      ? error
      : new AggregateError(
          [error, ...cleanupFailures],
          'Verification failed and unsigned output cleanup failed',
        );
  for (const output of [resultOutput, external, externalCi]) {
    if (output === undefined) continue;
    try {
      retireReportOutput(output);
      written.delete(output);
    } catch {
      // A replaced caller entry is never removed or overwritten by failed-attempt cleanup.
    }
  }
  const problem = failure instanceof Error ? failure.message : 'Verification failed';
  for (const output of [expectedOutput, externalExpected]) {
    if (output !== undefined && !reportOutputPublished(output))
      output.write(`${JSON.stringify({ phase: 'blocked', problem, expectations: [] }, null, 2)}\n`);
  }
  const report = {
    currentAccepted: false,
    snapshotAccepted: false,
    phase: 'blocked',
    problem,
    pendingQualifications: [...new Set(engines.flatMap((engine) => engine.pending))],
    evidenceDirectory: directory,
    simulationDiagnostics: engines.map((engine) => engine.simulationDiagnostics()),
    elapsedMs: Math.round(performance.now()),
    stages: stageTimes(),
  };
  process.stderr.write(`Verification blocked: ${problem}; evidence ${directory}\n`);
  return report;
}

function controllerVerificationReport(
  result: ControllerResult,
  engines: readonly BazelVerificationEngine[],
  directory: string,
) {
  return {
    ...result,
    currentAccepted: result.admitted,
    snapshotAccepted:
      result.results.every((entry) => entry.snapshotAccepted) && result.results.length === 1,
    evidenceDirectory: directory,
    simulationDiagnostics: engines.map((engine) => engine.simulationDiagnostics()),
    // Where this process spent its time, apart from every verification fact above.
    elapsedMs: Math.round(performance.now()),
    stages: stageTimes(),
  };
}

function engineSelectionOptions(options: VerificationArguments) {
  return {
    ...(options.unit ? { unit: true } : {}),
    ...(options.assuranceEvent === undefined ? {} : { assuranceEvent: options.assuranceEvent }),
    ...(options.extendedSuite === undefined ? {} : { extendedSuite: options.extendedSuite }),
    ...(options.extendedSuites ? { extendedSuites: true } : {}),
    ...(options.base === undefined ? {} : { base: options.base }),
    ...(options.candidate === undefined ? {} : { candidate: options.candidate }),
  };
}

/**
 * An ordinary run keeps its engine between runs and holds its home for the run. A forced,
 * placed, qualifying or artifact-producing run is authoritative work: its engine is private
 * and discarded.
 */
function keptEngine(
  root: string,
  options: VerificationArguments,
  placed: boolean,
): {
  readonly engine: { readonly home?: string };
  readonly preparation: { readonly stable?: string };
  readonly release: () => void;
} {
  if (
    options.force ||
    placed ||
    options.unsigned ||
    options.nativePlatforms ||
    options.qualifyExecution
  )
    return { engine: {}, preparation: {}, release: () => undefined };
  const home = engineHome(root);
  return {
    engine: { home },
    preparation: { stable: path.join(home, 'workspace') },
    release: holdEngineHome(home),
  };
}

/** Each engine keeps its own part of a batch's pass; one without a home keeps nothing. */
function enginePasses(engines: readonly BazelVerificationEngine[]): PassRecords {
  return {
    recorded: (epochs) => Promise.all(engines.map((engine) => engine.recordedPass(epochs))),
    async record(epochs, passes) {
      await Promise.all(
        engines.map((engine, index) => {
          const pass = passes[index];
          if (pass === undefined) throw new Error('Missing engine pass');
          return engine.recordPass(epochs, pass);
        }),
      );
    },
  };
}

function completionLine(result: ControllerResult, directory: string): string {
  return `Verification ${result.admitted ? 'accepted' : 'unqualified'}${
    result.recorded ? ' from the recorded pass' : ''
  }; evidence ${directory}\n`;
}

export async function verificationMain(args: readonly string[]): Promise<number> {
  const options = verificationArguments(args);
  if (options.help) {
    process.stdout.write(
      'bazel run //tools:verify -- [--changed|--all|--staged|--unit] [--force] [--unsigned --unsigned-output-directory ABS_FRESH_DIR] [--native-platforms --executor-policy-file ABS_JSON] [--qualify-execution] [--assurance-event EVENT] [--extended-suite OPERATION|--extended-suites] [--base FULL_SHA] [--candidate FULL_SHA] [--admit-file ABS_JSON] [--report-file ABS_JSON] [--ci-report-file ABS_JSON] [--expected-context-file ABS_JSON] --ledger-client ABS_BARE_REPO [--credential-file ABS_BAZELRC]\n',
    );
    return 0;
  }
  const workspace = process.env.BUILD_WORKSPACE_DIRECTORY;
  if (workspace === undefined || !path.isAbsolute(workspace))
    throw new Error('Run the declared //tools:verify launcher from the workspace');
  const root = realpathSync(workspace);
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error('Verification cancelled by SIGINT'));
  const terminate = () => cancellation.abort(new Error('Verification cancelled by SIGTERM'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  let internal: ReturnType<typeof openReportOutput> | undefined;
  let internalExpected: ReturnType<typeof openReportOutput> | undefined;
  let external: ReturnType<typeof openReportOutput> | undefined;
  let externalExpected: ReturnType<typeof openReportOutput> | undefined;
  let externalCi: ReportOutput | undefined;
  const written = new Set<ReportOutput>();
  function publish(output: ReportOutput | undefined, document: string): void {
    if (output === undefined || written.has(output)) return;
    output.write(document);
    written.add(output);
  }
  try {
    const outputFiles = verificationOutputFiles(options);
    external =
      options.reportFile === undefined ? undefined : openReportOutput(options.reportFile, root);
    externalExpected =
      options.expectedContextFile === undefined
        ? undefined
        : openReportOutput(options.expectedContextFile, root);
    externalCi =
      options.ciReportFile === undefined ? undefined : openReportOutput(options.ciReportFile, root);
    // Hold caller output parents before creating the externally observable evidence directory.
    // macOS reaches its temporary directory through an alias; the engine binds physical roots.
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'merkur-verification-')));
    internal = openReportOutput(path.join(directory, 'report.json'), root);
    internalExpected = openReportOutput(path.join(directory, 'expected-context.json'), root);
    const expectedOutput = internalExpected;
    const resultOutput = internal;
    let engine: BazelVerificationEngine | undefined;
    const engines: BazelVerificationEngine[] = [];
    const diagnostics: { root: string; directory: OwnedDirectory }[] = [];
    async function closeEngines(): Promise<unknown[]> {
      const results = await Promise.allSettled(engines.map(async (engine) => engine.close()));
      return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    }
    const engineDirectories = new Map<BazelVerificationEngine, string>();
    let publication: readonly { directory: OwnedDirectory; root: string }[] = [];
    let report: unknown;
    let releaseHome: () => void = () => undefined;
    let controllerResult: ControllerResult | undefined;
    let exitCode = 1;
    try {
      let operationFailure: unknown;
      let operationFailed = false;
      try {
        if (options.ledgerClient === undefined)
          throw new Error('Verification requires an explicit authoritative bare ledger client');
        const admittedUntracked = await admittedInputs(options.admitFile);
        cancellation.signal.throwIfAborted();
        const executionPolicy =
          options.executorPolicyFile === undefined
            ? undefined
            : parseExecutorPolicy(
                JSON.parse(
                  (
                    await readDeclaredInput(
                      path.dirname(options.executorPolicyFile),
                      path.basename(options.executorPolicyFile),
                    )
                  ).bytes.toString(),
                ),
              );
        const platforms = options.nativePlatforms ? NATIVE_EXECUTION_PLATFORMS : [undefined];
        const tools = declaredTools(options.credentialFile ?? path.join(root, '.bazelrc.local'));
        const kept = keptEngine(root, options, executionPolicy !== undefined);
        releaseHome = kept.release;
        for (const platform of platforms) {
          const engineDirectory =
            platform === undefined ? directory : mkdtempSync(path.join(directory, `${platform}-`));
          const diagnosticRoot = path.join(directory, `simulation-${platform ?? 'host'}`);
          mkdirSync(diagnosticRoot);
          const retained = { root: diagnosticRoot, directory: openOwnedDirectory(diagnosticRoot) };
          diagnostics.push(retained);
          const nativeEngine = new BazelVerificationEngine({
            diagnostics: retained,
            signal: cancellation.signal,
            root,
            directory: engineDirectory,
            tools,
            admittedUntracked,
            all: options.all,
            unsigned: options.unsigned ?? false,
            completeUnsigned: options.unsigned === true && options.nativePlatforms === true,
            staged: options.staged ?? false,
            ...(platform === undefined ? {} : { platform }),
            ...(executionPolicy === undefined ? {} : { executionPolicy }),
            qualifyExecution: options.qualifyExecution ?? false,
            ...kept.engine,
            ...engineSelectionOptions(options),
          });
          engines.push(nativeEngine);
          engineDirectories.set(nativeEngine, engineDirectory);
          await timedAsync('engine initialize', () => nativeEngine.initialize());
        }
        engine = engines[0];
        if (engine === undefined) throw new Error('Verification requires an initialized engine');
        const controllerOptions: Parameters<typeof verifyReservedBatch>[0] = {
          signal: cancellation.signal,
          attempts: engines.map((engine) => {
            const engineDirectory = engineDirectories.get(engine);
            if (engineDirectory === undefined)
              throw new Error('Engine evidence directory disappeared');
            return {
              options: {
                root: engine.verificationRoot,
                destination: path.join(engineDirectory, 'snapshot'),
                ...kept.preparation,
                admittedUntracked,
              },
              engine,
            };
          }),
          store: engine.ledgerStore(options.ledgerClient),
          force: options.force,
          passes: enginePasses(engines),
          expectationOutputs:
            externalExpected === undefined ? [expectedOutput] : [expectedOutput, externalExpected],
          admissionOutputs: [resultOutput, external, externalCi].filter(
            (output): output is ReportOutput => output !== undefined,
          ),
          async publishAdmission(result) {
            const ci = externalCi === undefined ? undefined : reconstructControllerCiReport(result);
            const inputs =
              options.unsigned && result.admitted
                ? engines.map((engine) => engine.unsignedArtifactInputs())
                : undefined;
            const artifacts =
              inputs === undefined ? undefined : await bindControllerCiArtifacts(result, inputs);
            if (artifacts !== undefined && inputs !== undefined) {
              const outputRoot = options.unsignedOutputDirectory;
              if (outputRoot === undefined) throw new Error('Unsigned output directory is absent');
              const physicalParent = realpathSync(path.dirname(outputRoot));
              const physicalOutput = path.join(physicalParent, path.basename(outputRoot));
              const relative = path.relative(root, physicalOutput);
              if (
                relative === '' ||
                (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
              )
                throw new Error('Unsigned output directory must be outside the source checkout');
              for (const output of outputFiles) {
                if (output === undefined) continue;
                const physical = path.join(
                  realpathSync(path.dirname(output)),
                  path.basename(output),
                );
                const child = path.relative(physicalOutput, physical);
                if (child === '' || (!child.startsWith(`..${path.sep}`) && !path.isAbsolute(child)))
                  throw new Error('Unsigned artifacts must be separate from report output Files');
              }
              const staged = options.nativePlatforms
                ? await stageReleaseArtifacts({
                    batches: artifacts,
                    sources: inputs,
                    releaseRoot: outputRoot,
                    evidenceRoot: `${outputRoot}.evidence`,
                    assertCurrent: () => {
                      controllerExpectations(result);
                    },
                  })
                : [
                    await stageCiArtifacts({
                      batches: artifacts,
                      sources: inputs,
                      outputRoot,
                      assertCurrent: () => {
                        controllerExpectations(result);
                      },
                    }),
                  ];
              publication = staged.map((directory, index) => ({
                directory,
                root: index === 0 ? physicalOutput : `${physicalOutput}.evidence`,
              }));
            }
            controllerExpectations(result);
            const document = `${JSON.stringify(
              controllerVerificationReport(result, engines, directory),
              null,
              2,
            )}\n`;
            publish(resultOutput, document);
            publish(external, document);
            if (ci !== undefined)
              publish(
                externalCi,
                `${JSON.stringify({ ...ci, ...(artifacts === undefined ? {} : { artifacts }) }, null, 2)}\n`,
              );
          },
          async completeExecution() {
            const failures = await closeEngines();
            if (failures.length !== 0)
              throw new AggregateError(failures, 'Verification private engine cleanup failed');
          },
          validateAdmission(result) {
            controllerExpectations(result);
            for (const output of [...publication, ...diagnostics])
              output.directory.verifyCreated(output.root);
          },
          retainReports(results) {
            const executionOutput = openReportOutput(
              path.join(directory, 'execution-reports.json'),
              root,
            );
            try {
              executionOutput.write(`${JSON.stringify(results, null, 2)}\n`);
            } finally {
              executionOutput.close();
            }
          },
        };
        const result =
          options.nativePlatforms && executionPolicy !== undefined
            ? await verifyNativePlatformBatch({
                ...controllerOptions,
                executorPolicy: executionPolicy,
              })
            : await verifyReservedBatch(controllerOptions);
        controllerResult = result;
        report = controllerVerificationReport(result, engines, directory);
        exitCode = result.admitted ? 0 : 1;
      } catch (error) {
        operationFailure = error;
        operationFailed = true;
      } finally {
        const failures = await closeEngines();
        releaseHome();
        if (failures.length !== 0) {
          operationFailure = new AggregateError(
            operationFailed ? [operationFailure, ...failures] : failures,
            'Verification private engine cleanup failed',
          );
          operationFailed = true;
        }
      }
      if (operationFailed) throw operationFailure;
    } catch (error) {
      report = blockedVerificationReport({
        error,
        publication,
        written,
        expectedOutput,
        externalExpected,
        resultOutput,
        external,
        externalCi,
        engines,
        directory,
      });
    } finally {
      for (const output of [...publication, ...diagnostics]) output.directory.close();
    }
    const output = `${JSON.stringify(report, null, 2)}\n`;
    publish(internal, output);
    publish(external, output);
    publish(
      externalCi,
      `${JSON.stringify({ admitted: false, evidenceDirectory: directory, result: report }, null, 2)}\n`,
    );
    if (controllerResult !== undefined)
      process.stdout.write(completionLine(controllerResult, directory));
    return exitCode;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    internal?.close();
    internalExpected?.close();
    external?.close();
    externalExpected?.close();
    externalCi?.close();
  }
}

if (import.meta.main) process.exitCode = await verificationMain(process.argv.slice(2));
