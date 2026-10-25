import { describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { Elysia } from 'elysia';

import { createLogger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import {
  type AccountTelemetryService,
  AccountTelemetryServiceTag,
} from '../../services/account-telemetry-service';
import { infrastructureError } from '../../services/errors';
import { apiErrorPlugin } from '../api-errors';
import { accountRoutesPlugin } from './account-routes';

const AUTHORIZED = async () => ({
  userId: 'user-1',
  delegationId: 'delegation-1',
  delegationExpiresAt: Date.now() + 60_000,
});

function makeApp(
  service: AccountTelemetryService,
  authorizeRequest: typeof AUTHORIZED | (() => Promise<null>) = AUTHORIZED,
) {
  const layer = Layer.succeed(AccountTelemetryServiceTag, service);
  // SAFETY: This route only requires AccountTelemetryServiceTag, provided by the fixture layer.
  const run = ((program) =>
    Effect.runPromise(
      Effect.provide(program as Effect.Effect<unknown, unknown, never>, layer),
    )) as typeof runServerProgram;
  return new Elysia({ normalize: false }).use(apiErrorPlugin).use(
    accountRoutesPlugin({
      runServerProgram: run,
      authorizeRequest,
      logger: createLogger('account-routes-test'),
    }),
  );
}

type TestBody = { readonly enabled?: boolean | number | string | null; readonly extra?: boolean };

function put(body: TestBody): Request {
  return new Request('https://merkur.test/api/account/telemetry', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function unexpectedService(): AccountTelemetryService {
  return {
    read: () => Effect.die('unexpected telemetry read'),
    write: () => Effect.die('unexpected telemetry write'),
  };
}

describe('account telemetry route', () => {
  test('writes for the authenticated account and responds with the stored value', async () => {
    const writes: Array<{ userId: string; enabled: boolean }> = [];
    const app = makeApp({
      ...unexpectedService(),
      write: (userId, enabled) =>
        Effect.sync(() => {
          writes.push({ userId, enabled });
          return true;
        }),
    });
    const response = await app.handle(put({ enabled: false }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
    expect(writes).toEqual([{ userId: 'user-1', enabled: false }]);
  });

  test('requires authentication before writing', async () => {
    const response = await makeApp(unexpectedService(), async () => null).handle(
      put({ enabled: false }),
    );
    expect(response.status).toBe(401);
  });

  test('requires exactly one boolean and never coerces it', async () => {
    const app = makeApp(unexpectedService());
    for (const body of [
      {},
      { enabled: 1 },
      { enabled: 'true' },
      { enabled: null },
      { enabled: false, extra: true },
    ]) {
      expect((await app.handle(put(body))).status).toBe(400);
    }
  });

  test('maps a settings failure through the shared error handler', async () => {
    const app = makeApp({
      ...unexpectedService(),
      write: () =>
        Effect.fail(
          infrastructureError('database', 'write-account-telemetry')(new Error('private detail')),
        ),
    });
    const response = await app.handle(put({ enabled: false }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  test('has no telemetry GET route', async () => {
    expect(
      (
        await makeApp(unexpectedService()).handle(
          new Request('https://merkur.test/api/account/telemetry'),
        )
      ).status,
    ).toBe(404);
  });
});
