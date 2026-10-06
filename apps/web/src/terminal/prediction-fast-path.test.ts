import { describe, expect, spyOn, test } from 'bun:test';
import {
  createPredictionFastPathBuffer,
  createPredictionFastPathConsumer,
  createPredictionFastPathWriter,
  createPredictionFastStateReader,
  PREDICTION_COMMAND_BACKSPACE,
  PREDICTION_COMMAND_CURSOR_SHIFT,
  PREDICTION_COMMAND_FLUSH,
  PREDICTION_COMMAND_PRINTABLE,
  PREDICTION_COMMAND_SLOTS,
  type ProvisionalPreviewSnapshot,
} from './prediction-fast-path';

describe('prediction fast path', () => {
  test('fences commands until the worker adopts the required epoch', () => {
    const sab = createPredictionFastPathBuffer();
    const writer = createPredictionFastPathWriter(sab);
    const consumer = createPredictionFastPathConsumer(sab);

    expect(writer.writePrintable(1, 0x61, 100, true)).toBe(false);
    expect(writer.beginEpoch()).toBe(1);
    expect(writer.epochReady()).toBe(false);
    expect(consumer.adoptRequiredEpoch()).toBe(1);
    expect(writer.epochReady()).toBe(true);
    expect(writer.writePrintable(1, 0x61, 100, true)).toBe(true);
  });

  test('a hidden printable arrives hidden', () => {
    const sab = createPredictionFastPathBuffer();
    const writer = createPredictionFastPathWriter(sab);
    const consumer = createPredictionFastPathConsumer(sab);
    writer.beginEpoch();
    consumer.adoptRequiredEpoch();

    expect(writer.writePrintable(1, 0x61, 10, false)).toBe(true);
    const seen: boolean[] = [];
    consumer.drain(4, (_kind, _inputSeq, _value, _sentAtMs, visible) => {
      seen.push(visible);
    });
    expect(seen).toEqual([false]);
  });

  test('drains fixed commands in exact input order', () => {
    const sab = createPredictionFastPathBuffer();
    const writer = createPredictionFastPathWriter(sab);
    const consumer = createPredictionFastPathConsumer(sab);
    writer.beginEpoch();
    consumer.adoptRequiredEpoch();

    expect(writer.writePrintable(1, 0x61, 10, true)).toBe(true);
    expect(writer.writeBackspace(2, 11)).toBe(true);
    expect(writer.writeCursorShift(3, -1, 12)).toBe(true);
    expect(writer.writeFlush(4)).toBe(true);

    // The visible flag is the fifth field, and it rides in the entry's existing
    // alignment padding — assert the exact set, so a writer and a reader cannot
    // disagree about where it sits.
    const commands: Array<readonly [number, number, number, number, boolean]> = [];
    expect(
      consumer.drain(16, (kind, inputSeq, value, sentAtMs, visible) => {
        commands.push([kind, inputSeq, value, sentAtMs, visible]);
      }),
    ).toBe(4);
    expect(commands).toEqual([
      [PREDICTION_COMMAND_PRINTABLE, 1, 0x61, 10, true],
      [PREDICTION_COMMAND_BACKSPACE, 2, 0, 11, false],
      [PREDICTION_COMMAND_CURSOR_SHIFT, 3, -1, 12, false],
      [PREDICTION_COMMAND_FLUSH, 4, 0, 0, false],
    ]);
    expect(consumer.pendingCount()).toBe(0);
  });

  test('publishes visibility and exact model revision without presentation ACK fields', () => {
    const sab = createPredictionFastPathBuffer();
    const writer = createPredictionFastPathWriter(sab);
    const consumer = createPredictionFastPathConsumer(sab);
    const state = createPredictionFastStateReader(sab);
    writer.beginEpoch();
    consumer.adoptRequiredEpoch();
    const before = consumer.modelVersion();
    consumer.publishVisible(true);
    expect(state.visible()).toBe(true);
    consumer.publishModel(true, 1, 1, 2, 3, 8, 80, 12);
    expect(consumer.modelVersion()).toBe((before + 2) >>> 0);
    consumer.publishVisible(false);
    expect(state.visible()).toBe(false);
    expect(writer.writePrintable(0x1_0000_0000, 0x61, 10, true)).toBe(false);
  });

  test('deduplicates identical model publication but advances fresh authority revision', () => {
    const sab = createPredictionFastPathBuffer();
    const writer = createPredictionFastPathWriter(sab);
    const consumer = createPredictionFastPathConsumer(sab);
    const state = createPredictionFastStateReader(sab);
    writer.beginEpoch();
    consumer.adoptRequiredEpoch();
    consumer.publishVisible(true);
    consumer.publishModel(true, 1, 1, 2, 3, 8, 80, 12);
    const revision = consumer.modelVersion();
    for (let i = 0; i < 100; i++) consumer.publishModel(true, 1, 1, 2, 3, 8, 80, 12);
    expect(consumer.modelVersion()).toBe(revision);
    consumer.invalidateModelRevision();
    expect(consumer.modelVersion()).toBe((revision + 2) >>> 0);
    expect(state.visible()).toBe(true);
    consumer.publishModel(true, 1, 1, 2, 3, 8, 80, 12);
    expect(consumer.modelVersion()).toBe((revision + 2) >>> 0);
    consumer.publishModel(true, 1, 1, 2, 3, 8, 80, 13);
    expect(consumer.modelVersion()).toBe((revision + 4) >>> 0);
    writer.beginEpoch();
    expect(state.visible()).toBe(false);
    consumer.adoptRequiredEpoch();
    expect(consumer.modelVersion()).toBe((revision + 6) >>> 0);
  });

  test('fails full-ring writes closed and reports the overflow boundary', () => {
    const sab = createPredictionFastPathBuffer();
    const writer = createPredictionFastPathWriter(sab);
    const consumer = createPredictionFastPathConsumer(sab);
    writer.beginEpoch();
    consumer.adoptRequiredEpoch();

    for (let inputSeq = 1; inputSeq < PREDICTION_COMMAND_SLOTS; inputSeq += 1) {
      expect(writer.writePrintable(inputSeq, 0x61, inputSeq, true)).toBe(true);
    }
    expect(writer.writePrintable(PREDICTION_COMMAND_SLOTS, 0x62, 5_000, true)).toBe(false);
    expect(writer.droppedCount()).toBe(1);
    expect(consumer.takeOverflowInputSeq()).toBe(PREDICTION_COMMAND_SLOTS);
  });

  test('latest pointer set has ten slots and no growing clear tombstone or command queue', () => {
    const sab = createPredictionFastPathBuffer();
    const writer = createPredictionFastPathWriter(sab);
    const consumer = createPredictionFastPathConsumer(sab);
    writer.beginEpoch();
    consumer.adoptRequiredEpoch();
    const byteLength = sab.byteLength;
    for (let pointer = 0; pointer < 10; pointer++)
      expect(writer.writeProvisional(pointer, 0x61, 1, 2)).toBe(true);
    expect(writer.writeProvisional(10, 0x62, 1, 2)).toBe(false);
    let first: ProvisionalPreviewSnapshot | undefined;
    expect(
      consumer.drainProvisionalPreviews((snapshot) => {
        first = snapshot;
        expect(snapshot.activeMask).toBe(1023);
      }),
    ).toBe(true);
    for (let pointer = 10; pointer < 1010; pointer++) {
      expect(writer.writeProvisional(pointer - 10, null, 1, 0)).toBe(true);
      expect(writer.writeProvisional(pointer, 0x62, 1, 2)).toBe(true);
    }
    expect(consumer.pendingCount()).toBe(0);
    expect(writer.droppedCount()).toBe(0);
    expect(sab.byteLength).toBe(byteLength);
    expect(
      consumer.drainProvisionalPreviews((snapshot) => {
        if (first === undefined) throw new Error('initial preview snapshot missing');
        expect(snapshot).toBe(first);
        expect(snapshot.activeMask).toBe(1023);
        expect([...snapshot.pointers].sort((a, b) => a - b)).toEqual([
          1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009,
        ]);
      }),
    ).toBe(true);
    expect(consumer.previewsPending()).toBe(false);
    expect(
      consumer.drainProvisionalPreviews(() => {
        throw new Error('unchanged snapshot repeated');
      }),
    ).toBe(false);
  });

  test('preview input validation and epoch clearing never admit stale unsent choices', () => {
    const sab = createPredictionFastPathBuffer();
    const writer = createPredictionFastPathWriter(sab);
    const consumer = createPredictionFastPathConsumer(sab);
    expect(writer.writeProvisional(1, 0x61, 1, 2)).toBe(false);
    writer.beginEpoch();
    consumer.adoptRequiredEpoch();
    for (const values of [
      [-1, 0x61, 1, 2],
      [1.5, 0x61, 1, 2],
      [1, 0x1f, 1, 2],
      [1, 0x7f, 1, 2],
      [1, 0x61, 0, 2],
      [1, 0x61, 1, 0],
      [1, 0x61, 1, 3],
      [1, 0x61, 1, 2 ** 32],
    ]) {
      expect(
        writer.writeProvisional(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0),
      ).toBe(false);
    }
    expect(writer.writeProvisional(Number.MAX_SAFE_INTEGER, 0x61, 1, 2)).toBe(true);
    consumer.publishVisible(false);
    expect(writer.writeProvisional(Number.MAX_SAFE_INTEGER, null, 1, 0)).toBe(true);
    writer.writeProvisional(2, 0x62, 1, 2);
    writer.beginEpoch();
    expect(
      consumer.drainProvisionalPreviews(() => {
        throw new Error('unadopted epoch');
      }),
    ).toBe(false);
    consumer.adoptRequiredEpoch();
    expect(writer.writeProvisional(2, 0x62, 1, 2)).toBe(false);
    consumer.drainProvisionalPreviews((snapshot) => {
      expect(snapshot.activeMask).toBe(0);
      expect([...snapshot.pointers]).toEqual(Array(10).fill(0));
      expect([...snapshot.codepoints]).toEqual(Array(10).fill(0));
    });
  });

  test('a preview arriving exactly between work check and wait cannot lose its wake', () => {
    const sab = createPredictionFastPathBuffer();
    const writer = createPredictionFastPathWriter(sab);
    const consumer = createPredictionFastPathConsumer(sab);
    writer.beginEpoch();
    consumer.adoptRequiredEpoch();
    consumer.drainProvisionalPreviews(() => {});
    const original = Atomics.waitAsync;
    const waiting = spyOn(Atomics, 'waitAsync').mockImplementation(
      (words, index, value, timeout) => {
        writer.writeProvisional(1, 0x61, 1, 2);
        if (words instanceof Int32Array && typeof value === 'number')
          return original(words, index, value, timeout);
        if (words instanceof BigInt64Array && typeof value === 'bigint')
          return original(words, index, value, timeout);
        throw new TypeError('mismatched atomic wait value');
      },
    );
    try {
      expect(consumer.waitAsync(1000)).toBe('not-equal');
      expect(consumer.previewsPending()).toBe(true);
      expect(consumer.pendingCount()).toBe(0);
    } finally {
      waiting.mockRestore();
    }
  });

  test('an already parked idle consumer wakes for preview-only work', async () => {
    const sab = createPredictionFastPathBuffer();
    const writer = createPredictionFastPathWriter(sab);
    const consumer = createPredictionFastPathConsumer(sab);
    writer.beginEpoch();
    consumer.adoptRequiredEpoch();
    consumer.drainProvisionalPreviews(() => {});
    const wait = consumer.waitAsync(1000);
    expect(wait).not.toBe('not-equal');
    writer.writeProvisional(1, 0x61, 1, 2);
    // The wait's own verdict: the preview's wake, not the timeout, ended it.
    await expect(wait as Promise<unknown>).resolves.toBe('ok');
    expect(consumer.previewsPending()).toBe(true);
  });

  test('seqlock retries a pointer set overwritten in the middle of its borrowed read', () => {
    const sab = createPredictionFastPathBuffer();
    const writer = createPredictionFastPathWriter(sab);
    const consumer = createPredictionFastPathConsumer(sab);
    writer.beginEpoch();
    consumer.adoptRequiredEpoch();
    writer.writeProvisional(1, 0x61, 1, 2);
    let inject = true;
    const original = DataView.prototype.getFloat64;
    const reader = spyOn(DataView.prototype, 'getFloat64').mockImplementation(function (
      this: DataView,
      offset,
      littleEndian,
    ) {
      const value = original.call(this, offset, littleEndian);
      if (inject && this.buffer === sab) {
        inject = false;
        writer.writeProvisional(1, null, 1, 0);
        writer.writeProvisional(2, 0x62, 1, 2);
      }
      return value;
    });
    try {
      consumer.drainProvisionalPreviews((snapshot) => {
        expect(snapshot.activeMask).toBe(1);
        expect(snapshot.pointers[0]).toBe(2);
        expect(snapshot.codepoints[0]).toBe(0x62);
      });
    } finally {
      reader.mockRestore();
    }
  });
});
