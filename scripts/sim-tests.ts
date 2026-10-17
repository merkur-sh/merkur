/**
 * Runs Merkur's network simulator (`tools/sim`), which Bazel builds from its own crate hub
 * (`scripts/sim-workspace.ts`) with `--cfg merkur_sim`.
 *
 *   bun run test:sim                       every scenario and recorded regression
 *   bun run test:sim:sweep [count] [start] random seeds, failures into regressions.json
 *   bun run test:sim:update-lock           re-resolve tools/sim/Cargo.lock, then the hub
 */
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cargoEnvironment, root } from './generated-cargo-workspace';
import { writePathWorkspace } from './sim-workspace';

const source = path.join(root, 'tools', 'sim');
const retainedLock = path.join(source, 'Cargo.lock');

async function exec(
  command: string[],
  env: Record<string, string> = {},
  cwd = root,
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(' ')} failed (${code})`);
}

/**
 * Re-resolves the simulator's own dependencies, seeded from the release lock so every crate a
 * shipped build links keeps its version, then regenerates the hub's workspace from it.
 */
async function updateLock(): Promise<void> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'merkur-sim-lock-'));
  try {
    // Seeded from the release lock, so every crate a shipped build links keeps its version.
    await writePathWorkspace(workspace, path.join(root, 'Cargo.lock'));
    const child = Bun.spawn(['cargo', 'update', '--workspace'], {
      cwd: workspace,
      env: cargoEnvironment(
        '--cfg merkur_sim --cfg tokio_unstable',
        path.join(workspace, 'target'),
      ),
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if ((await child.exited) !== 0) throw new Error('cargo update failed');
    await copyFile(path.join(workspace, 'Cargo.lock'), retainedLock);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  await exec([process.execPath, 'run', 'scripts/sim-workspace.ts']);
}

async function run(): Promise<void> {
  const [mode = 'test', ...rest] = process.argv.slice(2);
  if (mode === 'update-lock') return updateLock();
  if (mode === 'sweep') return sweep(rest);
  if (mode !== 'test')
    throw new Error('Usage: bun scripts/sim-tests.ts test | sweep [count] [start] | update-lock');
  // Simulations share process-wide clock and entropy hooks: each target runs one at a time.
  await exec(['bazel', 'test', '//tools/bazel/sim:all', ...rest]);
}

interface Failure {
  seed: number;
  failure: string;
}

/**
 * Runs `count` random seeds (from `start`, else a random one) through
 * `tests/sweep.rs` and appends each failing seed to `regressions.json`, which
 * every `test:sim` replays.
 */
async function sweep([countText = '100', startText]: string[]): Promise<void> {
  const count = Number(countText);
  const [random = 0] = crypto.getRandomValues(new Uint32Array(1));
  const start = startText === undefined ? random : Number(startText);
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(start) || start < 0) {
    throw new Error('Usage: bun scripts/sim-tests.ts sweep [count] [start]');
  }
  const scratch = await mkdtemp(path.join(tmpdir(), 'merkur-sim-sweep-'));
  const failuresFile = path.join(scratch, 'sweep-failures.json');
  process.stdout.write(`sweeping seeds ${start}..${start + count}\n`);
  // The target's own arguments already run one simulation at a time.
  await exec(
    [
      'bazel',
      'run',
      '//tools/bazel/sim:sweep',
      '--',
      'sweep',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    { MERKUR_SIM_SWEEP: `${start},${count}`, MERKUR_SIM_SWEEP_FAILURES: failuresFile },
  );
  const failures = (await Bun.file(failuresFile).json()) as Failure[];
  if (failures.length === 0) {
    process.stdout.write(`all ${count} seeds held every invariant\n`);
    return;
  }
  const regressionsFile = path.join(source, 'regressions.json');
  const recorded = (await Bun.file(regressionsFile).json()) as (Failure & { found: string })[];
  const found = new Date().toISOString().slice(0, 10);
  for (const { seed, failure } of failures) {
    if (!recorded.some((regression) => regression.seed === seed)) {
      recorded.push({ seed, failure: failure.split('\n')[0] ?? failure, found });
    }
  }
  recorded.sort((a, b) => a.seed - b.seed);
  await writeFile(regressionsFile, `${JSON.stringify(recorded, null, 2)}\n`);
  for (const { seed, failure } of failures) process.stdout.write(`seed ${seed}: ${failure}\n`);
  throw new Error(
    `${failures.length} of ${count} seeds failed; recorded in tools/sim/regressions.json`,
  );
}

if (import.meta.main) await run();
