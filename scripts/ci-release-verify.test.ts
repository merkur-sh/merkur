import { expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { daemonArtifactName, encodeReleaseManifest, RELEASE_PLATFORMS } from '@merkur/shared';
import {
  deriveReleaseSigningKey,
  encodeReleasePublicKey,
  encodeReleaseSignature,
  signReleaseManifest,
} from '@merkur/shared/release-signature';
import { Effect } from 'effect';
import { persistReleaseTrustFloorEffect } from '../apps/daemon/src/cli/update';
import { verifyCIRelease } from './ci-release-verify';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ci-release-'));
  const source = path.join(directory, 'source');
  const root = path.join(directory, 'root');
  const state = path.join(root, 'home/dev/.merkur');
  await mkdir(source);
  await mkdir(state, { recursive: true });
  await mkdir(path.join(root, 'opt/merkur-releases/v0.1.0'), { recursive: true });
  await symlink('/opt/merkur-releases/v0.1.0', path.join(root, 'opt/merkur'));
  await Effect.runPromise(
    persistReleaseTrustFloorEffect(state, { manifestSha512: 'a'.repeat(128), sequence: 1 }),
  );
  const executables = ['merkur', 'merkur-dataplane', 'merkur-image-worker', 'merkur-tui'];
  for (const name of executables) {
    await writeFile(path.join(source, name), `signed ${name}`);
    await chmod(path.join(source, name), 0o755);
  }
  const archive = path.join(directory, 'fixture.tar.gz');
  const tar = Bun.spawn(['tar', '--format=ustar', '-czf', archive, '-C', source, ...executables], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  expect(await tar.exited).toBe(0);
  const bytes = await readFile(archive);
  const artifacts = [];
  for (const platform of RELEASE_PLATFORMS) {
    const name = daemonArtifactName(platform);
    await writeFile(path.join(directory, name), bytes);
    artifacts.push({
      name,
      size: bytes.length,
      sha512: createHash('sha512').update(bytes).digest('hex'),
    });
  }
  const pair = deriveReleaseSigningKey(randomBytes(32));
  const manifest = encodeReleaseManifest({
    sequence: 2,
    version: 'v0.2.0',
    expiresAt: Date.now() + 60_000,
    minimumSequence: 1,
    artifacts,
  });
  await writeFile(path.join(directory, 'merkur-release.json'), manifest);
  await writeFile(
    path.join(directory, 'merkur-release.sig'),
    encodeReleaseSignature(signReleaseManifest(manifest, pair, randomBytes(32))),
  );
  const key = encodeReleasePublicKey(pair.publicKey);
  pair.free();
  return { directory, root, state, key };
}

test('managed install activates four verified files atomically and resumes identical bytes', async () => {
  const f = await fixture();
  try {
    await verifyCIRelease(f.directory, 'v0.2.0', 2, f.key, 'linux-x64', f.root);
    expect(await readlink(path.join(f.root, 'opt/merkur'))).toBe('/opt/merkur-releases/v0.2.0');
    expect(
      JSON.parse(await readFile(path.join(f.state, 'release-trust.json'), 'utf8')).sequence,
    ).toBe(2);
    await verifyCIRelease(f.directory, 'v0.2.0', 2, f.key, 'linux-x64', f.root);
    await writeFile(path.join(f.root, 'opt/merkur-releases/v0.2.0/merkur'), 'tampered');
    await expect(
      verifyCIRelease(f.directory, 'v0.2.0', 2, f.key, 'linux-x64', f.root),
    ).rejects.toThrow('existing version directory differs');
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('tampered archive and wrong reservation cannot move the current release', async () => {
  const f = await fixture();
  try {
    await expect(verifyCIRelease(f.directory, 'v0.2.0', 3, f.key)).rejects.toThrow(
      'reservation sequence',
    );
    await writeFile(path.join(f.directory, 'merkur-daemon-linux-x64.tar.gz'), 'tampered');
    await expect(
      verifyCIRelease(f.directory, 'v0.2.0', 2, f.key, 'linux-x64', f.root),
    ).rejects.toThrow('artifact mismatch');
    expect(await readlink(path.join(f.root, 'opt/merkur'))).toBe('/opt/merkur-releases/v0.1.0');
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('rollback and rootfs symlink escape fail before activation', async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(
      persistReleaseTrustFloorEffect(f.state, { manifestSha512: 'b'.repeat(128), sequence: 3 }),
    );
    await expect(
      verifyCIRelease(f.directory, 'v0.2.0', 2, f.key, 'linux-x64', f.root),
    ).rejects.toThrow('rollback floor');
    await rm(path.join(f.root, 'home'), { recursive: true });
    await symlink(f.directory, path.join(f.root, 'home'));
    await expect(
      verifyCIRelease(f.directory, 'v0.2.0', 2, f.key, 'linux-x64', f.root),
    ).rejects.toThrow();
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
