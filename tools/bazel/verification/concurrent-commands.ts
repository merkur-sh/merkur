import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CommandResult {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

type Command = readonly string[];

interface Request {
  /** Each lane runs its commands one after another; the lanes run at the same time. */
  readonly lanes: readonly (readonly Command[])[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

function command(value: unknown): value is Command {
  return (
    Array.isArray(value) &&
    value.length !== 0 &&
    value.every((part: unknown) => typeof part === 'string')
  );
}

function request(value: unknown): Request {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('lanes' in value) ||
    !('cwd' in value) ||
    !('environment' in value) ||
    !('timeoutMs' in value) ||
    !Array.isArray(value.lanes) ||
    !value.lanes.every(
      (lane: unknown) => Array.isArray(lane) && lane.length !== 0 && lane.every(command),
    ) ||
    typeof value.cwd !== 'string' ||
    typeof value.environment !== 'object' ||
    value.environment === null ||
    !Object.values(value.environment).every((item) => typeof item === 'string') ||
    typeof value.timeoutMs !== 'number'
  )
    throw new Error('Concurrent commands require their exact request');
  return value as Request;
}

function result(value: unknown): value is CommandResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'exitCode' in value &&
    'signalCode' in value &&
    'stdout' in value &&
    'stderr' in value &&
    (value.exitCode === null || typeof value.exitCode === 'number') &&
    (value.signalCode === null || typeof value.signalCode === 'string') &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string'
  );
}

/**
 * Run lanes of commands at the same time and return when every command has ended, each lane's
 * results in the order asked. Commands that may not overlap share a lane. A synchronous caller
 * keeps its tree and Git state held across the whole set; this runtime, started once more on
 * this file, is what waits on several children at once.
 */
export function runConcurrently(options: Request): readonly (readonly CommandResult[])[] {
  const runner = Bun.spawnSync(
    [process.execPath, '--no-install', '--no-env-file', fileURLToPath(import.meta.url)],
    {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      env: options.environment,
      stdin: Buffer.from(JSON.stringify(options)),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (runner.exitCode !== 0 || runner.signalCode)
    throw new Error(`Concurrent commands did not complete: ${runner.stderr.toString()}`);
  const results: unknown = JSON.parse(runner.stdout.toString());
  if (
    !Array.isArray(results) ||
    results.length !== options.lanes.length ||
    !results.every(
      (lane: unknown, index) =>
        Array.isArray(lane) && lane.length === options.lanes[index]?.length && lane.every(result),
    )
  )
    throw new Error('Concurrent commands returned a malformed answer');
  return results as readonly (readonly CommandResult[])[];
}

if (import.meta.main) {
  const { lanes, cwd, environment, timeoutMs } = request(JSON.parse(await Bun.stdin.text()));
  const run = async (argv: Command): Promise<CommandResult> => {
    const child = Bun.spawn([...argv], {
      cwd,
      env: environment,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      exitCode: child.signalCode ? null : exitCode,
      signalCode: child.signalCode,
      stdout,
      stderr,
    };
  };
  const results = await Promise.all(
    lanes.map(async (lane) => {
      const ended: CommandResult[] = [];
      for (const argv of lane) ended.push(await run(argv));
      return ended;
    }),
  );
  process.stdout.write(JSON.stringify(results));
}
