import type { Kysely } from 'kysely';

import type { DatabaseSchema } from '../src/db/types';

/**
 * Records which box a daemon runs in, from the moment its link token is minted.
 *
 * `001_initial_schema` declared the whole schema while no deployed database
 * predated it. The production database now does, so this is an ordinary forward
 * step rather than an edit to the declaration.
 *
 * The box name travels link token → link claim → daemon row. Before this the
 * server told a box's device apart by its name matching the box's hostname,
 * which a rename or a stale row with the same name defeats; the STUN issuer
 * also needs the exact fact to leave the box host's own observers out of a box
 * daemon's list. `NULL` means "not a box". Existing rows are `NULL` until their
 * box is relinked or the column is set once by an operator who knows the box.
 */
export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema.alterTable('link_tokens').addColumn('box_id', 'text').execute();
  await db.schema.alterTable('daemon_link_claims').addColumn('box_id', 'text').execute();
  await db.schema.alterTable('daemons').addColumn('box_id', 'text').execute();
}

export async function down(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema.alterTable('daemons').dropColumn('box_id').execute();
  await db.schema.alterTable('daemon_link_claims').dropColumn('box_id').execute();
  await db.schema.alterTable('link_tokens').dropColumn('box_id').execute();
}
