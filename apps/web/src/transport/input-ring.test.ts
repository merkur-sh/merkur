import { describe, expect, test } from 'bun:test';
import { createTaskWake } from '../lib/task-wake';
import {
  createInputRingReader,
  createInputRingWriter,
  INPUT_RING_SIZE,
  type InputRingReader,
  MAX_BUFFERED_INPUT_BYTES,
  MAX_BUFFERED_INPUT_ENTRIES,
  wakeInputRingReader,
} from './input-ring';
import {
  createPredictionAdmissionBuffer,
  createPredictionAdmissionResolver,
} from './prediction-admission';

function payload(len: number, fill: number): Uint8Array {
  return new Uint8Array(len).fill(fill);
}

function readPayload(reader: InputRingReader, ordinal: number): Uint8Array {
  const out = new Uint8Array(reader.payloadLength(ordinal));
  reader.copyPayload(ordinal, out, 0);
  return out;
}

describe('input ring', () => {
  test('writes and reads entries in order with packed shadow provenance', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const predictionAdmission = createPredictionAdmissionBuffer();
    const writer = createInputRingWriter(sab, predictionAdmission);
    const reader = createInputRingReader(sab, undefined, predictionAdmission);
    writer.beginPredictionLineage();

    expect(reader.tryReadNext()).toBe(-1);

    expect(writer.write(1, payload(3, 0xa), () => true)).toBe(true);
    expect(writer.write(2, payload(5, 0xb))).toBe(true);

    // The verdict was decided inside `write`, so both entries are readable at
    // once. Nothing here waits on the terminal worker.
    const a = reader.tryReadNext();
    expect(a).toBe(0);
    expect(reader.localSeq(a)).toBe(1);
    expect(readPayload(reader, a)).toEqual(payload(3, 0xa));
    expect(reader.shadowModelled(a)).toBe(true);
    const b = reader.tryReadNext();
    expect(b).toBe(1);
    expect(reader.localSeq(b)).toBe(2);
    expect(readPayload(reader, b)).toEqual(payload(5, 0xb));
    expect(reader.shadowModelled(b)).toBe(false);
    expect(reader.tryReadNext()).toBe(-1);
  });

  test('a read never copies: the entry stays in the ring until it is released', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const writer = createInputRingWriter(sab);
    const reader = createInputRingReader(sab);

    expect(writer.write(1, payload(4, 0x61))).toBe(true);
    expect(writer.write(2, payload(6, 0x62))).toBe(true);
    const first = reader.tryReadNext();
    const second = reader.tryReadNext();
    expect(reader.consumedOrdinal()).toBe(2);
    expect(reader.releasedOrdinal()).toBe(0);

    // Reading transferred nothing out of the ring: the writer's budget and the
    // acked boundary still hold both entries.
    expect(writer.bufferedBytes()).toBe(10);
    expect(writer.bufferedEntries()).toBe(2);
    const meta = new Int32Array(sab, 0, 8);
    expect(Atomics.load(meta, 1)).toBe(0);
    expect(Atomics.load(meta, 7)).toBe(32);

    // The payload is read from the slot each time, so a retransmit sees the
    // same bytes without any copy having been made.
    const scratch = new Uint8Array(16);
    reader.copyPayload(second, scratch, 2);
    expect(Array.from(scratch.subarray(0, 10))).toEqual([
      0, 0, 0x62, 0x62, 0x62, 0x62, 0x62, 0x62, 0, 0,
    ]);

    // An acknowledgement releases the slot: the acked boundary moves to the
    // next held entry and the charge returns to the writer in one step.
    reader.release(first + 1);
    expect(reader.releasedOrdinal()).toBe(1);
    expect(writer.bufferedBytes()).toBe(6);
    expect(writer.bufferedEntries()).toBe(1);
    expect(Atomics.load(meta, 1)).toBe(16);
    expect(() => reader.payloadLength(first)).toThrow(RangeError);
    expect(reader.payloadLength(second)).toBe(6);

    reader.release(second + 1);
    expect(writer.bufferedBytes()).toBe(0);
    expect(writer.bufferedEntries()).toBe(0);
    // Nothing held: the acked boundary is the consumed cursor.
    expect(Atomics.load(meta, 1)).toBe(32);
    expect(() => reader.release(3)).toThrow(RangeError);
  });

  test('a classifier that refuses the input never grants provenance', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const predictionAdmission = createPredictionAdmissionBuffer();
    const writer = createInputRingWriter(sab, predictionAdmission);
    const reader = createInputRingReader(sab, undefined, predictionAdmission);
    writer.beginPredictionLineage();

    expect(writer.write(1, payload(1, 0x61), () => false)).toBe(true);
    expect(reader.shadowModelled(reader.tryReadNext())).toBe(false);
  });

  test('a classifier that throws still delivers the keystroke, without provenance', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const predictionAdmission = createPredictionAdmissionBuffer();
    const writer = createInputRingWriter(sab, predictionAdmission);
    const reader = createInputRingReader(sab, undefined, predictionAdmission);
    writer.beginPredictionLineage();

    expect(
      writer.write(1, payload(1, 0x61), () => {
        throw new Error('overlay failed');
      }),
    ).toBe(true);
    const entry = reader.tryReadNext();
    expect(reader.localSeq(entry)).toBe(1);
    expect(reader.shadowModelled(entry)).toBe(false);
  });

  test('the terminal model can downgrade a grant before the transport reads it', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const predictionAdmission = createPredictionAdmissionBuffer();
    const writer = createInputRingWriter(sab, predictionAdmission);
    const reader = createInputRingReader(sab, undefined, predictionAdmission);
    const resolver = createPredictionAdmissionResolver(predictionAdmission);
    writer.beginPredictionLineage();

    expect(writer.write(1, payload(1, 0x61), () => true)).toBe(true);
    expect(resolver.reject(1)).toBe(true);
    expect(reader.shadowModelled(reader.tryReadNext())).toBe(false);
  });

  test('revoking provenance clears every held grant in place', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const predictionAdmission = createPredictionAdmissionBuffer();
    const writer = createInputRingWriter(sab, predictionAdmission);
    const reader = createInputRingReader(sab, undefined, predictionAdmission);
    writer.beginPredictionLineage();

    expect(writer.write(1, payload(1, 0x61), () => true)).toBe(true);
    expect(writer.write(2, payload(1, 0x62), () => true)).toBe(true);
    const first = reader.tryReadNext();
    const second = reader.tryReadNext();
    expect(reader.shadowModelled(first)).toBe(true);
    reader.revokeShadowProvenance();
    expect(reader.shadowModelled(first)).toBe(false);
    expect(reader.shadowModelled(second)).toBe(false);
  });

  test('an idle reader wakes once, for the entry, and never parks on admission', async () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const predictionAdmission = createPredictionAdmissionBuffer();
    const writer = createInputRingWriter(sab, predictionAdmission);
    const reader = createInputRingReader(sab, 60_000, predictionAdmission);
    writer.beginPredictionLineage();

    const ringWait = reader.waitAsync();
    if (ringWait === 'not-equal') throw new Error('empty reader did not park');
    expect(writer.write(1, payload(1, 0x61), () => true)).toBe(true);
    await ringWait;

    // Readable the instant it is published: provenance was already decided.
    expect(reader.shadowModelled(reader.tryReadNext())).toBe(true);
  });

  test('uses a task wake only for an empty ring', async () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const predictionAdmission = createPredictionAdmissionBuffer();
    const taskWake = createTaskWake();
    let edgeCount = 0;
    let taskWaitCount = 0;
    const writer = createInputRingWriter(sab, predictionAdmission, () => {
      edgeCount += 1;
      taskWake.wake();
    });
    const reader = createInputRingReader(sab, 60_000, predictionAdmission, (watchdogMs) => {
      taskWaitCount += 1;
      return taskWake.wait(watchdogMs);
    });
    writer.beginPredictionLineage();

    const emptyWait = reader.waitAsync();
    if (emptyWait === 'not-equal') throw new Error('empty input reader did not park');
    expect(writer.write(1, payload(1, 0x61), () => true)).toBe(true);
    await emptyWait;
    expect(edgeCount).toBe(1);
    expect(taskWaitCount).toBe(1);

    expect(reader.localSeq(reader.tryReadNext())).toBe(1);
    expect(taskWaitCount).toBe(1);

    expect(writer.write(2, payload(1, 0x62))).toBe(true);
    expect(edgeCount).toBe(2);
    expect(writer.write(3, payload(1, 0x63))).toBe(true);
    expect(edgeCount).toBe(2);
  });

  test('wakes when the consumer reads everything and parks during producer publication', async () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const taskWake = createTaskWake();
    let edgeCount = 0;
    const writer = createInputRingWriter(sab, undefined, () => {
      edgeCount += 1;
      taskWake.wake();
    });
    const reader = createInputRingReader(sab, 60_000, undefined, (watchdogMs) =>
      taskWake.wait(watchdogMs),
    );

    expect(writer.write(1, payload(1, 0x61))).toBe(true);
    // Consume the first publication's latched task edge so it cannot mask the
    // read-and-park interleaving below.
    await taskWake.wait(60_000);

    const parked: { current: Promise<void> | null } = { current: null };
    expect(
      writer.write(2, payload(1, 0x62), () => {
        // Classification runs after the producer snapshots both cursors but
        // before it publishes this entry. Re-entering the consumer here makes
        // the otherwise cross-worker race deterministic. The entry it reads is
        // deliberately NOT released: the reader is parked on having read
        // everything, while the daemon has acknowledged nothing.
        expect(reader.localSeq(reader.tryReadNext())).toBe(1);
        const wait = reader.waitAsync();
        if (wait === 'not-equal') throw new Error('drained input reader did not park');
        parked.current = wait;
        return false;
      }),
    ).toBe(true);
    const installedWait = parked.current;
    if (installedWait === null) throw new Error('publication interleaving was not installed');

    const wokePromptly = await Promise.race([
      installedWait.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(wokePromptly).toBe(true);
    expect(edgeCount).toBe(2);
    expect(reader.releasedOrdinal()).toBe(0);
    expect(reader.localSeq(reader.tryReadNext())).toBe(2);
  });

  test('keeps published input accepted if its task notifier throws', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const writer = createInputRingWriter(sab, undefined, () => {
      throw new Error('worker closed');
    });
    const reader = createInputRingReader(sab);

    expect(writer.write(1, payload(1, 0x61))).toBe(true);
    expect(reader.localSeq(reader.tryReadNext())).toBe(1);
  });

  test('rejects zero-length payloads (skip-marker collision)', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const writer = createInputRingWriter(sab);
    expect(writer.write(1, new Uint8Array(0))).toBe(false);
  });

  test('wraps around and preserves order under sustained traffic', () => {
    const sab = new SharedArrayBuffer(4096);
    const writer = createInputRingWriter(sab);
    const reader = createInputRingReader(sab);

    let writeSeq = 0;
    let readSeq = 0;
    for (let round = 0; round < 2000; round += 1) {
      if (writer.write(writeSeq + 1, payload(40, (writeSeq + 1) & 0xff))) {
        writeSeq += 1;
      }
      const ordinal = reader.tryReadNext();
      if (ordinal >= 0) {
        readSeq += 1;
        expect(reader.localSeq(ordinal)).toBe(readSeq);
        expect(readPayload(reader, ordinal)[0]).toBe(readSeq & 0xff);
        // Held slots are what bound the writer; acknowledge as we go.
        reader.release(ordinal + 1);
      }
    }
    // Drain the remainder; seqs stay contiguous start-to-finish.
    for (let ordinal = reader.tryReadNext(); ordinal >= 0; ordinal = reader.tryReadNext()) {
      readSeq += 1;
      expect(reader.localSeq(ordinal)).toBe(readSeq);
      reader.release(ordinal + 1);
    }
    expect(readSeq).toBe(writeSeq);
  });

  test('held slots bound the writer, and acknowledging past the skip marker frees the ring', () => {
    // 1024 bytes of data area: 40-byte payloads take 48-byte slots, so the
    // writer fits 21 and then needs the acked boundary to move before it can
    // wrap onto the front of the ring.
    const sab = new SharedArrayBuffer(32 + 1024);
    const writer = createInputRingWriter(sab);
    const reader = createInputRingReader(sab);
    const meta = new Int32Array(sab, 0, 8);

    let seq = 1;
    while (writer.write(seq, payload(40, seq & 0xff))) seq += 1;
    const published = seq - 1;
    expect(published).toBe(21);
    expect(writer.droppedCount()).toBe(1);

    // Reading everything frees nothing: the ring is the outbox.
    const ordinals: number[] = [];
    for (let ordinal = reader.tryReadNext(); ordinal >= 0; ordinal = reader.tryReadNext()) {
      ordinals.push(ordinal);
    }
    expect(ordinals).toHaveLength(published);
    expect(writer.write(seq, payload(40, 1))).toBe(false);
    expect(Atomics.load(meta, 1)).toBe(0);

    // Acknowledge the first three: the boundary moves and the writer wraps,
    // planting a skip marker where the last entry ended. Two more fit before
    // the boundary; a third does not.
    reader.release(3);
    expect(Atomics.load(meta, 1)).toBe(3 * 48);
    expect(writer.write(seq, payload(40, seq & 0xff))).toBe(true);
    seq += 1;
    expect(writer.write(seq, payload(40, seq & 0xff))).toBe(true);
    seq += 1;
    expect(writer.write(seq, payload(40, 1))).toBe(false);
    expect(Atomics.load(meta, 0)).toBe(2 * 48);

    // The reader crosses the marker on its next read.
    const afterWrap = reader.tryReadNext();
    expect(reader.localSeq(afterWrap)).toBe(published + 1);
    expect(Atomics.load(meta, 7)).toBe(48);

    // Acknowledge every pre-wrap entry: the acked boundary lands on the first
    // post-wrap slot at offset 0, and the whole tail of the ring is free again.
    reader.release(published);
    expect(Atomics.load(meta, 1)).toBe(0);
    for (let more = 0; more < 15; more += 1) {
      expect(writer.write(seq, payload(40, seq & 0xff))).toBe(true);
      seq += 1;
    }

    // Everything acknowledged: nothing is held and the boundary is the
    // consumed cursor, wherever it stands.
    for (let ordinal = reader.tryReadNext(); ordinal >= 0; ordinal = reader.tryReadNext()) {
      expect(reader.localSeq(ordinal)).toBe(ordinal + 1);
    }
    reader.release(reader.consumedOrdinal());
    expect(Atomics.load(meta, 1)).toBe(Atomics.load(meta, 7));
    expect(writer.bufferedBytes()).toBe(0);
    expect(writer.bufferedEntries()).toBe(0);
  });

  test('drops writes when full and counts them', () => {
    const sab = new SharedArrayBuffer(1024);
    const writer = createInputRingWriter(sab);
    let accepted = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (writer.write(i + 1, payload(200, 1))) accepted += 1;
    }
    expect(accepted).toBeGreaterThan(0);
    expect(writer.droppedCount()).toBeGreaterThan(0);
  });

  test('refuses an entry past the ordinal capacity even with ring space to spare', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const writer = createInputRingWriter(sab);
    for (let seq = 1; seq <= MAX_BUFFERED_INPUT_ENTRIES; seq += 1) {
      expect(writer.write(seq, payload(1, 1))).toBe(true);
    }
    expect(writer.bufferedEntries()).toBe(MAX_BUFFERED_INPUT_ENTRIES);
    expect(writer.write(MAX_BUFFERED_INPUT_ENTRIES + 1, payload(1, 1))).toBe(false);
    expect(writer.droppedCount()).toBe(1);
  });

  test('the byte budget binds before the ring does', () => {
    // One-byte payloads at the entry cap plus the largest payloads the byte
    // budget admits must both fit without the ring ever refusing a write.
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const writer = createInputRingWriter(sab);
    let seq = 1;
    let bytes = 0;
    const chunk = payload(64, 7);
    while (bytes + chunk.byteLength <= MAX_BUFFERED_INPUT_BYTES) {
      expect(writer.write(seq, chunk)).toBe(true);
      seq += 1;
      bytes += chunk.byteLength;
    }
    expect(writer.droppedCount()).toBe(0);
    expect(writer.bufferedBytes()).toBe(bytes);
  });

  test('never classifies a rejected write and fails closed if classification throws', () => {
    const sab = new SharedArrayBuffer(160);
    const writer = createInputRingWriter(sab);
    const reader = createInputRingReader(sab);
    let classifications = 0;

    expect(
      writer.write(1, payload(40, 1), () => {
        classifications += 1;
        throw new Error('prediction queue failed');
      }),
    ).toBe(true);
    expect(reader.shadowModelled(reader.tryReadNext())).toBe(false);

    expect(writer.write(2, payload(40, 2))).toBe(true);
    expect(
      writer.write(3, payload(40, 3), () => {
        classifications += 1;
        return true;
      }),
    ).toBe(false);
    expect(classifications).toBe(1);
  });

  test('the budget counts every entry from publication until its release', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const writer = createInputRingWriter(sab);
    const reader = createInputRingReader(sab);

    expect(writer.bufferedBytes()).toBe(0);
    expect(writer.bufferedEntries()).toBe(0);
    expect(writer.write(1, payload(4, 7))).toBe(true);
    expect(writer.write(2, payload(3, 8))).toBe(true);
    expect(writer.bufferedBytes()).toBe(7);
    expect(writer.bufferedEntries()).toBe(2);

    // Reading is not a transfer: the charge is unchanged.
    expect(reader.tryReadNext()).toBe(0);
    expect(writer.bufferedBytes()).toBe(7);
    expect(writer.bufferedEntries()).toBe(2);

    // A release of ordinals below 1 returns exactly that entry's charge, and
    // a repeated release is a no-op.
    reader.release(1);
    reader.release(1);
    expect(writer.bufferedBytes()).toBe(3);
    expect(writer.bufferedEntries()).toBe(1);
  });

  test('discardQueuedEntries drops only unread entries and releases their charge', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const writer = createInputRingWriter(sab);
    const reader = createInputRingReader(sab);

    expect(writer.write(1, payload(3, 1))).toBe(true);
    expect(writer.write(2, payload(5, 2))).toBe(true);
    expect(writer.write(3, payload(7, 3))).toBe(true);
    const held = reader.tryReadNext();
    expect(reader.discardQueuedEntries()).toBe(2);
    // The held entry survives with its charge; the unread two are gone.
    expect(writer.bufferedBytes()).toBe(3);
    expect(writer.bufferedEntries()).toBe(1);
    expect(reader.tryReadNext()).toBe(-1);
    expect(readPayload(reader, held)).toEqual(payload(3, 1));

    reader.release(held + 1);
    expect(writer.bufferedBytes()).toBe(0);
    expect(writer.bufferedEntries()).toBe(0);
    expect(writer.write(4, payload(2, 4))).toBe(true);
    expect(reader.localSeq(reader.tryReadNext())).toBe(4);
  });

  test('a deferred entry is silent and invisible until an ordinary entry carries it', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    let edges = 0;
    const writer = createInputRingWriter(sab, undefined, () => {
      edges += 1;
    });
    const reader = createInputRingReader(sab);

    expect(writer.write(1, payload(2, 1), undefined, true)).toBe(true);
    expect(writer.write(2, payload(2, 2), undefined, true)).toBe(true);
    // Charged like any entry, so admission still bounds it, but not announced.
    expect(writer.bufferedEntries()).toBe(2);
    expect(edges).toBe(0);
    expect(reader.tryReadNext()).toBe(-1);

    expect(reader.hasReadable()).toBe(false);

    expect(writer.write(3, payload(2, 3))).toBe(true);
    expect(edges).toBe(1);
    // The drain loop sends once, at the entry nothing readable follows.
    const read: Array<[number, boolean, boolean]> = [];
    for (let ordinal = reader.tryReadNext(); ordinal >= 0; ordinal = reader.tryReadNext()) {
      read.push([reader.localSeq(ordinal), reader.deferred(ordinal), reader.hasReadable()]);
    }
    expect(read).toEqual([
      [1, true, true],
      [2, true, true],
      [3, false, false],
    ]);
  });

  test('releaseDeferred clears what was published before it and nothing after', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    let edges = 0;
    const writer = createInputRingWriter(sab, undefined, () => {
      edges += 1;
    });
    const reader = createInputRingReader(sab);

    writer.releaseDeferred();
    expect(edges).toBe(0);
    expect(writer.write(1, payload(2, 1), undefined, true)).toBe(true);
    writer.releaseDeferred();
    expect(edges).toBe(1);
    expect(writer.write(2, payload(2, 2), undefined, true)).toBe(true);

    expect(reader.localSeq(reader.tryReadNext())).toBe(1);
    expect(reader.tryReadNext()).toBe(-1);
    writer.releaseDeferred();
    expect(reader.localSeq(reader.tryReadNext())).toBe(2);
    expect(reader.tryReadNext()).toBe(-1);
  });

  test('the cleared bound holds across a wrap onto a skip marker', () => {
    // 128 data bytes: two 48-byte slots fit before the alignment slack.
    const sab = new SharedArrayBuffer(160);
    const writer = createInputRingWriter(sab);
    const reader = createInputRingReader(sab);
    const meta = new Int32Array(sab, 0, 8);

    expect(writer.write(1, payload(40, 1))).toBe(true);
    reader.release(reader.tryReadNext() + 1);
    expect(writer.write(2, payload(40, 2), undefined, true)).toBe(true);
    writer.releaseDeferred();
    const released = reader.tryReadNext();
    expect(reader.localSeq(released)).toBe(2);
    reader.release(released + 1);

    // The next entry wraps: a skip marker now sits exactly at the cleared
    // bound, and the entry behind it was published after the release.
    expect(writer.write(3, payload(40, 3), undefined, true)).toBe(true);
    expect(Atomics.load(meta, 0)).toBe(48);
    expect(reader.tryReadNext()).toBe(-1);
    writer.releaseDeferred();
    expect(reader.localSeq(reader.tryReadNext())).toBe(3);
  });

  test('a release covers only entries published before it', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const writer = createInputRingWriter(sab);
    const reader = createInputRingReader(sab);

    // A discarded held entry leaves the writer holding; the ordinary entry
    // after it releases a bound the reader passes without meeting a deferred
    // entry. A later deferred entry is still above that bound.
    expect(writer.write(1, payload(2, 1), undefined, true)).toBe(true);
    expect(reader.discardQueuedEntries()).toBe(1);
    expect(writer.write(2, payload(2, 2))).toBe(true);
    expect(writer.write(3, payload(2, 3))).toBe(true);
    expect(writer.write(4, payload(2, 4), undefined, true)).toBe(true);
    expect(reader.localSeq(reader.tryReadNext())).toBe(2);
    expect(reader.localSeq(reader.tryReadNext())).toBe(3);
    expect(reader.tryReadNext()).toBe(-1);

    // A new writer restarts seqs, so it restarts the bound with them.
    const replacement = createInputRingWriter(sab);
    expect(replacement.write(1, payload(2, 5), undefined, true)).toBe(true);
    expect(reader.discardQueuedEntries()).toBe(2);
  });

  test('a reader holding only deferred entries parks until they are released', async () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const writer = createInputRingWriter(sab);
    const reader = createInputRingReader(sab, 60_000);

    expect(writer.write(1, payload(2, 1), undefined, true)).toBe(true);
    expect(reader.tryReadNext()).toBe(-1);
    const wait = reader.waitAsync();
    if (wait === 'not-equal') throw new Error('a held head must park, not spin');
    writer.releaseDeferred();
    await wait;
    expect(reader.localSeq(reader.tryReadNext())).toBe(1);
  });

  test('discarding unread entries drops held ones with their charge', () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const writer = createInputRingWriter(sab);
    const reader = createInputRingReader(sab);

    expect(writer.write(1, payload(2, 1), undefined, true)).toBe(true);
    expect(reader.discardQueuedEntries()).toBe(1);
    expect(writer.bufferedEntries()).toBe(0);
    expect(writer.write(2, payload(2, 2))).toBe(true);
    expect(reader.localSeq(reader.tryReadNext())).toBe(2);
  });

  test('waitAsync resolves once a write lands', async () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const writer = createInputRingWriter(sab);
    const reader = createInputRingReader(sab);

    const wait = reader.waitAsync();
    expect(wait).not.toBe('not-equal');
    writer.write(1, payload(4, 7));
    await wait;
    expect(reader.localSeq(reader.tryReadNext())).toBe(1);
  });

  test('periodically wakes an empty reader without a producer notification', async () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const reader = createInputRingReader(sab, 1);

    const wait = reader.waitAsync();
    expect(wait).not.toBe('not-equal');
    // The wait's own verdict: the watchdog, not a producer, ended it.
    await expect(wait as Promise<unknown>).resolves.toBe('timed-out');
    expect(reader.tryReadNext()).toBe(-1);
  });

  test('a resume hint directly wakes a parked reader without waiting for the watchdog', async () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const reader = createInputRingReader(sab, 60_000);
    const wait = reader.waitAsync();
    if (wait === 'not-equal') throw new Error('empty reader did not park');

    expect(wakeInputRingReader(sab)).toBe(1);
    await wait;
    expect(reader.tryReadNext()).toBe(-1);
  });
});
