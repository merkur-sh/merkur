import { withDragonflyContainer } from './dragonfly-container';

export interface SessionIssuanceBenchmarkOptions {
  readonly iterations?: string;
  readonly warmupIterations?: string;
}

export function resolveSessionIssuanceBenchmarkOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): SessionIssuanceBenchmarkOptions {
  if (args.length > 0) {
    throw new Error(`session issuance benchmark accepts no arguments: ${args.join(' ')}`);
  }
  return {
    iterations: readOptionalPositiveInteger('BENCH_ITERATIONS', environment.BENCH_ITERATIONS),
    warmupIterations: readOptionalPositiveInteger(
      'BENCH_WARMUP_ITERATIONS',
      environment.BENCH_WARMUP_ITERATIONS,
    ),
  };
}

if (import.meta.main) {
  const options = resolveSessionIssuanceBenchmarkOptions(Bun.argv.slice(2), process.env);
  await withDragonflyContainer(async ({ id, redisUrl }) => {
    await run(['bun', 'run', '--cwd', 'apps/server', 'bench:session-issuance'], {
      ...process.env,
      DRAGONFLY_BENCH_URL: redisUrl,
      DRAGONFLY_BENCH_IMAGE_ID: inspectContainerImageId(id),
      ...(options.iterations === undefined ? {} : { BENCH_ITERATIONS: options.iterations }),
      ...(options.warmupIterations === undefined
        ? {}
        : { BENCH_WARMUP_ITERATIONS: options.warmupIterations }),
    });
  });
}

function inspectContainerImageId(containerId: string): string {
  const result = Bun.spawnSync(['docker', 'inspect', '--format={{.Image}}', containerId], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`docker inspect failed: ${result.stderr.toString().trim()}`);
  }
  const imageId = result.stdout.toString().trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    throw new Error(`docker inspect returned an invalid image id: ${imageId}`);
  }
  return imageId;
}

function readOptionalPositiveInteger(name: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return raw;
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
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited with ${exitCode}`);
}
