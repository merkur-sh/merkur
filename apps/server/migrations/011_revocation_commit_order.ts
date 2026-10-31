import { type Kysely, sql } from 'kysely';
import type { DatabaseSchema } from '../src/db/types';

/** Statement order follows serialized database writes, independent of clocks and nonces. */
export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema
    .createTable('delegation_revocation_order')
    .addColumn('sequence', 'integer', (column) => column.primaryKey().autoIncrement())
    .addColumn('nonce', 'text', (column) =>
      column.notNull().unique().references('delegation_revocations.nonce').onDelete('cascade'),
    )
    .execute();
  await sql`INSERT INTO delegation_revocation_order (nonce)
    SELECT nonce FROM delegation_revocations ORDER BY rowid`.execute(db);
  await sql`CREATE TRIGGER delegation_revocation_committed AFTER INSERT ON delegation_revocations BEGIN
    INSERT INTO delegation_revocation_order (nonce) VALUES (new.nonce);
  END`.execute(db);
}

export async function down(db: Kysely<DatabaseSchema>): Promise<void> {
  await sql`DROP TRIGGER delegation_revocation_committed`.execute(db);
  await db.schema.dropTable('delegation_revocation_order').execute();
}
