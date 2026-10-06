export interface NetworkChangeEvent {
  readonly kind: 'online' | 'offline';
}

export interface NetworkMonitor {
  destroy(): void;
}

export interface NetworkMonitorIo {
  windowTarget: ConnectionEventTarget;
}

/**
 * The browser's connectivity edges, and nothing else.
 *
 * `online` and `offline` fire only when the browser's connectivity actually
 * flips, so every edge is a real transition and none needs deduplicating.
 * NetworkInformation's `change` is deliberately not observed: desktop Chromium
 * fires it when its network-quality estimate moves, which bulk traffic does on
 * its own, and a move between two live interfaces need not move it at all. A
 * move between networks is proved exactly elsewhere: the edge reports the
 * address it validated on the committed signaling carrier, and a carrier that
 * cannot follow closes or fails the heartbeat ladder. Chromium on Android's
 * `typechange` is the one handover hint, observed in the transport worker.
 */
export function createNetworkMonitor(
  onNetworkChange: (event: NetworkChangeEvent) => void,
  io: NetworkMonitorIo = { windowTarget: window },
): NetworkMonitor {
  function handleOnline(): void {
    onNetworkChange({ kind: 'online' });
  }
  function handleOffline(): void {
    onNetworkChange({ kind: 'offline' });
  }

  io.windowTarget.addEventListener('online', handleOnline);
  io.windowTarget.addEventListener('offline', handleOffline);

  return {
    destroy(): void {
      io.windowTarget.removeEventListener('online', handleOnline);
      io.windowTarget.removeEventListener('offline', handleOffline);
    },
  };
}

export interface ConnectionEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
