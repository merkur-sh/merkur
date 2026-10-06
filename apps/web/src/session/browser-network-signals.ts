export type LocalNetworkPermission = 'local-network' | 'loopback-network';

const LOCAL_NETWORK_PERMISSIONS: readonly LocalNetworkPermission[] = [
  'local-network',
  'loopback-network',
];

/** `Permissions`, able to name the Local Network Access permissions. */
type LocalNetworkPermissions = Permissions & {
  query(descriptor: { readonly name: LocalNetworkPermission }): Promise<PermissionStatus>;
};

/** The part of `NetworkInformation` this reads. Chromium exposes it to workers. */
interface ConnectionTypeSource extends EventTarget {
  readonly type?: string;
}

export interface BrowserNetworkSignalsIo {
  readonly permissions: LocalNetworkPermissions | undefined;
  readonly connection: ConnectionTypeSource | undefined;
}

export interface BrowserNetworkSignalHandlers {
  onLocalNetworkPermission(permission: LocalNetworkPermission, state: PermissionState): void;
  onConnectionTypeChange(): void;
}

function browserNetworkSignalsIo(): BrowserNetworkSignalsIo {
  const nav = navigator as Navigator & {
    readonly permissions?: LocalNetworkPermissions;
    readonly connection?: ConnectionTypeSource;
  };
  return { permissions: nav.permissions, connection: nav.connection };
}

/**
 * Follow the two browser signals that bear on direct dials and that no
 * connection can prove on its own. Returns the function that stops following.
 *
 * - Local Network Access: Chromium gates a WebTransport dial to a private,
 *   shared, unique-local, link-local or loopback address behind the
 *   `local-network` / `loopback-network` permission, from workers too. Each
 *   state and every change is reported. A browser without the permission
 *   (Safari, Firefox) rejects the query and reports nothing: its local dials
 *   are not gated.
 * - Connection type: Chromium on Android fires `typechange` when the active
 *   network changes type, the one handover signal a browser exposes. Only a
 *   type that exists and actually changed is reported; `change` stays
 *   unobserved (see `network-monitor.ts`).
 */
export function watchBrowserNetworkSignals(
  handlers: BrowserNetworkSignalHandlers,
  io: BrowserNetworkSignalsIo = browserNetworkSignalsIo(),
): () => void {
  let stopped = false;
  const watched: { readonly status: PermissionStatus; readonly listener: () => void }[] = [];
  for (const permission of LOCAL_NETWORK_PERMISSIONS) {
    io.permissions?.query({ name: permission }).then(
      (status) => {
        if (stopped) return;
        const listener = (): void => handlers.onLocalNetworkPermission(permission, status.state);
        status.addEventListener('change', listener);
        watched.push({ status, listener });
        listener();
      },
      () => {
        // Not a permission this browser has: its local dials are not gated.
      },
    );
  }

  const connection = io.connection;
  let connectionType = connection?.type;
  const onTypeChange = (): void => {
    const next = connection?.type;
    if (next === undefined || next === connectionType) return;
    connectionType = next;
    handlers.onConnectionTypeChange();
  };
  connection?.addEventListener('typechange', onTypeChange);

  return () => {
    stopped = true;
    for (const { status, listener } of watched) status.removeEventListener('change', listener);
    watched.length = 0;
    connection?.removeEventListener('typechange', onTypeChange);
  };
}
