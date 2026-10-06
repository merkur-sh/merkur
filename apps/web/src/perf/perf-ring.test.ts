import { fullGC, heapStats } from 'bun:jsc';
import { describe, expect, test } from 'bun:test';
import {
  createPerfRingBuffer,
  createPerfRingReader,
  createPerfRingWriter,
  PERF_RECORD_F64_SLOTS,
  PERF_RECORD_U32_SLOTS,
  type PerfRecordView,
  perfRingByteLength,
} from './perf-ring';

interface DecodedRecord {
  readonly kind: number;
  readonly f64: number[];
  readonly u32: number[];
}

function drainAll(reader: ReturnType<typeof createPerfRingReader>): {
  readonly records: DecodedRecord[];
  readonly lost: number;
} {
  const records: DecodedRecord[] = [];
  const result = reader.drain((record) => {
    const f64: number[] = [];
    for (let slot = 0; slot < PERF_RECORD_F64_SLOTS; slot += 1) f64.push(record.f64(slot));
    const u32: number[] = [];
    for (let slot = 0; slot < PERF_RECORD_U32_SLOTS; slot += 1) u32.push(record.u32(slot));
    records.push({ kind: record.kind, f64, u32 });
  });
  expect(records).toHaveLength(result.drained);
  return { records, lost: result.lost };
}

/**
 * Cells allocated per op of `run`, net of the heap snapshot itself. Counts are
 * taken with no collection in between, so every cell the loop allocates is
 * still counted; a collection inside the loop could only lower the figure.
 */
function cellsPerOp(run: (ops: number) => void, ops: number): number {
  const cells = (): number => {
    const counts = heapStats().objectTypeCounts;
    let total = 0;
    for (const key in counts) total += counts[key] ?? 0;
    return total;
  };
  for (let warmup = 0; warmup < 20; warmup += 1) run(ops);
  fullGC();
  const snapshotStart = cells();
  const snapshotOverhead = cells() - snapshotStart;
  fullGC();
  const before = cells();
  run(ops);
  return (cells() - before - snapshotOverhead) / ops;
}

describe('perf ring', () => {
  test('round-trips every slot of a record', () => {
    const sab = createPerfRingBuffer(8);
    const writer = createPerfRingWriter(sab);
    const reader = createPerfRingReader(sab);

    writer.begin(7);
    // Fractional values are the reason timestamps get f64 slots at all:
    // `performance.now()` is sub-millisecond and truncating it would quantise
    // every sub-term in the decomposition.
    writer.f64(0, 1234.5678);
    writer.f64(7, -0.25);
    writer.u32(1, 4_294_967_295);
    writer.u32(15, 42);
    writer.commit();

    const { records, lost } = drainAll(reader);
    expect(lost).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe(7);
    expect(records[0]?.f64[0]).toBe(1234.5678);
    expect(records[0]?.f64[7]).toBe(-0.25);
    expect(records[0]?.u32[1]).toBe(4_294_967_295);
    expect(records[0]?.u32[15]).toBe(42);
  });

  test('signed slots survive the round trip', () => {
    const sab = createPerfRingBuffer(4);
    const writer = createPerfRingWriter(sab);
    const reader = createPerfRingReader(sab);

    // `prediction_gate.mode` is -1 when no rendered header exists yet, so the
    // u32 slots must be readable as signed without a bias hack.
    writer.begin(1);
    writer.i32(3, -1);
    writer.commit();

    const observed: number[] = [];
    reader.drain((record) => {
      observed.push(record.i32(3));
    });
    expect(observed).toEqual([-1]);
  });

  test('begin clears slots the previous record left behind', () => {
    const sab = createPerfRingBuffer(1);
    const writer = createPerfRingWriter(sab);
    const reader = createPerfRingReader(sab);

    writer.begin(1);
    writer.f64(3, 99);
    writer.u32(5, 99);
    writer.commit();
    drainAll(reader);

    // Same slot in the ring, an event kind that sets neither field.
    writer.begin(2);
    writer.commit();

    const { records } = drainAll(reader);
    expect(records[0]?.f64[3]).toBe(0);
    expect(records[0]?.u32[5]).toBe(0);
  });

  test('drains in write order across a wrap', () => {
    const sab = createPerfRingBuffer(4);
    const writer = createPerfRingWriter(sab);
    const reader = createPerfRingReader(sab);

    for (let index = 0; index < 3; index += 1) {
      writer.begin(1);
      writer.u32(1, index);
      writer.commit();
    }
    expect(drainAll(reader).records.map((r) => r.u32[1])).toEqual([0, 1, 2]);

    // Past the physical end of the ring; the cursor keeps counting.
    for (let index = 3; index < 7; index += 1) {
      writer.begin(1);
      writer.u32(1, index);
      writer.commit();
    }
    expect(drainAll(reader).records.map((r) => r.u32[1])).toEqual([3, 4, 5, 6]);
  });

  test('a full ring loses the OLDEST records and reports the loss', () => {
    const sab = createPerfRingBuffer(4);
    const writer = createPerfRingWriter(sab);
    const reader = createPerfRingReader(sab);

    // Ten records into four slots without draining. The frame ring would reject
    // the newest six; a profiler must never backpressure its subject, so the
    // oldest six are the ones that go.
    for (let index = 0; index < 10; index += 1) {
      writer.begin(1);
      writer.u32(1, index);
      writer.commit();
    }

    const { records, lost } = drainAll(reader);
    expect(lost).toBe(6);
    expect(records.map((r) => r.u32[1])).toEqual([6, 7, 8, 9]);
  });

  test('an empty drain reports nothing rather than replaying', () => {
    const sab = createPerfRingBuffer(4);
    const writer = createPerfRingWriter(sab);
    const reader = createPerfRingReader(sab);

    writer.begin(1);
    writer.commit();
    expect(drainAll(reader).records).toHaveLength(1);
    // Each record is delivered exactly once.
    expect(drainAll(reader).records).toHaveLength(0);
    expect(drainAll(reader).lost).toBe(0);
  });

  test('a record staged but not committed is never visible', () => {
    const sab = createPerfRingBuffer(4);
    const writer = createPerfRingWriter(sab);
    const reader = createPerfRingReader(sab);

    writer.begin(1);
    writer.u32(1, 7);
    // No commit: the cursor is the only publish signal.
    expect(drainAll(reader).records).toHaveLength(0);

    writer.commit();
    expect(drainAll(reader).records.map((r) => r.u32[1])).toEqual([7]);
  });

  test('every slot of every record survives the copy out of the ring', () => {
    const sab = createPerfRingBuffer(3);
    const writer = createPerfRingWriter(sab);
    const reader = createPerfRingReader(sab);
    const expected: DecodedRecord[] = [];

    for (let record = 0; record < 3; record += 1) {
      const f64: number[] = [];
      const u32: number[] = [];
      writer.begin(record + 1);
      for (let slot = 0; slot < PERF_RECORD_F64_SLOTS; slot += 1) {
        const value = record * 1_000.125 + slot * 0.5 - 3;
        writer.f64(slot, value);
        f64.push(value);
      }
      u32.push(record + 1);
      for (let slot = 1; slot < PERF_RECORD_U32_SLOTS; slot += 1) {
        const value = (record * 0x1000_0001 + slot * 0x0101_0101) >>> 0;
        writer.u32(slot, value);
        u32.push(value);
      }
      writer.commit();
      expected.push({ kind: record + 1, f64, u32 });
    }

    expect(drainAll(reader).records).toEqual(expected);
  });

  test('a drain copies records out without allocating per record', () => {
    const records = 1_024;
    const sab = createPerfRingBuffer(records);
    const writer = createPerfRingWriter(sab);
    const reader = createPerfRingReader(sab);
    let kinds = 0;
    const visit = (record: PerfRecordView): void => {
      kinds += record.kind;
    };
    const writeAndDrain = (count: number): void => {
      for (let index = 0; index < count; index += 1) {
        writer.begin(1);
        writer.f64(0, index);
        writer.u32(1, index);
        writer.commit();
      }
      reader.drain(visit);
    };

    // Copying through two `subarray` views costs 2 cells per record; the
    // drain result is one object per drain, not per record.
    expect(cellsPerOp(writeAndDrain, records)).toBeLessThan(0.5);
    expect(kinds).toBeGreaterThan(0);
  });

  test('byte length accounts for the meta header', () => {
    expect(perfRingByteLength(4)).toBe(64 + 4 * 128);
    // A buffer with no room for a record is a construction error, not a ring
    // that silently drops everything.
    expect(() => createPerfRingWriter(new SharedArrayBuffer(64))).toThrow(RangeError);
    expect(() => createPerfRingReader(new SharedArrayBuffer(64))).toThrow(RangeError);
  });
});
