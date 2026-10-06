import '../packages/shared/src/e2e-wasm-bun';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { MlDsa87SigningKey } from '../packages/e2e-wasm/pkg/e2e_wasm.js';
import {
  BUILD_PROOFS,
  encodeBuildMarker,
  verifyBuildIdentity,
} from '../packages/shared/src/build-identity';
import { e2eWasm } from '../packages/shared/src/e2e-wasm-runtime';
import {
  decodeReleasePublicKey,
  decodeReleaseSignature,
  deriveReleaseSigningKey,
  encodeReleaseSignature,
} from '../packages/shared/src/release-signature';

interface BuildFile {
  readonly path: string;
  readonly size: number;
  readonly sha512: string;
}

if (import.meta.main) {
  const result = await runWebBuildSignature(
    process.argv.slice(2),
    process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY ?? '',
  );
  process.stdout.write(`${result}\n`);
}

export async function runWebBuildSignature(
  arguments_: readonly string[],
  publicKeyPin: string,
): Promise<string> {
  const [command, ...argv] = arguments_;
  if (
    command !== 'sign' &&
    command !== 'verify' &&
    command !== 'sign-deployment' &&
    command !== 'verify-deployment' &&
    command !== 'verify-server'
  ) {
    throw new Error(
      'usage: web-build-signature sign|verify|sign-deployment|verify-deployment|verify-server --commit SHA [--directory PATH] [--seed-file PATH] [--origin URL]',
    );
  }
  const deployment =
    command === 'sign-deployment' || command === 'verify-deployment' || command === 'verify-server';
  const signing = command === 'sign' || command === 'sign-deployment';
  const proof = deployment ? BUILD_PROOFS.deployment : BUILD_PROOFS.web;
  const MANIFEST_FILE = proof.manifest;
  const SIGNATURE_FILE = proof.signature;
  const CONTEXT = new TextEncoder().encode(proof.context);
  const allowed = new Set([
    '--commit',
    '--directory',
    ...(signing ? ['--seed-file'] : []),
    ...(command === 'verify-server' ? ['--origin'] : []),
  ]);
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined || !allowed.has(name) || args.has(name)) {
      throw new Error('unknown, duplicate, or incomplete web signing argument');
    }
    args.set(name, value);
  }
  const commit = args.get('--commit') ?? '';
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw new Error('--commit must be a full lowercase Git commit SHA');
  const directory = path.resolve(
    args.get('--directory') ?? (deployment ? 'deployment' : 'apps/web/dist'),
  );
  if (!(await lstat(directory)).isDirectory())
    throw new Error('web build must be a regular directory');
  const publicKey = decodeReleasePublicKey(publicKeyPin);

  let deploymentBuildId = '';
  if (deployment) {
    const markerBytes = await readRegularFile(path.join(directory, 'web/merkur-build.json'));
    const marker: unknown = JSON.parse(markerBytes.toString());
    if (
      typeof marker !== 'object' ||
      marker === null ||
      !('buildId' in marker) ||
      typeof marker.buildId !== 'string' ||
      encodeBuildMarker(marker.buildId) !== markerBytes.toString()
    )
      throw new Error('invalid build marker');
    deploymentBuildId = marker.buildId;
    await runWebBuildSignature(
      ['verify', '--directory', path.join(directory, 'web'), '--commit', commit],
      publicKeyPin,
    );
  }
  if (signing) {
    const seedFile = args.get('--seed-file');
    if (seedFile === undefined || seedFile.length === 0) throw new Error('--seed-file is required');
    await signBuild(seedFile);
  } else {
    await verifyBuild();
  }
  if (deployment) {
    const identity = verifyBuildIdentity(
      {
        server: await readProof(directory, BUILD_PROOFS.deployment),
        client: await readProof(path.join(directory, 'web'), BUILD_PROOFS.web),
      },
      publicKeyPin,
      deploymentBuildId,
    );
    if (command === 'verify-server') {
      const origin = args.get('--origin');
      if (!origin) throw new Error('--origin is required');
      const url = new URL('/api/build-identity', origin);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new Error('invalid server origin');
      const response = await fetch(url, { cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw new Error('server build identity unavailable');
      const remote = verifyBuildIdentity(await response.json(), publicKeyPin, deploymentBuildId);
      if (
        remote.serverSignature !== identity.serverSignature ||
        remote.clientSignature !== identity.clientSignature
      )
        throw new Error('server is not serving the expected signed deployment');
    }
    return `${signing ? 'signed' : 'verified'} deployment for ${commit}: ${identity.verificationId}`;
  }
  return `${signing ? 'signed' : 'verified'} ${deployment ? 'deployment' : 'web build'} for ${commit}`;

  async function readProof(root: string, names: { manifest: string; signature: string }) {
    return {
      manifest: (await readRegularFile(path.join(root, names.manifest))).toString(),
      signature: (await readRegularFile(path.join(root, names.signature))).toString(),
    };
  }

  async function signBuild(seedFile: string): Promise<void> {
    const relativeSeed = path.relative(await realpath(directory), await realpath(seedFile));
    if (
      !path.isAbsolute(relativeSeed) &&
      relativeSeed !== '..' &&
      !relativeSeed.startsWith(`..${path.sep}`)
    ) {
      throw new Error('signing seed must be outside the web build directory');
    }
    const seed = await readRegularFile(seedFile, true);
    let key: MlDsa87SigningKey | undefined;
    const entropy = randomBytes(32);
    try {
      key = deriveReleaseSigningKey(seed);
      if (!timingSafeEqual(key.publicKey, publicKey)) {
        throw new Error('signing seed does not match MERKUR_RELEASE_MLDSA87_PUBLIC_KEY');
      }
      const manifest = await buildManifest();
      const signature = encodeReleaseSignature(key.sign(CONTEXT, manifest, entropy));
      // Exclusive creation refuses re-signing a directory and never overwrites a
      // previous signature. On failure remove only files this invocation created.
      const created: string[] = [];
      try {
        for (const [name, bytes] of [
          [MANIFEST_FILE, manifest],
          [SIGNATURE_FILE, signature],
        ] as const) {
          const target = path.join(directory, name);
          const file = await open(target, 'wx', 0o644);
          created.push(target);
          try {
            await file.writeFile(bytes);
            await file.sync();
          } finally {
            await file.close();
          }
        }
      } catch (cause) {
        for (const target of created) await rm(target);
        throw cause;
      }
    } finally {
      seed.fill(0);
      key?.free();
      entropy.fill(0);
    }
  }

  async function verifyBuild(): Promise<void> {
    const manifest = await readRegularFile(path.join(directory, MANIFEST_FILE));
    const signature = decodeReleaseSignature(
      (await readRegularFile(path.join(directory, SIGNATURE_FILE))).toString('utf8'),
    );
    if (!e2eWasm().mlDsa87Verify(publicKey, CONTEXT, manifest, signature)) {
      throw new Error('web build signature is invalid');
    }
    // Reconstruct from the actual directory and the independently supplied commit.
    // Exact byte equality enforces canonical encoding, schema, sorted unique paths,
    // every file's size/hash, and the absence of unlisted files without trusting JSON.
    if (!manifest.equals(await buildManifest())) {
      throw new Error('web build contents or expected commit do not match the signed manifest');
    }
  }

  async function buildManifest(): Promise<Buffer> {
    const files: BuildFile[] = [];
    await walk(directory, '');
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const entry = deployment ? 'server/server' : 'index.html';
    if (!files.some((file) => file.path === entry && file.size > 0)) {
      throw new Error(`build must contain a non-empty ${entry}`);
    }
    if (deployment && !files.some((file) => file.path.startsWith('migrations/') && file.size > 0)) {
      throw new Error('deployment must contain migrations');
    }
    return Buffer.from(`${JSON.stringify({ commit, files })}\n`);

    async function walk(current: string, prefix: string): Promise<void> {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const relative = `${prefix}${entry.name}`;
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (relative === MANIFEST_FILE || relative === SIGNATURE_FILE) {
            throw new Error(`signature metadata must be a regular file: ${relative}`);
          }
          await walk(absolute, `${relative}/`);
        } else if (entry.isFile()) {
          if (relative === MANIFEST_FILE || relative === SIGNATURE_FILE) continue;
          const digest = createHash('sha512');
          let size = 0;
          const file = await open(
            absolute,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            if (!(await file.stat()).isFile()) throw new Error('expected a regular build file');
            for await (const chunk of file.createReadStream({ autoClose: false })) {
              size += chunk.length;
              digest.update(chunk);
            }
          } finally {
            await file.close();
          }
          files.push({ path: relative, size, sha512: digest.digest('hex') });
        } else {
          throw new Error(`web build contains a link or special file: ${relative}`);
        }
      }
    }
  }

  async function readRegularFile(filePath: string, signingSeed = false): Promise<Buffer> {
    const file = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) throw new Error('expected a regular file');
      if (
        signingSeed &&
        (metadata.size !== 32 || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0))
      ) {
        throw new Error('signing seed must be exactly 32 raw bytes with owner-only permissions');
      }
      const bytes = await file.readFile();
      if (signingSeed && bytes.length !== 32) {
        bytes.fill(0);
        throw new Error('signing seed must be exactly 32 raw bytes');
      }
      return bytes;
    } finally {
      await file.close();
    }
  }
}
