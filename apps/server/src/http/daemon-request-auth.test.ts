import { describe, expect, spyOn, test } from 'bun:test';
import { daemonHttpProofHeaders, MAX_DAEMON_HTTP_BODY_BYTES, signDaemonProof } from '@merkur/auth';
import { Elysia } from 'elysia';

import { DAEMON_TEST_SEED, daemonAuthFixture } from './daemon-auth-fixture';
import {
  authorizeDaemonRequest,
  parseDaemonJsonBody,
  parseDaemonTextBody,
} from './daemon-request-auth';
import { telemetryRoutesPlugin } from './routes/telemetry-routes';

const ORIGIN = 'https://merkur.test';
const URL = `${ORIGIN}/api/daemon/perf`;
const BODY = '{ "value": 1 }';

async function proof(body = BODY, url = URL, timestamp = Date.now()) {
  return {
    'content-type': 'application/json',
    ...(await daemonHttpProofHeaders(
      'daemon-1',
      async (transcript) => signDaemonProof(DAEMON_TEST_SEED, 'http', transcript),
      'POST',
      url,
      'application/json',
      new TextEncoder().encode(body),
      timestamp,
    )),
  };
}

function app(options: Parameters<typeof daemonAuthFixture>[0] = {}) {
  const fixture = daemonAuthFixture({ origin: ORIGIN, ...options });
  let admitted = 0;
  const handle = async ({ request }: { request: Request }) => {
    const identity = await authorizeDaemonRequest(fixture.runProgram, request, fixture.logger);
    if (identity === null) return new Response(null, { status: 401 });
    admitted++;
    return identity;
  };
  const server = new Elysia()
    .post('/api/daemon/perf', { parse: parseDaemonJsonBody }, handle)
    .put('/api/daemon/perf', { parse: parseDaemonJsonBody }, handle)
    .post('/api/daemon/traces', { parse: parseDaemonTextBody }, handle);
  return {
    server,
    fixture,
    get admitted() {
      return admitted;
    },
  };
}

describe('daemon HTTP proof boundary', () => {
  test('records proof refusals without credentials, independently of authorization span success', async () => {
    const h = app();
    const warning = spyOn(h.fixture.logger, 'warn');
    try {
      const response = await h.server.handle(
        new Request(URL, { method: 'POST', body: BODY, headers: await proof('{}') }),
      );
      expect(response.status).toBe(401);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith('daemon_http_authentication_rejected');
      const accepted = await h.server.handle(
        new Request(URL, { method: 'POST', body: BODY, headers: await proof() }),
      );
      expect(accepted.status).toBe(200);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  test('accepts exact raw bytes and rejects semantic reserialization and request substitution', async () => {
    const h = app();
    const changes: Array<{
      body?: string;
      method?: string;
      url?: string;
      headers?: Record<string, string>;
    }> = [
      { body: '{"value":1}' },
      { method: 'PUT' },
      { url: `${URL}?x=1` },
      { url: `${ORIGIN}/api/daemon/traces` },
      { headers: { 'content-type': 'text/plain' } },
      { headers: { authorization: 'Bearer copied-key' } },
      { headers: { 'x-merkur-daemon-id': 'daemon-2' } },
    ];
    for (const change of changes) {
      const response = await h.server.handle(
        new Request(change.url ?? URL, {
          method: change.method ?? 'POST',
          body: change.body ?? BODY,
          headers: { ...(await proof()), ...change.headers },
        }),
      );
      expect(response.status).toBe(401);
    }
    expect(h.admitted).toBe(0);
    const response = await h.server.handle(
      new Request(URL, { method: 'POST', headers: await proof(), body: BODY }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ daemonId: 'daemon-1', userId: 'user-1', boxId: null });
  });

  test('admits one concurrent copy across replicas and does not spend invalid proofs', async () => {
    const nonces = new Set<string>();
    const first = app({ nonces });
    const second = app({ nonces });
    const headers = await proof();
    expect(
      (await first.server.handle(new Request(URL, { method: 'POST', headers, body: '{}' }))).status,
    ).toBe(401);
    expect(nonces.size).toBe(0);
    const results = await Promise.all(
      [first, second].map((h) =>
        h.server.handle(new Request(URL, { method: 'POST', headers, body: BODY })),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(first.admitted + second.admitted).toBe(1);
  });

  test('uses configured audience behind proxies and rejects a signature for another origin', async () => {
    const h = app();
    for (const signedUrl of [URL, URL.replace('merkur.test', 'attacker.test')]) {
      const response = await h.server.handle(
        new Request('http://internal/api/daemon/perf', {
          method: 'POST',
          body: BODY,
          headers: {
            ...(await proof(BODY, signedUrl)),
            host: 'attacker.test',
            'x-forwarded-host': 'attacker.test',
          },
        }),
      );
      expect(response.status).toBe(signedUrl === URL ? 200 : 401);
    }
  });

  test('fails closed on replay-store failure and on expired requests', async () => {
    for (const [h, timestamp, status] of [
      [app({ redisFails: true }), Date.now(), 500],
      [app(), Date.now() - 60_000, 401],
      [app(), Date.now() + 40_000, 401],
    ] as const) {
      const response = await h.server.handle(
        new Request(URL, {
          method: 'POST',
          headers: await proof(BODY, URL, timestamp),
          body: BODY,
        }),
      );
      expect(response.status).toBe(status);
      expect(h.admitted).toBe(0);
    }
  });

  test('bounds streamed bodies before authentication', async () => {
    const h = app();
    const response = await h.server.handle(
      new Request(`${ORIGIN}/api/daemon/traces`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_DAEMON_HTTP_BODY_BYTES));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(h.admitted).toBe(0);
  });

  test('the production OTLP route authenticates its exact text body', async () => {
    const f = daemonAuthFixture({ origin: ORIGIN });
    const server = telemetryRoutesPlugin({
      runServerProgram: f.runProgram,
      logger: f.logger,
      authorizeRequest: async () => null,
    });
    const url = `${ORIGIN}/api/daemon/traces`;
    const body = '{"resourceSpans":[]}';
    const response = await server.handle(
      new Request(url, { method: 'POST', headers: await proof(body, url), body }),
    );
    expect(response.status).toBe(204);
    expect(f.nonces.size).toBe(1);
  });
});
