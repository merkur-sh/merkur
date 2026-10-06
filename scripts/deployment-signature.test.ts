import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readSignedBuildIdentity } from '../apps/server/src/http/build-identity';
import {
  BUILD_PROOFS,
  encodeBuildMarker,
  verifyBuildIdentity,
} from '../packages/shared/src/build-identity';
import {
  deriveReleaseSigningKey,
  encodeReleasePublicKey,
} from '../packages/shared/src/release-signature';
import { runWebBuildSignature } from './web-build-signature';

const COMMIT = 'a'.repeat(40);
const BUILD_ID = '01234567-89ab-cdef-0123-456789abcdef';
const SEED = new Uint8Array(32).fill(41);
const PUBLIC_KEY = encodeReleasePublicKey(deriveReleaseSigningKey(SEED).publicKey);
let root: string;
let directory: string;
let seedFile: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'merkur-deployment-test-'));
  directory = path.join(root, 'deployment');
  seedFile = path.join(root, 'seed');
  for (const name of ['web', 'server', 'migrations'])
    await mkdir(path.join(directory, name), { recursive: true });
  await writeFile(seedFile, SEED, { mode: 0o600 });
  await writeFile(path.join(directory, 'web/index.html'), '<title>Merkur</title>');
  await writeFile(path.join(directory, 'web/merkur-build.json'), encodeBuildMarker(BUILD_ID));
  await writeFile(path.join(directory, 'server/server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(directory, 'migrations/001.sql'), 'SELECT 1;');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function command(name: string, extra: string[] = []) {
  return runWebBuildSignature(
    [name, '--directory', directory, '--commit', COMMIT, ...extra],
    PUBLIC_KEY,
  );
}

async function sign(): Promise<void> {
  await runWebBuildSignature(
    [
      'sign',
      '--directory',
      path.join(directory, 'web'),
      '--commit',
      COMMIT,
      '--seed-file',
      seedFile,
    ],
    PUBLIC_KEY,
  );
  await command('sign-deployment', ['--seed-file', seedFile]);
}

test('offline signatures bind the server, migrations, client and the copied verification ID', async () => {
  await sign();
  const proof = readSignedBuildIdentity(directory, BUILD_ID, PUBLIC_KEY);
  const identity = verifyBuildIdentity(proof, PUBLIC_KEY, BUILD_ID);
  expect(identity.verificationId).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  expect(identity.commit).toBe(COMMIT);
  expect(identity.verificationId).toBe(
    verifyBuildIdentity(JSON.parse(JSON.stringify(proof)), PUBLIC_KEY, BUILD_ID).verificationId,
  );
  await rm(seedFile);
  expect(await command('verify-deployment')).toContain(identity.verificationId);
  const manifest = JSON.parse(
    await readFile(path.join(directory, BUILD_PROOFS.deployment.manifest), 'utf8'),
  );
  expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([
    'migrations/001.sql',
    'server/server',
    'web/index.html',
    'web/merkur-build.json',
    'web/merkur-web-release.json',
    'web/merkur-web-release.sig',
  ]);
});

test.each(['server/server', 'migrations/001.sql', 'web/index.html'])(
  'packaging rejects changed %s',
  async (name) => {
    await sign();
    await writeFile(path.join(directory, name), 'tampered');
    await expect(command('verify-deployment')).rejects.toThrow();
  },
);

test('packaging rejects unlisted files, unsigned bundles, and wrong expected commits', async () => {
  await expect(command('verify-deployment')).rejects.toThrow();
  await sign();
  await expect(
    runWebBuildSignature(
      ['verify-deployment', '--directory', directory, '--commit', 'b'.repeat(40)],
      PUBLIC_KEY,
    ),
  ).rejects.toThrow();
  await writeFile(path.join(directory, 'extra'), 'unlisted');
  await expect(command('verify-deployment')).rejects.toThrow();
});

test('an invalid build marker is rejected before publishing deployment signatures', async () => {
  await writeFile(path.join(directory, 'web/merkur-build.json'), '{"buildId":"invalid"}\n');
  await runWebBuildSignature(
    [
      'sign',
      '--directory',
      path.join(directory, 'web'),
      '--commit',
      COMMIT,
      '--seed-file',
      seedFile,
    ],
    PUBLIC_KEY,
  );
  await expect(command('sign-deployment', ['--seed-file', seedFile])).rejects.toThrow();
  expect(await Bun.file(path.join(directory, BUILD_PROOFS.deployment.manifest)).exists()).toBe(
    false,
  );
});

test('the browser rejects stale client builds, wrong pins, and tampered signatures', async () => {
  await sign();
  const proof = readSignedBuildIdentity(directory, BUILD_ID, PUBLIC_KEY);
  expect(() =>
    verifyBuildIdentity(proof, PUBLIC_KEY, 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  ).toThrow('loaded application');
  const wrongKey = encodeReleasePublicKey(
    deriveReleaseSigningKey(new Uint8Array(32).fill(9)).publicKey,
  );
  expect(() => verifyBuildIdentity(proof, wrongKey, BUILD_ID)).toThrow();
  expect(() =>
    verifyBuildIdentity(
      { ...proof, server: { ...proof.server, signature: `${proof.server.signature}\n` } },
      PUBLIC_KEY,
      BUILD_ID,
    ),
  ).toThrow();
  expect(() =>
    verifyBuildIdentity(
      { ...proof, client: { ...proof.client, manifest: '{}\n' } },
      PUBLIC_KEY,
      BUILD_ID,
    ),
  ).toThrow();
});

test('a separately signed client cannot be substituted into an existing server proof', async () => {
  await sign();
  const original = readSignedBuildIdentity(directory, BUILD_ID, PUBLIC_KEY);
  await rm(path.join(directory, 'web', BUILD_PROOFS.web.manifest));
  await rm(path.join(directory, 'web', BUILD_PROOFS.web.signature));
  await writeFile(path.join(directory, 'web/index.html'), 'a different legitimate client');
  await runWebBuildSignature(
    [
      'sign',
      '--directory',
      path.join(directory, 'web'),
      '--commit',
      COMMIT,
      '--seed-file',
      seedFile,
    ],
    PUBLIC_KEY,
  );
  const replaced = {
    server: original.server,
    client: {
      manifest: await readFile(path.join(directory, 'web', BUILD_PROOFS.web.manifest), 'utf8'),
      signature: await readFile(path.join(directory, 'web', BUILD_PROOFS.web.signature), 'utf8'),
    },
  };
  expect(() => verifyBuildIdentity(replaced, PUBLIC_KEY, BUILD_ID)).toThrow();
  expect(() => readSignedBuildIdentity(directory, BUILD_ID, PUBLIC_KEY)).toThrow();
});

test('release rollout check requires the exact locally verified serving bundle', async () => {
  await sign();
  const proof = readSignedBuildIdentity(directory, BUILD_ID, PUBLIC_KEY);
  let payload: unknown = proof;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json(payload) });
  try {
    expect(await command('verify-server', ['--origin', server.url.origin])).toContain(
      verifyBuildIdentity(proof, PUBLIC_KEY, BUILD_ID).verificationId,
    );
    payload = null;
    await expect(command('verify-server', ['--origin', server.url.origin])).rejects.toThrow();
  } finally {
    await server.stop(true);
  }
});
