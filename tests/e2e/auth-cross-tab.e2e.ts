import type { Page } from '@playwright/test';

import { createAccount, expectLoggedIn, expectLoggedOut, signIn } from './fixtures/account';
import { expect, test } from './fixtures/test';

/**
 * The browser half of strict refresh-token reuse detection.
 *
 * The server revokes the whole chain the moment a spent refresh token is
 * presented, with no grace window. These tests exercise the two client
 * guarantees that make that safe, against a real cookie jar, real
 * `navigator.locks`, and real `localStorage` — none of which a unit-test shim
 * reproduces faithfully.
 *
 * Kept separate because these scenarios deliberately share an actual browser
 * profile, Web Locks namespace, refresh cookie, and IndexedDB delegation.
 */

const REFRESH_PATH = '/api/auth/refresh';
const PASSWORD = 'Password123!';

let identitySequence = 0;

interface TestIdentity {
  readonly username: string;
  readonly clientKey: string;
}

function createIdentity(label: string): TestIdentity {
  identitySequence += 1;
  const suffix = `${process.pid}-${Date.now().toString(36)}-${identitySequence}`;
  return {
    username: `authx-${label}-${suffix}`,
    // Must parse as an IP to become this scenario's rate-limit identity; see the
    // matching note in auth-resilience.e2e.ts. A distinct second octet keeps the
    // two spec files from sharing buckets.
    clientKey: `10.2.${(identitySequence >> 8) & 0xff}.${identitySequence & 0xff}`,
  };
}

function requestHeaders(identity: TestIdentity): Record<string, string> {
  return { 'x-forwarded-for': identity.clientKey };
}

async function openRegisteredTab(page: Page, identity: TestIdentity): Promise<void> {
  await page.setExtraHTTPHeaders(requestHeaders(identity));
  await page.goto('/');
  await expectLoggedOut(page);
  await createAccount(page, identity.username, PASSWORD);
  await expectLoggedIn(page);
}

test.describe('cross-tab refresh credential', () => {
  test('concurrent tab refreshes serialize instead of tripping reuse detection', async ({
    baseURL,
    browser,
  }) => {
    if (baseURL === undefined) {
      throw new Error('baseURL is required for cross-tab auth E2E tests');
    }

    const identity = createIdentity('concurrent');
    // One context means one cookie jar and one Web Locks namespace, which is
    // what two tabs of the same app actually share.
    const context = await browser.newContext({ baseURL });

    try {
      const firstPage = await context.newPage();
      await openRegisteredTab(firstPage, identity);

      const secondPage = await context.newPage();
      await secondPage.setExtraHTTPHeaders(requestHeaders(identity));

      const refreshStatuses: number[] = [];
      for (const page of [firstPage, secondPage]) {
        page.on('response', (response) => {
          if (new URL(response.url()).pathname === REFRESH_PATH) {
            refreshStatuses.push(response.status());
          }
        });
      }

      // Hold the first tab's refresh open so the second tab is guaranteed to
      // boot while it is still in flight, rather than relying on scheduling.
      await firstPage.route(
        `**${REFRESH_PATH}`,
        async (route) => {
          const response = await route.fetch();
          await new Promise((resolve) => setTimeout(resolve, 500));
          await route.fulfill({ response });
        },
        { times: 1 },
      );

      await Promise.all([firstPage.reload(), secondPage.goto('/')]);

      // Without the cross-tab lock the second tab would post the same one-use
      // cookie, take a 401, and revoke the family out from under both tabs.
      await expectLoggedIn(firstPage);
      await expectLoggedIn(secondPage);
      expect(refreshStatuses).not.toHaveLength(0);
      expect(refreshStatuses.filter((status) => status !== 200)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('a tab does not present a credential another tab retired', async ({ baseURL, browser }) => {
    if (baseURL === undefined) {
      throw new Error('baseURL is required for cross-tab auth E2E tests');
    }

    const identity = createIdentity('retired');
    const context = await browser.newContext({ baseURL });

    try {
      const firstPage = await context.newPage();
      await openRegisteredTab(firstPage, identity);

      // A refresh that dies on the network may already have rotated server-side
      // with the Set-Cookie lost, so the cookie in the jar may be spent.
      await firstPage.route(`**${REFRESH_PATH}`, (route) => route.abort('failed'));
      await firstPage.reload();
      await expectLoggedOut(firstPage);

      const secondPage = await context.newPage();
      await secondPage.setExtraHTTPHeaders(requestHeaders(identity));
      const secondPageRefreshAttempts: string[] = [];
      secondPage.on('request', (request) => {
        if (new URL(request.url()).pathname === REFRESH_PATH) {
          secondPageRefreshAttempts.push(REFRESH_PATH);
        }
      });

      await secondPage.goto('/');
      await expectLoggedOut(secondPage);

      // Retirement is origin-wide, so a tab that never observed the failure
      // still declines to present the credential. Presenting it would revoke the
      // chain and log `refresh_token_reuse_detected` for a benign cause.
      expect(secondPageRefreshAttempts).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});

test('password change rewraps the root, revokes other browsers and serializes a concurrent refresh', async ({
  baseURL,
  browser,
}, testInfo) => {
  const identity = createIdentity('password');
  const context = await browser.newContext({ baseURL });
  const otherContext = await browser.newContext({ baseURL });
  const replacement = 'A fresh password 123!';
  try {
    const page = await context.newPage();
    await openRegisteredTab(page, identity);
    const other = await otherContext.newPage();
    await other.setExtraHTTPHeaders(requestHeaders(identity));
    await other.goto('/');
    await signIn(other, identity.username, PASSWORD);
    await expectLoggedIn(other);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Change', exact: true }).click();
    await page.getByLabel('Current password', { exact: true }).fill('Wrong password 123!');
    await page.locator('#new-password').fill(replacement);
    await page.getByLabel('Confirm new password', { exact: true }).fill('does not match');
    await page.getByRole('button', { name: 'Save password', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('The new passwords do not match.');
    await page.getByLabel('Confirm new password', { exact: true }).fill(replacement);
    await page.getByRole('button', { name: 'Save password', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('The current password is incorrect.');
    await page.getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await page.screenshot({ path: testInfo.outputPath('password-form.png') });

    // Hold the password response after its transaction commits. A second tab
    // must wait for the replacement cookie before it can refresh.
    let releaseResponse = () => {};
    const release = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let committedStatus: number | null = null;
    await page.route(
      '**/api/auth/password',
      async (route) => {
        const response = await route.fetch();
        committedStatus = response.status();
        await release;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: 'Save password', exact: true }).click();
    await expect
      .poll(async () => ({
        status: committedStatus,
        error: await page.getByRole('alert').allTextContents(),
      }))
      .toEqual({ status: 200, error: [] });
    const sibling = await context.newPage();
    await sibling.setExtraHTTPHeaders(requestHeaders(identity));
    let refreshStarted = false;
    sibling.on('request', (request) => {
      if (new URL(request.url()).pathname === REFRESH_PATH) refreshStarted = true;
    });
    try {
      await sibling.goto('/');
      await expect
        .poll(() =>
          sibling.evaluate(async () => {
            const locks = await navigator.locks.query();
            return locks.pending?.some((lock) => lock.name === 'merkur-auth-refresh') ?? false;
          }),
        )
        .toBe(true);
      expect(refreshStarted).toBe(false);
    } finally {
      releaseResponse();
    }
    await expect(
      page.getByRole('status').filter({ hasText: 'Changed. Other browsers were signed out.' }),
    ).toBeVisible();
    await expectLoggedIn(sibling);
    await page.reload();
    await expectLoggedIn(page);
    await expectLoggedOut(other);
    const endedDialog = other.getByRole('dialog', { name: 'Session ended' });
    await expect(endedDialog).toBeVisible();
    await endedDialog.getByRole('button', { name: 'Back to login' }).click();
    await signIn(other, identity.username, PASSWORD);
    await expect(other.getByRole('alert')).toBeVisible();
    await expectLoggedOut(other);
    await signIn(other, identity.username, replacement);
    await expectLoggedIn(other);
  } finally {
    await context.close();
    await otherContext.close();
  }
});

test('a lost password-change response retires the previous refresh credential', async ({
  page,
}) => {
  const identity = createIdentity('password-lost');
  const replacement = 'Another password 123!';
  await openRegisteredTab(page, identity);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await page.getByLabel('Current password', { exact: true }).fill(PASSWORD);
  await page.locator('#new-password').fill(replacement);
  await page.getByLabel('Confirm new password', { exact: true }).fill(replacement);
  await page.route(
    '**/api/auth/password',
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('failed');
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to confirm the change.');
  const refreshes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === REFRESH_PATH) refreshes.push(request.url());
  });
  await page.reload();
  await expectLoggedOut(page);
  expect(refreshes).toEqual([]);
  await signIn(page, identity.username, replacement);
  await expectLoggedIn(page);
});
