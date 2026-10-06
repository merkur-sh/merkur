/**
 * Pooled storage for the reliable lanes' length-prefixed wire records.
 *
 * A provider's `send(channel, sealed, length)` is handed the Noise session's
 * full-capacity output view, valid only until the next seal, so the record
 * that goes onto the stream — `[u32 BE length][sealed[0..length)]` — has to be
 * copied into storage the provider owns. That storage used to be a fresh
 * `Uint8Array` per frame (`encodePayloadFrame`), retained by the platform
 * stream until the write settled and then garbage. Here it comes from a pool
 * and goes back once `writer.write()` resolves, in the shape of
 * `terminal/retained-wire-payload-pool.ts`: newest-first reuse so a steady
 * stream of same-sized keystroke records hits in one comparison, storage
 * accepted only between the requested size and twice it so a keystroke never
 * squats in a paste's buffer, and a bounded free list.
 *
 * The exact-length view the stream is handed is cached on the frame and
 * re-minted only when the frame's length changes, so the steady state mints
 * nothing at all.
 */

export interface PooledWireFrame {
  /** `[u32 BE length][sealed]`, exactly `4 + length` bytes, valid until released. */
  readonly bytes: Uint8Array;
}

export interface WireFramePool {
  /** Copy `sealed[0..length)` behind a length prefix into pooled storage. */
  acquire(sealed: Uint8Array, length: number): PooledWireFrame;
  /** Return a frame the stream has settled; a second release of the same frame is ignored. */
  release(frame: PooledWireFrame): void;
  availableCount(): number;
}

const WIRE_FRAME_LENGTH_PREFIX_BYTES = 4;
/** Below this a byte loop beats `set` plus the exact-length view it would need. */
const INLINE_COPY_MAX_BYTES = 256;

/**
 * Copy `sealed[0..length)` to `destination[offset..]` without minting a view
 * for the common case. An exact-length source (a recovered frame, a cold
 * `sealStream` copy) is one `set`; a short prefix of a longer view — every
 * keystroke lent out of the Noise output buffer — is a byte loop; only a long
 * prefix (a paste) pays one `subarray` for the memcpy.
 */
export function copySealedBytes(
  sealed: Uint8Array,
  length: number,
  destination: Uint8Array,
  offset: number,
): void {
  if (length === sealed.byteLength) {
    destination.set(sealed, offset);
    return;
  }
  if (length <= INLINE_COPY_MAX_BYTES) {
    for (let index = 0; index < length; index += 1) {
      destination[offset + index] = sealed[index] ?? 0;
    }
    return;
  }
  destination.set(sealed.subarray(0, length), offset);
}

export function createWireFramePool(maxAvailable = 64): WireFramePool {
  if (!Number.isSafeInteger(maxAvailable) || maxAvailable < 0) {
    throw new RangeError('wire frame pool capacity must be a non-negative integer');
  }
  const available: PooledFrame[] = [];

  class PooledFrame implements PooledWireFrame {
    bytes: Uint8Array;
    held = false;

    constructor(readonly storage: Uint8Array) {
      this.bytes = storage;
    }

    fill(sealed: Uint8Array, length: number): void {
      const frameBytes = WIRE_FRAME_LENGTH_PREFIX_BYTES + length;
      if (this.bytes.byteLength !== frameBytes) {
        this.bytes = this.storage.subarray(0, frameBytes);
      }
      const bytes = this.bytes;
      bytes[0] = (length >>> 24) & 0xff;
      bytes[1] = (length >>> 16) & 0xff;
      bytes[2] = (length >>> 8) & 0xff;
      bytes[3] = length & 0xff;
      copySealedBytes(sealed, length, bytes, WIRE_FRAME_LENGTH_PREFIX_BYTES);
      this.held = true;
    }
  }

  return {
    acquire(sealed, length): PooledWireFrame {
      if (!Number.isSafeInteger(length) || length < 0 || length > sealed.byteLength) {
        throw new RangeError('wire frame length is outside the lent view');
      }
      const frameBytes = WIRE_FRAME_LENGTH_PREFIX_BYTES + length;
      let storageIndex = available.length;
      for (let index = available.length - 1; index >= 0; index -= 1) {
        const storageBytes = available[index]?.storage.byteLength ?? 0;
        if (storageBytes >= frameBytes && storageBytes <= frameBytes * 2) {
          storageIndex = index;
          break;
        }
      }
      const retained = available[storageIndex];
      if (retained !== undefined) {
        if (storageIndex === available.length - 1) {
          available.pop();
        } else {
          available.copyWithin(storageIndex, storageIndex + 1);
          available.length -= 1;
        }
      }
      const frame = retained ?? new PooledFrame(new Uint8Array(frameBytes));
      frame.fill(sealed, length);
      return frame;
    },

    release(frame): void {
      if (!(frame instanceof PooledFrame) || !frame.held) return;
      frame.held = false;
      if (available.length < maxAvailable) available.push(frame);
    },

    availableCount(): number {
      return available.length;
    },
  };
}
