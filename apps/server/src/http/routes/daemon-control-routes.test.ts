import { describe, expect, test } from 'bun:test';
import { websocket } from 'elysia/websocket';

import {
  isSecureDaemonControlOrigin,
  parseDaemonControlUpgradeCredentials,
} from './daemon-control-routes';

describe('daemon control WebSocket upgrade validation', () => {
  test('accepts public connection metadata without putting secrets in the URL', () => {
    const request = new Request('https://merkur.example/api/daemon/control', {
      headers: {
        'x-merkur-daemon-id': 'daemon-1',
        'x-merkur-version': '4.0.0',
      },
    });

    expect(parseDaemonControlUpgradeCredentials(request)).toEqual({
      daemonId: 'daemon-1',
      daemonVersion: '4.0.0',
      resumePresenceId: null,
    });
  });

  test('carries a well-formed resume presence and rejects a malformed one', () => {
    const withHeader = (value: string) =>
      parseDaemonControlUpgradeCredentials(
        new Request('https://merkur.example/api/daemon/control', {
          headers: {
            'x-merkur-daemon-id': 'daemon-1',
            'x-merkur-version': '4.0.0',
            'x-merkur-resume-presence': value,
          },
        }),
      );

    const presenceId = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    expect(withHeader(presenceId)?.resumePresenceId).toBe(presenceId);

    expect(withHeader('not-a-uuid')).toBeNull();
    expect(withHeader('')).toBeNull();
  });

  test('rejects credentials and other data in the URL', () => {
    const request = new Request(
      'https://merkur.example/api/daemon/control?api_key=daemon-api-key',
      {
        headers: {
          'x-merkur-daemon-id': 'daemon-1',
          'x-merkur-version': '4.0.0',
        },
      },
    );

    expect(parseDaemonControlUpgradeCredentials(request)).toBeNull();
  });

  test('rejects malformed bearer and missing identity headers', () => {
    expect(
      parseDaemonControlUpgradeCredentials(
        new Request('https://merkur.example/api/daemon/control', {
          headers: {
            authorization: 'daemon-api-key',
            'x-merkur-version': '4.0.0',
          },
        }),
      ),
    ).toBeNull();
  });

  test('requires TLS except for explicit loopback development', () => {
    expect(isSecureDaemonControlOrigin('https://merkur.example')).toBe(true);
    expect(isSecureDaemonControlOrigin('http://localhost:5703')).toBe(true);
    expect(isSecureDaemonControlOrigin('http://127.0.0.1:5703')).toBe(true);
    expect(isSecureDaemonControlOrigin('http://127.12.34.56:5703')).toBe(true);
    expect(isSecureDaemonControlOrigin('http://[::1]:5703')).toBe(true);
    expect(isSecureDaemonControlOrigin('http://merkur.example')).toBe(false);
  });
});

// Elysia creates a new context view for each callback. The upgrade Request must
// remain identical so authenticated connections and ping liveness share one key.
describe('Elysia WebSocket ping dispatch', () => {
  test('preserves the upgrade request across open, message, ping and close', async () => {
    const { Elysia } = await import('elysia');

    let pingHookCalls = 0;

    // Both hook arguments travel out on promises rather than closure variables,
    // so the assertions below see their real types instead of `null`.
    const { promise: serverOpened, resolve: resolveServerOpened } =
      Promise.withResolvers<Request>();
    const { promise: pinged, resolve: resolvePinged } = Promise.withResolvers<Request>();

    const { promise: messaged, resolve: resolveMessaged } = Promise.withResolvers<Request>();
    const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<Request>();
    const app = new Elysia().use(websocket()).ws('/ping-dispatch', {
      sendPings: false,
      open(ws) {
        resolveServerOpened(ws.request);
      },
      ping(ws) {
        pingHookCalls += 1;
        resolvePinged(ws.request);
      },
      message(ws) {
        resolveMessaged(ws.request);
      },
      close(ws) {
        resolveClosed(ws.request);
      },
    });

    const server = app.listen(0);
    try {
      const port = server.server?.port;
      expect(port).toBeDefined();

      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ping-dispatch`) as WebSocket & {
        ping(): void;
      };
      const { promise: opened, resolve: resolveOpened } = Promise.withResolvers<void>();
      socket.addEventListener('open', () => resolveOpened());

      await Promise.race([
        opened,
        Bun.sleep(2_000).then(() => Promise.reject(new Error('client never opened'))),
      ]);
      socket.send('hello');
      socket.ping();
      const pingArgument = await Promise.race([
        pinged,
        Bun.sleep(2_000).then(() => Promise.reject(new Error('ping hook never fired'))),
      ]);
      socket.close();

      // The ping hook cannot fire before the open hook, so this is settled.
      const openKey = await serverOpened;

      expect(pingHookCalls).toBe(1);
      expect(pingArgument).toBe(openKey);
      expect(await messaged).toBe(openKey);
      expect(await closed).toBe(openKey);
    } finally {
      await server.stop(true);
    }
  }, 15_000);
});
