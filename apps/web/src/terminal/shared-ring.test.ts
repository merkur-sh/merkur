import { describe, expect, test } from 'bun:test';
import { MAX_DISPLAY_FRAME_BYTES, type SynchronousByteSource } from '@merkur/shared';
import { createTaskWake } from '../lib/task-wake';
import {
  createFrameRingReader,
  createFrameRingWriter,
  FRAME_KIND_DISPLAY,
  FRAME_KIND_HASH_DIGEST,
  FRAME_RING_SIZE,
  wakeFrameRingReader,
} from './shared-ring';

function randomPayload(byteLen: number, seed: number): Uint8Array {
  const buf = new Uint8Array(byteLen);
  let state = seed >>> 0;
  for (let i = 0; i < byteLen; i += 1) {
    state = (state * 1103515245 + 12345) >>> 0;
    buf[i] = state & 0xff;
  }
  return buf;
}

function synchronousSource(
  bytes: Uint8Array,
  copyTo: (destination: Uint8Array, destinationOffset: number) => void = (
    destination,
    destinationOffset,
  ) => destination.set(bytes, destinationOffset),
): SynchronousByteSource {
  return {
    byteLength: bytes.byteLength,
    getUint8: (offset) => bytes[offset] ?? 0,
    getUint16BE: (offset) => ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0),
    getUint32BE: (offset) =>
      ((bytes[offset] ?? 0) * 0x100_0000 +
        ((bytes[offset + 1] ?? 0) << 16) +
        ((bytes[offset + 2] ?? 0) << 8) +
        (bytes[offset + 3] ?? 0)) >>>
      0,
    copyTo,
    copy: () => bytes.slice(),
  };
}

describe('frame ring', () => {
  test('writes and reads payloads in order', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);

    const a = randomPayload(100, 1);
    const b = randomPayload(2048, 2);
    const c = randomPayload(7, 3);

    expect(writer.write(a, FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(writer.write(b, FRAME_KIND_HASH_DIGEST, true)).toBe(true);
    expect(writer.write(c, FRAME_KIND_DISPLAY, false)).toBe(true);

    const entryA = reader.tryRead();
    expect(entryA?.kind).toBe(FRAME_KIND_DISPLAY);
    expect(entryA?.allowLarge).toBe(false);
    expect(entryA?.payload).toEqual(a);

    const entryB = reader.tryRead();
    expect(entryB?.kind).toBe(FRAME_KIND_HASH_DIGEST);
    expect(entryB?.allowLarge).toBe(true);
    expect(entryB?.payload).toEqual(b);

    const entryC = reader.tryRead();
    expect(entryC?.payload).toEqual(c);

    expect(reader.tryRead()).toBeNull();
  });

  test('copies a synchronous source directly into an unpublished ring slot', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    const payload = randomPayload(4096, 77);
    const mapping = { epoch: 9, localMinusWire: 3, wireMin: 4, wireMax: 8 };

    expect(writer.writeFrom(synchronousSource(payload), FRAME_KIND_DISPLAY, true, mapping)).toBe(
      true,
    );
    expect(reader.tryRead()).toEqual({
      payload,
      kind: FRAME_KIND_DISPLAY,
      allowLarge: true,
      inputSequenceMapping: mapping,
    });
  });

  test('does not publish a partial entry when a synchronous copier throws', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const meta = new Int32Array(sab, 0, 4);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    const payload = randomPayload(256, 78);
    const writeOffset = Atomics.load(meta, 0);

    expect(() =>
      writer.writeFrom(
        synchronousSource(payload, (destination, destinationOffset) => {
          destination.set(payload.subarray(0, 32), destinationOffset);
          throw new Error('copy failed');
        }),
        FRAME_KIND_DISPLAY,
        false,
      ),
    ).toThrow('copy failed');
    expect(Atomics.load(meta, 0)).toBe(writeOffset);
    expect(reader.tryRead()).toBeNull();

    const replacement = randomPayload(256, 79);
    expect(writer.write(replacement, FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(reader.tryRead()?.payload).toEqual(replacement);
  });

  test('rejects ring-full synchronous writes before invoking their copier', () => {
    const sab = new SharedArrayBuffer(1024);
    const writer = createFrameRingWriter(sab);
    const payload = new Uint8Array(128);
    while (writer.write(payload, FRAME_KIND_DISPLAY, false)) {
      // Fill without consuming.
    }
    let copies = 0;
    const source = synchronousSource(payload, (destination, destinationOffset) => {
      copies += 1;
      destination.set(payload, destinationOffset);
    });

    expect(writer.writeFrom(source, FRAME_KIND_DISPLAY, false)).toBe(false);
    expect(copies).toBe(0);
  });

  test('rejects a reentrant write while preserving the outer transaction', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    const outer = Uint8Array.of(1, 2, 3, 4);

    expect(
      writer.writeFrom(
        synchronousSource(outer, (destination, destinationOffset) => {
          expect(() => writer.write(Uint8Array.of(9), FRAME_KIND_DISPLAY, false)).toThrow(
            'not reentrant',
          );
          destination.set(outer, destinationOffset);
        }),
        FRAME_KIND_DISPLAY,
        false,
      ),
    ).toBe(true);
    expect(reader.tryRead()?.payload).toEqual(outer);
    expect(reader.tryRead()).toBeNull();
  });

  test('snapshots the input sequence mapping with each frame-ring entry', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    const mapping = {
      epoch: 7,
      localMinusWire: 0xffff_ff9d,
      wireMin: 1,
      wireMax: 4,
    };

    expect(writer.write(Uint8Array.of(1, 2, 3), FRAME_KIND_DISPLAY, false, mapping)).toBe(true);
    // Mutating the producer's live mapping cannot retroactively change a
    // published entry.
    mapping.epoch = 8;
    mapping.wireMax = 5;

    expect(reader.tryRead()?.inputSequenceMapping).toEqual({
      epoch: 7,
      localMinusWire: 0xffff_ff9d,
      wireMin: 1,
      wireMax: 4,
    });
  });

  test('leases a shared payload until the consumer advances the ring', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    const first = randomPayload(256, 31);
    const second = randomPayload(128, 32);
    expect(writer.write(first, FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(writer.write(second, FRAME_KIND_DISPLAY, true)).toBe(true);
    const lease = must(reader.tryReadLeased());
    expect(lease.payload.buffer).toBe(sab);
    expect(lease.payload).toEqual(first);
    expect(reader.tryReadLeased()).toBeNull();
    expect(reader.tryRead()).toBeNull();
    lease.release();
    lease.release();
    const next = must(reader.tryRead());
    expect(next.payload.buffer).not.toBe(sab);
    expect(next.payload).toEqual(second);
  });

  test('the reader owns one lease record and moves its fields with each read', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    const first = Uint8Array.of(0xa1, 0xa2, 0xa3);
    const second = Uint8Array.of(0xb1, 0xb2, 0xb3, 0xb4, 0xb5);
    expect(
      writer.write(first, FRAME_KIND_DISPLAY, false, {
        epoch: 3,
        localMinusWire: 10,
        wireMin: 1,
        wireMax: 4,
      }),
    ).toBe(true);
    expect(
      writer.write(second, FRAME_KIND_HASH_DIGEST, true, {
        epoch: 4,
        localMinusWire: 0xffff_ff9d,
        wireMin: 5,
        wireMax: 9,
      }),
    ).toBe(true);

    const leaseA = must(reader.tryReadLeased());
    const mappingA = leaseA.inputSequenceMapping;
    const releaseA = leaseA.release;
    expect(leaseA.payload).toEqual(first);
    expect(leaseA.kind).toBe(FRAME_KIND_DISPLAY);
    expect(leaseA.allowLarge).toBe(false);
    expect(mappingA).toEqual({ epoch: 3, localMinusWire: 10, wireMin: 1, wireMax: 4 });
    leaseA.release();

    // The second read hands back the same lease, the same mapping object and
    // the same release — with every field moved to the second entry.
    const leaseB = must(reader.tryReadLeased());
    expect(leaseB).toBe(leaseA);
    expect(leaseB.inputSequenceMapping).toBe(mappingA);
    expect(leaseB.release).toBe(releaseA);
    expect(leaseB.payload).toEqual(second);
    expect(leaseB.kind).toBe(FRAME_KIND_HASH_DIGEST);
    expect(leaseB.allowLarge).toBe(true);
    expect(mappingA).toEqual({ epoch: 4, localMinusWire: 0xffff_ff9d, wireMin: 5, wireMax: 9 });
    leaseB.release();
    // A released lease exposes no bytes of a slot the producer may be refilling.
    expect(leaseB.payload.byteLength).toBe(0);
    expect(reader.tryReadLeased()).toBeNull();
  });

  test('readable-backlog census owns no lease, waiter, or cursor mutation and honors lineage fences', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const meta = new Int32Array(sab, 0, 4);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    expect(reader.hasPending()).toBe(false);
    expect(writer.write(Uint8Array.of(1), FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(reader.pendingBytes()).toBe(32);
    expect(reader.droppedCount()).toBe(0);
    const cursor = Atomics.load(meta, 1);
    for (let query = 0; query < 100; query += 1) expect(reader.hasPending()).toBe(true);
    expect(Atomics.load(meta, 1)).toBe(cursor);
    const lease = must(reader.tryReadLeased());
    expect(reader.hasPending()).toBe(true);
    expect(lease.payload).toEqual(Uint8Array.of(1));
    lease.release();
    expect(reader.hasPending()).toBe(false);
    expect(reader.pendingBytes()).toBe(0);
    expect(writer.write(Uint8Array.of(2), FRAME_KIND_DISPLAY, false)).toBe(true);
    const fence = writer.fenceSessionLineage();
    expect(reader.hasPending()).toBe(false);
    expect(reader.pendingBytes()).toBe(32);
    expect(reader.releaseSessionLineageFence(fence)).toBe(true);
    expect(reader.hasPending()).toBe(true);
    expect(reader.tryRead()?.payload).toEqual(Uint8Array.of(2));
    expect(reader.hasPending()).toBe(false);
    expect(reader.pendingBytes()).toBe(0);
  });

  test('a re-entrant read while a lease is live yields nothing and moves no record', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    expect(writer.write(Uint8Array.of(1), FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(writer.write(Uint8Array.of(2), FRAME_KIND_DISPLAY, false)).toBe(true);
    const lease = must(reader.tryReadLeased());
    // The pump is the ring's one consumer, and a nested wake (a session epoch
    // restarting the pump from inside a frame's apply) finds the lease live:
    // it reads nothing rather than moving the record out from under the outer
    // frame, exactly as the base returned null for a second lease.
    expect(reader.tryReadLeased()).toBeNull();
    expect(reader.tryRead()).toBeNull();
    // The refused reads left the live lease and the cursor where they were.
    expect(lease.payload).toEqual(Uint8Array.of(1));
    lease.release();
    expect(reader.tryRead()?.payload).toEqual(Uint8Array.of(2));
  });

  test('discardPending invalidates a lease without letting a late release rewind the fence', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    expect(writer.write(Uint8Array.of(1), FRAME_KIND_DISPLAY, false)).toBe(true);
    const lease = must(reader.tryReadLeased());
    expect(writer.write(Uint8Array.of(2), FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(reader.discardPending()).toBe(true);
    lease.release();
    expect(reader.tryRead()).toBeNull();
    expect(writer.write(Uint8Array.of(3), FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(reader.tryRead()?.payload).toEqual(Uint8Array.of(3));
  });

  test('an empty discard reports no loss and preserves a later publication', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    const postDiscardFrame = Uint8Array.of(4, 5, 6);

    expect(reader.discardPending()).toBe(false);
    expect(writer.write(postDiscardFrame, FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(reader.tryRead()?.payload).toEqual(postDiscardFrame);
  });

  test('wraps around without overrunning the reader', () => {
    // Use a small ring so we can fill it deterministically.
    const small = 8 * 1024;
    const sab = new SharedArrayBuffer(small);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);

    const payloadSize = 256;
    let writeCount = 0;
    let readCount = 0;
    const expected: Uint8Array[] = [];

    // Push 1024 frames through a tiny ring, reading two per write iteration.
    for (let i = 0; i < 1024; i += 1) {
      const p = randomPayload(payloadSize, i + 1);
      while (!writer.write(p, FRAME_KIND_DISPLAY, false)) {
        const entry = must(reader.tryRead());
        expect(entry.payload).toEqual(must(expected[readCount]));
        readCount += 1;
      }
      expected.push(p);
      writeCount += 1;
    }
    while (readCount < writeCount) {
      const entry = must(reader.tryRead());
      expect(entry.payload).toEqual(must(expected[readCount]));
      readCount += 1;
    }
    // droppedCount counts every refused write attempt (backpressure ticks),
    // not data loss — every payload pushed into `expected` was successfully
    // written and verified against the read sequence above.
  });

  test('rejects writes when ring is full instead of overrunning', () => {
    const small = 4 * 1024;
    const sab = new SharedArrayBuffer(small);
    const writer = createFrameRingWriter(sab);

    // Fill the ring without ever reading.
    let writes = 0;
    const payload = new Uint8Array(512);
    while (writer.write(payload, FRAME_KIND_DISPLAY, false)) writes += 1;
    expect(writes).toBeGreaterThan(0);
    expect(writer.droppedCount()).toBeGreaterThanOrEqual(1);
  });

  test('a lineage fence halts an active drain until it is released', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    const first = randomPayload(128, 10);
    const second = randomPayload(128, 11);

    expect(writer.write(first, FRAME_KIND_DISPLAY, true)).toBe(true);
    expect(writer.write(second, FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(reader.tryRead()?.payload).toEqual(first);

    const fenceToken = writer.fenceSessionLineage();
    expect(reader.tryRead()).toBeNull();
    expect(reader.tryReadLeased()).toBeNull();

    expect(reader.releaseSessionLineageFence(fenceToken)).toBe(true);
    expect(reader.tryRead()?.payload).toEqual(second);
    expect(reader.tryRead()).toBeNull();
  });

  test('the epoch discard cuts fenced publication at an exact cursor boundary', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const meta = new Int32Array(sab, 0, 4);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    const priorEpochSnapshot = randomPayload(128, 20);
    const racedSnapshot = randomPayload(128, 21);
    const postDiscardSnapshot = randomPayload(128, 22);

    expect(writer.write(priorEpochSnapshot, FRAME_KIND_DISPLAY, true)).toBe(true);
    const preFenceWakeState = Atomics.load(meta, 3);
    const fenceToken = writer.fenceSessionLineage();
    const fencedWakeState = Atomics.load(meta, 3);
    expect(fencedWakeState).not.toBe(preFenceWakeState);
    expect(fencedWakeState & 1).toBe(1);
    expect(writer.write(racedSnapshot, FRAME_KIND_DISPLAY, true)).toBe(true);
    expect(reader.tryRead()).toBeNull();

    expect(reader.discardPending()).toBe(true);
    expect(writer.write(postDiscardSnapshot, FRAME_KIND_DISPLAY, true)).toBe(true);
    expect(reader.tryRead()).toBeNull();

    expect(reader.releaseSessionLineageFence(fenceToken)).toBe(true);
    // A full fence cycle must not restore the captured futex value: otherwise
    // a reader racing the transition could park despite the surviving frame.
    const releasedWakeState = Atomics.load(meta, 3);
    expect(releasedWakeState & 1).toBe(0);
    expect((releasedWakeState - preFenceWakeState) >>> 0).toBe(4);
    expect(reader.waitAsync()).toBe('not-equal');
    expect(reader.tryRead()?.payload).toEqual(postDiscardSnapshot);
    expect(reader.tryRead()).toBeNull();
  });

  test('a fenced native reader wakes only when the terminal releases its epoch', async () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const meta = new Int32Array(sab, 0, 4);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab, 60_000);

    const fenceToken = writer.fenceSessionLineage();
    const fencedWakeState = Atomics.load(meta, 3);
    expect(fencedWakeState & 1).toBe(1);
    const parked = reader.waitAsync();
    if (parked === 'not-equal') throw new Error('fenced frame reader did not park');
    expect(writer.write(Uint8Array.of(9), FRAME_KIND_DISPLAY, false)).toBe(true);
    // Publication keeps the fence bit and suppresses the native wake sequence.
    expect(Atomics.load(meta, 3)).toBe(fencedWakeState);

    expect(reader.releaseSessionLineageFence(fenceToken)).toBe(true);
    await parked;
    expect(Atomics.load(meta, 3) & 1).toBe(0);
    expect(Atomics.load(meta, 3)).not.toBe(fencedWakeState);
    expect(reader.tryRead()?.payload).toEqual(Uint8Array.of(9));
  });

  test('periodically wakes an empty reader without a producer notification', async () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const reader = createFrameRingReader(sab, 1);

    const wait = reader.waitAsync();
    expect(wait).not.toBe('not-equal');
    // The park promise is the futex promise itself, not a continuation over it.
    await expect(wait).resolves.toBe('timed-out');
    expect(reader.tryRead()).toBeNull();
  });

  test('a resume hint directly wakes a parked frame reader', async () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const reader = createFrameRingReader(sab, 60_000);
    const wait = reader.waitAsync();
    if (wait === 'not-equal') throw new Error('empty frame reader did not park');

    expect(wakeFrameRingReader(sab)).toBe(1);
    await wait;
    expect(reader.tryRead()).toBeNull();
  });

  test('uses one task wake per empty-to-nonempty frame-ring edge', async () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const taskWake = createTaskWake();
    let edges = 0;
    const writer = createFrameRingWriter(sab, () => {
      edges += 1;
      taskWake.wake();
    });
    const reader = createFrameRingReader(sab, 60_000, (watchdogMs) => taskWake.wait(watchdogMs));

    const parked = reader.waitAsync();
    if (parked === 'not-equal') throw new Error('empty frame reader did not park');
    expect(writer.write(Uint8Array.of(1), FRAME_KIND_DISPLAY, false)).toBe(true);
    await parked;
    expect(writer.write(Uint8Array.of(2), FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(edges).toBe(1);

    expect(reader.tryRead()?.payload).toEqual(Uint8Array.of(1));
    expect(reader.tryRead()?.payload).toEqual(Uint8Array.of(2));
    expect(writer.write(Uint8Array.of(3), FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(edges).toBe(2);
  });

  test('the task fallback honors the lineage fence and ordered release wake', async () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const taskWake = createTaskWake();
    let edges = 0;
    const writer = createFrameRingWriter(sab, () => {
      edges += 1;
      taskWake.wake();
    });
    const reader = createFrameRingReader(sab, 60_000, (watchdogMs) => taskWake.wait(watchdogMs));

    const fenceToken = writer.fenceSessionLineage();
    const publicationWake = reader.waitAsync();
    if (publicationWake === 'not-equal') throw new Error('fenced task reader did not park');
    expect(writer.write(Uint8Array.of(8), FRAME_KIND_DISPLAY, false)).toBe(true);
    await publicationWake;
    expect(edges).toBe(1);
    expect(reader.tryRead()).toBeNull();

    const epochWake = reader.waitAsync();
    if (epochWake === 'not-equal') throw new Error('fenced task reader did not repark');
    expect(reader.releaseSessionLineageFence(fenceToken)).toBe(true);
    taskWake.wake();
    await epochWake;
    expect(reader.tryRead()?.payload).toEqual(Uint8Array.of(8));
  });

  test('only the latest overlapping session fence token can release the reader', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const meta = new Int32Array(sab, 0, 4);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    const payload = Uint8Array.of(7, 8, 9);

    const firstFenceToken = writer.fenceSessionLineage();
    const secondFenceToken = writer.fenceSessionLineage();
    expect(firstFenceToken).not.toBe(secondFenceToken);
    expect(secondFenceToken & 1).toBe(1);
    expect(Atomics.load(meta, 3) >>> 0).toBe(secondFenceToken);
    expect(writer.write(payload, FRAME_KIND_DISPLAY, false)).toBe(true);

    expect(reader.releaseSessionLineageFence(firstFenceToken)).toBe(false);
    expect(Atomics.load(meta, 3) >>> 0).toBe(secondFenceToken);
    expect(reader.tryRead()).toBeNull();

    expect(reader.releaseSessionLineageFence(secondFenceToken)).toBe(true);
    expect(Atomics.load(meta, 3) & 1).toBe(0);
    expect(reader.tryRead()?.payload).toEqual(payload);
    expect(reader.releaseSessionLineageFence(secondFenceToken)).toBe(false);
  });

  test('a completed epoch cannot release a later fence', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const meta = new Int32Array(sab, 0, 4);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);

    const firstFenceToken = writer.fenceSessionLineage();
    expect(reader.releaseSessionLineageFence(firstFenceToken)).toBe(true);
    const secondFenceToken = writer.fenceSessionLineage();

    expect(secondFenceToken & 1).toBe(1);
    expect((secondFenceToken - firstFenceToken) >>> 0).toBe(4);
    expect(Atomics.load(meta, 3) >>> 0).toBe(secondFenceToken);
    expect(reader.releaseSessionLineageFence(firstFenceToken)).toBe(false);
    expect(Atomics.load(meta, 3) >>> 0).toBe(secondFenceToken);
  });

  test('fence ownership tokens preserve exact uint32 wrap semantics', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const meta = new Int32Array(sab, 0, 4);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);

    Atomics.store(meta, 3, 0xffff_fffc);
    const wrappedFenceToken = writer.fenceSessionLineage();
    expect(wrappedFenceToken).toBe(0xffff_ffff);
    expect(reader.releaseSessionLineageFence(wrappedFenceToken)).toBe(true);
    expect(Atomics.load(meta, 3) >>> 0).toBe(0);
    expect(reader.releaseSessionLineageFence(wrappedFenceToken)).toBe(false);
    expect(writer.fenceSessionLineage()).toBe(3);
  });

  test('keeps a published frame readable if its task notifier throws', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab, () => {
      throw new Error('worker closed');
    });
    const reader = createFrameRingReader(sab);

    expect(writer.write(Uint8Array.of(7), FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(reader.tryRead()?.payload).toEqual(Uint8Array.of(7));
  });
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a published ring entry');
  return value;
}

test('a maximum display frame fits every empty-ring wrap boundary with one contiguous lease', () => {
  const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
  const meta = new Int32Array(sab, 0, 4);
  const capacity = sab.byteLength - meta.byteLength;
  const half = capacity / 2;
  const writer = createFrameRingWriter(sab);
  const reader = createFrameRingReader(sab);
  const payload = new Uint8Array(MAX_DISPLAY_FRAME_BYTES);
  payload[0] = 0x31;
  payload[payload.length - 1] = 0xa7;
  for (const offset of [0, 8, half - 8, half, half + 8, capacity - 16, capacity - 8]) {
    Atomics.store(meta, 0, offset);
    Atomics.store(meta, 1, offset);
    let copies = 0;
    const source = synchronousSource(payload, (target, start) => {
      copies += 1;
      target.set(payload, start);
    });
    expect(writer.writeFrom(source, FRAME_KIND_DISPLAY, true)).toBe(true);
    expect(copies).toBe(1);
    const lease = reader.tryReadLeased();
    expect(lease).not.toBeNull();
    if (lease === null) throw new Error('maximum frame missing');
    expect(lease.payload.buffer).toBe(sab);
    expect(lease.payload.byteLength).toBe(MAX_DISPLAY_FRAME_BYTES);
    expect(lease.payload[0]).toBe(0x31);
    expect(lease.payload[MAX_DISPLAY_FRAME_BYTES - 1]).toBe(0xa7);
    expect(lease.allowLarge).toBe(true);
    lease.release();
    expect(reader.hasPending()).toBe(false);
  }
  expect(writer.droppedCount()).toBe(0);
});
