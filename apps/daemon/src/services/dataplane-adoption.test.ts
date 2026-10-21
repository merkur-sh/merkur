import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  createSidecarFrame,
  SidecarFrameReader,
  type spawnFramedSidecarProcess,
} from '@merkur/shared/node-sidecar';

import {
  adoptingSpawnSidecar,
  DATAPLANE_ADOPT_ENV,
  encodeDataplaneAdoption,
  takeDataplaneAdoption,
} from './dataplane-adoption';
import type { DataplaneSidecarProcess } from './dataplane-client';

const SPAWN_OPTIONS: Parameters<typeof spawnFramedSidecarProcess>[3] = {
  args: ['--shell', '/bin/sh'],
  defaultRustLog: 'info',
  stderrEvent: 'dataplane_stderr',
  logInfo: () => {},
};

describe('dataplane adoption', () => {
  test('is read once, from its frozen shape, and leaves the environment', () => {
    const env: NodeJS.ProcessEnv = {
      [DATAPLANE_ADOPT_ENV]: encodeDataplaneAdoption({ pid: 4242, socketPath: '/r/d.sock' }),
    };
    expect(env[DATAPLANE_ADOPT_ENV]).toBe('4242:/r/d.sock');
    expect(takeDataplaneAdoption(env)).toEqual({ pid: 4242, socketPath: '/r/d.sock' });
    expect(DATAPLANE_ADOPT_ENV in env).toBe(false);
    expect(takeDataplaneAdoption(env)).toBeNull();
    for (const value of ['4242', '0:/r', 'x:/r', '42:relative']) {
      expect(() => takeDataplaneAdoption({ [DATAPLANE_ADOPT_ENV]: value })).toThrow();
    }
  });

  test('adopts over the socket first, with the spawn arguments, and spawns every replacement', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-adopt-'));
    const socketPath = path.join(directory, 'd.sock');
    const firstBytes = Promise.withResolvers<Buffer>();
    const accepted = Promise.withResolvers<net.Socket>();
    const server = net.createServer((socket) => {
      socket.once('data', (chunk: Buffer) => firstBytes.resolve(chunk));
      accepted.resolve(socket);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const spawned: string[] = [];
    const replacement = adoptingSpawnSidecar({ pid: process.pid, socketPath }, (binaryPath) => {
      spawned.push(binaryPath);
      const spawnedSidecar: DataplaneSidecarProcess = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      return spawnedSidecar;
    });
    try {
      const frame = Promise.withResolvers<[number, string]>();
      const sidecar = replacement(
        '/unused/merkur-dataplane',
        new SidecarFrameReader(),
        (kind, payload) => frame.resolve([kind, new TextDecoder().decode(payload)]),
        SPAWN_OPTIONS,
      );
      expect(sidecar.pid).toBe(process.pid);
      const peer = await accepted.promise;
      const first = await firstBytes.promise;
      expect(first[0]).toBe(0x16);
      expect(JSON.parse(first.subarray(5).toString('utf8'))).toEqual({
        args: ['--shell', '/bin/sh'],
      });
      peer.write(createSidecarFrame(0x82, new TextEncoder().encode('{"pid":7}')));
      expect(await frame.promise).toEqual([0x82, '{"pid":7}']);

      const closed = new Promise<[unknown, unknown]>((resolve) =>
        sidecar.on('close', (code, signal) => resolve([code, signal])),
      );
      peer.end();
      expect(await closed).toEqual([null, null]);

      replacement('/bin/merkur-dataplane', new SidecarFrameReader(), () => {}, SPAWN_OPTIONS);
      expect(spawned).toEqual(['/bin/merkur-dataplane']);
    } finally {
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
