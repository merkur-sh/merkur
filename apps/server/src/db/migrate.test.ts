import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Kysely, sql } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { createDatabaseClient } from './client';
import { LibsqlDialect } from './libsql-dialect';
import { createMigratedKyselyDatabase } from './migrate';
import type { DatabaseSchema } from './types';

const SOURCE_MIGRATIONS = path.resolve(import.meta.dir, '../../migrations');
const INITIAL_MIGRATION = '001_initial_schema.ts';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('schema migration', () => {
  test('declares the schema', async () => {
    const db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
    try {
      expect(await tableNames(db)).toEqual([
        'box_access',
        'box_removals',
        'box_waitlist',
        'browser_delegations',
        'daemon_link_claims',
        'daemons',
        'delegation_revocation_outbox',
        'delegation_revocations',
        'keyboard_settings',
        'link_tokens',
        'notification_outbox',
        'push_subscriptions',
        'refresh_tokens',
        'users',
      ]);
      expect(await tableColumns(db, 'box_waitlist')).toEqual(['email', 'created_at']);
      expect(await tableColumns(db, 'box_removals')).toEqual(['box_id', 'requested_at']);
      expect(await tableColumns(db, 'users')).toEqual([
        'id',
        'username',
        'opaque_registration_record',
        'root_public_key',
        'root_key_commitment',
        'root_epoch',
        'root_envelope_nonce',
        'root_envelope_ciphertext',
        'created_at',
        'deletion_scheduled_at',
        'suspended_at',
        'privileged_at',
      ]);
      expect(await tableColumns(db, 'daemons')).toContain('identity_seal_backend');
      for (const table of ['link_tokens', 'daemon_link_claims', 'daemons']) {
        expect(await tableColumns(db, table)).toContain('box_id');
      }
      expect(await tableColumns(db, 'browser_delegations')).toContain('client_installed');
      expect(await tableColumns(db, 'refresh_tokens')).toContain('delegation_id');
    } finally {
      await db.destroy();
    }
  });

  test('erases every account-owned row when the account row goes', async () => {
    // Account erasure is one `DELETE FROM users` and nothing else: it relies
    // entirely on `ON DELETE CASCADE` reaching every table that belongs to an
    // account, while foreign keys are enforced. A table added without that
    // clause — or enforcement silently off — leaves personal data behind and
    // still looks like it succeeded, so assert the erasure rather than the
    // declaration.
    const db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
    try {
      expect(await foreignKeysEnforced(db)).toBe(true);
      await seedFullAccount(db);
      await db.insertInto('box_removals').values({ box_id: 'box-1', requested_at: 1 }).execute();

      for (const table of ACCOUNT_OWNED_TABLES) {
        expect(await rowCount(db, table)).toBe(1);
      }

      await db.deleteFrom('users').where('id', '=', 'user-1').execute();

      for (const table of ACCOUNT_OWNED_TABLES) {
        expect({ table, rows: await rowCount(db, table) }).toEqual({ table, rows: 0 });
      }
      // A box queued for destruction names no account: the container still
      // exists, so its removal stays owed after the account is gone.
      expect(await rowCount(db, 'box_removals')).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  test('drops every table it created', async () => {
    const directory = await migrationDirectory();
    const db = createDatabase(`file:${path.join(directory, 'merkur.sqlite')}`);
    try {
      await createMigrator(db, directory).migrateToLatest();
      expect((await tableNames(db)).length).toBeGreaterThan(0);

      const result = await createMigrator(db, directory).migrateDown();

      expect(result.error).toBeUndefined();
      expect(await tableNames(db)).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  test('leaves the database untouched when any migration in the run fails', async () => {
    // `MerkurSqliteAdapter` opts into transactional DDL, and Kysely then runs a
    // whole `migrateToLatest` inside one transaction. So the unit that succeeds
    // or fails is the run, not the migration: a failure anywhere in it takes
    // back every earlier migration of the same run, ledger rows included.
    // Without transactional DDL a half-applied schema would survive with no
    // ledger row to explain it.
    const directory = await migrationDirectory();
    await writeMigration(
      directory,
      '002_fails_after_ddl.ts',
      `
      import type { Kysely } from 'kysely';
      export async function up(db: Kysely<never>): Promise<void> {
        await db.schema.createTable('half_applied').addColumn('id', 'text').execute();
        throw new Error('injected migration failure');
      }
      export async function down(): Promise<void> {}
      `,
    );
    const db = createDatabase(`file:${path.join(directory, 'merkur.sqlite')}`);
    try {
      const result = await createMigrator(db, directory).migrateToLatest();

      expect(result.error).toBeDefined();
      expect(await tableNames(db)).toEqual([]);
      expect(await appliedMigrations(db)).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  test('rolls the DDL back when the ledger insert fails after it', async () => {
    // The bookkeeping write shares the migration's transaction, so a rejected
    // ledger insert has to take the schema change with it. Otherwise the
    // migration is applied but unrecorded, and the next start replays it.
    const directory = await migrationDirectory();
    await writeMigration(
      directory,
      '002_adds_a_table.ts',
      `
      import type { Kysely } from 'kysely';
      export async function up(db: Kysely<never>): Promise<void> {
        await db.schema.createTable('recorded_only_on_commit').addColumn('id', 'text').execute();
      }
      export async function down(): Promise<void> {}
      `,
    );
    const db = createDatabase(`file:${path.join(directory, 'merkur.sqlite')}`);
    try {
      await createMigrator(db, directory).migrateTo('001_initial_schema');
      await sql`
        CREATE TRIGGER reject_second_migration_ledger
        BEFORE INSERT ON kysely_migration
        WHEN NEW.name = '002_adds_a_table'
        BEGIN
          SELECT RAISE(ABORT, 'injected migration ledger failure');
        END
      `.execute(db);

      const result = await createMigrator(db, directory).migrateToLatest();

      expect(result.error).toBeDefined();
      expect(await tableNames(db)).not.toContain('recorded_only_on_commit');
      expect(await appliedMigrations(db)).toEqual(['001_initial_schema']);
    } finally {
      await db.destroy();
    }
  });
});

/** Every table whose rows belong to one account, and so must go with it. */
const ACCOUNT_OWNED_TABLES = [
  'box_access',
  'browser_delegations',
  'daemon_link_claims',
  'daemons',
  'delegation_revocation_outbox',
  'delegation_revocations',
  'keyboard_settings',
  'link_tokens',
  'push_subscriptions',
  'refresh_tokens',
] as const;

async function seedFullAccount(db: Kysely<DatabaseSchema>): Promise<void> {
  await db
    .insertInto('users')
    .values({
      id: 'user-1',
      username: 'alice',
      opaque_registration_record: 'record',
      root_public_key: 'root-public-key',
      root_key_commitment: 'root-key-commitment',
      root_epoch: 1,
      root_envelope_nonce: 'nonce',
      root_envelope_ciphertext: 'ciphertext',
      created_at: 1,
    })
    .execute();
  await db
    .insertInto('browser_delegations')
    .values({
      id: 'delegation-1',
      user_id: 'user-1',
      root_epoch: 1,
      delegate_public_key: 'delegate',
      certificate_json: '{}',
      issued_at: 1,
      expires_at: 2,
      revoked_at: null,
      client_browser: null,
      client_platform: null,
    })
    .execute();
  await db
    .insertInto('daemons')
    .values({
      id: 'daemon-1',
      user_id: 'user-1',
      name: 'machine',
      platform: 'test',
      daemon_identity_public_key: 'identity',
      daemon_identity_key_commitment: 'commitment',
      daemon_binding_json: 'binding',
      daemon_identity_p256_public_key: 'identity-p256',
      identity_seal_backend: 'software',
    })
    .execute();
  await db
    .insertInto('refresh_tokens')
    .values({
      id: 'refresh-1',
      family_id: 'family-1',
      user_id: 'user-1',
      delegation_id: 'delegation-1',
      token_hash: 'hash',
      expires_at: 2,
      rotated_at: null,
    })
    .execute();
  await db
    .insertInto('daemon_link_claims')
    .values({
      link_claim_id: 'claim-1',
      user_id: 'user-1',
      state: 'pending',
      claim_commitment: 'commitment',
      public_claim_json: '{}',
      poll_token_hash: 'poll-hash',
      server_nonce: 'server-nonce',
      approval_json: null,
      expires_at: 2,
      attempt_count: 0,
      created_at: 1,
      approved_at: null,
    })
    .execute();
  await db
    .insertInto('delegation_revocations')
    .values({
      nonce: 'revocation-1',
      user_id: 'user-1',
      actor_delegation_id: 'delegation-1',
      actor_certificate_json: '{}',
      revocation_json: '{}',
      revoked_count: 1,
      created_at: 1,
    })
    .execute();
  await db
    .insertInto('delegation_revocation_outbox')
    .values({
      command_id: 'command-1',
      revocation_nonce: 'revocation-1',
      daemon_id: 'daemon-1',
      user_id: 'user-1',
      actor_certificate_json: '{}',
      revocation_json: '{}',
      created_at: 1,
      acknowledged_at: null,
      rejected_reason: null,
    })
    .execute();
  await db
    .insertInto('link_tokens')
    .values({ token_hash: 'link-hash', user_id: 'user-1', expires_at: 2, used_at: null })
    .execute();
  await db
    .insertInto('push_subscriptions')
    .values({
      id: 'push-1',
      user_id: 'user-1',
      endpoint: 'https://push.example/1',
      p256dh: 'p256dh',
      auth: 'auth',
    })
    .execute();
  await db
    .insertInto('keyboard_settings')
    .values({ user_id: 'user-1', settings_json: '{}', updated_at: 1 })
    .execute();
  await db
    .insertInto('box_access')
    .values({ user_id: 'user-1', status: 'approved', requested_at: 1, decided_at: 2 })
    .execute();
}

function createDatabase(databaseUrl = ':memory:'): Kysely<DatabaseSchema> {
  return new Kysely<DatabaseSchema>({
    dialect: new LibsqlDialect(createDatabaseClient(databaseUrl, undefined)),
  });
}

/**
 * Scratch migration folders live inside the server package, not in
 * `os.tmpdir()`. `FileMigrationProvider` imports each file it finds, and
 * `001_initial_schema` imports `sql` from `kysely` as a value, so the copy only
 * resolves its imports from a path that reaches the node_modules of a package
 * declaring `kysely`. Under the isolated linker that is `apps/server`, never the
 * repository root: a root-level scratch folder resolved only where a stale
 * hoisted install had left a root `kysely` behind. Production has the same
 * requirement met a different way: the Dockerfile bundles the migrations with
 * their runtime imports, because the signed runtime has no `node_modules` at
 * all. (`data/` is ignored at any depth.)
 */
const TEST_SCRATCH_ROOT = path.resolve(import.meta.dir, '../../data');

async function migrationDirectory(): Promise<string> {
  await mkdir(TEST_SCRATCH_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(TEST_SCRATCH_ROOT, 'merkur-migrations-'));
  temporaryDirectories.push(directory);
  await copyFile(
    path.join(SOURCE_MIGRATIONS, INITIAL_MIGRATION),
    path.join(directory, INITIAL_MIGRATION),
  );
  return directory;
}

async function writeMigration(directory: string, name: string, source: string): Promise<void> {
  await writeFile(path.join(directory, name), source);
}

async function tableNames(db: Kysely<DatabaseSchema>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'kysely_%'
    ORDER BY name
  `.execute(db);
  return result.rows.map((row) => row.name);
}

async function tableColumns(db: Kysely<DatabaseSchema>, table: string): Promise<string[]> {
  const result = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(table)})`.execute(db);
  return result.rows.map((row) => row.name);
}

async function foreignKeysEnforced(db: Kysely<DatabaseSchema>): Promise<boolean> {
  const result = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(db);
  return result.rows[0]?.foreign_keys === 1;
}

async function rowCount(db: Kysely<DatabaseSchema>, table: string): Promise<number> {
  const result = await sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM ${sql.raw(table)}
  `.execute(db);
  return Number(result.rows[0]?.count ?? -1);
}

async function appliedMigrations(db: Kysely<DatabaseSchema>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT name FROM kysely_migration ORDER BY name
  `.execute(db);
  return result.rows.map((row) => row.name);
}

function createMigrator(db: Kysely<DatabaseSchema>, directory: string): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: directory }),
  });
}
