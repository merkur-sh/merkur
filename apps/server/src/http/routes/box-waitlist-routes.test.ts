import { beforeEach, describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { Elysia } from 'elysia';
import type { Kysely } from 'kysely';

import { createMigratedKyselyDatabase } from '../../db/migrate';
import type { DatabaseSchema } from '../../db/types';
import type { Logger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import {
  BoxWaitlistServiceTag,
  createBoxWaitlistService,
} from '../../services/box-waitlist-service';
import type { MailResolver } from '../../services/email-admission';
import {
  type RateLimitCheck,
  type RateLimitService,
  RateLimitServiceTag,
} from '../../services/rate-limit-service';
import {
  type RybbitEvents,
  RybbitEventsTag,
  type RybbitServerEvent,
} from '../../services/rybbit-events';
import { apiErrorPlugin } from '../api-errors';
import { boxWaitlistCorsPlugin, boxWaitlistRoutesPlugin } from './box-waitlist-routes';

const SITE_ORIGIN = 'https://www.merkur.test';
const CLIENT_IP = '203.0.113.7';
/** Answers for a domain that names a mail exchanger. */
const TAKES_MAIL: MailResolver = {
  resolveMx: async () => [{ exchange: 'mx.example.net' }],
  resolve4: async () => [],
  resolve6: async () => [],
};

let db: Kysely<DatabaseSchema>;
let sent: RybbitServerEvent[];
let consumed: RateLimitCheck[];
let allowed: boolean;
let logs: Array<{ readonly message: string; readonly context: Record<string, unknown> }>;

beforeEach(async () => {
  db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
  sent = [];
  consumed = [];
  allowed = true;
  logs = [];
});

/**
 * Composed the way `createServerApp` composes it: the CORS hook ahead of the
 * error contract, the route after it. Mounting the route alone would bypass
 * `apiErrorPlugin`, and with it the error answers the CORS headers must reach.
 */
function makeApp(resolver: MailResolver = TAKES_MAIL) {
  const rateLimit: RateLimitService = {
    consume: (check) =>
      Effect.sync(() => {
        consumed.push(check);
        return allowed ? { allowed: true } : { allowed: false, retryAfterMs: 60_000 };
      }),
  };
  const rybbit: RybbitEvents = {
    send: (event) =>
      Effect.sync(() => {
        sent.push(event);
      }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(BoxWaitlistServiceTag, createBoxWaitlistService(db, resolver)),
    Layer.succeed(RateLimitServiceTag, rateLimit),
    Layer.succeed(RybbitEventsTag, rybbit),
  );
  const run = ((program) =>
    Effect.runPromise(
      Effect.provide(program as Effect.Effect<unknown, unknown, never>, layer),
    )) as typeof runServerProgram;
  const record = (message: string, context: Record<string, unknown> = {}) => {
    logs.push({ message, context });
  };
  const logger: Logger = { info: record, warn: record, error: record };
  return new Elysia({ normalize: false })
    .use(boxWaitlistCorsPlugin(SITE_ORIGIN))
    .use(apiErrorPlugin)
    .use(
      boxWaitlistRoutesPlugin({
        runServerProgram: run,
        logger,
        trustedProxyHops: 1,
        siteOrigin: SITE_ORIGIN,
      }),
    );
}

/**
 * The post the website's form makes; `origin: null` leaves the header out, and
 * `navigate` marks it as the browser marks a form posted without script.
 */
function join(
  email: string,
  options: { readonly origin?: string | null; readonly navigate?: boolean } = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    'x-forwarded-for': CLIENT_IP,
    'sec-fetch-mode': options.navigate === true ? 'navigate' : 'cors',
  };
  const origin = options.origin === undefined ? SITE_ORIGIN : options.origin;
  if (origin !== null) headers.origin = origin;
  return new Request('https://merkur.test/api/box-waitlist', {
    method: 'POST',
    headers,
    body: new URLSearchParams({ email }).toString(),
  });
}

function expectCors(response: Response): void {
  expect(response.headers.get('access-control-allow-origin')).toBe(SITE_ORIGIN);
  expect(response.headers.get('vary')).toBe('Origin');
  expect(response.headers.get('access-control-allow-credentials')).toBeNull();
}

async function waitlist(): Promise<string[]> {
  const rows = await db.selectFrom('box_waitlist').select('email').execute();
  return rows.map((row) => row.email);
}

describe('box waitlist route', () => {
  test('answers a new and a known address with the same bare 204', async () => {
    const app = makeApp();

    const first = await app.handle(join('person@example.com'));
    const second = await app.handle(join('Person@Example.com'));

    for (const response of [first, second]) {
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expectCors(response);
    }
    expect([...first.headers.keys()].sort()).toEqual([...second.headers.keys()].sort());
    expect(await waitlist()).toEqual(['person@example.com']);
  });

  test('sends a form posted without script back to the page’s line, new address or known', async () => {
    const app = makeApp();

    const first = await app.handle(join('person@example.com', { navigate: true }));
    const second = await app.handle(join('person@example.com', { navigate: true }));

    for (const response of [first, second]) {
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(`${SITE_ORIGIN}/#waitlist-done`);
      expect(await response.text()).toBe('');
    }
    expect(await waitlist()).toEqual(['person@example.com']);
    expect(sent).toEqual(['waitlist_joined']);
  });

  test('counts a new address in Rybbit exactly once, and a known one never', async () => {
    const app = makeApp();

    await app.handle(join('person@example.com'));
    await app.handle(join('person@example.com'));
    await app.handle(join('other@example.com'));

    expect(sent).toEqual(['waitlist_joined', 'waitlist_joined']);
  });

  test('logs whether the row was new, and never the address', async () => {
    const app = makeApp();

    await app.handle(join('person@example.com'));
    await app.handle(join('person@example.com'));

    expect(logs).toEqual([
      { message: 'box_waitlist_recorded', context: { inserted: true } },
      { message: 'box_waitlist_recorded', context: { inserted: false } },
    ]);
    expect(JSON.stringify(logs)).not.toContain('example.com');
  });

  test('refuses a disposable address with its reason, stores nothing and counts nothing', async () => {
    const app = makeApp();

    const response = await app.handle(join('someone@mailinator.com'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'email_refused' });
    expectCors(response);
    expect(await waitlist()).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('refuses an address whose domain takes no mail, the same way', async () => {
    const app = makeApp({ ...TAKES_MAIL, resolveMx: async () => [{ exchange: '' }] });

    const response = await app.handle(join('person@example.com'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'email_refused' });
    expectCors(response);
    expect(await waitlist()).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('answers a resolver that gave no answer as a fault, stores nothing and counts nothing', async () => {
    const app = makeApp({
      ...TAKES_MAIL,
      resolveMx: async (name) => {
        throw Object.assign(new Error(`queryMx ETIMEOUT ${name}`), { code: 'ETIMEOUT' });
      },
    });

    const response = await app.handle(join('person@example.com'));

    expect(response.status).toBe(500);
    expectCors(response);
    expect(await waitlist()).toEqual([]);
    expect(sent).toEqual([]);
    // The failure is logged, with the resolver's code and nothing of the address.
    expect(logs.map((entry) => entry.message)).toEqual(['box_waitlist_record_failed']);
    expect(JSON.stringify(logs)).toContain('ETIMEOUT');
    expect(JSON.stringify(logs)).not.toContain('example.com');
  });

  test('refuses a value that is not an address', async () => {
    const app = makeApp();

    const response = await app.handle(join('not-an-address'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'email_invalid' });
    expectCors(response);
    expect(sent).toEqual([]);
  });

  test('keeps the CORS headers on a body that fails validation', async () => {
    const app = makeApp();
    const post = (contentType: string, body: string) =>
      new Request('https://merkur.test/api/box-waitlist', {
        method: 'POST',
        headers: { 'content-type': contentType, origin: SITE_ORIGIN, 'x-forwarded-for': CLIENT_IP },
        body,
      });

    for (const request of [
      join('ab'),
      join(`${'x'.repeat(250)}@example.com`),
      // One body shape: url-encoded `email` and nothing beside it.
      post('application/x-www-form-urlencoded', 'email=person%40example.com&name=Person'),
      post('application/json', JSON.stringify({ email: 'person@example.com' })),
    ]) {
      const response = await app.handle(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error', 'invalid_request');
      expectCors(response);
    }
    expect(await waitlist()).toEqual([]);
  });

  test('refuses a post from another origin, or from none, before it spends or stores anything', async () => {
    const app = makeApp();

    for (const origin of ['https://evil.test', 'https://merkur.test', 'null', null]) {
      const response = await app.handle(join('person@example.com', { origin }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'origin_forbidden' });
      expectCors(response);
    }
    expect(consumed).toEqual([]);
    expect(await waitlist()).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('limits each source address to five joins in ten minutes, and says so readably', async () => {
    const app = makeApp();

    await app.handle(join('person@example.com'));
    expect(consumed).toEqual([
      { key: `box-waitlist:ip:${CLIENT_IP}`, limit: 5, windowMs: 600_000 },
    ]);

    allowed = false;
    const response = await app.handle(join('other@example.com'));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'rate_limited' });
    expectCors(response);
    expect(await waitlist()).toEqual(['person@example.com']);
    expect(sent).toEqual(['waitlist_joined']);
  });

  test('gates and answers every spelling the router sends to the route', async () => {
    const app = makeApp();
    const at = (path: string, origin: string) =>
      new Request(`https://merkur.test${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin,
          'x-forwarded-for': CLIENT_IP,
        },
        body: 'email=person%40example.com',
      });

    for (const path of ['/api/box-waitlist/', '/api/box-waitlist?from=hero']) {
      const foreign = await app.handle(at(path, 'https://evil.test'));
      expect(foreign.status).toBe(403);
      expectCors(foreign);
      const accepted = await app.handle(at(path, SITE_ORIGIN));
      expect(accepted.status).toBe(204);
      expectCors(accepted);
    }
    expect(await waitlist()).toEqual(['person@example.com']);
  });

  test('leaves every other path without CORS headers', async () => {
    const app = makeApp()
      .get('/api/other', () => ({ ok: true }))
      .get('/api/box-waitlist-other', () => ({ ok: true }));

    for (const path of ['/api/other', '/api/box-waitlist-other']) {
      const response = await app.handle(
        new Request(`https://merkur.test${path}`, { headers: { origin: SITE_ORIGIN } }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });
});
