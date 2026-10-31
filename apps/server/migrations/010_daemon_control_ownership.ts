import { type Kysely, sql } from 'kysely';
import type { DatabaseSchema } from '../src/db/types';

export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  for (const name of ['daemon_control_owners', 'daemon_unlinks']) {
    const table = db.schema
      .createTable(name)
      .addColumn('connection_id', 'text', (column) => column.primaryKey().notNull())
      .addColumn('daemon_id', 'text', (column) =>
        name === 'daemon_control_owners'
          ? column.notNull().unique().references('daemons.id').onDelete('cascade')
          : column.notNull(),
      )
      .addColumn('user_id', 'text', (column) => column.notNull())
      .addColumn('owner_instance_id', 'text', (column) => column.notNull())
      .addColumn('presence_id', 'text', (column) => column.notNull())
      .addColumn('claim_seq', 'integer', (column) => column.notNull())
      .addColumn('root_epoch', 'integer', (column) => column.notNull());
    await table.execute();
  }
  await sql`CREATE TRIGGER daemon_control_unlinked AFTER DELETE ON daemon_control_owners BEGIN
    INSERT INTO daemon_unlinks (connection_id, daemon_id, user_id, owner_instance_id, presence_id, claim_seq, root_epoch)
    VALUES (old.connection_id, old.daemon_id, old.user_id, old.owner_instance_id, old.presence_id, old.claim_seq,
      coalesce((SELECT root_epoch FROM users WHERE id = old.user_id AND root_epoch > old.root_epoch), 0));
  END`.execute(db);
}

export async function down(db: Kysely<DatabaseSchema>): Promise<void> {
  await sql`DROP TRIGGER daemon_control_unlinked`.execute(db);
  await db.schema.dropTable('daemon_control_owners').execute();
  await db.schema.dropTable('daemon_unlinks').execute();
}
