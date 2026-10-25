import type { Locator, Page } from '@playwright/test';
import { expectDeviceListLive } from '../app-state';
import { expect } from './test';

/** Profiling needs account consent before any terminal workers are created. */
export async function acceptTelemetryConsent(page: Page): Promise<void> {
  const notice = page.getByRole('dialog', { name: 'Share performance reports?' });
  await notice.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(notice).toHaveCount(0);
}

export async function openAccountSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  const reporting = page.getByRole('switch', { name: 'Performance reporting', exact: true });
  await expect(reporting).toBeVisible();
  await expect(reporting).not.toHaveAttribute('aria-busy', 'true');
  return reporting;
}

/**
 * Saves through Settings and returns to the list, including when restoring from a terminal.
 *
 * Navigates inside the app rather than reloading: a reload from a terminal reopens the
 * machine it was showing, which is not the list this needs.
 */
export async function setPerformanceReporting(page: Page, enabled: boolean): Promise<void> {
  const body = page.locator('body');
  // A page the app has not been loaded into yet carries no phase at all.
  if (page.url() === 'about:blank') await page.goto('/');
  await expect(body).toHaveAttribute('data-phase', 'shell');
  if ((await body.getAttribute('data-route')) === 'terminal') {
    await page
      .locator('#terminal')
      .getByRole('button', { name: 'Back to machines', exact: true })
      .click();
  }
  await expect(body).toHaveAttribute('data-route', 'devices');
  // The first live list frame follows the stream's account consent statement.
  await expectDeviceListLive(page);
  await expect(body).not.toHaveAttribute('data-telemetry-consent', 'unknown');
  const reporting = await openAccountSettings(page);
  if ((await reporting.getAttribute('aria-checked')) !== String(enabled)) {
    await reporting.click();
  }
  await expect(reporting).not.toHaveAttribute('aria-busy', 'true');
  await expect(reporting).toHaveAttribute('aria-checked', String(enabled));
  await page.getByRole('button', { name: 'Back to machines', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-route', 'devices');
}
