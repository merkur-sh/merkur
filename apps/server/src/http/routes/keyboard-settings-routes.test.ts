import { describe, expect, test } from 'bun:test';
import type { AccountKeyboardSettings } from '@merkur/shared';
import { Effect, Layer } from 'effect';
import { Elysia } from 'elysia';

import { createLogger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import {
  type KeyboardSettingsService,
  KeyboardSettingsServiceTag,
} from '../../services/keyboard-settings-service';
import { apiErrorPlugin } from '../api-errors';
import { keyboardSettingsRoutesPlugin } from './keyboard-settings-routes';

const settings: AccountKeyboardSettings = {
  macros: [
    {
      id: 'macro:interrupt',
      name: 'Interrupt',
      steps: [{ key: 'key-c', ctrl: true, alt: false, shift: false, meta: false }],
    },
  ],
  toolbarKeys: ['escape', 'ctrl'],
  layerKeyOrder: { alpha: ['key-a'], numbers: ['key-1'], symbols: ['at'], pc: ['home'] },
};

const AUTHORIZED = async () => ({
  userId: 'user-1',
  delegationId: 'delegation-1',
  delegationExpiresAt: Date.now() + 60_000,
});

/**
 * Composed the way `createServerApp` composes it: the unauthorized error is
 * thrown by the authentication plugin and turned into a 401 by `apiErrorPlugin`,
 * which must be mounted ahead of the routes for their per-route handlers to
 * carry it. A plugin tested without it answers 500 to every rejection.
 */
function makeApp(
  service: KeyboardSettingsService,
  authorizeRequest: typeof AUTHORIZED | (() => Promise<null>) = AUTHORIZED,
) {
  return new Elysia({ normalize: false }).use(apiErrorPlugin).use(
    keyboardSettingsRoutesPlugin({
      runServerProgram: makeRunServerProgram(service),
      authorizeRequest,
      logger: createLogger('keyboard-settings-routes-test'),
    }),
  );
}

function put(body: unknown): Request {
  return new Request('https://merkur.test/api/settings/keyboard', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('keyboard settings routes', () => {
  test('reads the account arrangement', async () => {
    const app = makeApp({
      ...unexpectedService(),
      read: (userId) => Effect.sync(() => (userId === 'user-1' ? settings : null)),
    });

    const response = await app.handle(new Request('https://merkur.test/api/settings/keyboard'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settings });
  });

  // The browser answers `null` by seeding the account from the device in front
  // of the user, so it must reach the browser as itself rather than as defaults
  // the server invented.
  test('an account with no arrangement reads as null', async () => {
    const app = makeApp({ ...unexpectedService(), read: () => Effect.succeed(null) });

    const response = await app.handle(new Request('https://merkur.test/api/settings/keyboard'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settings: null });
  });

  test('writes the arrangement for the authenticated account', async () => {
    const writes: { userId: string; settings: AccountKeyboardSettings }[] = [];
    const app = makeApp({
      ...unexpectedService(),
      write: (userId, next) => Effect.sync(() => void writes.push({ userId, settings: next })),
    });

    const response = await app.handle(put(settings));

    expect(response.status).toBe(204);
    expect(writes).toEqual([{ userId: 'user-1', settings }]);
  });

  test('an unauthenticated request reaches neither read nor write', async () => {
    const app = makeApp(unexpectedService(), async () => null);

    expect(
      (await app.handle(new Request('https://merkur.test/api/settings/keyboard'))).status,
    ).toBe(401);
    expect((await app.handle(put(settings))).status).toBe(401);
  });

  // The body is untrusted input that becomes a stored row, so the bounds are
  // the route's job — the service stores whatever it is handed.
  test('refuses a body that is not an arrangement', async () => {
    const app = makeApp(unexpectedService());

    for (const body of [
      { toolbarKeys: ['escape'] },
      { ...settings, layerKeyOrder: { alpha: [], numbers: [], symbols: [] } },
      { ...settings, keyPreview: true },
      { ...settings, toolbarKeys: ['x'.repeat(64)] },
      { ...settings, toolbarKeys: Array.from({ length: 33 }, (_, index) => `key-${index}`) },
      { ...settings, toolbarKeys: [''] },
    ]) {
      expect((await app.handle(put(body))).status).toBe(400);
    }
  });

  test('refuses malformed macros and duplicate identities before storage', async () => {
    const app = makeApp(unexpectedService());
    const macro = settings.macros[0];
    if (macro === undefined) throw new Error('macro fixture missing');
    for (const changed of [
      { name: ' ' },
      { name: 'x'.repeat(33) },
      { id: 'escape' },
      { steps: [] },
      { steps: Array.from({ length: 33 }, () => macro.steps[0]) },
      { steps: [{ ...macro.steps[0], ctrl: 'true' }] },
    ]) {
      expect(
        (await app.handle(put({ ...settings, macros: [{ ...macro, ...changed }] }))).status,
      ).toBe(400);
    }
    expect(
      (
        await app.handle(
          put({
            ...settings,
            macros: Array.from({ length: 33 }, (_, index) => ({ ...macro, id: `macro:${index}` })),
          }),
        )
      ).status,
    ).toBe(400);
    expect((await app.handle(put({ ...settings, macros: [macro, macro] }))).status).toBe(422);
  });

  test('refuses a layer carrying more keys than a layout can hold', async () => {
    const app = makeApp(unexpectedService());
    const tooMany = Array.from({ length: 255 }, (_, index) => `key-${index}`);

    const response = await app.handle(
      put({ ...settings, layerKeyOrder: { ...settings.layerKeyOrder, alpha: tooMany } }),
    );

    expect(response.status).toBe(400);
  });
});

function unexpectedService(): KeyboardSettingsService {
  const unexpected = (name: string) =>
    Effect.die(new Error(`unexpected keyboard settings service call: ${name}`));
  return {
    read: () => unexpected('read'),
    write: () => unexpected('write'),
  };
}

function makeRunServerProgram(service: KeyboardSettingsService): typeof runServerProgram {
  const layer = Layer.succeed(KeyboardSettingsServiceTag, service);
  return ((program) =>
    Effect.runPromise(
      Effect.provide(program as Effect.Effect<unknown, unknown, never>, layer),
    )) as typeof runServerProgram;
}
