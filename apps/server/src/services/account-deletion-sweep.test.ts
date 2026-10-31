import { describe, expect, test } from 'bun:test';
import type { Logger } from '@merkur/logger';
import { Effect } from 'effect';
import { sql } from 'kysely';
import { DatabaseService } from '../db/client';
import { sweepDeletedAccountsEffect } from './account-deletion-sweep';
import { type AuthService, AuthServiceTag } from './auth-service';
import {
  db,
  finishClientLogin,
  OLD_PASSWORD,
  registerAccount,
  service,
  startClientAndServerLogin,
  TEST_CLIENT,
  useAuthServiceFixture,
} from './auth-service-fixture';
import { BoxHostError, type BoxHostService, BoxHostServiceTag } from './box-host-service';
import { drainBoxRemovalsEffect } from './box-removal';
import { createDeviceService, DeviceServiceTag } from './device-service';

useAuthServiceFixture();
const logger: Logger = { info() {}, warn() {}, error() {} };
function unexpected(name: string) {
  return () => Effect.die(new Error(`unexpected call: ${name}`));
}
async function insertBox(userId: string) {
  await db
    .insertInto('daemons')
    .values({
      id: 'box-daemon',
      user_id: userId,
      name: 'Box',
      platform: 'linux',
      daemon_identity_public_key: 'key',
      daemon_identity_p256_public_key: 'p256',
      identity_seal_backend: 'software',
      daemon_identity_key_commitment: 'commitment',
      daemon_binding_json: '{}',
      last_seen: null,
      version: null,
      box_id: 'owned-box',
    })
    .execute();
}
describe('account deletion sweep', () => {
  test('sign-in cancels scanned erasure', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x22, 'erasure-actor');
    await db
      .updateTable('users')
      .set({ deletion_scheduled_at: 1 })
      .where('id', '=', actor.userId)
      .execute();
    await db
      .insertInto('daemons')
      .values({
        id: 'box-daemon',
        user_id: actor.userId,
        name: 'Box',
        platform: 'linux',
        daemon_identity_public_key: 'key',
        daemon_identity_p256_public_key: 'p256',
        identity_seal_backend: 'software',
        daemon_identity_key_commitment: 'commitment',
        daemon_binding_json: '{}',
        last_seen: null,
        version: null,
        box_id: 'owned-box',
      })
      .execute();
    const removed: string[] = [];
    const logger: Logger = { info() {}, warn() {}, error() {} };
    const auth: AuthService = {
      ...service,
      accountsDueForDeletion: () =>
        service.accountsDueForDeletion().pipe(
          Effect.tap(() =>
            Effect.promise(async () => {
              const login = await startClientAndServerLogin(OLD_PASSWORD);
              const finish = finishClientLogin(OLD_PASSWORD, login);
              await Effect.runPromise(
                service.finishLogin({
                  flowId: login.server.flowId,
                  finishLoginRequest: finish.finishLoginRequest,
                  delegationCertificate: actor.certificate,
                  client: TEST_CLIENT,
                }),
              );
            }),
          ),
        ),
    };
    await Effect.runPromise(
      sweepDeletedAccountsEffect(logger).pipe(
        Effect.provideService(AuthServiceTag, auth),
        Effect.provideService(
          DeviceServiceTag,
          createDeviceService(
            db,
            { tokenHmacSecret: 'secret', publicOrigin: 'https://merkur.test' },
            Effect.void,
          ),
        ),
        Effect.provideService(BoxHostServiceTag, {
          createLinked: unexpected('createLinked'),
          start: unexpected('start'),
          remove: (box) => Effect.sync(() => void removed.push(box)),
        }),
      ),
    );
    expect(removed).toEqual([]);
    expect(
      await db.selectFrom('users').select('id').where('id', '=', actor.userId).execute(),
    ).toHaveLength(1);
    expect(await db.selectFrom('daemons').select('id').execute()).toHaveLength(1);
    expect(await db.selectFrom('box_removals').selectAll().execute()).toEqual([]);
  });

  test('queues boxes with eligible erasure and retries a refused host after commit', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x22, 'erasure-actor');
    await insertBox(actor.userId);
    await db
      .updateTable('users')
      .set({ deletion_scheduled_at: 1 })
      .where('id', '=', actor.userId)
      .execute();
    await sql`CREATE TRIGGER refuse_removal BEFORE INSERT ON box_removals BEGIN SELECT RAISE(FAIL, 'queue unavailable'); END`.execute(
      db,
    );
    await expect(Effect.runPromise(service.purgeAccount(actor.userId))).rejects.toThrow(
      'queue unavailable',
    );
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(1);
    expect(await db.selectFrom('daemons').select('id').execute()).toHaveLength(1);
    await sql`DROP TRIGGER refuse_removal`.execute(db);
    await Effect.runPromise(
      sweepDeletedAccountsEffect(logger).pipe(Effect.provideService(AuthServiceTag, service)),
    );
    expect(await db.selectFrom('users').select('id').execute()).toEqual([]);
    expect(await db.selectFrom('daemons').select('id').execute()).toEqual([]);
    expect(await db.selectFrom('box_removals').select('box_id').execute()).toEqual([
      { box_id: 'owned-box' },
    ]);
    const removed: string[] = [];
    let refuse = true;
    const host: BoxHostService = {
      createLinked: unexpected('createLinked'),
      start: unexpected('start'),
      remove: (box) =>
        refuse
          ? Effect.fail(new BoxHostError({ operation: 'remove', message: 'down', status: 502 }))
          : Effect.sync(() => void removed.push(box)),
    };
    const drain = drainBoxRemovalsEffect(logger).pipe(
      Effect.provideService(DatabaseService, db),
      Effect.provideService(BoxHostServiceTag, host),
    );
    await Effect.runPromise(drain);
    expect(await db.selectFrom('box_removals').selectAll().execute()).toHaveLength(1);
    refuse = false;
    await Effect.runPromise(drain);
    expect(removed).toEqual(['owned-box']);
    expect(await db.selectFrom('box_removals').selectAll().execute()).toEqual([]);
  });
});
