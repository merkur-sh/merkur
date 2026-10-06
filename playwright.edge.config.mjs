// Playwright config for real browser/daemon transport tests. Boots an isolated,
// edge-configured server using the coordinates supplied by
// scripts/run-edge-harness.ts. Do not run directly: the harness starts the edge
// and exports the required edge coordinates first.
import { defineConfig } from '@playwright/test';

const port = Number(process.env.PW_E2E_PORT ?? 54_331);
const redisPort = Number(process.env.PW_E2E_REDIS_PORT ?? port + 1);
const origin = `http://127.0.0.1:${port}`;
const dbPath = process.env.PW_E2E_DB_PATH ?? `${process.cwd()}/data/merkur-edge-${process.pid}.db`;
const browserName = process.env.PW_E2E_BROWSER ?? 'chromium';
const softwareGpu = process.env.PW_E2E_GPU === 'swiftshader';
if (process.env.PW_E2E_GPU !== undefined && !softwareGpu) {
  throw new Error('PW_E2E_GPU must be swiftshader or unset for hardware');
}
if (browserName !== 'chromium' && browserName !== 'firefox') {
  throw new Error('PW_E2E_BROWSER must be chromium or firefox');
}

process.env.PW_E2E_DB_PATH = dbPath;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: [
    '**/carrier-rebind.e2e.ts',
    '**/client-idle-work.e2e.ts',
    '**/device-list-updates.e2e.ts',
    '**/display-resync-recovery.e2e.ts',
    '**/edge-handshake-reorder.e2e.ts',
    '**/edge-sweep.e2e.ts',
    '**/ios-webkit-startup.e2e.ts',
    '**/network-handover.e2e.ts',
    '**/relay-keystroke-packets.e2e.ts',
    '**/terminal-cursor-motion.e2e.ts',
    '**/terminal-direct-latency.e2e.ts',
    '**/terminal-geometry-matrix.e2e.ts',
    '**/terminal-graphics.e2e.ts',
    '**/terminal-input-matrix.e2e.ts',
    '**/terminal-links.e2e.ts',
    '**/terminal-performance-matrix.e2e.ts',
    '**/terminal-redraw-reference.e2e.ts',
    '**/terminal-selection.e2e.ts',
    '**/terminal-touch.e2e.ts',
    '**/terminal-touch-matrix.e2e.ts',
    '**/terminal.e2e.ts',
    '**/startup-latency.e2e.ts',
    '**/transport-latency.e2e.ts',
    '**/tui-direct.e2e.ts',
    '**/tui-headless.e2e.ts',
    '**/tui-rebind.e2e.ts',
  ],
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  outputDir: process.env.PW_E2E_OUTPUT_DIR ?? 'test-results/e2e-edge',
  preserveOutput: 'always',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: origin,
    browserName,
    // Select full Chromium in both headed and headless runs. Without a channel,
    // Playwright silently switches headless runs to a different executable
    // (Headless Shell), invalidating full-browser artifact provenance.
    channel: browserName === 'chromium' ? 'chromium' : undefined,
    headless: !process.env.HEADED,
    // `--enable-gpu` is what makes the wall-clock budgets in
    // `transport-latency.e2e.ts` measurable: headless Chromium otherwise picks
    // SwiftShader even on a machine with a GPU, and the spec skips itself
    // rather than time a software rasterizer. On a host with no GPU the flag
    // changes nothing -- Chromium still lands on SwiftShader and the spec still
    // skips -- so it asks for hardware without ever faking it.
    // `PW_E2E_NETLOG=<file>` opts one run into Chromium's net log, at its
    // default capture mode (no payload bytes): the QUIC session events time
    // when the network service read each packet. Logging perturbs the network
    // thread it observes, so a run that sets it attributes; it does not gate.
    launchOptions: {
      args:
        browserName === 'chromium'
          ? [
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
              ...(process.env.PW_E2E_NETLOG ? [`--log-net-log=${process.env.PW_E2E_NETLOG}`] : []),
            ]
          : [],
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  // FORCE_EDGE=1 bakes VITE_FORCE_EDGE into the web build so the browser skips
  // the direct-WT race and stays pinned to the edge — required to exercise the
  // relay path with co-located (loopback) browser+daemon.
  webServer: {
    command: 'bun --no-orphans --no-env-file run tests/e2e/start-server.ts',
    env: {
      PW_E2E_PORT: String(port),
      PW_E2E_REDIS_PORT: String(redisPort),
      PW_E2E_DB_PATH: dbPath,
      PW_E2E_TRANSPORT: '1',
      PW_E2E_FORCE_EDGE: process.env.FORCE_EDGE === '1' ? '1' : '0',
      EDGE_REGISTRATION_KEYS_JSON:
        process.env.EDGE_REGISTRATION_KEYS_JSON ??
        JSON.stringify({
          'local-harness-1': Buffer.alloc(64, 0x71).toString('base64url'),
        }),
    },
    url: origin,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
