import { defineConfig } from '@playwright/test';

const port = Number(process.env.PW_E2E_PORT ?? 54_321);
const redisPort = Number(process.env.PW_E2E_REDIS_PORT ?? port + 1);
const origin = `http://127.0.0.1:${port}`;
const dbPath = process.env.PW_E2E_DB_PATH ?? `${process.cwd()}/data/merkur-e2e-${process.pid}.db`;
process.env.PW_E2E_DB_PATH = dbPath;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: [
    '**/app.e2e.ts',
    '**/auth-cross-tab.e2e.ts',
    '**/auth-resilience.e2e.ts',
    '**/display-burst-paint.e2e.ts',
    '**/keyboard-navigation.e2e.ts',
  ],
  globalTeardown: './tests/e2e/global-teardown.ts',
  outputDir: process.env.PW_E2E_OUTPUT_DIR ?? 'test-results/e2e',
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
    },
    url: origin,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
