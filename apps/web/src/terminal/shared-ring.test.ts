import { describe, expect, test } from 'bun:test';
import { MAX_DISPLAY_FRAME_BYTES, type SynchronousByteSource } from '@merkur/shared';
import { createTaskWake } from '../lib/task-wake';
import {
  createFrameRingReader,
  createFrameRingWriter,
  FRAME_KIND_DISPLAY,
  FRAME_KIND_HASH_DIGEST,
  FRAME_KIND_LINEAGE_FENCE,
  FRAME_RING_SIZE,
  type FrameRingEntry,
  readFrameRingFence,
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
    writer.fenceSessionLineage(2, false);
    // The old lineage's entry is still backlog: the reader has to run to
    // discard it.
    expect(reader.hasPending()).toBe(true);
    expect(reader.tryRead()).toBeNull();
    expect(reader.hasPending()).toBe(false);
    expect(reader.pendingBytes()).toBe(0);
    expect(writer.publishFence()).toBe(true);
    expect(reader.hasPending()).toBe(true);
    expect(reader.tryRead()?.kind).toBe(FRAME_KIND_LINEAGE_FENCE);
    expect(reader.hasPending()).toBe(false);
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

  test('discardPending invalidates a lease without letting a late release rewind the cursor', () => {
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

  test('a lineage fence discards the old lineage unread and orders the new one behind it', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    const first = randomPayload(128, 10);
    const second = randomPayload(128, 11);
    const third = randomPayload(128, 12);

    expect(writer.write(first, FRAME_KIND_DISPLAY, true)).toBe(true);
    expect(writer.write(second, FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(reader.tryRead()?.payload).toEqual(first);

    const token = writer.fenceSessionLineage(2, false);
    expect(writer.publishFence()).toBe(true);
    // The new lineage's frame is written with no word from the reader.
    expect(writer.write(third, FRAME_KIND_DISPLAY, false)).toBe(true);

    expect(fenceOf(reader.tryRead())).toEqual({ token, lineage: 2, newSession: false });
    expect(reader.tryRead()?.payload).toEqual(third);
    expect(reader.tryRead()).toBeNull();
  });

  test('an announced fence frees a full ring of the old lineage for its own entry', () => {
    const sab = new SharedArrayBuffer(4 * 1024);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    while (writer.write(new Uint8Array(512), FRAME_KIND_DISPLAY, false)) {}
    while (writer.write(Uint8Array.of(0), FRAME_KIND_DISPLAY, false)) {}

    const token = writer.fenceSessionLineage(3, false);
    expect(writer.publishFence()).toBe(false);
    // The reader discards the ended lineage and records the refusal it owes
    // the producer a space edge for.
    expect(reader.tryRead()).toBeNull();
    expect(reader.takeRefusal()).toBe(true);
    expect(writer.publishFence()).toBe(true);
    expect(writer.publishFence()).toBe(true);
    expect(fenceOf(reader.tryRead())).toEqual({ token, lineage: 3, newSession: false });
    expect(reader.tryRead()).toBeNull();
  });

  test('a fence superseded before it was read hands its new session to the next', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);

    writer.fenceSessionLineage(1, true);
    expect(writer.publishFence()).toBe(true);
    expect(writer.write(Uint8Array.of(1), FRAME_KIND_DISPLAY, false)).toBe(true);
    const latest = writer.fenceSessionLineage(2, false);
    expect(writer.publishFence()).toBe(true);
    expect(writer.write(Uint8Array.of(2), FRAME_KIND_DISPLAY, false)).toBe(true);

    expect(fenceOf(reader.tryRead())).toEqual({ token: latest, lineage: 2, newSession: true });
    expect(reader.tryRead()?.payload).toEqual(Uint8Array.of(2));
    expect(reader.tryRead()).toBeNull();
  });

  test('the writer reads the fence the viewer installed and never waits for it', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    expect(writer.installedFence()).toBe(0);

    const token = writer.fenceSessionLineage(1, true);
    expect(writer.publishFence()).toBe(true);
    expect(writer.write(Uint8Array.of(5), FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(writer.installedFence()).toBe(0);

    const fence = fenceOf(reader.tryRead());
    reader.installFence(fence.token);
    expect(writer.installedFence()).toBe(token);
    // A reader built later over the same ring starts after the installed fence.
    const successor = createFrameRingReader(sab);
    expect(successor.tryRead()?.payload).toEqual(Uint8Array.of(5));
  });

  test('a pending fence is the only entry the reader hands out until taken', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);
    expect(writer.write(Uint8Array.of(1), FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(reader.fencePending()).toBe(false);

    const token = writer.fenceSessionLineage(2, false);
    expect(reader.fencePending()).toBe(true);
    // Announced but not yet published: nothing to hand out, the old frame gone.
    expect(reader.tryReadLeased()).toBeNull();
    expect(reader.fencePending()).toBe(true);
    expect(writer.publishFence()).toBe(true);
    expect(writer.write(Uint8Array.of(2), FRAME_KIND_DISPLAY, false)).toBe(true);
    const lease = must(reader.tryReadLeased());
    expect(fenceOf(lease)).toEqual({ token, lineage: 2, newSession: false });
    lease.release();
    expect(reader.fencePending()).toBe(false);
    expect(reader.tryRead()?.payload).toEqual(Uint8Array.of(2));
  });

  test('fence tokens skip zero across the uint32 wrap', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    Atomics.store(new Int32Array(sab, 0, 6), 4, 0xffff_ffff | 0);
    const writer = createFrameRingWriter(sab);
    expect(writer.fenceSessionLineage(1, false)).toBe(1);
    expect(writer.fenceSessionLineage(2, false)).toBe(2);
  });

  test('discardPending keeps an announced fence and the lineage behind it', () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab);

    expect(writer.write(randomPayload(128, 20), FRAME_KIND_DISPLAY, true)).toBe(true);
    const token = writer.fenceSessionLineage(4, false);
    expect(writer.publishFence()).toBe(true);
    expect(writer.write(Uint8Array.of(6), FRAME_KIND_DISPLAY, false)).toBe(true);

    expect(reader.discardPending()).toBe(true);
    expect(fenceOf(reader.tryRead())).toEqual({ token, lineage: 4, newSession: false });
    expect(reader.tryRead()?.payload).toEqual(Uint8Array.of(6));
    expect(reader.discardPending()).toBe(false);
  });

  test('an announcement wakes a parked native reader', async () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const writer = createFrameRingWriter(sab);
    const reader = createFrameRingReader(sab, 60_000);

    const parked = reader.waitAsync();
    if (parked === 'not-equal') throw new Error('empty frame reader did not park');
    writer.fenceSessionLineage(1, true);
    await parked;
    expect(writer.publishFence()).toBe(true);
    expect(reader.waitAsync()).toBe('not-equal');
    expect(reader.tryRead()?.kind).toBe(FRAME_KIND_LINEAGE_FENCE);
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

  test('the task fallback wakes for an announcement as for an entry', async () => {
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const taskWake = createTaskWake();
    let edges = 0;
    const writer = createFrameRingWriter(sab, () => {
      edges += 1;
      taskWake.wake();
    });
    const reader = createFrameRingReader(sab, 60_000, (watchdogMs) => taskWake.wait(watchdogMs));

    const announced = reader.waitAsync();
    if (announced === 'not-equal') throw new Error('empty task reader did not park');
    const token = writer.fenceSessionLineage(5, false);
    await announced;
    expect(edges).toBe(1);
    expect(writer.publishFence()).toBe(true);
    expect(writer.write(Uint8Array.of(8), FRAME_KIND_DISPLAY, false)).toBe(true);
    expect(fenceOf(reader.tryRead())).toEqual({ token, lineage: 5, newSession: false });
    expect(reader.tryRead()?.payload).toEqual(Uint8Array.of(8));
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

function fenceOf(entry: FrameRingEntry | null | undefined) {
  const fence = must(entry);
  expect(fence.kind).toBe(FRAME_KIND_LINEAGE_FENCE);
  return readFrameRingFence(fence.payload);
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a published ring entry');
  return value;
}

test('a maximum display frame fits every empty-ring wrap boundary with one contiguous lease', () => {
  const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
  const meta = new Int32Array(sab, 0, 6);
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
