/**
 * Builds and runs Merkur's network simulator (`tools/sim`) in its own generated
 * workspace, `test-results/sim/workspace`, with `--cfg merkur_sim` and the
 * retained `tools/sim/Cargo.lock`.
 */
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  absoluteCargoPaths,
  cargoEnvironment,
  manifestText,
  productionWorkspaceTables,
  root,
  table,
} from './generated-cargo-workspace';

const source = path.join(root, 'tools', 'sim');
const workspace = path.join(root, 'test-results', 'sim', 'workspace');
const retainedLock = path.join(source, 'Cargo.lock');
const generatedLock = path.join(workspace, 'Cargo.lock');
/** `tokio_unstable` lets turmoil seed each host's scheduler. */
const rustflags = '--cfg merkur_sim --cfg tokio_unstable';

async function prepare(): Promise<void> {
  const { lints, patch } = await productionWorkspaceTables();
  const crate = table(
    absoluteCargoPaths(
      Bun.TOML.parse(await Bun.file(path.join(source, 'manifest.toml')).text()),
      source,
    ),
  );
  const manifest = table(crate.package);
  crate.package = {
    ...manifest,
    autotests: false,
    build: path.join(source, String(manifest.build)),
  };
  crate.test = (await readdir(path.join(source, 'tests')))
    .filter((file) => file.endsWith('.rs'))
    .sort()
    .map((file) => ({
      name: file.slice(0, -'.rs'.length),
      path: path.join(source, 'tests', file),
    }));
  await mkdir(path.join(workspace, 'merkur-sim'), { recursive: true });
  await writeFile(
    path.join(workspace, 'Cargo.toml'),
    manifestText({ workspace: { resolver: '3', members: ['merkur-sim'], lints }, patch }),
  );
  await writeFile(path.join(workspace, 'merkur-sim', 'Cargo.toml'), manifestText(crate));
}

async function cargo(args: string[], overrides: Record<string, string> = {}): Promise<void> {
  const env = cargoEnvironment(rustflags, path.join(workspace, 'target'), overrides);
  const child = Bun.spawn(['cargo', ...args], {
    cwd: workspace,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`cargo ${args.join(' ')} failed (${code})`);
}

async function run(): Promise<void> {
  const [mode = 'test', ...rest] = process.argv.slice(2);
  await prepare();
  if (mode === 'update-lock') {
    // Seeded from production, so every crate production links keeps its
    // version and only the simulator's own dependencies resolve here.
    await copyFile(path.join(root, 'Cargo.lock'), generatedLock);
    await cargo(['update', '--workspace']);
    await copyFile(generatedLock, retainedLock);
    return;
  }
  if (mode !== 'test' && mode !== 'sweep')
    throw new Error(
      'Usage: bun scripts/sim-tests.ts test [filter] | sweep [count] [start] | update-lock',
    );
  if (!(await Bun.file(retainedLock).exists()))
    throw new Error('Run sim-tests.ts update-lock first');
  await copyFile(retainedLock, generatedLock);
  if (mode === 'sweep') return sweep(rest);
  // Simulations share process-wide clock and entropy hooks: one test at a time.
  await cargo(['test', '--locked', '--release', ...rest, '--', '--test-threads=1', '--nocapture']);
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
  const failuresFile = path.join(workspace, 'sweep-failures.json');
  await rm(failuresFile, { force: true });
  process.stdout.write(`sweeping seeds ${start}..${start + count}\n`);
  await cargo(
    [
      'test',
      '--locked',
      '--release',
      '--test',
      'sweep',
      'sweep',
      '--',
      '--ignored',
      '--exact',
      '--test-threads=1',
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
