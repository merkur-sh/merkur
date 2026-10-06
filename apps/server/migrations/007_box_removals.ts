import type { Kysely } from 'kysely';

import type { DatabaseSchema } from '../src/db/types';

/**
 * Hosted boxes whose destruction has been decided and is still owed.
 *
 * A password reset removes the device rows that named an account's boxes in the
 * same transaction that replaces the account root, so the rows cannot be what
 * remembers the containers afterwards. This table is: one row per box, written
 * in that transaction and deleted only once the box host confirms the box is
 * gone. It names no user and has no cascade, because the removal is owed even
 * if the account is erased before the host answers.
 */
export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema
    .createTable('box_removals')
    .addColumn('box_id', 'text', (column) => column.primaryKey().notNull())
    .addColumn('requested_at', 'integer', (column) => column.notNull())
    .execute();
}

export async function down(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema.dropTable('box_removals').execute();
}
