import type { Kysely } from 'kysely';

import type { DatabaseSchema } from '../src/db/types';

/**
 * Marks an account as privileged: exempt from the per-account machine limit
 * and approved for hosted boxes without the waitlist.
 *
 * Like `suspended_at`, an operator sets it directly in the database; no route
 * grants it, so no sign-in can reach it. `NULL` is an ordinary account.
 */
export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema.alterTable('users').addColumn('privileged_at', 'integer').execute();
}

export async function down(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('privileged_at').execute();
}
