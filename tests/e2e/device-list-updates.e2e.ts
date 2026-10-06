import {
  deviceListAttempts,
  expectConnected,
  expectDeviceListLive,
  expectShellPhase,
} from './app-state';
import { expect, test } from './fixtures/daemon-process';

/**
 * Enough round trips that a state left behind by one of them is caught rather
 * than raced past. Each is a full session: issue, connect, tear down, reopen.
 */
const ROUNDS = 6;

/**
 * Returning from a terminal must leave the machine list live.
 *
 * The authenticated stream also carries browser presence, so it stays open
 * across terminal navigation. Rejoining it must neither restart the stream
 * nor leave the badge waiting for an opening frame it has already received.
 */
test('exiting a terminal restores live machine updates', async ({ page, linkedDaemon }) => {
  await expectDeviceListLive(page);
  const attempts = await deviceListAttempts(page);
  expect(attempts).toBeGreaterThan(0);

  for (let round = 0; round < ROUNDS; round += 1) {
    await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
    await expectConnected(page, 20_000);

    await page.getByRole('button', { name: 'Back to machines' }).click();
    await expectShellPhase(page);
    await expect(page.getByTitle(`Connect to ${linkedDaemon.daemonName}`)).toBeVisible();
    await expectDeviceListLive(page);
    expect(await deviceListAttempts(page)).toBe(attempts);
  }
});
