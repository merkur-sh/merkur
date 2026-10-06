import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../src/db/types';

/**
 * Hard cutover to platform-neutral key custody (`hardware` / `software`). No
 * stored identity opens in its former shape, so every linked daemon relinks
 * with a fresh identity: its row goes, with the claims, tokens and revocation
 * deliveries that name the old one.
 */
export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.deleteFrom('delegation_revocation_outbox').execute();
  await db.deleteFrom('daemon_link_claims').execute();
  await db.deleteFrom('link_tokens').execute();
  await db.deleteFrom('daemons').execute();
}

export async function down(): Promise<void> {}
