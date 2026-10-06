/** Execute the original configured simulator harness, without Cargo or source mutation. */
import { appendFile, copyFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SeedFailure {
  readonly seed: number;
  readonly failure: string;
}

export function sweepRange(count: string, start: string): { start: number; count: number } {
  const size = Number(count);
  const first = Number(start);
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    !Number.isSafeInteger(first) ||
    first < 0 ||
    !Number.isSafeInteger(first + size)
  )
    throw new Error('usage: sweep <count> [start-seed]');
  return { start: first, count: size };
}

export function readFailures(raw: string, start: number, count: number): SeedFailure[] {
  const records: unknown = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error('Simulator sweep did not write a failure array');
  const seen = new Set<number>();
  return records.map((record: unknown) => {
    if (
      typeof record !== 'object' ||
      record === null ||
      !('seed' in record) ||
      !('failure' in record) ||
      typeof record.seed !== 'number' ||
      !Number.isSafeInteger(record.seed) ||
      record.seed < start ||
      record.seed >= start + count ||
      typeof record.failure !== 'string' ||
      seen.has(record.seed)
    )
      throw new Error('Simulator returned an invalid or duplicate sweep failure');
    seen.add(record.seed);
    return { seed: record.seed, failure: record.failure };
  });
}

export function appendRegressions(
  raw: string,
  failures: readonly SeedFailure[],
  found: string,
): string {
  const records: unknown = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error('Original simulator regressions are not an array');
  const regressions = records.map((record: unknown) => {
    if (
      typeof record !== 'object' ||
      record === null ||
      !('seed' in record) ||
      !('failure' in record) ||
      !('found' in record) ||
      typeof record.seed !== 'number' ||
      !Number.isSafeInteger(record.seed) ||
      record.seed < 0 ||
      typeof record.failure !== 'string' ||
      typeof record.found !== 'string'
    )
      throw new Error('Original simulator regression has an invalid identity');
    return { seed: record.seed, failure: record.failure, found: record.found };
  });
  for (const failure of failures) {
    if (!regressions.some((record) => record.seed === failure.seed)) {
      regressions.push({
        seed: failure.seed,
        failure: failure.failure.split('\n')[0] ?? '',
        found,
      });
    }
  }
  regressions.sort((left, right) => left.seed - right.seed);
  return `${JSON.stringify(regressions, null, 2)}\n`;
}

async function invoke(
  binary: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  logFile: string,
): Promise<void> {
  if (!path.isAbsolute(binary))
    throw new Error('An absolute declared simulator executable is required');
  const log = await open(logFile, 'a');
  try {
    const child = Bun.spawn([binary, ...args], {
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let cancelled = false;
    const interrupt = () => {
      cancelled = true;
      child.kill('SIGINT');
    };
    const terminate = () => {
      cancelled = true;
      child.kill('SIGTERM');
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const tee = async (stream: ReadableStream<Uint8Array>, destination: Bun.BunFile) => {
      try {
        for await (const chunk of stream) {
          await log.writeFile(chunk);
          await Bun.write(destination, chunk);
        }
      } catch (error) {
        child.kill('SIGTERM');
        throw error;
      }
    };
    try {
      const completed = await Promise.allSettled([
        child.exited,
        tee(child.stdout, Bun.stdout),
        tee(child.stderr, Bun.stderr),
      ]);
      for (const result of completed) if (result.status === 'rejected') throw result.reason;
      const exit = child.exitCode;
      if (cancelled || exit !== 0 || child.signalCode !== null)
        throw new Error(`Simulator harness failed (${exit}, ${child.signalCode})`);
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
  } finally {
    await log.close();
  }
}

export async function runSweep(options: {
  readonly start: number;
  readonly count: number;
  readonly output: string;
  readonly regressions: string;
  readonly execute: (
    args: string[],
    environment: NodeJS.ProcessEnv,
    logFile: string,
  ) => Promise<void>;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!path.isAbsolute(options.output))
    throw new Error('Declared sweep output directory is required');
  const directory = path.join(options.output, 'simulation');
  await mkdir(directory, { recursive: true });
  await copyFile(options.regressions, path.join(directory, 'regressions.json'));
  const failuresFile = path.join(directory, 'sweep-failures.json');
  const logFile = path.join(directory, 'sweep.log');
  await rm(failuresFile, { force: true });
  await writeFile(logFile, '');
  const emit = async (destination: Bun.BunFile, message: string) => {
    await appendFile(logFile, message);
    await Bun.write(destination, message);
  };
  try {
    await emit(Bun.stdout, `sweeping seeds ${options.start}..${options.start + options.count}\n`);
    await options.execute(
      ['sweep', '--ignored', '--exact', '--test-threads=1', '--nocapture'],
      {
        ...options.environment,
        MERKUR_SIM_SWEEP: `${options.start},${options.count}`,
        MERKUR_SIM_SWEEP_FAILURES: failuresFile,
      },
      logFile,
    );
    const raw = await readFile(failuresFile, 'utf8');
    const failures = readFailures(raw, options.start, options.count);
    if (failures.length === 0) {
      await emit(Bun.stdout, `all ${options.count} seeds held every invariant\n`);
      return;
    }
    await writeFile(
      path.join(directory, 'regressions.json'),
      appendRegressions(
        await readFile(options.regressions, 'utf8'),
        failures,
        new Date().toISOString().slice(0, 10),
      ),
    );
    for (const failure of failures)
      await emit(Bun.stderr, `seed ${failure.seed}: ${failure.failure}\n`);
    throw new Error(
      `${failures.length} of ${options.count} seeds failed; recorded in declared regressions.json output`,
    );
  } catch (error) {
    await appendFile(logFile, `${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  }
}

async function main(): Promise<void> {
  const binary = process.env.MERKUR_SIM_BINARY;
  if (binary === undefined)
    throw new Error('MERKUR_SIM_BINARY must name the declared configured harness');
  const [mode, count = '200', start] = process.argv.slice(2);
  const output = process.env.TEST_UNDECLARED_OUTPUTS_DIR;
  if (output === undefined || !path.isAbsolute(output))
    throw new Error('Absolute TEST_UNDECLARED_OUTPUTS_DIR is required for simulator artifacts');
  if (mode === 'test') {
    const directory = path.join(output, 'simulation');
    await mkdir(directory, { recursive: true });
    const logFile = path.join(directory, 'scenarios.log');
    await writeFile(logFile, '');
    try {
      await invoke(
        binary,
        [...process.argv.slice(3), '--test-threads=1', '--nocapture'],
        process.env,
        logFile,
      );
    } catch (error) {
      await appendFile(logFile, `${error instanceof Error ? error.message : String(error)}\n`);
      throw error;
    }
  } else if (mode === 'sweep') {
    const range = sweepRange(count, start ?? String(crypto.getRandomValues(new Uint32Array(1))[0]));
    await runSweep({
      ...range,
      output,
      regressions: fileURLToPath(new URL('../../sim/regressions.json', import.meta.url)),
      execute: (args, environment, logFile) => invoke(binary, args, environment, logFile),
      environment: process.env,
    });
  } else throw new Error('An explicit simulator test or sweep operation is required');
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    await Bun.write(Bun.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
