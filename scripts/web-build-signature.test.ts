import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';

import {
  decodeReleaseSignature,
  deriveReleaseSigningKey,
  encodeReleasePublicKey,
  encodeReleaseSignature,
  signReleaseManifest,
  verifyReleaseManifestSignature,
} from '../packages/shared/src/release-signature';

import { runWebBuildSignature } from './web-build-signature';

const COMMIT = 'a'.repeat(40);
const SEED = new Uint8Array(32).fill(7);
const PAIR = deriveReleaseSigningKey(SEED);
const PUBLIC_KEY = encodeReleasePublicKey(PAIR.publicKey);
const MANIFEST = 'merkur-web-release.json';
const SIGNATURE = 'merkur-web-release.sig';
const CONTENTS = {
  'index.html': '<script type="module" src="/assets/app.js"></script>',
  'sw.js': 'self.addEventListener("fetch", () => {});',
  'assets/app.js': 'export const app = 1;',
  'assets/worker.js': 'self.onmessage = () => {};',
  'assets/module.wasm': '\0asm',
  'assets/app.js.br': 'compressed bytes',
  'assets/empty.css': '',
};
let temporary: string;
let directory: string;
let seedFile: string;

beforeEach(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'merkur-web-signing-'));
  directory = path.join(temporary, 'dist');
  seedFile = path.join(temporary, 'seed');
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  await writeFile(seedFile, SEED, { mode: 0o600 });
  for (const [name, content] of Object.entries(CONTENTS)) {
    await writeFile(path.join(directory, name), content);
  }
});

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

async function run(command: string, extra: string[] = [], publicKey = PUBLIC_KEY, commit = COMMIT) {
  try {
    const stdout = await runWebBuildSignature(
      [command, '--directory', directory, '--commit', commit, ...extra],
      publicKey,
    );
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error) {
    return { stdout: '', stderr: String(error), exitCode: 1 };
  }
}

async function sign(): Promise<void> {
  const result = await run('sign', ['--seed-file', seedFile]);
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
}

test('command signs the canonical complete build and verifies it with only the public pin', async () => {
  await sign();
  const manifest = await readFile(path.join(directory, MANIFEST));
  const files = Object.entries(CONTENTS)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, content]) => ({
      path: name,
      size: Buffer.byteLength(content),
      sha512: createHash('sha512').update(content).digest('hex'),
    }));
  expect(manifest.toString()).toBe(`${JSON.stringify({ commit: COMMIT, files })}\n`);
  const signatureText = await readFile(path.join(directory, SIGNATURE), 'utf8');
  expect(signatureText).toHaveLength(6170);
  const signature = decodeReleaseSignature(signatureText);
  expect(
    ml_dsa87.verify(signature, manifest, PAIR.publicKey, {
      context: new TextEncoder().encode('merkur-web-release-manifest'),
    }),
  ).toBe(true);
  expect(verifyReleaseManifestSignature(manifest, signature, PAIR.publicKey)).toBe(false);
  await rm(seedFile);
  const result = await run('verify');
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
});

test.each(Object.keys(CONTENTS))('rejects a changed %s', async (name) => {
  await sign();
  await writeFile(path.join(directory, name), 'modified');
  expect((await run('verify')).exitCode).not.toBe(0);
});

test('rejects missing and additional files, including nested metadata names', async () => {
  await sign();
  await rm(path.join(directory, 'assets/app.js'));
  expect((await run('verify')).exitCode).not.toBe(0);
  await writeFile(path.join(directory, 'assets/app.js'), CONTENTS['assets/app.js']);
  await writeFile(path.join(directory, 'assets', MANIFEST), 'unlisted');
  expect((await run('verify')).exitCode).not.toBe(0);
});

test('rejects a wrong trusted key and a different expected commit', async () => {
  await sign();
  expect((await run('verify', [], '')).exitCode).not.toBe(0);
  const wrong = deriveReleaseSigningKey(new Uint8Array(32).fill(8));
  expect((await run('verify', [], encodeReleasePublicKey(wrong.publicKey))).exitCode).not.toBe(0);
  const result = await run('verify', [], PUBLIC_KEY, 'b'.repeat(40));
  expect(result.stderr.toString()).toContain('expected commit');
  expect(result.exitCode).not.toBe(0);
});

test('rejects a daemon-context signature and noncanonical signed manifest bytes', async () => {
  await sign();
  const manifest = await readFile(path.join(directory, MANIFEST));
  await writeFile(
    path.join(directory, SIGNATURE),
    encodeReleaseSignature(signReleaseManifest(manifest, PAIR, new Uint8Array(32))),
  );
  expect((await run('verify')).stderr.toString()).toContain('signature is invalid');
  const noncanonical = Buffer.concat([manifest, Buffer.from('\n')]);
  await writeFile(path.join(directory, MANIFEST), noncanonical);
  await writeFile(
    path.join(directory, SIGNATURE),
    encodeReleaseSignature(
      PAIR.sign(
        new TextEncoder().encode('merkur-web-release-manifest'),
        noncanonical,
        crypto.getRandomValues(new Uint8Array(32)),
      ),
    ),
  );
  expect((await run('verify')).stderr.toString()).toContain('do not match');
});

test('rejects tampered, missing, and noncanonical signature metadata', async () => {
  await sign();
  const signature = await readFile(path.join(directory, SIGNATURE), 'utf8');
  await writeFile(path.join(directory, SIGNATURE), `${signature}\n`);
  expect((await run('verify')).exitCode).not.toBe(0);
  await writeFile(path.join(directory, SIGNATURE), signature);
  await writeFile(path.join(directory, MANIFEST), '{}\n');
  expect((await run('verify')).exitCode).not.toBe(0);
  await rm(path.join(directory, SIGNATURE));
  expect((await run('verify')).exitCode).not.toBe(0);
});

test('refuses overwrites and preserves an existing orphan signature on failure', async () => {
  await sign();
  const original = await readFile(path.join(directory, SIGNATURE));
  expect((await run('sign', ['--seed-file', seedFile])).exitCode).not.toBe(0);
  expect((await run('verify')).exitCode).toBe(0);
  await rm(path.join(directory, MANIFEST));
  expect((await run('sign', ['--seed-file', seedFile])).exitCode).not.toBe(0);
  expect(await readFile(path.join(directory, SIGNATURE))).toEqual(original);
  expect(await Bun.file(path.join(directory, MANIFEST)).exists()).toBe(false);
});

test('rejects symlinked files, directories, and metadata', async () => {
  await sign();
  await rm(path.join(directory, 'assets/app.js'));
  await symlink(seedFile, path.join(directory, 'assets/app.js'));
  expect((await run('verify')).exitCode).not.toBe(0);
  await rm(path.join(directory, 'assets/app.js'));
  await writeFile(path.join(directory, 'assets/app.js'), CONTENTS['assets/app.js']);
  await symlink(temporary, path.join(directory, 'linked'));
  expect((await run('verify')).exitCode).not.toBe(0);
  await rm(path.join(directory, 'linked'));
  await rm(path.join(directory, SIGNATURE));
  await symlink(seedFile, path.join(directory, SIGNATURE));
  expect((await run('verify')).exitCode).not.toBe(0);
});

test('refuses an exposed, malformed, wrong, or in-build signing seed', async () => {
  await chmod(seedFile, 0o644);
  expect((await run('sign', ['--seed-file', seedFile])).exitCode).not.toBe(0);
  await chmod(seedFile, 0o600);
  await writeFile(seedFile, new Uint8Array(31));
  expect((await run('sign', ['--seed-file', seedFile])).exitCode).not.toBe(0);
  await writeFile(seedFile, new Uint8Array(32));
  expect((await run('sign', ['--seed-file', seedFile])).stderr.toString()).toContain(
    'does not match',
  );
  const inside = path.join(directory, 'seed');
  await writeFile(inside, SEED, { mode: 0o600 });
  expect((await run('sign', ['--seed-file', inside])).stderr.toString()).toContain('outside');
  expect(await Bun.file(path.join(directory, MANIFEST)).exists()).toBe(false);
});

test('rejects incomplete builds and invalid CLI arguments', async () => {
  expect((await run('sign')).exitCode).not.toBe(0);
  expect((await run('verify', ['--commit', COMMIT])).exitCode).not.toBe(0);
  expect((await run('verify', ['--seed-file', seedFile])).exitCode).not.toBe(0);
  expect((await run('verify', ['--unknown'])).exitCode).not.toBe(0);
  await rm(path.join(directory, 'index.html'));
  expect((await run('sign', ['--seed-file', seedFile])).stderr.toString()).toContain('index.html');
});
