import { expect, test } from 'bun:test';
import { publicReleaseEnvironment } from './public-release-context';

const settings = {
  version: 'v0.2.0',
  sequence: 2,
  releasePublicKey: Buffer.alloc(2592, 43).toString('base64url'),
  origin: 'https://merkur.example',
  opaquePublicKey: Buffer.alloc(32).toString('base64url'),
};

test('shared native environment binds the exact public signed release context', () => {
  expect(publicReleaseEnvironment(settings)).toEqual({
    MERKUR_VERSION: settings.version,
    MERKUR_RELEASE_SEQUENCE: '2',
    MERKUR_RELEASE_MLDSA87_PUBLIC_KEY: settings.releasePublicKey,
    MERKUR_PUBLIC_ORIGIN: settings.origin,
    MERKUR_OPAQUE_SERVER_PUBLIC_KEY: settings.opaquePublicKey,
  });
  expect(publicReleaseEnvironment({ ...settings, version: 'dev', sequence: 0 })).toEqual({
    MERKUR_VERSION: 'dev',
  });
});

test('missing, malformed, noncanonical and unreserved public trust fails closed', () => {
  for (const change of [
    { version: '' },
    { version: 'dev\nINJECTED=value' },
    { version: 'v00.2.0' },
    { sequence: 0 },
    { sequence: -1 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { sequence: 1.5 },
    { releasePublicKey: '' },
    { releasePublicKey: settings.releasePublicKey + '=' },
    { origin: 'http://merkur.example' },
    { origin: 'https://merkur.example/' },
    { origin: 'https://user:secret@merkur.example' }, // trufflehog:ignore
    { origin: 'https://MERKUR.example' },
    { opaquePublicKey: '' },
    { opaquePublicKey: settings.opaquePublicKey + '=' },
  ])
    expect(() => publicReleaseEnvironment({ ...settings, ...change })).toThrow();
});
