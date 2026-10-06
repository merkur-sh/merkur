import { type Kysely, sql } from 'kysely';

import type { DatabaseSchema } from '../src/db/types';

/**
 * The whole Merkur schema, declared once.
 *
 * Merkur has exactly one version — the current checkout — and no deployed
 * database predates it, so the schema is stated in its final shape rather than
 * reconstructed by replaying the cutovers that produced it. The chain this
 * replaces spent four of its eleven steps dropping and recreating tables it had
 * created earlier, which left the real shape of a table readable only by
 * replaying every step that touched it.
 *
 * Two conventions here are load-bearing elsewhere:
 *
 * - Every table that belongs to an account declares
 *   `references('users.id').onDelete('cascade')`. Account erasure is a single
 *   `DELETE FROM users` and relies entirely on those cascades, so a new
 *   account-owned table is erased correctly only if it follows this convention.
 *   The cascade fires only while foreign keys are enforced, which is why the
 *   database connection asserts that rather than assuming it.
 * - Instants are epoch milliseconds in `integer` columns, and a nullable one
 *   means the event has not happened rather than being unknown.
 */
export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('username', 'text', (column) => column.notNull().unique())
    .addColumn('opaque_registration_record', 'text', (column) => column.notNull())
    .addColumn('root_public_key', 'text', (column) => column.notNull())
    .addColumn('root_key_commitment', 'text', (column) => column.notNull())
    .addColumn('root_epoch', 'integer', (column) => column.notNull())
    .addColumn('root_envelope_nonce', 'text', (column) => column.notNull())
    .addColumn('root_envelope_ciphertext', 'text', (column) => column.notNull())
    .addColumn('created_at', 'integer', (column) => column.notNull())
    // When the account asked to be erased. Signing in clears it: delegations are
    // revoked when erasure is scheduled, so a successful sign-in is the exact
    // signal that the holder came back, not a guess at one.
    .addColumn('deletion_scheduled_at', 'integer')
    // When an operator suspended the account. Deliberately keyed to the account
    // and nothing else: an IP or a device fingerprint would be a guess at the
    // person, wrong in both directions, where the account and its root key are
    // identities the server can prove.
    .addColumn('suspended_at', 'integer')
    .execute();

  await db.schema
    .createTable('browser_delegations')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('user_id', 'text', (column) =>
      column.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('root_epoch', 'integer', (column) => column.notNull())
    .addColumn('delegate_public_key', 'text', (column) => column.notNull())
    .addColumn('certificate_json', 'text', (column) => column.notNull())
    .addColumn('issued_at', 'integer', (column) => column.notNull())
    .addColumn('expires_at', 'integer', (column) => column.notNull())
    .addColumn('revoked_at', 'integer')
    // Parsed from the issuing request's `User-Agent` and written once, because
    // nothing later can ask the browser what it is, and letting a browser name a
    // session it can reach would let it rename someone else's. Both stay
    // nullable: a header the parser has never seen has no answer.
    .addColumn('client_browser', 'text')
    .addColumn('client_platform', 'text')
    // SQLite has no boolean.
    .addColumn('client_installed', 'integer', (column) => column.notNull().defaultTo(0))
    .execute();

  await db.schema
    .createTable('daemons')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('user_id', 'text', (column) =>
      column.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('platform', 'text', (column) => column.notNull())
    .addColumn('daemon_identity_public_key', 'text', (column) => column.notNull())
    .addColumn('daemon_identity_key_commitment', 'text', (column) => column.notNull())
    .addColumn('daemon_binding_json', 'text', (column) => column.notNull())
    .addColumn('last_seen', 'integer')
    .addColumn('version', 'text')
    // A daemon identity is composite: the ML-DSA-87 key above and a
    // hardware-resident P-256 key, required as a pair everywhere.
    .addColumn('daemon_identity_p256_public_key', 'text', (column) => column.notNull())
    .addColumn('identity_seal_backend', 'text', (column) => column.notNull())
    .execute();

  await db.schema
    .createTable('refresh_tokens')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('family_id', 'text', (column) => column.notNull())
    .addColumn('user_id', 'text', (column) =>
      column.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('delegation_id', 'text', (column) =>
      column.notNull().references('browser_delegations.id').onDelete('cascade'),
    )
    .addColumn('token_hash', 'text', (column) => column.notNull())
    .addColumn('expires_at', 'integer', (column) => column.notNull())
    .addColumn('rotated_at', 'integer')
    .execute();

  await db.schema
    .createTable('daemon_link_claims')
    .addColumn('link_claim_id', 'text', (column) => column.primaryKey())
    .addColumn('user_id', 'text', (column) =>
      column.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('state', 'text', (column) => column.notNull())
    .addColumn('claim_commitment', 'text', (column) => column.notNull())
    .addColumn('public_claim_json', 'text', (column) => column.notNull())
    .addColumn('poll_token_hash', 'text', (column) => column.notNull().unique())
    .addColumn('server_nonce', 'text', (column) => column.notNull())
    .addColumn('approval_json', 'text')
    .addColumn('expires_at', 'integer', (column) => column.notNull())
    .addColumn('attempt_count', 'integer', (column) => column.notNull())
    .addColumn('created_at', 'integer', (column) => column.notNull())
    .addColumn('approved_at', 'integer')
    .execute();

  await db.schema
    .createTable('delegation_revocations')
    .addColumn('nonce', 'text', (column) => column.primaryKey())
    .addColumn('user_id', 'text', (column) =>
      column.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('actor_delegation_id', 'text', (column) => column.notNull())
    .addColumn('actor_certificate_json', 'text', (column) => column.notNull())
    .addColumn('revocation_json', 'text', (column) => column.notNull())
    .addColumn('revoked_count', 'integer', (column) => column.notNull())
    .addColumn('created_at', 'integer', (column) => column.notNull())
    .execute();

  await db.schema
    .createTable('delegation_revocation_outbox')
    .addColumn('sequence', 'integer', (column) => column.primaryKey().autoIncrement())
    .addColumn('command_id', 'text', (column) => column.notNull().unique())
    .addColumn('revocation_nonce', 'text', (column) =>
      column.notNull().references('delegation_revocations.nonce').onDelete('cascade'),
    )
    .addColumn('daemon_id', 'text', (column) =>
      column.notNull().references('daemons.id').onDelete('cascade'),
    )
    .addColumn('user_id', 'text', (column) =>
      column.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('actor_certificate_json', 'text', (column) => column.notNull())
    .addColumn('revocation_json', 'text', (column) => column.notNull())
    .addColumn('created_at', 'integer', (column) => column.notNull())
    .addColumn('acknowledged_at', 'integer')
    .addColumn('rejected_reason', 'text')
    .execute();

  await db.schema
    .createTable('link_tokens')
    .addColumn('token_hash', 'text', (column) => column.primaryKey())
    .addColumn('user_id', 'text', (column) =>
      column.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('expires_at', 'integer', (column) => column.notNull())
    .addColumn('used_at', 'integer')
    .execute();

  await db.schema
    .createTable('push_subscriptions')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('user_id', 'text', (column) =>
      column.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('endpoint', 'text', (column) => column.notNull().unique())
    .addColumn('p256dh', 'text', (column) => column.notNull())
    .addColumn('auth', 'text', (column) => column.notNull())
    .execute();

  /**
   * Account-scoped keyboard arrangement, so it follows a user between devices.
   * One row per account, so the key is the account and there is no history to
   * reconcile. The document is opaque to the server: the key identifiers are the
   * browser keyboard's vocabulary, bounded and structurally validated at the
   * HTTP boundary, and normalized by the browser against the layout it applies.
   */
  await db.schema
    .createTable('keyboard_settings')
    .addColumn('user_id', 'text', (column) =>
      column.primaryKey().references('users.id').onDelete('cascade'),
    )
    .addColumn('settings_json', 'text', (column) => column.notNull())
    .addColumn('updated_at', 'integer', (column) => column.notNull())
    .execute();

  /**
   * Who may create hosted boxes. Signing up is open, but a box is a container on
   * a host with a fixed memory budget, so creating one is gated per account. No
   * row means the account never asked. Revoking returns the row to `waitlisted`
   * rather than deleting it, so the account keeps its place and the decision
   * keeps its record.
   */
  await db.schema
    .createTable('box_access')
    .addColumn('user_id', 'text', (column) =>
      column.primaryKey().notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('requested_at', 'integer', (column) => column.notNull())
    .addColumn('decided_at', 'integer')
    .addCheckConstraint('box_access_status', sql`status in ('waitlisted', 'approved')`)
    .execute();

  await db.schema.createIndex('idx_users_username').on('users').column('username').execute();
  // Partial: the erasure sweep only ever asks for rows that are due, and in the
  // ordinary case no account has asked at all, so the index stays empty.
  await db.schema
    .createIndex('users_deletion_scheduled_at_idx')
    .on('users')
    .column('deletion_scheduled_at')
    .where('deletion_scheduled_at', 'is not', null)
    .execute();

  await db.schema
    .createIndex('idx_browser_delegations_user_id')
    .on('browser_delegations')
    .column('user_id')
    .execute();
  await db.schema
    .createIndex('idx_browser_delegations_expires_at')
    .on('browser_delegations')
    .column('expires_at')
    .execute();

  await db.schema.createIndex('idx_daemons_user_id').on('daemons').column('user_id').execute();
  // Serves the replaced-daemon delete during device linking, which filters on
  // (user_id, name, platform); the plain user_id index forced a row scan.
  await db.schema
    .createIndex('idx_daemons_user_id_name_platform')
    .on('daemons')
    .columns(['user_id', 'name', 'platform'])
    .execute();

  await db.schema
    .createIndex('idx_refresh_tokens_user_id')
    .on('refresh_tokens')
    .column('user_id')
    .execute();
  await db.schema
    .createIndex('idx_refresh_tokens_delegation_id')
    .on('refresh_tokens')
    .column('delegation_id')
    .execute();
  await db.schema
    .createIndex('idx_refresh_tokens_token_hash')
    .on('refresh_tokens')
    .column('token_hash')
    .execute();
  await db.schema
    .createIndex('idx_refresh_tokens_expires_at')
    .on('refresh_tokens')
    .column('expires_at')
    .execute();
  await db.schema
    .createIndex('idx_refresh_tokens_family_id')
    .on('refresh_tokens')
    .column('family_id')
    .execute();

  await db.schema
    .createIndex('idx_daemon_link_claims_expires_at')
    .on('daemon_link_claims')
    .column('expires_at')
    .execute();

  await db.schema
    .createIndex('idx_delegation_revocation_outbox_daemon_pending')
    .on('delegation_revocation_outbox')
    .columns(['daemon_id', 'acknowledged_at'])
    .execute();
  await db.schema
    .createIndex('idx_delegation_revocation_outbox_revocation_daemon')
    .unique()
    .on('delegation_revocation_outbox')
    .columns(['revocation_nonce', 'daemon_id'])
    .execute();

  await db.schema
    .createIndex('idx_link_tokens_user_id')
    .on('link_tokens')
    .column('user_id')
    .execute();
  await db.schema
    .createIndex('idx_link_tokens_expires_at')
    .on('link_tokens')
    .column('expires_at')
    .execute();

  await db.schema
    .createIndex('idx_push_subscriptions_user_id')
    .on('push_subscriptions')
    .column('user_id')
    .execute();

  await db.schema
    .createIndex('box_access_requested_at_idx')
    .on('box_access')
    .column('requested_at')
    .execute();
}

export async function down(db: Kysely<DatabaseSchema>): Promise<void> {
  // Dropped in reverse dependency order so each table goes before the ones it
  // references, which keeps the statement valid with foreign keys enforced.
  await db.schema.dropTable('box_access').execute();
  await db.schema.dropTable('keyboard_settings').execute();
  await db.schema.dropTable('push_subscriptions').execute();
  await db.schema.dropTable('link_tokens').execute();
  await db.schema.dropTable('delegation_revocation_outbox').execute();
  await db.schema.dropTable('delegation_revocations').execute();
  await db.schema.dropTable('daemon_link_claims').execute();
  await db.schema.dropTable('refresh_tokens').execute();
  await db.schema.dropTable('daemons').execute();
  await db.schema.dropTable('browser_delegations').execute();
  await db.schema.dropTable('users').execute();
}
