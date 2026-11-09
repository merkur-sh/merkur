import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';
import { shellQuote, waitForMirrorBaseline, waitForTerminalLog } from './terminal-e2e-helpers';

test('the Shift selection layer follows output that arrives while it is up', async ({
  page,
  linkedDaemon,
}, testInfo) => {
  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  await expectConnected(page, 20_000);

  // The marker is assembled by printf so the echoed command line never matches,
  // and printed after the layer is up so only a refresh can bring it in.
  const trigger = testInfo.outputPath('selection-output.fifo');
  await promisify(execFile)('mkfifo', [trigger]);
  await waitForMirrorBaseline(page, 15_000);
  await page.keyboard.type(
    `printf 'selection-%s\\n' ready; read -r release < ${shellQuote(trigger)}; printf 'arrived-%s\\n' late\n`,
  );
  await waitForTerminalLog(page, 'selection-ready', 'line', 15_000);

  const layer = page.locator('.terminal-selection-layer');
  await page.keyboard.down('Shift');
  await expect(layer).toBeVisible();
  await expect(layer).not.toContainText('arrived-late');

  await writeFile(trigger, 'release\n');
  await expect(layer).toContainText('arrived-late', { timeout: 10_000 });
  await page.keyboard.up('Shift');
  await expect(layer).toBeHidden();
});
