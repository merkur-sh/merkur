import { type Kysely, sql } from 'kysely';
import type { DatabaseSchema } from '../src/db/types';

export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema.dropTable('push_subscriptions').execute();
  await db.schema
    .createTable('push_subscriptions')
    .addColumn('id', 'text', (column) => column.primaryKey().notNull())
    .addColumn('user_id', 'text', (column) =>
      column.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('delegation_id', 'text', (column) =>
      column.notNull().references('browser_delegations.id').onDelete('cascade'),
    )
    .addColumn('endpoint', 'text', (column) => column.notNull().unique())
    .addColumn('p256dh', 'text', (column) => column.notNull())
    .addColumn('auth', 'text', (column) => column.notNull())
    .execute();
  await db.schema
    .createIndex('idx_push_subscriptions_user_id')
    .on('push_subscriptions')
    .column('user_id')
    .execute();
  await db.schema
    .createIndex('idx_push_subscriptions_delegation_id')
    .on('push_subscriptions')
    .column('delegation_id')
    .execute();
  await sql`CREATE TRIGGER push_delegation_revoked AFTER UPDATE OF revoked_at ON browser_delegations
    WHEN new.revoked_at IS NOT NULL BEGIN
    DELETE FROM push_subscriptions WHERE delegation_id = new.id;
  END`.execute(db);
}

export async function down(): Promise<void> {}
