import { EventEmitter } from 'node:events';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import {
  encodeSidecarCommand,
  processFramedSidecarChunk,
  type spawnFramedSidecarProcess,
} from '@merkur/shared/node-sidecar';

import { CMD_ADOPT, type DataplaneSidecarProcess } from './dataplane-client';

/**
 * How an owner that replaced itself at an upgrade finds the dataplane it already started:
 * `<pid>:<absolute socket path>`. One of the frozen cross-release contracts
 * (docs/releases.md, Convergence): the previous release sets it on its `execve`, this
 * release reads it, so its shape never changes.
 */
export const DATAPLANE_ADOPT_ENV = 'MERKUR_DATAPLANE_ADOPT';

export interface DataplaneAdoption {
  /** The dataplane, still this process's child: the pid survives both `execve`s. */
  readonly pid: number;
  /** Where it accepts this process, and only this process, as its owner. */
  readonly socketPath: string;
}

export function encodeDataplaneAdoption(adoption: DataplaneAdoption): string {
  return `${adoption.pid}:${adoption.socketPath}`;
}

/**
 * Reads the adoption this process was started with, once, and removes it from the
 * environment so nothing it spawns later inherits it.
 */
export function takeDataplaneAdoption(
  env: Record<string, string | undefined> = process.env,
): DataplaneAdoption | null {
  const value = env[DATAPLANE_ADOPT_ENV];
  delete env[DATAPLANE_ADOPT_ENV];
  if (value === undefined) return null;
  const match = /^([1-9]\d*):(\/.+)$/.exec(value);
  const pid = Number(match?.[1]);
  const socketPath = match?.[2];
  if (socketPath === undefined || !Number.isSafeInteger(pid)) {
    throw new Error(`${DATAPLANE_ADOPT_ENV} is not <pid>:<absolute socket path>`);
  }
  return { pid, socketPath };
}

type SpawnSidecar = (
  ...args: Parameters<typeof spawnFramedSidecarProcess>
) => DataplaneSidecarProcess;

/**
 * The dataplane client's spawn, which adopts the running dataplane the first time it is
 * asked for one and spawns every replacement after it. A replacement is a fresh dataplane
 * with a fresh shell, exactly what a spawn after a crash is.
 */
export function adoptingSpawnSidecar(
  adoption: DataplaneAdoption,
  spawn: SpawnSidecar,
  connect: (path: string) => net.Socket = (path) => net.connect({ path }),
): SpawnSidecar {
  let adopted = false;
  return (binaryPath, frameReader, handleFrame, options) => {
    if (adopted) return spawn(binaryPath, frameReader, handleFrame, options);
    adopted = true;
    frameReader.clear();
    const socket = connect(adoption.socketPath);
    // The arguments a spawn would pass on the command line, ahead of every command.
    socket.write(encodeSidecarCommand(CMD_ADOPT, { args: options.args ?? [] }));
    socket.on('data', (chunk: Buffer) => {
      processFramedSidecarChunk(frameReader, chunk, handleFrame, (error) => {
        if (options.onFrameError === undefined) throw error;
        options.onFrameError(error);
      });
    });
    return new AdoptedSidecar(adoption.pid, socket);
  };
}

/**
 * The adopted dataplane as the client supervises a spawned one. Its commands and events
 * share the socket, and its stderr already goes where this process's does. Its exit is the
 * socket closing: it is this process's child by pid, but no handle of this runtime spawned
 * it, so its exit status is not this process's to read.
 */
class AdoptedSidecar extends EventEmitter implements DataplaneSidecarProcess {
  readonly stdin: net.Socket;
  readonly stdout: net.Socket;
  readonly stderr = new PassThrough();

  constructor(
    readonly pid: number,
    socket: net.Socket,
  ) {
    super();
    this.stdin = socket;
    this.stdout = socket;
    this.stderr.end();
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', () => this.emit('close', null, null));
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    try {
      process.kill(this.pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}
