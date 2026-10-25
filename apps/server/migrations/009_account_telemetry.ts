import type { Kysely } from 'kysely';

import type { DatabaseSchema } from '../src/db/types';

/** NULL = not chosen, 1 = on, 0 = off; not-chosen behaves as off everywhere. */
export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema.alterTable('users').addColumn('telemetry_consent', 'integer').execute();
}

export async function down(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('telemetry_consent').execute();
}
