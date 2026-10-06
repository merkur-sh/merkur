import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';

// Touch context: maxTouchPoints > 0 makes isTouchKeyboardEligible() true, so
// the panel creates the touch-mode editing surface instead of the desktop
// cursor-anchored one, and the window keydown fast path defers to it.
test.use({ linkedDaemonContextOptions: { hasTouch: true } });

test('terminal stays edge-to-edge and header controls respond after viewport rotation', async ({
  page,
  linkedDaemon,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'safe-area emulation requires CDP');
  const cdp = await page.context().newCDPSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await connectTerminal(page, linkedDaemon.daemonName);
  const back = page.getByRole('button', { name: 'Back to machines' });
  await expect(page.locator('body')).not.toHaveCSS('position', 'fixed');

  // Resizing alone leaves env(safe-area-inset-*) at zero on desktop. Model
  // the installed iPhone viewport, including the returning portrait status bar.
  for (const { viewport, insets } of [
    { viewport: { width: 390, height: 844 }, insets: { top: 59, left: 0, right: 0, bottom: 34 } },
    { viewport: { width: 844, height: 390 }, insets: { top: 0, left: 59, right: 59, bottom: 21 } },
    { viewport: { width: 390, height: 844 }, insets: { top: 59, left: 0, right: 0, bottom: 34 } },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
    await expect
      .poll(() =>
        page.locator('#terminal').evaluate((terminal) => {
          const style = getComputedStyle(terminal);
          return [style.paddingTop, style.paddingLeft, style.paddingRight];
        }),
      )
      .toEqual(['0px', '0px', '0px']);
    await expect
      .poll(() =>
        page.locator('#terminal-output').evaluate((container) => {
          const canvas = container.querySelector('canvas');
          if (canvas === null) return false;
          const grid = canvas.getBoundingClientRect();
          const box = container.getBoundingClientRect();
          return (
            grid.width > box.width - 30 &&
            grid.width <= box.width + 0.5 &&
            grid.height <= box.height + 0.5
          );
        }),
      )
      .toBe(true);
  }

  // Model a stale document origin without another size change. A fixed shell
  // must not preserve this offset when the orientation notification arrives.
  const previousMinHeight = await page.evaluate(() => {
    const root = document.documentElement;
    const previous = root.style.minHeight;
    root.style.minHeight = '200vh';
    window.scrollTo(0, 64);
    if (window.scrollY !== 64) throw new Error('test did not establish a stale scroll origin');
    window.dispatchEvent(new Event('orientationchange'));
    return previous;
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  // The browser may adjust scrolling after the orientation event has settled.
  await page.evaluate(() => window.scrollTo(0, 32));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.evaluate((previous) => {
    document.documentElement.style.minHeight = previous;
  }, previousMinHeight);

  const toggle = page.getByRole('button', { name: /^(Enable|Disable) keyboard$/ });
  const wasEnabled = (await toggle.getAttribute('aria-pressed')) === 'true';
  await toggle.tap();
  await expect(toggle).toHaveAttribute('aria-pressed', String(!wasEnabled));
  await toggle.tap();
  await expect(toggle).toHaveAttribute('aria-pressed', String(wasEnabled));

  // Real touch activation, not DOM click(), exercises browser hit testing.
  await back.tap();
  await expect(page.locator('body')).toHaveAttribute('data-route', 'devices');
  await page.getByRole('button', { name: 'Settings', exact: true }).tap();
  await expect(page.locator('body')).toHaveAttribute('data-route', 'settings');
  await page.getByRole('button', { name: 'Back to machines' }).tap();
  await expect(page.locator('body')).toHaveAttribute('data-route', 'devices');
  await cdp.detach();
});

async function connectTerminal(
  page: import('@playwright/test').Page,
  daemonName: string,
): Promise<void> {
  await page.getByTitle(`Connect to ${daemonName}`).click();
  await expectConnected(page, 20_000);
}

async function enableKeyboardAndFocusSurface(page: import('@playwright/test').Page): Promise<void> {
  // The unified editing surface replaces the old JSX touch textarea.
  const surface = page.locator('textarea[data-terminal-hidden-input]');
  await expect(surface).toHaveCount(1);

  const toggle = page.getByRole('button', { name: /keyboard/i });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') {
    await toggle.click();
  }
  await surface.focus();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.hasAttribute('data-terminal-hidden-input') ?? false,
      ),
    )
    .toBe(true);
}

test('touch typing flows through the editing surface beforeinput path', async ({
  page,
  linkedDaemon,
}) => {
  await connectTerminal(page, linkedDaemon.daemonName);
  await enableKeyboardAndFocusSurface(page);
  const output = page.getByRole('log', { name: 'Terminal output' });

  // Keys target the focused surface: the window fast path skips them and the
  // text arrives via `beforeinput insertText`; Enter via `insertLineBreak`.
  await page.keyboard.type("printf 'touch-baseline\\n'");
  await page.keyboard.press('Enter');
  await page.waitForTimeout(750);
  await page.keyboard.type("printf 'touch-typing-ok\\n'");
  await page.keyboard.press('Enter');
  await expectOutput(output, 'touch-typing-ok');
});

test('IME composition on the touch surface commits exactly once', async ({
  page,
  linkedDaemon,
}) => {
  await connectTerminal(page, linkedDaemon.daemonName);
  await enableKeyboardAndFocusSurface(page);
  const output = page.getByRole('log', { name: 'Terminal output' });

  await page.keyboard.type("printf 'touch-ime-baseline\\n'");
  await page.keyboard.press('Enter');
  await page.waitForTimeout(750);

  await page.keyboard.type('case "');

  // Synthetic composition: preedit must not reach the PTY; the commit must be
  // delivered exactly once (compositionend), with the trailing `input` echo
  // absorbed by the surface's sentinel reset.
  await page.evaluate(() => {
    const surface = document.querySelector('textarea[data-terminal-hidden-input]');
    if (!(surface instanceof HTMLTextAreaElement)) throw new Error('editing surface missing');
    surface.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    surface.dispatchEvent(
      new CompositionEvent('compositionupdate', { data: 'ime-ok', bubbles: true }),
    );
    surface.value = ' ime-ok';
    surface.dispatchEvent(
      new CompositionEvent('compositionend', { data: 'ime-ok', bubbles: true }),
    );
    surface.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await page.keyboard.type("\" in ime-ok) printf 'touch-ime-ok\\n' ;; *) false ;; esac");
  await page.keyboard.press('Enter');

  // Only one exact composition commit takes the marker branch. A duplicate
  // commit produces "ime-okime-ok" and the shell emits no marker.
  await expectOutput(output, 'touch-ime-ok');
});

test('touch delete and surface paste preserve exact input', async ({ page, linkedDaemon }) => {
  await connectTerminal(page, linkedDaemon.daemonName);
  await enableKeyboardAndFocusSurface(page);
  const output = page.getByRole('log', { name: 'Terminal output' });

  await page.keyboard.type("printf 'touch-edit-baseline\\n'");
  await page.keyboard.press('Enter');
  await page.waitForTimeout(750);

  await page.keyboard.type("printf 'touch-delete-oX");
  await page.keyboard.press('Backspace');
  await page.keyboard.type("k\\n'");
  await page.keyboard.press('Enter');
  await expectOutput(output, 'touch-delete-ok');

  await page.evaluate(() => {
    const surface = document.querySelector('textarea[data-terminal-hidden-input]');
    if (!(surface instanceof HTMLTextAreaElement)) throw new Error('editing surface missing');
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', "printf 'touch-paste-ok\\n'\n");
    surface.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: clipboard }));
  });
  await expectOutput(output, 'touch-paste-ok');
});

async function expectOutput(
  output: import('@playwright/test').Locator,
  marker: string,
): Promise<void> {
  await expect.poll(() => output.textContent(), { timeout: 15_000 }).toContain(marker);
}

test('named macros are edited, synced, reordered and tapped as exact key sequences', async ({
  page,
  linkedDaemon,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Settings', exact: true }).tap();
  await page.getByRole('tab', { name: 'Keyboard', exact: true }).tap();
  await page.locator('[data-keyboard-settings-open="toolbar"]').tap();
  const toolbarEditor = page.getByRole('dialog', { name: 'Quick Access', exact: true });
  await expect(toolbarEditor.getByRole('combobox')).toHaveCount(0);
  await toolbarEditor.screenshot({ path: '/tmp/merkur-toolbar-phone.png' });
  await toolbarEditor.getByRole('button', { name: 'Manage macros', exact: true }).tap();
  const macros = page.getByRole('dialog', { name: 'Macros', exact: true });
  await macros.getByLabel('Display name').fill('Sequence');
  await macros.getByRole('button', { name: 'Ctrl', exact: true }).tap();
  await macros.getByRole('button', { name: 'ABC', exact: true }).tap();
  await macros.getByRole('button', { name: 'Choose a', exact: true }).tap();
  await macros.getByRole('button', { name: 'Add step', exact: true }).tap();
  await macros.getByRole('button', { name: 'Ctrl', exact: true }).tap();
  await macros.getByRole('button', { name: 'Alt', exact: true }).tap();
  await macros.getByRole('button', { name: 'Choose b', exact: true }).tap();
  await macros.getByRole('button', { name: 'Add step', exact: true }).tap();
  await macros.getByRole('button', { name: 'Alt', exact: true }).tap();
  await macros.getByRole('button', { name: 'Controls', exact: true }).tap();
  await macros.getByRole('button', { name: 'Choose Tab', exact: true }).tap();
  await macros.getByRole('button', { name: 'Add step', exact: true }).tap();
  await macros.screenshot({ path: '/tmp/merkur-macro-phone.png' });
  await macros.getByRole('button', { name: 'Save macro', exact: true }).tap();
  await macros.getByRole('button', { name: 'Add Sequence to toolbar', exact: true }).tap();
  await macros.getByRole('button', { name: 'Edit Sequence', exact: true }).tap();
  await macros.getByLabel('Display name').fill('My shortcut');
  await macros.getByRole('button', { name: 'Edit step 3', exact: true }).tap();
  await macros.getByRole('button', { name: 'Choose Return', exact: true }).tap();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/settings/keyboard') &&
      response.request().method() === 'PUT' &&
      response.status() === 204,
  );
  await macros.getByRole('button', { name: 'Save macro', exact: true }).tap();
  await saved;
  await macros.getByRole('button', { name: 'Done', exact: true }).tap();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).tap();
  await page.getByRole('tab', { name: 'Keyboard', exact: true }).tap();
  await page.locator('[data-keyboard-settings-open="toolbar"]').tap();
  await toolbarEditor.getByRole('button', { name: 'Move My shortcut', exact: true }).tap();
  await toolbarEditor.getByRole('button', { name: 'Move Esc', exact: true }).tap();
  await expect(toolbarEditor.locator('[data-toolbar-editor-slot="0"]')).toContainText(
    'My shortcut',
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await toolbarEditor.screenshot({ path: '/tmp/merkur-toolbar-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await toolbarEditor.getByRole('button', { name: 'Done', exact: true }).tap();
  await page.getByRole('button', { name: 'Back to machines', exact: true }).tap();
  await connectTerminal(page, linkedDaemon.daemonName);
  await enableKeyboardAndFocusSurface(page);
  const output = page.getByRole('log', { name: 'Terminal output' });
  await page.keyboard.type(
    "stty raw -echo; printf '\\115\\101\\103\\122\\117\\137\\122\\105\\101\\104\\131\\n'; bytes=$(dd bs=1 count=4 2>/dev/null | od -An -tx1 | tr -d ' \\n'); stty sane; printf 'macro-bytes-%s\\n' \"$bytes\"",
  );
  await page.keyboard.press('Enter');
  await expectOutput(output, 'MACRO_READY');
  await page.locator('[data-terminal-toolbar-key="ctrl"]').tap();
  await page.getByRole('button', { name: 'My shortcut', exact: true }).tap();
  await expectOutput(output, 'macro-bytes-011b620d');
  await expect(page.locator('[data-terminal-toolbar-key="ctrl"]')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('button', { name: 'Back to machines', exact: true }).tap();
  await page.getByRole('button', { name: 'Settings', exact: true }).tap();
  await page.getByRole('tab', { name: 'Keyboard', exact: true }).tap();
  await page.locator('[data-keyboard-settings-open="macros"]').tap();
  await macros.getByRole('button', { name: 'Delete My shortcut', exact: true }).tap();
  await expect(macros.getByRole('button', { name: 'Edit My shortcut', exact: true })).toHaveCount(
    0,
  );
  await macros.getByRole('button', { name: 'Done', exact: true }).tap();
  await page.locator('[data-keyboard-settings-open="toolbar"]').tap();
  await expect(
    toolbarEditor.getByRole('button', { name: 'Move My shortcut', exact: true }),
  ).toHaveCount(0);
});
