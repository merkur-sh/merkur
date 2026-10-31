import { type Kysely, sql } from 'kysely';
import type { DatabaseSchema } from '../src/db/types';

/** Security intents and their replica wakes commit together. */
export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema
    .createIndex('idx_daemon_unlinks_daemon')
    .on('daemon_unlinks')
    .column('daemon_id')
    .execute();
  await sql`CREATE TRIGGER daemon_unlink_notification AFTER INSERT ON daemon_unlinks BEGIN
    INSERT INTO notification_outbox (id, user_id, kind, payload)
    VALUES (lower(hex(randomblob(16))), new.user_id, 'daemon-control',
      json_object('type', 'daemon_work', 'version', 1, 'daemonId', new.daemon_id,
        'ownerInstanceId', new.owner_instance_id));
  END`.execute(db);
  await sql`CREATE TRIGGER daemon_revocation_notification AFTER INSERT ON delegation_revocation_outbox BEGIN
    INSERT INTO notification_outbox (id, user_id, kind, payload)
    SELECT lower(hex(randomblob(16))), new.user_id, 'daemon-control',
      json_object('type', 'daemon_work', 'version', 1, 'daemonId', new.daemon_id,
        'ownerInstanceId', owner_instance_id)
    FROM daemon_control_owners WHERE daemon_id = new.daemon_id;
  END`.execute(db);
}

export async function down(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema.dropIndex('idx_daemon_unlinks_daemon').execute();
  await sql`DROP TRIGGER daemon_unlink_notification`.execute(db);
  await sql`DROP TRIGGER daemon_revocation_notification`.execute(db);
}
