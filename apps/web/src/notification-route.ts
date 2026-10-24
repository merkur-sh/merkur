const MACHINE_FRAGMENT = '#machine=';

export function machineNotificationPath(deviceId: string): string {
  return `/${MACHINE_FRAGMENT}${encodeURIComponent(deviceId)}`;
}

export function notificationMachineId(hash: string): string | null {
  if (!hash.startsWith(MACHINE_FRAGMENT)) return null;
  try {
    const id = decodeURIComponent(hash.slice(MACHINE_FRAGMENT.length));
    return id.length > 0 && `${MACHINE_FRAGMENT}${encodeURIComponent(id)}` === hash ? id : null;
  } catch (cause) {
    if (cause instanceof URIError) return null;
    throw cause;
  }
}

/** A notification can address only this app's root and a machine fragment. */
export function notificationTarget(path: string, origin: string): URL | null {
  try {
    const url = new URL(path, origin);
    if (
      url.origin !== origin ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      (url.hash.length > 0 && notificationMachineId(url.hash) === null)
    ) {
      return null;
    }
    return url;
  } catch (cause) {
    if (cause instanceof TypeError) return null;
    throw cause;
  }
}
