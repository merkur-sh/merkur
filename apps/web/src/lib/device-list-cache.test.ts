import { beforeEach, describe, expect, test } from 'bun:test';
import type { Device } from '@merkur/shared';
import {
  type CachedDeviceList,
  clearCachedDeviceList,
  loadCachedDeviceList,
  saveCachedDeviceList,
} from './device-list-cache';

const validDevice: Device = {
  id: 'device-1',
  userId: 'user-1',
  name: 'Workstation',
  platform: 'linux',
  status: 'online',
  lastSeen: 1,
  version: '1.0.0',
  identitySealBackend: 'software',
};

const EPOCH = 'a1b2c3d4e5f60718';

const cache = (devices: readonly Device[], seq = 7): CachedDeviceList => ({
  userId: 'user-1',
  epoch: EPOCH,
  seq,
  devices,
});

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});

beforeEach(() => {
  values.clear();
});

describe('device list cache schema', () => {
  test('round-trips the list with its owner and cursor, including an authoritative empty list', () => {
    saveCachedDeviceList(cache([validDevice]));
    expect(loadCachedDeviceList()).toEqual(cache([validDevice]));

    saveCachedDeviceList(cache([], 0));
    expect(loadCachedDeviceList()).toEqual(cache([], 0));
  });

  test('round-trips a degraded device and purges an unknown status', () => {
    const degraded: Device = { ...validDevice, status: 'degraded' };
    saveCachedDeviceList(cache([degraded]));
    expect(loadCachedDeviceList()).toEqual(cache([degraded]));

    // One unparseable element purges the whole cache, so a snapshot written by
    // a build with a different status vocabulary self-cleans on read.
    values.set(
      'merkur:device-list:v1',
      JSON.stringify(cache([{ ...validDevice, status: 'suspended' as Device['status'] }])),
    );
    expect(loadCachedDeviceList()).toBeNull();
    expect(values.has('merkur:device-list:v1')).toBe(false);
  });

  test('rejects and deletes a cache without an owner or a whole cursor', () => {
    // The shape a build before sequencing wrote: a bare array. Resuming it
    // would be wrong for any account, so it is removed rather than read.
    localStorage.setItem('merkur:device-list:v1', JSON.stringify([validDevice]));
    expect(loadCachedDeviceList()).toBeNull();
    expect(localStorage.getItem('merkur:device-list:v1')).toBeNull();

    localStorage.setItem(
      'merkur:device-list:v1',
      JSON.stringify({ userId: 'user-1', epoch: EPOCH, seq: -1, devices: [validDevice] }),
    );
    expect(loadCachedDeviceList()).toBeNull();

    localStorage.setItem(
      'merkur:device-list:v1',
      JSON.stringify({ userId: '', epoch: EPOCH, seq: 1, devices: [validDevice] }),
    );
    expect(loadCachedDeviceList()).toBeNull();

    // A sequence with no epoch is the shape written before the counter could
    // be told apart from a restarted one. Reading it would let a browser offer
    // half a cursor, which the server can only answer with a snapshot anyway.
    localStorage.setItem(
      'merkur:device-list:v1',
      JSON.stringify({ userId: 'user-1', seq: 7, devices: [validDevice] }),
    );
    expect(loadCachedDeviceList()).toBeNull();
    expect(localStorage.getItem('merkur:device-list:v1')).toBeNull();

    localStorage.setItem(
      'merkur:device-list:v1',
      JSON.stringify({ userId: 'user-1', epoch: 'NOT-HEX', seq: 7, devices: [validDevice] }),
    );
    expect(loadCachedDeviceList()).toBeNull();
  });

  test('rejects and deletes an entire mixed-schema snapshot', () => {
    localStorage.setItem(
      'merkur:device-list:v1',
      JSON.stringify({
        userId: 'user-1',
        epoch: EPOCH,
        seq: 7,
        devices: [validDevice, { ...validDevice, version: undefined }],
      }),
    );

    expect(loadCachedDeviceList()).toBeNull();
    expect(localStorage.getItem('merkur:device-list:v1')).toBeNull();
  });

  test('clear removes the persisted list', () => {
    saveCachedDeviceList(cache([validDevice]));
    clearCachedDeviceList();
    expect(loadCachedDeviceList()).toBeNull();
  });
});

test('purges identities cached before the hardware identity cutover', () => {
  const { identitySealBackend: _backend, ...retiredDevice } = validDevice;
  values.set('merkur:device-list:v1', JSON.stringify({ ...cache([]), devices: [retiredDevice] }));
  expect(loadCachedDeviceList()).toBeNull();
  expect(values.has('merkur:device-list:v1')).toBe(false);
});
