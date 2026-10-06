import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { e2eWasm } from '@merkur/shared/e2e-wasm-runtime';
import {
  buildSessionDelegationProofTranscript,
  decodeUserAuthorizationBytes,
  deriveSessionDelegationAuthorizationDigest,
  USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
  USER_AUTHORIZATION_SIGNATURE_BYTES,
  verifyDelegationRevocationStatement,
  verifySessionDelegationProof,
} from '@merkur/shared/user-authorization';

import {
  createBrowserDelegation,
  createBrowserRevocation,
  createBrowserSessionProof,
  validateStoredBrowserDelegation,
} from './browser-delegation';
import { deriveUserRootPublicKey } from './user-root';

const SERVER_ORIGIN = 'https://merkur.example';
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

beforeAll(() => {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL(SERVER_ORIGIN),
  });
});

afterAll(() => {
  if (originalLocation === undefined) Reflect.deleteProperty(globalThis, 'location');
  else Object.defineProperty(globalThis, 'location', originalLocation);
});

describe('root-signed browser delegation', () => {
  test('signs the session transcript and a canonical self-revocation', () => {
    const rootSeed = new Uint8Array(32).fill(4);
    const rootPublicKey = deriveUserRootPublicKey(rootSeed);
    const created = createBrowserDelegation(rootSeed, {
      userId: 'user-1',
      serverOrigin: SERVER_ORIGIN,
      rootEpoch: 1,
      issuedAt: 1_000,
      expiresAt: 2_592_001_000,
      delegationId: 'delegation-1',
    });
    try {
      expect(
        validateStoredBrowserDelegation(created.certificate, rootPublicKey, 'user-1', 2_000),
      ).toEqual(created.certificate);
      expect(() =>
        validateStoredBrowserDelegation(
          created.certificate,
          rootPublicKey,
          'user-1',
          created.certificate.expiresAt,
        ),
      ).toThrow();

      const requestTranscript = sessionRequest('signed-session-token');
      const proof = createBrowserSessionProof(
        requestTranscript,
        created.certificate,
        created.delegateSeed,
      );
      const proofTranscript = buildSessionDelegationProofTranscript(
        requestTranscript,
        created.certificate,
      );
      const signature = decodeUserAuthorizationBytes(
        proof.signature,
        USER_AUTHORIZATION_SIGNATURE_BYTES,
        'delegation proof signature',
      );
      const delegatePublicKey = decodeUserAuthorizationBytes(
        created.certificate.delegatePublicKey,
        USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
        'delegate public key',
      );
      try {
        expect(verifySessionDelegationProof(proofTranscript, signature, delegatePublicKey)).toBe(
          true,
        );
        expect(proof.authorizationDigest).toEqual(
          deriveSessionDelegationAuthorizationDigest(proofTranscript, signature),
        );
      } finally {
        proof.authorizationDigest.fill(0);
        proofTranscript.fill(0);
        signature.fill(0);
        delegatePublicKey.fill(0);
      }

      const revocation = createBrowserRevocation(
        created,
        [
          {
            delegationId: created.certificate.delegationId,
            expiresAt: created.certificate.expiresAt,
          },
        ],
        2_000,
      );
      const revocationPublicKey = decodeUserAuthorizationBytes(
        created.certificate.delegatePublicKey,
        USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
        'delegate public key',
      );
      try {
        expect(verifyDelegationRevocationStatement(revocation, revocationPublicKey)).not.toBeNull();
      } finally {
        revocationPublicKey.fill(0);
      }
    } finally {
      rootSeed.fill(0);
      rootPublicKey.fill(0);
      created.delegateSeed.fill(0);
    }
  });
});

/** A canonical session request transcript: the delegate proof only ever signs one. */
function sessionRequest(token: string): Uint8Array {
  return e2eWasm().buildSessionRequestTranscript(
    new TextEncoder().encode(token),
    'session-1',
    'browser-1',
    'daemon-1',
    new Uint8Array(32).fill(0x31),
    new Uint8Array(1_568).fill(0x32),
  );
}
