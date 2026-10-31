import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { sql } from 'kysely';

import { createMigratedKyselyDatabase } from '../src/db/migrate';
import type { DatabaseSchema } from '../src/db/types';
import { dump, restore } from './database-backup';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const SCRATCH_ROOT = path.join(REPO_ROOT, 'data');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('database backup', () => {
  test('carries every row through a dump and back into an empty database', async () => {
    const directory = await scratchDirectory();
    const source = `file:${path.join(directory, 'source.db')}`;
    const target = `file:${path.join(directory, 'target.db')}`;
    const dumpFile = path.join(directory, 'dump.jsonl');
    await seed(source);

    await dump(source, dumpFile);
    await restore(target, dumpFile);

    const restored = await createMigratedKyselyDatabase<DatabaseSchema>(target);
    try {
      expect(await restored.selectFrom('users').selectAll().execute()).toEqual([
        {
          id: 'user-1',
          username: 'alice',
          opaque_registration_record: 'record',
          root_public_key: 'root-public-key',
          root_key_commitment: 'root-key-commitment',
          root_epoch: 1,
          root_envelope_nonce: 'nonce',
          root_envelope_ciphertext: 'ciphertext',
          created_at: 10,
          deletion_scheduled_at: null,
          suspended_at: null,
          privileged_at: null,
          last_sign_in_at: 20,
          inactivity_notice_sent_at: 30,
          telemetry_consent: 1,
        },
      ]);
      const daemons = await restored.selectFrom('daemons').select(['id', 'name']).execute();
      expect(daemons).toEqual([{ id: 'daemon-1', name: 'quiet-willow' }]);
      expect(await restored.selectFrom('daemon_control_owners').selectAll().execute()).toEqual([
        {
          connection_id: 'connection-live',
          daemon_id: 'daemon-1',
          user_id: 'user-1',
          owner_instance_id: 'replica-1',
          presence_id: 'presence-live',
          claim_seq: 2,
          root_epoch: 1,
        },
      ]);
      expect(await restored.selectFrom('daemon_unlinks').selectAll().execute()).toEqual([
        {
          connection_id: 'connection-old',
          daemon_id: 'daemon-1',
          user_id: 'user-1',
          owner_instance_id: 'replica-1',
          presence_id: 'presence-old',
          claim_seq: 1,
          root_epoch: 0,
        },
      ]);
      expect(
        await restored
          .selectFrom('delegation_revocation_order')
          .selectAll()
          .orderBy('sequence')
          .execute(),
      ).toEqual([
        { sequence: 17, nonce: 'z-first' },
        { sequence: 23, nonce: 'a-second' },
      ]);
      await restored
        .insertInto('delegation_revocations')
        .values({
          nonce: 'after-restore',
          user_id: 'user-1',
          actor_delegation_id: 'actor',
          actor_certificate_json: '{}',
          revocation_json: '{}',
          revoked_count: 1,
          created_at: 10,
        })
        .execute();
      expect(
        await restored
          .selectFrom('delegation_revocation_order')
          .select('sequence')
          .where('nonce', '=', 'after-restore')
          .executeTakeFirstOrThrow(),
      ).toEqual({ sequence: 24 });
      const access = await restored.selectFrom('box_access').select('status').execute();
      expect(access).toEqual([{ status: 'approved' }]);
      const waitlist = await restored.selectFrom('box_waitlist').selectAll().execute();
      expect(waitlist).toEqual([{ email: 'bob@example.com', created_at: 3 }]);
      const removals = await restored.selectFrom('box_removals').selectAll().execute();
      expect(removals).toEqual([{ box_id: 'box-1', requested_at: 4 }]);
      const outbox = await restored.selectFrom('notification_outbox').selectAll().execute();
      expect(outbox.filter((row) => row.kind !== 'daemon-control')).toEqual([
        { id: 'note-1', user_id: 'user-1', kind: 'welcome', payload: '{}' },
      ]);
      const wakes = outbox.filter((row) => row.kind === 'daemon-control');
      expect(wakes).toHaveLength(2);
      for (const wake of wakes)
        expect(JSON.parse(wake.payload)).toEqual({
          type: 'daemon_work',
          version: 1,
          daemonId: 'daemon-1',
          ownerInstanceId: 'replica-1',
        });
    } finally {
      await restored.destroy();
    }
  });

  test('refuses a dump that was cut short', async () => {
    // A truncated dump still parses line by line; only the counts the trailer
    // declares reveal that rows are missing. Without that check a backup lost
    // to a dropped connection would restore as a smaller, plausible database.
    const directory = await scratchDirectory();
    const source = `file:${path.join(directory, 'source.db')}`;
    const target = `file:${path.join(directory, 'target.db')}`;
    const dumpFile = path.join(directory, 'dump.jsonl');
    await seed(source);
    await dump(source, dumpFile);

    const lines = (await Bun.file(dumpFile).text()).split('\n').filter((line) => line.length > 0);
    const trailer = lines.pop();
    if (trailer === undefined) throw new Error('dump has no trailer');
    await Bun.write(dumpFile, `${[...lines.slice(0, -1), trailer].join('\n')}\n`);

    await expect(restore(target, dumpFile)).rejects.toThrow('is truncated');
  });

  test('refuses to dump a database with a table it does not know', async () => {
    // A table a migration adds but the list lacks would silently be left out of
    // every backup; the dump fails instead, so the gap shows the first night.
    const directory = await scratchDirectory();
    const source = `file:${path.join(directory, 'source.db')}`;
    const db = await createMigratedKyselyDatabase<DatabaseSchema>(source);
    try {
      await sql`CREATE TABLE unlisted (id TEXT PRIMARY KEY)`.execute(db);
    } finally {
      await db.destroy();
    }

    await expect(dump(source, path.join(directory, 'dump.jsonl'))).rejects.toThrow(
      'tables missing from the dump list: unlisted',
    );
  });

  test('refuses to restore over a database that already holds accounts', async () => {
    const directory = await scratchDirectory();
    const source = `file:${path.join(directory, 'source.db')}`;
    const dumpFile = path.join(directory, 'dump.jsonl');
    await seed(source);
    await dump(source, dumpFile);

    await expect(restore(source, dumpFile)).rejects.toThrow('already holds accounts');
  });
});

async function scratchDirectory(): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(SCRATCH_ROOT, 'merkur-backup-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function seed(url: string): Promise<void> {
  const db = await createMigratedKyselyDatabase<DatabaseSchema>(url);
  try {
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
        created_at: 10,
        last_sign_in_at: 20,
        inactivity_notice_sent_at: 30,
        telemetry_consent: 1,
      })
      .execute();
    await db
      .insertInto('daemons')
      .values({
        id: 'daemon-1',
        user_id: 'user-1',
        name: 'quiet-willow',
        platform: 'linux',
        daemon_identity_public_key: 'identity',
        daemon_identity_key_commitment: 'commitment',
        daemon_binding_json: '{}',
        daemon_identity_p256_public_key: 'identity-p256',
        identity_seal_backend: 'software',
      })
      .execute();
    await db
      .insertInto('daemon_control_owners')
      .values({
        connection_id: 'connection-live',
        daemon_id: 'daemon-1',
        user_id: 'user-1',
        owner_instance_id: 'replica-1',
        presence_id: 'presence-live',
        claim_seq: 2,
        root_epoch: 1,
      })
      .execute();
    await db
      .insertInto('daemon_unlinks')
      .values({
        connection_id: 'connection-old',
        daemon_id: 'daemon-1',
        user_id: 'user-1',
        owner_instance_id: 'replica-1',
        presence_id: 'presence-old',
        claim_seq: 1,
        root_epoch: 0,
      })
      .execute();
    for (const nonce of ['z-first', 'a-second']) {
      await db
        .insertInto('delegation_revocations')
        .values({
          nonce,
          user_id: 'user-1',
          actor_delegation_id: 'actor',
          actor_certificate_json: '{}',
          revocation_json: '{}',
          revoked_count: 1,
          created_at: 30,
        })
        .execute();
    }
    await db
      .updateTable('delegation_revocation_order')
      .set({ sequence: 17 })
      .where('nonce', '=', 'z-first')
      .execute();
    await db
      .updateTable('delegation_revocation_order')
      .set({ sequence: 23 })
      .where('nonce', '=', 'a-second')
      .execute();
    await db
      .insertInto('box_access')
      .values({ user_id: 'user-1', status: 'approved', requested_at: 1, decided_at: 2 })
      .execute();
    await db
      .insertInto('box_waitlist')
      .values({ email: 'bob@example.com', created_at: 3 })
      .execute();
    await db.insertInto('box_removals').values({ box_id: 'box-1', requested_at: 4 }).execute();
    await db
      .insertInto('notification_outbox')
      .values({ id: 'note-1', user_id: 'user-1', kind: 'welcome', payload: '{}' })
      .execute();
  } finally {
    await db.destroy();
  }
}
