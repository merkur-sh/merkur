export interface RetainedWirePayload {
  readonly bytes: Uint8Array;
  readonly storageBytes: number;
  /** Exact backing-store bytes requested by this acquisition; zero on reuse. */
  readonly allocationRequestedBytes: number;
  /** One payload object + one typed-array backing request on a pool miss. */
  readonly objectAllocationRequestCount: number;
  readonly releaseCallback: () => void;
  reset(source: Uint8Array): void;
  retain(): void;
  release(): void;
}

export interface RetainedWirePayloadPool {
  acquire(source: Uint8Array): RetainedWirePayload;
  availableCount(): number;
}

/**
 * Reuse owning display-wire copies across asynchronous assembly and queueing.
 * The source may be a shared-ring lease and is therefore always copied before
 * the reader advances.
 */
export function createRetainedWirePayloadPool(maxAvailable = 64): RetainedWirePayloadPool {
  if (!Number.isSafeInteger(maxAvailable) || maxAvailable < 0) {
    throw new RangeError('retained wire payload pool capacity must be a non-negative integer');
  }
  const available: PooledWirePayload[] = [];

  class PooledWirePayload implements RetainedWirePayload {
    bytes: Uint8Array;
    references = 0;
    allocationRequestedBytes = 0;
    objectAllocationRequestCount = 0;
    readonly releaseCallback = (): void => this.release();

    constructor(private readonly storage: Uint8Array) {
      this.bytes = storage;
    }

    get storageBytes(): number {
      return this.storage.byteLength;
    }

    reset(source: Uint8Array): void {
      if (this.bytes.byteLength !== source.byteLength) {
        this.bytes = this.storage.subarray(0, source.byteLength);
      }
      this.bytes.set(source);
      this.references = 1;
    }

    retain(): void {
      this.references += 1;
    }

    release(): void {
      if (this.references === 0) return;
      this.references -= 1;
      if (this.references === 0 && available.length < maxAvailable) available.push(this);
    }
  }

  return {
    acquire(source): RetainedWirePayload {
      const sourceLength = source.byteLength;
      let storageIndex = available.length;
      // The payload returned by the immediately preceding frame is the hottest
      // storage and sits at the tail. Search newest-first so steady frame sizes
      // hit in one comparison and preserve cache locality.
      for (let index = available.length - 1; index >= 0; index -= 1) {
        const storageBytes = available[index]?.storageBytes ?? 0;
        if (storageBytes >= sourceLength && storageBytes <= sourceLength * 2) {
          storageIndex = index;
          break;
        }
      }
      const retained = available[storageIndex];
      if (retained !== undefined) {
        if (storageIndex === available.length - 1) {
          available.pop();
        } else {
          // Preserve the remaining order without `splice` allocating a
          // one-element result array.
          available.copyWithin(storageIndex, storageIndex + 1);
          available.length -= 1;
        }
      }
      const result = retained ?? new PooledWirePayload(new Uint8Array(source.byteLength));
      result.allocationRequestedBytes = retained === undefined ? source.byteLength : 0;
      // A miss requests the typed array and payload objects. Reusing storage at
      // a different logical length still requests one `subarray` view object;
      // same-sized reuse requests nothing.
      result.objectAllocationRequestCount =
        retained === undefined ? 2 : retained.bytes.byteLength === sourceLength ? 0 : 1;
      result.reset(source);
      return result;
    },

    availableCount(): number {
      return available.length;
    },
  };
}
