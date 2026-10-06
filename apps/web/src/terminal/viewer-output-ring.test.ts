import { describe, expect, test } from 'bun:test';
import { createTaskWake } from '../lib/task-wake';
import {
  createViewerOutputRingReader,
  createViewerOutputRingWriter,
  VIEWER_OUTPUT_MAX_BYTES,
  VIEWER_OUTPUT_RING_SIZE,
  VIEWER_OUTPUT_WORDS_BYTES,
  type ViewerOutputRingReader,
  type ViewerOutputSource,
} from './viewer-output-ring';

/** Seven words and `bodyLength` bytes, every byte derived from `seed`. */
function output(bodyLength: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(VIEWER_OUTPUT_WORDS_BYTES + bodyLength);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state = (state * 1103515245 + 12345) >>> 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function source(bytes: Uint8Array): ViewerOutputSource {
  return {
    byteLength: bytes.byteLength,
    copyTo: (destination, destinationOffset) => destination.set(bytes, destinationOffset),
  };
}

interface Read {
  kind: number;
  lineage: number;
  frameFenceToken: number;
  payload: Uint8Array;
}

function read(reader: ViewerOutputRingReader): Read | null {
  const length = reader.nextLength();
  if (length < 0) return null;
  // Offset from zero, so a copy that ignored its destination offset would show.
  const destination = new Uint8Array(length + 3);
  reader.copyPayload(destination, 3);
  const entry = {
    kind: reader.kind(),
    lineage: reader.lineage(),
    frameFenceToken: reader.frameFenceToken(),
    payload: destination.subarray(3),
  };
  reader.consume();
  return entry;
}

describe('viewer output ring', () => {
  test('outputs arrive in order with the lineage and fence they were polled under', () => {
    const sab = new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE);
    const writer = createViewerOutputRingWriter(sab);
    const reader = createViewerOutputRingReader(sab);
    const ack = output(44, 1);
    const snapshot = output(0, 2);
    const resume = output(2048, 3);

    expect(writer.write(1, 7, 0xffff_fffe, source(ack))).toBe(true);
    expect(writer.write(2, 7, 0xffff_fffe, source(snapshot))).toBe(true);
    expect(writer.write(6, 8, 12, source(resume))).toBe(true);

    expect(read(reader)).toEqual({
      kind: 1,
      lineage: 7,
      frameFenceToken: 0xffff_fffe,
      payload: ack,
    });
    expect(read(reader)).toEqual({
      kind: 2,
      lineage: 7,
      frameFenceToken: 0xffff_fffe,
      payload: snapshot,
    });
    expect(read(reader)).toEqual({ kind: 6, lineage: 8, frameFenceToken: 12, payload: resume });
    expect(read(reader)).toBeNull();
  });

  test('an entry stays the next one until it is consumed', () => {
    const sab = new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE);
    const writer = createViewerOutputRingWriter(sab);
    const reader = createViewerOutputRingReader(sab);
    writer.write(1, 1, 1, source(output(8, 1)));
    writer.write(4, 1, 1, source(output(0, 2)));

    expect(reader.nextLength()).toBe(VIEWER_OUTPUT_WORDS_BYTES + 8);
    expect(reader.nextLength()).toBe(VIEWER_OUTPUT_WORDS_BYTES + 8);
    expect(reader.kind()).toBe(1);
    reader.consume();
    // A second consume has no entry to pass.
    reader.consume();
    expect(reader.nextLength()).toBe(VIEWER_OUTPUT_WORDS_BYTES);
    expect(reader.kind()).toBe(4);
  });

  test('outputs keep their bytes and order across many wraps', () => {
    const sab = new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE);
    const writer = createViewerOutputRingWriter(sab);
    const reader = createViewerOutputRingReader(sab);
    const queued: Uint8Array[] = [];
    for (let index = 0; index < 4000; index += 1) {
      const payload = output((index * 37) % 700, index);
      if (!writer.write(1 + (index % 7), index, index ^ 0x5a5a, source(payload))) {
        // Full: the reader takes everything, and the same output then fits.
        for (const expected of queued.splice(0)) expect(read(reader)?.payload).toEqual(expected);
        expect(writer.write(1 + (index % 7), index, index ^ 0x5a5a, source(payload))).toBe(true);
      }
      queued.push(payload);
    }
    for (const expected of queued) expect(read(reader)?.payload).toEqual(expected);
    expect(read(reader)).toBeNull();
  });

  test('a maximum output fits at every cursor of an empty ring', () => {
    const sab = new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE);
    const writer = createViewerOutputRingWriter(sab);
    const reader = createViewerOutputRingReader(sab);
    const largest = output(VIEWER_OUTPUT_MAX_BYTES, 9);
    // Small outputs walk the cursor round the ring; the largest follows each.
    for (let index = 0; index < 600; index += 1) {
      expect(writer.write(1, 1, 1, source(output(index % 90, index)))).toBe(true);
      expect(read(reader)).not.toBeNull();
      expect(writer.write(7, 1, 1, source(largest))).toBe(true);
      expect(read(reader)?.payload).toEqual(largest);
    }
    expect(reader.takeRefusal()).toBe(false);
  });

  test('a payload no entry can hold is a fault, not a refusal', () => {
    const sab = new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE);
    const writer = createViewerOutputRingWriter(sab);
    const reader = createViewerOutputRingReader(sab);
    expect(() => writer.write(7, 1, 1, source(output(VIEWER_OUTPUT_MAX_BYTES + 1, 1)))).toThrow(
      RangeError,
    );
    expect(() => writer.write(1, 1, 1, source(new Uint8Array(27)))).toThrow(RangeError);
    expect(reader.takeRefusal()).toBe(false);
    expect(read(reader)).toBeNull();
  });

  test('a full ring refuses, and the reader that drains it owes the writer the edge', () => {
    const sab = new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE);
    const writer = createViewerOutputRingWriter(sab);
    const reader = createViewerOutputRingReader(sab);
    const largest = source(output(VIEWER_OUTPUT_MAX_BYTES, 4));
    let written = 0;
    while (writer.write(1, 1, 1, largest)) written += 1;
    expect(written).toBeGreaterThan(0);
    // The held output is tried once more at once, and is refused again.
    expect(writer.write(1, 1, 1, largest)).toBe(false);

    for (let index = 0; index < written; index += 1) expect(read(reader)).not.toBeNull();
    expect(read(reader)).toBeNull();
    expect(reader.takeRefusal()).toBe(true);
    expect(reader.takeRefusal()).toBe(false);
    expect(writer.write(1, 1, 1, largest)).toBe(true);
  });

  test('a reader built after a refusal is not owed its edge', () => {
    const sab = new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE);
    const writer = createViewerOutputRingWriter(sab);
    const largest = source(output(VIEWER_OUTPUT_MAX_BYTES, 4));
    while (writer.write(1, 1, 1, largest)) {
      // Fill it.
    }
    expect(createViewerOutputRingReader(sab).takeRefusal()).toBe(false);
  });

  test('the task edge fires only when the reader may have parked', () => {
    const sab = new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE);
    let edges = 0;
    const writer = createViewerOutputRingWriter(sab, () => {
      edges += 1;
    });
    const reader = createViewerOutputRingReader(sab);
    const ack = source(output(44, 1));

    writer.write(1, 1, 1, ack);
    expect(edges).toBe(1);
    // The reader has not caught up: it will find this entry before it parks.
    writer.write(1, 1, 1, ack);
    expect(edges).toBe(1);
    read(reader);
    read(reader);
    writer.write(1, 1, 1, ack);
    expect(edges).toBe(2);
  });

  test('a failing task edge leaves the output published', () => {
    const sab = new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE);
    const writer = createViewerOutputRingWriter(sab, () => {
      throw new Error('port closed');
    });
    const reader = createViewerOutputRingReader(sab);
    expect(writer.write(1, 1, 1, source(output(4, 1)))).toBe(true);
    expect(read(reader)).not.toBeNull();
  });

  test('a native reader is woken by the output it was parked for', async () => {
    const sab = new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE);
    const writer = createViewerOutputRingWriter(sab);
    const reader = createViewerOutputRingReader(sab, 5_000);

    const parked = reader.waitAsync();
    expect(parked).not.toBe('not-equal');
    writer.write(1, 1, 1, source(output(44, 1)));
    await parked;
    expect(reader.waitAsync()).toBe('not-equal');
    expect(read(reader)?.kind).toBe(1);
  });

  test('a task reader parks on its task wait and is woken through it', async () => {
    const sab = new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE);
    const wake = createTaskWake();
    const writer = createViewerOutputRingWriter(sab, () => wake.wake());
    const watchdogs: number[] = [];
    const reader = createViewerOutputRingReader(sab, 1_234, (watchdogMs) => {
      watchdogs.push(watchdogMs);
      return wake.wait(watchdogMs);
    });

    const parked = reader.waitAsync();
    expect(parked).not.toBe('not-equal');
    expect(watchdogs).toEqual([1_234]);
    writer.write(2, 1, 1, source(output(0, 1)));
    await parked;
    expect(read(reader)?.kind).toBe(2);
    wake.dispose();
  });
});
