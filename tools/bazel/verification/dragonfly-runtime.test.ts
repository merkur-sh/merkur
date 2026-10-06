import { expect, test } from 'bun:test';
import os from 'node:os';
import { dragonflyCommand, dragonflyPort } from './dragonfly-runtime';

const information = '# Server\r\ndragonfly_version:df-v2.0.0\r\ntcp_port:49237\r\n';

test('the exact authenticated native facts determine the ephemeral endpoint', () => {
  const configuration = Object.assign(Object.create(null), { port: '49237' });
  expect(dragonflyPort(configuration, information)).toBe(49237);
});

test('Redis-compatible replies cannot substitute another backend, version or listener', () => {
  expect(() => dragonflyPort({ port: '49237' }, '# Server\r\nredis_version:7.2.0\r\n')).toThrow(
    'declared Dragonfly',
  );
  expect(() =>
    dragonflyPort({ port: '49237' }, information.replace('df-v2.0.0', 'df-v2.0.1')),
  ).toThrow('declared Dragonfly');
  expect(() => dragonflyPort({ port: '49238' }, information)).toThrow('bound port');
  expect(() => dragonflyPort({ port: '49237' }, `${information}tcp_port:49237\r\n`)).toThrow(
    'ambiguous',
  );
});

test('invalid or disabled ports and malformed protocol replies cannot admit a fixture', () => {
  for (const port of ['0', '-1', '65536', '04', '4e2', '', 49237, null])
    expect(() => dragonflyPort({ port }, information)).toThrow();
  for (const reply of [null, [], ['port', '49237'], '49237'])
    expect(() => dragonflyPort(reply, information)).toThrow('native RESP3 map');
  expect(() => dragonflyPort({ port: '49237' }, null)).toThrow('absent');
  expect(() => dragonflyPort({ port: '49237' }, 'not an INFO fact\r\n')).toThrow('malformed');
});

test('native launch has no shell, Docker, downloads or released port reservation', () => {
  const directory = '/private/tmp/dragonfly-command-control';
  const command = dragonflyCommand(
    process.execPath,
    process.execPath,
    os.tmpdir(),
    directory,
    'fixture-only-password',
  );
  expect(command.slice(0, 5)).toEqual([
    process.execPath,
    '--inhibit-cache',
    '--library-path',
    os.tmpdir(),
    process.execPath,
  ]);
  expect(command).toContain('--port=-1');
  expect(command).toContain('--bind=127.0.0.1');
  expect(command).toContain('--version_check=false');
  expect(command).toContain('--unixsocket=/private/tmp/dragonfly-command-control/redis.sock');
  expect(command).toContain('--requirepass=fixture-only-password');
  expect(() =>
    dragonflyCommand('dragonfly', process.execPath, os.tmpdir(), directory, 'fixture'),
  ).toThrow('declared native');
});
