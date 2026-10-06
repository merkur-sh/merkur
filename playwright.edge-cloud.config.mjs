// Runs the edge-sweep spec against the REMOTE experiment cloud server (Railway)
// + Fly edge, with a REAL local daemon linked to it. No local webServer — the
// remote server owns the authenticated daemon WSS control connection and
// presence. The daemon uses the local (fixed) dataplane binary, so the
// WebTransport relay-path burst fix is exercised end-to-end.
//
// Run: bunx playwright test -c playwright.edge-cloud.config.mjs
import { defineConfig } from '@playwright/test';

const origin = process.env.CLOUD_ORIGIN ?? 'https://mercury-experiment.up.railway.app';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/edge-sweep.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 45_000 },
  globalSetup: './tests/e2e/global-setup.ts',
  outputDir: process.env.PW_E2E_OUTPUT_DIR ?? 'test-results/e2e-edge-cloud',
  use: {
    baseURL: origin,
    headless: !process.env.HEADED,
    launchOptions: { args: ['--enable-experimental-web-platform-features'] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
