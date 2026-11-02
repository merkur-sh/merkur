import { guarded, localValue } from '@merkur/browser-storage';
import { type Device, isDevice, isDeviceEventsEpoch, isRecord } from '@merkur/shared';

// Last-known device list, persisted so a cold/resumed mobile launch can paint
// the list instantly instead of staring at an empty screen until the first
// live frame arrives. The cursor is what lets that launch resume the stream
// with zero bytes when nothing changed — both halves of it, since a sequence
// without its epoch cannot be told apart from the same number on a counter
// that restarted — and `userId` is what keeps one account's list, and its
// cursor, from ever answering for another.
const CACHE_KEYS = ['userId', 'epoch', 'seq', 'devices'] as const;

export interface CachedDeviceList {
  readonly userId: string;
  readonly epoch: string;
  readonly seq: number;
  readonly devices: readonly Device[];
}

// Anything that is not exactly the current shape is purged on read, so a cache
// written by a build with a different vocabulary cleans itself up.
const deviceListCache = localValue('merkur:device-list:v1', guarded(isCachedDeviceList));

export function loadCachedDeviceList(): CachedDeviceList | null {
  return deviceListCache.read();
}

/** Private mode or a full quota leaves the next launch without a cache, and nothing else. */
export function saveCachedDeviceList(cache: CachedDeviceList): void {
  deviceListCache.write(cache);
}

export function clearCachedDeviceList(): void {
  deviceListCache.remove();
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
