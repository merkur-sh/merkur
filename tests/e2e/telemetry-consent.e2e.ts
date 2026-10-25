import { expectDeviceListLive } from './app-state';
import {
  createAccountAwaitingTelemetryConsent,
  openAuthScreen,
  uniqueSuffix,
} from './fixtures/account';
import { openAccountSettings } from './fixtures/telemetry-consent';
import { expect, test } from './fixtures/test';

test('performance reporting waits for consent and remembers the account choice', async ({
  page,
}) => {
  const reports: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/telemetry/')) {
      reports.push(request.url());
    }
  });

  await openAuthScreen(page);
  await createAccountAwaitingTelemetryConsent(page, `consent-${uniqueSuffix()}`, 'Password123!');
  await expectDeviceListLive(page);
  const notice = page.getByRole('dialog', { name: 'Share performance reports?' });
  await expect(notice).toBeVisible();
  // Neither answer starts focused, so Enter accepts nothing.
  await expect(notice.getByRole('heading', { name: 'Share performance reports?' })).toBeFocused();
  // A required question: Escape and a press on the backdrop leave it open.
  await page.keyboard.press('Escape');
  await page.mouse.click(4, 4);
  await expect(notice).toBeVisible();
  expect(reports).toEqual([]);

  await notice.getByRole('button', { name: "Don't share", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expectDeviceListLive(page);
  await expect(notice).toHaveCount(0);
  const reporting = await openAccountSettings(page);
  await expect(reporting).toHaveAttribute('aria-checked', 'false');
  expect(reports).toEqual([]);

  await reporting.click();
  await expect(reporting).not.toHaveAttribute('aria-busy', 'true');
  await expect(reporting).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expectDeviceListLive(page);
  await expect(notice).toHaveCount(0);
  const restoredReporting = await openAccountSettings(page);
  await expect(restoredReporting).toHaveAttribute('aria-checked', 'true');
});
