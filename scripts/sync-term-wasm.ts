import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hasExactTermWasmArtifactSet,
  termWasmArtifactSetsEqual,
  termWasmArtifactsMatchSource,
} from './term-wasm-provenance';

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIRECTORY, '..');
const SOURCE_DIRECTORY = path.join(REPO_ROOT, 'packages/term-wasm/pkg');
const TARGET_DIRECTORY = path.join(REPO_ROOT, 'apps/web/src/term-wasm/pkg');

if (import.meta.main) {
  if (!(await hasCurrentWasmArtifacts(SOURCE_DIRECTORY))) {
    await runOrThrow(['bun', 'run', 'scripts/build-term-wasm.ts'], REPO_ROOT);
  }

  if (!(await hasCurrentWasmArtifacts(SOURCE_DIRECTORY))) {
    throw new Error('terminal WASM build did not produce a current exact artifact set');
  }

  await synchronizeTermWasmArtifactSet(SOURCE_DIRECTORY, TARGET_DIRECTORY);
}

export async function synchronizeTermWasmArtifactSet(
  sourceDirectory: string,
  targetDirectory: string,
): Promise<boolean> {
  if (!(await hasExactTermWasmArtifactSet(sourceDirectory))) {
    throw new Error('refusing to synchronize a non-exact terminal WASM artifact set');
  }
  if (await termWasmArtifactSetsEqual(sourceDirectory, targetDirectory)) return false;
  await fs.rm(targetDirectory, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDirectory), { recursive: true });
  await fs.cp(sourceDirectory, targetDirectory, { recursive: true });
  if (!(await termWasmArtifactSetsEqual(sourceDirectory, targetDirectory))) {
    throw new Error('terminal WASM artifact synchronization did not produce an exact copy');
  }
  return true;
}

async function hasCurrentWasmArtifacts(directory: string): Promise<boolean> {
  return (
    (await hasExactTermWasmArtifactSet(directory)) &&
    (await termWasmArtifactsMatchSource(REPO_ROOT, directory))
  );
}

async function runOrThrow(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
