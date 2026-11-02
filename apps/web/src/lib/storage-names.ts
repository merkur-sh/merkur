import { BROWSER_STORAGE_TARGETS, type BrowserStorageTarget } from '@merkur/shared';

/**
 * Every web-storage key and IndexedDB database the web app declares, under the
 * telemetry target its failures are counted as. Each module takes its name
 * from here, so a store cannot exist without a target, and `satisfies` keeps
 * the table and the shared contract to the same set.
 */
export const STORAGE_NAMES = {
  refresh_retired: 'merkur:refresh-credential-retired',
  refresh_generation: 'merkur:refresh-credential-generation',
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
} as const satisfies Record<Exclude<BrowserStorageTarget, 'unlisted'>, string>;

const TARGET_BY_NAME = new Map<string, BrowserStorageTarget>();
for (const target of BROWSER_STORAGE_TARGETS) {
  if (target !== 'unlisted') TARGET_BY_NAME.set(STORAGE_NAMES[target], target);
}

/** The target a failure reported against `name` (a key or a database) is counted as. */
export function storageTargetOf(name: string): BrowserStorageTarget {
  return TARGET_BY_NAME.get(name) ?? 'unlisted';
}
