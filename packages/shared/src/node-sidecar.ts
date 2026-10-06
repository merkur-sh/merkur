import { Buffer } from 'node:buffer';
import {
  type ChildProcessWithoutNullStreams,
  spawn as spawnChildProcess,
} from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const FRAME_HEADER_BYTES = 5;
const UTF8_ENCODER = new TextEncoder();

/**
 * Maximum sidecar IPC payload size, in bytes. MUST equal the Rust dataplane's
 * `apps/daemon/dataplane/src/ipc/mod.rs::MAX_PAYLOAD_BYTES` (512 KiB). The Rust
 * reader treats any larger declared length as fatal `InvalidData` and tears the
 * IPC loop down, so both ends of the framed stream must agree on this ceiling.
 * If you change one side, change the other in the same commit.
 */
export const MAX_SIDECAR_PAYLOAD_BYTES = 512 * 1024;

/**
 * Raised when a sidecar frame's payload exceeds {@link MAX_SIDECAR_PAYLOAD_BYTES}.
 * On the write side it is thrown before any bytes hit the stream, so a rejected
 * command can never desync the framing. On the read side it signals a
 * stale/corrupt dataplane emitting a bogus length that would otherwise buffer
 * unboundedly.
 */
export class SidecarPayloadTooLargeError extends Error {
  readonly kind: number;
  readonly payloadBytes: number;
  readonly maxPayloadBytes: number;

  constructor(kind: number, payloadBytes: number) {
    super(
      `Sidecar frame payload of ${payloadBytes} bytes for kind 0x${kind.toString(16)} exceeds the ${MAX_SIDECAR_PAYLOAD_BYTES}-byte cap`,
    );
    this.name = 'SidecarPayloadTooLargeError';
    this.kind = kind;
    this.payloadBytes = payloadBytes;
    this.maxPayloadBytes = MAX_SIDECAR_PAYLOAD_BYTES;
  }
}

export class SidecarFrameReader {
  private readBufferedBytes = 0;
  private readQueue: Array<Uint8Array | undefined> = [];
  private readQueueStart = 0;

  clear(): void {
    this.readQueue.length = 0;
    this.readQueueStart = 0;
    this.readBufferedBytes = 0;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.readQueue.push(chunk);
    this.readBufferedBytes += chunk.length;
  }

  processFrames(handleFrame: (kind: number, payload: Uint8Array) => void): void {
    while (this.readBufferedBytes >= FRAME_HEADER_BYTES) {
      const first = this.readQueue[this.readQueueStart];
      if (first === undefined) break;

      if (first.length >= FRAME_HEADER_BYTES) {
        const kind = first[0] ?? 0;
        const payloadLength =
          (((first[1] ?? 0) << 24) |
            ((first[2] ?? 0) << 16) |
            ((first[3] ?? 0) << 8) |
            (first[4] ?? 0)) >>>
          0;
        // A bogus length from a stale/corrupt dataplane would otherwise buffer
        // up to 4 GiB. Fail loudly instead of stalling silently.
        if (payloadLength > MAX_SIDECAR_PAYLOAD_BYTES) {
          throw new SidecarPayloadTooLargeError(kind, payloadLength);
        }
        const frameLength = FRAME_HEADER_BYTES + payloadLength;

        if (this.readBufferedBytes < frameLength) break;

        if (first.length >= frameLength) {
          const payload = first.subarray(FRAME_HEADER_BYTES, frameLength);
          if (first.length === frameLength) {
            this.dropFirstChunk();
          } else {
            this.readQueue[this.readQueueStart] = first.subarray(frameLength);
          }
          this.readBufferedBytes -= frameLength;
          handleFrame(kind, payload);
          continue;
        }
      }

      const headerBytes = this.peekBytes(FRAME_HEADER_BYTES);
      if (headerBytes === null) break;

      const header = new DataView(
        headerBytes.buffer,
        headerBytes.byteOffset,
        headerBytes.byteLength,
      );
      const kind = header.getUint8(0);
      const payloadLength = header.getUint32(1);
      // A bogus length from a stale/corrupt dataplane would otherwise buffer up
      // to 4 GiB. Fail loudly instead of stalling silently.
      if (payloadLength > MAX_SIDECAR_PAYLOAD_BYTES) {
        throw new SidecarPayloadTooLargeError(kind, payloadLength);
      }
      const frameLength = FRAME_HEADER_BYTES + payloadLength;

      if (this.readBufferedBytes < frameLength) break;

      this.advanceReadQueue(FRAME_HEADER_BYTES);
      handleFrame(kind, this.takeReadBytes(payloadLength));
    }
  }

  private peekBytes(count: number): Uint8Array | null {
    if (this.readBufferedBytes < count) {
      return null;
    }

    const result = new Uint8Array(count);
    let offset = 0;
    for (let index = this.readQueueStart; index < this.readQueue.length; index += 1) {
      const chunk = this.readQueue[index];
      if (chunk === undefined) continue;
      const needed = count - offset;
      const available = Math.min(chunk.length, needed);
      result.set(chunk.subarray(0, available), offset);
      offset += available;
      if (offset >= count) {
        break;
      }
    }
    return result;
  }

  private advanceReadQueue(count: number): void {
    let remaining = count;
    while (remaining > 0 && this.readQueueStart < this.readQueue.length) {
      const chunk = this.readQueue[this.readQueueStart];
      if (chunk === undefined) {
        break;
      }
      if (chunk.length <= remaining) {
        remaining -= chunk.length;
        this.dropFirstChunk();
      } else {
        this.readQueue[this.readQueueStart] = chunk.subarray(remaining);
        remaining = 0;
      }
    }
    this.readBufferedBytes -= count;
  }

  private takeReadBytes(count: number): Uint8Array {
    if (count === 0) {
      return new Uint8Array(0);
    }

    const result = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const chunk = this.readQueue[this.readQueueStart];
      if (chunk === undefined) {
        throw new Error('Sidecar read buffer underflow');
      }
      const needed = count - offset;
      if (chunk.length <= needed) {
        result.set(chunk, offset);
        offset += chunk.length;
        this.dropFirstChunk();
      } else {
        result.set(chunk.subarray(0, needed), offset);
        this.readQueue[this.readQueueStart] = chunk.subarray(needed);
        offset = count;
      }
    }
    this.readBufferedBytes -= count;
    return result;
  }

  private dropFirstChunk(): void {
    if (this.readQueueStart >= this.readQueue.length) return;
    // Stream fragmentation can queue thousands of tiny chunks. Advancing a
    // cursor is O(1); Array.shift() copied the whole suffix for every fragment.
    this.readQueue[this.readQueueStart] = undefined;
    this.readQueueStart += 1;
    if (this.readQueueStart >= this.readQueue.length) {
      this.readQueue.length = 0;
      this.readQueueStart = 0;
    } else if (this.readQueueStart >= 64 && this.readQueueStart * 2 >= this.readQueue.length) {
      this.readQueue.copyWithin(0, this.readQueueStart);
      this.readQueue.length -= this.readQueueStart;
      this.readQueueStart = 0;
    }
  }
}

export function encodeSidecarCommand(kind: number, payload: object): Uint8Array {
  const json = JSON.stringify(payload) ?? '';
  const payloadBytes = Buffer.byteLength(json, 'utf8');
  if (payloadBytes > MAX_SIDECAR_PAYLOAD_BYTES) {
    throw new SidecarPayloadTooLargeError(kind, payloadBytes);
  }
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payloadBytes);
  frame.set(createSidecarHeader(kind, payloadBytes));
  const encoded = UTF8_ENCODER.encodeInto(json, frame.subarray(FRAME_HEADER_BYTES));
  if (encoded.read !== json.length || encoded.written !== payloadBytes) {
    throw new Error('Sidecar JSON frame encoding was unexpectedly truncated');
  }
  return frame;
}

export function createSidecarFrame(
  kind: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  // Fail fast BEFORE constructing or writing a header: the Rust reader rejects
  // an oversized declared length as fatal, and a partial frame would desync the
  // stream.
  if (payload.byteLength > MAX_SIDECAR_PAYLOAD_BYTES) {
    throw new SidecarPayloadTooLargeError(kind, payload.byteLength);
  }
  const header = createSidecarHeader(kind, payload.byteLength);
  const frame = new Uint8Array(header.byteLength + payload.byteLength);
  frame.set(header);
  frame.set(payload, header.byteLength);
  return frame;
}

export function writeSidecarCommand(stdin: Writable, kind: number, payload: object): void {
  // One write owns one complete frame. Besides avoiding partial frames, this
  // lets bounded callers stop exactly at a Writable backpressure boundary.
  stdin.write(encodeSidecarCommand(kind, payload));
}

export function isSidecarInputWritable(
  sidecar: { readonly stdin: Writable } | null,
): sidecar is { readonly stdin: Writable } {
  return (
    sidecar !== null &&
    !sidecar.stdin.destroyed &&
    !sidecar.stdin.writableEnded &&
    !sidecar.stdin.writableFinished &&
    sidecar.stdin.writable
  );
}

export function spawnSidecarProcess(
  binaryPath: string,
  options: {
    readonly args?: readonly string[];
    readonly defaultRustLog: string;
    readonly stderrEvent: string;
    readonly logInfo: (eventName: string, metadata: { readonly line: string }) => void;
    readonly onStdoutChunk: (chunk: Uint8Array) => void;
  },
): ChildProcessWithoutNullStreams {
  const child = spawnChildProcess(binaryPath, [...(options.args ?? [])], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: createSidecarProcessEnvironment(options.defaultRustLog),
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line.length > 0) {
      options.logInfo(options.stderrEvent, { line });
    }
  });

  child.stdout.on('data', (chunk: Buffer) => {
    options.onStdoutChunk(new Uint8Array(chunk));
  });

  return child;
}

export function createSidecarProcessEnvironment(
  defaultRustLog: string,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...inheritedEnvironment,
    RUST_LOG: inheritedEnvironment.RUST_LOG ?? defaultRustLog,
  };
}

export function spawnFramedSidecarProcess(
  binaryPath: string,
  frameReader: SidecarFrameReader,
  handleFrame: (kind: number, payload: Uint8Array) => void,
  options: {
    readonly args?: readonly string[];
    readonly defaultRustLog: string;
    readonly stderrEvent: string;
    readonly logInfo: (eventName: string, metadata: { readonly line: string }) => void;
    readonly onFrameError?: (error: unknown) => void;
  },
): ChildProcessWithoutNullStreams {
  frameReader.clear();
  return spawnSidecarProcess(binaryPath, {
    ...options,
    onStdoutChunk(chunk): void {
      processFramedSidecarChunk(frameReader, chunk, handleFrame, (error) => {
        if (options.onFrameError === undefined) throw error;
        options.onFrameError(error);
      });
    },
  });
}

export function processFramedSidecarChunk(
  frameReader: SidecarFrameReader,
  chunk: Uint8Array,
  handleFrame: (kind: number, payload: Uint8Array) => void,
  onFrameError: (error: unknown) => void,
): void {
  try {
    frameReader.push(chunk);
    frameReader.processFrames(handleFrame);
  } catch (error) {
    // A malformed sidecar must be restarted, not allowed to crash the parent
    // Bun process. Clear the poisoned prefix before delegating supervision.
    frameReader.clear();
    onFrameError(error);
  }
}

export function createSidecarHeader(kind: number, payloadLength = 0): Uint8Array {
  const header = new Uint8Array(FRAME_HEADER_BYTES);
  header[0] = kind & 0xff;
  const len = payloadLength >>> 0;
  header[1] = (len >>> 24) & 0xff;
  header[2] = (len >>> 16) & 0xff;
  header[3] = (len >>> 8) & 0xff;
  header[4] = len & 0xff;
  return header;
}

export function resolveSidecarBinaryPath(options: {
  readonly envKey: string;
  readonly binaryName: string;
  readonly moduleUrl: string;
  readonly appDirectory: 'daemon' | 'server';
  readonly rustTargetReleaseSubdirectory: string;
}): string | null {
  const explicitPath = process.env[options.envKey];
  if (typeof explicitPath === 'string' && explicitPath.trim().length > 0) {
    const normalizedPath = path.resolve(explicitPath.trim());
    return isExecutablePath(normalizedPath) ? normalizedPath : null;
  }

  const moduleDirectory = path.dirname(fileURLToPath(options.moduleUrl));
  const candidates = [
    // Compiled binaries: module URLs point into Bun's embedded virtual
    // filesystem, so look next to the real on-disk executable first.
    path.resolve(path.dirname(process.execPath), options.binaryName),
    path.resolve(moduleDirectory, options.binaryName),
    path.resolve(moduleDirectory, '..', '..', 'dist', options.binaryName),
    path.resolve(process.cwd(), 'dist', options.binaryName),
    path.resolve(process.cwd(), 'apps', options.appDirectory, 'dist', options.binaryName),
    path.resolve(process.cwd(), options.rustTargetReleaseSubdirectory, options.binaryName),
    path.resolve(
      process.cwd(),
      '..',
      '..',
      options.rustTargetReleaseSubdirectory,
      options.binaryName,
    ),
    path.resolve(
      moduleDirectory,
      '..',
      '..',
      '..',
      '..',
      options.rustTargetReleaseSubdirectory,
      options.binaryName,
    ),
  ];

  return candidates.find(isExecutablePath) ?? null;
}

export function isExecutablePath(pathToExecutable: string): boolean {
  try {
    accessSync(pathToExecutable, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
