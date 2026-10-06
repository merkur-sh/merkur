import { type Device, isDevice, isDeviceEventsEpoch, isRecord } from '@merkur/shared';

// Last-known device list, persisted so a cold/resumed mobile launch can paint
// the list instantly instead of staring at an empty screen until the first
// live frame arrives. The cursor is what lets that launch resume the stream
// with zero bytes when nothing changed — both halves of it, since a sequence
// without its epoch cannot be told apart from the same number on a counter
// that restarted — and `userId` is what keeps one account's list, and its
// cursor, from ever answering for another.
const DEVICE_LIST_CACHE_KEY = 'merkur:device-list:v1';
const CACHE_KEYS = ['userId', 'epoch', 'seq', 'devices'] as const;

export interface CachedDeviceList {
  readonly userId: string;
  readonly epoch: string;
  readonly seq: number;
  readonly devices: readonly Device[];
}

export function loadCachedDeviceList(): CachedDeviceList | null {
  try {
    const raw = localStorage.getItem(DEVICE_LIST_CACHE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isCachedDeviceList(parsed)) {
      // Anything that is not exactly the current shape is purged, so a cache
      // written by a build with a different vocabulary self-cleans on read.
      localStorage.removeItem(DEVICE_LIST_CACHE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveCachedDeviceList(cache: CachedDeviceList): void {
  try {
    localStorage.setItem(DEVICE_LIST_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Private mode / quota — the cache is best-effort.
  }
}

export function clearCachedDeviceList(): void {
  try {
    localStorage.removeItem(DEVICE_LIST_CACHE_KEY);
  } catch {
    // Best-effort.
  }
}

function isCachedDeviceList(value: unknown): value is CachedDeviceList {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === CACHE_KEYS.length &&
    CACHE_KEYS.every((key) => Object.hasOwn(value, key)) &&
    typeof value.userId === 'string' &&
    value.userId.length > 0 &&
    isDeviceEventsEpoch(value.epoch) &&
    typeof value.seq === 'number' &&
    Number.isSafeInteger(value.seq) &&
    value.seq >= 0 &&
    Array.isArray(value.devices) &&
    value.devices.every(isDevice)
  );
}
