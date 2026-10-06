import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { digestFiles, treeFiles } from './content-digest';
import { E2E_OPAQUE_PUBLIC_KEY } from './e2e-opaque-pin';
import { runVerificationCommand } from './verification-executor';

export function webArtifactInput(root: string, forceEdge: boolean): string {
  const files = [
    'package.json',
    'bun.lock',
    'bunfig.toml',
    'tsconfig.base.json',
    'scripts/e2e-web-artifacts.ts',
    'scripts/sync-term-wasm.ts',
    'scripts/term-wasm-provenance.ts',
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
  const sync = await runVerificationCommand(
    ['bun', 'run', 'sync:wasm'],
    path.join(staging, 'sync-wasm.log'),
    process.env,
    signal,
  );
  if (sync.exitCode !== 0) throw new Error('WASM synchronization failed');
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
  const build = await runVerificationCommand(
    ['bun', 'run', '--cwd', 'apps/web', 'build', '--outDir', dist],
    path.join(staging, 'build.log'),
    environment,
    signal,
  );
  if (build.exitCode !== 0) throw new Error(`E2E web build failed: ${staging}`);
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
