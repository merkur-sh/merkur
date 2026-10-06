import { beforeEach, describe, expect, test } from 'bun:test';
import { createLinkToken, deriveSoftwareDaemonP256PublicKey, hashToken } from '@merkur/auth';
import { DaemonLinkClaimInspectResponse } from '@merkur/shared/api-schema';
import {
  createDaemonBinding,
  createDaemonLinkApproval,
  createDelegationRevocationStatement,
  createUserDelegationCertificate,
  deriveDaemonIdentityKeyCommitment,
  deriveDaemonLinkClaimCommitment,
  deriveUserAuthorizationSigningKey,
  deriveUserRootKeyCommitment,
  encodeUserAuthorizationBytes,
  USER_DELEGATION_LIFETIME_MS,
} from '@merkur/shared/user-authorization';
import { Effect } from 'effect';
import type { Kysely } from 'kysely';
import { Value } from 'typebox/value';

import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import { createDaemonLinkClaimService, DaemonLinkClaimError } from './daemon-link-claim-service';
import { MAX_LINKED_MACHINES, readMachineUsage } from './machine-usage';

const ORIGIN = 'https://merkur.test';
const HMAC_SECRET = 'link-claim-test-secret';
const ROOT = deriveUserAuthorizationSigningKey(new Uint8Array(32).fill(0x11));
const ROOT_PUBLIC_KEY = encodeUserAuthorizationBytes(ROOT.publicKey);
const ROOT_KEY_COMMITMENT = deriveUserRootKeyCommitment(ROOT.publicKey);
const DAEMON_IDENTITY = deriveUserAuthorizationSigningKey(new Uint8Array(32).fill(0x22));
const DAEMON_IDENTITY_PUBLIC_KEY = encodeUserAuthorizationBytes(DAEMON_IDENTITY.publicKey);
const DAEMON_IDENTITY_KEY_COMMITMENT = deriveDaemonIdentityKeyCommitment(
  DAEMON_IDENTITY.publicKey,
  deriveSoftwareDaemonP256PublicKey(new Uint8Array(32).fill(0x22)),
);

let db: Kysely<DatabaseSchema>;

beforeEach(async () => {
  db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
  await db
    .insertInto('users')
    .values({
      id: 'user-1',
      username: 'user@example.com',
      opaque_registration_record: 'A'.repeat(256),
      root_public_key: ROOT_PUBLIC_KEY,
      root_key_commitment: ROOT_KEY_COMMITMENT,
      root_epoch: 1,
      root_envelope_nonce: 'A'.repeat(16),
      root_envelope_ciphertext: 'A'.repeat(64),
      created_at: 1,
    })
    .execute();
});

describe('DaemonLinkClaimService', () => {
  test('inspects the committed identity and preserves another same-name daemon on completion', async () => {
    const service = createDaemonLinkClaimService(db, {
      publicOrigin: ORIGIN,
      tokenHmacSecret: HMAC_SECRET,
      sessionTokenVerifyKey: 'V'.repeat(3_456),
    });
    const admission = createLinkToken();
    await db
      .insertInto('link_tokens')
      .values({
        token_hash: hashToken(admission.token, HMAC_SECRET, 'device-link'),
        user_id: 'user-1',
        expires_at: admission.expiresAt,
        used_at: null,
        box_id: 'box-a',
      })
      .execute();
    const linkSecret = new Uint8Array(32).fill(0x33);
    const publicClaim = {
      linkClaimId: 'claim-1',
      daemonId: 'daemon-new',
      daemonIdentityPublicKey: DAEMON_IDENTITY_PUBLIC_KEY,
      daemonIdentityP256PublicKey: Buffer.from(
        deriveSoftwareDaemonP256PublicKey(new Uint8Array(32).fill(0x22)),
      ).toString('base64url'),
      daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
      name: 'Shared name',
      platform: 'darwin',
      identitySealBackend: 'software',
    } as const;
    const claimCommitment = deriveDaemonLinkClaimCommitment(publicClaim, linkSecret);
    const created = await Effect.runPromise(
      service.create({
        linkToken: admission.token,
        ...publicClaim,
        claimCommitment,
      }),
    );

    const inspected = await Effect.runPromise(service.inspect('user-1', publicClaim.linkClaimId));
    expect(inspected).toMatchObject({ ...publicClaim, claimCommitment });
    expect(inspected.serverNonce).toBe(created.serverNonce);
    expect(inspected.serverTimeMs).toBeGreaterThan(0);

    const daemonBinding = createDaemonBinding(
      {
        userId: 'user-1',
        rootKeyCommitment: ROOT_KEY_COMMITMENT,
        daemonId: publicClaim.daemonId,
        daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
        serverOrigin: ORIGIN,
        linkClaimId: publicClaim.linkClaimId,
        issuedAt: inspected.serverTimeMs,
      },
      ROOT,
    );
    const approval = createDaemonLinkApproval(
      {
        linkClaimId: publicClaim.linkClaimId,
        claimCommitment,
        userRootPublicKey: ROOT_PUBLIC_KEY,
        rootEpoch: 1,
        daemonBinding,
      },
      new Uint8Array(Buffer.from(created.serverNonce, 'base64url')),
      linkSecret,
    );
    await Effect.runPromise(service.approve('user-1', publicClaim.linkClaimId, approval));
    const polled = await Effect.runPromise(
      service.poll(publicClaim.linkClaimId, created.pollToken),
    );
    expect(polled.status).toBe('approved');

    await db
      .insertInto('daemons')
      .values({
        id: 'daemon-existing',
        user_id: 'user-1',
        name: publicClaim.name,
        platform: publicClaim.platform,
        daemon_identity_public_key: 'existing-public-key',
        daemon_identity_p256_public_key: 'existing-p256-key',
        identity_seal_backend: 'software',
        daemon_identity_key_commitment: 'existing-key-commitment',
        daemon_binding_json: '{"existing":true}',
        last_seen: 1,
        version: 'existing',
      })
      .execute();
    const revocationActor = deriveUserAuthorizationSigningKey(new Uint8Array(32).fill(0x44));
    const revocationIssuedAt = Date.now() - 1_000;
    const actorCertificate = createUserDelegationCertificate(
      {
        userId: 'user-1',
        rootKeyCommitment: ROOT_KEY_COMMITMENT,
        delegationId: 'delegation-revocation-actor',
        delegatePublicKey: encodeUserAuthorizationBytes(revocationActor.publicKey),
        scopes: ['terminal-session', 'session-revoke'],
        serverOrigin: ORIGIN,
        rootEpoch: 1,
        issuedAt: revocationIssuedAt,
        expiresAt: revocationIssuedAt + USER_DELEGATION_LIFETIME_MS,
      },
      ROOT,
    );
    const makeRevocation = (delegationId: string, nonceByte: number, expiresAt: number) =>
      createDelegationRevocationStatement(
        {
          userId: 'user-1',
          rootKeyCommitment: ROOT_KEY_COMMITMENT,
          actorDelegationId: actorCertificate.delegationId,
          targets: [{ delegationId, expiresAt }],
          issuedAt: revocationIssuedAt,
          nonce: encodeUserAuthorizationBytes(new Uint8Array(32).fill(nonceByte)),
        },
        revocationActor,
      );
    const oldLive = makeRevocation(
      'delegation-old-live',
      0x45,
      revocationIssuedAt + USER_DELEGATION_LIFETIME_MS,
    );
    const expired = makeRevocation('delegation-expired', 0x46, revocationIssuedAt);
    const newLive = makeRevocation(
      'delegation-new-live',
      0x47,
      revocationIssuedAt + USER_DELEGATION_LIFETIME_MS,
    );
    await db
      .insertInto('delegation_revocations')
      .values([
        {
          nonce: oldLive.nonce,
          user_id: 'user-1',
          actor_delegation_id: actorCertificate.delegationId,
          actor_certificate_json: JSON.stringify(actorCertificate),
          revocation_json: JSON.stringify(oldLive),
          revoked_count: 1,
          created_at: revocationIssuedAt,
        },
        {
          nonce: expired.nonce,
          user_id: 'user-1',
          actor_delegation_id: actorCertificate.delegationId,
          actor_certificate_json: JSON.stringify(actorCertificate),
          revocation_json: JSON.stringify(expired),
          revoked_count: 1,
          created_at: revocationIssuedAt + 1,
        },
        {
          nonce: newLive.nonce,
          user_id: 'user-1',
          actor_delegation_id: actorCertificate.delegationId,
          actor_certificate_json: JSON.stringify(actorCertificate),
          revocation_json: JSON.stringify(newLive),
          revoked_count: 1,
          created_at: revocationIssuedAt + 2,
        },
      ])
      .execute();
    await Effect.runPromise(
      service.complete(publicClaim.linkClaimId, created.pollToken, approval.approvalMac),
    );

    // The box the token was minted for rides the claim onto the new daemon only.
    expect(
      await db.selectFrom('daemons').select(['id', 'box_id']).orderBy('id', 'asc').execute(),
    ).toEqual([
      { id: 'daemon-existing', box_id: null },
      { id: 'daemon-new', box_id: 'box-a' },
    ]);
    expect(
      await db
        .selectFrom('delegation_revocation_outbox')
        .select(['revocation_nonce', 'actor_certificate_json', 'revocation_json'])
        .where('daemon_id', '=', 'daemon-new')
        .orderBy('sequence', 'asc')
        .execute(),
    ).toEqual([
      {
        revocation_nonce: oldLive.nonce,
        actor_certificate_json: JSON.stringify(actorCertificate),
        revocation_json: JSON.stringify(oldLive),
      },
      {
        revocation_nonce: newLive.nonce,
        actor_certificate_json: JSON.stringify(actorCertificate),
        revocation_json: JSON.stringify(newLive),
      },
    ]);
  });

  describe('machine limit', () => {
    test('counts reservations, excludes boxes, and releases expired capacity', async () => {
      await insertMachine('machine-1');
      await insertMachine('hosted-1', 'box-1');
      expect(await claimAndApprove('reservation-1', 'machine-2')).toBeNull();
      expect((await readMachineUsage(db, 'user-1', Date.now())).machineUsage).toEqual({
        used: 2,
        limit: 3,
      });
      await db
        .updateTable('daemon_link_claims')
        .set({ expires_at: 100 })
        .where('link_claim_id', '=', 'reservation-1')
        .execute();
      expect(await readMachineUsage(db, 'user-1', 100)).toEqual({
        machineUsage: { used: 1, limit: 3 },
        reservationExpiresAt: null,
      });
      await db.updateTable('users').set({ privileged_at: 1 }).where('id', '=', 'user-1').execute();
      expect((await readMachineUsage(db, 'user-1', 100)).machineUsage).toEqual({
        used: 1,
        limit: null,
      });
    });
    const service = () =>
      createDaemonLinkClaimService(db, {
        publicOrigin: ORIGIN,
        tokenHmacSecret: HMAC_SECRET,
        sessionTokenVerifyKey: 'V'.repeat(3_456),
      });

    async function insertMachine(id: string, boxId: string | null = null): Promise<void> {
      await db
        .insertInto('daemons')
        .values({
          id,
          user_id: 'user-1',
          name: id,
          platform: 'linux',
          daemon_identity_public_key: `${id}-public-key`,
          daemon_identity_p256_public_key: `${id}-p256-key`,
          identity_seal_backend: 'software',
          daemon_identity_key_commitment: `${id}-key-commitment`,
          daemon_binding_json: '{}',
          last_seen: 1,
          version: null,
          box_id: boxId,
        })
        .execute();
    }

    const FIRST_ROOT = {
      key: ROOT,
      publicKey: ROOT_PUBLIC_KEY,
      commitment: ROOT_KEY_COMMITMENT,
      epoch: 1,
    };

    /** Create a claim for `daemonId` and try to approve it, as the browser does. */
    async function claimAndApprove(
      linkClaimId: string,
      daemonId: string,
      boxId: string | null = null,
      root: typeof FIRST_ROOT = FIRST_ROOT,
    ): Promise<string | null> {
      const claims = service();
      const admission = createLinkToken();
      await db
        .insertInto('link_tokens')
        .values({
          token_hash: hashToken(admission.token, HMAC_SECRET, 'device-link'),
          user_id: 'user-1',
          expires_at: admission.expiresAt,
          used_at: null,
          box_id: boxId,
        })
        .execute();
      const linkSecret = new Uint8Array(32).fill(0x33);
      const publicClaim = {
        linkClaimId,
        daemonId,
        daemonIdentityPublicKey: DAEMON_IDENTITY_PUBLIC_KEY,
        daemonIdentityP256PublicKey: Buffer.from(
          deriveSoftwareDaemonP256PublicKey(new Uint8Array(32).fill(0x22)),
        ).toString('base64url'),
        daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
        name: daemonId,
        platform: 'linux',
        identitySealBackend: 'software',
      } as const;
      const claimCommitment = deriveDaemonLinkClaimCommitment(publicClaim, linkSecret);
      const created = await Effect.runPromise(
        claims.create({ linkToken: admission.token, ...publicClaim, claimCommitment }),
      );
      const { machineUsage } = await readMachineUsage(db, 'user-1', Date.now());
      expect(created.machineUsage).toEqual(machineUsage);
      const existing = await db
        .selectFrom('daemons')
        .select('id')
        .where('id', '=', daemonId)
        .executeTakeFirst();
      expect(created.canLink).toBe(
        boxId !== null ||
          existing !== undefined ||
          machineUsage.limit === null ||
          machineUsage.used < machineUsage.limit,
      );
      const inspected = await Effect.runPromise(claims.inspect('user-1', linkClaimId));
      // The inspection is the route's response as it stands; the browser holds it to this schema.
      expect(Value.Check(DaemonLinkClaimInspectResponse, inspected)).toBe(true);
      const daemonBinding = createDaemonBinding(
        {
          userId: 'user-1',
          rootKeyCommitment: root.commitment,
          daemonId,
          daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
          serverOrigin: ORIGIN,
          linkClaimId,
          issuedAt: inspected.serverTimeMs,
        },
        root.key,
      );
      const approval = createDaemonLinkApproval(
        {
          linkClaimId,
          claimCommitment,
          userRootPublicKey: root.publicKey,
          rootEpoch: root.epoch,
          daemonBinding,
        },
        new Uint8Array(Buffer.from(created.serverNonce, 'base64url')),
        linkSecret,
      );
      return await Effect.runPromise(
        claims.approve('user-1', linkClaimId, approval).pipe(
          Effect.match({
            onFailure: (error) =>
              error instanceof DaemonLinkClaimError ? error.code : String(error),
            onSuccess: () => null,
          }),
        ),
      );
    }

    async function claimState(linkClaimId: string): Promise<string | undefined> {
      return (
        await db
          .selectFrom('daemon_link_claims')
          .select('state')
          .where('link_claim_id', '=', linkClaimId)
          .executeTakeFirst()
      )?.state;
    }

    test('refuses a machine beyond the limit and leaves its claim pending', async () => {
      expect(MAX_LINKED_MACHINES).toBe(3);
      for (const id of ['machine-1', 'machine-2', 'machine-3']) await insertMachine(id);
      expect(await claimAndApprove('claim-4', 'machine-4')).toBe('machine_limit_reached');
      expect(await claimState('claim-4')).toBe('pending');
    });

    test('never counts boxes, whether linked or being linked', async () => {
      for (const id of ['machine-1', 'machine-2', 'machine-3']) await insertMachine(id);
      await insertMachine('box-machine', 'calm-harbor');
      expect(await claimAndApprove('claim-box', 'box-daemon', 'bright-river')).toBeNull();
      expect(await claimState('claim-box')).toBe('approved');
    });

    test('re-linking a machine already on the account adds nothing', async () => {
      for (const id of ['machine-1', 'machine-2', 'machine-3']) await insertMachine(id);
      expect(await claimAndApprove('claim-relink', 'machine-2')).toBeNull();
    });

    test('a privileged account links past the limit', async () => {
      for (const id of ['machine-1', 'machine-2', 'machine-3']) await insertMachine(id);
      await db.updateTable('users').set({ privileged_at: 1 }).execute();
      expect(await claimAndApprove('claim-4', 'machine-4')).toBeNull();
      expect(await claimState('claim-4')).toBe('approved');
    });

    test('after a password reset only the new root, at its epoch, links a machine', async () => {
      const key = deriveUserAuthorizationSigningKey(new Uint8Array(32).fill(0x55));
      const nextRoot = {
        key,
        publicKey: encodeUserAuthorizationBytes(key.publicKey),
        commitment: deriveUserRootKeyCommitment(key.publicKey),
        epoch: 2,
      };
      await db
        .updateTable('users')
        .set({
          root_public_key: nextRoot.publicKey,
          root_key_commitment: nextRoot.commitment,
          root_epoch: nextRoot.epoch,
        })
        .where('id', '=', 'user-1')
        .execute();

      // The root a reset discarded approves nothing, nor does the new root
      // naming the epoch it replaced.
      expect(await claimAndApprove('claim-old-root', 'machine-1')).toBe('claim_invalid');
      expect(await claimState('claim-old-root')).toBe('pending');
      expect(
        await claimAndApprove('claim-old-epoch', 'machine-1', null, { ...nextRoot, epoch: 1 }),
      ).toBe('claim_invalid');
      expect(await claimAndApprove('claim-new-root', 'machine-1', null, nextRoot)).toBeNull();
      expect(await claimState('claim-new-root')).toBe('approved');
    });

    test('an approved claim that can still complete holds its place', async () => {
      for (const id of ['machine-1', 'machine-2']) await insertMachine(id);
      expect(await claimAndApprove('claim-3', 'machine-3')).toBeNull();
      expect(await claimAndApprove('claim-4', 'machine-4')).toBe('machine_limit_reached');
    });
  });
});
