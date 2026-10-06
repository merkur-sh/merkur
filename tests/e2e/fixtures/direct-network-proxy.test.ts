import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { DIRECT_PROXY_DIAL_MARKER, directProxyWorkerPrelude } from './direct-network-proxy';

describe('direct network constructor translation', () => {
  test('changes only the UDP destination and retains native constructor/options identity', () => {
    const calls: { url: string; options: object | undefined }[] = [];
    const messages: unknown[][] = [];
    class NativeTransport {
      constructor(url: string, options?: object) {
        calls.push({ url, options });
      }
    }
    const options = {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array([1, 2, 3]) }],
    };
    const result = runInNewContext(
      directProxyWorkerPrelude(44433, 54321) +
        `
        const direct = new WebTransport('https://127.0.0.1:44433/session', options);
        const edge = new WebTransport('https://[::1]:46331/', options);
        ({ direct, edge });
      `,
      {
        WebTransport: NativeTransport,
        URL,
        options,
        console: { info: (...args: unknown[]) => messages.push(args) },
      },
    );
    expect(result.direct).toBeInstanceOf(NativeTransport);
    expect(result.edge).toBeInstanceOf(NativeTransport);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://[::1]:54321/session');
    expect(calls[0]?.options).toBe(options);
    expect(calls[1]?.url).toBe('https://[::1]:46331/');
    expect(calls[1]?.options).toBe(options);
    expect(messages).toEqual([
      [DIRECT_PROXY_DIAL_MARKER, 'https://127.0.0.1:44433/session', 'https://[::1]:54321/session'],
    ]);
  });

  test('refuses an unexpected non-loopback direct candidate instead of allowing bypass', () => {
    expect(() =>
      runInNewContext(
        `${directProxyWorkerPrelude(44433, 54321)}new WebTransport('https://192.0.2.4:44433')`,
        { WebTransport: class {}, URL },
      ),
    ).toThrow('unexpected direct backend candidate');
  });

  test('validates exact ports before installing any interception', () => {
    for (const port of [0, -1, 1023, 65536, Number.NaN, 4000.5]) {
      expect(() => directProxyWorkerPrelude(port, 54321)).toThrow('invalid direct proxy port');
    }
    expect(() => directProxyWorkerPrelude(44433, 44433)).toThrow('cannot target itself');
  });
});
