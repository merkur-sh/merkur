import { afterAll, beforeAll, expect, test } from 'bun:test';
import '../../../packages/shared/src/e2e-wasm-bun';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  daemonArtifactName,
  encodeReleaseManifest,
  RELEASE_PLATFORMS,
} from '../../../packages/shared/src/release';
import {
  deriveReleaseSigningKey,
  encodeReleaseSignature,
  signReleaseManifest,
} from '../../../packages/shared/src/release-signature';

let directory: string;
let verifier: string;
let signature: string;
let archive: Uint8Array;

beforeAll(async () => {
  const executable = process.env.MERKUR_COMPILED_VERIFIER;
  if (executable === undefined)
    throw new Error('Compiled verification requires its declared native producer');
  verifier = executable;
  directory = await mkdtemp(path.join(tmpdir(), 'compiled-release-verifier-'));
  const source = path.join(directory, 'archive-source');
  await mkdir(source);
  for (const name of ['merkur', 'merkur-dataplane', 'merkur-image-worker', 'merkur-tui']) {
    await writeFile(path.join(source, name), `authenticated qualification fixture ${name}`);
    await chmod(path.join(source, name), 0o755);
  }
  const archivePath = path.join(directory, 'fixture.tar.gz');
  const tar = Bun.spawn(
    [
      'tar',
      '--format=ustar',
      '-czf',
      archivePath,
      '-C',
      source,
      'merkur',
      'merkur-dataplane',
      'merkur-image-worker',
      'merkur-tui',
    ],
    {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      stdout: 'ignore',
      stderr: 'inherit',
    },
  );
  if ((await tar.exited) !== 0) throw new Error('Declared native tar producer failed');
  archive = await readFile(archivePath);
  const artifacts = [];
  for (const platform of RELEASE_PLATFORMS) {
    const name = daemonArtifactName(platform);
    await writeFile(path.join(directory, name), archive);
    artifacts.push({
      name,
      size: archive.byteLength,
      sha512: createHash('sha512').update(archive).digest('hex'),
    });
  }
  const manifest = encodeReleaseManifest({
    sequence: 2,
    version: 'v0.2.0',
    expiresAt: Date.now() + 60_000,
    minimumSequence: 1,
    artifacts,
  });
  const key = deriveReleaseSigningKey(new Uint8Array(32).fill(43));
  try {
    signature = encodeReleaseSignature(
      signReleaseManifest(manifest, key, new Uint8Array(32).fill(44)),
    );
  } finally {
    key.free();
  }
  await writeFile(path.join(directory, 'merkur-release.json'), manifest);
  await writeFile(path.join(directory, 'merkur-release.sig'), signature);
});
afterAll(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

async function verify(sequence = '2') {
  const child = Bun.spawn([verifier, directory, 'v0.2.0', sequence], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

test('the actual compiled verifier authenticates every native platform archive with its baked public key', async () => {
  const result = await verify();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('v0.2.0 sequence 2 verified');
});

test('the compiled verifier rejects wrong reservation, altered signature and altered archive', async () => {
  expect((await verify('3')).status).not.toBe(0);
  const changedSignature = Uint8Array.from(signature);
  changedSignature[changedSignature.length - 1] = (changedSignature.at(-1) ?? 0) ^ 1;
  await writeFile(path.join(directory, 'merkur-release.sig'), changedSignature);
  expect((await verify()).status).not.toBe(0);
  await writeFile(path.join(directory, 'merkur-release.sig'), signature);
  await writeFile(
    path.join(directory, 'merkur-daemon-linux-x64.tar.gz'),
    'altered authenticated archive',
  );
  const rejected = await verify();
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain('artifact mismatch');
  await writeFile(path.join(directory, 'merkur-daemon-linux-x64.tar.gz'), archive);
});
