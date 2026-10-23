import { describe, expect, test } from 'bun:test';
import { nativeNetworkCommand } from './native-network-namespace';

describe('native NAT-lab process placement', () => {
  test('ordinary fixtures keep the same executable and arguments', () => {
    expect(nativeNetworkCommand('client', '/client', ['headless'], {}, 'darwin')).toEqual({
      executable: '/client',
      args: ['headless'],
    });
  });

  test('each role enters only its named lab namespace without a shell', () => {
    const environment = {
      MERKUR_E2E_DAEMON_NETNS: 'merkur-natlab-daemon',
      MERKUR_E2E_CLIENT_NETNS: 'merkur-natlab-client',
    };
    expect(nativeNetworkCommand('client', '/client', ['headless'], environment, 'linux')).toEqual({
      executable: 'ip',
      args: ['netns', 'exec', 'merkur-natlab-client', '/client', 'headless'],
    });
    expect(
      nativeNetworkCommand('daemon', 'bun', ['run', 'daemon'], environment, 'linux').args,
    ).toEqual(['netns', 'exec', 'merkur-natlab-daemon', 'bun', 'run', 'daemon']);
  });

  test('unsupported platforms and names are rejected', () => {
    expect(() =>
      nativeNetworkCommand(
        'client',
        '/client',
        [],
        {
          MERKUR_E2E_CLIENT_NETNS: 'merkur-natlab-client',
        },
        'darwin',
      ),
    ).toThrow('isolated Linux');
    expect(() =>
      nativeNetworkCommand(
        'client',
        '/client',
        [],
        {
          MERKUR_E2E_CLIENT_NETNS: 'unrelated',
        },
        'linux',
      ),
    ).toThrow('isolated Linux');
  });
});
