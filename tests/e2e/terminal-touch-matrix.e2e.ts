import type { Page } from '@playwright/test';
import { expectShellPhase } from './app-state';
import { expect, test } from './fixtures/daemon-process';
import {
  connectTerminal,
  dispatchTouchBeforeInput,
  dispatchTouchPaste,
  exactValueCommand,
  expectOutput,
  insertTouchText,
  primeTouchTerminal,
  sendTouchEnter,
  terminalTouchInputActive,
} from './terminal-e2e-helpers';

test.use({
  linkedDaemonContextOptions: { hasTouch: true, viewport: { width: 390, height: 720 } },
});

const TOUCH_TEXT_CASES = [
  ['lowercase letters', 'touchlowercase'],
  ['uppercase letters', 'TOUCHUPPERCASE'],
  ['digits', '01234567890123456789'],
  ['spaces', 'touch value with  multiple spaces'],
  ['punctuation', 'touch-._,:;!?'],
  ['paired delimiters', 'touch-[square]{brace}(paren)'],
  ['Greek unicode', 'touch-λ-ω'],
  ['CJK unicode', 'touch-東京-终端-서울'],
  ['emoji unicode', 'touch-🚀-⌨-✅'],
  ['long insertion', 'touch-value-'.repeat(64)],
] as const;

for (const [index, [name, value]] of TOUCH_TEXT_CASES.entries()) {
  test(`touch beforeinput ${index + 1}: ${name}`, async ({ page, linkedDaemon }) => {
    const output = await primeTouchTerminal(page, linkedDaemon.daemonName);
    const marker = `touch-beforeinput-${index + 1}-ok`;
    await insertTouchCommand(page, exactValueCommand(value, marker));
    await expectOutput(output, marker);
  });
}

const COMPOSITION_CASES = [
  ['Latin composition', 'composition'],
  ['accented composition', 'café'],
  ['CJK composition', '日本語'],
  ['emoji composition', '🚀⌨'],
  ['combining composition', 'e\u0301a\u0308'],
] as const;

for (const [index, [name, value]] of COMPOSITION_CASES.entries()) {
  test(`touch IME ${index + 1}: ${name} commits once`, async ({ page, linkedDaemon }) => {
    const output = await primeTouchTerminal(page, linkedDaemon.daemonName);
    const marker = `touch-ime-${index + 1}-ok`;
    const command = exactValueCommand(value, marker);
    const insertion = command.indexOf(value);
    if (insertion < 0) throw new Error('composition value missing from command');
    await insertTouchText(page, command.slice(0, insertion));
    await dispatchComposition(page, value);
    await insertTouchText(page, command.slice(insertion + value.length, -1));
    await sendTouchEnter(page);
    await expectOutput(output, marker);
  });
}

test('touch delete 1: backward beforeinput deletes exactly one character', async ({
  page,
  linkedDaemon,
}) => {
  const output = await primeTouchTerminal(page, linkedDaemon.daemonName);
  await insertTouchText(page, 'echo touch-delete-backward-oX');
  await dispatchTouchBeforeInput(page, 'deleteContentBackward');
  await insertTouchText(page, 'k');
  await sendTouchEnter(page);
  await expectOutput(output, 'touch-delete-backward-ok');
});

test('touch delete 2: keydown and beforeinput are deduplicated', async ({ page, linkedDaemon }) => {
  const output = await primeTouchTerminal(page, linkedDaemon.daemonName);
  await insertTouchText(page, 'echo touch-delete-dedup-oX');
  await dispatchSoftDelete(page, true);
  await insertTouchText(page, 'k');
  await sendTouchEnter(page);
  await expectOutput(output, 'touch-delete-dedup-ok');
});

test('touch delete 3: keydown and keyup fallback deletes once', async ({ page, linkedDaemon }) => {
  const output = await primeTouchTerminal(page, linkedDaemon.daemonName);
  await insertTouchText(page, 'echo touch-delete-keyup-oX');
  await dispatchSoftDelete(page, false);
  await insertTouchText(page, 'k');
  await sendTouchEnter(page);
  await expectOutput(output, 'touch-delete-keyup-ok');
});

test('touch delete 4: forward delete removes the character at the cursor', async ({
  page,
  linkedDaemon,
}) => {
  const output = await primeTouchTerminal(page, linkedDaemon.daemonName);
  await insertTouchText(page, 'echo touch-delete-forward-oXk');
  await dispatchWindowKey(page, 'ArrowLeft');
  await dispatchWindowKey(page, 'ArrowLeft');
  await dispatchTouchBeforeInput(page, 'deleteContentForward');
  await sendTouchEnter(page);
  await expectOutput(output, 'touch-delete-forward-ok');
});

const TOUCH_PASTE_CASES = [
  ['plain text', 'touch-paste-plain'],
  ['spaces and punctuation', 'touch paste !? [] {}'],
  ['unicode', 'touch-paste-λ-東京-café'],
  ['emoji', 'touch-paste-🚀-⌨-✅'],
] as const;

for (const [index, [name, value]] of TOUCH_PASTE_CASES.entries()) {
  test(`touch paste ${index + 1}: ${name}`, async ({ page, linkedDaemon }) => {
    const output = await primeTouchTerminal(page, linkedDaemon.daemonName);
    const marker = `touch-paste-${index + 1}-ok`;
    await dispatchTouchPaste(page, exactValueCommand(value, marker));
    await expectOutput(output, marker);
  });
}

test('touch paste 5: typed prefix and pasted suffix remain ordered', async ({
  page,
  linkedDaemon,
}) => {
  const output = await primeTouchTerminal(page, linkedDaemon.daemonName);
  await insertTouchText(page, "printf '");
  await dispatchTouchPaste(page, "touch-paste-5-ok\\n'\n");
  await expectOutput(output, 'touch-paste-5-ok');
});

test('touch paste 6: 24 KB paste remains byte ordered', async ({ page, linkedDaemon }) => {
  const output = await primeTouchTerminal(page, linkedDaemon.daemonName);
  await insertTouchCommand(page, 'stty -echo\n');
  const comments = Array.from(
    { length: 64 },
    (_, index) => `#${String(index).padStart(2, '0')}-${'t'.repeat(380)}\n`,
  ).join('');
  await dispatchTouchPaste(page, `${comments}stty echo\nprintf 'touch-paste-6-ok\\n'\n`);
  await expectOutput(output, 'touch-paste-6-ok', 25_000);
});

const TOOLBAR_BYTE_CASES = [
  ['escape', 'Esc', 1, '1b'],
  ['tab', 'Tab', 1, '09'],
  ['page-up', 'PgUp', 4, '1b5b357e'],
  ['page-down', 'PgDn', 4, '1b5b367e'],
] as const;

for (const [index, [name, label, byteCount, expectedHex]] of TOOLBAR_BYTE_CASES.entries()) {
  test(`touch toolbar ${index + 1}: ${name} sends exact bytes`, async ({ page, linkedDaemon }) => {
    const output = await primeTouchTerminal(page, linkedDaemon.daemonName);
    const marker = `touch-toolbar-${index + 1}`;
    await prepareRawByteCapture(page, byteCount, marker);
    await page.getByRole('button', { name: label, exact: true }).click();
    await expectOutput(output, `${marker}-${expectedHex}`);
    expect(await terminalTouchInputActive(page)).toBe(true);
  });
}

test('touch keyboard preview appears synchronously on pointerdown and clears on cancel', async ({
  page,
  linkedDaemon,
}) => {
  await primeTouchTerminal(page, linkedDaemon.daemonName);
  const state = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-terminal-custom-keyboard]');
    if (root === null) {
      throw new Error('custom keyboard preview fixture missing');
    }
    const surface = root.querySelector<HTMLElement>('.merkur-keyboard__surface');
    const key = root.querySelector<HTMLElement>('.merkur-keyboard__key[data-key-id="key-q"]');
    const preview = root.querySelector<HTMLElement>(
      '.merkur-keyboard__preview[data-key-id="key-q"]',
    );
    if (surface === null || key === null || preview === null) {
      throw new Error('custom keyboard preview fixture missing');
    }
    const rect = key.getBoundingClientRect();
    const eventInit: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      pointerId: 91,
      pointerType: 'touch',
      button: 0,
      buttons: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    surface.dispatchEvent(new PointerEvent('pointerdown', eventInit));
    const pressedOnDown = key.hasAttribute('data-pressed');
    const previewOnDown = preview.hasAttribute('data-visible');
    surface.dispatchEvent(new PointerEvent('pointercancel', eventInit));
    return {
      previewMode: root.dataset.keyboardPreview,
      pressedOnDown,
      previewOnDown,
      pressedAfterCancel: key.hasAttribute('data-pressed'),
      previewAfterCancel: preview.hasAttribute('data-visible'),
    };
  });

  expect(state).toEqual({
    previewMode: 'keycap',
    pressedOnDown: true,
    previewOnDown: true,
    pressedAfterCancel: false,
    previewAfterCancel: false,
  });
});

test('touch toolbar 5: alt-tab sends an escape-prefixed tab', async ({ page, linkedDaemon }) => {
  const output = await primeTouchTerminal(page, linkedDaemon.daemonName);
  await prepareRawByteCapture(page, 2, 'touch-toolbar-5');
  const alt = page.getByRole('button', { name: 'Alt', exact: true });
  await alt.click();
  await expect(alt).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Tab', exact: true }).click();
  await expectOutput(output, 'touch-toolbar-5-1b09');
  await expect(alt).toHaveAttribute('aria-pressed', 'false');
});

test('touch toolbar 6: modifier taps keep the custom input target active', async ({
  page,
  linkedDaemon,
}) => {
  await primeTouchTerminal(page, linkedDaemon.daemonName);
  for (const label of ['Ctrl', 'Alt']) {
    const button = page.getByRole('button', { name: label, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await terminalTouchInputActive(page)).toBe(true);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }
});

test('touch toolbar 7: horizontal swipe scrolls without activating a key', async ({
  page,
  linkedDaemon,
}) => {
  // The default seven keys fit at 390px; exercise a viewport that requires scrolling.
  await page.setViewportSize({ width: 320, height: 720 });
  await primeTouchTerminal(page, linkedDaemon.daemonName);
  const toolbar = page.locator('[data-terminal-key-toolbar]');
  await expect(toolbar).toBeVisible();
  const dimensions = await toolbar.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  const ctrl = page.locator('[data-terminal-key="ctrl"]');
  await expect(ctrl).toHaveAttribute('aria-pressed', 'false');
  await swipeToolbarLeft(page);
  await expect.poll(() => toolbar.evaluate((element) => element.scrollLeft)).toBeGreaterThan(20);
  await expect(ctrl).toHaveAttribute('aria-pressed', 'false');
  expect(await terminalTouchInputActive(page)).toBe(true);
});

test('touch viewport 1: keyboard animation commits only its stable final height', async ({
  page,
  linkedDaemon,
}) => {
  await primeTouchTerminal(page, linkedDaemon.daemonName);
  const result = await simulateKeyboardViewportAnimation(page);
  expect(result.intermediateHeights).toEqual(result.intermediateHeights.map(() => result.initial));
  expect(result.committedHeights).toEqual([result.final]);
  expect(result.renderedFinal).toBe(result.final);
});

test('touch viewport 2: settled browser resize keeps terminal usable', async ({
  page,
  linkedDaemon,
}) => {
  const output = await primeTouchTerminal(page, linkedDaemon.daemonName);
  await page.setViewportSize({ width: 360, height: 600 });
  await expect
    .poll(() => page.locator('#terminal').evaluate((element) => element.clientHeight))
    .toBe(600);
  await insertTouchCommand(page, "printf 'touch-viewport-resize-ok\\n'\n");
  await expectOutput(output, 'touch-viewport-resize-ok');
});

test('touch viewport 3: reconnect replaces a stale desktop-sized canvas immediately', async ({
  page,
  linkedDaemon,
}) => {
  await page.setViewportSize({ width: 1200, height: 720 });
  await connectTerminal(page, linkedDaemon.daemonName);
  await page.getByRole('button', { name: 'Back to machines' }).click();
  await expectShellPhase(page);

  // The daemon keeps its PTY and therefore reconnects with the preceding wide
  // snapshot. The mobile viewport still owns the browser surface dimensions.
  await page.setViewportSize({ width: 390, height: 720 });
  await connectTerminal(page, linkedDaemon.daemonName);

  await expect
    .poll(() =>
      page.locator('#terminal-output').evaluate((container) => {
        const canvas = container.querySelector('canvas');
        if (!(canvas instanceof HTMLCanvasElement)) return false;
        return canvas.getBoundingClientRect().width <= container.getBoundingClientRect().width + 1;
      }),
    )
    .toBe(true);
});

test('touch viewport 4: keyboard toggle restores focus and toolbar state', async ({
  page,
  linkedDaemon,
}) => {
  await primeTouchTerminal(page, linkedDaemon.daemonName);
  const toggle = page.getByRole('button', { name: /keyboard/i });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-terminal-key-toolbar]')).toHaveCount(0);
  expect(await terminalTouchInputActive(page)).toBe(false);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-terminal-key-toolbar]')).toBeVisible();
  await expect.poll(() => terminalTouchInputActive(page)).toBe(true);
});

async function insertTouchCommand(page: Page, command: string): Promise<void> {
  const text = command.endsWith('\n') ? command.slice(0, -1) : command;
  await insertTouchText(page, text);
  await sendTouchEnter(page);
}

async function dispatchComposition(page: Page, value: string): Promise<void> {
  await page.evaluate((text) => {
    const surface = document.querySelector('textarea[data-terminal-hidden-input]');
    if (!(surface instanceof HTMLTextAreaElement)) throw new Error('editing surface missing');
    surface.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    surface.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: text }));
    surface.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
    surface.value = ` ${text}`;
    surface.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  }, value);
}

async function dispatchSoftDelete(page: Page, withBeforeInput: boolean): Promise<void> {
  await page.evaluate((includeBeforeInput) => {
    const surface = document.querySelector('textarea[data-terminal-hidden-input]');
    if (!(surface instanceof HTMLTextAreaElement)) throw new Error('editing surface missing');
    surface.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Backspace' }),
    );
    if (includeBeforeInput) {
      surface.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'deleteContentBackward',
        }),
      );
    }
    surface.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Backspace' }));
  }, withBeforeInput);
}

async function dispatchWindowKey(page: Page, key: string): Promise<void> {
  await page.evaluate((value) => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value, code: value }),
    );
  }, key);
}

async function prepareRawByteCapture(page: Page, byteCount: number, marker: string): Promise<void> {
  await insertTouchCommand(
    page,
    `stty raw -echo; bytes=$(dd bs=1 count=${byteCount} 2>/dev/null | od -An -tx1 | tr -d ' \\n'); stty sane; printf '${marker}-%s\\n' "$bytes"\n`,
  );
  await page.waitForTimeout(150);
}

async function swipeToolbarLeft(page: Page): Promise<void> {
  const box = await page.locator('[data-terminal-key-toolbar]').boundingBox();
  if (box === null) throw new Error('toolbar has no bounding box');
  const client = await page.context().newCDPSession(page);
  const y = box.y + box.height / 2;
  const startX = box.x + box.width - 20;
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: startX, y }],
  });
  for (const distance of [40, 80, 120, 160, 200]) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: startX - distance, y }],
    });
    await page.waitForTimeout(16);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

interface ViewportAnimationResult {
  readonly initial: number;
  readonly final: number;
  readonly intermediateHeights: readonly number[];
  readonly committedHeights: readonly number[];
  readonly renderedFinal: number;
}

async function simulateKeyboardViewportAnimation(page: Page): Promise<ViewportAnimationResult> {
  return page.evaluate(async () => {
    const viewport = window.visualViewport;
    const panel = document.querySelector<HTMLElement>('#terminal');
    const surface = document.querySelector('textarea[data-terminal-hidden-input]');
    if (viewport === null || panel === null) throw new Error('visual viewport or terminal missing');
    if (!(surface instanceof HTMLTextAreaElement)) throw new Error('editing surface missing');
    // The native keyboard rises for the focused editing surface, and only then
    // does the visual viewport size the shell (without it, `h-app` does).
    surface.focus({ preventScroll: true });
    const initial = Math.round(viewport.height);
    const final = initial - 240;
    const committedHeights: number[] = [];
    const observer = new MutationObserver(() => {
      const height = Number.parseFloat(panel.style.height);
      if (height !== initial) committedHeights.push(height);
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['style'] });
    const intermediateHeights: number[] = [];
    for (const height of [initial - 40, initial - 90, initial - 150, initial - 210]) {
      Object.defineProperty(viewport, 'height', { configurable: true, value: height });
      viewport.dispatchEvent(new Event('resize'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      intermediateHeights.push(Number.parseFloat(panel.style.height));
    }
    Object.defineProperty(viewport, 'height', { configurable: true, value: final });
    viewport.dispatchEvent(new Event('resize'));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
    );
    observer.disconnect();
    return {
      initial,
      final,
      intermediateHeights,
      committedHeights,
      renderedFinal: Number.parseFloat(panel.style.height),
    };
  });
}
