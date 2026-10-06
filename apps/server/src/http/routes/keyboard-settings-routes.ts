import { type AccountKeyboardSettings, isAccountKeyboardSettings } from '@merkur/shared';
import { Effect } from 'effect';
import { Elysia, status } from 'elysia';

import type { Logger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import type { AuthenticatedBrowser } from '../../services/auth-service';
import { KeyboardSettingsServiceTag } from '../../services/keyboard-settings-service';
import { ApiModels } from '../api-models';
import { authenticatedApiPlugin } from '../authenticated-api';
import { runRouteEffect } from '../effect-route';

const STATUS_NO_CONTENT = 204;

/**
 * The stored settings as the response schema declares them.
 *
 * The domain type is readonly so a service cannot hand a caller something it
 * can mutate; the schema's arrays are not. Copying here is what keeps the two
 * facts from having to agree, and it is four arrays on a settings read.
 */
function toResponseSettings(settings: AccountKeyboardSettings | null): {
  toolbarKeys: string[];
  macros: Array<{
    id: string;
    name: string;
    steps: Array<{ key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }>;
  }>;
  layerKeyOrder: { alpha: string[]; numbers: string[]; symbols: string[]; pc: string[] };
} | null {
  if (settings === null) return null;
  const order = settings.layerKeyOrder;
  return {
    toolbarKeys: [...settings.toolbarKeys],
    macros: settings.macros.map((macro) => ({
      ...macro,
      steps: macro.steps.map((step) => ({ ...step })),
    })),
    layerKeyOrder: {
      alpha: [...order.alpha],
      numbers: [...order.numbers],
      symbols: [...order.symbols],
      pc: [...order.pc],
    },
  };
}

interface KeyboardSettingsRoutesOptions {
  readonly runServerProgram: typeof runServerProgram;
  readonly authorizeRequest: (request: Request) => Promise<AuthenticatedBrowser | null>;
  readonly logger: Logger;
}

/**
 * The account's keyboard arrangement.
 *
 * The account is the authority: a signing-in device adopts what is stored here
 * and pushes its own only when it changes one. There is no merge and no
 * client-supplied timestamp to arbitrate with — a later write simply wins,
 * which is the whole contract for a preference one person edits.
 */
export function keyboardSettingsRoutesPlugin({
  runServerProgram,
  authorizeRequest,
  logger,
}: KeyboardSettingsRoutesOptions) {
  return new Elysia({ name: 'keyboard-settings-routes', normalize: false }).group(
    '/api/settings',
    (api) =>
      api
        .use(authenticatedApiPlugin({ authorizeRequest }))
        .get(
          '/keyboard',
          {
            response: {
              200: ApiModels.KeyboardSettingsResponse,
              401: ApiModels.ErrorResponse,
            },
          },
          async ({ request, userId }) => {
            const settings = await runRouteEffect(
              runServerProgram,
              Effect.gen(function* () {
                const keyboardSettings = yield* KeyboardSettingsServiceTag;
                return yield* keyboardSettings.read(userId);
              }),
              {
                logger,
                eventName: 'keyboard_settings_read_failed',
                request,
                signal: request.signal,
              },
            );
            return { settings: toResponseSettings(settings) };
          },
        )
        .put(
          '/keyboard',
          {
            body: ApiModels.KeyboardSettingsBody,
            response: {
              204: ApiModels.EmptyResponse,
              422: ApiModels.ErrorResponse,
              401: ApiModels.ErrorResponse,
            },
          },
          async ({ body, request, userId }) => {
            if (!isAccountKeyboardSettings(body))
              return status(422, { error: 'Invalid keyboard settings' });
            await runRouteEffect(
              runServerProgram,
              Effect.gen(function* () {
                const keyboardSettings = yield* KeyboardSettingsServiceTag;
                yield* keyboardSettings.write(userId, body);
              }),
              {
                logger,
                eventName: 'keyboard_settings_write_failed',
                request,
                signal: request.signal,
              },
            );
            return status(STATUS_NO_CONTENT, undefined);
          },
        ),
  );
}
