import { type Kysely, sql } from 'kysely';

import type { DatabaseSchema } from '../src/db/types';

export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema
    .alterTable('users')
    .addColumn('last_sign_in_at', 'integer', (column) => column.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable('users').addColumn('inactivity_notice_sent_at', 'integer').execute();
  // Delegation issuance is a recorded sign-in, including password changes and
  // resets. Refreshes keep that delegation and do not extend inactivity.
  await sql`
    UPDATE users SET last_sign_in_at = max(created_at, coalesce(
      (SELECT max(issued_at) FROM browser_delegations WHERE user_id = users.id), created_at
    ))
  `.execute(db);
  await db.schema
    .createIndex('users_last_sign_in_at')
    .on('users')
    .column('last_sign_in_at')
    .execute();
  await db.schema.createIndex('users_suspended_at').on('users').column('suspended_at').execute();
  await db.schema
    .createIndex('box_waitlist_created_at')
    .on('box_waitlist')
    .column('created_at')
    .execute();
}

export async function down(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema.dropIndex('box_waitlist_created_at').execute();
  await db.schema.dropIndex('users_suspended_at').execute();
  await db.schema.dropIndex('users_last_sign_in_at').execute();
  await db.schema.alterTable('users').dropColumn('inactivity_notice_sent_at').execute();
  await db.schema.alterTable('users').dropColumn('last_sign_in_at').execute();
}
