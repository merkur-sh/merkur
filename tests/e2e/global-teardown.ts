import type { FullConfig } from '@playwright/test';

import { removeE2EDatabase } from './runtime-files';

export default function globalTeardown(_config: FullConfig): void {
  const databasePath = process.env.PW_E2E_DB_PATH;
  if (databasePath !== undefined) {
    removeE2EDatabase(databasePath);
  }
}
