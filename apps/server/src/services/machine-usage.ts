import type { MachineUsage } from '@merkur/shared';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { DatabaseSchema } from '../db/types';

export const MAX_LINKED_MACHINES = 3;

/** Linked machines and live approved reservations share the same capacity. */
export function machineCountSql(userId: string, now: number) {
  return sql<number>`(
    (SELECT count(*) FROM daemons
      WHERE daemons.user_id = ${userId} AND daemons.box_id IS NULL)
    + (SELECT count(DISTINCT json_extract(pending.public_claim_json, '$.daemonId'))
      FROM daemon_link_claims AS pending
      WHERE pending.user_id = ${userId}
        AND pending.state = 'approved' AND pending.box_id IS NULL
        AND pending.expires_at > ${now}
        AND json_extract(pending.public_claim_json, '$.daemonId') NOT IN (
          SELECT daemons.id FROM daemons WHERE daemons.user_id = ${userId}
        ))
  )`;
}

export async function readMachineUsage(
  db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  userId: string,
  now: number,
): Promise<{ machineUsage: MachineUsage; reservationExpiresAt: number | null }> {
  const row = await db
    .selectFrom('users')
    .select([
      'privileged_at',
      machineCountSql(userId, now).as('used'),
      sql<number | null>`(SELECT min(expires_at) FROM daemon_link_claims
        WHERE user_id = ${userId} AND state = 'approved' AND box_id IS NULL
          AND expires_at > ${now})`.as('reservationExpiresAt'),
    ])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  return {
    machineUsage: {
      used: Number(row.used),
      limit: row.privileged_at === null ? MAX_LINKED_MACHINES : null,
    },
    reservationExpiresAt: row.reservationExpiresAt,
  };
}
