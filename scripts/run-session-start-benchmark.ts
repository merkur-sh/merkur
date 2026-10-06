import { resolve } from 'node:path';

import { withDragonflyContainer } from './dragonfly-container';

const USAGE =
  'Usage: bun run scripts/run-session-start-benchmark.ts ' +
  '[--baseline-artifact=<path>] [--regression-percent=<number>]';

interface SessionStartBenchmarkOptions {
  readonly iterations?: string;
  readonly warmupIterations?: string;
  readonly baselineArtifact?: string;
  readonly regressionPercent?: string;
}

export function resolveSessionStartBenchmarkOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): SessionStartBenchmarkOptions {
  let baselineArtifact: string | undefined;
  let regressionPercent: string | undefined;
  for (const argument of args) {
    if (argument.startsWith('--baseline-artifact=')) {
      if (baselineArtifact !== undefined) {
        throw new Error(`${USAGE}; --baseline-artifact may be specified only once`);
      }
      const path = argument.slice('--baseline-artifact='.length);
      if (path.length === 0 || path.includes('\0')) {
        throw new Error(`${USAGE}; --baseline-artifact requires a non-empty path`);
      }
      baselineArtifact = path;
      continue;
    }
    if (argument.startsWith('--regression-percent=')) {
      if (regressionPercent !== undefined) {
        throw new Error(`${USAGE}; --regression-percent may be specified only once`);
      }
      const raw = argument.slice('--regression-percent='.length);
      if (!isNonNegativeFiniteNumber(raw)) {
        throw new Error(`${USAGE}; --regression-percent must be a non-negative finite number`);
      }
      regressionPercent = raw;
      continue;
    }
    throw new Error(`${USAGE}; unexpected argument: ${argument}`);
  }
  if (regressionPercent !== undefined && baselineArtifact === undefined) {
    throw new Error(`${USAGE}; --regression-percent requires --baseline-artifact`);
  }
  return {
    iterations: readOptionalPositiveInteger('BENCH_ITERATIONS', environment.BENCH_ITERATIONS),
    warmupIterations: readOptionalPositiveInteger(
      'BENCH_WARMUP_ITERATIONS',
      environment.BENCH_WARMUP_ITERATIONS,
    ),
    baselineArtifact,
    regressionPercent,
  };
}

if (import.meta.main) {
  const options = resolveSessionStartBenchmarkOptions(Bun.argv.slice(2), process.env);
  await withDragonflyContainer(async ({ redisUrl }) => {
    const childEnvironment: Record<string, string | undefined> = { ...process.env };
    delete childEnvironment.SESSION_START_BASELINE_ARTIFACT;
    delete childEnvironment.SESSION_START_REGRESSION_PERCENT;
    await run(['bun', 'run', '--cwd', 'apps/server', 'bench:session-start'], {
      ...childEnvironment,
      DRAGONFLY_BENCH_URL: redisUrl,
      ...(options.iterations === undefined ? {} : { BENCH_ITERATIONS: options.iterations }),
      ...(options.warmupIterations === undefined
        ? {}
        : { BENCH_WARMUP_ITERATIONS: options.warmupIterations }),
      ...(options.baselineArtifact === undefined
        ? {}
        : { SESSION_START_BASELINE_ARTIFACT: resolve(options.baselineArtifact) }),
      ...(options.regressionPercent === undefined
        ? {}
        : { SESSION_START_REGRESSION_PERCENT: options.regressionPercent }),
    });
  });
}

function readOptionalPositiveInteger(name: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return raw;
}

function isNonNegativeFiniteNumber(raw: string): boolean {
  if (raw.length === 0 || raw.trim() !== raw) return false;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0;
}

async function run(
  command: readonly string[],
  environment: Record<string, string | undefined>,
): Promise<void> {
  const processHandle = Bun.spawn([...command], {
    env: environment,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} exited with ${exitCode}`);
  }
}
