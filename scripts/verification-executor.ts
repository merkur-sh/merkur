import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { type Command, cachedBunLane, type GatePlan } from './select-gates';
import { testCommand } from './test-inventory';
import { planPartition, recordGreen, type TestPartition } from './verification-cache';
import { cargoTestBuild, cargoTestExecutions, cargoTestSelection } from './verification-cargo';
import { greenTestFiles } from './verification-junit';

const ROOT = path.resolve(import.meta.dir, '..');

/** Concurrent Cargo test binaries; libtest threads each one across the host's cores. */
const CARGO_TEST_WORKERS = 4;

/**
 * Per-file durations from earlier runs, so Bun starts the slowest files first and one long file
 * is never left running alone at the end. They change only the order files start in.
 */
const TEST_TIMINGS = path.join(ROOT, 'test-results', 'verification', 'test-timings.json');

/** The one shape `bun test --timings` accepts; anything else makes it refuse to start. */
function bunTimings(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (!('version' in value) || value.version !== 1) return false;
  if (!('files' in value) || typeof value.files !== 'object' || value.files === null) return false;
  return Object.values(value.files).every((ms) => typeof ms === 'number' && Number.isFinite(ms));
}

/**
 * This run's own copy of the durations. Concurrent runs share the published file, and Bun
 * refuses a half-written one, so a run reads a copy and publishes its update by rename. A missing
 * or unusable file starts the run without one; Bun then writes it fresh.
 */
export function stageTestTimings(directory: string, published = TEST_TIMINGS): string {
  const staged = path.join(directory, 'test-timings.json');
  try {
    const text = readFileSync(published, 'utf8');
    if (bunTimings(JSON.parse(text))) writeFileSync(staged, text);
  } catch {
    // Nothing usable published yet: this run measures every file it runs.
  }
  return staged;
}

interface TaskResult {
  readonly command: Command;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly log: string;
  readonly signal: NodeJS.Signals | null;
}

/** Every runner uses these descriptors; no child inherits a consumed stdin pipe. */
export async function runVerificationCommand(
  command: Command,
  logPath: string,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  options: { readonly cwd?: string; readonly stdoutPath?: string } = {},
): Promise<TaskResult> {
  signal?.throwIfAborted();
  const started = performance.now();
  const label =
    command[0] === 'bun' && command[1] === 'test'
      ? `bun test (${command.filter((arg) => arg.startsWith('./')).length} files)`
      : command.join(' ');
  process.stdout.write(`[start] ${label}\n`);
  const executable = command[0];
  if (executable === undefined) throw new Error('Empty verification command');
  const log = openSync(logPath, 'w');
  const stdout = options.stdoutPath === undefined ? undefined : openSync(options.stdoutPath, 'w');
  const child = spawn(executable === 'bun' ? process.execPath : executable, command.slice(1), {
    cwd: options.cwd ?? ROOT,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const interrupt = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  };
  signal?.addEventListener('abort', interrupt, { once: true });
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  child.stdout.on('data', (data: Buffer) => {
    writeSync(log, data);
    if (stdout === undefined) process.stdout.write(data);
    else writeSync(stdout, data);
  });
  child.stderr.on('data', (data: Buffer) => {
    writeSync(log, data);
    process.stderr.write(data);
  });
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  const status = await new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal })),
  );
  const exitCode = status.code;
  signal?.removeEventListener('abort', interrupt);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  if (spawnError !== undefined) {
    writeSync(log, `${spawnError.message}\n`);
    process.stderr.write(`${label}: ${spawnError.message}\n`);
  }
  closeSync(log);
  if (stdout !== undefined) closeSync(stdout);
  const durationMs = performance.now() - started;
  process.stdout.write(
    `[${exitCode === 0 ? 'pass' : 'FAIL'}] ${label} ${(durationMs / 1000).toFixed(2)}s — ${logPath}\n`,
  );
  return { command, exitCode, durationMs, log: logPath, signal: status.signal };
}

/**
 * Run a plan, skipping the test files the result cache already proves green for exactly the
 * bytes they read. `cache` comes precomputed from `gates`, which needed it to print the plan;
 * the other entry points let it be derived here. Only the bun lane is cached: the static
 * gates are the correctness floor and cost seconds, Cargo owns its own incremental state,
 * and the browser harnesses depend on a live environment no content key can see.
 */
export async function executePlan(
  plan: GatePlan,
  all = false,
  cache?: TestPartition,
): Promise<number> {
  const parent = path.join(ROOT, 'test-results', 'verification');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'run-'));
  const partition = cache ?? planPartition(ROOT, plan);
  const bunLane = cachedBunLane(plan, partition.fresh);
  if (partition.cached.length > 0) {
    process.stdout.write(
      `[cache] ${partition.cached.length} test file${partition.cached.length === 1 ? '' : 's'} already green for these inputs; ${partition.fresh.length} to run\n`,
    );
  }
  const results: TaskResult[] = [];
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
  };
  const outstanding = new Set(
    [
      ...plan.builds,
      ...plan.preflight,
      ...plan.static,
      ...plan.cargo,
      ...bunLane,
      ...plan.deferred,
    ].map((command) => command.join(' ')),
  );
  let next = 0;
  let proven: string[] = [];
  const testLane =
    partition.fresh.length === 0 ? undefined : testCommand(partition.fresh).join(' ');
  const run = async (
    command: Command,
    options: {
      readonly cwd?: string;
      readonly stdoutPath?: string;
      readonly environment?: NodeJS.ProcessEnv;
    } = {},
  ) => {
    if (interrupted) return 130;
    const taskNumber = ++next;
    const taskEnvironment = {
      ...(options.environment ?? environment),
      PW_E2E_OUTPUT_DIR: path.join(directory, `${taskNumber}-browser`),
    };
    const isTestLane = command.join(' ') === testLane;
    const junit = path.join(directory, `${taskNumber}-junit.xml`);
    const timings = isTestLane ? stageTestTimings(directory) : undefined;
    const executed = isTestLane
      ? [
          ...command,
          '--reporter=junit',
          `--reporter-outfile=${junit}`,
          `--timings=${timings}`,
          '--update-timings',
        ]
      : command;
    if (isTestLane) recordGreen(ROOT, [], partition.keys, partition.fresh);
    const rawResult = await runVerificationCommand(
      executed,
      path.join(directory, `${taskNumber}.log`),
      command[0] === 'bun' && command[1] === 'test'
        ? { ...taskEnvironment, LOG_LEVEL: 'silent' }
        : taskEnvironment,
      undefined,
      options,
    );
    const result = { ...rawResult, command };
    if (isTestLane && !interrupted && result.signal === null && existsSync(junit)) {
      proven = greenTestFiles(readFileSync(junit, 'utf8'), ROOT, partition.fresh);
      recordGreen(ROOT, proven, partition.keys);
    }
    if (timings !== undefined && !interrupted && result.signal === null && existsSync(timings)) {
      renameSync(timings, TEST_TIMINGS);
    }
    results.push(result);
    if (result.exitCode === 0) outstanding.delete(command.join(' '));
    process.stdout.write(
      `[progress] ${results.length} tasks finished; ${outstanding.size} required checks outstanding\n`,
    );
    return result.exitCode;
  };
  const serial = async (commands: readonly Command[], prerequisite: boolean) => {
    for (const command of commands) {
      if (interrupted) return false;
      if ((await run(command)) !== 0 && prerequisite) return false;
    }
    return true;
  };
  // `rust:lint` compiles in its own target directory, so Clippy and the other Cargo checks no
  // longer queue on the test build's directory lock: they run beside it.
  const cargoLane = () =>
    Promise.all([
      serial(
        plan.cargo.filter((command) => cargoTestSelection(command) === undefined),
        false,
      ),
      cargoTests(),
    ]);
  const cargoTests = async () => {
    const build = cargoTestBuild(plan.cargo);
    if (build === undefined || interrupted) return;
    const stdoutPath = path.join(directory, 'cargo-artifacts.jsonl');
    outstanding.add(build.join(' '));
    if ((await run(build, { stdoutPath })) !== 0) return;
    const executions = cargoTestExecutions(
      readFileSync(stdoutPath, 'utf8'),
      plan.cargo,
      ROOT,
      environment,
    );
    // Test binaries are independent processes, so they run side by side. Each one's
    // stdout goes to its own file and is printed whole if it fails, never interleaved.
    const queue = [...executions].flatMap(([selection, tasks]) =>
      tasks.map((task) => ({ selection, task })),
    );
    for (const { task } of queue) outstanding.add(task.command.join(' '));
    const failedSelections = new Set<Command>();
    let queued = 0;
    const worker = async () => {
      while (!interrupted && queued < queue.length) {
        const index = queued++;
        const item = queue[index];
        if (item === undefined) return;
        const output = path.join(directory, `cargo-test-${index}.out`);
        if ((await run(item.task.command, { ...item.task, stdoutPath: output })) !== 0) {
          failedSelections.add(item.selection);
          process.stdout.write(readFileSync(output, 'utf8'));
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CARGO_TEST_WORKERS, queue.length) }, () => worker()),
    );
    if (interrupted) return;
    for (const selection of executions.keys()) {
      if (!failedSelections.has(selection)) outstanding.delete(selection.join(' '));
    }
  };
  let ready = await serial(plan.builds, true);
  if (ready) ready = await serial(plan.preflight, true);
  if (ready) {
    await Promise.all(plan.static.map((command) => run(command)));
    await Promise.all([cargoLane(), serial(bunLane, false)]);
  }
  const pending = new Set(plan.deferred.map((command) => command.join(' ')));
  if (all && ready && results.every((result) => result.exitCode === 0)) {
    for (const command of plan.deferred) {
      if (interrupted) break;
      await run(command);
      pending.delete(command.join(' '));
    }
  }
  for (const name of pending) process.stdout.write(`[pending required] ${name}\n`);
  const failed = interrupted || results.some((result) => result.exitCode !== 0);
  const report = {
    files: plan.files,
    reasons: plan.reasons,
    cache: {
      cached: partition.cached,
      fresh: partition.fresh,
      unclaimed: partition.unclaimed,
      proven,
    },
    results,
    pending: [...pending],
    outstanding: [...outstanding],
    prerequisitesComplete: ready,
    interrupted,
    complete: ready && !failed && pending.size === 0,
  };
  writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `[verification] ${failed ? 'FAILED' : pending.size > 0 ? 'selected checks passed; required evidence pending' : 'complete'} — ${directory}/report.json\n`,
  );
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  return interrupted ? 130 : failed ? 1 : 0;
}
