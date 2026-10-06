import { beforeEach, describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { Elysia } from 'elysia';
import type { Kysely } from 'kysely';
import { DatabaseService } from '../../db/client';
import { createMigratedKyselyDatabase } from '../../db/migrate';
import type { DatabaseSchema } from '../../db/types';
import { createLogger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import { BoxAccessServiceTag, createBoxAccessService } from '../../services/box-access-service';
import { type BoxHostService, BoxHostServiceTag } from '../../services/box-host-service';
import { type DeviceService, DeviceServiceTag } from '../../services/device-service';
import { type RateLimitService, RateLimitServiceTag } from '../../services/rate-limit-service';
import { apiErrorPlugin } from '../api-errors';
import { createDeviceEventsSseLifetime } from '../sse';
import { boxAccessRoutesPlugin } from './box-access-routes';
import { deviceRoutesPlugin } from './device-routes';

const USERS = { alice: 'user-1' } as const;

let db: Kysely<DatabaseSchema>;
let createdBoxes: string[];
let consumed: Map<string, number>;

/** Counts every consume per key and refuses the ones past the limit. */
const rateLimits: RateLimitService = {
  consume: ({ key, limit }) =>
    Effect.sync(() => {
      const count = (consumed.get(key) ?? 0) + 1;
      consumed.set(key, count);
      return count > limit ? { allowed: false, retryAfterMs: 1 } : { allowed: true };
    }),
};

beforeEach(async () => {
  db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
  await insertUser(db, USERS.alice, 'alice');
  createdBoxes = [];
  consumed = new Map();
});

/**
 * The waitlist and box routes composed the way `createServerApp` composes
 * them, over a real migrated database: the gate on `POST /api/boxes` is only
 * meaningful against the same rows the waitlist routes write.
 */
function makeApp(signedInAs: string | null) {
  const boxAccess = createBoxAccessService(db);
  const deviceService: DeviceService = {
    ...unexpectedDeviceService(),
    createLinkToken: () =>
      Effect.succeed({
        token: 'A'.repeat(52),
        command: 'merkur link "https://merkur.test"',
        expiresAt: Date.now() + 60_000,
      }),
  };
  const boxHost: BoxHostService = {
    createLinked: (boxId) =>
      Effect.sync(() => {
        createdBoxes.push(boxId);
        return { boxId, linkCode: 'claim.secret' };
      }),
    start: () => Effect.die(new Error('unexpected box start')),
    remove: () => Effect.die(new Error('unexpected box remove')),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(DatabaseService, db),
    Layer.succeed(BoxAccessServiceTag, boxAccess),
    Layer.succeed(DeviceServiceTag, deviceService),
    Layer.succeed(BoxHostServiceTag, boxHost),
    Layer.succeed(RateLimitServiceTag, rateLimits),
  );
  const run = ((program) =>
    Effect.runPromise(
      Effect.provide(program as Effect.Effect<unknown, unknown, never>, layer),
    )) as typeof runServerProgram;
  const authorizeRequest = async () =>
    signedInAs === null
      ? null
      : {
          userId: signedInAs,
          delegationId: 'delegation-1',
          delegationExpiresAt: Date.now() + 60_000,
        };
  const logger = createLogger('box-access-routes-test');
  return new Elysia({ normalize: false })
    .use(apiErrorPlugin)
    .use(
      boxAccessRoutesPlugin({
        runServerProgram: run,
        authorizeRequest,
        logger,
        trustedProxyHops: 1,
      }),
    )
    .use(
      deviceRoutesPlugin({
        deviceEventsLifetime: createDeviceEventsSseLifetime(),
        runServerProgram: run,
        authorizeRequest,
        logger,
        trustedProxyHops: 1,
      }),
    );
}

function post(path: string, body: unknown = {}): Request {
  return new Request(`https://merkur.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request(`https://merkur.test${path}`);
}

describe('box access routes', () => {
  test('an account that never asked reads as none and cannot create a box', async () => {
    const app = makeApp(USERS.alice);

    const access = await app.handle(get('/api/boxes/access'));
    expect(access.status).toBe(200);
    expect(await access.json()).toEqual({ status: 'none' });

    const create = await app.handle(post('/api/boxes', { boxId: 'quiet-harbor' }));
    expect(create.status).toBe(403);
    expect(await create.json()).toEqual({ error: 'box_access_required' });
    expect(createdBoxes).toEqual([]);
  });

  test('joining the waitlist still refuses a box until the row is approved', async () => {
    const alice = makeApp(USERS.alice);

    const joined = await alice.handle(post('/api/boxes/waitlist'));
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual({ status: 'waitlisted' });
    expect((await alice.handle(post('/api/boxes', { boxId: 'quiet-harbor' }))).status).toBe(403);

    await db
      .updateTable('box_access')
      .set({ status: 'approved', decided_at: Date.now() })
      .where('user_id', '=', USERS.alice)
      .execute();

    expect(await (await alice.handle(get('/api/boxes/access'))).json()).toEqual({
      status: 'approved',
    });
    const create = await alice.handle(post('/api/boxes', { boxId: 'quiet-harbor' }));
    expect(create.status).toBe(200);
    expect(createdBoxes).toEqual(['quiet-harbor']);
  });

  test('one source joins five times in a window, whichever of its IPv6 addresses it uses', async () => {
    const alice = makeApp(USERS.alice);
    const join = (address: string) => {
      const request = post('/api/boxes/waitlist');
      request.headers.set('x-forwarded-for', address);
      return alice.handle(request);
    };

    for (let host = 1; host <= 5; host += 1) {
      expect((await join(`2001:db8:1:2::${host}`)).status).toBe(200);
    }
    const refused = await join('2001:db8:1:2::6');
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'rate_limited' });
    expect([...consumed.keys()]).toEqual(['box-waitlist:join:ip:2001:db8:1:2::/64']);

    expect((await join('2001:db8:1:3::1')).status).toBe(200);
  });

  test('an unauthenticated request reaches none of the routes', async () => {
    const app = makeApp(null);

    expect((await app.handle(get('/api/boxes/access'))).status).toBe(401);
    expect((await app.handle(post('/api/boxes/waitlist'))).status).toBe(401);
    expect(await db.selectFrom('box_access').selectAll().execute()).toHaveLength(0);
  });
});

function unexpectedDeviceService(): DeviceService {
  const unexpected = (name: string) =>
    Effect.die(new Error(`unexpected device service call: ${name}`));
  return {
    listDevices: () => unexpected('listDevices'),
    createLinkToken: () => unexpected('createLinkToken'),
    resolveBox: () => unexpected('resolveBox'),
    listAccountBoxes: () => unexpected('listAccountBoxes'),
    getDaemonSessionIdentity: () => unexpected('getDaemonSessionIdentity'),
    renameDevice: () => unexpected('renameDevice'),
    deleteDevice: () => unexpected('deleteDevice'),
    getDevice: () => unexpected('getDevice'),
    authenticateDaemonProof: () => unexpected('authenticateDaemonProof'),
    touchDaemon: () => unexpected('touchDaemon'),
    touchDaemonsSeen: () => unexpected('touchDaemonsSeen'),
  };
}

async function insertUser(
  database: Kysely<DatabaseSchema>,
  id: string,
  username: string,
): Promise<void> {
  await database
    .insertInto('users')
    .values({
      id,
      username,
      opaque_registration_record: 'record',
      root_public_key: 'root-public-key',
      root_key_commitment: 'root-key-commitment',
      root_epoch: 1,
      root_envelope_nonce: 'nonce',
      root_envelope_ciphertext: 'ciphertext',
      created_at: 0,
    })
    .execute();
}
