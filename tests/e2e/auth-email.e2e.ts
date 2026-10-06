import { randomInt } from 'node:crypto';
import type { Page } from '@playwright/test';

import { expectLoggedIn, expectLoggedOut, logout } from './fixtures/account';
import { expect, test } from './fixtures/test';

const PASSWORD = 'Password123!';

interface CapturedMail {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
}

function mailPort(): number {
  const port = Number(process.env.PW_E2E_MAIL_PORT);
  if (!Number.isInteger(port)) throw new Error('PW_E2E_MAIL_PORT is set by the email config');
  return port;
}

async function mailTo(address: string): Promise<CapturedMail[]> {
  const response = await fetch(`http://127.0.0.1:${mailPort()}/captured`);
  const captured = (await response.json()) as CapturedMail[];
  return captured.filter((mail) => mail.to.includes(address));
}

/** The two mailed-code steps: the subject their code arrives under, and the form that takes it. */
const CODE_STEP = {
  signUp: {
    subject: /^(\d{6}) is your Merkur code$/,
    form: '#auth-code-form',
    submit: 'Create account',
  },
  reset: {
    subject: /^(\d{6}) is your Merkur password reset code$/,
    form: '#auth-reset-code-form',
    submit: 'Continue',
  },
} as const;
type CodeStep = keyof typeof CODE_STEP;

async function latestCode(address: string, step: CodeStep = 'signUp'): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(async () => {
      const last = (await mailTo(address)).at(-1);
      code = last?.subject.match(CODE_STEP[step].subject)?.[1];
      return code;
    })
    .toMatch(/^\d{6}$/);
  if (code === undefined) throw new Error(`no ${step} code was mailed to ${address}`);
  return code;
}

async function forgotPassword(page: Page, address: string): Promise<void> {
  const form = page.locator('#auth-form');
  await form.getByLabel('Email').fill(address);
  await form.getByRole('button', { name: 'Forgot password?', exact: true }).click();
  await expect(page.locator(CODE_STEP.reset.form)).toContainText(address);
}

function uniqueAddress(): string {
  return `e2e-${Date.now()}-${randomInt(1_000_000)}@example.test`;
}

async function submitCredentials(page: Page, address: string, password: string): Promise<void> {
  const form = page.locator('#auth-form');
  await form.getByLabel('Email').fill(address);
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
}

async function submitCode(page: Page, code: string, step: CodeStep = 'signUp'): Promise<void> {
  const form = page.locator(CODE_STEP[step].form);
  await form.getByLabel('Code').fill(code);
  await form.getByRole('button', { name: CODE_STEP[step].submit, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  // Sign-up and code mail are capped per source address; each scenario gets its own.
  await page
    .context()
    .setExtraHTTPHeaders({ 'x-forwarded-for': `198.18.${randomInt(256)}.${1 + randomInt(254)}` });
});

test('a new address becomes an account only with the code mailed to it', async ({ page }) => {
  const address = uniqueAddress();
  await page.goto('/');
  await expectLoggedOut(page);
  await expect(page.locator('#auth-form').getByLabel('Email')).toHaveAttribute('type', 'email');

  // Typed in capitals: the form repeats what was typed, the mail goes to the
  // one spelling the server stores.
  await submitCredentials(page, address.toUpperCase(), PASSWORD);

  const codeForm = page.locator('#auth-code-form');
  await expect(codeForm).toContainText(address.toUpperCase());
  const code = await latestCode(address);

  await submitCode(page, code === '000000' ? '000001' : '000000');
  await expect(page.locator('#auth-feedback')).toHaveText(
    'That code is not right. Check the latest email, then try again.',
  );
  await expect(codeForm).toBeVisible();

  await submitCode(page, code);
  await expectLoggedIn(page);

  // The account exists now: signing in again sends no mail and asks for no code.
  const sent = (await mailTo(address)).length;
  await logout(page);
  await submitCredentials(page, address, PASSWORD);
  await expectLoggedIn(page);
  expect(await mailTo(address)).toHaveLength(sent);
});

test('a wrong password on an existing address mails a notice, never a code', async ({ page }) => {
  const address = uniqueAddress();
  await page.goto('/');
  await expectLoggedOut(page);
  await submitCredentials(page, address, PASSWORD);
  await submitCode(page, await latestCode(address));
  await expectLoggedIn(page);
  await logout(page);

  await submitCredentials(page, address, 'Not the password 1!');

  // The form answers exactly as it does for a new address.
  const codeForm = page.locator('#auth-code-form');
  await expect(codeForm).toContainText(address);
  await expect
    .poll(async () => (await mailTo(address)).at(-1)?.subject)
    .toBe('Your Merkur sign-in did not match');
  await submitCode(page, '123456');
  await expect(page.locator('#auth-feedback')).toHaveText(
    'That code is not right. Check the latest email, then try again.',
  );

  await codeForm.getByRole('button', { name: 'Use a different email', exact: true }).click();
  await expect(page.locator('#auth-form').getByLabel('Email')).toBeVisible();
});

test('a forgotten password is reset with a mailed code; only the new one signs in', async ({
  page,
  browser,
}) => {
  const address = uniqueAddress();
  const newPassword = 'A second Password123!';
  await page.goto('/');
  await expectLoggedOut(page);
  await submitCredentials(page, address, PASSWORD);
  await submitCode(page, await latestCode(address));
  await expectLoggedIn(page);

  // A second profile of the same account, left signed in.
  const otherContext = await browser.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': `198.18.${randomInt(256)}.${1 + randomInt(254)}` },
  });
  const other = await otherContext.newPage();
  await other.goto('/');
  await expectLoggedOut(other);
  await submitCredentials(other, address, PASSWORD);
  await expectLoggedIn(other);

  await logout(page);
  await forgotPassword(page, address);
  const code = await latestCode(address, 'reset');

  await submitCode(page, code === '000000' ? '000001' : '000000', 'reset');
  await expect(page.locator('#auth-feedback')).toHaveText(
    'That code is not right. Check the latest email, then try again.',
  );
  await submitCode(page, code, 'reset');

  // What the reset destroys is named before the new password is asked for.
  const confirm = page.locator('#auth-reset-confirm-form');
  await expect(confirm).toContainText(address);
  await expect(confirm).toContainText('Every browser is signed out.');
  await expect(confirm.locator('#auth-reset-machines')).toHaveText(
    'No machines are linked to this account.',
  );
  // Nothing has happened yet: the other profile is still signed in.
  await expectLoggedIn(other);

  await confirm.getByLabel('New password').fill(newPassword);
  await confirm.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expectLoggedIn(page);
  await expect
    .poll(async () => (await mailTo(address)).at(-1)?.subject)
    .toBe('Your Merkur password was reset');

  // The reset signed the other profile out.
  await expectLoggedOut(other);
  await otherContext.close();

  // The old password is now a wrong password, answered as any wrong one is.
  await logout(page);
  await submitCredentials(page, address, PASSWORD);
  await expect
    .poll(async () => (await mailTo(address)).at(-1)?.subject)
    .toBe('Your Merkur sign-in did not match');
  await page
    .locator('#auth-code-form')
    .getByRole('button', { name: 'Use a different email', exact: true })
    .click();
  await submitCredentials(page, address, newPassword);
  await expectLoggedIn(page);
});

test('the reset form answers an address with no account exactly as one with', async ({ page }) => {
  const address = uniqueAddress();
  await page.goto('/');
  await expectLoggedOut(page);

  await forgotPassword(page, address);

  // The same card and the same sentence; the mailbox gets a notice, no code.
  await expect
    .poll(async () => (await mailTo(address)).at(-1)?.subject)
    .toBe('Your Merkur password reset');
  await submitCode(page, '123456', 'reset');
  await expect(page.locator('#auth-feedback')).toHaveText(
    'That code is not right. Check the latest email, then try again.',
  );
  await page
    .locator(CODE_STEP.reset.form)
    .getByRole('button', { name: 'Back to sign in', exact: true })
    .click();
  await expect(page.locator('#auth-form').getByLabel('Email')).toBeVisible();
});
