import type { Page } from '@playwright/test';

import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';
import type { TerminalPerfFixture } from './fixtures/test';
import {
  dispatchWindowPaste,
  exactValueCommand,
  expectOutput,
  primeTerminal,
} from './terminal-e2e-helpers';

interface TextCase {
  readonly name: string;
  readonly value: string;
  readonly method: 'type' | 'insertText';
}

const TEXT_CASES: readonly TextCase[] = [
  { name: 'lowercase letters', value: 'merkurterminal', method: 'type' },
  { name: 'uppercase letters', value: 'MERKURTERMINAL', method: 'type' },
  { name: 'digits', value: '01234567890123456789', method: 'type' },
  { name: 'word spacing', value: 'alpha beta  gamma', method: 'type' },
  { name: 'dash and underscore', value: 'dash-under_score--ok', method: 'type' },
  { name: 'sentence punctuation', value: 'period.comma,colon:semicolon;', method: 'type' },
  { name: 'slashes', value: 'slash/path\\backslash', method: 'type' },
  { name: 'paired delimiters', value: '[square]{brace}(paren)', method: 'type' },
  { name: 'math punctuation', value: 'plus+equals=percent%caret^', method: 'type' },
  { name: 'shell punctuation', value: 'at@hash#dollar$ampersand&', method: 'type' },
  { name: 'quotes', value: `single'and"double`, method: 'type' },
  { name: 'operators', value: 'question?bang!asterisk*pipe|', method: 'type' },
  { name: 'greek unicode', value: 'lambda-λ-omega-ω', method: 'insertText' },
  { name: 'accented unicode', value: 'café-naïve-jalapeño', method: 'insertText' },
  { name: 'CJK unicode', value: '東京-终端-서울', method: 'insertText' },
  { name: 'emoji unicode', value: 'terminal-🚀-keyboard-⌨', method: 'insertText' },
  { name: 'combining unicode', value: 'combine-e\u0301-a\u0308', method: 'insertText' },
  { name: 'non-ASCII punctuation', value: 'left←middle→end—done', method: 'insertText' },
  { name: '256 byte run', value: 'x'.repeat(256), method: 'type' },
  { name: '512 byte alternating run', value: 'ab'.repeat(256), method: 'insertText' },
];

for (const [index, inputCase] of TEXT_CASES.entries()) {
  test(`desktop text ${index + 1}: ${inputCase.name}`, async ({ page, linkedDaemon }) => {
    const output = await primeTerminal(page, linkedDaemon.daemonName);
    const marker = `desktop-text-${index + 1}-ok`;
    const command = exactValueCommand(inputCase.value, marker);
    if (inputCase.method === 'type') await page.keyboard.type(command);
    else await page.keyboard.insertText(command);
    await expectOutput(output, marker);
  });
}

type EditStep =
  | { readonly kind: 'type'; readonly value: string }
  | { readonly kind: 'press'; readonly value: string }
  | { readonly kind: 'wait'; readonly value: number };

interface EditingCase {
  readonly name: string;
  readonly marker: string;
  readonly steps: readonly EditStep[];
}

const EDITING_CASES: readonly EditingCase[] = [
  {
    name: 'single backspace',
    marker: 'edit-backspace-ok',
    steps: [type('echo edit-backspace-oX'), press('Backspace'), type('k'), press('Enter')],
  },
  {
    name: 'repeated backspace',
    marker: 'edit-backspaces-ok',
    steps: [
      type('echo edit-backspaces-okXX'),
      press('Backspace'),
      press('Backspace'),
      press('Enter'),
    ],
  },
  {
    name: 'forward delete',
    marker: 'edit-delete-ok',
    steps: [
      type('echo edit-delete-oXk'),
      press('ArrowLeft'),
      press('ArrowLeft'),
      press('Delete'),
      press('Enter'),
    ],
  },
  {
    name: 'left arrow insertion',
    marker: 'edit-left-ok',
    steps: [type('echo edit-left-k'), press('ArrowLeft'), type('o'), press('Enter')],
  },
  {
    name: 'right arrow restoration',
    marker: 'edit-right-ok',
    steps: [
      type('echo edit-right-o'),
      press('ArrowLeft'),
      press('ArrowRight'),
      type('k'),
      press('Enter'),
    ],
  },
  {
    name: 'multi-character cursor move',
    marker: 'edit-move-12345-ok',
    steps: [
      type('echo edit-move-1235-ok'),
      ...Array.from({ length: 4 }, () => press('ArrowLeft')),
      type('4'),
      press('Enter'),
    ],
  },
  {
    name: 'home key',
    marker: 'edit-home-ok',
    steps: [type(' edit-home-ok'), press('Home'), type('echo'), press('Enter')],
  },
  {
    name: 'end key',
    marker: 'edit-end-ok',
    steps: [type('echo edit-end-'), press('Home'), press('End'), type('ok'), press('Enter')],
  },
  {
    name: 'control-a line start',
    marker: 'edit-ctrl-a-ok',
    steps: [type(' edit-ctrl-a-ok'), press('Control+a'), type('echo'), press('Enter')],
  },
  {
    name: 'control-e line end',
    marker: 'edit-ctrl-e-ok',
    steps: [
      type('echo edit-ctrl-e-'),
      press('Control+a'),
      press('Control+e'),
      type('ok'),
      press('Enter'),
    ],
  },
  {
    name: 'control-u line clear',
    marker: 'edit-ctrl-u-ok',
    steps: [
      type('this-command-must-disappear'),
      press('Control+u'),
      type('echo edit-ctrl-u-ok'),
      press('Enter'),
    ],
  },
  {
    name: 'control-w word erase',
    marker: 'edit-ctrl-w-ok',
    steps: [type('echo unwanted'), press('Control+w'), type('edit-ctrl-w-ok'), press('Enter')],
  },
  {
    name: 'control-k suffix erase',
    marker: 'edit-ctrl-k-ok',
    steps: [
      type('unwanted suffix'),
      press('Control+a'),
      press('Control+k'),
      type('echo edit-ctrl-k-ok'),
      press('Enter'),
    ],
  },
  {
    name: 'control-l preserves line',
    marker: 'edit-ctrl-l-ok',
    steps: [type('echo edit-ctrl-l-ok'), press('Control+l'), press('Enter')],
  },
  {
    name: 'alt-b word navigation',
    marker: 'edit-alt-b-ok',
    steps: [
      type('echo edit-alt-b-ok trailing'),
      press('Alt+b'),
      press('Control+k'),
      press('Enter'),
    ],
  },
  {
    name: 'control-c interrupt recovery',
    marker: 'edit-ctrl-c-ok',
    steps: [
      type('sleep 10'),
      press('Enter'),
      wait(150),
      press('Control+c'),
      type('echo edit-ctrl-c-ok'),
      press('Enter'),
    ],
  },
];

for (const [index, editingCase] of EDITING_CASES.entries()) {
  test(`desktop editing ${index + 1}: ${editingCase.name}`, async ({ page, linkedDaemon }) => {
    const output = await primeTerminal(page, linkedDaemon.daemonName);
    await runEditSteps(page, editingCase.steps);
    await expectOutput(output, editingCase.marker);
  });
}

const PASTE_VALUE_CASES = [
  ['plain ASCII', 'paste-plain-value'],
  ['spaces', 'paste value with  multiple spaces'],
  ['shell punctuation', 'paste-$-#-!-&-|-value'],
  ['quotes', `paste-'single'-"double"`],
  ['unicode', 'paste-λ-東京-café'],
  ['emoji', 'paste-🚀-⌨-✅'],
] as const;

for (const [index, [name, value]] of PASTE_VALUE_CASES.entries()) {
  test(`desktop paste ${index + 1}: ${name}`, async ({ page, linkedDaemon }) => {
    const output = await primeTerminal(page, linkedDaemon.daemonName);
    const marker = `desktop-paste-${index + 1}-ok`;
    await dispatchWindowPaste(page, exactValueCommand(value, marker));
    await expectOutput(output, marker);
  });
}

test('desktop paste 7: multiline command order', async ({ page, linkedDaemon }) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await dispatchWindowPaste(
    page,
    'value=first\nvalue=$value-second\n[ "$value" = first-second ] && echo desktop-paste-7-ok\n',
  );
  await expectOutput(output, 'desktop-paste-7-ok');
});

test('desktop paste 8: CRLF line endings', async ({ page, linkedDaemon }) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await dispatchWindowPaste(page, 'echo desktop-paste-8-ok\r\n');
  await expectOutput(output, 'desktop-paste-8-ok');
});

test('desktop paste 9: tab command separator', async ({ page, linkedDaemon }) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await dispatchWindowPaste(page, "printf\t'desktop-paste-9-ok\\n'\n");
  await expectOutput(output, 'desktop-paste-9-ok');
});

test('desktop paste 10: typed prefix plus pasted suffix', async ({ page, linkedDaemon }) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await page.keyboard.type("printf '");
  await dispatchWindowPaste(page, "desktop-paste-10-ok\\n'\n");
  await expectOutput(output, 'desktop-paste-10-ok');
});

test('desktop paste 11: consecutive paste ordering', async ({ page, linkedDaemon }) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await dispatchWindowPaste(page, 'value=paste-order');
  await dispatchWindowPaste(
    page,
    '-preserved\n[ "$value" = paste-order-preserved ] && echo desktop-paste-11-ok\n',
  );
  await expectOutput(output, 'desktop-paste-11-ok');
});

test('desktop paste 12: 48 KB chunk ordering', async ({ page, linkedDaemon }) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await page.keyboard.type('stty -echo\n');
  const comments = Array.from(
    { length: 126 },
    (_, index) => `#${String(index).padStart(3, '0')}-${'x'.repeat(380)}\n`,
  ).join('');
  await dispatchWindowPaste(page, `${comments}stty echo\nprintf 'desktop-paste-12-ok\\n'\n`);
  await expectOutput(output, 'desktop-paste-12-ok', 25_000);
});

test('terminal interaction 1: input survives a narrow resize', async ({ page, linkedDaemon }) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.keyboard.type("printf 'interaction-resize-narrow-ok\\n'\n");
  await expectOutput(output, 'interaction-resize-narrow-ok');
});

test('terminal interaction 2: input survives a wide resize', async ({ page, linkedDaemon }) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.keyboard.type("printf 'interaction-resize-wide-ok\\n'\n");
  await expectOutput(output, 'interaction-resize-wide-ok');
});

test('terminal interaction 3: input survives a resize storm', async ({ page, linkedDaemon }) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  for (const size of [
    { width: 420, height: 700 },
    { width: 900, height: 500 },
    { width: 375, height: 667 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(size);
  }
  await page.keyboard.type("printf 'interaction-resize-storm-ok\\n'\n");
  await expectOutput(output, 'interaction-resize-storm-ok');
});

test('terminal interaction 4: terminal click restores input focus', async ({
  page,
  linkedDaemon,
}) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await page.locator('#terminal-output').click({ position: { x: 20, y: 20 } });
  await page.keyboard.type("printf 'interaction-refocus-ok\\n'\n");
  await expectOutput(output, 'interaction-refocus-ok');
});

test('terminal interaction 5: large output burst reaches its final frame', async ({
  page,
  linkedDaemon,
}) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await page.keyboard.type(
    "i=0; while [ $i -lt 300 ]; do printf 'burst-%s\\n' $i; i=$((i+1)); done; echo interaction-burst-ok\n",
  );
  await expectOutput(output, 'interaction-burst-ok', 25_000);
});

test('terminal interaction 6: rapid command batch preserves order', async ({
  page,
  linkedDaemon,
}) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  const commands = Array.from({ length: 30 }, (_, index) => `value=${index}\n`).join('');
  await dispatchWindowPaste(
    page,
    `${commands}[ "$value" = 29 ] && echo interaction-command-order-ok\n`,
  );
  await expectOutput(output, 'interaction-command-order-ok');
});

test('terminal interaction 7: back navigation permits a fresh terminal session', async ({
  page,
  linkedDaemon,
}) => {
  await primeTerminal(page, linkedDaemon.daemonName);
  await page.getByRole('button', { name: 'Back to machines' }).click();
  await expect(page.getByTitle(`Connect to ${linkedDaemon.daemonName}`)).toBeVisible();
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await page.keyboard.type("printf 'interaction-reconnect-ok\\n'\n");
  await expectOutput(output, 'interaction-reconnect-ok');
});

test('terminal interaction 8: idle terminal remains responsive', async ({ page, linkedDaemon }) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await page.waitForTimeout(1_000);
  await page.keyboard.type("printf 'interaction-idle-ok\\n'\n");
  await expectOutput(output, 'interaction-idle-ok');
});

test('terminal interaction 9: input acknowledgements remain bounded', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await terminalPerf.reset();
  await page.keyboard.type("printf 'interaction-latency-ok\\n'\n");
  await expectOutput(output, 'interaction-latency-ok');
  await expect
    .poll(async () => (await terminalPerf.snapshot()).report.inputAckMs.count)
    .toBeGreaterThan(10);
  const snapshot = await terminalPerf.snapshot();
  expect(snapshot.report.inputAckMs.p95).not.toBeNull();
  expect(snapshot.report.inputAckMs.p95 ?? Number.POSITIVE_INFINITY).toBeLessThan(2_500);
});

test('terminal interaction 10: input during background output stays connected', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await terminalPerf.reset();
  await page.keyboard.type(
    '(i=0; while [ $i -lt 150 ]; do echo pressure-$i; i=$((i+1)); done) &\n',
  );
  await page.keyboard.type("printf 'interaction-pressure-ok\\n'\n");
  await expectOutput(output, 'interaction-pressure-ok', 25_000);
  const snapshot = await terminalPerf.snapshot();
  expect(
    snapshot.events.filter(
      (event) => event.kind === 'transport_state' && event.state === 'disconnected',
    ),
  ).toEqual([]);
});

test('terminal interaction 11: history and completion remain authority-only', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await page.keyboard.type("printf 'authority-history-source\\n'\n");
  await expectOutput(output, 'authority-history-source');

  await pressAuthorityOnlyKey(page, terminalPerf, 'ArrowUp');
  await pressAuthorityOnlyKey(page, terminalPerf, 'ArrowDown');

  // Stage one unambiguous filesystem completion and isolate Tab in its own
  // logical presentation window. An ACK only proves delivery; the completed
  // token plus exact GPU-fenced window proves the remote editor transformed
  // the line and presented that authoritative result.
  const completionTarget = '/tmp/merkur-authority-completion-result-q7m4';
  const completionPrefix = completionTarget.slice(0, -1);
  const completionSetupMarker = 'authority-completion-setup-ok';
  await page.keyboard.type(
    `rm -f ${completionTarget}; : > ${completionTarget}; printf '${completionSetupMarker}\\n'\n`,
  );
  await expectOutput(output, completionSetupMarker);
  await terminalPerf.reset();
  await page.keyboard.type(`printf 'authority-completion-result:%s\\n' ${completionPrefix}`);
  // This drain freezes the typed prefix outside the Tab window without
  // changing the terminal line being edited.
  await terminalPerf.reset();
  const completionMeasurement = await terminalPerf.beginPresentationMeasurement('streaming');
  await page.keyboard.press('Tab');
  await terminalPerf.endPresentationMeasurement(completionMeasurement);
  const completionSnapshot = await terminalPerf.snapshot();
  const completionInputs = completionSnapshot.events.filter(
    (event) => event.kind === 'input_queued',
  );
  // Tab's press, a two-byte key record; its release awaits no output.
  expect(completionInputs.map((input) => input.byteLength)).toEqual([2]);
  expect(completionSnapshot.report.inputToCompletedAuthoritativePresentationFenceMs).toMatchObject({
    complete: true,
    count: 1,
    eligibleCount: 1,
    censoredCount: 0,
  });
  expect(completionSnapshot.report.presentation.measurementWindowCount).toBe(1);
  expect(
    completionSnapshot.report.presentation
      .measurementWindowToCompletedAuthoritativePresentationFenceMs.complete,
  ).toBe(true);
  expect(
    completionSnapshot.report.presentation
      .measurementWindowToCompletedAuthoritativePresentationFenceMs.count,
  ).toBe(1);
  expect(
    completionSnapshot.events.filter(
      (event) =>
        (event.kind === 'prediction_queued' || event.kind === 'prediction_applied') &&
        event.inputSeq === completionInputs[0]?.inputSeq,
    ),
    'Tab must cross the real transport without a speculative action',
  ).toEqual([]);
  await page.keyboard.type(`; rm -f ${completionTarget}`);
  await page.keyboard.press('Enter');
  await expectOutput(output, `authority-completion-result:${completionTarget}`);

  // Clear whatever the authenticated remote editor did, then prove the
  // authority-only keys left the terminal/session usable.
  await page.keyboard.press('Control+u');
  await page.keyboard.type("printf 'authority-only-keys-ok\\n'\n");
  await expectOutput(output, 'authority-only-keys-ok');
  await terminalPerf.snapshot();
});

// The terminal is the one route the command palette could not be opened from:
// its editing surface holds focus, and the keyboard layer read that as a field
// the user is typing into. Run it on both surface tiers, because only one of
// them is a `<textarea>` and only that one ever tripped the guard — Chromium
// takes the EditContext tier here, so a single-tier test would pass without
// the fix and guard nothing.
interface SurfaceTier {
  readonly name: string;
  readonly tagName: string;
  /** Boots the app again with `EditContext` unavailable. */
  readonly withoutEditContext: boolean;
}

const SURFACE_TIERS: readonly SurfaceTier[] = [
  { name: 'EditContext surface', tagName: 'DIV', withoutEditContext: false },
  { name: 'textarea surface', tagName: 'TEXTAREA', withoutEditContext: true },
];

for (const [index, tier] of SURFACE_TIERS.entries()) {
  test(`terminal interaction ${12 + index}: the palette opens over a live terminal (${tier.name})`, async ({
    page,
    linkedDaemon,
  }) => {
    if (tier.withoutEditContext) {
      await page.addInitScript(() => {
        Reflect.deleteProperty(globalThis, 'EditContext');
      });
      await page.goto('/');
    }
    const output = await primeTerminal(page, linkedDaemon.daemonName);

    // The tier is the point of the case, so read it rather than assume it.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName ?? null))
      .toBe(tier.tagName);

    // Held explicitly rather than a `Meta+k` press, which would send the left
    // ⌘ and prove nothing — only the right one is bound.
    await page.keyboard.down('MetaRight');
    await page.keyboard.press('k');
    await page.keyboard.up('MetaRight');
    const palette = page.getByRole('dialog');
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('combobox')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    // Dismissing hands the keys back to the shell rather than stranding focus.
    const marker = `interaction-palette-${index + 1}-ok`;
    await page.keyboard.type(`printf '${marker}\\n'\n`);
    await expectOutput(output, marker);
  });
}

// Selecting a machine from the palette *while a terminal is live* is the one
// connect path that never leaves the terminal route: the session is torn down
// and a new ring bundle published in the same tick, so nothing observes the
// gap between them. One machine proves it, because reconnecting to the same
// daemon takes the identical path a switch to a second one does — and the
// failure it guards was total: the previous machine's frame frozen on screen
// under "Restoring display", forever.
test('terminal interaction 14: selecting a machine from a live terminal reconnects', async ({
  page,
  linkedDaemon,
}) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);

  await page.keyboard.down('MetaRight');
  await page.keyboard.press('k');
  await page.keyboard.up('MetaRight');
  const palette = page.getByRole('dialog');
  await expect(palette).toBeVisible();
  await palette.getByRole('option', { name: `Connect to ${linkedDaemon.daemonName}` }).click();
  await expect(palette).toBeHidden();

  // `connected` is published from the terminal worker's own GPU fence, so it
  // is reached only by a worker that actually owns this session's rings.
  await expectConnected(page);

  const marker = 'interaction-reconnect-ok';
  await page.keyboard.type(`printf '${marker}\\n'\n`);
  await expectOutput(output, marker);
});

function type(value: string): EditStep {
  return { kind: 'type', value };
}

function press(value: string): EditStep {
  return { kind: 'press', value };
}

function wait(value: number): EditStep {
  return { kind: 'wait', value };
}

async function runEditSteps(page: Page, steps: readonly EditStep[]): Promise<void> {
  for (const step of steps) {
    if (step.kind === 'type') await page.keyboard.type(step.value);
    else if (step.kind === 'press') await page.keyboard.press(step.value);
    else await page.waitForTimeout(step.value);
  }
}

async function pressAuthorityOnlyKey(
  page: Page,
  terminalPerf: TerminalPerfFixture,
  key: 'ArrowUp' | 'ArrowDown' | 'Tab',
): Promise<void> {
  await terminalPerf.reset();
  await page.keyboard.press(key);
  await expect
    .poll(
      async () => {
        const snapshot = await terminalPerf.snapshot();
        const input = snapshot.events.findLast((event) => event.kind === 'input_queued');
        return (
          input !== undefined &&
          snapshot.events.some(
            (event) => event.kind === 'input_ack' && event.inputSeq >= input.inputSeq,
          )
        );
      },
      {
        timeout: 10_000,
        intervals: [10, 25, 50, 100],
        message: `${key} never reached authenticated input acknowledgement`,
      },
    )
    .toBe(true);

  const snapshot = await terminalPerf.snapshot();
  const inputs = snapshot.events.filter((event) => event.kind === 'input_queued');
  // The press, a two-byte key record the daemon encodes. Its release is sent
  // too but awaits no output, so it is not an input anyone waits on.
  expect(inputs.map((input) => input.byteLength)).toEqual([2]);
  const inputSeqs = new Set(inputs.map((input) => input.inputSeq));
  expect(
    snapshot.events.filter(
      (event) =>
        (event.kind === 'prediction_queued' || event.kind === 'prediction_applied') &&
        inputSeqs.has(event.inputSeq),
    ),
    `${key} must cross the real transport without a speculative action`,
  ).toEqual([]);
}

test('terminal interaction 15: a keystroke burst that recycles every send slot reaches the daemon intact', async ({
  page,
  linkedDaemon,
}) => {
  // Every keystroke goes out as one datagram from the provider's three-slot
  // rotation and one reliable record from its frame pool, and a slot or frame
  // is overwritten as soon as its own write has settled. Typing this many
  // distinct bytes with no inter-key delay reuses every slot several times
  // over while the daemon is still reading what each one carried; the exact
  // value check fails on any byte that was corrupted, dropped or duplicated
  // by a copy taken too late or a buffer reused too early.
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  const value = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const marker = 'interaction-send-slot-reuse-ok';
  await page.keyboard.type(exactValueCommand(value, marker), { delay: 0 });
  await expectOutput(output, marker);
});
