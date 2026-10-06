import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { hashToken, verifyToken } from '@merkur/auth';
import type { DaemonIdentitySealBackend, MachineUsage } from '@merkur/shared';
import {
  type DaemonLinkApproval,
  type DaemonLinkPublicClaim,
  decodeUserAuthorizationBytes,
  deriveUserRootKeyCommitment,
  parseDaemonLinkApproval,
  parseDaemonLinkPublicClaim,
  parseDelegationRevocationStatement,
  parseUserDelegationCertificate,
  USER_AUTHORIZATION_NONCE_BYTES,
  USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
  verifyDaemonBinding,
} from '@merkur/shared/user-authorization';
import { Clock, Context, Data, Effect, Layer, Redacted } from 'effect';
import { type Kysely, sql, type Transaction } from 'kysely';

import { ServerConfigService } from '../config';
import { DatabaseService } from '../db/client';
import { tryDatabaseTransactionPromise, withDatabaseTransaction } from '../db/transaction';
import type { DatabaseSchema } from '../db/types';
import { type InfrastructureError, infrastructureError } from './errors';
import { MAX_LINKED_MACHINES, machineCountSql, readMachineUsage } from './machine-usage';

const CLAIM_TTL_MS = 10 * 60 * 1_000;
const MAX_POLL_AUTH_ATTEMPTS = 32;
const BINDING_CLOCK_SKEW_MS = 30_000;

export type DaemonLinkClaimErrorCode =
  | 'claim_conflict'
  | 'claim_expired'
  | 'claim_invalid'
  | 'claim_not_approved'
  | 'claim_unauthorized'
  | 'link_token_consumed'
  | 'link_token_expired'
  | 'link_token_invalid'
  | 'machine_limit_reached';

export class DaemonLinkClaimError extends Data.TaggedError('DaemonLinkClaimError')<{
  readonly code: DaemonLinkClaimErrorCode;
  readonly message: string;
}> {}

export interface CreateDaemonLinkClaimInput {
  readonly linkToken: string;
  readonly linkClaimId: string;
  readonly daemonId: string;
  readonly daemonIdentityPublicKey: string;
  readonly daemonIdentityP256PublicKey: string;
  readonly identitySealBackend: DaemonIdentitySealBackend;
  readonly daemonIdentityKeyCommitment: string;
  readonly name: string;
  readonly platform: string;
  readonly claimCommitment: string;
}

export interface DaemonLinkClaimCreated {
  readonly pollToken: string;
  readonly serverNonce: string;
  readonly expiresAt: number;
  readonly machineUsage: MachineUsage;
  readonly canLink: boolean;
}

export type DaemonLinkPollResult =
  | { readonly status: 'pending' }
  | {
      readonly status: 'approved';
      readonly sessionTokenVerifyKey: string;
      readonly approval: DaemonLinkApproval;
    };

export interface DaemonLinkCompletion {
  readonly userId: string;
  readonly daemonId: string;
}

export interface DaemonLinkClaimService {
  create(
    input: CreateDaemonLinkClaimInput,
  ): Effect.Effect<DaemonLinkClaimCreated, InfrastructureError | DaemonLinkClaimError>;
  inspect(
    userId: string,
    linkClaimId: string,
  ): Effect.Effect<
    DaemonLinkPublicClaim & { readonly serverNonce: string; readonly serverTimeMs: number },
    InfrastructureError | DaemonLinkClaimError
  >;
  approve(
    userId: string,
    linkClaimId: string,
    approval: unknown,
  ): Effect.Effect<void, InfrastructureError | DaemonLinkClaimError>;
  poll(
    linkClaimId: string,
    pollToken: string,
  ): Effect.Effect<DaemonLinkPollResult, InfrastructureError | DaemonLinkClaimError>;
  /** Resolves to the account and the daemon the claim linked into it. */
  complete(
    linkClaimId: string,
    pollToken: string,
    approvalMac: string,
  ): Effect.Effect<DaemonLinkCompletion, InfrastructureError | DaemonLinkClaimError>;
}

export class DaemonLinkClaimServiceTag extends Context.Service<
  DaemonLinkClaimServiceTag,
  DaemonLinkClaimService
>()('DaemonLinkClaimService') {}

export const DaemonLinkClaimServiceLive = Layer.effect(
  DaemonLinkClaimServiceTag,
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const config = yield* ServerConfigService;
    return createDaemonLinkClaimService(db, {
      publicOrigin: config.publicOrigin,
      tokenHmacSecret: Redacted.value(config.tokenHmacSecret),
      sessionTokenVerifyKey: config.sessionTokenVerifyKeyB64,
    });
  }),
);

interface DaemonLinkClaimConfig {
  readonly publicOrigin: string;
  readonly tokenHmacSecret: string;
  readonly sessionTokenVerifyKey: string;
}

export function createDaemonLinkClaimService(
  db: Kysely<DatabaseSchema>,
  config: DaemonLinkClaimConfig,
): DaemonLinkClaimService {
  return {
    create(input) {
      return Effect.gen(function* () {
        const claim = parseClaimInput(input);
        const now = yield* Clock.currentTimeMillis;
        const expiresAt = now + CLAIM_TTL_MS;
        const pollToken = randomBytes(USER_AUTHORIZATION_NONCE_BYTES).toString('base64url');
        const serverNonce = randomBytes(USER_AUTHORIZATION_NONCE_BYTES).toString('base64url');
        const publicClaimJson = JSON.stringify(claim);
        const admission = yield* withDatabaseTransaction(db, (trx) =>
          tryDatabaseTransactionPromise({
            try: async () => {
              const tokenHash = hashToken(input.linkToken, config.tokenHmacSecret, 'device-link');
              const token = await trx
                .selectFrom('link_tokens')
                .select(['user_id', 'expires_at', 'used_at', 'box_id'])
                .where('token_hash', '=', tokenHash)
                .executeTakeFirst();
              if (token === undefined) throw claimError('link_token_invalid');
              if (token.used_at !== null) throw claimError('link_token_consumed');
              if (token.expires_at <= now) throw claimError('link_token_expired');
              const { machineUsage } = await readMachineUsage(trx, token.user_id, now);
              const existing = await trx
                .selectFrom('daemons')
                .select('id')
                .where('user_id', '=', token.user_id)
                .where('id', '=', claim.daemonId)
                .executeTakeFirst();
              const canLink =
                token.box_id !== null ||
                existing !== undefined ||
                machineUsage.limit === null ||
                machineUsage.used < machineUsage.limit;
              const consumed = await trx
                .updateTable('link_tokens')
                .set({ used_at: now })
                .where('token_hash', '=', tokenHash)
                .where('used_at', 'is', null)
                .executeTakeFirst();
              if (Number(consumed.numUpdatedRows) !== 1) {
                throw claimError('link_token_consumed');
              }
              await trx
                .insertInto('daemon_link_claims')
                .values({
                  link_claim_id: claim.linkClaimId,
                  user_id: token.user_id,
                  state: 'pending',
                  claim_commitment: claim.claimCommitment,
                  public_claim_json: publicClaimJson,
                  poll_token_hash: hashToken(pollToken, config.tokenHmacSecret, 'daemon-link-poll'),
                  server_nonce: serverNonce,
                  approval_json: null,
                  expires_at: expiresAt,
                  attempt_count: 0,
                  created_at: now,
                  approved_at: null,
                  box_id: token.box_id,
                })
                .execute();
              return { machineUsage, canLink };
            },
            catch: normalizeClaimError('create-daemon-link-claim'),
          }),
        );
        return { pollToken, serverNonce, expiresAt, ...admission };
      });
    },

    inspect(userId, linkClaimId) {
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.tryPromise({
          try: async () => {
            const row = await db
              .selectFrom('daemon_link_claims')
              .select(['user_id', 'state', 'public_claim_json', 'server_nonce', 'expires_at'])
              .where('link_claim_id', '=', linkClaimId)
              .executeTakeFirst();
            if (row === undefined || row.user_id !== userId) {
              throw claimError('claim_invalid');
            }
            requireLiveClaim(row.state, row.expires_at, now);
            return {
              ...parseDaemonLinkPublicClaim(JSON.parse(row.public_claim_json)),
              serverNonce: row.server_nonce,
              serverTimeMs: now,
            };
          },
          catch: normalizeClaimError('inspect-daemon-link-claim'),
        });
      });
    },

    approve(userId, linkClaimId, approvalValue) {
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* withDatabaseTransaction(db, (trx) =>
          tryDatabaseTransactionPromise({
            try: async () => {
              const approval = parseDaemonLinkApproval(approvalValue);
              const claimRow = await trx
                .selectFrom('daemon_link_claims')
                .select([
                  'user_id',
                  'state',
                  'claim_commitment',
                  'public_claim_json',
                  'approval_json',
                  'expires_at',
                ])
                .where('link_claim_id', '=', linkClaimId)
                .executeTakeFirst();
              if (claimRow === undefined || claimRow.user_id !== userId) {
                throw claimError('claim_invalid');
              }
              requireLiveClaim(claimRow.state, claimRow.expires_at, now);
              const claim = parseDaemonLinkPublicClaim(JSON.parse(claimRow.public_claim_json));
              if (claim.claimCommitment !== claimRow.claim_commitment) {
                throw claimError('claim_invalid');
              }
              const user = await trx
                .selectFrom('users')
                .select(['root_public_key', 'root_key_commitment', 'root_epoch'])
                .where('id', '=', userId)
                .executeTakeFirst();
              if (user === undefined) throw claimError('claim_invalid');
              validateApproval(approval, claim, userId, user, config.publicOrigin, now);
              const approvalJson = JSON.stringify(approval);
              if (claimRow.state === 'approved') {
                if (claimRow.approval_json !== approvalJson) throw claimError('claim_conflict');
                return;
              }
              // The machine limit is folded into the approval itself: one
              // statement, so two approvals racing at the limit cannot both pass
              // a count taken before either wrote. A machine counts once it is
              // linked or while its approved claim can still complete; a box
              // never counts, re-linking a machine already on the account
              // replaces it rather than adding one, and a privileged account
              // has no limit.
              const updated = await trx
                .updateTable('daemon_link_claims')
                .set({ state: 'approved', approval_json: approvalJson, approved_at: now })
                .where('link_claim_id', '=', linkClaimId)
                .where('state', '=', 'pending')
                .where(
                  sql<boolean>`(
                    daemon_link_claims.box_id IS NOT NULL
                    OR EXISTS (
                      SELECT 1 FROM users
                      WHERE users.id = ${userId} AND users.privileged_at IS NOT NULL
                    )
                    OR EXISTS (
                      SELECT 1 FROM daemons
                      WHERE daemons.id = ${claim.daemonId} AND daemons.user_id = ${userId}
                    )
                    OR ${machineCountSql(userId, now)} < ${MAX_LINKED_MACHINES}
                  )`,
                )
                .executeTakeFirst();
              if (Number(updated.numUpdatedRows) !== 1) {
                const current = await trx
                  .selectFrom('daemon_link_claims')
                  .select('state')
                  .where('link_claim_id', '=', linkClaimId)
                  .executeTakeFirst();
                throw claimError(
                  current?.state === 'pending' ? 'machine_limit_reached' : 'claim_conflict',
                );
              }
            },
            catch: normalizeClaimError('approve-daemon-link-claim'),
          }),
        );
      });
    },

    poll(linkClaimId, pollToken) {
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.tryPromise({
          try: async () => {
            const row = await authenticatePollToken(db, linkClaimId, pollToken, config, now);
            if (row.state === 'pending') return { status: 'pending' as const };
            if (row.state !== 'approved' || row.approval_json === null) {
              throw claimError('claim_not_approved');
            }
            return {
              status: 'approved' as const,
              sessionTokenVerifyKey: config.sessionTokenVerifyKey,
              approval: parseDaemonLinkApproval(JSON.parse(row.approval_json)),
            };
          },
          catch: normalizeClaimError('poll-daemon-link-claim'),
        });
      });
    },

    complete(linkClaimId, pollToken, approvalMac) {
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* withDatabaseTransaction(db, (trx) =>
          tryDatabaseTransactionPromise({
            try: async () => {
              const row = await authenticatePollToken(trx, linkClaimId, pollToken, config, now);
              if (row.approval_json === null) throw claimError('claim_not_approved');
              const approval = parseDaemonLinkApproval(JSON.parse(row.approval_json));
              if (!equalCanonicalMac(approval.approvalMac, approvalMac)) {
                throw claimError('claim_unauthorized');
              }
              const claim = parseDaemonLinkPublicClaim(JSON.parse(row.public_claim_json));
              if (row.state === 'completed') {
                return { userId: row.user_id, daemonId: claim.daemonId };
              }
              if (row.state !== 'approved') throw claimError('claim_not_approved');
              const linked = await trx
                .insertInto('daemons')
                .values({
                  id: claim.daemonId,
                  user_id: row.user_id,
                  name: claim.name,
                  platform: claim.platform,
                  daemon_identity_public_key: claim.daemonIdentityPublicKey,
                  daemon_identity_p256_public_key: claim.daemonIdentityP256PublicKey,
                  identity_seal_backend: claim.identitySealBackend,
                  daemon_identity_key_commitment: claim.daemonIdentityKeyCommitment,
                  daemon_binding_json: JSON.stringify(approval.daemonBinding),
                  last_seen: now,
                  version: null,
                  box_id: row.box_id,
                })
                .onConflict((conflict) =>
                  conflict
                    .column('id')
                    .doUpdateSet((expression) => ({
                      name: expression.ref('excluded.name'),
                      platform: expression.ref('excluded.platform'),
                      daemon_identity_p256_public_key: expression.ref(
                        'excluded.daemon_identity_p256_public_key',
                      ),
                      identity_seal_backend: expression.ref('excluded.identity_seal_backend'),
                      daemon_binding_json: expression.ref('excluded.daemon_binding_json'),
                      last_seen: expression.ref('excluded.last_seen'),
                      box_id: expression.ref('excluded.box_id'),
                    }))
                    .whereRef('daemons.user_id', '=', 'excluded.user_id')
                    .whereRef(
                      'daemons.daemon_identity_key_commitment',
                      '=',
                      'excluded.daemon_identity_key_commitment',
                    ),
                )
                .returning('id')
                .executeTakeFirst();
              if (linked === undefined) throw claimError('claim_conflict');
              await backfillDelegationRevocations(trx, row.user_id, claim.daemonId, now);
              await trx
                .updateTable('daemon_link_claims')
                .set({
                  state: 'completed',
                })
                .where('link_claim_id', '=', linkClaimId)
                .where('state', '=', 'approved')
                .execute();
              return { userId: row.user_id, daemonId: claim.daemonId };
            },
            catch: normalizeClaimError('complete-daemon-link-claim'),
          }),
        );
      });
    },
  };
}

async function backfillDelegationRevocations(
  db: Transaction<DatabaseSchema>,
  userId: string,
  daemonId: string,
  now: number,
): Promise<void> {
  const revocations = await db
    .selectFrom('delegation_revocations')
    .select(['nonce', 'actor_certificate_json', 'revocation_json', 'created_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at', 'asc')
    .orderBy('nonce', 'asc')
    .execute();
  for (const stored of revocations) {
    if (stored.nonce === null) throw claimError('claim_invalid');
    const actorCertificate = parseUserDelegationCertificate(
      JSON.parse(stored.actor_certificate_json),
    );
    const statement = parseDelegationRevocationStatement(JSON.parse(stored.revocation_json));
    if (
      actorCertificate.userId !== userId ||
      actorCertificate.delegationId !== statement.actorDelegationId ||
      statement.userId !== userId ||
      statement.nonce !== stored.nonce
    ) {
      throw claimError('claim_invalid');
    }
    if (!statement.targets.some((target) => target.expiresAt > now)) continue;
    await db
      .insertInto('delegation_revocation_outbox')
      .values({
        command_id: randomUUID(),
        revocation_nonce: stored.nonce,
        daemon_id: daemonId,
        user_id: userId,
        actor_certificate_json: stored.actor_certificate_json,
        revocation_json: stored.revocation_json,
        created_at: stored.created_at,
        acknowledged_at: null,
        rejected_reason: null,
      })
      .onConflict((conflict) => conflict.columns(['revocation_nonce', 'daemon_id']).doNothing())
      .execute();
  }
}

type StoredClaimForPoll = {
  readonly user_id: string;
  readonly state: string;
  readonly poll_token_hash: string;
  readonly public_claim_json: string;
  readonly approval_json: string | null;
  readonly expires_at: number;
  readonly attempt_count: number;
  /** The box the redeemed link token was minted for, or `null`. */
  readonly box_id: string | null;
};

async function authenticatePollToken(
  db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  linkClaimId: string,
  pollToken: string,
  config: DaemonLinkClaimConfig,
  now: number,
): Promise<StoredClaimForPoll> {
  const row = await db
    .selectFrom('daemon_link_claims')
    .select([
      'user_id',
      'state',
      'poll_token_hash',
      'public_claim_json',
      'approval_json',
      'expires_at',
      'attempt_count',
      'box_id',
    ])
    .where('link_claim_id', '=', linkClaimId)
    .executeTakeFirst();
  if (row === undefined) throw claimError('claim_invalid');
  if (
    row.attempt_count >= MAX_POLL_AUTH_ATTEMPTS ||
    !verifyToken(pollToken, row.poll_token_hash, config.tokenHmacSecret, 'daemon-link-poll')
  ) {
    await db
      .updateTable('daemon_link_claims')
      .set({ attempt_count: Math.min(MAX_POLL_AUTH_ATTEMPTS, row.attempt_count + 1) })
      .where('link_claim_id', '=', linkClaimId)
      .execute();
    throw claimError('claim_unauthorized');
  }
  if (row.expires_at <= now) throw claimError('claim_expired');
  return row;
}

function parseClaimInput(input: CreateDaemonLinkClaimInput): DaemonLinkPublicClaim {
  try {
    return parseDaemonLinkPublicClaim({
      linkClaimId: input.linkClaimId,
      daemonId: input.daemonId,
      daemonIdentityPublicKey: input.daemonIdentityPublicKey,
      daemonIdentityP256PublicKey: input.daemonIdentityP256PublicKey,
      daemonIdentityKeyCommitment: input.daemonIdentityKeyCommitment,
      name: input.name,
      platform: input.platform,
      identitySealBackend: input.identitySealBackend,
      claimCommitment: input.claimCommitment,
    });
  } catch {
    throw claimError('claim_invalid');
  }
}

function validateApproval(
  approval: DaemonLinkApproval,
  claim: DaemonLinkPublicClaim,
  userId: string,
  user: {
    readonly root_public_key: string;
    readonly root_key_commitment: string;
    readonly root_epoch: number;
  },
  publicOrigin: string,
  now: number,
): void {
  const rootPublicKey = decodeUserAuthorizationBytes(
    user.root_public_key,
    USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
    'user root public key',
  );
  if (
    approval.linkClaimId !== claim.linkClaimId ||
    approval.claimCommitment !== claim.claimCommitment ||
    approval.userRootPublicKey !== user.root_public_key ||
    deriveUserRootKeyCommitment(rootPublicKey) !== user.root_key_commitment ||
    approval.rootEpoch !== user.root_epoch ||
    Math.abs(approval.daemonBinding.issuedAt - now) > BINDING_CLOCK_SKEW_MS
  ) {
    throw claimError('claim_invalid');
  }
  const binding = verifyDaemonBinding(approval.daemonBinding, rootPublicKey, {
    userId,
    rootKeyCommitment: user.root_key_commitment,
    daemonId: claim.daemonId,
    daemonIdentityKeyCommitment: claim.daemonIdentityKeyCommitment,
    serverOrigin: publicOrigin,
    linkClaimId: claim.linkClaimId,
    issuedAt: approval.daemonBinding.issuedAt,
  });
  if (binding === null) throw claimError('claim_invalid');
}

function requireLiveClaim(state: string, expiresAt: number, now: number): void {
  if (expiresAt <= now) throw claimError('claim_expired');
  if (state !== 'pending' && state !== 'approved') throw claimError('claim_conflict');
}

function equalCanonicalMac(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'base64url');
  const actualBytes = Buffer.from(actual, 'base64url');
  try {
    return (
      expectedBytes.byteLength === 64 &&
      actualBytes.byteLength === 64 &&
      expectedBytes.toString('base64url') === expected &&
      actualBytes.toString('base64url') === actual &&
      timingSafeEqual(expectedBytes, actualBytes)
    );
  } finally {
    expectedBytes.fill(0);
    actualBytes.fill(0);
  }
}

function claimError(code: DaemonLinkClaimErrorCode): DaemonLinkClaimError {
  return new DaemonLinkClaimError({ code, message: code.replaceAll('_', ' ') });
}

function normalizeClaimError(operation: string) {
  return (error: unknown): DaemonLinkClaimError | InfrastructureError =>
    error instanceof DaemonLinkClaimError
      ? error
      : infrastructureError('daemon-link', operation)(error);
}
