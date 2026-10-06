import type { Page } from '@playwright/test';
import { createAccount, expectLoggedIn } from './fixtures/account';
import { linkOfflineDaemon } from './fixtures/daemon-process';

import { expect, test } from './fixtures/test';

/**
 * The keyboard layer, driven the only way it can honestly be checked: through
 * a real browser, against real focus.
 *
 * The unit tests cover the sequence machine in isolation. What they cannot see
 * is the part that actually breaks — whether a bare `j` reaches the handler,
 * whether the cursor is where the next binding thinks it is, and whether a
 * dialog takes the keys away while it is open.
 */

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Which screen is showing.
 *
 * Not visibility: every screen stays mounted behind `ViewLayer` and a hidden
 * one is only `opacity: 0` and `inert`, which Playwright still counts as
 * visible. `data-route` is the app's own answer to the question.
 */
async function expectRoute(page: Page, route: string): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-route', route);
}

test('drives the machine list, its actions, and the palette from the keyboard', async ({
  baseURL,
  page,
}) => {
  if (baseURL === undefined) throw new Error('baseURL is required for keyboard E2E tests');
  const password = 'Password123!';

  await page.goto('/');
  await createAccount(page, `e2e-keys-${uniqueSuffix()}`, password);
  await expectLoggedIn(page);
  await expect(page.locator('#device-list')).toBeVisible();

  const linked = await linkOfflineDaemon(page, baseURL, password);
  try {
    const row = page.getByTitle(`Start ${linked.daemonName}`);
    await expect(row).toBeVisible();

    // Linking left focus on the footer button the fixture used, and the list
    // declines to take the cursor away from a control the user is already on.
    // `g g` claims it explicitly.
    await page.keyboard.press('g');
    await page.keyboard.press('g');
    await expect(row).toBeFocused();

    // `j`/`k` wrap on a single-row list, which is the cheapest proof that the
    // walk ran at all rather than the press being swallowed.
    await page.keyboard.press('j');
    await expect(row).toBeFocused();
    await page.keyboard.press('k');
    await expect(row).toBeFocused();

    // With focus back at the document root, the list takes a cursor on its own
    // as the machines arrive, so every row binding below has something to act
    // on without the user first aiming at it.
    await page.reload();
    await expect(row).toBeFocused();

    // `?` renders from the live binding registry, so seeing a screen-specific
    // entry proves the device list's scope is the one being dispatched to.
    await page.keyboard.press('?');
    const help = page.getByRole('dialog', { name: 'Keyboard' });
    await expect(help).toBeVisible();
    await expect(help.getByText('Rename machine')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();

    // `r` acts on the row the cursor is on.
    await page.keyboard.press('r');
    const renameDialog = page.getByRole('dialog', { name: 'Rename machine' });
    await expect(renameDialog).toBeVisible();

    // The dialog owns the keyboard while it is open: `j` is a character in the
    // name field, not a cursor move behind it.
    const nameField = renameDialog.getByLabel('Machine name');
    await expect(nameField).toBeFocused();
    await nameField.fill('');
    await page.keyboard.type('jjkk');
    await expect(nameField).toHaveValue('jjkk');
    await page.keyboard.press('Escape');
    await expect(renameDialog).toBeHidden();

    // Chords: `g s` leaves for settings, `q` comes back.
    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await expectRoute(page, 'settings');
    await page.keyboard.press('q');
    await expectRoute(page, 'devices');

    // A dead prefix must not eat the key that killed it: the `g` before an
    // unbound key costs nothing, and `g s` still works after it.
    await page.keyboard.press('g');
    await page.keyboard.press('z');
    await expectRoute(page, 'devices');
    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await expectRoute(page, 'settings');

    // The four tabs are one screen: `l` and `3` move within it without
    // deepening the stack, so one Escape still leaves for the machine list.
    await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('l');
    await expect(page.getByRole('tab', { name: 'Keyboard' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('3');
    await expect(page.getByRole('tab', { name: 'Sessions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectRoute(page, 'settings');
    await page.keyboard.press('Escape');
    await expectRoute(page, 'devices');

    // The palette answers to the right ⌘ only. Held explicitly rather than via
    // a `Meta+k` press, because that would send the left one and prove nothing.
    await page.keyboard.down('MetaRight');
    await page.keyboard.press('k');
    await page.keyboard.up('MetaRight');
    const palette = page.getByRole('dialog');
    await expect(palette).toBeVisible();
    const query = palette.getByRole('combobox');
    await expect(query).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    // The left ⌘ is deliberately untouched, so the same letter does nothing.
    await page.keyboard.down('MetaLeft');
    await page.keyboard.press('k');
    await page.keyboard.up('MetaLeft');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Movement, driven the way a hand actually drives it: the ⌘ that summoned
    // the palette is still down when the first Ctrl+J follows. Excluding
    // `metaKey` here left the movement keys dead for exactly as long as that
    // key stayed pressed, which reads as them not working at all.
    await page.keyboard.down('MetaRight');
    await page.keyboard.press('k');
    await expect(query).toBeFocused();
    await expect(query).toHaveAttribute('aria-activedescendant', 'command-option-0');
    // The cursor has to be *visible*, not merely tracked. `bg-cursor` and
    // `bg-transparent` are both plain utilities in the same layer, so a row
    // carrying the pair had its highlight silently overridden by the reset —
    // `aria-activedescendant` moved and nothing on screen did.
    //
    // Both halves are asserted because a tint alone is 1.34:1 against the row's
    // own surface on this ramp: the accent ring is what actually reads as
    // "here", and the gradient only gives it an interior.
    const cursorStyle = await palette.locator('[data-command-index="0"]').evaluate((el) => {
      const style = getComputedStyle(el);
      return { image: style.backgroundImage, shadow: style.boxShadow };
    });
    expect(cursorStyle.image).toContain('linear-gradient');
    expect(cursorStyle.shadow).toContain('inset');
    await page.keyboard.down('Control');
    await page.keyboard.press('j');
    await page.keyboard.up('Control');
    await expect(query).toHaveAttribute('aria-activedescendant', 'command-option-1');
    await page.keyboard.up('MetaRight');
    await page.keyboard.press('Control+k');
    await expect(query).toHaveAttribute('aria-activedescendant', 'command-option-0');

    await query.fill('settings');
    const options = palette.getByRole('option');
    await expect(options.first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expectRoute(page, 'settings');

    // Settings moves on two axes, and the tabs get the horizontal one: a theme
    // is chosen once, while the tab is switched constantly. `j` walks the
    // controls of the open tab; `l` leaves it for the next tab.
    const controlLabel = async (): Promise<string> =>
      page.evaluate(() => document.activeElement?.textContent ?? '');
    const insidePanel = async (): Promise<boolean> =>
      page.evaluate(() => document.activeElement?.closest('#settings-panel') !== null);

    await page.keyboard.press('j');
    expect(await insidePanel()).toBe(true);
    const firstControl = await controlLabel();
    await page.keyboard.press('j');
    expect(await controlLabel()).not.toBe(firstControl);

    // The tab bar is never a `j` stop: walking the controls of a tab must not
    // wander into the control that replaces them.
    await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('l');
    await expect(page.getByRole('tab', { name: 'Keyboard' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectRoute(page, 'settings');

    await page.keyboard.press('q');
    await expectRoute(page, 'devices');
  } finally {
    linked.dispose();
  }
});
