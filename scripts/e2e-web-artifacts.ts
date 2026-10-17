import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { digestFiles, treeFiles } from './content-digest';
import { E2E_OPAQUE_PUBLIC_KEY } from './e2e-opaque-pin';

export function webArtifactInput(root: string, forceEdge: boolean): string {
  const files = [
    'package.json',
    'pnpm-lock.yaml',
    'bunfig.toml',
    'tsconfig.base.json',
    'scripts/e2e-web-artifacts.ts',
    ...treeFiles(root, 'apps/web', true),
    ...treeFiles(root, 'packages', true),
    ...readdirSync(path.join(root, 'apps/server'))
      .filter((file) => file.startsWith('.env'))
      .map((file) => `apps/server/${file}`),
  ];
  return createHash('sha256')
    .update(
      JSON.stringify({
        source: digestFiles(root, files),
        forceEdge,
        publicKey: E2E_OPAQUE_PUBLIC_KEY,
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
      }),
    )
    .digest('hex');
}

export function verifyWebArtifact(directory: string, input: string): string {
  const manifest: unknown = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('input' in manifest) ||
    !('output' in manifest) ||
    manifest.input !== input
  )
    throw new Error(`Web artifact input mismatch: ${directory}`);
  const dist = path.join(directory, 'web');
  if (
    !existsSync(path.join(dist, 'index.html')) ||
    digestFiles(dist, treeFiles(dist, '.')) !== manifest.output
  )
    throw new Error(`Web artifact bytes changed: ${directory}`);
  return dist;
}

/** Publish atomically; concurrent builders validate the winner before discarding their staging tree. */
export function publishWebArtifact(staging: string, directory: string, input: string): string {
  verifyWebArtifact(staging, input);
  try {
    renameSync(staging, directory);
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')
      )
    )
      throw error;
    verifyWebArtifact(directory, input);
    rmSync(staging, { recursive: true });
  }
  return verifyWebArtifact(directory, input);
}

/** Builds persist across plans; every server still owns fresh mutable state. */
export async function prepareE2EWebArtifact(
  root: string,
  forceEdge: boolean,
  artifactRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  mkdirSync(artifactRoot, { recursive: true });
  const staging = mkdtempSync(path.join(artifactRoot, '.build-'));
  const input = webArtifactInput(root, forceEdge);
  const directory = path.join(artifactRoot, input);
  if (existsSync(directory)) {
    const dist = verifyWebArtifact(directory, input);
    rmSync(staging, { recursive: true });
    process.stdout.write(`[artifact reused] ${dist}\n`);
    return dist;
  }
  const dist = path.join(staging, 'web');
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'CI', 'NO_COLOR'])
    environment[key] = process.env[key];
  environment.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY = E2E_OPAQUE_PUBLIC_KEY;
  environment.VITE_FORCE_EDGE = forceEdge ? '1' : '0';
  const code = await runLoggedCommand(
    root,
    ['bun', 'run', '--cwd', 'apps/web', 'build', '--outDir', dist],
    path.join(staging, 'build.log'),
    environment,
    signal,
  );
  if (code !== 0) throw new Error(`E2E web build failed: ${staging}`);
  if (webArtifactInput(root, forceEdge) !== input)
    throw new Error('Web build inputs changed during compilation');
  const files = treeFiles(dist, '.');
  const output = digestFiles(dist, files);
  writeFileSync(
    path.join(staging, 'manifest.json'),
    `${JSON.stringify({ input, output, forceEdge })}\n`,
  );
  for (const file of files) chmodSync(path.join(dist, file), 0o444);
  const published = publishWebArtifact(staging, directory, input);
  process.stdout.write(`[artifact built] ${directory}/web\n`);
  return published;
}

/**
 * Runs `command` in `root`, its output to `logPath` and the console. No child inherits a consumed
 * stdin pipe; an abort or a signal to this process ends the child's whole process group.
 */
async function runLoggedCommand(
  root: string,
  command: readonly string[],
  logPath: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const [executable, ...args] = command;
  if (executable === undefined) throw new Error('empty command');
  process.stdout.write(`[start] ${command.join(' ')}\n`);
  const log = openSync(logPath, 'w');
  const child = spawn(executable === 'bun' ? process.execPath : executable, args, {
    cwd: root,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const interrupt = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  };
  signal?.addEventListener('abort', interrupt, { once: true });
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  child.stdout.on('data', (data: Buffer) => {
    writeSync(log, data);
    process.stdout.write(data);
  });
  child.stderr.on('data', (data: Buffer) => {
    writeSync(log, data);
    process.stderr.write(data);
  });
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  const code = await new Promise<number>((resolve) =>
    child.once('close', (exitCode) => resolve(exitCode ?? 1)),
  );
  signal?.removeEventListener('abort', interrupt);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  if (spawnError !== undefined) writeSync(log, `${spawnError.message}\n`);
  closeSync(log);
  process.stdout.write(`[${code === 0 ? 'pass' : 'FAIL'}] ${command.join(' ')} — ${logPath}\n`);
  return code;
}
