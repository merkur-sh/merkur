import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../src/db/types';

/** Committed invalidations remain until Redis confirms publication. */
export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema
    .createTable('notification_outbox')
    .addColumn('id', 'text', (column) => column.primaryKey().notNull())
    // Delivery intent survives account erasure until every committed revocation
    // has been published. It contains exact IDs, never credentials.
    .addColumn('user_id', 'text', (column) => column.notNull())
    .addColumn('kind', 'text', (column) => column.notNull())
    .addColumn('payload', 'text', (column) => column.notNull())
    .execute();
}

export async function down(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema.dropTable('notification_outbox').execute();
}
