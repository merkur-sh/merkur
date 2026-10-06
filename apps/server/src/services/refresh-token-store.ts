import type { RefreshTokenRecord, RefreshTokenStore } from '@merkur/auth';
import type { Kysely, Transaction } from 'kysely';

import type { DatabaseSchema } from '../db/types';

export function createRefreshTokenStore(
  db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
): RefreshTokenStore {
  return {
    async findById(id: string): Promise<RefreshTokenRecord | null> {
      const row = await db
        .selectFrom('refresh_tokens')
        .select([
          'id',
          'family_id',
          'user_id',
          'delegation_id',
          'token_hash',
          'expires_at',
          'rotated_at',
        ])
        .where('id', '=', id)
        .executeTakeFirst();

      if (row === undefined || row.id === null) {
        return null;
      }

      return {
        id: row.id,
        familyId: row.family_id,
        userId: row.user_id,
        delegationId: row.delegation_id,
        tokenHash: row.token_hash,
        expiresAt: row.expires_at,
        rotatedAt: row.rotated_at,
      };
    },

    async insert(record: RefreshTokenRecord): Promise<void> {
      await db
        .insertInto('refresh_tokens')
        .values({
          id: record.id,
          family_id: record.familyId,
          user_id: record.userId,
          delegation_id: record.delegationId,
          token_hash: record.tokenHash,
          expires_at: record.expiresAt,
          rotated_at: record.rotatedAt,
        })
        .execute();
    },

    async markRotated(id: string, rotatedAt: number): Promise<void> {
      await db
        .updateTable('refresh_tokens')
        .set({ rotated_at: rotatedAt })
        .where('id', '=', id)
        .execute();
    },

    async deleteById(id: string): Promise<void> {
      await db.deleteFrom('refresh_tokens').where('id', '=', id).execute();
    },

    async deleteByFamilyId(familyId: string): Promise<void> {
      await db.deleteFrom('refresh_tokens').where('family_id', '=', familyId).execute();
    },

    async deleteByDelegationId(delegationId: string): Promise<void> {
      await db.deleteFrom('refresh_tokens').where('delegation_id', '=', delegationId).execute();
    },
  };
}
