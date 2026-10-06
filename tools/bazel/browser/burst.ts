import { accessSync, constants, mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const BURST_ARGUMENTS = ['test', '-c', 'playwright.burst.config.mjs'] as const;

function absolute(value: string | undefined, role: string): string {
  if (value === undefined || !path.isAbsolute(value))
    throw new Error(`Burst requires its declared ${role}`);
  return value;
}

export function burstCommand(options: {
  readonly root: string;
  readonly cli: string;
  readonly chromium: string | undefined;
  readonly output: string | undefined;
  readonly runtime: string;
  readonly bunConfig: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const chromium = absolute(options.chromium, 'Chromium executable');
  const output = absolute(options.output, 'test output directory');
  const bunConfig = absolute(options.bunConfig, 'neutral Bun configuration');
  absolute(options.root, 'source namespace');
  absolute(options.runtime, 'Bun executable');
  const environment: NodeJS.ProcessEnv = {
    ...options.environment,
    MERKUR_PLAYWRIGHT_CHROMIUM: chromium,
    PW_E2E_OUTPUT_DIR: path.join(output, 'playwright-burst'),
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  };
  delete environment.BUN_OPTIONS;
  delete environment.NODE_OPTIONS;
  return {
    command: [
      options.runtime,
      '--no-install',
      '--no-env-file',
      `--config=${bunConfig}`,
      absolute(options.cli, 'original Playwright CLI'),
      ...BURST_ARGUMENTS,
    ],
    cwd: options.root,
    outputDirectory: path.join(output, 'playwright-burst'),
    environment,
  };
}

function ordinaryFile(filename: string, role: string): void {
  if (!statSync(filename).isFile()) throw new Error(`Burst requires its declared ${role}`);
}

export async function runBurst(arguments_: readonly string[]): Promise<number> {
  if (arguments_.length !== 0) throw new Error('Burst does not accept alternate suite arguments');
  absolute(process.env.MERKUR_BAZEL_RUNFILES_ROOT, 'Bazel runfiles');
  absolute(process.env.TEST_TMPDIR, 'test scratch directory');
  const root = realpathSync(process.cwd());
  const packageRoot = realpathSync(path.join(root, 'node_modules/@playwright/test'));
  const manifest = await Bun.file(path.join(packageRoot, 'package.json')).json();
  if (manifest.name !== '@playwright/test' || manifest.bin?.playwright !== 'cli.js')
    throw new Error('Burst requires the original declared Playwright Test CLI member');
  const cli = realpathSync(path.join(packageRoot, 'cli.js'));
  if (path.dirname(cli) !== packageRoot)
    throw new Error('Burst Playwright CLI escaped its declared package');
  ordinaryFile(cli, 'Playwright CLI');
  const chromium = realpathSync(
    absolute(process.env.MERKUR_PLAYWRIGHT_CHROMIUM, 'Chromium executable'),
  );
  ordinaryFile(chromium, 'Chromium executable');
  accessSync(chromium, constants.X_OK);
  for (const member of [
    'playwright.burst.config.mjs',
    'tests/e2e/display-burst-paint.e2e.ts',
    'tests/e2e/fence-poll-cadence.e2e.ts',
    'apps/web/src/terminal-worker-display-owner.test.ts',
    'apps/web/src/wasm-loader.ts',
    'apps/web/src/terminal/render-mailbox.ts',
    'apps/web/src/term-wasm/pkg/term_wasm.js',
    'apps/web/src/term-wasm/pkg/term_wasm_bg.wasm',
    'apps/web/src/graphics-wasm/pkg/graphics_wasm.js',
    'apps/web/src/graphics-wasm/pkg/graphics_wasm_bg.wasm',
  ])
    ordinaryFile(path.join(root, member), member);
  const invocation = burstCommand({
    root,
    cli,
    chromium,
    output: process.env.TEST_UNDECLARED_OUTPUTS_DIR,
    runtime: process.execPath,
    bunConfig: process.env.MERKUR_BUN_TEST_CONFIG,
    environment: process.env,
  });
  mkdirSync(invocation.outputDirectory, { mode: 0o700 });
  const child = Bun.spawn(invocation.command, {
    cwd: invocation.cwd,
    env: invocation.environment,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const terminate = () => child.kill('SIGTERM');
  const interrupt = () => child.kill('SIGINT');
  process.once('SIGTERM', terminate);
  process.once('SIGINT', interrupt);
  try {
    return await child.exited;
  } finally {
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', interrupt);
  }
}

if (import.meta.main) process.exit(await runBurst(process.argv.slice(2)));
