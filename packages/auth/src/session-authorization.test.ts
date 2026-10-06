import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { e2eWasm } from '@merkur/shared/e2e-wasm-runtime';
import { deriveSoftwareDaemonP256PublicKey } from './daemon-proof';

import {
  createSessionAuthorizationToken,
  deriveDaemonIdentityKeyCommitment,
  deriveSessionAuthorizationKeyPair,
  deriveSessionRequestCommitment,
  SESSION_AUTHORIZATION_COMMITMENT_BYTES,
  SESSION_AUTHORIZATION_PUBLIC_KEY_BYTES,
  SESSION_AUTHORIZATION_SIGNATURE_BYTES,
  verifySessionAuthorizationToken,
} from './session-authorization';

const P256_PUBLIC_KEY = deriveSoftwareDaemonP256PublicKey(new Uint8Array(32).fill(0x41));
const ISSUED_AT_MS = 1_800_000_000_000;
const EXPIRES_AT_MS = ISSUED_AT_MS + 60_000;
const DAEMON_IDENTITY_KEY_COMMITMENT = deriveDaemonIdentityKeyCommitment(
  new Uint8Array(SESSION_AUTHORIZATION_PUBLIC_KEY_BYTES).fill(0x41),
  P256_PUBLIC_KEY,
);
const SESSION_REQUEST_COMMITMENT = deriveSessionRequestCommitment(
  new Uint8Array(32).fill(0x42),
  new Uint8Array(1_568).fill(0x43),
);

interface SessionAuthorizationInteropVector {
  readonly algorithm: 'ML-DSA-87';
  readonly context: string;
  readonly seedHex: string;
  readonly extraEntropyHex: string;
  readonly verifyKeyBase64Url: string;
  readonly token: string;
  readonly payload: {
    readonly u: string;
    readonly g: string;
    readonly b: string;
    readonly d: string;
    readonly s: string;
    readonly k: string;
    readonly q: string;
    readonly iat: number;
    readonly e: number;
  };
  readonly verifyAtMs: number;
}

describe('ML-DSA-87 session authorization', () => {
  test('derives fixed domain-separated daemon and browser-bootstrap commitments', () => {
    expect(Buffer.from(DAEMON_IDENTITY_KEY_COMMITMENT, 'base64url')).toHaveLength(
      SESSION_AUTHORIZATION_COMMITMENT_BYTES,
    );
    expect(Buffer.from(SESSION_REQUEST_COMMITMENT, 'base64url')).toHaveLength(
      SESSION_AUTHORIZATION_COMMITMENT_BYTES,
    );
    expect(DAEMON_IDENTITY_KEY_COMMITMENT).not.toBe(SESSION_REQUEST_COMMITMENT);
    expect(
      deriveSessionRequestCommitment(
        new Uint8Array(32).fill(0x42),
        new Uint8Array(1_568).fill(0x44),
      ),
    ).not.toBe(SESSION_REQUEST_COMMITMENT);
    expect(() => deriveDaemonIdentityKeyCommitment(new Uint8Array(2_591), P256_PUBLIC_KEY)).toThrow(
      'daemon identity public key',
    );
    expect(() => deriveSessionRequestCommitment(new Uint8Array(31), new Uint8Array(1_568))).toThrow(
      'session client nonce',
    );
  });

  test('the production signer reproduces the committed interoperability vector', async () => {
    const vector = JSON.parse(
      await readFile(
        new URL('../../shared/test-vectors/session-authorization-mldsa87.json', import.meta.url),
        'utf8',
      ),
    ) as SessionAuthorizationInteropVector;
    const encoder = new TextEncoder();
    const seed = new Uint8Array(Buffer.from(vector.seedHex, 'hex'));
    const extraEntropy = new Uint8Array(Buffer.from(vector.extraEntropyHex, 'hex'));
    const key = e2eWasm().MlDsa87SigningKey.fromSeed(seed);
    const publicKey = key.publicKey;
    const payloadSegment = Buffer.from(JSON.stringify(vector.payload)).toString('base64url');
    const signature = key.sign(
      encoder.encode(vector.context),
      encoder.encode(payloadSegment),
      extraEntropy,
    );

    expect(vector.algorithm).toBe('ML-DSA-87');
    expect(Buffer.from(publicKey).toString('base64url')).toBe(vector.verifyKeyBase64Url);
    expect(`${payloadSegment}.${Buffer.from(signature).toString('base64url')}`).toBe(vector.token);
    expect(verifySessionAuthorizationToken(vector.token, publicKey, vector.verifyAtMs)).toEqual(
      vector.payload,
    );

    seed.fill(0);
    extraEntropy.fill(0);
    key.free();
    signature.fill(0);
  });

  test('derives the fixed key sizes and binds every canonical payload field', () => {
    const keys = deriveSessionAuthorizationKeyPair(new Uint8Array(32).fill(7));
    expect(keys.verifyKey).toHaveLength(SESSION_AUTHORIZATION_PUBLIC_KEY_BYTES);

    const token = createSessionAuthorizationToken({
      userId: 'user-1',
      delegationId: 'delegation-1',
      browserNodeId: 'browser-1',
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
      sessionRequestCommitment: SESSION_REQUEST_COMMITMENT,
      issuedAtMs: ISSUED_AT_MS,
      expiresAtMs: EXPIRES_AT_MS,
      signingKey: keys.signingKey,
    });

    const [payloadSegment, signatureSegment] = token.split('.');
    expect(Buffer.from(signatureSegment ?? '', 'base64url')).toHaveLength(
      SESSION_AUTHORIZATION_SIGNATURE_BYTES,
    );
    expect(JSON.parse(Buffer.from(payloadSegment ?? '', 'base64url').toString('utf8'))).toEqual({
      u: 'user-1',
      g: 'delegation-1',
      b: 'browser-1',
      d: 'daemon-1',
      s: 'session-1',
      k: DAEMON_IDENTITY_KEY_COMMITMENT,
      q: SESSION_REQUEST_COMMITMENT,
      iat: ISSUED_AT_MS,
      e: EXPIRES_AT_MS,
    });
    expect(verifySessionAuthorizationToken(token, keys.verifyKey, ISSUED_AT_MS)).toEqual({
      u: 'user-1',
      g: 'delegation-1',
      b: 'browser-1',
      d: 'daemon-1',
      s: 'session-1',
      k: DAEMON_IDENTITY_KEY_COMMITMENT,
      q: SESSION_REQUEST_COMMITMENT,
      iat: ISSUED_AT_MS,
      e: EXPIRES_AT_MS,
    });
  });

  test('uses hedged signing and rejects tampering, expiry, and noncanonical encoding', () => {
    const keys = deriveSessionAuthorizationKeyPair(new Uint8Array(32).fill(9));
    const input = {
      userId: 'user-1',
      delegationId: 'delegation-1',
      browserNodeId: 'browser-1',
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
      sessionRequestCommitment: SESSION_REQUEST_COMMITMENT,
      issuedAtMs: ISSUED_AT_MS,
      expiresAtMs: EXPIRES_AT_MS,
      signingKey: keys.signingKey,
    } as const;
    const first = createSessionAuthorizationToken(input);
    const second = createSessionAuthorizationToken(input);
    expect(first).not.toBe(second);

    const [payload, signature] = first.split('.') as [string, string];
    const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;
    expect(
      verifySessionAuthorizationToken(
        `${tamperedPayload}.${signature}`,
        keys.verifyKey,
        ISSUED_AT_MS,
      ),
    ).toBeNull();
    expect(verifySessionAuthorizationToken(first, keys.verifyKey, EXPIRES_AT_MS)).toBeNull();
    expect(
      verifySessionAuthorizationToken(`${payload}=.${signature}`, keys.verifyKey, ISSUED_AT_MS),
    ).toBeNull();
  });

  test('rejects overlong or non-positive lifetimes before signing', () => {
    const keys = deriveSessionAuthorizationKeyPair(new Uint8Array(32).fill(3));
    const create = (expiresAtMs: number) =>
      createSessionAuthorizationToken({
        userId: 'user-1',
        delegationId: 'delegation-1',
        browserNodeId: 'browser-1',
        daemonId: 'daemon-1',
        sessionId: 'session-1',
        daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
        sessionRequestCommitment: SESSION_REQUEST_COMMITMENT,
        issuedAtMs: ISSUED_AT_MS,
        expiresAtMs,
        signingKey: keys.signingKey,
      });

    expect(() => create(ISSUED_AT_MS)).toThrow('lifetime');
    expect(() => create(ISSUED_AT_MS + 300_001)).toThrow('lifetime');
    expect(() =>
      createSessionAuthorizationToken({
        userId: 'user with spaces',
        delegationId: 'delegation-1',
        browserNodeId: 'browser-1',
        daemonId: 'daemon-1',
        sessionId: 'session-1',
        daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
        sessionRequestCommitment: SESSION_REQUEST_COMMITMENT,
        issuedAtMs: ISSUED_AT_MS,
        expiresAtMs: EXPIRES_AT_MS,
        signingKey: keys.signingKey,
      }),
    ).toThrow('protocol id alphabet');
  });
});
