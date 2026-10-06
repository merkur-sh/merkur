import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { e2eWasm } from './e2e-wasm-runtime';

import {
  buildSessionDelegationProofTranscript,
  createAccountDeletionStatement,
  createDaemonBinding,
  createDaemonLinkApproval,
  createDelegationRevocationStatement,
  createUserDelegationCertificate,
  type DaemonBinding,
  type DelegationRevocationStatement,
  decodeUserAuthorizationBytes,
  deriveDaemonIdentityKeyCommitment,
  deriveDaemonLinkClaimCommitment,
  deriveSessionDelegationAuthorizationDigest,
  deriveUserAuthorizationSigningKey,
  deriveUserRootKeyCommitment,
  encodeUserAuthorizationBytes,
  formatDaemonLinkCode,
  parseAccountDeletionStatement,
  parseDaemonBinding,
  parseDaemonLinkCode,
  parseDelegationRevocationStatement,
  parseUserDelegationCertificate,
  signSessionDelegationProof,
  USER_AUTHORIZATION_HASH_BYTES,
  USER_AUTHORIZATION_SIGNATURE_BYTES,
  USER_DELEGATION_LIFETIME_MS,
  type UserDelegationCertificate,
  verifyAccountDeletionStatement,
  verifyDaemonBinding,
  verifyDaemonLinkApproval,
  verifyDelegationRevocationStatement,
  verifySessionDelegationProof,
  verifyUserDelegationCertificate,
} from './user-authorization';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://merkur.example';

interface UserAuthorizationInteropVector {
  readonly rootSeedHex: string;
  readonly delegateSeedHex: string;
  readonly rootPublicKey: string;
  readonly rootKeyCommitment: string;
  readonly daemonIdentityPublicKey: string;
  readonly daemonIdentityP256PublicKey: string;
  readonly daemonIdentityKeyCommitment: string;
  readonly daemonBinding: DaemonBinding;
  readonly certificate: UserDelegationCertificate;
  readonly requestTranscriptBase64Url: string;
  readonly proofTranscriptBase64Url: string;
  readonly delegationSignature: string;
  readonly authorizationDigest: string;
  readonly revocation: DelegationRevocationStatement;
}

function makeCertificate() {
  const root = deriveUserAuthorizationSigningKey(new Uint8Array(32).fill(0x11));
  const delegate = deriveUserAuthorizationSigningKey(new Uint8Array(32).fill(0x22));
  const rootKeyCommitment = deriveUserRootKeyCommitment(root.publicKey);
  const certificate = createUserDelegationCertificate(
    {
      userId: 'user-1',
      rootKeyCommitment,
      delegationId: 'delegation-1',
      delegatePublicKey: encodeUserAuthorizationBytes(delegate.publicKey),
      scopes: ['terminal-session', 'session-revoke'],
      serverOrigin: ORIGIN,
      rootEpoch: 1,
      issuedAt: NOW,
      expiresAt: NOW + USER_DELEGATION_LIFETIME_MS,
    },
    root,
    new Uint8Array(32).fill(0x33),
  );
  return { root, delegate, rootKeyCommitment, certificate };
}

describe('post-quantum user authorization', () => {
  test('reproduces the deterministic TS-to-Rust user-root interoperability vector', async () => {
    const vector = JSON.parse(
      await readFile(
        new URL('../test-vectors/user-authorization-mldsa87.json', import.meta.url),
        'utf8',
      ),
    ) as UserAuthorizationInteropVector;
    const root = deriveUserAuthorizationSigningKey(
      new Uint8Array(Buffer.from(vector.rootSeedHex, 'hex')),
    );
    const delegate = deriveUserAuthorizationSigningKey(
      new Uint8Array(Buffer.from(vector.delegateSeedHex, 'hex')),
    );
    expect(encodeUserAuthorizationBytes(root.publicKey)).toBe(vector.rootPublicKey);
    expect(deriveUserRootKeyCommitment(root.publicKey)).toBe(vector.rootKeyCommitment);
    expect(encodeUserAuthorizationBytes(delegate.publicKey)).toBe(
      vector.certificate.delegatePublicKey,
    );
    expect(
      deriveDaemonIdentityKeyCommitment(
        decodeUserAuthorizationBytes(vector.daemonIdentityPublicKey, 2_592),
        decodeUserAuthorizationBytes(vector.daemonIdentityP256PublicKey, 65),
      ),
    ).toBe(vector.daemonIdentityKeyCommitment);

    const certificatePayload = {
      userId: vector.certificate.userId,
      rootKeyCommitment: vector.certificate.rootKeyCommitment,
      delegationId: vector.certificate.delegationId,
      delegatePublicKey: vector.certificate.delegatePublicKey,
      scopes: vector.certificate.scopes,
      serverOrigin: vector.certificate.serverOrigin,
      rootEpoch: vector.certificate.rootEpoch,
      issuedAt: vector.certificate.issuedAt,
      expiresAt: vector.certificate.expiresAt,
    };
    expect(
      createUserDelegationCertificate(certificatePayload, root, new Uint8Array(32).fill(0xa1)),
    ).toEqual(vector.certificate);
    const requestTranscript = new Uint8Array(
      Buffer.from(vector.requestTranscriptBase64Url, 'base64url'),
    );
    const proofTranscript = buildSessionDelegationProofTranscript(
      requestTranscript,
      vector.certificate,
    );
    expect(encodeUserAuthorizationBytes(proofTranscript)).toBe(vector.proofTranscriptBase64Url);
    const delegationSignature = signSessionDelegationProof(
      proofTranscript,
      delegate,
      new Uint8Array(32).fill(0xa2),
    );
    expect(encodeUserAuthorizationBytes(delegationSignature)).toBe(vector.delegationSignature);
    expect(
      encodeUserAuthorizationBytes(
        deriveSessionDelegationAuthorizationDigest(proofTranscript, delegationSignature),
      ),
    ).toBe(vector.authorizationDigest);

    const bindingPayload = {
      userId: vector.daemonBinding.userId,
      rootKeyCommitment: vector.daemonBinding.rootKeyCommitment,
      daemonId: vector.daemonBinding.daemonId,
      daemonIdentityKeyCommitment: vector.daemonBinding.daemonIdentityKeyCommitment,
      serverOrigin: vector.daemonBinding.serverOrigin,
      linkClaimId: vector.daemonBinding.linkClaimId,
      issuedAt: vector.daemonBinding.issuedAt,
    };
    expect(createDaemonBinding(bindingPayload, root, new Uint8Array(32).fill(0xa3))).toEqual(
      vector.daemonBinding,
    );
    const revocationPayload = {
      userId: vector.revocation.userId,
      rootKeyCommitment: vector.revocation.rootKeyCommitment,
      actorDelegationId: vector.revocation.actorDelegationId,
      targets: vector.revocation.targets,
      issuedAt: vector.revocation.issuedAt,
      nonce: vector.revocation.nonce,
    };
    expect(
      createDelegationRevocationStatement(
        revocationPayload,
        delegate,
        new Uint8Array(32).fill(0xa5),
      ),
    ).toEqual(vector.revocation);

    root.free();
    delegate.free();
  });

  test('creates and strictly verifies a fixed 30-day root-signed delegation', () => {
    const { root, rootKeyCommitment, certificate } = makeCertificate();
    expect(parseUserDelegationCertificate(certificate)).toEqual(certificate);
    expect(
      verifyUserDelegationCertificate(certificate, root.publicKey, {
        userId: 'user-1',
        rootKeyCommitment,
        delegationId: 'delegation-1',
        serverOrigin: ORIGIN,
        rootEpoch: 1,
        nowMs: NOW,
      }),
    ).toEqual(certificate);
    expect(
      verifyUserDelegationCertificate(
        { ...certificate, serverOrigin: 'https://attacker.example' },
        root.publicKey,
        {
          userId: 'user-1',
          rootKeyCommitment,
          delegationId: 'delegation-1',
          serverOrigin: 'https://attacker.example',
          rootEpoch: 1,
          nowMs: NOW,
        },
      ),
    ).toBeNull();
    expect(
      verifyUserDelegationCertificate(certificate, root.publicKey, {
        userId: 'user-1',
        rootKeyCommitment,
        serverOrigin: ORIGIN,
        rootEpoch: 1,
        nowMs: certificate.expiresAt,
      }),
    ).toBeNull();
    expect(() =>
      parseUserDelegationCertificate({
        ...certificate,
        scopes: ['session-revoke', 'terminal-session'],
      }),
    ).toThrow('fixed canonical scopes');
  });

  test('binds the delegate proof and response authorization digest to the exact request', () => {
    const { delegate, certificate } = makeCertificate();
    const request = sessionRequest('exact-capability-and-ml-kem-request');
    const proof = buildSessionDelegationProofTranscript(request, certificate);
    const signature = signSessionDelegationProof(proof, delegate, new Uint8Array(32).fill(0x44));
    expect(signature).toHaveLength(USER_AUTHORIZATION_SIGNATURE_BYTES);
    expect(verifySessionDelegationProof(proof, signature, delegate.publicKey)).toBe(true);

    const changed = buildSessionDelegationProofTranscript(
      sessionRequest('different-request'),
      certificate,
    );
    expect(verifySessionDelegationProof(changed, signature, delegate.publicKey)).toBe(false);
    const digest = deriveSessionDelegationAuthorizationDigest(proof, signature);
    expect(digest).toHaveLength(USER_AUTHORIZATION_HASH_BYTES);
    const changedSignature = signature.slice();
    changedSignature[0] = (changedSignature[0] ?? 0) ^ 1;
    expect(deriveSessionDelegationAuthorizationDigest(proof, changedSignature)).not.toEqual(digest);
  });

  test('pins a permanent daemon identity to the user root and exact link claim', () => {
    const { root, rootKeyCommitment } = makeCertificate();
    const payload = {
      userId: 'user-1',
      rootKeyCommitment,
      daemonId: 'daemon-1',
      daemonIdentityKeyCommitment: encodeUserAuthorizationBytes(
        new Uint8Array(USER_AUTHORIZATION_HASH_BYTES).fill(7),
      ),
      serverOrigin: ORIGIN,
      linkClaimId: 'claim-1',
      issuedAt: NOW,
    } as const;
    const binding = createDaemonBinding(payload, root, new Uint8Array(32).fill(0x55));
    expect(verifyDaemonBinding(binding, root.publicKey, payload)).toEqual(binding);
    expect(
      verifyDaemonBinding(binding, root.publicKey, { ...payload, daemonId: 'daemon-2' }),
    ).toBeNull();
  });

  test('retains only canonical daemon binding signatures', () => {
    const binding = {
      userId: 'user-1',
      rootKeyCommitment: encodeUserAuthorizationBytes(new Uint8Array(64).fill(1)),
      daemonId: 'daemon-1',
      daemonIdentityKeyCommitment: encodeUserAuthorizationBytes(new Uint8Array(64).fill(2)),
      serverOrigin: ORIGIN,
      linkClaimId: 'claim-1',
      issuedAt: NOW,
      signature: encodeUserAuthorizationBytes(new Uint8Array(USER_AUTHORIZATION_SIGNATURE_BYTES)),
    };
    expect(parseDaemonBinding(binding)).toEqual(binding);
    const noncanonicalTail = `${binding.signature.slice(0, -1)}B`;
    // The last byte's unused pad bits must be zero, even when decoding gives identical bytes.
    expect(Buffer.from(noncanonicalTail, 'base64url')).toEqual(
      Buffer.from(binding.signature, 'base64url'),
    );
    for (const signature of [
      null,
      42,
      '',
      `${binding.signature}=`,
      `+${binding.signature.slice(1)}`,
      binding.signature.slice(1),
      noncanonicalTail,
    ]) {
      expect(() => parseDaemonBinding({ ...binding, signature })).toThrow();
    }
    expect(() => parseDaemonBinding({ ...binding, extra: true })).toThrow('canonical');
  });

  test('signs sorted, bounded multi-browser revocations with the acting delegate', () => {
    const { delegate, rootKeyCommitment } = makeCertificate();
    const statement = createDelegationRevocationStatement(
      {
        userId: 'user-1',
        rootKeyCommitment,
        actorDelegationId: 'delegation-1',
        targets: [
          { delegationId: 'delegation-2', expiresAt: NOW + USER_DELEGATION_LIFETIME_MS },
          { delegationId: 'delegation-3', expiresAt: NOW + USER_DELEGATION_LIFETIME_MS },
        ],
        issuedAt: NOW,
        nonce: encodeUserAuthorizationBytes(new Uint8Array(32).fill(0x66)),
      },
      delegate,
      new Uint8Array(32).fill(0x77),
    );
    expect(parseDelegationRevocationStatement(statement)).toEqual(statement);
    expect(verifyDelegationRevocationStatement(statement, delegate.publicKey)).toEqual(statement);
    expect(
      verifyDelegationRevocationStatement(
        { ...statement, actorDelegationId: 'delegation-9' },
        delegate.publicKey,
      ),
    ).toBeNull();
    expect(() =>
      createDelegationRevocationStatement(
        {
          userId: statement.userId,
          rootKeyCommitment: statement.rootKeyCommitment,
          actorDelegationId: statement.actorDelegationId,
          targets: [...statement.targets].reverse(),
          issuedAt: statement.issuedAt,
          nonce: statement.nonce,
        },
        delegate,
      ),
    ).toThrow('sorted');
  });

  test('authenticates the complete daemon link claim and root approval with the OOB secret', () => {
    const { root, rootKeyCommitment } = makeCertificate();
    const linkSecret = new Uint8Array(32).fill(0x81);
    const serverNonce = new Uint8Array(32).fill(0x82);
    const p256Key = Buffer.from(
      'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',
      'base64url',
    );
    const daemonIdentityKeyCommitment = deriveDaemonIdentityKeyCommitment(root.publicKey, p256Key);
    const claim = {
      linkClaimId: 'claim-1',
      daemonId: 'daemon-1',
      daemonIdentityPublicKey: encodeUserAuthorizationBytes(root.publicKey),
      daemonIdentityP256PublicKey: encodeUserAuthorizationBytes(p256Key),
      daemonIdentityKeyCommitment,
      name: 'workstation',
      platform: 'darwin-arm64',
      identitySealBackend: 'software',
    } as const;
    const claimCommitment = deriveDaemonLinkClaimCommitment(claim, linkSecret);
    expect(
      deriveDaemonLinkClaimCommitment({ ...claim, daemonId: 'substituted-daemon' }, linkSecret),
    ).not.toBe(claimCommitment);

    expect(
      deriveDaemonLinkClaimCommitment({ ...claim, identitySealBackend: 'hardware' }, linkSecret),
    ).not.toBe(claimCommitment);
    const otherMldsa = root.publicKey.slice();
    otherMldsa[0] = (otherMldsa[0] ?? 0) ^ 1;
    expect(deriveDaemonIdentityKeyCommitment(otherMldsa, p256Key)).not.toBe(
      daemonIdentityKeyCommitment,
    );
    // Negating the generator's y coordinate gives a different valid P-256 key.
    const field = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
    const otherP256 = Buffer.from(p256Key);
    const y = BigInt(`0x${otherP256.subarray(33).toString('hex')}`);
    Buffer.from((field - y).toString(16).padStart(64, '0'), 'hex').copy(otherP256, 33);
    const otherCommitment = deriveDaemonIdentityKeyCommitment(root.publicKey, otherP256);
    expect(otherCommitment).not.toBe(daemonIdentityKeyCommitment);
    expect(
      deriveDaemonLinkClaimCommitment(
        {
          ...claim,
          daemonIdentityP256PublicKey: otherP256.toString('base64url'),
          daemonIdentityKeyCommitment: otherCommitment,
        },
        linkSecret,
      ),
    ).not.toBe(claimCommitment);

    const daemonBinding = createDaemonBinding(
      {
        userId: 'user-1',
        rootKeyCommitment,
        daemonId: claim.daemonId,
        daemonIdentityKeyCommitment,
        serverOrigin: ORIGIN,
        linkClaimId: claim.linkClaimId,
        issuedAt: NOW,
      },
      root,
      new Uint8Array(32).fill(0x84),
    );
    const approval = createDaemonLinkApproval(
      {
        linkClaimId: claim.linkClaimId,
        claimCommitment,
        userRootPublicKey: encodeUserAuthorizationBytes(root.publicKey),
        rootEpoch: 1,
        daemonBinding,
      },
      serverNonce,
      linkSecret,
    );
    expect(verifyDaemonLinkApproval(approval, serverNonce, linkSecret)).toEqual(approval);
    expect(
      verifyDaemonLinkApproval({ ...approval, rootEpoch: 2 }, serverNonce, linkSecret),
    ).toBeNull();

    const code = formatDaemonLinkCode(claim.linkClaimId, linkSecret);
    const parsedCode = parseDaemonLinkCode(code);
    expect(parsedCode.linkClaimId).toBe(claim.linkClaimId);
    expect(parsedCode.linkSecret).toEqual(linkSecret);
  });

  test('verifies an account deletion signed by the user root key', () => {
    const { root, rootKeyCommitment } = makeCertificate();
    const statement = createAccountDeletionStatement(
      {
        userId: 'user-1',
        rootKeyCommitment,
        rootEpoch: 1,
        issuedAt: NOW,
        nonce: encodeUserAuthorizationBytes(new Uint8Array(32).fill(0x44)),
      },
      root,
      new Uint8Array(32).fill(0x55),
    );

    expect(verifyAccountDeletionStatement(statement, root.publicKey)).toEqual(statement);
    expect(parseAccountDeletionStatement(statement)).toEqual(statement);
  });

  test('refuses an account deletion that a delegate signed', () => {
    const { root, delegate, rootKeyCommitment } = makeCertificate();
    // A delegate holds a browser session; it must not be able to erase the
    // account, because only the root key is gated behind the password.
    const statement = createAccountDeletionStatement(
      {
        userId: 'user-1',
        rootKeyCommitment,
        rootEpoch: 1,
        issuedAt: NOW,
        nonce: encodeUserAuthorizationBytes(new Uint8Array(32).fill(0x44)),
      },
      delegate,
    );

    expect(verifyAccountDeletionStatement(statement, root.publicKey)).toBeNull();
  });

  test('refuses an account deletion whose payload was edited after signing', () => {
    const { root, rootKeyCommitment } = makeCertificate();
    const statement = createAccountDeletionStatement(
      {
        userId: 'user-1',
        rootKeyCommitment,
        rootEpoch: 1,
        issuedAt: NOW,
        nonce: encodeUserAuthorizationBytes(new Uint8Array(32).fill(0x44)),
      },
      root,
    );

    // Every signed field is covered: swapping the victim, replaying across a
    // root rotation, or back-dating the request all break the signature.
    expect(
      verifyAccountDeletionStatement({ ...statement, userId: 'user-2' }, root.publicKey),
    ).toBeNull();
    expect(
      verifyAccountDeletionStatement({ ...statement, rootEpoch: 2 }, root.publicKey),
    ).toBeNull();
    expect(
      verifyAccountDeletionStatement({ ...statement, issuedAt: NOW - 1 }, root.publicKey),
    ).toBeNull();
  });

  test('refuses an account deletion with unexpected or missing fields', () => {
    const { root, rootKeyCommitment } = makeCertificate();
    const statement = createAccountDeletionStatement(
      {
        userId: 'user-1',
        rootKeyCommitment,
        rootEpoch: 1,
        issuedAt: NOW,
        nonce: encodeUserAuthorizationBytes(new Uint8Array(32).fill(0x44)),
      },
      root,
    );
    const { nonce: _nonce, ...withoutNonce } = statement;

    expect(() => parseAccountDeletionStatement({ ...statement, extra: 1 })).toThrow();
    expect(() => parseAccountDeletionStatement(withoutNonce)).toThrow();
    expect(verifyAccountDeletionStatement({ ...statement, extra: 1 }, root.publicKey)).toBeNull();
  });

  test('uses strict canonical base64url decoding', () => {
    const bytes = new Uint8Array(64).fill(0xa5);
    const encoded = encodeUserAuthorizationBytes(bytes);
    expect(decodeUserAuthorizationBytes(encoded, 64)).toEqual(bytes);
    expect(() => decodeUserAuthorizationBytes(`${encoded}=`, 64)).toThrow('canonical');
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
