import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, flush } from 'solid-js';

import type { BrowserSessionRecord } from '../auth/account-api';
import type { ActiveBrowserAccount } from '../auth/account-workflow';

// `account-api.ts` resolves request paths against `location.origin`. Writable,
// because other suites in the same shard install their own with assignment.
if (typeof globalThis.location === 'undefined') {
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'http://localhost' },
    configurable: true,
    writable: true,
  });
}

const { createBrowserSessionsController } = await import('./browser-sessions-controller');
type BrowserSessionsController = ReturnType<typeof createBrowserSessionsController>;

interface PendingRequest {
  readonly authorization: string | null;
  readonly signal: AbortSignal | null;
  answer(sessions: readonly BrowserSessionRecord[]): void;
  fail(status: number): void;
}

const originalFetch = globalThis.fetch;
let requests: PendingRequest[] = [];

beforeEach(() => {
  requests = [];
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? null;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      requests.push({
        authorization: new Headers(init?.headers).get('Authorization'),
        signal,
        answer(sessions) {
          resolve(Response.json({ serverTimeMs: 1_000, sessions }));
        },
        fail(status) {
          resolve(Response.json({ error: 'request_failed' }, { status }));
        },
      });
    })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ACCOUNT = { username: 'user' } as ActiveBrowserAccount;

function session(delegationId: string, current = false): BrowserSessionRecord {
  return {
    delegationId,
    issuedAt: 1,
    expiresAt: 2,
    revokedAt: null,
    current,
    client: { browser: null, platform: null, installed: false },
  };
}

function request(index: number): PendingRequest {
  const pending = requests[index];
  if (pending === undefined) throw new Error(`request ${index} was never sent`);
  return pending;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
}

function withController(
  run: (controller: BrowserSessionsController) => Promise<void>,
  token: () => string = () => 'live-token',
): Promise<void> {
  return createRoot(async (dispose) => {
    try {
      await run(
        createBrowserSessionsController({
          getAccount: () => ACCOUNT,
          authorize: (_signal, send) => send(token()),
        }),
      );
    } finally {
      dispose();
    }
  });
}

describe('createBrowserSessionsController', () => {
  test('presents the token the authorizer supplies, not a snapshot the account took', async () => {
    let token = 'first-token';
    await withController(
      async (controller) => {
        void controller.load();
        token = 'rotated-token';
        void controller.load();
        await settle();
        expect(request(0).authorization).toBe('Bearer first-token');
        expect(request(1).authorization).toBe('Bearer rotated-token');
      },
      () => token,
    );
  });

  test('an older answer landing after a newer one does not roll the list back', async () => {
    await withController(async (controller) => {
      const older = controller.load();
      const newer = controller.load();
      await settle();
      request(1).answer([session('current', true), session('other')]);
      await newer;
      request(0).answer([session('current', true)]);
      await older;
      await settle();
      expect(controller.sessions().map((entry) => entry.delegationId)).toEqual([
        'current',
        'other',
      ]);
      expect(controller.pending()).toBe(false);
    });
  });

  test('a superseded failure does not report an error over the answer that replaced it', async () => {
    await withController(async (controller) => {
      const older = controller.load().catch(() => undefined);
      const newer = controller.load();
      await settle();
      request(1).answer([session('current', true)]);
      await newer;
      request(0).fail(503);
      await older;
      await settle();
      expect(controller.error()).toBe('');
      expect(controller.sessions()).toHaveLength(1);
    });
  });

  test('the newest failure is reported and cleared by the next answer', async () => {
    await withController(async (controller) => {
      const failed = controller.load().catch(() => undefined);
      await settle();
      request(0).fail(503);
      await failed;
      await settle();
      expect(controller.error()).toBe('Unable to load browser sessions.');

      const retried = controller.load();
      await settle();
      request(1).answer([session('current', true)]);
      await retried;
      await settle();
      expect(controller.error()).toBe('');
    });
  });

  test('reset aborts what is in flight and nothing it answers is published', async () => {
    await withController(async (controller) => {
      const load = controller.load().catch(() => undefined);
      await settle();
      controller.reset();
      expect(request(0).signal?.aborted).toBe(true);
      await load;
      await settle();
      expect(controller.sessions()).toEqual([]);
      expect(controller.error()).toBe('');
      expect(controller.pending()).toBe(false);
    });
  });
});
