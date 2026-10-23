import { createRequire } from 'node:module';

/** The CLI export of the workspace's declared Playwright dependency. */
export const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');
