// Playwright config for the multi-edge regional routing spec. Do not run
// directly: scripts/run-edge-topology-harness.ts builds the Rust artifacts,
// starts every edge, and exports their coordinates before invoking this config.
// Use `bun run test:e2e:edge-topology`.
import { defineConfig } from '@playwright/test';

const port = Number(process.env.PW_E2E_PORT ?? 54_341);
const redisPort = Number(process.env.PW_E2E_REDIS_PORT ?? port + 1);
const origin = `http://127.0.0.1:${port}`;
const dbPath =
  process.env.PW_E2E_DB_PATH ?? `${process.cwd()}/data/merkur-edge-topology-${process.pid}.db`;
const softwareGpu = process.env.PW_E2E_GPU === 'swiftshader';
if (process.env.PW_E2E_GPU !== undefined && !softwareGpu) {
  throw new Error('PW_E2E_GPU must be swiftshader or unset for hardware');
}

if (!process.env.EDGE_TOPOLOGY_CONTROL_URL) {
  throw new Error('run this config through bun run test:e2e:edge-topology');
}

process.env.PW_E2E_DB_PATH = dbPath;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/edge-topology.e2e.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: process.env.PW_E2E_OUTPUT_DIR ?? 'test-results/e2e-edge-topology',
  use: {
    baseURL: origin,
    // Full Chromium with a WebGPU adapter, as playwright.edge.config.mjs selects
    // it: Headless Shell has none, and the terminal worker, which a session
    // needs, fails without one.
    channel: 'chromium',
    headless: !process.env.HEADED,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--enable-experimental-web-platform-features',
        '--enable-gpu',
        ...(softwareGpu
          ? [
              '--enable-unsafe-webgpu',
              '--enable-unsafe-swiftshader',
              '--use-webgpu-adapter=swiftshader',
              ...(process.platform === 'linux'
                ? [
                    '--enable-features=Vulkan',
                    '--use-angle=swiftshader',
                    '--use-vulkan=swiftshader',
                    '--disable-vulkan-surface',
                  ]
                : []),
            ]
          : []),
      ],
    },
  },
  webServer: {
    command: 'bun --no-orphans --no-env-file run tests/e2e/start-server.ts',
    env: {
      PW_E2E_PORT: String(port),
      PW_E2E_REDIS_PORT: String(redisPort),
      PW_E2E_DB_PATH: dbPath,
      PW_E2E_TRANSPORT: '1',
      PW_E2E_FORCE_EDGE: '1',
      EDGE_REGISTRATION_KEYS_JSON: process.env.EDGE_REGISTRATION_KEYS_JSON ?? '',
    },
    url: origin,
    reuseExistingServer: false,
    timeout: 600_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
