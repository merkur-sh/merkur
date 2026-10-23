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
const steps: string[] = [];

await installSecretScanning(REPO_ROOT);
steps.push('installed pre-commit secret scanning');
const environment = await Effect.runPromise(
  ensureDevelopmentServerEnvironment(SERVER_ENV_PATH, process.env),
);
steps.push(`validated apps/server/.env; added ${environment.added.length} missing settings`);
await ensureDataDirectory();
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

async function buildDevelopmentArtifacts(): Promise<void> {
  const wasmExitCode = await run(['bazel', 'run', '//tools/bazel/wasm:sync']);
  if (wasmExitCode !== 0) throw new Error(`WASM build failed with exit code ${wasmExitCode}`);
  steps.push('built and synchronized the WASM packages');

  const nativeExitCode = await run(['bazel', 'run', '//tools/bazel/native:sync']);
  if (nativeExitCode !== 0) throw new Error(`native build failed with exit code ${nativeExitCode}`);
  steps.push('built and installed the edge, dataplane, image worker and terminal client');
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
