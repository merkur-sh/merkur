import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';

async function connectTerminal(
  page: import('@playwright/test').Page,
  daemonName: string,
): Promise<void> {
  await page.getByTitle(`Connect to ${daemonName}`).click();
  await expectConnected(page, 20_000);
}

test('terminal command returns display data from a live daemon', async ({ page, linkedDaemon }) => {
  await connectTerminal(page, linkedDaemon.daemonName);

  const receivedBefore = await receivedBytes(page);
  await page.keyboard.type('echo hello-merkur\n');

  await expect
    .poll(() => receivedBytes(page), { timeout: 15_000 })
    .toBeGreaterThan(receivedBefore + 10);
});

test('the link strip plots terminal traffic while it crosses the wire', async ({
  page,
  linkedDaemon,
}) => {
  await connectTerminal(page, linkedDaemon.daemonName);

  // A burst scrolls off the strip within its visible columns, so the traffic
  // runs for as long as the poll may take to see it.
  await page.keyboard.type('for i in $(seq 1 150); do echo link-strip-$i; sleep 0.1; done\n');
  await expect.poll(() => linkStripTrafficPixels(page), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.keyboard.press('Control+c');
});

test('desktop typing, editing, unicode, and paste paths preserve exact terminal input', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  await connectTerminal(page, linkedDaemon.daemonName);
  const output = page.getByRole('log', { name: 'Terminal output' });

  // The first accessibility refresh establishes a silent baseline. Prime it so
  // every subsequent marker is an assertion on newly applied terminal output.
  await page.keyboard.type("printf 'typing-baseline\\n'\n");
  await page.waitForTimeout(750);
  await terminalPerf.reset();

  await page.keyboard.type("printf 'typing-printable-ok\\n'\n");
  await expectOutput(output, 'typing-printable-ok');

  await page.keyboard.type("printf 'typing-backspace-oX");
  await page.keyboard.press('Backspace');
  await page.keyboard.type("k\\n'\n");
  await expectOutput(output, 'typing-backspace-ok');

  await page.keyboard.type('printf typing-arrow-k');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('o');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type(";printf '\\n'\n");
  await expectOutput(output, 'typing-arrow-ok');

  await page.keyboard.type('this-command-must-be-cleared');
  await page.keyboard.press('Control+u');
  await page.keyboard.type("printf 'typing-control-ok\\n'\n");
  await expectOutput(output, 'typing-control-ok');

  await page.keyboard.insertText("printf 'typing-unicode-λ-ok\\n'\n");
  await expectOutput(output, 'typing-unicode-λ-ok');

  await dispatchPaste(page, "printf 'typing-paste-ok\\n'\n");
  await expectOutput(output, 'typing-paste-ok');

  // Cross PASTE_CHUNK several times. A missing or reordered input chunk leaves
  // the final command inside a comment and the marker never appears. Keep each
  // line below the PTY's canonical-line limit and suppress echo so this measures
  // input transport rather than a 40 KB display flood.
  await page.keyboard.type('stty -echo\n');
  await page.waitForTimeout(250);
  const commentLines = Array.from(
    { length: 104 },
    (_, index) => `#${'x'.repeat(380)}-${index}\n`,
  ).join('');
  await dispatchPaste(page, `${commentLines}stty echo\nprintf 'typing-chunked-paste-ok\\n'\n`);
  await expectOutput(output, 'typing-chunked-paste-ok', 20_000);

  const snapshot = await terminalPerf.snapshot();
  const disconnected = snapshot.events.filter(
    (event) => event.kind === 'transport_state' && event.state === 'disconnected',
  );
  expect(disconnected).toEqual([]);
  expect(snapshot.report.inputAckMs.count).toBeGreaterThan(20);
});

test('shift-drag selection copies terminal text through the browser clipboard', async ({
  page,
  linkedDaemon,
}) => {
  await connectTerminal(page, linkedDaemon.daemonName);
  const output = page.getByRole('log', { name: 'Terminal output' });

  const marker = 'copy-selection-ok-9271';
  await page.keyboard.type(`printf '${marker}\\n'\n`);
  await expectOutput(output, marker);

  // Shift is the gate. Without it there is no DOM text over the grid and the
  // browser has nothing to select — the canvas is opaque to selection.
  const layer = page.locator('.terminal-selection-layer');
  await expect(layer).toBeHidden();
  await page.keyboard.down('Shift');
  await expect(layer).toBeVisible();

  // Drag across the row the marker landed on. This is the browser's own
  // selection machinery acting on real text, not a Merkur gesture handler.
  const row = layer.locator('[data-row]').filter({ hasText: marker }).first();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  const midY = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, midY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, midY, { steps: 12 });
  await page.mouse.up();
  const selected = await page.evaluate(() => document.getSelection()?.toString() ?? '');
  expect(selected.trim()).toContain(marker);
  // The selection is what the drag crossed and nothing else. Shift+mousedown is
  // also the browser's "extend the current selection" gesture, so a drag that
  // keeps whatever base the browser was holding sweeps every row between there
  // and the pointer into the selection — and still contains the marker, which
  // is why the assertion above cannot see it. One row means no row break.
  expect(selected).not.toContain('\n');

  // Ctrl+Shift+C has no native binding, so it dispatches the same `copy` event
  // the native shortcuts do. The assertion is a real clipboard round trip: the
  // text has to survive out to the system clipboard and back through a paste.
  await page.keyboard.press('Control+Shift+C');
  await page.keyboard.up('Shift');

  await page.evaluate(() => {
    const sink = document.createElement('textarea');
    sink.id = 'e2e-clipboard-sink';
    document.body.appendChild(sink);
    sink.focus();
  });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
  await expect(page.locator('#e2e-clipboard-sink')).toHaveValue(new RegExp(marker));

  // Grid padding is not content: the copy stops at the last glyph even though
  // the drag ran to the end of the row.
  const pasted = await page.locator('#e2e-clipboard-sink').inputValue();
  expect(pasted).toBe(pasted.trimEnd());
});

test('a selection drag begun before the layer mounts still anchors under the pointer', async ({
  page,
  linkedDaemon,
}) => {
  await connectTerminal(page, linkedDaemon.daemonName);
  const output = page.getByRole('log', { name: 'Terminal output' });

  const marker = 'mid-drag-anchor-4416';
  await page.keyboard.type(`printf '${marker}\\n'\n`);
  await expectOutput(output, marker);

  // Geometry first: a row box can only be read while the layer is mounted.
  const layer = page.locator('.terminal-selection-layer');
  await page.keyboard.down('Shift');
  await expect(layer).toBeVisible();
  const box = await layer.locator('[data-row]').filter({ hasText: marker }).first().boundingBox();
  await page.keyboard.up('Shift');
  await expect(layer).toBeHidden();
  expect(box).not.toBeNull();
  if (box === null) return;
  const midY = box.y + box.height / 2;

  // Shift and the button together, which is how a hand that knows the gesture
  // actually performs it: the press lands inside the intent delay, so the
  // browser anchors the drag before this layer exists and the mount arrives
  // mid-gesture. Left alone the drag then extends from wherever the browser
  // parked that base — outside the layer, at one end of the viewport — and
  // swallows the screen on the way to the pointer.
  await page.mouse.move(box.x + 1, midY);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await expect(layer).toBeVisible();
  await page.mouse.move(box.x + box.width - 1, midY, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up('Shift');

  const selected = await page.evaluate(() => document.getSelection()?.toString() ?? '');
  expect(selected.trim()).toContain(marker);
  expect(selected).not.toContain('\n');
});

async function expectOutput(
  output: import('@playwright/test').Locator,
  marker: string,
  timeout = 10_000,
): Promise<void> {
  await expect.poll(() => output.textContent(), { timeout }).toContain(marker);
}

async function dispatchPaste(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.evaluate((payload) => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', payload);
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard }));
  }, text);
}

async function receivedBytes(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const title =
      document.querySelector<HTMLElement>(
        '[role="img"][title*="Traffic: sent above, received below."]',
      )?.title ?? '';
    const value = /received ([\d,]+) B/.exec(title)?.[1];
    return value === undefined ? 0 : Number(value.replaceAll(',', ''));
  });
}

/** Painted link-strip pixels off its baseline row: the traffic bars. */
async function linkStripTrafficPixels(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[role="img"][title*="Traffic: sent above, received below."] canvas',
    );
    const context = canvas?.getContext('2d');
    if (!canvas || !context || canvas.width === 0 || canvas.height === 0) return 0;
    const scale = canvas.height / canvas.getBoundingClientRect().height;
    const baselineTop = Math.floor(canvas.getBoundingClientRect().height / 2) * scale;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let painted = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      if (y >= baselineTop && y < baselineTop + scale) continue;
      for (let x = 0; x < canvas.width; x += 1) {
        if ((data[(y * canvas.width + x) * 4 + 3] ?? 0) > 0) painted += 1;
      }
    }
    return painted;
  });
}
