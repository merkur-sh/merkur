import { describe, expect, test } from 'bun:test';
import type { LocalNetworkPermission } from './browser-network-signals';
import {
  type BrowserNetworkSignalsIo,
  watchBrowserNetworkSignals,
} from './browser-network-signals';

class FakeStatus extends EventTarget {
  constructor(public state: PermissionState) {
    super();
  }
}

class FakeConnection extends EventTarget {
  constructor(public type: string | undefined) {
    super();
  }
}

function io(
  statuses: Partial<Record<LocalNetworkPermission, FakeStatus>>,
  connection?: FakeConnection,
): BrowserNetworkSignalsIo {
  const permissions = {
    query: async ({ name }: { readonly name: string }) => {
      const status = statuses[name as LocalNetworkPermission];
      if (status === undefined) throw new TypeError(`unknown permission ${name}`);
      return status;
    },
  } as unknown as BrowserNetworkSignalsIo['permissions'];
  return { permissions, connection };
}

describe('browser network signals', () => {
  test('reports each local network permission and every change until stopped', async () => {
    const local = new FakeStatus('prompt');
    const seen: string[] = [];
    const stop = watchBrowserNetworkSignals(
      {
        onLocalNetworkPermission: (permission, state) => seen.push(`${permission}:${state}`),
        onConnectionTypeChange: () => {},
      },
      // Only `local-network` exists here: the other query rejects, as in a
      // browser without the permission, and reports nothing.
      io({ 'local-network': local }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(['local-network:prompt']);

    local.state = 'granted';
    local.dispatchEvent(new Event('change'));
    expect(seen).toEqual(['local-network:prompt', 'local-network:granted']);

    stop();
    local.state = 'denied';
    local.dispatchEvent(new Event('change'));
    expect(seen).toHaveLength(2);
  });

  test('a connection type change is reported only when the type exists and changed', () => {
    const connection = new FakeConnection('cellular');
    let changes = 0;
    const stop = watchBrowserNetworkSignals(
      { onLocalNetworkPermission: () => {}, onConnectionTypeChange: () => changes++ },
      io({}, connection),
    );
    connection.dispatchEvent(new Event('typechange'));
    expect(changes).toBe(0);
    connection.type = 'wifi';
    connection.dispatchEvent(new Event('typechange'));
    expect(changes).toBe(1);
    connection.type = undefined;
    connection.dispatchEvent(new Event('typechange'));
    expect(changes).toBe(1);

    stop();
    connection.type = 'cellular';
    connection.dispatchEvent(new Event('typechange'));
    expect(changes).toBe(1);
  });
});
