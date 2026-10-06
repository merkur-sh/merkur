import { beforeEach, describe, expect, test } from 'bun:test';
import type { AccountKeyboardSettings } from '@merkur/shared';
import { Effect } from 'effect';
import type { Kysely } from 'kysely';

import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import { createKeyboardSettingsService } from './keyboard-settings-service';

let db: Kysely<DatabaseSchema>;

const settings: AccountKeyboardSettings = {
  macros: [
    {
      id: 'macro:interrupt',
      name: 'Interrupt',
      steps: [{ key: 'key-c', ctrl: true, alt: false, shift: false, meta: false }],
    },
  ],
  toolbarKeys: ['escape', 'ctrl', 'paste'],
  layerKeyOrder: {
    alpha: ['key-a', 'key-b'],
    numbers: ['key-1'],
    symbols: ['at'],
    pc: ['home'],
  },
};

beforeEach(async () => {
  db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
  await insertUser(db, 'user-1');
  await insertUser(db, 'user-2');
});

describe('KeyboardSettingsService', () => {
  test('an account with no saved arrangement reads as absent, not as defaults', async () => {
    const service = createKeyboardSettingsService(db);

    expect(await Effect.runPromise(service.read('user-1'))).toBeNull();
  });

  test('round-trips an arrangement', async () => {
    const service = createKeyboardSettingsService(db);

    await Effect.runPromise(service.write('user-1', settings));

    expect(await Effect.runPromise(service.read('user-1'))).toEqual(settings);
  });

  test('a later write replaces the arrangement rather than adding a row', async () => {
    const service = createKeyboardSettingsService(db);
    const rearranged: AccountKeyboardSettings = {
      ...settings,
      toolbarKeys: ['tab'],
    };

    await Effect.runPromise(service.write('user-1', settings));
    await Effect.runPromise(service.write('user-1', rearranged));

    expect(await Effect.runPromise(service.read('user-1'))).toEqual(rearranged);
    const rows = await db
      .selectFrom('keyboard_settings')
      .select('user_id')
      .where('user_id', '=', 'user-1')
      .execute();
    expect(rows).toHaveLength(1);
  });

  test('arrangements are scoped to their account', async () => {
    const service = createKeyboardSettingsService(db);

    await Effect.runPromise(service.write('user-1', settings));

    expect(await Effect.runPromise(service.read('user-2'))).toBeNull();
  });

  // Refusing to answer would leave the keyboard drawing nothing over a value
  // nothing can act on; the next save overwrites it.
  test('a row that no longer parses reads as absent', async () => {
    const service = createKeyboardSettingsService(db);
    await db
      .insertInto('keyboard_settings')
      .values({ user_id: 'user-1', settings_json: '{"toolbarKeys":', updated_at: 1 })
      .execute();

    expect(await Effect.runPromise(service.read('user-1'))).toBeNull();
  });

  test('a row that parses but is not an arrangement reads as absent', async () => {
    const service = createKeyboardSettingsService(db);
    await db
      .insertInto('keyboard_settings')
      .values({
        user_id: 'user-1',
        settings_json: JSON.stringify({ toolbarKeys: ['escape'] }),
        updated_at: 1,
      })
      .execute();

    expect(await Effect.runPromise(service.read('user-1'))).toBeNull();
  });

  test('deleting the account takes its arrangement with it', async () => {
    const service = createKeyboardSettingsService(db);
    await Effect.runPromise(service.write('user-1', settings));

    await db.deleteFrom('users').where('id', '=', 'user-1').execute();

    const rows = await db.selectFrom('keyboard_settings').select('user_id').execute();
    expect(rows).toHaveLength(0);
  });
});

async function insertUser(database: Kysely<DatabaseSchema>, id: string): Promise<void> {
  await database
    .insertInto('users')
    .values({
      id,
      username: `${id}@merkur.test`,
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
