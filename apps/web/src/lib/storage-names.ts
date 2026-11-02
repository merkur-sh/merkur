import { deleteDatabases, removeLocalKeys } from '@merkur/browser-storage';
import { BROWSER_STORAGE_TARGETS, type BrowserStorageTarget } from '@merkur/shared';

/**
 * Every name below starts with this. A `localStorage` key or IndexedDB database
 * under it that the table does not hold is an earlier build's: a renamed key, a
 * value that moved to IndexedDB, a database whose module is gone.
 */
const OWNED_PREFIX = 'merkur';

/**
 * Every web-storage key and IndexedDB database the web app declares, under the
 * telemetry target its failures are counted as. Each module takes its name
 * from here, so a store cannot exist without a target, and `satisfies` keeps
 * the table and the shared contract to the same set, every name under
 * `OWNED_PREFIX`.
 */
export const STORAGE_NAMES = {
  refresh_credential: 'merkur-refresh-credential',
  pending_logout: 'merkur:pending-browser-logout',
  device_list: 'merkur:device-list:v1',
  transport_autotuner: 'merkur-transport-tuning',
  appearance: 'merkur.terminal.appearance.v1',
  virtual_keyboard: 'merkur.terminal.virtualKeyboard',
  typing_offsets: 'merkur-typing-offsets',
  typing_diagnostics: 'merkur-typing-diagnostics',
  notifications: 'merkur:terminal-notifications-enabled',
  last_device: 'merkur:last-device-id',
  delegation_vault: 'merkur-auth',
  receiver_profiles: 'merkur-display-performance',
} as const satisfies Record<
  Exclude<BrowserStorageTarget, 'unlisted'>,
  `${typeof OWNED_PREFIX}${string}`
>;

const TARGET_BY_NAME = new Map<string, BrowserStorageTarget>();
for (const target of BROWSER_STORAGE_TARGETS) {
  if (target !== 'unlisted') TARGET_BY_NAME.set(STORAGE_NAMES[target], target);
}

/** The target a failure reported against `name` (a key or a database) is counted as. */
export function storageTargetOf(name: string): BrowserStorageTarget {
  return TARGET_BY_NAME.get(name) ?? 'unlisted';
}

const isUndeclared = (name: string): boolean =>
  name.startsWith(OWNED_PREFIX) && !TARGET_BY_NAME.has(name);

/**
 * Removes what earlier builds left under names no store declares. The table is
 * the whole set, so this needs no list of old names, and a later rename cleans
 * up after itself. `sessionStorage` is left alone: it ends with its tab.
 */
export async function removeUndeclaredStorage(): Promise<void> {
  removeLocalKeys(isUndeclared);
  await deleteDatabases(isUndeclared);
}
