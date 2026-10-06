import type { Page } from '@playwright/test';

import { createAccount, expectLoggedIn, expectLoggedOut, logout, signIn } from './fixtures/account';
import { linkOfflineDaemon, openAddMachine } from './fixtures/daemon-process';
import { expect, test } from './fixtures/test';

function createUniqueSuffix(): string {
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${Date.now()}-${randomPart}`;
}

async function expectAuthScreen(page: Page): Promise<void> {
  await expect(page.locator('#auth-screen')).toBeVisible();
}

test('keeps controls visible while creating an account and shows the first-list skeleton', async ({
  page,
}) => {
  const suffix = createUniqueSuffix();
  const username = `e2e-loading-${suffix}`;
  const password = 'Password123!';

  await page.route('**/api/auth/start', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await page.route('**/api/devices/events', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });

  await page.goto('/');
  await expectAuthScreen(page);
  const form = page.locator('#auth-form');
  await form.getByLabel('Username').fill(username);
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Continuing…' })).toBeVisible();
  await expect(page.getByLabel('Username')).toBeDisabled();
  await expect(page.getByLabel('Password')).toBeDisabled();

  await expect(page.locator('#device-list')).toBeAttached();
  await expect(page.getByRole('status', { name: 'Loading machines' })).toBeVisible();
  await expect(page.getByText('Connect your first machine')).toBeVisible();
  // With no machines the disclosure opens itself: linking one is not a
  // secondary action then, it is the only one.
  await expect(page.locator('#link-command')).toBeVisible();
  await expect(page.locator('#link-command')).not.toHaveText('');
});

test('auth flow supports registration, offline device persistence, and logout', async ({
  baseURL,
  page,
}) => {
  if (baseURL === undefined) throw new Error('baseURL is required for app E2E tests');
  const suffix = createUniqueSuffix();
  const username = `e2e-${suffix}`;
  const password = 'Password123!';

  await page.goto('/');
  await expectAuthScreen(page);

  await createAccount(page, username, password);

  await expectLoggedIn(page);
  await expect(page.locator('#device-list')).toBeVisible();
  await expect(page.locator('#link-command')).not.toHaveText('');

  // Preferences share a persistent shell with the list. Its DOM identity and
  // local scroll/menu state must survive the round trip.
  await page.locator('#device-list').evaluate((element) => {
    element.dataset.e2eInstance = 'preserved';
  });
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#settings')).toBeAttached();
  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('#device-list')).toHaveAttribute('data-e2e-instance', 'preserved');
  await page.getByLabel('Back to machines').click();
  await expect(page.locator('#device-list')).toHaveAttribute('data-e2e-instance', 'preserved');

  const linked = await linkOfflineDaemon(page, baseURL, password);
  const renamedDaemonName = `${linked.daemonName}-renamed`;
  try {
    // Linking publishes a device-change event. The live SSE stream must replace
    // the list without requiring a reload.
    await expect(page.getByTitle(`Start ${linked.daemonName}`)).toBeVisible();

    const actionsButton = page.getByRole('button', {
      name: `Machine actions for ${linked.daemonName}`,
    });
    await actionsButton.click();
    await expect(
      page.getByRole('menu', { name: `Actions for ${linked.daemonName}` }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: `Actions for ${linked.daemonName}` })).toBeHidden();
    await expect(actionsButton).toBeFocused();

    await actionsButton.click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const renameDialog = page.getByRole('dialog', { name: 'Rename machine' });
    await expect(renameDialog).toBeVisible();
    await expect(renameDialog.getByLabel('Machine name')).toBeFocused();
    await renameDialog.getByLabel('Machine name').fill(renamedDaemonName);
    await renameDialog.getByRole('button', { name: 'Save name' }).click();
    await expect(renameDialog).toBeHidden();
    await expect(page.getByTitle(`Start ${renamedDaemonName}`)).toBeVisible();

    await logout(page);
    await page.reload();
    await expectAuthScreen(page);

    await signIn(page, username, password);
    await expectLoggedIn(page);
    await expect(page.getByTitle(`Start ${renamedDaemonName}`)).toBeVisible();

    await logout(page);
    await expectAuthScreen(page);
  } finally {
    linked.dispose();
  }
});

test('shows a clear message for invalid credentials', async ({ page }) => {
  const suffix = createUniqueSuffix();
  const username = `e2e-${suffix}`;
  const password = 'Password123!';

  await page.goto('/');
  await expectAuthScreen(page);

  await createAccount(page, username, password);
  await expectLoggedIn(page);

  await logout(page);

  // Reload so the service worker handles this request path.
  await page.reload();
  await expectAuthScreen(page);

  await signIn(page, username, 'wrong-password-123');
  await expect(page.locator('#auth-feedback')).toHaveText(
    'Unable to continue. Check your username and password, then try again.',
  );
  await expectLoggedOut(page);
});

test('shows machine capacity and restores the link command after unlinking', async ({
  page,
  baseURL,
}) => {
  if (baseURL === undefined) throw new Error('baseURL is required');
  await page.setViewportSize({ width: 360, height: 780 });
  const password = 'Password123!';
  const linked: Awaited<ReturnType<typeof linkOfflineDaemon>>[] = [];
  await page.goto('/');
  await createAccount(page, `capacity-${createUniqueSuffix()}`, password);
  await expectLoggedIn(page);
  const usage = page.locator('[data-machine-usage]');
  await expect(usage).toHaveText('0 / 3 machine slots used');
  try {
    for (let count = 1; count <= 3; count++) {
      linked.push(await linkOfflineDaemon(page, baseURL, password));
      await expect(usage).toHaveText(`${count} / 3 machine slots used`);
    }
    const disclosure = page.locator('[data-add-machine]');
    if ((await disclosure.getAttribute('open')) === null) {
      await disclosure.locator('summary').click();
    }
    await expect(page.locator('#link-command')).toHaveCount(0);
    await expect(page.getByText('Machine limit reached.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy command', exact: true })).toBeDisabled();
    const machine = linked[0];
    if (machine === undefined) throw new Error('expected a linked machine');
    await page.locator(`#device-menu-button-${machine.daemonId}`).click();
    await page.getByRole('menuitem', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Remove machine', exact: true }).click();
    await expect(usage).toHaveText('2 / 3 machine slots used');
    await openAddMachine(page);
    await expect(page.locator('#link-command')).toContainText('MERKUR_LINK_TOKEN=');
    await expect(page.getByRole('button', { name: 'Copy command', exact: true })).toBeEnabled();
  } finally {
    for (const machine of linked) machine.dispose();
  }
});

test('device list recovers from a dropped event stream and an offline/online edge', async ({
  baseURL,
  page,
}) => {
  if (baseURL === undefined) throw new Error('baseURL is required for app E2E tests');
  const suffix = createUniqueSuffix();
  const username = `e2e-recovery-${suffix}`;
  const password = 'Password123!';

  const eventStreamAttempts: number[] = [];
  let abortNextEventStream = true;
  await page.route('**/api/devices/events', async (route) => {
    eventStreamAttempts.push(Date.now());
    if (abortNextEventStream) {
      // The transport drops before any snapshot. This is the ordinary case the
      // recovery loop exists for, not an authentication failure.
      abortNextEventStream = false;
      await route.abort('connectionfailed');
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await expectAuthScreen(page);
  await createAccount(page, username, password);

  // A dropped first attempt must not bounce boot back to the login screen: the
  // loop retries the same credential immediately and the list still goes live.
  await expectLoggedIn(page);
  await expect.poll(() => eventStreamAttempts.length).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#device-list')).toBeVisible();
  await expect(page.locator('#link-command')).not.toHaveText('');

  const linked = await linkOfflineDaemon(page, baseURL, password);
  try {
    // The stream that carried this snapshot is the reconnected one.
    await expect(page.getByTitle(`Start ${linked.daemonName}`)).toBeVisible();

    // An offline edge parks recovery. The online edge that follows preempts the
    // pending fallback deadline instead of waiting it out, and the list keeps
    // rendering the machines it already knows about throughout.
    const attemptsBeforeEdges = eventStreamAttempts.length;
    await page.evaluate(() => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    await expect
      .poll(() => eventStreamAttempts.length, { timeout: 5_000 })
      .toBeGreaterThan(attemptsBeforeEdges);
    await expect(page.getByTitle(`Start ${linked.daemonName}`)).toBeVisible();

    await logout(page);
    await expectAuthScreen(page);
  } finally {
    linked.dispose();
  }
});

test('an open row menu covers the rows beneath it', async ({ baseURL, page }) => {
  if (baseURL === undefined) throw new Error('baseURL is required for app E2E tests');
  const suffix = createUniqueSuffix();
  const password = 'Password123!';

  await page.goto('/');
  await expectAuthScreen(page);
  await createAccount(page, `e2e-menu-${suffix}`, password);
  await expectLoggedIn(page);

  const first = await linkOfflineDaemon(page, baseURL, password);
  // A link token is single-use, so a second machine needs a fresh one.
  await openAddMachine(page);
  await page.getByRole('button', { name: 'Refresh' }).click();
  const second = await linkOfflineDaemon(page, baseURL, password);

  try {
    const rows = page.locator('[data-device-row]');
    await expect(rows).toHaveCount(2);
    await rows
      .first()
      .getByRole('button', { name: /Machine actions/ })
      .click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();

    // Each row's entrance animation leaves an identity transform on it, and any
    // transform but `none` makes that row a stacking context — which traps its
    // own menu inside it. Without the row being raised while it owns a menu,
    // the row below painted its last-seen figure and its own actions button
    // straight through the open menu. Nothing but a real box test sees this:
    // the menu is "visible", on top by z-index, and completely obscured.
    const covered = await page.evaluate(() => {
      const box = document.querySelector('[role="menu"]')?.getBoundingClientRect();
      if (box === undefined) return 'no menu';
      const samples: string[] = [];
      for (const [x, y] of [
        [box.right - 8, box.top + 8],
        [box.right - 8, box.bottom - 8],
        [box.left + 8, box.top + 8],
      ] as const) {
        const hit = document.elementFromPoint(x, y);
        samples.push(hit?.closest('[role="menu"]') === null ? 'behind' : 'menu');
      }
      return samples.join(',');
    });
    expect(covered).toBe('menu,menu,menu');
  } finally {
    first.dispose();
    second.dispose();
  }
});
