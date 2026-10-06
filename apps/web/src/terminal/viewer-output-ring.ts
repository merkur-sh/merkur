import { readerNeedsWakeAfterPublish } from '../lib/spsc-ring-wake';

/**
 * Viewer-output ring (terminal worker → transport worker): what the Rust
 * viewer asks its session to send. Display ACKs at presentation rate, and the
 * rarer snapshot, resync, dictionary, resume and graphics-demand requests.
 *
 * It is the frame ring's counterpart in the other direction, and bounded the
 * same way: a transport worker that falls behind leaves the terminal worker
 * holding one output, which the viewer keeps coalescing behind, instead of a
 * port queue that grows with every presentation. Neither side mints an object
 * per output. The writer copies an output's words and bytes from the viewer's
 * linear memory into its entry, and the reader copies them from the entry
 * into the session's.
 *
 * meta (Int32Array):
 *   [0]: writeOffset (bytes into the data area; writer-owned)
 *   [1]: readOffset  (bytes into the data area; reader-owned)
 *   [2]: refusals    (writes refused because the ring had no room)
 *   [3]: wake sequence, the word the reader parks on
 *
 * Each entry occupies an 8-byte-aligned slot:
 *   [0-3]:   payload length (u32). Seven words lead every output, so a real
 *            length is at least 28 and 0 is the skip-to-start marker.
 *   [4]:     output kind, as the viewer's `poll_output` returns it
 *   [5-7]:   reserved
 *   [8-11]:  display lineage the output was polled under
 *   [12-15]: frame fence token it was polled under
 *   [16..]:  payload: the seven words, then the output's bytes
 *
 * The wake follows the frame ring's proof. The writer stores its cursor, then
 * bumps the wake word and notifies when the reader may have parked; the reader
 * snapshots the word, reads the cursors, and parks on the snapshot. A writer
 * may also carry a task edge for a reader that parks on a task instead of the
 * word; which a reader does is decided by the realm that constructs it.
 */

const META_WORDS = 4;
const META_BYTES = META_WORDS * 4;
const ENTRY_HEADER_BYTES = 16;
const ENTRY_ALIGN = 8;
const SKIP_MARKER = 0;
const WAKE_INDEX = 3;
// A coarse last resort if both the native and the task wake fail, as the
// frame ring keeps one.
const WAIT_WATCHDOG_MS = 30_000;

/** Seven `u32` words lead every viewer output. */
export const VIEWER_OUTPUT_WORDS_BYTES = 28;
/**
 * The largest byte body one output carries, `ClientViewer.output_max_bytes()`.
 * The terminal worker checks the two agree before it writes an entry.
 */
export const VIEWER_OUTPUT_MAX_BYTES = 4096;
/**
 * The transport worker's wake-port edge after it drained a ring that had
 * refused an output: the terminal worker writes the one it holds. Numeric like
 * the other port edges, and distinct from the task-mode ring wake (zero).
 */
export const VIEWER_OUTPUT_SPACE_EDGE = 3;

/**
 * Recovery wake for a natively parked reader: a suspended WebKit worker can
 * lose an `Atomics.notify`. A pure notify, since a reader that has not parked
 * yet reads the ring itself before it does.
 */
export function wakeViewerOutputRingReader(sab: SharedArrayBuffer): number {
  return Atomics.notify(new Int32Array(sab, 0, META_WORDS), WAKE_INDEX, 1);
}

function alignUp(n: number, align: number): number {
  return (n + align - 1) & ~(align - 1);
}

const MAX_SLOT_BYTES = alignUp(
  ENTRY_HEADER_BYTES + VIEWER_OUTPUT_WORDS_BYTES + VIEWER_OUTPUT_MAX_BYTES,
  ENTRY_ALIGN,
);

// Two maximum slots and their empty-sentinel space: a maximum output fits at
// every cursor of an empty ring, on either side of the wrap.
export const VIEWER_OUTPUT_RING_SIZE = META_BYTES + 2 * (MAX_SLOT_BYTES + ENTRY_ALIGN);

/** An output's payload where it lies, copied out once into the ring. */
export interface ViewerOutputSource {
  readonly byteLength: number;
  copyTo(destination: Uint8Array, destinationOffset: number): void;
}

export interface ViewerOutputRingWriter {
  /**
   * Publish one output. False when the ring has no room: the refusal is
   * counted before this returns, so a writer that tries once more at once
   * either finds the room the reader freed or is owed the reader's
   * `VIEWER_OUTPUT_SPACE_EDGE`. Throws for a payload no entry can hold.
   */
  write(
    kind: number,
    lineage: number,
    frameFenceToken: number,
    payload: ViewerOutputSource,
  ): boolean;
}

export function createViewerOutputRingWriter(
  sab: SharedArrayBuffer,
  onReadableEdge?: () => void,
): ViewerOutputRingWriter {
  const meta = new Int32Array(sab, 0, META_WORDS);
  const dataView = new DataView(sab, META_BYTES);
  const dataBytes = new Uint8Array(sab, META_BYTES);
  const capacity = sab.byteLength - META_BYTES;

  return {
    write(kind, lineage, frameFenceToken, payload): boolean {
      const payloadLen = payload.byteLength;
      if (
        payloadLen < VIEWER_OUTPUT_WORDS_BYTES ||
        payloadLen > VIEWER_OUTPUT_WORDS_BYTES + VIEWER_OUTPUT_MAX_BYTES
      ) {
        throw new RangeError(`viewer output of ${payloadLen} bytes fits no ring entry`);
      }
      const slotSize = alignUp(ENTRY_HEADER_BYTES + payloadLen, ENTRY_ALIGN);
      const writeOff = Atomics.load(meta, 0);
      const readOff = Atomics.load(meta, 1);

      // One alignment unit always stays free, so equal cursors mean empty.
      let pos: number;
      if (writeOff >= readOff) {
        if (writeOff + slotSize + ENTRY_ALIGN <= capacity) {
          pos = writeOff;
        } else if (slotSize + ENTRY_ALIGN <= readOff) {
          dataView.setUint32(writeOff, SKIP_MARKER, true);
          pos = 0;
        } else {
          Atomics.add(meta, 2, 1);
          return false;
        }
      } else if (writeOff + slotSize + ENTRY_ALIGN <= readOff) {
        pos = writeOff;
      } else {
        Atomics.add(meta, 2, 1);
        return false;
      }

      // The entry is invisible until the cursor store below.
      dataView.setUint32(pos, payloadLen, true);
      dataView.setUint32(pos + 4, kind & 0xff, true);
      dataView.setUint32(pos + 8, lineage, true);
      dataView.setUint32(pos + 12, frameFenceToken, true);
      payload.copyTo(dataBytes, pos + ENTRY_HEADER_BYTES);
      Atomics.store(meta, 0, pos + slotSize);

      // The reader may have drained the old tail and parked while this entry
      // was being copied, though the first snapshot showed it busy.
      if (readerNeedsWakeAfterPublish(writeOff, readOff, Atomics.load(meta, 1))) {
        Atomics.add(meta, WAKE_INDEX, 1);
        Atomics.notify(meta, WAKE_INDEX);
        try {
          onReadableEdge?.();
        } catch {
          // The entry is published and cannot be withdrawn; the reader's
          // watchdog is what remains if the task edge cannot be delivered.
        }
      }
      return true;
    },
  };
}

/**
 * The reader's view: one entry at a time, read in place. `nextLength` finds
 * the next entry and the accessors describe it until `consume` passes it.
 */
export interface ViewerOutputRingReader {
  /** Payload length of the next entry, or -1 when none is readable. */
  nextLength(): number;
  kind(): number;
  lineage(): number;
  frameFenceToken(): number;
  /** Copy that entry's payload: no view of it is minted. */
  copyPayload(destination: Uint8Array, destinationOffset: number): void;
  /** Advance past that entry and return its slot to the writer. */
  consume(): void;
  /**
   * Whether the writer was refused since the last call; read once a drain
   * finds the ring empty, and answered with `VIEWER_OUTPUT_SPACE_EDGE`.
   */
  takeRefusal(): boolean;
  /**
   * `'not-equal'` when an entry can be read now; otherwise the park promise,
   * resolved by a writer edge or the watchdog. The ring's state is the
   * signal, not the resolved value.
   */
  waitAsync(): Promise<unknown> | 'not-equal';
}

export function createViewerOutputRingReader(
  sab: SharedArrayBuffer,
  waitTimeoutMs = WAIT_WATCHDOG_MS,
  waitForReadableTask?: (watchdogMs: number) => Promise<void>,
): ViewerOutputRingReader {
  const meta = new Int32Array(sab, 0, META_WORDS);
  const dataView = new DataView(sab, META_BYTES);
  const dataBytes = new Uint8Array(sab, META_BYTES);
  // Refusals before this reader existed were answered by whoever read then.
  let refusalsTaken = Atomics.load(meta, 2);
  let entryOff = -1;
  let entryLen = 0;

  return {
    nextLength(): number {
      let readOff = Atomics.load(meta, 1);
      const writeOff = Atomics.load(meta, 0);
      entryOff = -1;
      if (readOff === writeOff) return -1;
      if (dataView.getUint32(readOff, true) === SKIP_MARKER) {
        readOff = 0;
        Atomics.store(meta, 1, 0);
        if (readOff === writeOff) return -1;
      }
      entryOff = readOff;
      entryLen = dataView.getUint32(readOff, true);
      return entryLen;
    },

    kind(): number {
      return entryOff < 0 ? 0 : dataView.getUint8(entryOff + 4);
    },

    lineage(): number {
      return entryOff < 0 ? 0 : dataView.getUint32(entryOff + 8, true);
    },

    frameFenceToken(): number {
      return entryOff < 0 ? 0 : dataView.getUint32(entryOff + 12, true);
    },

    copyPayload(destination: Uint8Array, destinationOffset: number): void {
      if (entryOff < 0) return;
      const start = entryOff + ENTRY_HEADER_BYTES;
      // `set` needs a source of exactly the payload's length, and a subarray
      // per output is the view this ring exists to stop minting. An ACK is a
      // few dozen bytes; copy them in place.
      for (let index = 0; index < entryLen; index += 1) {
        destination[destinationOffset + index] = dataBytes[start + index] ?? 0;
      }
    },

    consume(): void {
      if (entryOff < 0) return;
      Atomics.store(meta, 1, entryOff + alignUp(ENTRY_HEADER_BYTES + entryLen, ENTRY_ALIGN));
      entryOff = -1;
    },

    takeRefusal(): boolean {
      const refusals = Atomics.load(meta, 2);
      if (refusals === refusalsTaken) return false;
      refusalsTaken = refusals;
      return true;
    },

    waitAsync(): Promise<unknown> | 'not-equal' {
      const wakeSequence = Atomics.load(meta, WAKE_INDEX);
      if (Atomics.load(meta, 1) !== Atomics.load(meta, 0)) return 'not-equal';
      if (waitForReadableTask !== undefined) return waitForReadableTask(waitTimeoutMs);
      const result = Atomics.waitAsync(meta, WAKE_INDEX, wakeSequence, waitTimeoutMs);
      return result.async ? result.value : 'not-equal';
    },
  };
}
