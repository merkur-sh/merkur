import { randomBytes } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

const origin = process.env.SERVER_ORIGIN;
const username = process.env.CANARY_USERNAME;
const password = process.env.CANARY_PASSWORD;
const daemonName = process.argv[2];
if (!origin || !username || !password || !daemonName)
  throw new Error('canary credentials and name required');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(origin);
  const form = page.locator('#auth-form');
  // The field is labelled Email or Username by the server's AUTH_IDENTITY;
  // its id is the same under both.
  await form.locator('#field-username').fill(username);
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'shell', { timeout: 30_000 });
  // An account that has not answered the performance-reporting question is
  // asked before it can reach a machine. The canary declines, once.
  const body = page.locator('body');
  await expect(body).toHaveAttribute('data-telemetry-consent', /^(unchosen|on|off)$/, {
    timeout: 30_000,
  });
  if ((await body.getAttribute('data-telemetry-consent')) === 'unchosen') {
    await page
      .getByRole('dialog', { name: 'Share performance reports?' })
      .getByRole('button', { name: "Don't share", exact: true })
      .click();
    await expect(body).toHaveAttribute('data-telemetry-consent', 'off');
  }
  await page.getByTitle(`Connect to ${daemonName}`, { exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-connection', 'connected', {
    timeout: 30_000,
  });
  // The expected value is not present in the typed command, so shell echo cannot pass.
  // Prime accessibility output before the command whose result we assert.
  await page.keyboard.type("printf 'release-canary-ready\\n'\n");
  const nonce = randomBytes(16).toString('hex');
  const left = nonce.slice(0, 16);
  const right = nonce.slice(16);
  await page.keyboard.type(`printf '%s%s\\n' '${left}' '${right}'\n`);
  await expect(page.getByRole('log', { name: 'Terminal output' })).toContainText(nonce, {
    timeout: 30_000,
  });
  process.stdout.write(`${daemonName}: authenticated terminal round trip passed\n`);
} finally {
  await browser.close();
}
