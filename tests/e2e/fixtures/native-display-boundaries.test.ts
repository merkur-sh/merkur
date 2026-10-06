import { expect, test } from 'bun:test';
import type { TerminalPerfEvent } from '../../../apps/web/src/perf/terminal-latency';
import type { NativePerfTraceRecord } from '../../../packages/shared/src/native-perf-trace';
import type { DaemonPerfTraceCapture } from './daemon-perf-trace-capture';
import {
  resolveNativeBrowserSessionBinding,
  summarizeNativeDisplayBoundaries,
} from './native-display-boundaries';

type Record = NativePerfTraceRecord;
type Receipt = Extract<TerminalPerfEvent, { kind: 'display_received' }>;

function record(kind: Record['kind'], at_us: number, fields: number[]): Record {
  return {
    kind,
    at_us,
    ordinal: 0,
    owner: 1,
    fields: [...fields, ...Array(16 - fields.length).fill(0)],
  };
}
function member(seq: number, at: number): Record {
  return record('display_member', at, [seq, 1, seq, 7, seq - 1, 2, 0, 1, 0, 1, 100]);
}
function attempt(
  seq: number,
  start: number,
  end: number,
  tag = seq,
  carrier = 0,
  accepted = true,
): Record {
  return record('display_attempt', end, [
    seq,
    1,
    0,
    carrier,
    start,
    Number(accepted),
    100,
    1000,
    0,
    0,
    tag,
    2,
    3,
    4,
  ]);
}
function quic(phase: number, at: number, tag: number, connection = 1, packet = 1): Record {
  return record('quic_datagram', at, [
    phase,
    connection,
    phase === 0 ? 0 : packet,
    100,
    phase >= 2 ? 0 : 102,
    tag,
    2,
    3,
    4,
  ]);
}
function native(input: readonly Record[], dropped = 0): [DaemonPerfTraceCapture] {
  const records = input.map((value, index) => ({ ...value, ordinal: index + 1 }));
  return [
    {
      status: 'complete',
      terminalMarkerSeen: true,
      daemonId: 'daemon',
      requestedAfterMs: 100,
      commandId: 'capture',
      captureRequestedAtMs: 100,
      captureCompletedAtMs: 101,
      errors: [],
      rawLog: '',
      chunks: [
        {
          command_id: 'capture',
          owner: 1,
          peer_id: 'peer',
          session_id: 'session',
          observation_epoch: 1,
          attempted: records.length + dropped,
          dropped,
          stale: 0,
          record_count: records.length,
          first_ordinal: records.length === 0 ? 0 : 1,
          last_ordinal: records.length,
          chunk_index: 0,
          chunk_count: 1,
          records,
        },
      ],
    },
  ];
}
function received(seq: number, atMs: number): Receipt {
  return {
    kind: 'display_received',
    atMs,
    displaySeq: seq,
    generation: 1,
    inputSeq: 1,
    frameId: seq,
    chunkIndex: 0,
    chunkCount: 1,
    presentationId: 7,
    presentationMemberIndex: seq - 1,
    presentationMemberCount: 2,
    rowPredecessorPresentationId: 0,
    presentationTransactionSeq: 0,
    presentationCoherent: true,
    presentationEnd: seq === 2,
    fecRecovered: false,
    authoritativeVisualMutation: null,
    workerReceiptToDecodeMs: 0.1,
    decodeToApplyMs: null,
    byteLength: 100,
    rowCount: 1,
    displayKind: 'display_delta',
  };
}
function browser(
  receiveTimes: readonly number[],
  commitTimes: readonly number[],
): TerminalPerfEvent[] {
  return receiveTimes.flatMap((at, index): TerminalPerfEvent[] => {
    const seq = index + 1;
    const receipt = received(seq, at);
    const commitAt = commitTimes[index];
    if (commitAt === undefined) throw new Error('missing synthetic commit');
    return [
      receipt,
      {
        ...receipt,
        kind: 'worker_display_applied',
        atMs: at + 0.1,
        presentationTransactionSeq: seq,
        authoritativeVisualMutation: true,
        decodeToApplyMs: 0.1,
      },
      {
        kind: 'presentation_commit',
        atMs: commitAt,
        releaseFrameTimeMs: 0,
        releaseFrameCount: 0,
        membershipReleaseDisableBits: 0,
        transactionSeq: seq,
        renderSeq: seq,
        generation: 1,
        firstDisplaySeq: seq,
        lastDisplaySeq: seq,
        displayInputSeq: 1,
        displayEchoHorizonSeq: 1,
        firstPresentationId: 7,
        lastPresentationId: 7,
        firstApplyToCommitMs: commitAt - at - 0.1,
        lastApplyToCommitMs: commitAt - at - 0.1,
        deadlineOverrunMs: 0,
        refreshPeriodMs: 8.3,
        datagramCount: 1,
        rowCount: 1,
        byteLength: 100,
        queueHighWater: 0,
        coherent: true,
        endSeen: seq === 2,
        authoritativeVisualChange: true,
        reason: 'deadline-timer',
      },
    ];
  });
}
function twoMembers(secondQueue: number, secondPacket: number): Record[] {
  return [
    member(1, 0),
    quic(0, 10, 1),
    attempt(1, 9, 11),
    quic(1, 12, 1),
    member(2, 1),
    quic(0, secondQueue, 2),
    attempt(2, secondQueue - 1, secondQueue + 1),
    quic(1, secondPacket, 2, 1, 2),
  ];
}

test('separates sender admission spread from browser submission exposure without mixing clocks', () => {
  const result = summarizeNativeDisplayBoundaries(
    native(twoMembers(20_010, 20_012)),
    browser([1_000, 1_020], [1_008, 1_028]),
    'session',
  );
  expect(result.exactJoinEligible).toBe(true);
  expect(result.presentations[0]).toMatchObject({
    nativeMembershipComplete: true,
    allObservedMutationsJoined: true,
    firstAdmissionSpanUs: 20_000,
    firstPacketizationSpanUs: 20_000,
    browserReceiptSpanMs: 20,
    screenChangingSubmissionExposureMs: 20,
  });
  expect(result.attempts.map((value) => value.queueToPacketizedUs)).toEqual([2, 2]);
});

test('identifies pre-packetization queue residence independently of admission spread', () => {
  const result = summarizeNativeDisplayBoundaries(
    native(twoMembers(11, 20_012)),
    browser([1_000, 1_020], [1_008, 1_028]),
    'session',
  );
  expect(result.exactJoinEligible).toBe(true);
  expect(result.presentations[0]?.firstAdmissionSpanUs).toBe(1);
  expect(result.presentations[0]?.firstPacketizationSpanUs).toBe(20_000);
  expect(result.attempts[1]?.queueToPacketizedUs).toBe(20_001);
});

test('retains downstream receipt spread when observed sender packetization is compact', () => {
  const result = summarizeNativeDisplayBoundaries(
    native(twoMembers(11, 13)),
    browser([1_000, 1_080], [1_008, 1_088]),
    'session',
  );
  expect(result.exactJoinEligible).toBe(true);
  expect(result.presentations[0]?.firstPacketizationSpanUs).toBe(1);
  expect(result.presentations[0]?.browserReceiptSpanMs).toBe(80);
});

test('identical ciphertext copies retain connection/FIFO identity and packet-specific outcomes', () => {
  const result = summarizeNativeDisplayBoundaries(
    native([
      quic(0, 10, 1),
      attempt(1, 9, 11),
      quic(0, 20, 1, 2),
      attempt(1, 19, 21, 1, 1),
      quic(0, 30, 1),
      attempt(1, 29, 31),
      quic(1, 40, 1, 1, 1),
      quic(1, 50, 1, 2, 1),
      quic(1, 60, 1, 1, 2),
      quic(3, 70, 0, 1, 1),
      quic(2, 80, 0, 2, 1),
      quic(2, 90, 0, 1, 99),
    ]),
    [],
    'session',
  );
  expect(result.exactJoinEligible).toBe(true);
  expect(result.copies.map((copy) => copy.packetized?.at_us)).toEqual([40, 50, 60]);
  expect(result.copies.map((copy) => copy.outcomes.map((outcome) => outcome.fields[0]))).toEqual([
    [3],
    [2],
    [],
  ]);
  expect(result.unrelatedPacketOutcomes).toHaveLength(1);
});

test('sequential dual-carrier replicas sharing a microsecond retain distinct unique queue ownership', () => {
  const result = summarizeNativeDisplayBoundaries(
    native([
      quic(0, 10, 1, 1),
      attempt(1, 9, 10, 1, 0),
      quic(0, 10, 1, 2),
      attempt(1, 10, 10, 1, 1),
      quic(1, 12, 1, 2),
      quic(1, 14, 1, 1),
    ]),
    [],
    'session',
  );
  expect(result.exactJoinEligible).toBe(true);
  expect(result.attempts.map((value) => value.candidateQueueOrdinals)).toEqual([[1], [3]]);
  expect(result.attempts.map((value) => value.copy?.queue.ordinal)).toEqual([1, 3]);
  expect(result.attempts.map((value) => value.queueToPacketizedUs)).toEqual([4, 2]);
  expect(result.nonDisplayCopies).toHaveLength(0);
});

test('a refused replica sharing the prior admission microsecond does not inherit its queue', () => {
  const result = summarizeNativeDisplayBoundaries(
    native([quic(0, 10, 1), attempt(1, 9, 10), attempt(1, 10, 10, 1, 1, false), quic(1, 12, 1)]),
    [],
    'session',
  );
  expect(result.exactJoinEligible).toBe(true);
  expect(result.attempts[1]).toMatchObject({
    accepted: false,
    copy: null,
    candidateQueueOrdinals: [],
    joinError: null,
  });
});

test('a refused same-clock call still rejects genuinely unassigned queue evidence', () => {
  const result = summarizeNativeDisplayBoundaries(
    native([quic(0, 10, 1), attempt(1, 10, 10, 1, 0, false)]),
    [],
    'session',
  );
  expect(result.exactJoinEligible).toBe(false);
  expect(result.attempts[0]?.candidateQueueOrdinals).toEqual([1]);
  expect(result.attempts[0]?.copy).toBeNull();
  expect(result.errors).toContain('refused attempt 2 unexpectedly owns queue evidence');
});

test('missing queues, partial collection and mismatched sessions cannot yield an eligible join', () => {
  const records = twoMembers(11, 13);
  const raw = browser([1_000, 1_001], [1_008, 1_009]);
  expect(
    summarizeNativeDisplayBoundaries(
      native(records.filter((value) => value !== records[1])),
      raw,
      'session',
    ).exactJoinEligible,
  ).toBe(false);
  expect(
    summarizeNativeDisplayBoundaries(native(records, 1), raw, 'session').exactJoinEligible,
  ).toBe(false);
  expect(
    summarizeNativeDisplayBoundaries(native(records), raw, 'other-session').exactJoinEligible,
  ).toBe(false);
});

test('ambiguous same-tag queues in one call bracket remain ambiguous, never nearest-neighbor', () => {
  const result = summarizeNativeDisplayBoundaries(
    native([quic(0, 10, 1), quic(0, 11, 1, 2), attempt(1, 9, 12)]),
    [],
    'session',
  );
  expect(result.exactJoinEligible).toBe(false);
  expect(result.attempts[0]?.candidateQueueOrdinals).toEqual([1, 2]);
  expect(result.attempts[0]?.copy).toBeNull();
});

test('nonmutating duplicate applications never widen screen-changing exposure', () => {
  const events = browser([1_000, 1_001], [1_008, 1_009]);
  const source = received(1, 1_100);
  events.push({
    ...source,
    kind: 'worker_display_applied',
    authoritativeVisualMutation: false,
    presentationTransactionSeq: 0,
  });
  const result = summarizeNativeDisplayBoundaries(native(twoMembers(11, 13)), events, 'session');
  expect(result.presentations[0]?.screenChangingSubmissionExposureMs).toBe(1);
});

test('startup binding never crosses a new browser correlation namespace', () => {
  const initial: TerminalPerfEvent[] = [
    { kind: 'session_start', atMs: 1 },
    {
      kind: 'session_bound',
      atMs: 2,
      merkurSessionId: 'session',
      networkType: 'unavailable',
      effectiveType: 'unavailable',
    },
  ];
  expect(resolveNativeBrowserSessionBinding(initial).sessionId).toBe('session');
  expect(() => resolveNativeBrowserSessionBinding(initial.slice(1))).toThrow();
  expect(() =>
    resolveNativeBrowserSessionBinding([...initial, { kind: 'session_start', atMs: 3 }]),
  ).toThrow();
  expect(() =>
    resolveNativeBrowserSessionBinding([
      ...initial,
      {
        kind: 'session_bound',
        atMs: 4,
        merkurSessionId: 'other',
        networkType: 'unavailable',
        effectiveType: 'unavailable',
      },
    ]),
  ).toThrow();
});

test('a missing admitted member cannot turn zero observed exposure into complete redraw evidence', () => {
  const result = summarizeNativeDisplayBoundaries(
    native(twoMembers(11, 13)),
    browser([1_000], [1_008]),
    'session',
  );
  expect(result.presentations[0]?.screenChangingSubmissionExposureMs).toBe(0);
  expect(result.presentations[0]?.browserMembershipComplete).toBe(false);
  expect(result.presentations[0]?.coherentPresentationEvidenceComplete).toBe(false);
  expect(result.presentations[0]?.unreceivedAdmittedMembers).toHaveLength(1);
});

test('one exact transaction shared by both mutations has zero submission exposure', () => {
  const events = browser([1_000, 1_001], [1_008, 1_009]).flatMap((event): TerminalPerfEvent[] => {
    if (event.kind === 'presentation_commit' && event.transactionSeq === 2) return [];
    if (event.kind === 'worker_display_applied')
      return [{ ...event, presentationTransactionSeq: 1 }];
    if (event.kind === 'presentation_commit')
      return [{ ...event, lastDisplaySeq: 2, rowCount: 2, datagramCount: 2, byteLength: 200 }];
    return [event];
  });
  const result = summarizeNativeDisplayBoundaries(native(twoMembers(11, 13)), events, 'session');
  expect(result.presentations[0]?.coherentPresentationEvidenceComplete).toBe(true);
  expect(result.presentations[0]?.screenChangingSubmissionExposureMs).toBe(0);
  expect(result.presentations[0]?.visualCommits).toHaveLength(1);
});

test('stale previous-observation discards do not disqualify lossless current-owner records', () => {
  const capture = native(twoMembers(11, 13))[0];
  const result = summarizeNativeDisplayBoundaries(
    [{ ...capture, chunks: capture.chunks.map((chunk) => ({ ...chunk, stale: 7 })) }],
    browser([1_000, 1_001], [1_008, 1_009]),
    'session',
  );
  expect(result.exactJoinEligible).toBe(true);
  expect(result.nativeCaptures[0]?.stalePreviousObservationRecords).toBe(7);
});

test('merges late-published ordinals and queue predecessors across exact-owner drains', () => {
  const capture = native(twoMembers(11, 13))[0];
  const chunk = capture.chunks[0];
  if (chunk === undefined) throw new Error('missing fixture chunk');
  const drain = (records: readonly Record[], commandId: string): DaemonPerfTraceCapture => ({
    ...capture,
    commandId,
    chunks: [
      {
        ...chunk,
        command_id: commandId,
        records,
        record_count: records.length,
        attempted: records.length,
        first_ordinal: records[0]?.ordinal ?? 0,
        last_ordinal: records.at(-1)?.ordinal ?? 0,
      },
    ],
  });
  const early = drain(
    chunk.records.filter((record) => record.ordinal !== 1 && record.ordinal !== 5),
    'early',
  );
  const late = drain(
    chunk.records.filter((record) => record.ordinal === 1 || record.ordinal === 5),
    'late',
  );
  const result = summarizeNativeDisplayBoundaries(
    [early, late],
    browser([1_000, 1_001], [1_008, 1_009]),
    'session',
  );
  expect(result.exactJoinEligible).toBe(true);
  expect(result.nativeRecords.map((record) => record.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  const split = summarizeNativeDisplayBoundaries(
    [drain(chunk.records.slice(0, 3), 'before'), drain(chunk.records.slice(3), 'after')],
    browser([1_000, 1_001], [1_008, 1_009]),
    'session',
  );
  expect(split.exactJoinEligible).toBe(true);
  expect(split.attempts[0]?.queueToPacketizedUs).toBe(2);
  const conflicting = drain(
    chunk.records.map((record) => ({ ...record, at_us: record.at_us + 1 })),
    'conflicting',
  );
  expect(
    summarizeNativeDisplayBoundaries([capture, conflicting], [], 'session').exactJoinEligible,
  ).toBe(false);
  expect(
    summarizeNativeDisplayBoundaries(
      [
        capture,
        {
          ...late,
          chunks: late.chunks.map((value) => ({
            ...value,
            owner: 2,
            records: value.records.map((record) => ({ ...record, owner: 2 })),
          })),
        },
      ],
      [],
      'session',
    ).exactJoinEligible,
  ).toBe(false);
});
