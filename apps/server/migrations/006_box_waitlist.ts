import type { Kysely } from 'kysely';

import type { DatabaseSchema } from '../src/db/types';

/**
 * Addresses that asked, on the public website, to hear when Merkur Boxes open.
 *
 * Separate from `box_access`, which is an account's own standing inside the
 * application: this list belongs to no account, so it names no user and has no
 * cascade. It holds the address and the time it joined, and nothing else; the
 * address is stored in the one spelling sign-up normalizes it to, so the
 * primary key is also what makes a second join of the same address a no-op.
 */
export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema
    .createTable('box_waitlist')
    .addColumn('email', 'text', (column) => column.primaryKey().notNull())
    .addColumn('created_at', 'integer', (column) => column.notNull())
    .execute();
}

export async function down(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema.dropTable('box_waitlist').execute();
}
