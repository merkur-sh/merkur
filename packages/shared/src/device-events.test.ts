import { describe, expect, test } from 'bun:test';
import {
  formatDeviceEventsCursor,
  isDeviceResumeFrame,
  isDeviceSnapshotFrame,
  parseDeviceEventsCursor,
  presenceStateToDeviceStatus,
} from './device-events';
import type { Device } from './domain';

const EPOCH = 'a1b2c3d4e5f60718';

const DEVICE: Device = {
  id: 'daemon-1',
  userId: 'user-1',
  name: 'Workstation',
  platform: 'linux',
  status: 'online',
  lastSeen: 1,
  version: '1.0.0',
  identitySealBackend: 'software',
};

describe('device events cursor', () => {
  test('round-trips through the header value', () => {
    const cursor = { epoch: EPOCH, seq: 41 };
    expect(formatDeviceEventsCursor(cursor)).toBe(`${EPOCH}:41`);
    expect(parseDeviceEventsCursor(formatDeviceEventsCursor(cursor))).toEqual(cursor);
    expect(parseDeviceEventsCursor(`${EPOCH}:0`)).toEqual({ epoch: EPOCH, seq: 0 });
  });

  test('reads anything but a whole, exact cursor as no resume', () => {
    // Every one of these costs a snapshot, which is always correct — so this
    // never has to guess at a half-understood value.
    for (const raw of [
      null,
      '',
      '41',
      EPOCH,
      `${EPOCH}:`,
      `:41`,
      `${EPOCH}:-1`,
      `${EPOCH}:007`,
      `${EPOCH}:4.1`,
      `${EPOCH}:9007199254740993`,
      `${EPOCH.toUpperCase()}:41`,
      `not-hex:41`,
      `${'a'.repeat(65)}:41`,
      `${EPOCH}:41:41`,
    ]) {
      expect(parseDeviceEventsCursor(raw)).toBeNull();
    }
  });

  test('a hex-only epoch keeps the separator unambiguous', () => {
    // The epoch is opaque, so the alphabet is the only thing keeping a `:` out
    // of the left half of a cursor.
    expect(parseDeviceEventsCursor('ab:cd:41')).toBeNull();
  });
});

describe('device events frames', () => {
  test('a snapshot or resume without its epoch is not a frame', () => {
    expect(isDeviceSnapshotFrame({ epoch: EPOCH, seq: 4, devices: [DEVICE] })).toBe(true);
    expect(isDeviceResumeFrame({ epoch: EPOCH, seq: 4 })).toBe(true);

    // The shape written before the counter could be told apart from a restarted
    // one. A stream that answered with it could not be resumed from safely, so
    // it is not accepted at all.
    expect(isDeviceSnapshotFrame({ seq: 4, devices: [DEVICE] })).toBe(false);
    expect(isDeviceResumeFrame({ seq: 4 })).toBe(false);

    expect(isDeviceResumeFrame({ epoch: 'NOT-HEX', seq: 4 })).toBe(false);
    expect(isDeviceSnapshotFrame({ epoch: EPOCH, seq: -1, devices: [] })).toBe(false);
    // One unparseable device rejects the whole snapshot rather than truncating it.
    expect(isDeviceSnapshotFrame({ epoch: EPOCH, seq: 4, devices: [DEVICE, {}] })).toBe(false);
  });
});

describe('presence dispositions', () => {
  test('collapse onto the three statuses the wire carries', () => {
    expect(presenceStateToDeviceStatus('online')).toBe('online');
    // Down, but with a lease it can still come back to.
    expect(presenceStateToDeviceStatus('silent')).toBe('degraded');
    expect(presenceStateToDeviceStatus('suspended')).toBe('degraded');
    // No entry at all.
    expect(presenceStateToDeviceStatus(undefined)).toBe('offline');
  });
});
