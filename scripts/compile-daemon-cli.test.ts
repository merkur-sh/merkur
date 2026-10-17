import { expect, test } from 'bun:test';
import { compileArguments, releaseIdentity } from './compile-daemon-cli';

const release = {
  MERKUR_VERSION: 'v1.0.0',
  MERKUR_RELEASE_SEQUENCE: '1',
  MERKUR_RELEASE_MLDSA87_PUBLIC_KEY: 'A'.repeat(3456),
  MERKUR_PUBLIC_ORIGIN: 'https://merkur.test',
  MERKUR_OPAQUE_SERVER_PUBLIC_KEY: Buffer.alloc(32).toString('base64url'),
};

test('a development build carries no release identity', () => {
  expect(releaseIdentity({ MERKUR_VERSION: 'dev', MERKUR_RELEASE_SEQUENCE: '0' })).toEqual({
    version: 'dev',
    sequence: 0,
    publicKey: '',
    origin: '',
    opaquePin: '',
  });
  expect(() => releaseIdentity({ MERKUR_VERSION: 'dev', MERKUR_RELEASE_SEQUENCE: '3' })).toThrow(
    'positive sequence',
  );
  expect(() => releaseIdentity({ MERKUR_VERSION: 'v1.0.0', MERKUR_RELEASE_SEQUENCE: '0' })).toThrow(
    'positive sequence',
  );
});

test('a release refuses missing or noncanonical pins before compiling', () => {
  for (const [field, value, error] of [
    ['MERKUR_PUBLIC_ORIGIN', undefined, 'canonical HTTPS origin'],
    ['MERKUR_PUBLIC_ORIGIN', 'http://merkur.test', 'canonical HTTPS origin'],
    ['MERKUR_PUBLIC_ORIGIN', 'https://merkur.test/path', 'canonical HTTPS origin'],
    ['MERKUR_OPAQUE_SERVER_PUBLIC_KEY', undefined, 'exactly 32 bytes'],
    ['MERKUR_OPAQUE_SERVER_PUBLIC_KEY', Buffer.alloc(31).toString('base64url'), 'exactly 32 bytes'],
    ['MERKUR_RELEASE_MLDSA87_PUBLIC_KEY', 'A'.repeat(3455), 'exactly 2592 bytes'],
  ] as const) {
    expect(() => releaseIdentity({ ...release, [field]: value })).toThrow(error);
  }
});

test('the CLI stamps in its version, sequence and release key, and nothing else', () => {
  const args = compileArguments(releaseIdentity(release), '/out/merkur');
  expect(args.slice(0, 5)).toEqual([
    'build',
    expect.stringContaining('apps/daemon/src/index.ts'),
    '--compile',
    '--outfile',
    '/out/merkur',
  ]);
  expect(args.filter((arg) => arg.startsWith('process.env.'))).toEqual([
    'process.env.MERKUR_VERSION="v1.0.0"',
    'process.env.MERKUR_RELEASE_SEQUENCE="1"',
    `process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY="${'A'.repeat(3456)}"`,
  ]);
});
