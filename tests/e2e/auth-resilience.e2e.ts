import type {
  APIRequestContext,
  APIResponse,
  Page,
  Response as PlaywrightResponse,
} from '@playwright/test';

import {
  createAccount,
  expectLoggedIn,
  expectLoggedOut,
  logout,
  openAuthScreen,
  signIn,
} from './fixtures/account';
import { expect, test } from './fixtures/test';

const AUTH_START_PATH = '/api/auth/start';
const REFRESH_PATH = '/api/auth/refresh';
const LOGOUT_PATH = '/api/auth/logout';
const REFRESH_COOKIE_NAME = 'merkur_refresh';
const PASSWORD = 'Password123!';
const WRONG_PASSWORD = 'WrongPassword123!';
const AUTH_FEEDBACK = 'Unable to continue. Check your username and password, then try again.';
const RATE_LIMITED_FEEDBACK = 'Too many attempts. Wait a moment, then try again.';

let identitySequence = 0;

interface TestIdentity {
  readonly username: string;
  readonly clientKey: string;
}

function createIdentity(label: string): TestIdentity {
  identitySequence += 1;
  const suffix = `${process.pid}-${Date.now().toString(36)}-${identitySequence}`;
  return {
    username: `authr-${label}-${suffix}`,
    clientKey: `10.1.${(identitySequence >> 8) & 0xff}.${identitySequence & 0xff}`,
  };
}

function requestHeaders(identity: TestIdentity, cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'x-forwarded-for': identity.clientKey,
  };
  if (cookie !== undefined) headers.cookie = cookie;
  return headers;
}

function secondaryClientKey(identity: TestIdentity): string {
  const octets = identity.clientKey.split('.').map((part) => Number(part));
  const last = octets[3];
  if (last === undefined || !Number.isInteger(last)) {
    throw new Error(`Invalid E2E client key: ${identity.clientKey}`);
  }
  return `10.3.${octets[2] ?? 0}.${(last + 127) % 255}`;
}

async function refreshSession(
  request: APIRequestContext,
  identity: TestIdentity,
  cookie?: string,
): Promise<APIResponse> {
  return request.post(REFRESH_PATH, {
    headers: requestHeaders(identity, cookie),
  });
}

function requireHeader(response: APIResponse, name: string): string {
  const value = response.headers()[name.toLowerCase()];
  expect(value, `${name} response header`).toBeTruthy();
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name} response header`);
  }
  return value;
}

function refreshCookiePair(setCookieHeader: string): string {
  const pair = setCookieHeader.split(';', 1)[0];
  if (pair === undefined) throw new Error('Refresh Set-Cookie header has no cookie pair');
  const prefix = `${REFRESH_COOKIE_NAME}=`;
  expect(pair.startsWith(prefix)).toBe(true);
  expect(pair.slice(prefix.length)).toContain('.');
  return pair;
}

function expectHardenedRefreshCookie(setCookieHeader: string): void {
  const attributes = setCookieHeader.split(';').map((part) => part.trim());
  const maxAge = attributes.find((attribute) => attribute.startsWith('Max-Age='));

  expect(refreshCookiePair(setCookieHeader)).not.toBe(`${REFRESH_COOKIE_NAME}=`);
  expect(maxAge).toMatch(/^Max-Age=\d+$/);
  expect(attributes).toContain('Path=/api/auth');
  expect(attributes).toContain('SameSite=Strict');
  expect(attributes).toContain('Secure');
  expect(attributes).toContain('HttpOnly');
  expect(attributes.some((attribute) => attribute.toLowerCase().startsWith('domain='))).toBe(false);
}

async function expectSessionResponse(response: APIResponse): Promise<void> {
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({
    accessToken: expect.any(String),
    userId: expect.any(String),
    delegationId: expect.any(String),
    delegationExpiresAt: expect.any(Number),
    serverTimeMs: expect.any(Number),
    deletionCancelled: false,
  });
}

async function registerIdentity(page: Page, identity: TestIdentity, username = identity.username) {
  await openAuthScreen(page, requestHeaders(identity));
  await createAccount(page, username, PASSWORD);
  await expectLoggedIn(page);
}

async function browserRefreshCookie(page: Page) {
  const cookie = (await page.context().cookies()).find(
    (candidate) => candidate.name === REFRESH_COOKIE_NAME,
  );
  expect(cookie, 'browser refresh cookie').toBeDefined();
  if (cookie === undefined) throw new Error('Browser did not store a refresh cookie');
  return cookie;
}

test.describe('OPAQUE account and trusted-browser resilience', () => {
  test('registration issues a host-only hardened refresh cookie', async ({ page }) => {
    const identity = createIdentity('cookie');
    await registerIdentity(page, identity);

    const cookie = await browserRefreshCookie(page);
    expect(cookie).toMatchObject({
      domain: '127.0.0.1',
      httpOnly: true,
      path: '/api/auth',
      sameSite: 'Strict',
      secure: true,
    });
    expect(cookie.domain.startsWith('.')).toBe(false);
    expect(cookie.expires).toBeGreaterThan(Date.now() / 1_000);
  });

  test('refresh rotates the delegation-bound refresh cookie', async ({ page, request }) => {
    const identity = createIdentity('rotation');
    await registerIdentity(page, identity);
    const initial = await browserRefreshCookie(page);
    const initialPair = `${initial.name}=${initial.value}`;

    const refreshResponse = await refreshSession(request, identity, initialPair);
    await expectSessionResponse(refreshResponse);
    const rotatedHeader = requireHeader(refreshResponse, 'set-cookie');

    expect(refreshCookiePair(rotatedHeader)).not.toBe(initialPair);
    expectHardenedRefreshCookie(rotatedHeader);
  });

  test('replayed stale refresh cookie rejects and revokes its successor', async ({
    page,
    request,
  }) => {
    const identity = createIdentity('replay');
    await registerIdentity(page, identity);
    const initial = await browserRefreshCookie(page);
    const staleCookie = `${initial.name}=${initial.value}`;
    const firstRefresh = await refreshSession(request, identity, staleCookie);
    await expectSessionResponse(firstRefresh);
    const latestCookie = refreshCookiePair(requireHeader(firstRefresh, 'set-cookie'));

    const replayResponse = await refreshSession(request, identity, staleCookie);
    expect(replayResponse.status()).toBe(401);
    expect(await replayResponse.json()).toEqual({ error: 'invalid_refresh_token' });

    const latestResponse = await refreshSession(request, identity, latestCookie);
    expect(latestResponse.status()).toBe(401);
    expect(await latestResponse.json()).toEqual({ error: 'invalid_refresh_token' });
  });

  test('explicit logout sends a signed self-revocation and clears the cookie', async ({
    page,
    request,
  }) => {
    const identity = createIdentity('logout');
    await registerIdentity(page, identity);
    const initial = await browserRefreshCookie(page);
    const initialPair = `${initial.name}=${initial.value}`;
    const logoutResponsePromise = page.waitForResponse(
      (response) => new URL(response.url()).pathname === LOGOUT_PATH,
    );

    await logout(page);
    const logoutResponse = await logoutResponsePromise;

    expect(logoutResponse.status()).toBe(200);
    expect(await logoutResponse.json()).toEqual({ ok: true });
    expect(
      (await page.context().cookies()).some((cookie) => cookie.name === REFRESH_COOKIE_NAME),
    ).toBe(false);
    const revokedResponse = await refreshSession(request, identity, initialPair);
    expect(revokedResponse.status()).toBe(401);
  });

  test('trusted same-profile cold reload resumes without a password', async ({ page }) => {
    const identity = createIdentity('reload');
    await registerIdentity(page, identity);
    const cookieBeforeReload = await browserRefreshCookie(page);
    const requestsAfterRegistration: string[] = [];
    page.on('request', (request) =>
      requestsAfterRegistration.push(new URL(request.url()).pathname),
    );
    const refreshResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === REFRESH_PATH && response.request().method() === 'POST',
    );

    await page.reload();
    const refreshResponse = await refreshResponsePromise;

    expect(refreshResponse.status()).toBe(200);
    await expectLoggedIn(page);
    expect(requestsAfterRegistration.filter((path) => path === AUTH_START_PATH)).toHaveLength(0);
    const cookieAfterReload = await browserRefreshCookie(page);
    expect(cookieAfterReload.value).not.toBe(cookieBeforeReload.value);
  });

  test('invalid password leaves pending state and permits a successful retry', async ({ page }) => {
    const identity = createIdentity('recovery');
    await registerIdentity(page, identity);
    await logout(page);

    await page.route(
      `**${AUTH_START_PATH}`,
      async (route) => {
        const response = await route.fetch();
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    const failedStart = page.waitForResponse(
      (response) => new URL(response.url()).pathname === AUTH_START_PATH,
    );

    await signIn(page, identity.username, WRONG_PASSWORD);
    const form = page.locator('#auth-form');
    await expect(form.getByRole('button', { name: 'Continuing…' })).toBeDisabled();
    expect((await failedStart).status()).toBe(200);
    await expect(page.locator('#auth-feedback')).toHaveText(AUTH_FEEDBACK);
    await expect(form.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
    await expectLoggedOut(page);

    await signIn(page, identity.username, PASSWORD);
    await expectLoggedIn(page);
  });

  test('password change reseals the root and accepts only the new password in a fresh browser', async ({
    baseURL,
    browser,
    page,
  }) => {
    if (baseURL === undefined) throw new Error('baseURL is required for auth resilience E2E tests');
    const identity = createIdentity('password-change');
    const newPassword = 'ChangedPassword123!';
    await registerIdentity(page, identity);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Change', exact: true }).click();
    const form = page.locator('#change-password-form');
    await form.getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await form.getByLabel(/^New password/).fill(newPassword);
    await form.getByLabel('Confirm new password', { exact: true }).fill(newPassword);
    await form.getByRole('button', { name: 'Save password', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(
      page.getByText('Changed. Other browsers were signed out.', { exact: true }),
    ).toBeVisible();

    const freshContext = await browser.newContext({ baseURL });
    try {
      const freshPage = await freshContext.newPage();
      await openAuthScreen(freshPage, { 'x-forwarded-for': secondaryClientKey(identity) });
      await signIn(freshPage, identity.username, PASSWORD);
      await expect(freshPage.locator('#auth-feedback')).toHaveText(AUTH_FEEDBACK);
      await expectLoggedOut(freshPage);
      await signIn(freshPage, identity.username, newPassword);
      await expectLoggedIn(freshPage);
    } finally {
      await freshContext.close();
    }
  });

  test('auth start rate limit returns 429 and Retry-After feedback', async ({ page }) => {
    const identity = createIdentity('rate-limit');
    await registerIdentity(page, identity);
    await logout(page);

    let limitedResponse: PlaywrightResponse | null = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const responsePromise = page.waitForResponse(
        (response) => new URL(response.url()).pathname === AUTH_START_PATH,
      );
      await signIn(page, identity.username, WRONG_PASSWORD);
      const response = await responsePromise;
      if (response.status() === 429) {
        limitedResponse = response;
        break;
      }
      expect(response.status()).toBe(200);
      await expect(page.locator('#auth-feedback')).toHaveText(AUTH_FEEDBACK);
    }

    if (limitedResponse === null) throw new Error('Auth start rate limit was not enforced');
    expect(limitedResponse.status()).toBe(429);
    expect(limitedResponse.headers()['retry-after']).toMatch(/^\d+$/);
    await expect(page.locator('#auth-feedback')).toHaveText(RATE_LIMITED_FEEDBACK);
  });

  test('username matching trims whitespace and ignores case', async ({ page }) => {
    const identity = createIdentity('normalize');
    const mixedUsername = `  ${identity.username.toUpperCase()}  `;
    await registerIdentity(page, identity, mixedUsername);
    await logout(page);

    await signIn(page, identity.username.toLowerCase(), PASSWORD);
    await expectLoggedIn(page);
  });

  test('one trusted browser can remotely revoke another browser session', async ({
    baseURL,
    browser,
  }) => {
    if (baseURL === undefined) throw new Error('baseURL is required for auth resilience E2E tests');
    const identity = createIdentity('remote-revoke');
    const firstContext = await browser.newContext({ baseURL });
    const secondContext = await browser.newContext({ baseURL });

    try {
      const firstPage = await firstContext.newPage();
      await registerIdentity(firstPage, identity);

      const secondPage = await secondContext.newPage();
      await openAuthScreen(secondPage, {
        'x-forwarded-for': secondaryClientKey(identity),
      });
      await signIn(secondPage, identity.username, PASSWORD);
      await expectLoggedIn(secondPage);

      const siblingPage = await secondContext.newPage();
      await siblingPage.goto('/');
      await expectLoggedIn(siblingPage);
      let revokedRefreshRequests = 0;
      secondContext.on('request', (request) => {
        if (new URL(request.url()).pathname === REFRESH_PATH) revokedRefreshRequests += 1;
      });

      let revokeRequests = 0;
      firstPage.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() === 'DELETE' && path.startsWith('/api/browser-sessions/')) {
          revokeRequests += 1;
        }
      });
      await firstPage.route(
        '**/api/browser-sessions/*',
        (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'unavailable' }),
          }),
        { times: 1 },
      );
      await firstPage.getByRole('button', { name: 'Settings' }).click();
      await expect(firstPage.locator('#settings')).toBeVisible();
      await firstPage.getByRole('tab', { name: 'Sessions' }).click();
      // Each row is named by the browser it belongs to, so the one control
      // this matches is a row's own Revoke — never "Revoke all other browsers".
      const revokeButton = firstPage.getByRole('button', {
        name: /^Revoke (?!all\b)/u,
      });
      await expect(revokeButton).toHaveCount(1);
      await revokeButton.click();
      await expect(firstPage.getByRole('alert')).toHaveText(
        'Unable to revoke that browser session.',
      );
      expect(revokeRequests).toBe(1);
      await revokeButton.evaluate((button) => {
        if (!(button instanceof HTMLButtonElement))
          throw new Error('Revoke control is not a button');
        button.click();
        button.click();
      });
      await expect(revokeButton).toHaveCount(0);
      expect(revokeRequests).toBe(2);

      await expectLoggedOut(secondPage);
      const endedDialog = secondPage.getByRole('dialog', { name: 'Session ended' });
      await expect(endedDialog).toBeVisible();
      await expect(endedDialog).toContainText('Your session has expired or been revoked.');
      await expectLoggedOut(siblingPage);
      await expect(siblingPage.getByRole('dialog', { name: 'Session ended' })).toBeVisible();
      expect(revokedRefreshRequests).toBe(0);
      await endedDialog.getByRole('button', { name: 'Back to login' }).click();
      await expect(endedDialog).toHaveCount(0);
      await signIn(secondPage, identity.username, PASSWORD);
      await expectLoggedIn(secondPage);

      await firstPage.getByLabel('Back to machines').click();
      await firstPage.reload();
      await expectLoggedIn(firstPage);
    } finally {
      await Promise.all([firstContext.close(), secondContext.close()]);
    }
  });

  test('refresh without a cookie fails closed with stable JSON', async ({ request }) => {
    const identity = createIdentity('missing');
    const response = await refreshSession(request, identity);

    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_refresh_token' });
  });

  test('tampered refresh cookie fails closed with stable JSON', async ({ request }) => {
    const identity = createIdentity('tampered');
    const response = await refreshSession(
      request,
      identity,
      `${REFRESH_COOKIE_NAME}=unknown-id.tampered-token`,
    );

    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_refresh_token' });
  });
});
