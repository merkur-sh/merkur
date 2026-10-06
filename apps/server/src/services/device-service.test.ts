import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  deriveSessionAuthorizationKeyPair,
  deriveSoftwareDaemonP256PublicKey,
  hashToken,
  signDaemonProof,
} from '@merkur/auth';
import { Effect } from 'effect';
import { type Kysely, sql } from 'kysely';

import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import { createDeviceService } from './device-service';

const SEED = Buffer.alloc(32, 0x22);
const PUBLIC_KEY = Buffer.from(deriveSessionAuthorizationKeyPair(SEED).verifyKey).toString(
  'base64url',
);

const HMAC_SECRET = 'test-hmac-secret';
const PUBLIC_ORIGIN = 'https://merkur.test';

let db: Kysely<DatabaseSchema>;

beforeEach(async () => {
  db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
  await insertUser(db, 'user-1');
});

describe('DeviceService', () => {
  test('rename and unlink roll back when their durable invalidation cannot be recorded', async () => {
    const service = createDeviceService(
      db,
      { tokenHmacSecret: HMAC_SECRET, publicOrigin: PUBLIC_ORIGIN },
      Effect.void,
    );
    await insertDaemon(db, 'daemon-atomic');
    await sql`CREATE TRIGGER refuse_notification BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(FAIL, 'notification unavailable'); END`.execute(
      db,
    );
    await expect(
      Effect.runPromise(
        service.renameDevice({ userId: 'user-1', deviceId: 'daemon-atomic', name: 'new' }),
      ),
    ).rejects.toThrow('notification unavailable');
    await expect(
      Effect.runPromise(service.deleteDevice('user-1', 'daemon-atomic')),
    ).rejects.toThrow('notification unavailable');
    expect(
      (
        await db
          .selectFrom('daemons')
          .select('name')
          .where('id', '=', 'daemon-atomic')
          .executeTakeFirstOrThrow()
      ).name,
    ).toBe('Daemon');
    await sql`DROP TRIGGER refuse_notification`.execute(db);
    await Effect.runPromise(
      service.renameDevice({ userId: 'user-1', deviceId: 'daemon-atomic', name: 'new' }),
    );
    await Effect.runPromise(service.deleteDevice('user-1', 'daemon-atomic'));
    expect(await db.selectFrom('notification_outbox').selectAll().execute()).toHaveLength(2);
  });

  test('request identity lookups bind precompiled SQL without running the query compiler', async () => {
    await insertDaemon(db, 'daemon-compiled');
    const service = createDeviceService(
      db,
      { tokenHmacSecret: HMAC_SECRET, publicOrigin: PUBLIC_ORIGIN },
      Effect.void,
    );
    const compiler = spyOn(db.getExecutor(), 'compileQuery').mockImplementation(() => {
      throw new Error('request compiled SQL');
    });
    try {
      expect(
        await Effect.runPromise(service.getDaemonSessionIdentity('user-1', 'daemon-compiled')),
      ).not.toBeNull();
      expect(
        await Effect.runPromise(
          service.authenticateDaemonProof('missing', new Uint8Array(), '', 'http', ''),
        ),
      ).toBeNull();
      expect(compiler).not.toHaveBeenCalled();
    } finally {
      compiler.mockRestore();
    }
  });

  test('creates a one-use admission token without storing the bearer value', async () => {
    const service = createDeviceService(
      db,
      {
        tokenHmacSecret: HMAC_SECRET,
        publicOrigin: PUBLIC_ORIGIN,
      },
      Effect.void,
    );

    const result = await Effect.runPromise(service.createLinkToken('user-1', null));

    expect(result.token).toMatch(/^[0-9A-HJ-NP-Z]{52}$/);
    // One command installs and links. The token rides in the installer's
    // environment, never its argv, so `ps` cannot show it.
    expect(result.command).toBe(
      `curl -fsSL "${PUBLIC_ORIGIN}/install" | MERKUR_LINK_TOKEN=${result.token} sh`,
    );
    const row = await db
      .selectFrom('link_tokens')
      .select(['token_hash', 'used_at'])
      .executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(hashToken(result.token, HMAC_SECRET, 'device-link'));
    expect(row.token_hash).not.toContain(result.token);
    expect(row.used_at).toBeNull();
  });

  test('binds a box link token to its box and resolves a device to it exactly', async () => {
    const service = createDeviceService(
      db,
      {
        tokenHmacSecret: HMAC_SECRET,
        publicOrigin: PUBLIC_ORIGIN,
      },
      Effect.void,
    );

    await Effect.runPromise(service.createLinkToken('user-1', 'calm-harbor'));
    const token = await db.selectFrom('link_tokens').select('box_id').executeTakeFirstOrThrow();
    expect(token.box_id).toBe('calm-harbor');

    await insertDaemon(db, 'daemon-box', 'calm-harbor');
    await insertDaemon(db, 'daemon-laptop');
    expect(await Effect.runPromise(service.resolveBox('user-1', 'daemon-box'))).toEqual({
      boxId: 'calm-harbor',
      ambiguousBoxId: null,
    });
    expect(await Effect.runPromise(service.resolveBox('user-1', 'daemon-laptop'))).toEqual({
      boxId: null,
      ambiguousBoxId: null,
    });

    // A stale row carrying the same box makes the box unsafe to act on.
    await insertDaemon(db, 'daemon-stale', 'calm-harbor');
    expect(await Effect.runPromise(service.resolveBox('user-1', 'daemon-box'))).toEqual({
      boxId: null,
      ambiguousBoxId: 'calm-harbor',
    });
  });

  test('records liveness for many daemons in one write, throttled per daemon', async () => {
    const service = createDeviceService(
      db,
      {
        tokenHmacSecret: HMAC_SECRET,
        publicOrigin: PUBLIC_ORIGIN,
      },
      Effect.void,
    );
    await insertDaemon(db, 'daemon-1');
    await insertDaemon(db, 'daemon-2');

    await Effect.runPromise(service.touchDaemonsSeen(['daemon-1', 'daemon-2']));
    const seen = await readLastSeen(db);
    expect(seen.get('daemon-1')).not.toBeNull();
    expect(seen.get('daemon-2')).not.toBeNull();

    // Inside the throttle window nothing is rewritten: a renewal walk runs on
    // its own cadence and must not turn into a row write per daemon per tick.
    await Effect.runPromise(service.touchDaemonsSeen(['daemon-1']));
    expect((await readLastSeen(db)).get('daemon-1')).toBe(seen.get('daemon-1') ?? null);

    // A daemon the throttle has never seen is written even alongside one it has.
    await insertDaemon(db, 'daemon-3');
    await Effect.runPromise(service.touchDaemonsSeen(['daemon-1', 'daemon-3']));
    expect((await readLastSeen(db)).get('daemon-3')).not.toBeNull();
  });

  test('a newly reported build resyncs device lists once, in the same write', async () => {
    let wakes = 0;
    const wake = Effect.sync(() => {
      wakes += 1;
    });
    const config = { tokenHmacSecret: HMAC_SECRET, publicOrigin: PUBLIC_ORIGIN };
    const service = createDeviceService(db, config, wake);
    await insertDaemon(db, 'daemon-1');

    await Effect.runPromise(service.touchDaemon('daemon-1', 'v0.68.0'));
    expect(await readVersion(db, 'daemon-1')).toBe('v0.68.0');
    expect(await readResyncs(db)).toEqual(['user-1']);
    expect(wakes).toBe(1);

    // The same build again, or after a server restart emptied the throttle,
    // changes no row the list shows.
    await Effect.runPromise(service.touchDaemon('daemon-1', 'v0.68.0'));
    await Effect.runPromise(
      createDeviceService(db, config, wake).touchDaemon('daemon-1', 'v0.68.0'),
    );
    expect(await readResyncs(db)).toHaveLength(1);
    expect(wakes).toBe(1);

    // An update inside the throttle window still reaches every list.
    await Effect.runPromise(service.touchDaemon('daemon-1', 'v0.68.1'));
    expect(await readVersion(db, 'daemon-1')).toBe('v0.68.1');
    expect(await readResyncs(db)).toEqual(['user-1', 'user-1']);
    expect(wakes).toBe(2);

    // A version the list cannot be told about is not recorded either.
    await sql`CREATE TRIGGER refuse_notification BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(FAIL, 'notification unavailable'); END`.execute(
      db,
    );
    await expect(Effect.runPromise(service.touchDaemon('daemon-1', 'v0.69.0'))).rejects.toThrow(
      'notification unavailable',
    );
    expect(await readVersion(db, 'daemon-1')).toBe('v0.68.1');
    await sql`DROP TRIGGER refuse_notification`.execute(db);
    await Effect.runPromise(service.touchDaemon('daemon-1', 'v0.69.0'));
    expect(await readVersion(db, 'daemon-1')).toBe('v0.69.0');
    expect(await readResyncs(db)).toHaveLength(3);
    expect(wakes).toBe(3);
  });

  test('keeps a daemon unavailable for sessions until every revocation is acknowledged', async () => {
    const service = createDeviceService(
      db,
      {
        tokenHmacSecret: HMAC_SECRET,
        publicOrigin: PUBLIC_ORIGIN,
      },
      Effect.void,
    );
    await insertDaemon(db, 'daemon-1');

    await expect(
      Effect.runPromise(service.getDaemonSessionIdentity('user-1', 'daemon-1')),
    ).resolves.toEqual({
      daemonIdentityPublicKey: PUBLIC_KEY,
      daemonIdentityP256PublicKey: Buffer.from(deriveSoftwareDaemonP256PublicKey(SEED)).toString(
        'base64url',
      ),
      daemonBindingJson: '{"binding":true}',
    });

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

    await expect(
      Effect.runPromise(service.getDaemonSessionIdentity('user-1', 'daemon-1')),
    ).resolves.toBeNull();
    await db
      .updateTable('delegation_revocation_outbox')
      .set({ acknowledged_at: 2 })
      .where('command_id', '=', 'command-1')
      .execute();
    await expect(
      Effect.runPromise(service.getDaemonSessionIdentity('user-1', 'daemon-1')),
    ).resolves.toEqual({
      daemonIdentityPublicKey: PUBLIC_KEY,
      daemonIdentityP256PublicKey: Buffer.from(deriveSoftwareDaemonP256PublicKey(SEED)).toString(
        'base64url',
      ),
      daemonBindingJson: '{"binding":true}',
    });
  });

  test('authenticates possession of the linked identity and rejects cross-purpose proofs', async () => {
    const service = createDeviceService(
      db,
      {
        tokenHmacSecret: HMAC_SECRET,
        publicOrigin: PUBLIC_ORIGIN,
      },
      Effect.void,
    );
    await insertDaemon(db, 'daemon-1');

    const transcript = new TextEncoder().encode('bound request');
    const signature = signDaemonProof(SEED.toString('base64url'), 'http', transcript);
    await expect(
      Effect.runPromise(
        service.authenticateDaemonProof(
          'daemon-1',
          transcript,
          signature.mldsa,
          'http',
          signature.p256,
        ),
      ),
    ).resolves.toEqual({ daemonId: 'daemon-1', userId: 'user-1', boxId: null });
    await expect(
      Effect.runPromise(
        service.authenticateDaemonProof(
          'daemon-1',
          transcript,
          signature.mldsa,
          'control',
          signature.p256,
        ),
      ),
    ).resolves.toBeNull();
  });

  test('account boxes come from recorded box ids, once each, never from another account', async () => {
    const service = createDeviceService(
      db,
      { tokenHmacSecret: HMAC_SECRET, publicOrigin: PUBLIC_ORIGIN },
      Effect.void,
    );
    await insertUser(db, 'user-2');
    await insertDaemon(db, 'laptop');
    await insertDaemon(db, 'box-a-daemon', 'box-a');
    // A relinked box leaves a second row naming the same container.
    await insertDaemon(db, 'box-a-relinked', 'box-a');
    // A stale row whose name another account's live box now carries.
    await insertDaemon(db, 'box-b-stale', 'box-b');
    await insertDaemon(db, 'box-b-live', 'box-b', 'user-2');
    await db
      .updateTable('daemons')
      .set({ name: 'renamed' })
      .where('id', '=', 'box-a-daemon')
      .execute();

    const boxes = await Effect.runPromise(service.listAccountBoxes('user-1'));
    expect(boxes.owned).toEqual(['box-a']);
    expect(boxes.contested).toEqual(['box-b']);
    await expect(Effect.runPromise(service.listAccountBoxes('user-3'))).resolves.toEqual({
      owned: [],
      contested: [],
    });
  });
});

async function insertUser(db: Kysely<DatabaseSchema>, userId: string): Promise<void> {
  await db
    .insertInto('users')
    .values({
      id: userId,
      username: `${userId}@example.com`,
      opaque_registration_record: 'A'.repeat(256),
      root_public_key: 'A'.repeat(3_456),
      root_key_commitment: 'A'.repeat(86),
      root_epoch: 1,
      root_envelope_nonce: 'A'.repeat(16),
      root_envelope_ciphertext: 'A'.repeat(64),
      created_at: 1,
    })
    .execute();
}

async function insertDaemon(
  db: Kysely<DatabaseSchema>,
  daemonId: string,
  boxId: string | null = null,
  userId = 'user-1',
): Promise<void> {
  await db
    .insertInto('daemons')
    .values({
      id: daemonId,
      user_id: userId,
      name: 'Daemon',
      platform: 'test',
      daemon_identity_public_key: PUBLIC_KEY,
      daemon_identity_p256_public_key: Buffer.from(
        deriveSoftwareDaemonP256PublicKey(SEED),
      ).toString('base64url'),
      identity_seal_backend: 'software',
      daemon_identity_key_commitment: 'daemon-key-commitment',
      daemon_binding_json: '{"binding":true}',
      last_seen: null,
      version: null,
      box_id: boxId,
    })
    .execute();
}

async function readVersion(db: Kysely<DatabaseSchema>, daemonId: string): Promise<string | null> {
  const row = await db
    .selectFrom('daemons')
    .select('version')
    .where('id', '=', daemonId)
    .executeTakeFirstOrThrow();
  return row.version;
}

async function readResyncs(db: Kysely<DatabaseSchema>): Promise<string[]> {
  const rows = await db
    .selectFrom('notification_outbox')
    .select('user_id')
    .where('kind', '=', 'devices')
    .orderBy('id')
    .execute();
  return rows.map((row) => row.user_id);
}

async function readLastSeen(db: Kysely<DatabaseSchema>): Promise<Map<string, number | null>> {
  const rows = await db.selectFrom('daemons').select(['id', 'last_seen']).execute();
  return new Map(rows.map((row) => [row.id ?? '', row.last_seen]));
}
