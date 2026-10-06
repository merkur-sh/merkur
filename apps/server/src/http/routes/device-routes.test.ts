import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import type { Kysely } from 'kysely';
import { DatabaseService } from '../../db/client';
import { createMigratedKyselyDatabase } from '../../db/migrate';
import type { DatabaseSchema } from '../../db/types';
import { createLogger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import { BoxAccessServiceTag } from '../../services/box-access-service';
import {
  BoxHostError,
  type BoxHostService,
  BoxHostServiceTag,
  BoxHostUnconfiguredError,
} from '../../services/box-host-service';
import {
  type DeviceEventsService,
  DeviceEventsServiceTag,
} from '../../services/device-events-service';
import { type DeviceService, DeviceServiceTag } from '../../services/device-service';
import { createDeviceEventsSseLifetime } from '../sse';
import { deviceRoutesPlugin } from './device-routes';

let db: Kysely<DatabaseSchema>;
beforeEach(async () => {
  db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
  await db
    .insertInto('users')
    .values({
      id: 'user-1',
      username: 'machine-test',
      opaque_registration_record: 'A'.repeat(256),
      root_public_key: 'A'.repeat(3456),
      root_key_commitment: 'A'.repeat(86),
      root_epoch: 1,
      root_envelope_nonce: 'A'.repeat(16),
      root_envelope_ciphertext: 'A'.repeat(64),
      created_at: 1,
    })
    .execute();
});
afterEach(async () => {
  await db.destroy();
});

describe('device routes', () => {
  test('unlink preserves its box handle on host failures and deletes once the box is removed', async () => {
    // The box host client reports a box it no longer has as removed; its own
    // test pins that an exact 404 is the only refusal read that way.
    for (const failure of [
      new BoxHostError({ operation: 'remove', message: 'unreachable', status: 503 }),
      new BoxHostUnconfiguredError({ operation: 'remove' }),
      null,
    ]) {
      let deleted = false;
      const app = deviceRoutesPlugin({
        deviceEventsLifetime: createDeviceEventsSseLifetime(),
        runServerProgram: makeRunServerProgram(
          {
            ...unexpectedDeviceService(),
            resolveBox: () => Effect.succeed({ boxId: 'exact-box', ambiguousBoxId: null }),
            deleteDevice: () =>
              Effect.sync(() => {
                deleted = true;
              }),
          },
          {
            createLinked: () => Effect.die('unexpected create'),
            start: () => Effect.die('unexpected start'),
            remove: () => (failure === null ? Effect.void : Effect.fail(failure)),
          },
        ),
        authorizeRequest: async () => ({
          userId: 'user-1',
          delegationId: 'delegation-1',
          delegationExpiresAt: Date.now() + 60000,
        }),
        logger: createLogger('device-routes-test'),
        trustedProxyHops: 0,
      });
      const response = await app.handle(
        new Request('https://merkur.test/api/devices/daemon-1', { method: 'DELETE' }),
      );
      const removed = failure === null;
      expect(response.status).toBe(removed ? 204 : 503);
      expect(deleted).toBe(removed);
      if (!removed) expect(await response.json()).toEqual({ error: 'box_host_unavailable' });
    }
  });

  test('refuses a box name whose previous box is still queued for destruction', async () => {
    const created: string[] = [];
    const app = deviceRoutesPlugin({
      deviceEventsLifetime: createDeviceEventsSseLifetime(),
      runServerProgram: makeRunServerProgram(
        {
          ...unexpectedDeviceService(),
          createLinkToken: () =>
            Effect.succeed({ token: 'A'.repeat(52), command: 'link', expiresAt: Date.now() }),
        },
        {
          createLinked: (boxId) =>
            Effect.sync(() => {
              created.push(boxId);
              return { boxId, linkCode: 'code' };
            }),
          start: () => Effect.die('unexpected start'),
          remove: () => Effect.die('unexpected remove'),
        },
      ),
      authorizeRequest: async () => ({
        userId: 'user-1',
        delegationId: 'delegation-1',
        delegationExpiresAt: Date.now() + 60_000,
      }),
      logger: createLogger('device-routes-test'),
      trustedProxyHops: 0,
    });
    const create = (boxId: string) =>
      app.handle(
        new Request('https://merkur.test/api/boxes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ boxId }),
        }),
      );
    await db
      .insertInto('box_removals')
      .values({ box_id: 'calm-harbor', requested_at: 1 })
      .execute();

    const refused = await create('calm-harbor');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'box_removal_pending' });
    expect(created).toEqual([]);

    expect((await create('bright-river')).status).toBe(200);
    await db.deleteFrom('box_removals').execute();
    expect((await create('calm-harbor')).status).toBe(200);
    expect(created).toEqual(['bright-river', 'calm-harbor']);
  });

  test('creates a bearer link token from an exact empty request body', async () => {
    const createdFor: string[] = [];
    const deviceService: DeviceService = {
      ...unexpectedDeviceService(),
      createLinkToken: (userId) =>
        Effect.sync(() => {
          createdFor.push(userId);
          return {
            token: 'A'.repeat(52),
            command: 'merkur link "https://merkur.test"',
            expiresAt: Date.now() + 60_000,
          };
        }),
    };
    const app = deviceRoutesPlugin({
      deviceEventsLifetime: createDeviceEventsSseLifetime(),
      runServerProgram: makeRunServerProgram(deviceService),
      authorizeRequest: async () => ({
        userId: 'user-1',
        delegationId: 'delegation-1',
        delegationExpiresAt: Date.now() + 60_000,
      }),
      logger: createLogger('device-routes-test'),
      trustedProxyHops: 1,
    });

    const response = await app.handle(
      new Request('https://merkur.test/api/link-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    expect(createdFor).toEqual(['user-1']);
    // Only the command crosses the wire; the token is inside it.
    const body = await response.json();
    expect(Object.keys(body as object)).toEqual(['command', 'expiresAt', 'machineUsage']);
    expect(body).toMatchObject({ machineUsage: { used: 0, limit: 3 } });
  });

  test('withholds the command at capacity and restores it after unlinking', async () => {
    for (let index = 0; index < 3; index++) {
      await db
        .insertInto('daemons')
        .values({
          id: `machine-${index}`,
          user_id: 'user-1',
          name: `Machine ${index}`,
          platform: 'linux',
          daemon_identity_public_key: `key-${index}`,
          daemon_identity_p256_public_key: `p256-${index}`,
          identity_seal_backend: 'software',
          daemon_identity_key_commitment: `commitment-${index}`,
          daemon_binding_json: '{}',
          last_seen: 1,
          version: null,
          box_id: null,
        })
        .execute();
    }
    let issued = 0;
    const app = deviceRoutesPlugin({
      deviceEventsLifetime: createDeviceEventsSseLifetime(),
      runServerProgram: makeRunServerProgram({
        ...unexpectedDeviceService(),
        createLinkToken: () =>
          Effect.sync(() => {
            issued++;
            return {
              token: 'A'.repeat(52),
              command: 'link command',
              expiresAt: Date.now() + 60000,
            };
          }),
      }),
      authorizeRequest: async () => ({
        userId: 'user-1',
        delegationId: 'delegation-1',
        delegationExpiresAt: Date.now() + 60000,
      }),
      logger: createLogger('device-routes-test'),
      trustedProxyHops: 1,
    });
    const request = () =>
      app.handle(
        new Request('https://merkur.test/api/link-token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      );
    const full = await request();
    expect(full.status).toBe(200);
    expect(await full.json()).toEqual({
      command: null,
      expiresAt: null,
      machineUsage: { used: 3, limit: 3 },
    });
    expect(issued).toBe(0);
    await db.deleteFrom('daemons').where('id', '=', 'machine-0').execute();
    expect(await (await request()).json()).toMatchObject({
      command: 'link command',
      machineUsage: { used: 2, limit: 3 },
    });
    expect(issued).toBe(1);
    await db.updateTable('users').set({ privileged_at: 1 }).where('id', '=', 'user-1').execute();
    expect(await (await request()).json()).toMatchObject({
      command: 'link command',
      machineUsage: { used: 2, limit: null },
    });
  });

  test('rejects non-empty link-token bodies and exposes no retired direct-link route', async () => {
    const app = deviceRoutesPlugin({
      deviceEventsLifetime: createDeviceEventsSseLifetime(),
      runServerProgram: makeRunServerProgram(unexpectedDeviceService()),
      authorizeRequest: async () => ({
        userId: 'user-1',
        delegationId: 'delegation-1',
        delegationExpiresAt: Date.now() + 60_000,
      }),
      logger: createLogger('device-routes-test'),
      trustedProxyHops: 1,
    });

    const invalidBody = await app.handle(
      new Request('https://merkur.test/api/link-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingId: 'retired' }),
      }),
    );
    expect(invalidBody.status).toBe(422);

    const retiredRoute = await app.handle(
      new Request('https://merkur.test/api/devices/link', { method: 'POST' }),
    );
    expect(retiredRoute.status).toBe(404);
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

function makeRunServerProgram(
  deviceService: DeviceService,
  boxHost: BoxHostService = {
    createLinked: () => Effect.die('unexpected create'),
    start: () => Effect.die('unexpected start'),
    remove: () => Effect.die('unexpected remove'),
  },
): typeof runServerProgram {
  const deviceEvents: DeviceEventsService = {
    publishDelta: () => Effect.void,
    readCursor: () => Effect.succeed({ epoch: 'feedfacefeedface', seq: 0 }),
    subscribe: () => Effect.succeed(Effect.void),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(DatabaseService, db),
    Layer.succeed(BoxAccessServiceTag, {
      access: () => Effect.die('unexpected access'),
      join: () => Effect.die('unexpected join'),
      requireApproved: () => Effect.void,
    }),
    Layer.succeed(DeviceServiceTag, deviceService),
    Layer.succeed(BoxHostServiceTag, boxHost),
    Layer.succeed(DeviceEventsServiceTag, deviceEvents),
  );
  return ((program) =>
    Effect.runPromise(
      Effect.provide(program as Effect.Effect<unknown, unknown, never>, layer),
    )) as typeof runServerProgram;
}
