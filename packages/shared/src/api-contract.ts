import {
  DEVICE_STATUS_DEGRADED,
  DEVICE_STATUS_OFFLINE,
  DEVICE_STATUS_ONLINE,
  type Device,
  isDaemonIdentitySealBackend,
} from './domain';
import { isRecord, readNonEmptyStringField, readNullableFiniteNumberField } from './parsing';

const DEVICE_LINK_TOKEN_RESPONSE_KEYS = ['command', 'expiresAt', 'machineUsage'] as const;
const DEVICE_KEYS = [
  'id',
  'userId',
  'name',
  'platform',
  'status',
  'lastSeen',
  'version',
  'identitySealBackend',
] as const;

/** Account capacity, including approved links that have not completed yet. */
export interface MachineUsage {
  readonly used: number;
  /** null means unlimited. Hosted boxes do not count. */
  readonly limit: number | null;
}

export function isMachineUsage(value: unknown): value is MachineUsage {
  return (
    isExactRecord(value, ['used', 'limit']) &&
    typeof value.used === 'number' &&
    Number.isSafeInteger(value.used) &&
    value.used >= 0 &&
    (value.limit === null ||
      (typeof value.limit === 'number' && Number.isSafeInteger(value.limit) && value.limit > 0))
  );
}

export interface DeviceLinkTokenResponse {
  /** The one-use token stays inside the command, hidden at capacity. */
  readonly command: string | null;
  /** Command expiry, or the next reservation expiry when at capacity. */
  readonly expiresAt: number | null;
  readonly machineUsage: MachineUsage;
}

export function isDeviceLinkTokenResponse(value: unknown): value is DeviceLinkTokenResponse {
  if (!isExactRecord(value, DEVICE_LINK_TOKEN_RESPONSE_KEYS)) {
    return false;
  }

  if (!isMachineUsage(value.machineUsage)) return false;
  const atLimit =
    value.machineUsage.limit !== null && value.machineUsage.used >= value.machineUsage.limit;
  const validExpiry =
    typeof value.expiresAt === 'number' &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > 0;
  return atLimit
    ? value.command === null && (value.expiresAt === null || validExpiry)
    : readNonEmptyStringField(value, 'command') !== null && validExpiry;
}

export function isDevice(value: unknown): value is Device {
  if (!isExactRecord(value, DEVICE_KEYS)) {
    return false;
  }

  const id = readNonEmptyStringField(value, 'id');
  const userId = readNonEmptyStringField(value, 'userId');
  const name = readNonEmptyStringField(value, 'name');
  const platform = readNonEmptyStringField(value, 'platform');
  const status = readNonEmptyStringField(value, 'status');
  const lastSeen = readNullableFiniteNumberField(value, 'lastSeen');
  const hasValidLastSeen = lastSeen !== undefined;
  // version is always present; null means the daemon has not reported one yet.
  const hasValidVersion =
    value.version === null || (typeof value.version === 'string' && value.version.length > 0);

  return (
    id !== null &&
    userId !== null &&
    name !== null &&
    platform !== null &&
    (status === DEVICE_STATUS_ONLINE ||
      status === DEVICE_STATUS_DEGRADED ||
      status === DEVICE_STATUS_OFFLINE) &&
    hasValidLastSeen &&
    hasValidVersion &&
    isDaemonIdentitySealBackend(value.identitySealBackend)
  );
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}
