export const DEVICE_STATUS_ONLINE = 'online';
/**
 * The daemon's control presence is suspended: its carrier dropped but the lease
 * is still inside its resume grace window, so the device is expected back
 * shortly and its browser sessions have not been torn down.
 */
export const DEVICE_STATUS_DEGRADED = 'degraded';
export const DEVICE_STATUS_OFFLINE = 'offline';

/**
 * Where a daemon identity's custody lives: the host's key chip (a Secure
 * Enclave, a TPM), or locked memory by explicit choice. Self-reported.
 */
export const DAEMON_IDENTITY_SEAL_BACKENDS = ['hardware', 'software'] as const;
export type DaemonIdentitySealBackend = (typeof DAEMON_IDENTITY_SEAL_BACKENDS)[number];
export function isDaemonIdentitySealBackend(value: unknown): value is DaemonIdentitySealBackend {
  return value === 'hardware' || value === 'software';
}

export type DeviceStatus =
  | typeof DEVICE_STATUS_ONLINE
  | typeof DEVICE_STATUS_DEGRADED
  | typeof DEVICE_STATUS_OFFLINE;

export interface Device {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly platform: string;
  readonly lastSeen: number | null;
  readonly status: DeviceStatus;
  /** Daemon build version; null for daemons that have not reported one. */
  readonly version: string | null;
  readonly identitySealBackend: DaemonIdentitySealBackend;
}
