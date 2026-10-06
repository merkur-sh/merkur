// Standalone config for the WebTransport de-risk probe. No web server; the test
// dials an already-running local merkur-edge. Chromium needs QUIC/WebTransport,
// which is on by default, plus we widen the happy-eyeballs so [::1] resolves.
import { defineConfig } from '@playwright/test';

const probePort = Number(process.env.PW_E2E_PROBE_PORT ?? 24_341);
const probeOrigin = process.env.PROBE_ORIGIN ?? `http://127.0.0.1:${probePort}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/edge-wt-probe.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 15_000 },
  outputDir: process.env.PW_E2E_OUTPUT_DIR ?? 'test-results/e2e-edge-probe',
  use: {
    baseURL: probeOrigin,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--enable-experimental-web-platform-features'],
    },
  },
  webServer:
    process.env.PROBE_ORIGIN === undefined
      ? {
          command: 'bun --no-orphans --no-env-file run tests/e2e/start-probe-origin.ts',
          env: { PW_E2E_PROBE_PORT: String(probePort) },
          url: probeOrigin,
          reuseExistingServer: false,
          timeout: 10_000,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      : undefined,
});
