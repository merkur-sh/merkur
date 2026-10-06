import { expect, test } from 'bun:test';
import type { NativePerfTraceRecord } from '../../../packages/shared/src/native-perf-trace';
import { summarizeNativePtyBoundaries } from './native-pty-boundaries';

type NativeRecord = NativePerfTraceRecord;
function record(
  kind: NativeRecord['kind'],
  at_us: number,
  fields: number[],
  owner = 1,
): NativeRecord {
  return {
    kind,
    at_us,
    fields: [...fields, ...Array(16 - fields.length).fill(0)],
    owner,
    ordinal: 0,
  };
}
function summarize(records: readonly NativeRecord[], exactJoinEligible = true) {
  return summarizeNativePtyBoundaries({
    nativeRecords: records.map((value, index) => ({ ...value, ordinal: index + 1 })),
    exactJoinEligible,
    errors: exactJoinEligible ? [] : ['unrelated QUIC packetization lacks a predecessor'],
  });
}
function write(ordinal = 9, source = 0, owner = 1): NativeRecord[] {
  return [
    record('pty_enqueue', 10, [0, ordinal, 37, source, 1, 3, 9], owner),
    record('pty_write', 20, [0, ordinal], owner),
    record('pty_write', 23, [1, ordinal], owner),
    record('pty_write', 35, [2, ordinal, 1, 2, 7, 1], owner),
    record('pty_write', 50, [3, ordinal], owner),
  ];
}

test('joins exact writer boundaries and retains syscall counters separately from envelopes', () => {
  const result = summarize(write());
  expect(result.writeOperations).toHaveLength(1);
  expect(result.writeOperations[0]).toMatchObject({
    owner: 1,
    operationOrdinal: 9,
    source: 'userInput',
    inputSeq: 37,
    outstandingEntries: 3,
    outstandingBytes: 9,
    queuedBytes: 1,
    completion: { acceptedBytes: 1, syscallCount: 2, summedSyscallUs: 7, success: true },
    endpointIssues: [],
    intervals: {
      enqueueToDequeue: { status: 'complete', valueUs: 10 },
      dequeueToFirstSyscall: { status: 'complete', valueUs: 3 },
      firstSyscallToCompletion: { status: 'complete', valueUs: 12 },
      completionToOwner: { status: 'complete', valueUs: 15 },
      enqueueToCompletion: { status: 'complete', valueUs: 25 },
    },
  });
  expect(result.distributions.userInput.summedSyscallUs).toMatchObject({
    sampleCount: 1,
    p50: 7,
    p95: 7,
    p99: 7,
    max: 7,
  });
});

test('separates owners, terminal replies and user input without sequence/clock proximity joins', () => {
  const result = summarize([...write(9, 0, 1), ...write(9, 1, 2)]);
  expect(result.writeOperations).toHaveLength(2);
  expect(result.distributions.userInput.operationCount).toBe(1);
  expect(result.distributions.terminalReply.operationCount).toBe(1);
  expect(result.writeOperations[1]?.inputSeq).toBeNull();
  expect(result.readOperations).toEqual([]);
});

test('read return-to-owner and grid intervals never imply input-to-echo attribution', () => {
  const result = summarize([
    ...write(),
    // Physical read predates the input but the owner handles it later.
    record('pty_read_handled', 100, [0, 8]),
    record('pty_read', 1, [0, 8]),
    record('pty_read', 5, [1, 8, 64]),
    record('pty_read_handled', 107, [1, 8]),
  ]);
  expect(result.readOperations[0]).toMatchObject({
    owner: 1,
    operationOrdinal: 8,
    returnedBytes: 64,
    endpointIssues: [],
    intervals: {
      readCall: { valueUs: 4 },
      readReturnToOwner: { valueUs: 95 },
      ownerToGrid: { valueUs: 7 },
    },
  });
  expect(result.readOperations[0]).not.toHaveProperty('inputSeq');
  expect(result.readOperations[0]).not.toHaveProperty('writeOrdinal');
});

test('missing, duplicate and negative endpoints remain explicit and excluded without clamping', () => {
  const result = summarize([
    record('pty_enqueue', 20, [0, 1, 1, 0, 1]),
    record('pty_write', 10, [0, 1]),
    record('pty_write', 30, [2, 1, 1, 1, 2, 1]),
    record('pty_write', 31, [2, 1, 1, 1, 2, 1]),
  ]);
  expect(result.writeOperations[0]?.intervals.enqueueToDequeue).toMatchObject({
    status: 'negative',
    differenceUs: -10,
    valueUs: null,
  });
  expect(result.writeOperations[0]?.intervals.dequeueToFirstSyscall.status).toBe('missing');
  expect(result.writeOperations[0]?.intervals.completionToOwner.status).toBe('duplicate');
  expect(result.writeOperations[0]?.endpoints.completion).toHaveLength(2);
  expect(result.distributions.userInput.intervals.enqueueToDequeue).toMatchObject({
    observedOperationCount: 1,
    sampleCount: 0,
    excluded: { negative: 1, duplicate: 0, missing: 0 },
    p50: null,
    p95: null,
    p99: null,
    max: null,
  });
  expect(result.distributions.userInput.summedSyscallUs.sampleCount).toBe(0);
});

test('independent complete PTY subsets survive unrelated display errors with provenance retained', () => {
  const result = summarize(write(), false);
  expect(result.sourceDisplayJoin.exactJoinEligible).toBe(false);
  expect(result.sourceDisplayJoin.errors).toHaveLength(1);
  expect(result.distributions.userInput.intervals.enqueueToDequeue.sampleCount).toBe(1);
  expect(result.diagnosticOnly).toBe(true);
  expect(result.population).toContain('not full-phase');
});

test('distributions retain exact denominators and use documented nearest-rank percentiles', () => {
  const result = summarize(
    Array.from({ length: 100 }, (_, index) => [
      record('pty_enqueue', 1, [0, index + 1, index + 1, 0, 1]),
      record('pty_write', index + 2, [0, index + 1]),
    ]).flat(),
  );
  const distribution = result.distributions.userInput.intervals.enqueueToDequeue;
  expect(distribution.sampleCount).toBe(100);
  expect(distribution.observedOperationCount).toBe(100);
  expect(distribution.percentileMethod).toBe('nearest-rank');
  expect(distribution.p50).toBe(50);
  expect(distribution.p95).toBe(95);
  expect(distribution.p99).toBe(99);
  expect(distribution.max).toBe(100);
  expect(result.distributions.userInput.intervals.completionToOwner.excluded.missing).toBe(100);
});

test('retains censored reads, unknown subkinds and zero-call completions without fabricated calls', () => {
  const result = summarize([
    record('pty_boundary_discard', 10, [0, 1, 1, 4]),
    record('pty_write', 10, [99, 1]),
    record('pty_enqueue', 20, [0, 2, 3, 0, 0]),
    record('pty_write', 25, [0, 2]),
    record('pty_write', 26, [2, 2, 0, 0, 0, 1]),
    record('pty_write', 30, [3, 2]),
    record('pty_write', 40, [2, 3, 2, 2, 4, 0]),
  ]);
  expect(result.boundaryDiscards).toHaveLength(1);
  expect(result.unclassifiedRecords).toHaveLength(1);
  expect(result.readOperations).toHaveLength(0);
  expect(result.writeOperations[0]?.intervals.dequeueToFirstSyscall.status).toBe('missing');
  expect(result.distributions.userInput.summedSyscallUs).toMatchObject({ sampleCount: 1, max: 0 });
  expect(result.distributions.unknownWriteSource.unsuccessfulCompletionCount).toBe(1);
});

test('empty evidence produces no zero-latency synthetic samples', () => {
  const result = summarize([]);
  expect(result.distributions.userInput.intervals.enqueueToDequeue).toMatchObject({
    observedOperationCount: 0,
    sampleCount: 0,
    p50: null,
    p95: null,
    p99: null,
    max: null,
  });
  expect(result.distributions.reads.operationCount).toBe(0);
});
