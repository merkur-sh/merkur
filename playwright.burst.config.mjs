// Standalone Playwright config for the browser-side render-scheduling proofs.
// Unlike playwright.config.mjs this boots NO web server and needs no
// redis / JWT keys: these tests run against a blank headless-chromium page —
// one injects the real render-mailbox source, the other measures the browser's
// own timer nesting behaviour, which no unit test can observe.
// Run: bunx playwright test -c playwright.burst.config.mjs
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['**/display-burst-paint.e2e.ts', '**/fence-poll-cadence.e2e.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: process.env.PW_E2E_OUTPUT_DIR ?? 'test-results/e2e-burst',
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
