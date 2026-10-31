import { describe, expect, spyOn, test } from 'bun:test';
import * as daemonAuth from '@merkur/auth';
import { daemonHttpProofHeaders, MAX_DAEMON_HTTP_BODY_BYTES, signDaemonProof } from '@merkur/auth';
import { Clock, Effect, Match } from 'effect';
import { Elysia } from 'elysia';
import {
  type PushNotificationService,
  PushNotificationServiceTag,
} from '../services/push-notification-service';
import { apiErrorPlugin } from './api-errors';
import { DAEMON_TEST_SEED, daemonAuthFixture } from './daemon-auth-fixture';
import { authorizeDaemonRequest, createDaemonRequestAuth } from './daemon-request-auth';
import { notificationRoutesPlugin } from './routes/notification-routes';
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
  const auth = createDaemonRequestAuth(fixture.runProgram, fixture.logger);
  let admitted = 0;
  const bodies: unknown[] = [];
  const handle = async ({ request, body }: { request: Request; body: unknown }) => {
    const identity = authorizeDaemonRequest(request);
    if (identity === null) return new Response(null, { status: 401 });
    admitted++;
    bodies.push(body);
    return identity;
  };
  const server = new Elysia()
    .use(apiErrorPlugin)
    .post('/api/daemon/perf', { parse: 'none', transform: auth.json }, handle)
    .put('/api/daemon/perf', { parse: 'none', transform: auth.json }, handle)
    .post('/api/daemon/traces', { parse: 'none', transform: auth.text }, handle);
  return {
    server,
    fixture,
    bodies,
    get admitted() {
      return admitted;
    },
  };
}

describe('daemon HTTP proof boundary', () => {
  test.each([
    'missing',
    'malformed',
    'forged',
    'valid-json',
    'valid-text',
    'valid-chunked',
    'valid-empty',
    'valid-limit',
  ])('counts authentication boundary work: %s', async (workload) => {
    let verifications = 0;
    const h = app({
      beforeVerify: async () => {
        verifications++;
      },
    });
    const text = ['valid-text', 'valid-empty', 'valid-limit'].includes(workload);
    const body = Match.value(workload).pipe(
      Match.when('valid-empty', () => ''),
      Match.when('valid-limit', () => 'x'.repeat(MAX_DAEMON_HTTP_BODY_BYTES)),
      Match.orElse(() => BODY),
    );
    const url = text ? `${ORIGIN}/api/daemon/traces` : URL;
    const headers: Record<string, string> =
      workload === 'missing' ? {} : await proof(workload === 'forged' ? '{}' : body, url);
    if (workload === 'malformed') headers['x-merkur-signature'] = 'invalid';
    const bytes = new TextEncoder().encode(body);
    let offset = 0;
    let offeredBytes = 0;
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: new ReadableStream(
        {
          pull(controller) {
            if (offset === bytes.length) {
              controller.close();
              return;
            }
            const end = workload === 'valid-chunked' ? offset + 1 : bytes.length;
            const chunk = bytes.subarray(offset, end);
            offeredBytes += chunk.length;
            offset = end;
            controller.enqueue(chunk);
          },
        },
        { highWaterMark: 0 },
      ),
    });
    const stream = request.body;
    if (stream === null) throw new Error('Missing test body');
    const reader = spyOn(stream, 'getReader');
    const digest = spyOn(daemonAuth, 'daemonBodyDigest');
    const decode = spyOn(TextDecoder.prototype, 'decode');
    const parse = spyOn(JSON, 'parse');
    try {
      const response = await h.server.handle(request);
      const counts = {
        readers: reader.mock.calls.length,
        bytes: offeredBytes,
        digests: digest.mock.calls.length,
        verifications,
        decodes: decode.mock.calls.length,
        parses: parse.mock.calls.filter(([value]) => value === body).length,
      };
      process.stdout.write(`${JSON.stringify({ workload, status: response.status, ...counts })}\n`);
      const early = workload === 'missing' || workload === 'malformed';
      const valid = workload.startsWith('valid-');
      expect(response.status).toBe(valid ? 200 : 401);
      expect(counts).toEqual({
        readers: early ? 0 : 1,
        bytes: early ? 0 : bytes.length,
        digests: early ? 0 : 1,
        verifications: early ? 0 : 1,
        decodes: valid ? 1 : 0,
        parses: valid && !text ? 1 : 0,
      });
      expect(h.fixture.nonces.size).toBe(valid ? 1 : 0);
      if (valid) expect(h.bodies).toEqual([text ? body : { value: 1 }]);
    } finally {
      reader.mockRestore();
      digest.mockRestore();
      decode.mockRestore();
      parse.mockRestore();
    }
  });

  test('rejects every missing or malformed proof field without reading the body', async () => {
    const headers = await proof();
    for (const field of [
      'x-merkur-daemon-id',
      'x-merkur-timestamp',
      'x-merkur-nonce',
      'x-merkur-signature',
      'x-merkur-signature-p256',
    ]) {
      for (const value of [null, '!']) {
        const altered = new Headers(headers);
        if (value === null) altered.delete(field);
        else altered.set(field, value);
        const request = new Request(URL, { method: 'POST', headers: altered, body: '{' });
        const h = app();
        const stream = request.body;
        if (stream === null) throw new Error('Missing test body');
        const reader = spyOn(stream, 'getReader');
        try {
          expect((await h.server.handle(request)).status).toBe(401);
          expect(reader).not.toHaveBeenCalled();
          expect(h.admitted).toBe(0);
        } finally {
          reader.mockRestore();
        }
      }
    }
  });

  test('production management routes reject forged JSON before parsing or schema validation', async () => {
    for (const path of ['/api/daemon/perf', '/api/daemon/traces', '/api/daemon/terminal-bell']) {
      const f = daemonAuthFixture({ origin: ORIGIN });
      const options = {
        runServerProgram: f.runProgram,
        logger: f.logger,
        authorizeRequest: async () => null,
      };
      const server = new Elysia()
        .use(apiErrorPlugin)
        .use(telemetryRoutesPlugin(options))
        .use(notificationRoutesPlugin(options));
      const url = `${ORIGIN}${path}`;
      for (const headers of [{}, await proof('{}', url)]) {
        const request = new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: '{',
        });
        const response = await server.handle(request);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'unauthorized' });
        expect(f.nonces.size).toBe(0);
      }
    }
  });

  test('retains a verified principal only on the exact request and consumes it once', async () => {
    const f = daemonAuthFixture({ origin: ORIGIN });
    const auth = createDaemonRequestAuth(f.runProgram, f.logger);
    const request = new Request(URL, { method: 'POST', headers: await proof(), body: BODY });
    const copy = request.clone();
    const context: Parameters<typeof auth.json>[0] = { request, body: undefined };
    expect(authorizeDaemonRequest(request)).toBeNull();
    await auth.json(context);
    expect(context.body).toEqual({ value: 1 });
    expect(authorizeDaemonRequest(copy)).toBeNull();
    expect(authorizeDaemonRequest(request)).toMatchObject({
      daemonId: 'daemon-1',
      userId: 'user-1',
    });
    expect(authorizeDaemonRequest(request)).toBeNull();
  });

  test('rechecks expiry after body reading, signature verification and replay claiming', async () => {
    const timestamp = Date.now();
    for (const expireAt of ['body', 'signature', 'replay']) {
      let now = timestamp;
      const f = daemonAuthFixture({
        origin: ORIGIN,
        beforeVerify: async () => {
          if (expireAt === 'signature') now += 60_000;
        },
      });
      const runProgram: typeof f.runProgram = (program, options) =>
        f.runProgram(
          Effect.clockWith((clock) =>
            Effect.provideService(program, Clock.Clock, {
              currentTimeMillis: Effect.sync(() => now),
              currentTimeMillisUnsafe: () => now,
              currentTimeNanos: clock.currentTimeNanos,
              currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
              monotonicTimeNanos: clock.monotonicTimeNanos,
              monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
              sleep: (duration) => clock.sleep(duration),
            }),
          ),
          options,
        );
      const server = new Elysia()
        .use(apiErrorPlugin)
        .post(
          '/api/daemon/perf',
          { parse: 'none', transform: createDaemonRequestAuth(runProgram, f.logger).json },
          () => 'unexpected handler',
        );
      const headers = await proof(BODY, URL, timestamp);
      const request = new Request(URL, {
        method: 'POST',
        headers,
        body: new ReadableStream(
          {
            pull(controller) {
              if (expireAt === 'body') now += 60_000;
              controller.enqueue(new TextEncoder().encode(BODY));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      });
      const nonces = f.nonces;
      const originalAdd = nonces.add.bind(nonces);
      const add = spyOn(nonces, 'add').mockImplementation((nonce) => {
        if (expireAt === 'replay') now += 60_000;
        return originalAdd(nonce);
      });
      try {
        expect((await server.handle(request)).status).toBe(401);
        expect(authorizeDaemonRequest(request)).toBeNull();
      } finally {
        add.mockRestore();
      }
    }
  });

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

  test('bounds plausible streamed requests before digesting or verifying them', async () => {
    let verifications = 0;
    let cancelled = 0;
    const h = app({
      beforeVerify: async () => {
        verifications++;
      },
    });
    const url = `${ORIGIN}/api/daemon/traces`;
    const headers = await proof('', url);
    const digest = spyOn(daemonAuth, 'daemonBodyDigest');
    try {
      const response = await h.server.handle(
        new Request(url, {
          method: 'POST',
          headers,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_DAEMON_HTTP_BODY_BYTES));
              controller.enqueue(new Uint8Array(1));
            },
            cancel() {
              cancelled++;
            },
          }),
        }),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(h.admitted).toBe(0);
      expect(verifications).toBe(0);
      expect(cancelled).toBe(1);
      expect(digest).not.toHaveBeenCalled();
      expect(h.fixture.nonces.size).toBe(0);
    } finally {
      digest.mockRestore();
    }
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

  test('the production bell route preserves the authenticated identity and body', async () => {
    const f = daemonAuthFixture({ origin: ORIGIN });
    const notifications: unknown[] = [];
    const unused = () => Effect.die(new Error('Unexpected push service call'));
    const push: PushNotificationService = {
      getVapidPublicKey: () => null,
      upsertSubscription: unused,
      deleteSubscription: unused,
      notifyFailedSignIn: unused,
      notifyTerminalBell: (notification) =>
        Effect.sync(() => {
          notifications.push(notification);
        }),
    };
    const runProgram: typeof f.runProgram = (program, options) =>
      f.runProgram(Effect.provideService(program, PushNotificationServiceTag, push), options);
    const server = notificationRoutesPlugin({
      runServerProgram: runProgram,
      logger: f.logger,
      authorizeRequest: async () => null,
    });
    const url = `${ORIGIN}/api/daemon/terminal-bell`;
    const body = '{ "occurredAt": 1234 }';
    const response = await server.handle(
      new Request(url, { method: 'POST', headers: await proof(body, url), body }),
    );
    expect(response.status).toBe(204);
    expect(notifications).toEqual([{ userId: 'user-1', daemonId: 'daemon-1', occurredAt: 1234 }]);
    expect(f.nonces.size).toBe(1);
  });
});
