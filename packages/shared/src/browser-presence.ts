import { isRecord } from './parsing';

export const BROWSER_EVENT_PRESENCE = 'browser-presence';
/** Definitive loss of the event connection's browser delegation; payload is JSON null. */
export const BROWSER_EVENT_SESSION_ENDED = 'browser-session-ended';
/**
 * Another browser of this account signed in or was revoked; payload is JSON
 * null. The list itself is fetched, not carried: the event says only that the
 * one a browser may be showing is no longer current.
 */
export const BROWSER_EVENT_SESSIONS_CHANGED = 'browser-sessions-changed';

/** Absolute, ephemeral browser connectivity; independent of device-list cursors. */
export interface BrowserPresenceFrame {
  readonly activeDelegationIds: readonly string[];
}

export function isBrowserPresenceFrame(value: unknown): value is BrowserPresenceFrame {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.activeDelegationIds) &&
    value.activeDelegationIds.length <= 256 &&
    value.activeDelegationIds.every(
      (id) => typeof id === 'string' && id.length > 0 && id.length <= 128,
    ) &&
    new Set(value.activeDelegationIds).size === value.activeDelegationIds.length
  );
}
