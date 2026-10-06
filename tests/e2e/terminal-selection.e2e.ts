import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';

test('the Shift selection layer follows output that arrives while it is up', async ({
  page,
  linkedDaemon,
}) => {
  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  await expectConnected(page, 20_000);
  const output = page.getByRole('log', { name: 'Terminal output' });

  // The marker is assembled by printf so the echoed command line never matches,
  // and printed after the layer is up so only a refresh can bring it in.
  await page.keyboard.type(`sleep 2; printf 'arrived-%s\\n' late\n`);
  await expect.poll(async () => (await output.textContent()) ?? '').toContain('sleep 2');

  const layer = page.locator('.terminal-selection-layer');
  await page.keyboard.down('Shift');
  await expect(layer).toBeVisible();
  await expect(layer).not.toContainText('arrived-late');

  await expect(layer).toContainText('arrived-late', { timeout: 10_000 });
  await page.keyboard.up('Shift');
  await expect(layer).toBeHidden();
});
