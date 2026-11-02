/**
 * The browser storage failure report's vocabulary, as a contract rather than a
 * copy, on the terms of `browser-diagnostics.ts`: the web app counts what
 * `@merkur/browser-storage` reports, the server validates the body against
 * these literals, and a test on each side pins its own copy to them.
 *
 * Every field is a closed union or a bounded count: a target names which store
 * failed, never a key's value, a database record or a message.
 */

/**
 * The browser's stores, one per web-storage key or IndexedDB database the web
 * app declares. `unlisted` is a store the web app failed to name here, which
 * is a bug in the web app and is still worth a count.
 */
export const BROWSER_STORAGE_TARGETS = [
  'refresh_credential',
  'pending_logout',
  'device_list',
  'transport_autotuner',
  'appearance',
  'virtual_keyboard',
  'typing_offsets',
  'typing_diagnostics',
  'notifications',
  'last_device',
  'delegation_vault',
  'receiver_profiles',
  'unlisted',
] as const;

export type BrowserStorageTarget = (typeof BROWSER_STORAGE_TARGETS)[number];

/** The failures `@merkur/browser-storage` counts, by the names it gives them. */
export const BROWSER_STORAGE_FAILURES = [
  'quota',
  'refused',
  'unparseable',
  'aborted',
  'open_failed',
  'open_abandoned',
  'connection_lost',
] as const;

export type BrowserStorageFailure = (typeof BROWSER_STORAGE_FAILURES)[number];

export interface BrowserStorageReportBody {
  readonly target: BrowserStorageTarget;
  readonly failure: BrowserStorageFailure;
  readonly count: number;
}
