import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { BROWSER_DISPLAY_IO_SCOPE } from '../../../apps/web/src/perf/browser-display-io';
import {
  buildTerminalLatencyReport,
  type TerminalLatencyPercentiles,
  type TerminalLatencyReport,
  type TerminalLatencySample,
  type TerminalPerfEvent,
} from '../../../apps/web/src/perf/terminal-latency';
import {
  BoundedTailBuffer,
  boundTerminalLatencyReport,
  buildTelemetryObservationRecorderMetadata,
  collectApplicationDisplayOutcome,
  collectPredictionDiagnostics,
  freezeTerminalPerfSnapshot,
  installE2ETerminalPerfRecorder,
  isCompleteLatencyDistribution,
  MAX_DIAGNOSTIC_EVENT_KINDS,
  mergeTerminalPerfWorkerAndHarnessEvents,
  normalizeRecorderMetadata,
  unavailableRecorderMetadata,
  validateRecorderMetadata,
  writeGzipJsonArray,
} from './terminal-perf-artifacts';
import { verifyRawTerminalPerfTrace } from './terminal-perf-replay';

describe('terminal performance artifact helpers', () => {
  test('preserves both recorder-owned boundary kinds beside a worker dump and replays them', () => {
    const workerEvents: TerminalPerfEvent[] = [
      {
        kind: 'display_pump_complete',
        atMs: 110,
        durationMs: 1,
        budgetMs: 4,
        processedDatagramCount: 1,
        processedRowCount: 1,
        queueHighWater: 0,
        queueRemaining: 0,
        ringBytesAtStart: 64,
        ringBytesAtEnd: 0,
        ringDroppedTotal: 5,
      },
    ];
    const recorderEvents: TerminalPerfEvent[] = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 3,
        phase: 'start',
        purpose: 'streaming',
      },
      {
        kind: 'display_ring_measurement_boundary',
        atMs: 100,
        measurementId: 3,
        phase: 'start',
        observationEpoch: 7,
        sessionEpoch: 2,
        ringDroppedTotal: 4,
      },
      {
        kind: 'presentation_measurement_boundary',
        atMs: 120,
        measurementId: 3,
        phase: 'end',
        purpose: 'streaming',
      },
      {
        kind: 'display_ring_measurement_boundary',
        atMs: 120,
        measurementId: 3,
        phase: 'end',
        observationEpoch: 7,
        sessionEpoch: 2,
        ringDroppedTotal: 5,
      },
    ];
    const merged = mergeTerminalPerfWorkerAndHarnessEvents(workerEvents, [
      { kind: 'not-a-boundary', atMs: 99 },
      ...recorderEvents,
    ]) as TerminalPerfEvent[];
    expect(merged).toEqual([...workerEvents, ...recorderEvents]);
    const observation = telemetryObservationCapture({
      retainedEventCount: workerEvents.length,
      totalRecordedCount: workerEvents.length,
    });
    const capture = buildTelemetryObservationRecorderMetadata(
      availableRecorderMetadata(recorderEvents.length),
      observation,
      workerEvents.length,
      recorderEvents.length,
      observation,
    );
    expect(capture.capture).toEqual(observation);
    expect(capture.recorder).toMatchObject({
      available: true,
      capacity: 20_004,
      resetAtMs: 100,
      retainedEventCount: merged.length,
      totalRecordedCount: merged.length,
      overwriteCount: 0,
      droppedEventCount: 0,
    });
    expect(validateRecorderMetadata(capture.recorder)).toEqual([]);
    const report = buildTerminalLatencyReport(merged);
    const outcome = collectApplicationDisplayOutcome(merged);
    const replay = verifyRawTerminalPerfTrace(
      gzipSync(JSON.stringify(merged)),
      merged.length,
      report,
      outcome,
    );
    expect(report.displayPipeline.ringRefusalAccountingComplete).toBe(true);
    expect(report.displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows).toMatchObject({
      count: 0,
      complete: true,
    });
    expect(
      replay.metricSamples['displayPipeline.ringRefusedFrameCountPerMeasurementWindow'],
    ).toEqual([1]);
    expect(replay.metricComplete['displayPipeline.ringRefusedFrameCountPerMeasurementWindow']).toBe(
      true,
    );
  });

  test('rejects plausible numeric latency tails when event joins are incomplete', () => {
    expect(
      isCompleteLatencyDistribution(
        { count: 100, p50: 2, p95: 4, p99: 6, max: 8, complete: false },
        65,
      ),
    ).toBe(false);
    expect(
      isCompleteLatencyDistribution(
        { count: 100, p50: 2, p95: 4, p99: 6, max: 8, complete: true },
        65,
      ),
    ).toBe(true);
  });

  test('raw replay refuses an absent or malformed completion disposition even with a matching incomplete report', () => {
    for (const completionDisposition of [undefined, null, 'unknown']) {
      const events = [{ kind: 'frame_complete', atMs: 1, completionDisposition }];
      expect(() =>
        verifyRawTerminalPerfTrace(
          gzipSync(JSON.stringify(events)),
          events.length,
          buildTerminalLatencyReport([]),
          collectApplicationDisplayOutcome([]),
        ),
      ).toThrow('malformed event envelope');
    }
  });

  test('fails closed on incomplete, malformed, mismatched, or miscounted observation capture', () => {
    const capture = telemetryObservationCapture({ retainedEventCount: 2, totalRecordedCount: 2 });
    expect(() =>
      buildTelemetryObservationRecorderMetadata(
        availableRecorderMetadata(),
        { ...capture, complete: false },
        2,
        0,
        capture,
      ),
    ).toThrow(/incomplete/);
    expect(() =>
      buildTelemetryObservationRecorderMetadata(
        availableRecorderMetadata(),
        { ...capture, unexpected: true },
        2,
        0,
        capture,
      ),
    ).toThrow(/malformed/);
    expect(() =>
      buildTelemetryObservationRecorderMetadata(availableRecorderMetadata(), capture, 2, 0, {
        ...capture,
        observationEpoch: capture.observationEpoch + 1,
      }),
    ).toThrow(/active boundary/);
    expect(() =>
      buildTelemetryObservationRecorderMetadata(
        availableRecorderMetadata(),
        capture,
        1,
        0,
        capture,
      ),
    ).toThrow(/capture accounts for 2/);
  });

  test('keeps producer loss distinct from retained overwrite in exact recorder accounting', () => {
    const capture = telemetryObservationCapture({
      retainedEventCount: 18,
      retainedOverwriteCount: 2,
      producerRecordLossCount: 3,
      droppedEventCount: 5,
      totalRecordedCount: 23,
    });
    const result = buildTelemetryObservationRecorderMetadata(
      availableRecorderMetadata(2),
      capture,
      18,
      2,
      capture,
    );
    expect(result.recorder).toMatchObject({
      capacity: 20_002,
      retainedEventCount: 20,
      totalRecordedCount: 25,
      overwriteCount: 2,
      droppedEventCount: 5,
    });
    expect(validateRecorderMetadata(result.recorder)).toEqual([
      'terminal recorder truncated 5 event(s) at capacity 20002',
    ]);
  });

  test('cannot hide loss or missing events in the harness boundary recorder', () => {
    const capture = telemetryObservationCapture();
    expect(() =>
      buildTelemetryObservationRecorderMetadata(
        {
          ...availableRecorderMetadata(2),
          totalRecordedCount: 3,
          overwriteCount: 1,
          droppedEventCount: 1,
        },
        capture,
        0,
        2,
        capture,
      ),
    ).toThrow(/boundary recorder metadata is invalid/);
    expect(() =>
      buildTelemetryObservationRecorderMetadata(
        availableRecorderMetadata(1),
        capture,
        0,
        2,
        capture,
      ),
    ).toThrow(/expected 2/);
    expect(() =>
      buildTelemetryObservationRecorderMetadata(
        { ...availableRecorderMetadata(2), schemaVersion: null },
        capture,
        0,
        2,
        capture,
      ),
    ).toThrow(/boundary recorder metadata is invalid/);
  });

  test('reports realized application display gaps separately from proxy packet loss', () => {
    const shared = {
      generation: 4,
      inputSeq: 8,
      frameId: 9,
      chunkIndex: 0,
      chunkCount: 1,
      presentationId: 2,
      presentationMemberIndex: 0,
      presentationMemberCount: 2,
      rowPredecessorPresentationId: 0,
      presentationCoherent: true,
      fecRecovered: false,
      presentationEnd: true,
      byteLength: 100,
      rowCount: 2,
      displayKind: 'display_delta' as const,
    };
    const outcome = collectApplicationDisplayOutcome([
      {
        kind: 'display_received',
        atMs: 10,
        displaySeq: 10,
        presentationTransactionSeq: 0,
        authoritativeVisualMutation: null,
        workerReceiptToDecodeMs: 0.5,
        decodeToApplyMs: null,
        ...shared,
      },
      {
        kind: 'display_received',
        atMs: 11,
        displaySeq: 12,
        presentationTransactionSeq: 0,
        authoritativeVisualMutation: null,
        workerReceiptToDecodeMs: 0.5,
        decodeToApplyMs: null,
        ...shared,
      },
      {
        kind: 'display_received',
        atMs: 12,
        displaySeq: 12,
        presentationTransactionSeq: 0,
        authoritativeVisualMutation: null,
        workerReceiptToDecodeMs: 0.5,
        decodeToApplyMs: null,
        ...shared,
      },
      {
        kind: 'worker_display_applied',
        atMs: 13,
        displaySeq: 10,
        presentationTransactionSeq: 3,
        authoritativeVisualMutation: true,
        workerReceiptToDecodeMs: null,
        decodeToApplyMs: 1,
        ...shared,
      },
      {
        kind: 'worker_display_applied',
        atMs: 14,
        displaySeq: 12,
        presentationTransactionSeq: 3,
        authoritativeVisualMutation: true,
        workerReceiptToDecodeMs: null,
        decodeToApplyMs: 1,
        ...shared,
      },
      {
        kind: 'display_resync',
        atMs: 15,
        reason: 'profiling_harness',
        generation: 4,
        alreadyPending: false,
      },
      {
        kind: 'presentation_commit',
        atMs: 16,
        releaseFrameTimeMs: 0,
        releaseFrameCount: 0,
        membershipReleaseDisableBits: 0,
        transactionSeq: 3,
        renderSeq: 7,
        generation: 4,
        firstDisplaySeq: 10,
        lastDisplaySeq: 12,
        displayInputSeq: 8,
        displayEchoHorizonSeq: 8,
        firstPresentationId: 2,
        lastPresentationId: 2,
        firstApplyToCommitMs: 3,
        lastApplyToCommitMs: 2,
        deadlineOverrunMs: 0,
        refreshPeriodMs: 16.67,
        datagramCount: 2,
        rowCount: 4,
        byteLength: 200,
        queueHighWater: 2,
        coherent: true,
        endSeen: true,
        authoritativeVisualChange: true,
        reason: 'repair-target-satisfied',
      },
    ] satisfies TerminalPerfEvent[]);

    expect(outcome).toEqual({
      complete: true,
      receivedEventCount: 3,
      uniqueReceivedDatagramCount: 2,
      duplicateReceivedEventCount: 1,
      appliedEventCount: 2,
      uniqueAppliedDatagramCount: 2,
      receivedWithoutApplyCount: 0,
      appliedWithoutReceiveCount: 0,
      observedSequenceSlotCount: 3,
      interiorSequenceGapCount: 1,
      outOfOrderReceivedDatagramCount: 0,
      fecRecoveredReceivedDatagramCount: 0,
      fecRecoveredAppliedDatagramCount: 0,
      fecRecoveredVisualAppliedDatagramCount: 0,
      interiorSequenceGapPercent: 100 / 3,
      snapshotReceivedCount: 0,
      snapshotAppliedCount: 0,
      snapshotReceivedChunkCount: 0,
      snapshotAppliedChunkCount: 0,
      resyncRequestCount: 1,
      resyncAlreadyPendingCount: 0,
      repairTargetSatisfiedCommitCount: 1,
      repairDeadlineExpiredCommitCount: 0,
    });
  });

  test('counts wrapped display gaps, first-arrival reordering, and expired repair commits', () => {
    const shared = {
      generation: 7,
      inputSeq: 1,
      frameId: 1,
      chunkIndex: 0,
      chunkCount: 1,
      presentationId: 1,
      presentationMemberIndex: 0,
      presentationMemberCount: 1,
      rowPredecessorPresentationId: 0,
      presentationCoherent: true,
      fecRecovered: false,
      presentationEnd: true,
      presentationTransactionSeq: 0,
      authoritativeVisualMutation: null,
      workerReceiptToDecodeMs: 0.1,
      decodeToApplyMs: null,
      byteLength: 64,
      rowCount: 1,
      displayKind: 'display_delta' as const,
    };
    const received = (atMs: number, displaySeq: number): TerminalPerfEvent => ({
      kind: 'display_received',
      atMs,
      displaySeq,
      ...shared,
    });
    const outcome = collectApplicationDisplayOutcome([
      received(1, 0xffff_ffff),
      received(2, 3),
      received(3, 1),
      received(4, 1),
      {
        kind: 'presentation_commit',
        atMs: 5,
        releaseFrameTimeMs: 0,
        releaseFrameCount: 0,
        membershipReleaseDisableBits: 0,
        transactionSeq: 1,
        renderSeq: 1,
        generation: 7,
        firstDisplaySeq: 0xffff_ffff,
        lastDisplaySeq: 3,
        displayInputSeq: 1,
        displayEchoHorizonSeq: 1,
        firstPresentationId: 1,
        lastPresentationId: 1,
        firstApplyToCommitMs: 1,
        lastApplyToCommitMs: 1,
        deadlineOverrunMs: 0,
        refreshPeriodMs: 16.67,
        datagramCount: 3,
        rowCount: 3,
        byteLength: 192,
        queueHighWater: 3,
        coherent: true,
        endSeen: true,
        authoritativeVisualChange: true,
        reason: 'repair-deadline-expired',
      },
    ]);

    expect(outcome.complete).toBe(true);
    expect(outcome.uniqueReceivedDatagramCount).toBe(3);
    expect(outcome.duplicateReceivedEventCount).toBe(1);
    expect(outcome.observedSequenceSlotCount).toBe(4);
    expect(outcome.interiorSequenceGapCount).toBe(1);
    expect(outcome.outOfOrderReceivedDatagramCount).toBe(1);
    expect(outcome.repairTargetSatisfiedCommitCount).toBe(0);
    expect(outcome.repairDeadlineExpiredCommitCount).toBe(1);
  });

  test('fails display-outcome completeness closed when apply provenance is missing', () => {
    const outcome = collectApplicationDisplayOutcome([
      {
        kind: 'worker_display_applied',
        atMs: 10,
        displaySeq: 3,
        generation: 1,
        inputSeq: 1,
        frameId: 1,
        chunkIndex: 0,
        chunkCount: 1,
        presentationId: 1,
        presentationMemberIndex: 0,
        presentationMemberCount: 0,
        rowPredecessorPresentationId: 0,
        presentationTransactionSeq: 1,
        presentationCoherent: false,
        fecRecovered: false,
        presentationEnd: true,
        authoritativeVisualMutation: true,
        workerReceiptToDecodeMs: null,
        decodeToApplyMs: 1,
        byteLength: 50,
        rowCount: 1,
        displayKind: 'display_snapshot',
      },
    ]);
    expect(outcome.complete).toBe(false);
    expect(outcome.appliedWithoutReceiveCount).toBe(1);
  });

  test('joins a multi-chunk sequence-zero snapshot by frame and chunk identity', () => {
    const snapshot = {
      generation: 3,
      displaySeq: 0,
      inputSeq: 7,
      frameId: 41,
      presentationId: 42,
      presentationMemberIndex: 0,
      presentationMemberCount: 0,
      rowPredecessorPresentationId: 0,
      presentationCoherent: false,
      fecRecovered: false,
      presentationEnd: true,
      displayKind: 'display_snapshot' as const,
    };
    const outcome = collectApplicationDisplayOutcome([
      {
        kind: 'display_received',
        atMs: 10,
        chunkIndex: 0,
        chunkCount: 2,
        presentationTransactionSeq: 0,
        authoritativeVisualMutation: null,
        workerReceiptToDecodeMs: 0.5,
        decodeToApplyMs: null,
        byteLength: 400,
        rowCount: 12,
        ...snapshot,
      },
      {
        kind: 'display_received',
        atMs: 11,
        chunkIndex: 1,
        chunkCount: 2,
        presentationTransactionSeq: 0,
        authoritativeVisualMutation: null,
        workerReceiptToDecodeMs: 0.5,
        decodeToApplyMs: null,
        byteLength: 368,
        rowCount: 12,
        ...snapshot,
      },
      {
        kind: 'worker_display_applied',
        atMs: 14,
        chunkIndex: 0,
        chunkCount: 2,
        presentationTransactionSeq: 9,
        authoritativeVisualMutation: true,
        workerReceiptToDecodeMs: null,
        decodeToApplyMs: 2,
        byteLength: 768,
        rowCount: 24,
        ...snapshot,
      },
    ] satisfies TerminalPerfEvent[]);

    expect(outcome.complete).toBe(true);
    expect(outcome.receivedEventCount).toBe(2);
    expect(outcome.uniqueReceivedDatagramCount).toBe(0);
    expect(outcome.appliedEventCount).toBe(1);
    expect(outcome.uniqueAppliedDatagramCount).toBe(0);
    expect(outcome.snapshotReceivedCount).toBe(1);
    expect(outcome.snapshotAppliedCount).toBe(1);
    expect(outcome.snapshotReceivedChunkCount).toBe(2);
    expect(outcome.snapshotAppliedChunkCount).toBe(2);
    expect(outcome.receivedWithoutApplyCount).toBe(0);
    expect(outcome.appliedWithoutReceiveCount).toBe(0);
    expect(outcome.observedSequenceSlotCount).toBe(0);
    expect(outcome.interiorSequenceGapCount).toBe(0);
    expect(outcome.interiorSequenceGapPercent).toBeNull();
  });

  test('bounded tail buffer preserves order and exposes every overwrite', () => {
    const buffer = new BoundedTailBuffer<number>(3);

    for (let value = 0; value < 6; value += 1) buffer.push(value);

    expect(buffer.count).toBe(3);
    expect(buffer.droppedCount).toBe(3);
    expect(buffer.values()).toEqual([3, 4, 5]);
    expect(() => new BoundedTailBuffer(0)).toThrow(RangeError);
  });

  test('generic diagnostics use one bounded pass while retaining exact counts', () => {
    const events: unknown[] = [
      { kind: 'prediction_queued', inputSeq: 1 },
      { kind: 'prediction_queued', inputSeq: 2 },
      { kind: 'prediction_queued', inputSeq: 3 },
      { kind: 'prediction_applied', inputSeq: 3 },
      { kind: 'render_end', predictionInputSeq: 0 },
      { kind: 'render_end', predictionInputSeq: 3 },
      { kind: 'frame_complete', completionDisposition: 'latest-submitted', predictionInputSeq: 3 },
      null,
    ];
    for (let index = 0; index < MAX_DIAGNOSTIC_EVENT_KINDS + 10; index += 1) {
      events.push({ kind: `future_event_${index}`, index });
    }

    const diagnostics = collectPredictionDiagnostics(events, 2);

    expect(diagnostics.queued).toBe(3);
    expect(diagnostics.applied).toBe(1);
    expect(diagnostics.submitted).toBe(1);
    expect(diagnostics.completed).toBe(1);
    expect(diagnostics.queuedEvents.map((event) => event.inputSeq)).toEqual([2, 3]);
    expect(diagnostics.renderedFrames).toHaveLength(2);
    expect(diagnostics.submittedFrames).toHaveLength(1);
    expect(diagnostics.completedFrames).toHaveLength(1);
    expect(diagnostics.unclassifiedEvents).toBe(1);
    expect(Object.keys(diagnostics.eventCountsByKind)).toHaveLength(MAX_DIAGNOSTIC_EVENT_KINDS);
    expect(diagnostics.untrackedKindEvents).toBeGreaterThan(0);
  });

  test('report summaries preserve aggregates and bound samples head-to-tail', () => {
    const report = makeReport(7);

    const bounded = boundTerminalLatencyReport(report, 4);

    expect(bounded.report.sampleCount).toBe(7);
    expect(bounded.report.samples.map((sample) => sample.inputSeq)).toEqual([0, 1, 5, 6]);
    expect(bounded.sampleRetention).toEqual({
      strategy: 'head_tail',
      total: 7,
      retained: 4,
      limit: 4,
      truncated: true,
    });
    expect(() => boundTerminalLatencyReport(report, 0)).toThrow(RangeError);
  });

  test('metadata normalization rejects invalid counters and timestamps', () => {
    const metadata = normalizeRecorderMetadata(
      {
        available: true,
        schemaVersion: 3,
        capacity: Number.POSITIVE_INFINITY,
        installedAtMs: 10,
        resetAtMs: Number.NaN,
        totalRecordedCount: 9,
        retainedEventCount: -1,
        overwriteCount: -2,
        droppedEventCount: 4,
      },
      5,
    );

    expect(metadata).toMatchObject({
      available: true,
      schemaVersion: 3,
      capacity: null,
      installedAtMs: 10,
      resetAtMs: null,
      totalRecordedCount: 9,
      retainedEventCount: 5,
      overwriteCount: 0,
      droppedEventCount: 4,
    });
    expect(normalizeRecorderMetadata(null, 3)).toEqual(unavailableRecorderMetadata(3));
    expect(validateRecorderMetadata(metadata)).toEqual([
      'terminal recorder capacity is invalid: null',
      'terminal recorder truncated 4 event(s) at capacity null',
    ]);
  });

  test('serialized recorder reports deterministic ring truncation metadata', () => {
    const terminalGlobal = globalThis as unknown as {
      __merkurTerminalPerf?: {
        readonly events: unknown[];
        readonly metadata: {
          readonly capacity: number;
          readonly retainedEventCount: number;
          readonly totalRecordedCount: number;
          readonly overwriteCount: number;
          readonly droppedEventCount: number;
          readonly oldestRetainedEventAtMs: number | null;
          readonly newestRetainedEventAtMs: number | null;
        };
        record(event: unknown): void;
        reset(): void;
      };
      __merkurTerminalPerfResetObservation?: () => number;
    };
    const previous = terminalGlobal.__merkurTerminalPerf;
    const previousResetObservation = terminalGlobal.__merkurTerminalPerfResetObservation;
    let observationResetCount = 0;
    try {
      terminalGlobal.__merkurTerminalPerfResetObservation = () => {
        observationResetCount += 1;
        return observationResetCount + 1;
      };
      installE2ETerminalPerfRecorder();
      const recorder = terminalGlobal.__merkurTerminalPerf;
      if (recorder === undefined) throw new Error('recorder was not installed');
      const capacity = recorder.metadata.capacity;
      const retainedEvent = { kind: 'future_kind', atMs: 100 };
      for (let index = 0; index < capacity; index += 1) {
        recorder.record(retainedEvent);
      }
      recorder.record({
        kind: 'future_kind',
        atMs: 103,
        marker: 'penultimate',
      });
      recorder.record({ kind: 'future_kind', atMs: 104, marker: 'last' });

      const events = recorder.events;
      expect(events).toHaveLength(capacity);
      expect(events[0]).toBe(retainedEvent);
      expect(events.slice(-2)).toEqual([
        { kind: 'future_kind', atMs: 103, marker: 'penultimate' },
        { kind: 'future_kind', atMs: 104, marker: 'last' },
      ]);
      expect(recorder.metadata).toMatchObject({
        capacity,
        retainedEventCount: capacity,
        totalRecordedCount: capacity + 2,
        overwriteCount: 2,
        droppedEventCount: 2,
        oldestRetainedEventAtMs: 100,
        newestRetainedEventAtMs: 104,
      });

      recorder.reset();
      expect(observationResetCount).toBe(1);
      expect(recorder.events).toEqual([]);
      expect(recorder.metadata).toMatchObject({
        retainedEventCount: 0,
        totalRecordedCount: 0,
        overwriteCount: 0,
        droppedEventCount: 0,
      });
    } finally {
      terminalGlobal.__merkurTerminalPerf = previous;
      terminalGlobal.__merkurTerminalPerfResetObservation = previousResetObservation;
    }
  });

  test('frozen snapshots cannot drift after assertion', () => {
    const report = makeReport(1);
    const snapshot = freezeTerminalPerfSnapshot(
      [{ kind: 'input_sent', atMs: 10, inputSeq: 1 }],
      report,
      unavailableRecorderMetadata(1),
    );

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.events)).toBe(true);
    expect(Object.isFrozen(snapshot.events[0])).toBe(true);
    expect(Object.isFrozen(snapshot.report)).toBe(true);
    expect(Object.isFrozen(snapshot.report.samples)).toBe(true);
    expect(Object.isFrozen(snapshot.report.samples[0])).toBe(true);

    const nestedEvent = { kind: 'future_kind', atMs: 11, nested: [1, 2, 3] };
    freezeTerminalPerfSnapshot(
      [nestedEvent as unknown as Parameters<typeof freezeTerminalPerfSnapshot>[0][number]],
      makeReport(0),
      unavailableRecorderMetadata(1),
    );
    expect(Object.isFrozen(nestedEvent.nested)).toBe(true);
  });

  test('gzip raw-event artifacts are deterministic and round-trip exactly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'merkur-terminal-perf-'));
    const firstPath = join(directory, 'first.json.gz');
    const secondPath = join(directory, 'second.json.gz');
    const events = [
      { kind: 'input_queued', atMs: 1, admittedAtMs: 1, inputSeq: 1, byteLength: 2 },
      { kind: 'future_kind', atMs: 2, payload: 'αβγ' },
    ];
    try {
      await Promise.all([
        writeGzipJsonArray(firstPath, events),
        writeGzipJsonArray(secondPath, events),
      ]);
      const [first, second] = await Promise.all([readFile(firstPath), readFile(secondPath)]);

      expect(first.equals(second)).toBe(true);
      expect(JSON.parse(gunzipSync(first).toString('utf8'))).toEqual(events);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function availableRecorderMetadata(retainedEventCount = 0) {
  return {
    available: true,
    schemaVersion: 3,
    capacity: 20_000,
    installedAtMs: 1,
    resetAtMs: 100,
    capturedAtMs: 200,
    firstRecordedAtMs: 110,
    lastRecordedAtMs: 190,
    oldestRetainedEventAtMs: 110,
    newestRetainedEventAtMs: 190,
    totalRecordedCount: retainedEventCount,
    retainedEventCount,
    overwriteCount: 0,
    droppedEventCount: 0,
  } as const;
}

function telemetryObservationCapture(
  overrides: Partial<{
    complete: boolean;
    preparationRequestId: number;
    observationEpoch: number;
    observationStartedAtMs: number;
    capacity: number;
    totalRecordedCount: number;
    retainedEventCount: number;
    retainedOverwriteCount: number;
    producerRecordLossCount: number;
    droppedEventCount: number;
  }> = {},
) {
  return {
    complete: true,
    preparationRequestId: 4,
    observationEpoch: 7,
    observationStartedAtMs: 100,
    capacity: 20_000,
    totalRecordedCount: 0,
    retainedEventCount: 0,
    retainedOverwriteCount: 0,
    producerRecordLossCount: 0,
    droppedEventCount: 0,
    ...overrides,
  } as const;
}

function makeReport(sampleCount: number): TerminalLatencyReport {
  const samples: TerminalLatencySample[] = Array.from({ length: sampleCount }, (_, inputSeq) => ({
    inputSeq,
    physicalInputToAdmissionMs: inputSeq,
    touchToCommitMs: inputSeq,
    touchToPredictionSubmissionMs: inputSeq,
    inputToPredictionSubmissionMs: inputSeq,
    inputToPredictionPaintMs: inputSeq,
    admissionToInputSentMs: inputSeq,
    inputSentToAckMs: inputSeq,
    inputAckNetworkRttFloorMs: inputSeq,
    inputAckNonNetworkUpperBoundMs: inputSeq,
    inputToDisplayReceiveMs: inputSeq,
    displayReceiveToWorkerQueueMs: inputSeq,
    workerQueueToDisplayApplyMs: inputSeq,
    inputToDisplayApplyMs: inputSeq,
    inputToDisplayPaintMs: inputSeq,
    inputToAuthoritativeVisualFenceMs: inputSeq,
    inputToCompletedSenderPresentationFenceMs: inputSeq,
    inputToCompletedAuthoritativePresentationFenceMs: inputSeq,
    displayApplyToPaintMs: inputSeq,
    displayApplyToRenderStartMs: inputSeq,
    renderStartToRenderEndMs: inputSeq,
    renderEndToDisplayPaintMs: inputSeq,
    renderEndToLastUnreadyPollMs: inputSeq,
    fenceObservationIntervalMs: inputSeq,
    displayApplyToRenderWantedMs: inputSeq,
    renderFenceGateMs: inputSeq,
    renderOpportunityGateMs: inputSeq,
    inputAckMs: inputSeq,
  }));
  const metric: TerminalLatencyPercentiles = {
    count: sampleCount,
    p50: sampleCount > 0 ? 1 : null,
    p95: sampleCount > 0 ? 2 : null,
    p99: sampleCount > 0 ? 3 : null,
    max: sampleCount > 0 ? 4 : null,
    complete: true,
  };
  const zeroMetric: TerminalLatencyPercentiles = {
    count: sampleCount,
    p50: sampleCount > 0 ? 0 : null,
    p95: sampleCount > 0 ? 0 : null,
    p99: sampleCount > 0 ? 0 : null,
    max: sampleCount > 0 ? 0 : null,
    complete: true,
  };
  const betweenWindowCount = Math.max(0, sampleCount - 1);
  const betweenWindowZeroMetric: TerminalLatencyPercentiles = {
    count: betweenWindowCount,
    p50: betweenWindowCount > 0 ? 0 : null,
    p95: betweenWindowCount > 0 ? 0 : null,
    p99: betweenWindowCount > 0 ? 0 : null,
    max: betweenWindowCount > 0 ? 0 : null,
    complete: true,
  };
  return {
    sampleCount,
    frameCompletionBoundary: 'browser-observed-webgpu-queue-completion',
    physicalInputToAdmissionMs: metric,
    touchToCommitMs: metric,
    touchToPredictionSubmissionMs: metric,
    inputToPredictionSubmissionMs: metric,
    inputToPredictionPaintMs: {
      ...metric,
      eligibleCount: sampleCount,
      coverageRatio: sampleCount > 0 ? 1 : null,
    },
    admissionToInputSentMs: metric,
    inputSentToAckMs: metric,
    inputAckNetworkRttFloorMs: metric,
    inputAckNonNetworkUpperBoundMs: metric,
    inputToDisplayReceiveMs: metric,
    displayReceiveToWorkerQueueMs: metric,
    workerQueueToDisplayApplyMs: metric,
    inputToDisplayApplyMs: metric,
    inputToDisplayPaintMs: metric,
    inputToAuthoritativeVisualFenceMs: metric,
    inputToCompletedSenderPresentationFenceMs: metric,
    inputToCompletedAuthoritativePresentationFenceMs: {
      ...metric,
      eligibleCount: sampleCount,
      censoredCount: 0,
    },
    displayApplyToPaintMs: metric,
    displayApplyToRenderStartMs: metric,
    renderStartToRenderEndMs: metric,
    renderEndToDisplayPaintMs: metric,
    renderEndToLastUnreadyPollMs: metric,
    fenceObservationIntervalMs: metric,
    renderGate: {
      immediateCount: sampleCount,
      fenceCount: 0,
      opportunityCount: 0,
      fenceAndOpportunityCount: 0,
      unknownCount: 0,
      applyToRenderWantedMs: metric,
      fenceGateWaitMs: metric,
      opportunityGateWaitMs: metric,
      opportunityDelayRequestedMs: metric,
      opportunityPeriodMs: metric,
      opportunityLowConfidenceRatio: null,
    },
    renderInstrumentation: {
      latestSubmittedFrameCount: 0,
      supersededFrameCount: 0,
      invalidatedFrameCount: 0,
      joinedFenceRenderCount: sampleCount,
      missingRenderStartCount: 0,
      missingRenderEndCount: 0,
      duplicateRenderSeqFrameCount: 0,
      gpuQueueRenderCount: sampleCount,
      noFenceRenderCount: 0,
      atlasUploadRenderCount: 0,
      drainedDisplayRenderCount: 0,
      renderStartToRenderEndSteadyMs: metric,
    },
    daemonPipeline: {
      batchCount: sampleCount,
      inputAttributedTotal: sampleCount,
      inputDroppedTotal: 0,
      inputSkippedTotal: 0,
      pendingInputs: 0,
      displayAttributedTotal: sampleCount,
      displayDroppedTotal: 0,
      complete: true,
      recvToPtyUs: metric,
      ptyToReadUs: metric,
      gridApplyUs: metric,
      displayCoalesceUs: metric,
      selectCaptureUs: metric,
      prepareQueueUs: metric,
      encodeUs: metric,
      compressionUs: metric,
      completionQueueUs: metric,
      transportSubmitUs: metric,
      gridMutationToEncodedUs: metric,
      queuedBeforeTransportSubmitUs: metric,
      displayOperationTotalUs: metric,
      totalUs: metric,
      writeCompletionUs: metric,
      ackTransmitUs: metric,
      ownerCpuUs: metric,
      ownerOffCpuUs: metric,
      ownerQuinnWaitUs: metric,
      ownerRegistryWaitUs: metric,
      flushLockWaitUs: metric,
      displayOperationOwnerOffCpuUs: metric,
      displayOperationLockWaitUs: metric,
    },
    transportEgress: {
      complete: true,
      daemonSnapshotCount: 0,
      edgeSnapshotCount: 0,
      daemon: {
        interactive: { blocked: 0, paced: 0, waitedUs: 0 },
        bulk: { blocked: 0, paced: 0, waitedUs: 0 },
      },
      edge: {
        interactive: { blocked: 0, paced: 0, waitedUs: 0 },
        bulk: { blocked: 0, paced: 0, waitedUs: 0 },
      },
      edgeForwardResidence: new Array<number>(12).fill(0),
    },
    displayPipeline: {
      workerReceiptToDecodeMs: metric,
      decodeToApplyMs: metric,
      pumpDurationMs: metric,
      pumpBudgetMs: metric,
      datagramsPerPump: metric,
      rowsPerPump: metric,
      encodedDeferralQueueHighWaterPerPump: metric,
      encodedDeferralQueueRemainingPerPump: metric,
      ringBytesAtPumpStart: metric,
      ringBytesAtPumpEnd: metric,
      ringRefusedFrameCountPerMeasurementWindow: zeroMetric,
      ringRefusedFrameCountBetweenMeasurementWindows: betweenWindowZeroMetric,
      ringRefusedFrameCount: 0,
      ringRefusalAccountingComplete: true,
      budgetExceededCount: 0,
    },
    mainThread: {
      complete: true,
      measurementWindowCount: sampleCount,
      sampledMeasurementWindowCount: sampleCount,
      intervalCount: sampleCount,
      rafGapMs: metric,
      frameBudgetOverrunMs: metric,
      estimatedMissedFramesPerGap: metric,
      estimatedMissedFramesPerMeasurementWindow: metric,
      estimatedMissedFrameCount: 0,
      frameBudgetExceededIntervalCount: 0,
      longTaskObserverSupported: true,
      longTaskDurationMs: metric,
      longTaskCount: sampleCount,
      longTaskTotalMs: sampleCount,
    },
    browserDisplayIo: {
      scope: BROWSER_DISPLAY_IO_SCOPE,
      complete: true,
      transportIngressUpdateCount: sampleCount,
      rejectedTransportIngressUpdateCount: 0,
      terminalApplyUpdateCount: sampleCount,
      transportFecIngressUpdateCount: 0,
      terminalFecProcessingUpdateCount: 0,
      fecPayloadByteCount: 0,
      fecExplicitCopyCount: 0,
      fecExplicitCopiedByteCount: 0,
      fecExplicitAllocationRequestCount: 0,
      fecExplicitAllocationRequestedByteCount: 0,
      fecExplicitObjectAllocationRequestCount: 0,
      endToEndMatchedUpdateCount: sampleCount,
      fecRecoveredTerminalApplyUpdateCount: 0,
      endToEndCoverageRatio: sampleCount > 0 ? 1 : null,
      endToEndMatchedPayloadByteCount: sampleCount,
      payloadByteCount: sampleCount * 2,
      explicitCopyCount: sampleCount,
      explicitCopiedByteCount: sampleCount,
      explicitAllocationRequestCount: sampleCount,
      explicitAllocationRequestedByteCount: sampleCount,
      explicitObjectAllocationRequestCount: sampleCount,
      endToEndExplicitCopiesPerUpdate: metric,
      endToEndExplicitCopiedBytesPerPayloadByte: metric,
      endToEndExplicitAllocationRequestsPerUpdate: metric,
      endToEndExplicitAllocationRequestedBytesPerUpdate: metric,
      endToEndExplicitAllocationRequestedBytesPerPayloadByte: metric,
      endToEndExplicitObjectAllocationRequestsPerUpdate: metric,
    },
    presentation: {
      epochBoundaryCount: 0,
      currentEpoch: null,
      commitCount: sampleCount,
      coherentCommitCount: sampleCount,
      urgentCommitCount: 0,
      authoritativeVisualCommitCount: sampleCount,
      discardedTransactionCount: 0,
      discardedDatagramCount: 0,
      discardedRowCount: 0,
      discardedByteCount: 0,
      discardedTransactionCountByReason: {
        resync: 0,
        'epoch-reset': 0,
        teardown: 0,
      },
      groupCount: sampleCount,
      groupsWithMultipleCommits: 0,
      measurementWindowCount: sampleCount,
      measurementWindowCountByPurpose: {
        'coherent-redraw': 0,
        'isolated-interactive': 0,
        streaming: sampleCount,
      },
      measurementWindowsWithMultipleCommits: 0,
      frameBudgetExceededCount: 0,
      deadlineExceededCount: 0,
      datagramsPerCommit: metric,
      rowsPerCommit: metric,
      bytesPerCommit: metric,
      firstApplyToCommitMs: metric,
      lastApplyToCommitMs: metric,
      firstReceiveToCommitMs: metric,
      deadlineOverrunMs: metric,
      commitToGpuFenceMs: metric,
      renderSubmissionMs: metric,
      partialPresentationExposureMs: metric,
      commitsPerPresentation: metric,
      measurementWindowExposureMs: metric,
      measurementWindowToCompletedAuthoritativePresentationFenceMs: metric,
      commitsPerMeasurementWindow: metric,
      ordinaryCommitsPerMeasurementWindow: metric,
      repairCommitsPerMeasurementWindow: metric,
      expiredRepairCommitsPerMeasurementWindow: metric,
      ordinaryMeasurementWindowExposureMs: metric,
      rowsPerMeasurementWindow: metric,
      datagramsPerMeasurementWindow: metric,
      bytesPerMeasurementWindow: metric,
      firstDisplayReceiveToCompletedPresentationFenceMs: metric,
      refreshPeriodPerMeasurementWindowMs: metric,
      fenceObservationIntervalPerMeasurementWindowMs: metric,
    },
    inputAckMs: metric,
    startup: {
      attemptCount: 0,
      completedCount: 0,
      complete: true,
      attempts: [],
    },
    samples,
  };
}
