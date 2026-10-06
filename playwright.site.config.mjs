// Playwright config for merkur.sh: the built site served by its compiled
// static server, with a fake Rybbit upstream behind `/analytics/*`
// (tests/e2e/start-site.ts). Run it through `bun run test:e2e:site`, which
// builds the site and the server first.
import { defineConfig } from '@playwright/test';

const port = Number(process.env.PW_SITE_PORT ?? 54_361);
const rybbitPort = Number(process.env.PW_SITE_RYBBIT_PORT ?? port + 1);
const origin = `http://127.0.0.1:${port}`;
const softwareGpu = process.env.PW_E2E_GPU === 'swiftshader';
if (process.env.PW_E2E_GPU !== undefined && !softwareGpu) {
  throw new Error('PW_E2E_GPU must be swiftshader or unset for hardware');
}
process.env.PW_SITE_RYBBIT_PORT = String(rybbitPort);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['**/site.e2e.ts', '**/site-blog.e2e.ts'],
  outputDir: process.env.PW_E2E_OUTPUT_DIR ?? 'test-results/e2e-site',
  preserveOutput: 'always',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: origin,
    browserName: 'chromium',
    // Full Chromium, headless or headed: the page's pictures are drawn with
    // WebGL2 on an OffscreenCanvas in a worker, which the headless shell lacks.
    channel: 'chromium',
    headless: !process.env.HEADED,
    launchOptions: {
      args: [
        '--enable-gpu',
        ...(softwareGpu ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] : []),
      ],
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun --no-orphans --no-env-file run tests/e2e/start-site.ts',
    env: {
      PW_SITE_PORT: String(port),
      PW_SITE_RYBBIT_PORT: String(rybbitPort),
    },
    url: `${origin}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
