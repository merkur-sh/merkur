import '../packages/shared/src/e2e-wasm-bun';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  chown,
  lstat,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';
import {
  persistReleaseTrustFloorEffect,
  readReleaseTrustFloorEffect,
  validateReleaseTarballEffect,
  verifyReleaseCandidateEffect,
} from '../apps/daemon/src/cli/update';
import { parseCanonicalReleaseManifest, RELEASE_PLATFORMS } from '../packages/shared/src/release';

const EXECUTABLES = ['merkur', 'merkur-dataplane', 'merkur-image-worker', 'merkur-tui'];

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function contained(root: string, relative: string): Promise<string> {
  const target = path.join(root, relative);
  if ((await realpath(target)) !== target) throw new Error(`symlink in managed path: ${relative}`);
  return target;
}

export async function verifyCIRelease(
  directory: string,
  version: string,
  sequence: number,
  publicKey: string,
  platform?: string,
  rootPath?: string,
  historical = false,
): Promise<void> {
  if (historical && rootPath) throw new Error('historical verification cannot activate a release');
  const root = rootPath ? await realpath(rootPath) : undefined;
  const manifestBytes = await readFile(path.join(directory, 'merkur-release.json'));
  const signatureBytes = await readFile(path.join(directory, 'merkur-release.sig'));
  const manifest = parseCanonicalReleaseManifest(manifestBytes);
  if (manifest.sequence !== sequence) throw new Error('reservation sequence differs from manifest');
  const selected = RELEASE_PLATFORMS.filter(
    (value) => platform === undefined || value === platform,
  );
  if (selected.length === 0 || (root && selected.length !== 1)) throw new Error('invalid platform');
  const installRoot = root ? await contained(root, 'home/dev/.merkur') : undefined;
  // Provisioning establishes this floor from the previously signed package and proves
  // its four installed binary hashes. Missing state is never an installation license.
  const trustFile = installRoot ? path.join(installRoot, 'release-trust.json') : undefined;
  const owner = trustFile ? await lstat(trustFile) : undefined;
  if (owner && !owner.isFile()) throw new Error('trust state must be a regular file');
  const floor = installRoot
    ? await Effect.runPromise(readReleaseTrustFloorEffect(installRoot, 1))
    : { sequence, manifestSha512: null };
  for (const target of selected) {
    const candidate = await Effect.runPromise(
      verifyReleaseCandidateEffect({
        consumerSequence: floor.sequence,
        consumerVersion: floor.sequence === sequence ? version : 'installed',
        expectedVersion: version,
        manifestBytes,
        now: historical ? manifest.expiresAt - 1 : Date.now(),
        platform: target,
        publicKeyBase64url: publicKey,
        signatureBytes,
        trustFloor: floor,
      }),
    );
    const archive = path.join(directory, candidate.artifact.name);
    if (
      (await stat(archive)).size !== candidate.artifact.size ||
      (await hashFile(archive)) !== candidate.artifact.sha512
    )
      throw new Error('artifact mismatch');
    await Effect.runPromise(validateReleaseTarballEffect(archive));
    if (!root || !installRoot || !trustFile || !owner) continue;
    const opt = await contained(root, 'opt');
    const releases = await contained(root, 'opt/merkur-releases');
    const current = path.join(opt, 'merkur');
    if (
      !/^\/opt\/merkur-releases\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
        await readlink(current),
      )
    ) {
      throw new Error('managed installation must be provisioned before rollout');
    }
    const rootOwner = await stat(opt);
    const stage = await mkdtemp(path.join(releases, '.incoming-'));
    try {
      const extraction = Bun.spawn(['tar', '-xzf', archive, '-C', stage], {
        stdout: 'inherit',
        stderr: 'inherit',
      });
      if ((await extraction.exited) !== 0) throw new Error('release extraction failed');
      await chmod(stage, 0o755);
      await chown(stage, rootOwner.uid, rootOwner.gid);
      for (const executable of EXECUTABLES) {
        const file = path.join(stage, executable);
        await chown(file, rootOwner.uid, rootOwner.gid);
        await syncFile(file);
      }
      await syncFile(stage);
      const targetDirectory = path.join(releases, version);
      let existing = false;
      try {
        await lstat(targetDirectory);
        existing = true;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (existing) {
        await contained(root, `opt/merkur-releases/${version}`);
        for (const executable of EXECUTABLES) {
          const file = path.join(targetDirectory, executable);
          if (
            !(await lstat(file)).isFile() ||
            (await hashFile(file)) !== (await hashFile(path.join(stage, executable)))
          ) {
            throw new Error('existing version directory differs from the signed release');
          }
        }
      } else {
        await rename(stage, targetDirectory);
        await syncFile(releases);
      }
      await Effect.runPromise(
        persistReleaseTrustFloorEffect(installRoot, {
          manifestSha512: candidate.manifestSha512,
          sequence,
        }),
      );
      await chown(trustFile, owner.uid, owner.gid);
      const next = path.join(opt, `merkur-${sequence}.new`);
      await rm(next, { force: true });
      await symlink(`/opt/merkur-releases/${version}`, next);
      await rename(next, current);
      await syncFile(opt);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const [directory, version, sequenceText, platform, root] = process.argv.slice(2);
  if (!directory || !version || !sequenceText)
    throw new Error('directory, version, sequence required');
  await verifyCIRelease(
    directory,
    version,
    Number(sequenceText),
    process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY ?? '',
    platform,
    root === '--history' ? undefined : root,
    root === '--history',
  );
  process.stdout.write(`${version} sequence ${sequenceText} verified\n`);
}
