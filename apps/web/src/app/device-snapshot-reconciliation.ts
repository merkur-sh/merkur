import type { Device } from '@merkur/shared';

/**
 * Keep unchanged device objects stable across full SSE snapshots. Solid's
 * <For> reconciles by item identity, so this prevents rows (and their focus,
 * hover, or open-menu state) from being reconstructed on every heartbeat.
 */
export function reconcileDeviceSnapshot(
  current: readonly Device[],
  next: readonly Device[],
): Device[] {
  const currentById = new Map(current.map((device) => [device.id, device]));
  const reconciled = next.map((device) => {
    const previous = currentById.get(device.id);
    return previous !== undefined && sameDevice(previous, device) ? previous : device;
  });

  return current.length === reconciled.length &&
    reconciled.every((device, index) => current[index] === device)
    ? (current as Device[])
    : reconciled;
}

function sameDevice(a: Device, b: Device): boolean {
  return (
    a.id === b.id &&
    a.userId === b.userId &&
    a.name === b.name &&
    a.platform === b.platform &&
    a.lastSeen === b.lastSeen &&
    a.status === b.status &&
    a.version === b.version &&
    a.identitySealBackend === b.identitySealBackend
  );
}
