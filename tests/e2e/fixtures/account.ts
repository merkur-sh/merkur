import { randomInt } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expectAuthPhase, expectShellPhase } from '../app-state';
import { expect } from './test';

export async function expectLoggedOut(page: Page): Promise<void> {
  await expect(page.locator('#auth-screen')).toBeVisible();
  await expectAuthPhase(page);
}

export async function expectLoggedIn(page: Page): Promise<void> {
  await expectShellPhase(page);
}

/**
 * Creates the account from its own client address. The server trusts one proxy
 * hop under test (`start-server.ts`), and sign-up is capped per address per
 * hour, so a suite that registers every account from the shared 127.0.0.1
 * socket runs out of sign-ups after the fifth. The address is set on the
 * context, so every later request from that account's pages carries the same
 * identity; a scenario that pins its own address with `openAuthScreen` keeps
 * it, because page-level headers win over context-level ones.
 */
export async function createAccount(page: Page, username: string, password: string): Promise<void> {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': uniqueClientAddress() });
  await continueWithAccount(page, username, password);
}

/** An address in 198.18.0.0/15, the range reserved for benchmark traffic. */
function uniqueClientAddress(): string {
  return `198.${18 + randomInt(2)}.${randomInt(256)}.${1 + randomInt(254)}`;
}

export async function signIn(page: Page, username: string, password: string): Promise<void> {
  await continueWithAccount(page, username, password);
}

async function continueWithAccount(page: Page, username: string, password: string): Promise<void> {
  const form = page.locator('#auth-form');
  await form.getByLabel('Username').fill(username);
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
}

export async function openAuthScreen(
  page: Page,
  headers: Record<string, string> = {},
): Promise<void> {
  await page.setExtraHTTPHeaders(headers);
  await page.goto('/');
  await expectLoggedOut(page);
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Log Out' }).click();
  await expectLoggedOut(page);
}
