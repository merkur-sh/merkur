import { describe, expect, test } from 'bun:test';
import { e2eWasm } from '@merkur/shared/e2e-wasm-runtime';

import {
  createDaemonNonce,
  daemonBodyDigest,
  daemonControlTranscript,
  daemonHttpProofHeaders,
  daemonHttpTranscript,
  deriveSoftwareDaemonP256PublicKey,
  parseDaemonChallenge,
  parseDaemonControlSignature,
  parseDaemonHttpProof,
  signDaemonProof,
  verifyDaemonProof,
} from './daemon-proof';

const SEED = Buffer.alloc(32, 0x22).toString('base64url');
const PUBLIC_KEY = Buffer.from(
  e2eWasm().MlDsa87SigningKey.fromSeed(Buffer.from(SEED, 'base64url')).publicKey,
).toString('base64url');
const P256_PUBLIC_KEY = Buffer.from(
  deriveSoftwareDaemonP256PublicKey(Buffer.from(SEED, 'base64url')),
).toString('base64url');
const URL = 'https://merkur.test/api/daemon/perf';
const NOW = 1_800_000_000_000;
const BODY = new TextEncoder().encode('{"value":1}');

describe('daemon identity proofs', () => {
  test('binds every HTTP component and separates cryptographic purposes', async () => {
    const headers = new Headers(
      await daemonHttpProofHeaders(
        'daemon-1',
        async (transcript) => signDaemonProof(SEED, 'http', transcript),
        'POST',
        URL,
        'application/json',
        BODY,
        NOW,
      ),
    );
    const proof = parseDaemonHttpProof(headers, NOW);
    if (proof === null) throw new Error('missing proof');
    const digest = daemonBodyDigest(BODY);
    const transcript = daemonHttpTranscript(proof, 'POST', URL, 'application/json', digest);
    expect(
      verifyDaemonProof(
        PUBLIC_KEY,
        P256_PUBLIC_KEY,
        'http',
        transcript,
        proof.signature,
        proof.p256Signature,
      ),
    ).toBe(true);
    expect(
      verifyDaemonProof(
        PUBLIC_KEY,
        P256_PUBLIC_KEY,
        'control',
        transcript,
        proof.signature,
        proof.p256Signature,
      ),
    ).toBe(false);
    for (const changed of [
      daemonHttpTranscript(
        { ...proof, daemonId: 'daemon-2' },
        'POST',
        URL,
        'application/json',
        digest,
      ),
      daemonHttpTranscript(
        { ...proof, timestamp: NOW + 1 },
        'POST',
        URL,
        'application/json',
        digest,
      ),
      daemonHttpTranscript(
        { ...proof, nonce: createDaemonNonce() },
        'POST',
        URL,
        'application/json',
        digest,
      ),
      daemonHttpTranscript(proof, 'PUT', URL, 'application/json', digest),
      daemonHttpTranscript(proof, 'POST', `${URL}?x=1`, 'application/json', digest),
      daemonHttpTranscript(
        proof,
        'POST',
        URL.replace('merkur.test', 'other.test'),
        'application/json',
        digest,
      ),
      daemonHttpTranscript(proof, 'POST', URL, 'text/plain', digest),
      daemonHttpTranscript(
        proof,
        'POST',
        URL,
        'application/json',
        daemonBodyDigest(new Uint8Array()),
      ),
    ])
      expect(
        verifyDaemonProof(
          PUBLIC_KEY,
          P256_PUBLIC_KEY,
          'http',
          changed,
          proof.signature,
          proof.p256Signature,
        ),
      ).toBe(false);
  });

  test('bounds time and rejects duplicate, noncanonical and retired headers', async () => {
    const original = await daemonHttpProofHeaders(
      'daemon-1',
      async (transcript) => signDaemonProof(SEED, 'http', transcript),
      'POST',
      URL,
      'application/json',
      BODY,
      NOW,
    );
    expect(parseDaemonHttpProof(new Headers(original), NOW + 59_999)).not.toBeNull();
    expect(parseDaemonHttpProof(new Headers(original), NOW + 60_000)).toBeNull();
    expect(parseDaemonHttpProof(new Headers(original), NOW - 30_000)).not.toBeNull();
    expect(parseDaemonHttpProof(new Headers(original), NOW - 30_001)).toBeNull();
    for (const [field, value] of [
      ['authorization', 'Bearer copied-key'],
      ['content-encoding', 'identity'],
      ['x-merkur-timestamp', `0${NOW}`],
      ['x-merkur-nonce', `${original['x-merkur-nonce']}=`],
      ['x-merkur-signature', 'invalid'],
      ['x-merkur-daemon-id', 'daemon-1, daemon-1'],
    ]) {
      if (field === undefined || value === undefined) throw new Error('fixture');
      expect(parseDaemonHttpProof(new Headers({ ...original, [field]: value }), NOW)).toBeNull();
    }
  });

  test('binds a control proof to its challenge, destination and connection metadata', () => {
    const nonce = createDaemonNonce();
    const control = 'https://merkur.test/api/daemon/control';
    const transcript = daemonControlTranscript('daemon-1', control, 'dev', null, nonce);
    const signature = signDaemonProof(SEED, 'control', transcript);
    expect(
      verifyDaemonProof(
        PUBLIC_KEY,
        P256_PUBLIC_KEY,
        'control',
        transcript,
        signature.mldsa,
        signature.p256,
      ),
    ).toBe(true);
    for (const changed of [
      daemonControlTranscript('daemon-1', control, 'dev', null, createDaemonNonce()),
      daemonControlTranscript('daemon-2', control, 'dev', null, nonce),
      daemonControlTranscript('daemon-1', control, 'changed', null, nonce),
      daemonControlTranscript('daemon-1', control, 'dev', 'presence-id', nonce),
      daemonControlTranscript(
        'daemon-1',
        control.replace('merkur.test', 'other.test'),
        'dev',
        null,
        nonce,
      ),
    ])
      expect(
        verifyDaemonProof(
          PUBLIC_KEY,
          P256_PUBLIC_KEY,
          'control',
          changed,
          signature.mldsa,
          signature.p256,
        ),
      ).toBe(false);
    expect(parseDaemonChallenge(JSON.stringify({ type: 'auth_challenge', nonce }))).toBe(nonce);
    expect(parseDaemonChallenge({ type: 'auth_challenge', nonce, extra: true })).toBeNull();
    expect(
      parseDaemonControlSignature({
        type: 'auth_proof',
        signature: signature.mldsa,
        p256_signature: signature.p256,
      }),
    ).toEqual(signature);
    expect(
      parseDaemonControlSignature({ type: 'auth_proof', signature: `${signature}=` }),
    ).toBeNull();
  });
});

test('requires both signatures and rejects high-S P-256 malleability', () => {
  const transcript = daemonControlTranscript(
    'daemon-1',
    'https://merkur.test/api/daemon/control',
    '',
    null,
    createDaemonNonce(),
  );
  const pair = signDaemonProof(SEED, 'control', transcript);
  expect(
    verifyDaemonProof(PUBLIC_KEY, P256_PUBLIC_KEY, 'control', transcript, pair.mldsa, ''),
  ).toBe(false);
  expect(verifyDaemonProof(PUBLIC_KEY, P256_PUBLIC_KEY, 'control', transcript, '', pair.p256)).toBe(
    false,
  );
  const sig = Buffer.from(pair.p256, 'base64url');
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const highS = order - BigInt(`0x${sig.subarray(32).toString('hex')}`);
  Buffer.from(highS.toString(16).padStart(64, '0'), 'hex').copy(sig, 32);
  expect(
    verifyDaemonProof(
      PUBLIC_KEY,
      P256_PUBLIC_KEY,
      'control',
      transcript,
      pair.mldsa,
      sig.toString('base64url'),
    ),
  ).toBe(false);
});

test('verifies the committed composite identity vector', async () => {
  const vector = await Bun.file(
    new globalThis.URL('../../shared/test-vectors/daemon-identity-composite.json', import.meta.url),
  ).json();
  const transcript = Buffer.from(vector.transcript, 'base64url');
  expect(
    Buffer.from(deriveSoftwareDaemonP256PublicKey(Buffer.from(vector.seedHex, 'hex'))).toString(
      'base64url',
    ),
  ).toBe(vector.p256PublicKey);
  expect(
    verifyDaemonProof(
      vector.mldsaPublicKey,
      vector.p256PublicKey,
      'control',
      transcript,
      vector.mldsaSignature,
      vector.p256Signature,
    ),
  ).toBe(true);
});
