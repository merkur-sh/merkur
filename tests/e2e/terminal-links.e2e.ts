import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';

// Targets under `.invalid` never resolve, so every popup is answered by the
// route below and no test depends on the network.
const LINK_ORIGIN = 'https://links.e2e.invalid';

async function connectTerminal(
  page: import('@playwright/test').Page,
  daemonName: string,
): Promise<void> {
  await page.getByTitle(`Connect to ${daemonName}`).click();
  await expectConnected(page, 20_000);
  await page
    .context()
    .route(`${LINK_ORIGIN}/**`, (route) => route.fulfill({ status: 200, body: 'link target' }));
}

async function expectOutput(
  output: import('@playwright/test').Locator,
  marker: string,
): Promise<void> {
  await expect
    .poll(async () => (await output.textContent()) ?? '', { timeout: 10_000 })
    .toContain(marker);
}

test('Ctrl-hover shows an OSC 8 target and Ctrl-click opens it; plain URLs open too', async ({
  page,
  linkedDaemon,
}) => {
  await connectTerminal(page, linkedDaemon.daemonName);
  const output = page.getByRole('log', { name: 'Terminal output' });

  // Markers are assembled by printf so the echoed command line never matches.
  // Clear, then print at the home cell: an OSC 8 link whose text is not its
  // target, one space, and a plain URL.
  await page.keyboard.type(
    `printf '\\033[2J\\033[H\\033]8;;${LINK_ORIGIN}/osc8-target\\033\\\\osc8-link\\033]8;;\\033\\\\ ${LINK_ORIGIN}/plain-target\\n'; printf 'links-%s\\n' printed\n`,
  );
  await expectOutput(output, 'links-printed');

  const hover = page.locator('[data-terminal-link-hover]');
  const grid = hover.locator('..');
  const origin = await grid.boundingBox();
  expect(origin).not.toBeNull();
  if (origin === null) return;

  // Row 0, column 0 is inside the OSC 8 link.
  await page.mouse.move(origin.x + 2, origin.y + 4);
  await page.keyboard.down('Control');
  await page.mouse.move(origin.x + 3, origin.y + 4);
  const label = page.locator('[data-terminal-link-target]');
  await expect(label).toHaveText(`${LINK_ORIGIN}/osc8-target`);

  // The underline spans the nine cells of `osc8-link`, which gives the cell width.
  const underline = hover.locator('div').first();
  const underlineBox = await underline.boundingBox();
  expect(underlineBox).not.toBeNull();
  if (underlineBox === null) return;
  const cellWidth = underlineBox.width / 'osc8-link'.length;

  const osc8Popup = page.context().waitForEvent('page');
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(async () => (await osc8Popup).url()).toBe(`${LINK_ORIGIN}/osc8-target`);

  // Column 12 is inside the plain URL, which starts at column 10.
  const plainX = origin.x + cellWidth * 12 + 1;
  await page.mouse.move(plainX, origin.y + 4);
  await expect(label).toHaveText(`${LINK_ORIGIN}/plain-target`);
  const plainPopup = page.context().waitForEvent('page');
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(async () => (await plainPopup).url()).toBe(`${LINK_ORIGIN}/plain-target`);

  // Releasing the modifier takes the link away.
  await page.keyboard.up('Control');
  await expect(label).toHaveCount(0);
});

test('a link redrawn away stops opening where it was', async ({ page, linkedDaemon }) => {
  await connectTerminal(page, linkedDaemon.daemonName);
  const output = page.getByRole('log', { name: 'Terminal output' });
  const popups: import('@playwright/test').Page[] = [];
  page.context().on('page', (popup) => popups.push(popup));

  await page.keyboard.type(
    `printf '\\033[2J\\033[H\\033]8;;${LINK_ORIGIN}/gone\\033\\\\gone-link\\033]8;;\\033\\\\\\n'; printf 'link-%s\\n' printed\n`,
  );
  await expectOutput(output, 'link-printed');

  const hover = page.locator('[data-terminal-link-hover]');
  const origin = await hover.locator('..').boundingBox();
  expect(origin).not.toBeNull();
  if (origin === null) return;
  const label = page.locator('[data-terminal-link-target]');

  // The first read of the grid, taken while the link is on screen.
  await page.mouse.move(origin.x + 2, origin.y + 4);
  await page.keyboard.down('Control');
  await page.mouse.move(origin.x + 3, origin.y + 4);
  await expect(label).toHaveText(`${LINK_ORIGIN}/gone`);
  await page.keyboard.up('Control');
  await expect(label).toHaveCount(0);

  // The same cells redrawn with plain text, as a tmux window switch does.
  await page.keyboard.type(`printf '\\033[2J\\033[Hplain-text\\n'; printf 'redraw-%s\\n' done\n`);
  await expectOutput(output, 'redraw-done');

  // Before the grid's change retired the first read, the modifier alone put
  // the old target back up and a click opened it.
  await page.keyboard.down('Control');
  await page.mouse.move(origin.x + 2, origin.y + 4);
  await expect(label).toHaveCount(0);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Control');
  expect(popups).toHaveLength(0);
});

test('a URL the terminal wrapped opens whole; a program-made row break ends it', async ({
  page,
  linkedDaemon,
}) => {
  await connectTerminal(page, linkedDaemon.daemonName);
  const output = page.getByRole('log', { name: 'Terminal output' });

  // Rows 0-1: written exactly to the margin and continued on an indented row, as
  // a TUI's own word wrap leaves it. No wrap bit joins them, and nothing else
  // in the grid tells that break from a URL ending at the margin, so the link
  // ends with row 0. Rows 3-4: eight cells past the margin, wrapped by the
  // terminal, so one link. Rows 6-8: an OSC 8 link reopened on every row, the
  // bytes Claude Code writes for its sign-in URL, so one link to the full target.
  // A script keeps the URLs out of the echoed command line.
  const programUrl = `${LINK_ORIGIN}/program-${'p'.repeat(400)}`;
  const terminalUrl = `${LINK_ORIGIN}/terminal-${'t'.repeat(400)}`;
  const osc8Base = `${LINK_ORIGIN}/osc8-rows-${'o'.repeat(1200)}`;
  const script = join(await mkdtemp(join(tmpdir(), 'merkur-links-')), 'print.sh');
  await writeFile(
    script,
    [
      'c=$(tput cols); l=$(tput lines)',
      "printf '\\033[2J\\033[H'",
      `printf '%s\\n' '${programUrl}' | cut -c "1-$c"`,
      "printf '  program-tail\\n'",
      "printf '\\n'",
      `printf '%s\\n' '${terminalUrl}' | cut -c "1-$((c + 8))"`,
      "printf '\\n'",
      `u=$(printf '%s' '${osc8Base}' | cut -c "1-$((2 * c + 20))")`,
      'for part in "1-$c" "$((c + 1))-$((2 * c))" "$((2 * c + 1))-"; do',
      `  printf '\\033]8;id=signin;%s\\a%s\\033]8;;\\a\\n' "$u" "$(printf '%s' "$u" | cut -c "$part")"`,
      'done',
      'printf \'grid-%s-%s\\n\' "$c" "$l"',
      '',
    ].join('\n'),
  );
  await page.keyboard.type(`sh ${script}\n`);
  await expect
    .poll(async () => /grid-(\d+)-(\d+)/.exec((await output.textContent()) ?? ''), {
      timeout: 10_000,
    })
    .not.toBeNull();
  const grid = /grid-(\d+)-(\d+)/.exec((await output.textContent()) ?? '');
  const origin = await page.locator('[data-terminal-link-hover]').locator('..').boundingBox();
  expect(grid).not.toBeNull();
  expect(origin).not.toBeNull();
  if (grid === null || origin === null) return;
  const cols = Number(grid[1]);
  const cellWidth = origin.width / cols;
  const cellHeight = origin.height / Number(grid[2]);
  const cell = (row: number, col: number) => ({
    x: origin.x + (col + 0.5) * cellWidth,
    y: origin.y + (row + 0.5) * cellHeight,
  });
  const label = page.locator('[data-terminal-link-target]');

  const programTarget = programUrl.slice(0, cols);
  await page.mouse.move(cell(0, 4).x, cell(0, 4).y);
  await page.keyboard.down('Control');
  await page.mouse.move(cell(0, 5).x, cell(0, 5).y);
  await expect(label).toHaveText(programTarget);
  await expect(page.locator('[data-terminal-link-hover] > div')).toHaveCount(2);
  await page.mouse.move(cell(1, 6).x, cell(1, 6).y);
  await expect(label).toHaveCount(0);

  const osc8Target = osc8Base.slice(0, 2 * cols + 20);
  await page.mouse.move(cell(8, 5).x, cell(8, 5).y);
  await expect(label).toHaveText(osc8Target);
  await page.mouse.move(cell(6, 5).x, cell(6, 5).y);
  await expect(label).toHaveText(osc8Target);
  await expect(page.locator('[data-terminal-link-hover] > div')).toHaveCount(4);

  const terminalTarget = terminalUrl.slice(0, cols + 8);
  await page.mouse.move(cell(4, 3).x, cell(4, 3).y);
  await expect(label).toHaveText(terminalTarget);
  await expect(page.locator('[data-terminal-link-hover] > div')).toHaveCount(3);
  const popup = page.context().waitForEvent('page');
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(async () => (await popup).url()).toBe(terminalTarget);
  await page.keyboard.up('Control');
});

test('a program opens a URL at once right after a key press', async ({ page, linkedDaemon }) => {
  await connectTerminal(page, linkedDaemon.daemonName);
  const output = page.getByRole('log', { name: 'Terminal output' });
  const popups: import('@playwright/test').Page[] = [];
  page.context().on('page', (popup) => popups.push(popup));
  const openedUrls = (): string[] => popups.map((popup) => popup.url());

  // The Enter that runs the command is the user activation the request opens
  // with, so no click is asked for.
  await page.keyboard.type(`"$BROWSER" ${LINK_ORIGIN}/browser; printf 'browser-%s\\n' ran\n`);
  await expectOutput(output, 'browser-ran');
  await expect.poll(openedUrls, { timeout: 15_000 }).toEqual([`${LINK_ORIGIN}/browser`]);

  // A CLI that runs the platform opener directly instead of reading $BROWSER.
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  await page.keyboard.type(`${opener} ${LINK_ORIGIN}/opener; printf 'opener-%s\\n' ran\n`);
  await expectOutput(output, 'opener-ran');
  await expect
    .poll(openedUrls, { timeout: 15_000 })
    .toEqual([`${LINK_ORIGIN}/browser`, `${LINK_ORIGIN}/opener`]);

  // Output cannot forge a request: no token, no tab and no toast.
  await page.keyboard.type(
    `printf '\\033]7780;merkur=forged;${LINK_ORIGIN}/forged\\007'; printf 'forged-%s\\n' printed\n`,
  );
  await expectOutput(output, 'forged-printed');
  await expect(page.locator('[data-open-url-toast]')).toHaveCount(0);
  expect(openedUrls()).toHaveLength(2);
});

/** Count the app's `open_url_request` logs, and whether each opened a tab. */
function watchOpenRequests(page: import('@playwright/test').Page): {
  readonly opened: boolean[];
  settle(count: number): Promise<void>;
} {
  const opened: boolean[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (text.includes('open_url_request')) opened.push(text.includes('opened: true'));
  });
  return {
    opened,
    async settle(count) {
      while (opened.length < count) await page.waitForEvent('console', { timeout: 30_000 });
    },
  };
}

// Playwright runs every page read and locator check as a user gesture, which is
// exactly the activation that lets a tab open. The two tests below therefore do
// not read the page while requests are arriving, and watch the app's console.

test('a URL requested while nobody is interacting waits behind a click', async ({
  page,
  linkedDaemon,
}) => {
  await connectTerminal(page, linkedDaemon.daemonName);
  const popups: import('@playwright/test').Page[] = [];
  page.context().on('page', (popup) => popups.push(popup));
  const openedUrls = (): string[] => popups.map((popup) => popup.url());
  const target = (name: string): string => `${LINK_ORIGIN}/${name}`;
  const requests = watchOpenRequests(page);

  // The browsers end the activation of a key press after 5 s, so requests made
  // 6 s after Enter find none. A repeated URL waits once.
  await page.keyboard.type(
    `sleep 6; for t in second second third; do "$BROWSER" ${LINK_ORIGIN}/$t; done\n`,
  );
  await requests.settle(3);
  expect(requests.opened).toEqual([false, false, false]);

  const toast = page.locator('[data-open-url-toast]');
  await expect(toast).toContainText(target('second'));
  await expect(toast).toContainText('1 more waiting');
  expect(openedUrls()).toEqual([]);
  await toast.getByRole('button', { name: 'Open' }).click();
  await expect.poll(openedUrls).toEqual([target('second')]);
  await expect(toast).toContainText(target('third'));
  await expect(toast).not.toContainText('more waiting');
  await toast.getByRole('button', { name: 'Dismiss' }).click();
  await expect(toast).toHaveCount(0);
  expect(openedUrls()).toEqual([target('second')]);
});

test('a URL requested while the page reloads reaches the reloaded page', async ({
  page,
  linkedDaemon,
}) => {
  await connectTerminal(page, linkedDaemon.daemonName);
  const output = page.getByRole('log', { name: 'Terminal output' });
  const popups: import('@playwright/test').Page[] = [];
  page.context().on('page', (popup) => popups.push(popup));
  const target = `${LINK_ORIGIN}/reloaded`;

  // The request leaves while the machine is reconnecting and the daemon still
  // counts the old page as a peer. Only an acknowledgement retires a request,
  // so the reloaded page is offered it. Whether it then opens or waits depends
  // on the activation the reload itself carries, which is not under test.
  const trigger = join(await mkdtemp(join(tmpdir(), 'merkur-links-')), 'go');
  await page.keyboard.type(`until [ -e ${trigger} ]; do sleep 0.1; done; "$BROWSER" ${target}\n`);
  await expectOutput(output, 'until [');
  const requests = watchOpenRequests(page);
  await page.reload();
  await writeFile(trigger, '');
  await requests.settle(1);
  if (requests.opened[0] === true) {
    await expect.poll(() => popups.map((popup) => popup.url())).toEqual([target]);
  } else {
    await expect(page.locator('[data-open-url-toast]')).toContainText(target);
  }
});
