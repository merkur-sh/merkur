import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const ORIGIN = 'https://merkur.test';
const ADDRESS = 'someone@example.test';

// Flow ids as the server issues them, 32 bytes in canonical base64url:
// responses are checked against its schemas.
const CODE_FLOW = Buffer.alloc(32, 1).toString('base64url');

const SECOND_CODE_FLOW = Buffer.alloc(32, 2).toString('base64url');

const PROVEN_FLOW = Buffer.alloc(32, 3).toString('base64url');

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const realFetch = globalThis.fetch;
const originalFormData = Object.getOwnPropertyDescriptor(globalThis, 'FormData');
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

let createAuth: typeof import('./createAuth').createAuth;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: ORIGIN },
  });
  // The handlers read the submitted form; these tests hand them its fields.
  Object.defineProperty(globalThis, 'FormData', {
    configurable: true,
    value: class {
      constructor(private readonly form: { readonly fields: Record<string, string> }) {}
      get(name: string): string | null {
        return this.form.fields[name] ?? null;
      }
    },
  });
  ({ createAuth } = await import('./createAuth'));
});

afterAll(() => {
  for (const [key, descriptor] of [
    ['fetch', originalFetch],
    ['FormData', originalFormData],
    ['location', originalLocation],
  ] as const) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
});

type Answer = { readonly status: number; readonly body: unknown };

/** Serves the policy, then whatever each test queues for the reset routes. */
function serve(identity: 'username' | 'email', answers: Record<string, Answer[]>) {
  const requests: Array<{ path: string; body: unknown }> = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      // The signing module loads its WebAssembly through `fetch` too.
      if (!path.startsWith('/api/')) return realFetch(input, init);
      if (path === '/api/auth/policy') return json(200, { identity, registration: true });
      requests.push({ path, body: JSON.parse(String(init?.body)) });
      const next = answers[path]?.shift();
      if (next === undefined) throw new Error(`Unexpected request: ${path}`);
      return json(next.status, next.body);
    },
  });
  return requests;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function submit(fields: Record<string, string>): SubmitEvent {
  return {
    preventDefault() {},
    currentTarget: { fields, reset() {} },
  } as unknown as SubmitEvent;
}

async function auth(identity: 'username' | 'email') {
  const installed: unknown[] = [];
  const created = createAuth({
    enterAuth: () => Promise.resolve(),
    endSignedInState: () => {},
    setAccessToken: (next) => void installed.push(next),
    setAccount: (next) => void installed.push(next),
    getAccount: () => null,
    loadDevices: async () => {},
  });
  await created.loadAuthPolicy();
  expect(created.authIdentity()).toBe(identity);
  return { auth: created, installed };
}

describe('createAuth password reset', () => {
  test('a username server offers no reset and sends nothing', async () => {
    const requests = serve('username', {});
    const { auth: created } = await auth('username');

    await created.onAuthResetStart('someone');

    expect(created.authReset()).toBeNull();
    expect(requests).toEqual([]);
  });

  test('walks code to confirmation, keeping the step through a wrong code and a busy server', async () => {
    const devices = [{ name: 'laptop', platform: 'macOS', box: false }];
    const requests = serve('email', {
      '/api/auth/reset/code': [
        { status: 200, body: { flowId: CODE_FLOW } },
        { status: 200, body: { flowId: SECOND_CODE_FLOW } },
      ],
      '/api/auth/reset/verify': [
        { status: 400, body: { error: 'invalid_email_code' } },
        { status: 429, body: { error: 'rate_limited' } },
        { status: 200, body: { flowId: PROVEN_FLOW, devices } },
      ],
    });
    const { auth: created } = await auth('email');

    await created.onAuthResetStart(ADDRESS);
    expect(created.authReset()).toMatchObject({ step: 'code', address: ADDRESS });
    expect(created.authError()).toBe('');

    // Not six digits: refused here, never sent.
    await created.onAuthResetCodeSubmit(submit({ code: '12a456' }));
    expect(created.authError()).toBe(
      'That code is not right. Check the latest email, then try again.',
    );
    expect(requests).toHaveLength(1);

    await created.onAuthResetCodeSubmit(submit({ code: '000000' }));
    expect(created.authError()).toBe(
      'That code is not right. Check the latest email, then try again.',
    );
    expect(created.authReset()?.step).toBe('code');

    await created.onAuthResetCodeSubmit(submit({ code: '000001' }));
    expect(created.authError()).toBe('Too many attempts. Try again later.');
    expect(created.authReset()?.step).toBe('code');

    // A resend opens a new flow; the next guess goes to it.
    await created.onAuthResetCodeResend();
    expect(created.authError()).toBe('');
    await created.onAuthResetCodeSubmit(submit({ code: ' 123456 ' }));

    expect(created.authReset()).toMatchObject({ step: 'confirm', address: ADDRESS, devices });
    expect(created.authError()).toBe('');
    expect(requests.map((request) => request.body)).toEqual([
      { username: ADDRESS },
      { flowId: CODE_FLOW, emailCode: '000000' },
      { flowId: CODE_FLOW, emailCode: '000001' },
      { username: ADDRESS },
      { flowId: SECOND_CODE_FLOW, emailCode: '123456' },
    ]);
    expect(created.authPending()).toBe(false);

    created.onAuthResetCancel();
    expect(created.authReset()).toBeNull();
  });

  test('a flow the server no longer has ends the reset and says to start again', async () => {
    serve('email', {
      '/api/auth/reset/code': [{ status: 200, body: { flowId: CODE_FLOW } }],
      '/api/auth/reset/verify': [{ status: 400, body: { error: 'authentication_failed' } }],
    });
    const { auth: created } = await auth('email');
    await created.onAuthResetStart(ADDRESS);

    await created.onAuthResetCodeSubmit(submit({ code: '123456' }));

    expect(created.authReset()).toBeNull();
    expect(created.authError()).toBe(
      'This password reset has expired. Start again to get a new code.',
    );
  });

  test('a refused address and an exhausted mail budget each say what to do', async () => {
    serve('email', {
      '/api/auth/reset/code': [
        { status: 400, body: { error: 'authentication_failed' } },
        { status: 429, body: { error: 'rate_limited' } },
      ],
    });
    const { auth: created } = await auth('email');

    await created.onAuthResetStart('not-an-address');
    expect(created.authError()).toBe('Enter the email address of your account, then try again.');
    await created.onAuthResetStart(ADDRESS);
    expect(created.authError()).toBe('Too many attempts. Try again later.');
    expect(created.authReset()).toBeNull();
  });

  test('the new password is held to the account policy before anything is sent', async () => {
    const requests = serve('email', {
      '/api/auth/reset/code': [{ status: 200, body: { flowId: CODE_FLOW } }],
      '/api/auth/reset/verify': [{ status: 200, body: { flowId: PROVEN_FLOW, devices: [] } }],
    });
    const { auth: created, installed } = await auth('email');
    await created.onAuthResetStart(ADDRESS);
    await created.onAuthResetCodeSubmit(submit({ code: '123456' }));

    await created.onAuthResetConfirm(submit({ password: 'short' }));

    expect(created.authError()).not.toBe('');
    expect(created.authReset()?.step).toBe('confirm');
    expect(requests).toHaveLength(2);
    expect(installed).toEqual([]);
  });

  test('a reset the server has already spent ends, and nothing is installed', async () => {
    const requests = serve('email', {
      '/api/auth/reset/code': [{ status: 200, body: { flowId: CODE_FLOW } }],
      '/api/auth/reset/verify': [{ status: 200, body: { flowId: PROVEN_FLOW, devices: [] } }],
      '/api/auth/reset/start': [{ status: 400, body: { error: 'authentication_failed' } }],
    });
    const { auth: created, installed } = await auth('email');
    await created.onAuthResetStart(ADDRESS);
    await created.onAuthResetCodeSubmit(submit({ code: '123456' }));

    await created.onAuthResetConfirm(submit({ password: 'a second correct horse battery' }));

    expect(requests.at(-1)?.path).toBe('/api/auth/reset/start');
    expect(created.authReset()).toBeNull();
    expect(created.authError()).toBe(
      'This password reset has expired. Start again to get a new code.',
    );
    // The account and token are cleared, never set.
    expect(installed).toEqual([null, null]);
  }, 30_000);
});
