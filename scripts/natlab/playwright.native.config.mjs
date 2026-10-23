import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, defineConfig } from '@playwright/test';
import edge from '../../playwright.edge.config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  ...edge,
  testDir: '../../tests/e2e',
  testMatch: ['**/tui-nat.e2e.ts'],
  globalSetup: path.join(root, 'tests/e2e/global-setup.ts'),
  globalTeardown: path.join(root, 'tests/e2e/global-teardown.ts'),
  workers: 1,
  timeout: 120_000,
  use: {
    ...edge.use,
    launchOptions: {
      ...edge.use.launchOptions,
      executablePath: path.join(root, 'scripts/natlab/browser.sh'),
      env: { ...process.env, MERKUR_NATLAB_CHROMIUM: chromium.executablePath() },
    },
  },
});
