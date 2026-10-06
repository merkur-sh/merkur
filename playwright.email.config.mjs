import { defineConfig } from '@playwright/test';

// The same hermetic server as `playwright.config.mjs`, started with
// AUTH_IDENTITY=email and a captured stand-in for Resend, for the specs that
// cover sign-up by verified address.
const port = Number(process.env.PW_E2E_PORT ?? 24_331);
const redisPort = Number(process.env.PW_E2E_REDIS_PORT ?? port + 1);
const mailPort = Number(process.env.PW_E2E_MAIL_PORT ?? port + 2);
const origin = `http://127.0.0.1:${port}`;
const dbPath =
  process.env.PW_E2E_DB_PATH ?? `${process.cwd()}/data/merkur-e2e-email-${process.pid}.db`;
process.env.PW_E2E_DB_PATH = dbPath;
process.env.PW_E2E_MAIL_PORT = String(mailPort);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['**/auth-email.e2e.ts'],
  globalTeardown: './tests/e2e/global-teardown.ts',
  outputDir: process.env.PW_E2E_OUTPUT_DIR ?? 'test-results/e2e-email',
  preserveOutput: 'always',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: origin,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'bun --no-orphans --no-env-file run tests/e2e/start-server.ts',
    env: {
      PW_E2E_PORT: String(port),
      PW_E2E_REDIS_PORT: String(redisPort),
      PW_E2E_DB_PATH: dbPath,
      PW_E2E_AUTH_IDENTITY: 'email',
      PW_E2E_MAIL_PORT: String(mailPort),
    },
    url: origin,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
