import { describe, expect, test } from 'bun:test';

import { isDevice, isDeviceLinkTokenResponse } from './api-contract';

const VALID_DEVICE = {
  id: 'daemon-1',
  userId: 'user-1',
  name: 'Macbook',
  platform: 'darwin-arm64',
  status: 'online',
  lastSeen: 1_700_000_000_000,
  version: 'v1.2.3',
  identitySealBackend: 'hardware',
};

describe('isDevice', () => {
  test('accepts a device with a version string', () => {
    expect(isDevice(VALID_DEVICE)).toBe(true);
  });

  test('accepts a device with a null version', () => {
    expect(isDevice({ ...VALID_DEVICE, version: null })).toBe(true);
  });

  test('rejects a device without a version field', () => {
    const { version: _version, ...withoutVersion } = VALID_DEVICE;
    expect(isDevice(withoutVersion)).toBe(false);
  });

  test('rejects a device with a non-string version', () => {
    expect(isDevice({ ...VALID_DEVICE, version: 7 })).toBe(false);
  });

  test('rejects a payload missing required fields', () => {
    expect(isDevice({ ...VALID_DEVICE, id: '' })).toBe(false);
  });

  test('rejects a payload without lastSeen', () => {
    const { lastSeen: _lastSeen, ...withoutLastSeen } = VALID_DEVICE;
    expect(isDevice(withoutLastSeen)).toBe(false);
  });

  test('accepts every device status in the tri-state union', () => {
    expect(isDevice({ ...VALID_DEVICE, status: 'online' })).toBe(true);
    expect(isDevice({ ...VALID_DEVICE, status: 'degraded' })).toBe(true);
    expect(isDevice({ ...VALID_DEVICE, status: 'offline' })).toBe(true);
  });

  test('rejects a status outside the union', () => {
    expect(isDevice({ ...VALID_DEVICE, status: 'suspended' })).toBe(false);
    expect(isDevice({ ...VALID_DEVICE, status: '' })).toBe(false);
  });

  test('rejects surplus and empty-version fields', () => {
    // Pins that widening DeviceStatus did not grow DEVICE_KEYS.
    expect(isDevice({ ...VALID_DEVICE, legacyStatus: 'connected' })).toBe(false);
    expect(isDevice({ ...VALID_DEVICE, version: '' })).toBe(false);
  });
});

describe('exact API responses', () => {
  test('requires a hidden command at capacity and validates the account usage', () => {
    const limited = { command: null, expiresAt: null, machineUsage: { used: 3, limit: 3 } };
    expect(isDeviceLinkTokenResponse(limited)).toBe(true);
    expect(isDeviceLinkTokenResponse({ ...limited, expiresAt: 123 })).toBe(true);
    expect(isDeviceLinkTokenResponse({ ...limited, command: 'secret' })).toBe(false);
    expect(isDeviceLinkTokenResponse({ ...limited, machineUsage: { used: 2, limit: 3 } })).toBe(
      false,
    );
    for (const used of [-1, 0.5, Number.NaN]) {
      expect(isDeviceLinkTokenResponse({ ...limited, machineUsage: { used, limit: 3 } })).toBe(
        false,
      );
    }
    expect(
      isDeviceLinkTokenResponse({
        command: 'link',
        expiresAt: 123,
        machineUsage: { used: 10, limit: null },
      }),
    ).toBe(true);
  });
  test('accepts only the current link-token response shape', () => {
    const response = {
      command: 'curl -fsSL "https://merkur.test/install" | MERKUR_LINK_TOKEN=link-1 sh',
      expiresAt: 1_700_000_000_000,
      machineUsage: { used: 2, limit: 3 },
    };
    expect(isDeviceLinkTokenResponse(response)).toBe(true);
    expect(isDeviceLinkTokenResponse({ ...response, expires_at: response.expiresAt })).toBe(false);
    // The token travels only inside the command.
    expect(isDeviceLinkTokenResponse({ ...response, token: 'link-1' })).toBe(false);
  });
});
