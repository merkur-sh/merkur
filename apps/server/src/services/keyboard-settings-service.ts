import { type AccountKeyboardSettings, isAccountKeyboardSettings, parseJson } from '@merkur/shared';
import { Clock, Context, Effect, Layer } from 'effect';
import type { Kysely } from 'kysely';

import { DatabaseService } from '../db/client';
import type { DatabaseSchema } from '../db/types';
import { type InfrastructureError, infrastructureError } from './errors';

export interface KeyboardSettingsService {
  /**
   * The account's stored arrangement, or `null` when it has never saved one.
   *
   * `null` is a real answer, not a failure: a brand-new account has no opinion
   * yet, and the browser answers it by seeding the account from whatever the
   * device in front of the user is already using.
   */
  read(userId: string): Effect.Effect<AccountKeyboardSettings | null, InfrastructureError>;
  write(
    userId: string,
    settings: AccountKeyboardSettings,
  ): Effect.Effect<void, InfrastructureError>;
}

export class KeyboardSettingsServiceTag extends Context.Service<
  KeyboardSettingsServiceTag,
  KeyboardSettingsService
>()('KeyboardSettingsService') {}

export const KeyboardSettingsServiceLive = Layer.effect(
  KeyboardSettingsServiceTag,
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    return createKeyboardSettingsService(db);
  }),
);

export function createKeyboardSettingsService(db: Kysely<DatabaseSchema>): KeyboardSettingsService {
  return {
    read: Effect.fn('KeyboardSettingsService.read')(function* (userId: string) {
      const row = yield* Effect.tryPromise({
        try: () =>
          db
            .selectFrom('keyboard_settings')
            .select('settings_json')
            .where('user_id', '=', userId)
            .executeTakeFirst(),
        catch: infrastructureError('database', 'read-keyboard-settings'),
      });
      if (row === undefined) return null;
      // A row that no longer parses is treated as absent rather than as an
      // error: the account's arrangement is a preference, and refusing to
      // answer would leave the keyboard unusable over a value nothing can act
      // on. The next save overwrites it.
      const parsed = parseJson(row.settings_json);
      return isAccountKeyboardSettings(parsed) ? parsed : null;
    }),

    write: Effect.fn('KeyboardSettingsService.write')(function* (
      userId: string,
      settings: AccountKeyboardSettings,
    ) {
      const updatedAt = yield* Clock.currentTimeMillis;
      const settingsJson = JSON.stringify(settings);
      yield* Effect.tryPromise({
        try: () =>
          db
            .insertInto('keyboard_settings')
            .values({ user_id: userId, settings_json: settingsJson, updated_at: updatedAt })
            .onConflict((conflict) =>
              conflict
                .column('user_id')
                .doUpdateSet({ settings_json: settingsJson, updated_at: updatedAt }),
            )
            .execute(),
        catch: infrastructureError('database', 'write-keyboard-settings'),
      });
    }),
  };
}
