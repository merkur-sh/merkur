import '../packages/shared/src/e2e-wasm-bun';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { toolEnvironment } from './dev-environment';
import { probeRedis, redisEndpoint } from './dev-redis';
import { ensureDevelopmentServerEnvironment } from './dev-server-env';
import { installSecretScanning } from './secret-scanning';

// Local setup validates a complete candidate before persisting it.
const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIRECTORY, '..');
const SERVER_ENV_PATH = path.join(REPO_ROOT, 'apps/server/.env');
const SERVER_DATA_DIRECTORY = path.join(REPO_ROOT, 'apps/server/data');
const WASM_TARGET = 'wasm32-unknown-unknown';
const steps: string[] = [];

await installSecretScanning(REPO_ROOT);
steps.push('installed pre-commit secret scanning');
const environment = await Effect.runPromise(
  ensureDevelopmentServerEnvironment(SERVER_ENV_PATH, process.env),
);
steps.push(`validated apps/server/.env; added ${environment.added.length} missing settings`);
await ensureDataDirectory();
await ensureWasmTarget();
await Effect.runPromise(probeRedis(environment.config.redisUrl));
steps.push(`Redis authenticated PING succeeded at ${redisEndpoint(environment.config.redisUrl)}`);
await buildDevelopmentArtifacts();

process.stdout.write('\nSetup summary:\n');
for (const step of steps) {
  process.stdout.write(`  ${step}\n`);
}
process.stdout.write('\nNext: bun run dev:doctor && bun run dev\n');

async function ensureDataDirectory(): Promise<void> {
  await mkdir(SERVER_DATA_DIRECTORY, { recursive: true });
  steps.push('ensured apps/server/data/ exists');
}

async function ensureWasmTarget(): Promise<void> {
  const rustup = Bun.which('rustup');
  if (rustup === null) {
    throw new Error(`rustup not found; install Rust, then run: rustup target add ${WASM_TARGET}`);
  }

  const exitCode = await run([rustup, 'target', 'add', WASM_TARGET]);
  if (exitCode !== 0) throw new Error(`failed to add rust target ${WASM_TARGET}`);
  steps.push(`ensured rust target ${WASM_TARGET}`);
}

async function buildDevelopmentArtifacts(): Promise<void> {
  for (const script of ['scripts/sync-term-wasm.ts', 'scripts/build-daemon-artifacts.ts']) {
    const exitCode = await run([process.execPath, '--bun', '--no-env-file', 'run', script]);
    if (exitCode !== 0) throw new Error(`${script} failed with exit code ${exitCode}`);
    steps.push(`completed ${script}`);
  }

  const edgeExitCode = await run([
    'cargo',
    'build',
    '--manifest-path',
    'Cargo.toml',
    '--locked',
    '-p',
    'merkur-edge',
  ]);
  if (edgeExitCode !== 0) throw new Error(`merkur-edge build failed with exit ${edgeExitCode}`);
  steps.push('built local merkur-edge');
}

async function run(command: string[]): Promise<number> {
  const proc = Bun.spawn(command, {
    cwd: REPO_ROOT,
    env: toolEnvironment(process.env),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}
