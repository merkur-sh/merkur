import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { createMigratedKyselyDatabase } from '../src/db/migrate';
import type { DatabaseSchema } from '../src/db/types';

const SCRIPT = path.resolve(import.meta.dir, 'database-backup.ts');
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

    expect(await run(['dump', '--url', source, '--out', dumpFile])).toBe(0);
    expect(await run(['restore', '--url', target, '--in', dumpFile])).toBe(0);

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
        },
      ]);
      const daemons = await restored.selectFrom('daemons').select(['id', 'name']).execute();
      expect(daemons).toEqual([{ id: 'daemon-1', name: 'quiet-willow' }]);
      const access = await restored.selectFrom('box_access').select('status').execute();
      expect(access).toEqual([{ status: 'approved' }]);
      const waitlist = await restored.selectFrom('box_waitlist').selectAll().execute();
      expect(waitlist).toEqual([{ email: 'bob@example.com', created_at: 3 }]);
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
    await run(['dump', '--url', source, '--out', dumpFile]);

    const lines = (await Bun.file(dumpFile).text()).split('\n').filter((line) => line.length > 0);
    const trailer = lines.pop();
    if (trailer === undefined) throw new Error('dump has no trailer');
    await Bun.write(dumpFile, `${[...lines.slice(0, -1), trailer].join('\n')}\n`);

    expect(await run(['restore', '--url', target, '--in', dumpFile])).not.toBe(0);
  });

  test('refuses to restore over a database that already holds accounts', async () => {
    const directory = await scratchDirectory();
    const source = `file:${path.join(directory, 'source.db')}`;
    const dumpFile = path.join(directory, 'dump.jsonl');
    await seed(source);
    await run(['dump', '--url', source, '--out', dumpFile]);

    expect(await run(['restore', '--url', source, '--in', dumpFile])).not.toBe(0);
  });
});

async function scratchDirectory(): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(SCRATCH_ROOT, 'merkur-backup-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function run(argv: readonly string[]): Promise<number> {
  const child = Bun.spawn(['bun', 'run', SCRIPT, ...argv], {
    cwd: REPO_ROOT,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return await child.exited;
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
      .insertInto('box_access')
      .values({ user_id: 'user-1', status: 'approved', requested_at: 1, decided_at: 2 })
      .execute();
    await db
      .insertInto('box_waitlist')
      .values({ email: 'bob@example.com', created_at: 3 })
      .execute();
  } finally {
    await db.destroy();
  }
}
