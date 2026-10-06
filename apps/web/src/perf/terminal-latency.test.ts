import { describe, expect, test } from 'bun:test';
import { decodePerfEvent, emitFrameComplete } from './perf-event-codec';
import { createPerfRingBuffer, createPerfRingReader, createPerfRingWriter } from './perf-ring';
import { createPerfStringResolver, createPerfStringTableBuffer } from './perf-string-table';

import {
  buildTerminalLatencyRawMetricSamples,
  buildTerminalLatencyReport,
  buildTerminalStartupReport,
  createTerminalPerfRecorder,
  installTerminalPerfRecorder,
  onTerminalPerfObservationReset,
  type TerminalPerfEvent,
  terminalElapsedMsSince,
  terminalPerfObservationEpoch,
  uninstallTerminalPerfRecorder,
} from './terminal-latency';

describe('terminal diagnostics clock', () => {
  test('subtracts timestamps in the shared monotonic epoch domain', () => {
    expect(terminalElapsedMsSince(10_000.4, 10_025.9)).toBe(26);
    expect(terminalElapsedMsSince(10_025, 10_000)).toBe(0);
  });
});

describe('buildTerminalLatencyReport', () => {
  test('real zero-poll WebGPU producer records survive binary decoding and exact report joins', () => {
    const ring = createPerfRingBuffer(16);
    const writer = createPerfRingWriter(ring);
    const reader = createPerfRingReader(ring);
    const strings = createPerfStringResolver(createPerfStringTableBuffer());
    const events: TerminalPerfEvent[] = [
      inputQueued(90),
      displayEvent('worker_display_applied', 100, 1, 1),
      renderStart(104),
      renderEnd(110),
    ];
    // Exact production callback arguments: real queue readiness, no timer poll.
    expect(emitFrameComplete(writer, 126, 1, 1, 0, 0, [], false, 0, 0, 'latest-submitted')).toBe(
      true,
    );
    reader.drain((record) => {
      const event = decodePerfEvent(record, strings);
      expect(event).not.toBeNull();
      if (event !== null) events.push(event);
    });
    const report = buildTerminalLatencyReport(events);
    expect(report.renderInstrumentation.gpuQueueRenderCount).toBe(1);
    expect(report.renderInstrumentation.latestSubmittedFrameCount).toBe(1);
    expect(report.renderInstrumentation.joinedFenceRenderCount).toBe(1);
    expect(report.samples[0]?.displayApplyToPaintMs).toBe(26);
    expect(report.samples[0]?.renderEndToDisplayPaintMs).toBe(16);
    expect(report.samples[0]?.fenceObservationIntervalMs).toBe(16);
  });

  test('labels every report completion as browser-observed WebGPU queue completion', () => {
    expect(buildTerminalLatencyReport([]).frameCompletionBoundary).toBe(
      'browser-observed-webgpu-queue-completion',
    );
  });

  test('accounts exact display-ring refusals between same-lineage worker boundaries', () => {
    const events: TerminalPerfEvent[] = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      {
        kind: 'display_ring_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        observationEpoch: 7,
        sessionEpoch: 3,
        ringDroppedTotal: 0xffff_fffe,
      },
      {
        kind: 'presentation_measurement_boundary',
        atMs: 120,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
      {
        kind: 'display_ring_measurement_boundary',
        atMs: 120,
        measurementId: 1,
        phase: 'end',
        observationEpoch: 7,
        sessionEpoch: 3,
        ringDroppedTotal: 1,
      },
    ];
    const report = buildTerminalLatencyReport(events);
    expect(report.displayPipeline.ringRefusalAccountingComplete).toBe(true);
    expect(report.displayPipeline.ringRefusedFrameCount).toBe(3);
    expect(report.displayPipeline.ringRefusedFrameCountPerMeasurementWindow).toMatchObject({
      count: 1,
      p50: 3,
      complete: true,
    });
    expect(report.displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows).toMatchObject({
      count: 0,
      complete: true,
    });
    expect(
      buildTerminalLatencyRawMetricSamples(events)[
        'displayPipeline.ringRefusedFrameCountPerMeasurementWindow'
      ],
    ).toEqual([3]);
  });

  test('accounts refusals between adjacent measurement windows without rebasing them away', () => {
    const events: TerminalPerfEvent[] = [];
    for (const [measurementId, startAtMs, endAtMs, startDropped, endDropped] of [
      [1, 100, 120, 0, 0],
      [2, 140, 160, 1, 1],
    ] as const) {
      events.push(
        {
          kind: 'presentation_measurement_boundary',
          atMs: startAtMs,
          measurementId,
          phase: 'start',
          purpose: 'streaming',
        },
        {
          kind: 'display_ring_measurement_boundary',
          atMs: startAtMs,
          measurementId,
          phase: 'start',
          observationEpoch: 7,
          sessionEpoch: 3,
          ringDroppedTotal: startDropped,
        },
        {
          kind: 'presentation_measurement_boundary',
          atMs: endAtMs,
          measurementId,
          phase: 'end',
          purpose: 'streaming',
        },
        {
          kind: 'display_ring_measurement_boundary',
          atMs: endAtMs,
          measurementId,
          phase: 'end',
          observationEpoch: 7,
          sessionEpoch: 3,
          ringDroppedTotal: endDropped,
        },
      );
    }

    const report = buildTerminalLatencyReport(events);
    expect(report.displayPipeline.ringRefusalAccountingComplete).toBe(true);
    expect(report.displayPipeline.ringRefusedFrameCount).toBe(1);
    expect(report.displayPipeline.ringRefusedFrameCountPerMeasurementWindow).toMatchObject({
      count: 2,
      p50: 0,
      max: 0,
      complete: true,
    });
    expect(report.displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows).toMatchObject({
      count: 1,
      p50: 1,
      max: 1,
      complete: true,
    });
    expect(
      buildTerminalLatencyRawMetricSamples(events)[
        'displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows'
      ],
    ).toEqual([1]);

    const crossLineage = buildTerminalLatencyReport(
      events.map((event) =>
        event.kind === 'display_ring_measurement_boundary' && event.measurementId === 2
          ? { ...event, observationEpoch: 8 }
          : event,
      ),
    );
    expect(crossLineage.displayPipeline.ringRefusalAccountingComplete).toBe(false);
    expect(
      crossLineage.displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows.complete,
    ).toBe(false);
  });

  test('fails display-ring refusal accounting closed without an exact same-lineage pair', () => {
    const presentation = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      {
        kind: 'presentation_measurement_boundary',
        atMs: 120,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];
    const start = {
      kind: 'display_ring_measurement_boundary',
      atMs: 100,
      measurementId: 1,
      phase: 'start',
      observationEpoch: 7,
      sessionEpoch: 3,
      ringDroppedTotal: 2,
    } satisfies TerminalPerfEvent;
    const missing = buildTerminalLatencyReport([...presentation, start]);
    expect(missing.displayPipeline.ringRefusalAccountingComplete).toBe(false);
    expect(missing.displayPipeline.ringRefusedFrameCountPerMeasurementWindow.complete).toBe(false);
    expect(missing.displayPipeline.ringRefusedFrameCountPerMeasurementWindow.count).toBe(0);

    const mismatched = buildTerminalLatencyReport([
      ...presentation,
      start,
      {
        ...start,
        atMs: 120,
        phase: 'end',
        observationEpoch: 8,
        ringDroppedTotal: 2,
      },
    ]);
    expect(mismatched.displayPipeline.ringRefusalAccountingComplete).toBe(false);
    expect(mismatched.displayPipeline.ringRefusedFrameCountPerMeasurementWindow.complete).toBe(
      false,
    );
  });

  test('redraw stage distributions exclude setup while retaining exact render and fence joins', () => {
    const events: TerminalPerfEvent[] = [];
    for (const [seq, atMs, decodeMs, applyMs, holdMs, renderMs, fenceMs] of [
      [1, 10, 0.1, 0.2, 1, 0.5, 1],
      [2, 110, 7, 8, 13, 4, 2],
    ] as const) {
      events.push(
        inputQueued(atMs - 1, seq),
        { ...displayEvent('display_received', atMs, 1, seq), workerReceiptToDecodeMs: decodeMs },
        {
          ...displayEvent('worker_display_applied', atMs + 1, 1, seq),
          decodeToApplyMs: applyMs,
          presentationTransactionSeq: seq,
          presentationCoherent: true,
        },
        renderStart(atMs + 1 + holdMs - renderMs, { renderSeq: seq, displayInputSeq: seq }),
        renderEnd(atMs + 1 + holdMs, { renderSeq: seq, displayInputSeq: seq }),
        presentationCommit(atMs + 1 + holdMs, {
          transactionSeq: seq,
          renderSeq: seq,
          displayInputSeq: seq,
          firstDisplaySeq: seq,
          lastDisplaySeq: seq,
          firstPresentationId: seq,
          lastPresentationId: seq,
          firstApplyToCommitMs: holdMs,
          lastApplyToCommitMs: holdMs,
        }),
        frameComplete(atMs + 1 + holdMs + fenceMs, { renderSeq: seq, displayInputSeq: seq }),
      );
    }
    events.push(
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'coherent-redraw',
      },
      {
        kind: 'presentation_measurement_boundary',
        atMs: 140,
        measurementId: 1,
        phase: 'end',
        purpose: 'coherent-redraw',
      },
    );
    const report = buildTerminalLatencyReport(events);
    const raw = buildTerminalLatencyRawMetricSamples(events);
    expect(raw['displayPipeline.workerReceiptToDecodeMs']).toEqual([7]);
    expect(raw['displayPipeline.decodeToApplyMs']).toEqual([8]);
    expect(raw['presentation.firstApplyToCommitMs']).toEqual([13]);
    expect(raw['presentation.commitToGpuFenceMs']).toEqual([2]);
    expect(raw['presentation.renderSubmissionMs']).toEqual([4]);
    expect(report.presentation.renderSubmissionMs.complete).toBe(true);
    expect(report.presentation.renderSubmissionMs.count).toBe(1);
    expect(report.presentation.commitCount).toBe(2);
    expect(report.displayPipeline.workerReceiptToDecodeMs.p50).toBe(7);
  });

  test('retains a measured transaction whose slow commit and GPU fence follow the window end', () => {
    const events: TerminalPerfEvent[] = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'coherent-redraw',
      },
      inputQueued(101, 1),
      displayEvent('display_received', 105, 1, 1),
      { ...displayEvent('worker_display_applied', 110, 1, 1), presentationId: 7 },
      {
        kind: 'presentation_measurement_boundary',
        atMs: 120,
        measurementId: 1,
        phase: 'end',
        purpose: 'coherent-redraw',
      },
      // A new input after the observation boundary must not hide the previous
      // transaction's long queue/submit tail from its stage distributions.
      inputQueued(121, 2),
      renderStart(150),
      renderEnd(160),
      presentationCommit(160, { firstApplyToCommitMs: 50, lastApplyToCommitMs: 50 }),
      frameComplete(180),
    ];
    const raw = buildTerminalLatencyRawMetricSamples(events);
    expect(raw['presentation.firstApplyToCommitMs']).toEqual([50]);
    expect(raw['presentation.lastApplyToCommitMs']).toEqual([50]);
    expect(raw['presentation.commitToGpuFenceMs']).toEqual([20]);
    expect(raw['presentation.renderSubmissionMs']).toEqual([10]);
    expect(raw['presentation.datagramsPerCommit']).toEqual([1]);
    expect(raw['presentation.rowsPerCommit']).toEqual([1]);
    expect(raw['presentation.bytesPerCommit']).toEqual([32]);
  });

  test('rejects stage intervals crossing a measurement boundary without counting setup samples', () => {
    const events: TerminalPerfEvent[] = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'coherent-redraw',
      },
      {
        kind: 'presentation_measurement_boundary',
        atMs: 150,
        measurementId: 1,
        phase: 'end',
        purpose: 'coherent-redraw',
      },
      // Both stages end inside the window but began during setup.
      { ...displayEvent('display_received', 102, 1, 1), workerReceiptToDecodeMs: 5 },
      { ...displayEvent('worker_display_applied', 104, 1, 1), decodeToApplyMs: 6 },
      {
        kind: 'display_pump_complete',
        ringBytesAtStart: 8192,
        ringBytesAtEnd: 64,
        ringDroppedTotal: 2,
        atMs: 105,
        durationMs: 8,
        budgetMs: 4,
        processedDatagramCount: 1,
        processedRowCount: 1,
        queueHighWater: 1,
        queueRemaining: 0,
      },
      { ...displayEvent('display_received', 110, 1, 2), workerReceiptToDecodeMs: 2 },
      { ...displayEvent('worker_display_applied', 113, 1, 2), decodeToApplyMs: 3 },
      {
        kind: 'display_pump_complete',
        ringBytesAtStart: 8192,
        ringBytesAtEnd: 64,
        ringDroppedTotal: 2,
        atMs: 115,
        durationMs: 4,
        budgetMs: 4,
        processedDatagramCount: 1,
        processedRowCount: 1,
        queueHighWater: 1,
        queueRemaining: 0,
      },
    ];
    const raw = buildTerminalLatencyRawMetricSamples(events);
    const report = buildTerminalLatencyReport(events);
    expect(raw['displayPipeline.workerReceiptToDecodeMs']).toEqual([2]);
    expect(raw['displayPipeline.decodeToApplyMs']).toEqual([3]);
    expect(raw['displayPipeline.pumpDurationMs']).toEqual([4]);
    expect(report.displayPipeline.workerReceiptToDecodeMs.complete).toBe(false);
    expect(report.displayPipeline.decodeToApplyMs.complete).toBe(false);
    expect(report.displayPipeline.pumpDurationMs.complete).toBe(false);
  });

  test('does not assign a transaction straddling setup and measurement to the later commit', () => {
    const events: TerminalPerfEvent[] = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'coherent-redraw',
      },
      {
        kind: 'presentation_measurement_boundary',
        atMs: 150,
        measurementId: 1,
        phase: 'end',
        purpose: 'coherent-redraw',
      },
      displayEvent('display_received', 98, 1, 1),
      { ...displayEvent('worker_display_applied', 99, 1, 1), presentationId: 7 },
      displayEvent('display_received', 104, 1, 2),
      { ...displayEvent('worker_display_applied', 105, 1, 2), presentationId: 7 },
      renderStart(110),
      renderEnd(111),
      presentationCommit(111, {
        lastDisplaySeq: 2,
        firstApplyToCommitMs: 12,
        lastApplyToCommitMs: 6,
        datagramCount: 2,
        rowCount: 2,
        byteLength: 64,
      }),
      frameComplete(112),
    ];
    const raw = buildTerminalLatencyRawMetricSamples(events);
    const report = buildTerminalLatencyReport(events);
    expect(raw['presentation.firstApplyToCommitMs']).toEqual([]);
    expect(report.presentation.firstApplyToCommitMs.complete).toBe(false);
    expect(report.presentation.renderSubmissionMs.complete).toBe(false);
  });

  test('measures visible main-thread cadence and direct long tasks inside the exact workload window', () => {
    const events = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      { kind: 'main_frame_cadence', atMs: 101, gapMs: 8, longTaskObserverSupported: true },
      // 1.25 periods: over budget beyond the explicit 1ms tolerance, but
      // nearest-period estimation correctly calls this zero missed frames.
      { kind: 'main_frame_cadence', atMs: 111, gapMs: 10, longTaskObserverSupported: true },
      { kind: 'main_frame_cadence', atMs: 127, gapMs: 16, longTaskObserverSupported: true },
      { kind: 'main_long_task', atMs: 106, durationMs: 60 },
      {
        ...displayEvent('display_received', 104, 1, 10),
        presentationId: 7,
      },
      {
        ...displayEvent('worker_display_applied', 105, 1, 10),
        presentationId: 7,
        presentationTransactionSeq: 1,
      },
      renderStart(106, { refreshPeriodMs: 8 }),
      renderEnd(107),
      presentationCommit(107, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        firstPresentationId: 7,
        lastPresentationId: 7,
        refreshPeriodMs: 8,
      }),
      frameComplete(110),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 120,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const main = buildTerminalLatencyReport(events).mainThread;
    expect(main.complete).toBe(true);
    expect(main.measurementWindowCount).toBe(1);
    expect(main.sampledMeasurementWindowCount).toBe(1);
    expect(main.intervalCount).toBe(3);
    expect(main.rafGapMs).toMatchObject({ count: 3, p50: 10, max: 16, complete: true });
    expect(main.frameBudgetOverrunMs).toMatchObject({ count: 3, p50: 2, max: 8 });
    expect(main.estimatedMissedFramesPerGap).toMatchObject({ count: 3, p50: 0, max: 1 });
    expect(main.estimatedMissedFramesPerMeasurementWindow.p50).toBe(1);
    expect(main.estimatedMissedFrameCount).toBe(1);
    expect(main.frameBudgetExceededIntervalCount).toBe(2);
    expect(main.longTaskObserverSupported).toBe(true);
    expect(main.longTaskDurationMs).toMatchObject({ count: 1, p50: 60, complete: true });
    expect(main.longTaskTotalMs).toBe(14);
    expect(
      buildTerminalLatencyRawMetricSamples(events)['mainThread.estimatedMissedFramesPerGap'],
    ).toEqual([0, 0, 1]);
    expect(buildTerminalLatencyRawMetricSamples(events)['mainThread.frameBudgetOverrunMs']).toEqual(
      [0, 2, 8],
    );
  });

  test('classifies frame-budget misses against the measured 60 through 480 Hz cadence', () => {
    for (const hz of [60, 120, 240, 480]) {
      const periodMs = 1_000 / hz;
      const startAtMs = 100;
      const endAtMs = startAtMs + periodMs * 3;
      const report = buildTerminalLatencyReport([
        {
          kind: 'presentation_measurement_boundary',
          atMs: startAtMs,
          measurementId: hz,
          phase: 'start',
          purpose: 'streaming',
        },
        {
          kind: 'main_frame_cadence',
          atMs: startAtMs + periodMs * 0.5,
          gapMs: periodMs,
          longTaskObserverSupported: true,
        },
        {
          kind: 'main_frame_cadence',
          atMs: startAtMs + periodMs * 1.5,
          gapMs: periodMs,
          longTaskObserverSupported: true,
        },
        {
          kind: 'main_frame_cadence',
          atMs: startAtMs + periodMs * 3.5,
          gapMs: periodMs * 2,
          longTaskObserverSupported: true,
        },
        {
          ...displayEvent('display_received', startAtMs + periodMs, 1, 10),
          presentationId: 7,
        },
        {
          ...displayEvent('worker_display_applied', startAtMs + periodMs * 1.1, 1, 10),
          presentationId: 7,
          presentationTransactionSeq: 1,
        },
        renderStart(startAtMs + periodMs * 1.2, { refreshPeriodMs: periodMs }),
        renderEnd(startAtMs + periodMs * 1.3),
        presentationCommit(startAtMs + periodMs * 1.3, {
          firstDisplaySeq: 10,
          lastDisplaySeq: 10,
          firstPresentationId: 7,
          lastPresentationId: 7,
          refreshPeriodMs: periodMs,
        }),
        frameComplete(startAtMs + periodMs * 1.4),
        {
          kind: 'presentation_measurement_boundary',
          atMs: endAtMs,
          measurementId: hz,
          phase: 'end',
          purpose: 'streaming',
        },
      ] satisfies TerminalPerfEvent[]).mainThread;

      expect(report.complete).toBe(true);
      expect(report.sampledMeasurementWindowCount).toBe(1);
      expect(report.estimatedMissedFrameCount).toBe(1);
      expect(report.frameBudgetExceededIntervalCount).toBe(1);
      expect(report.rafGapMs.max).toBeCloseTo(periodMs * 2, 8);
    }
  });

  test('fails main-thread cadence closed without both window boundary intervals', () => {
    const report = buildTerminalLatencyReport([
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      { kind: 'main_frame_cadence', atMs: 110, gapMs: 8, longTaskObserverSupported: false },
      {
        kind: 'presentation_measurement_boundary',
        atMs: 120,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[]).mainThread;

    expect(report.complete).toBe(false);
    expect(report.sampledMeasurementWindowCount).toBe(0);
    expect(report.estimatedMissedFramesPerMeasurementWindow.complete).toBe(false);
    expect(report.longTaskObserverSupported).toBeNull();
    expect(report.longTaskDurationMs.complete).toBe(false);
  });

  test('reports exact matched browser copy/allocation requests without inventing engine bytes', () => {
    const events = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      browserIoEvent('transport_ingress', 110, {
        explicitCopyCount: 1,
        explicitCopiedBytes: 64,
      }),
      browserIoEvent('terminal_apply', 120, {
        explicitCopyCount: 2,
        explicitCopiedBytes: 128,
        explicitAllocationRequestCount: 1,
        explicitAllocationRequestedBytes: 64,
        explicitObjectAllocationRequestCount: 3,
      }),
      browserIoEvent('transport_ingress', 130, {
        frameId: 9,
        admitted: false,
        explicitCopyCount: 0,
        explicitCopiedBytes: 0,
      }),
      // Not part of the explicit workload and therefore not in its totals.
      browserIoEvent('transport_ingress', 250, {
        frameId: 10,
        explicitCopyCount: 7,
        explicitCopiedBytes: 448,
      }),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 200,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const io = buildTerminalLatencyReport(events).browserDisplayIo;
    expect(io.complete).toBe(true);
    expect(io.transportIngressUpdateCount).toBe(2);
    expect(io.rejectedTransportIngressUpdateCount).toBe(1);
    expect(io.terminalApplyUpdateCount).toBe(1);
    expect(io.endToEndMatchedUpdateCount).toBe(1);
    expect(io.endToEndCoverageRatio).toBe(1);
    expect(io.endToEndMatchedPayloadByteCount).toBe(64);
    expect(io.payloadByteCount).toBe(192);
    expect(io.explicitCopyCount).toBe(3);
    expect(io.explicitCopiedByteCount).toBe(192);
    expect(io.explicitAllocationRequestCount).toBe(1);
    expect(io.explicitAllocationRequestedByteCount).toBe(64);
    expect(io.explicitObjectAllocationRequestCount).toBe(3);
    expect(io.endToEndExplicitCopiesPerUpdate).toMatchObject({ count: 1, p50: 3 });
    expect(io.endToEndExplicitCopiedBytesPerPayloadByte).toMatchObject({ count: 1, p50: 3 });
    expect(io.endToEndExplicitAllocationRequestsPerUpdate).toMatchObject({ count: 1, p50: 1 });
    expect(io.endToEndExplicitAllocationRequestedBytesPerPayloadByte).toMatchObject({
      count: 1,
      p50: 1,
    });
    expect(io.endToEndExplicitObjectAllocationRequestsPerUpdate).toMatchObject({
      count: 1,
      p50: 3,
    });
  });

  test('fails browser display I/O completeness on missing or cross-stage ingress routes', () => {
    for (const event of [
      browserIoEvent('transport_ingress', 110, { ingressRoute: null }),
      browserIoEvent('transport_fec_ingress', 110, { ingressRoute: null }),
      browserIoEvent('terminal_apply', 110, { ingressRoute: 'direct-datagram' }),
      browserIoEvent('terminal_fec', 110, { ingressRoute: 'relay-reliable' }),
    ]) {
      expect(buildTerminalLatencyReport([event]).browserDisplayIo.complete).toBe(false);
    }
  });

  test('requires exact FEC provenance for an unmatched recovered apply', () => {
    const io = buildTerminalLatencyReport([
      browserIoEvent('terminal_apply', 120, {
        displaySeq: 99,
        frameId: 99,
        fecRecovered: true,
      }),
    ]).browserDisplayIo;

    expect(io.complete).toBe(true);
    expect(io.terminalApplyUpdateCount).toBe(1);
    expect(io.endToEndMatchedUpdateCount).toBe(0);
    expect(io.fecRecoveredTerminalApplyUpdateCount).toBe(1);
    expect(io.endToEndCoverageRatio).toBe(1);
    expect(io.endToEndExplicitCopiesPerUpdate).toMatchObject({ count: 0, complete: true });
  });

  test('fails closed when an unmatched apply has no FEC provenance', () => {
    const io = buildTerminalLatencyReport([
      browserIoEvent('terminal_apply', 120, { displaySeq: 99, frameId: 99 }),
    ]).browserDisplayIo;

    expect(io.complete).toBe(false);
    expect(io.fecRecoveredTerminalApplyUpdateCount).toBe(0);
    expect(io.endToEndCoverageRatio).toBe(0);
  });

  test('fails closed when one apply claims both direct ingress and FEC recovery', () => {
    const io = buildTerminalLatencyReport([
      browserIoEvent('transport_ingress', 110, { displaySeq: 99, frameId: 99 }),
      browserIoEvent('terminal_apply', 120, {
        displaySeq: 99,
        frameId: 99,
        fecRecovered: true,
      }),
    ]).browserDisplayIo;

    expect(io.complete).toBe(false);
    expect(io.endToEndMatchedUpdateCount).toBe(0);
    expect(io.fecRecoveredTerminalApplyUpdateCount).toBe(0);
    expect(io.endToEndCoverageRatio).toBe(0);
  });

  test('reports FEC ingress and reconstruction costs without folding them into patch joins', () => {
    const io = buildTerminalLatencyReport([
      browserIoEvent('transport_fec_ingress', 110, {
        displaySeq: 20,
        generation: 3,
        payloadByteLength: 80,
        explicitCopyCount: 1,
        explicitCopiedBytes: 80,
      }),
      browserIoEvent('terminal_fec', 115, {
        displaySeq: 20,
        generation: 3,
        payloadByteLength: 80,
        explicitCopyCount: 4,
        explicitCopiedBytes: 256,
        explicitAllocationRequestCount: 1,
        explicitAllocationRequestedBytes: 64,
        explicitObjectAllocationRequestCount: 16,
      }),
      browserIoEvent('terminal_apply', 120, {
        displaySeq: 22,
        generation: 3,
        frameId: 22,
        fecRecovered: true,
        explicitCopyCount: 1,
        explicitCopiedBytes: 64,
      }),
    ]).browserDisplayIo;

    expect(io.complete).toBe(true);
    expect(io.transportFecIngressUpdateCount).toBe(1);
    expect(io.terminalFecProcessingUpdateCount).toBe(1);
    expect(io.fecPayloadByteCount).toBe(160);
    expect(io.fecExplicitCopyCount).toBe(5);
    expect(io.fecExplicitCopiedByteCount).toBe(336);
    expect(io.fecExplicitAllocationRequestCount).toBe(1);
    expect(io.fecExplicitAllocationRequestedByteCount).toBe(64);
    expect(io.fecExplicitObjectAllocationRequestCount).toBe(16);
    expect(io.terminalApplyUpdateCount).toBe(1);
    expect(io.endToEndMatchedUpdateCount).toBe(0);
    expect(io.fecRecoveredTerminalApplyUpdateCount).toBe(1);
    expect(io.endToEndCoverageRatio).toBe(1);
    expect(io.explicitCopiedByteCount).toBe(400);
  });

  test('accounts exact datagrams, bytes, and first receipt through each logical window fence', () => {
    const events = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      inputQueued(101),
      {
        ...displayEvent('display_received', 104, 1, 10),
        presentationId: 7,
        rowCount: 2,
        byteLength: 100,
      },
      {
        ...displayEvent('worker_display_applied', 105, 1, 10),
        presentationId: 7,
        presentationTransactionSeq: 1,
        rowCount: 2,
        byteLength: 100,
      },
      renderStart(106),
      renderEnd(107),
      presentationCommit(107, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        firstPresentationId: 7,
        lastPresentationId: 7,
        datagramCount: 1,
        rowCount: 2,
        byteLength: 100,
      }),
      frameComplete(110),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 112,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const presentation = buildTerminalLatencyReport(events).presentation;
    expect(presentation.datagramsPerMeasurementWindow.p50).toBe(1);
    expect(presentation.bytesPerMeasurementWindow.p50).toBe(100);
    expect(presentation.firstDisplayReceiveToCompletedPresentationFenceMs.p50).toBe(6);
    expect(presentation.firstDisplayReceiveToCompletedPresentationFenceMs.complete).toBe(true);
    expect(presentation.ordinaryCommitsPerMeasurementWindow.p50).toBe(1);
    expect(presentation.repairCommitsPerMeasurementWindow.p50).toBe(0);
    expect(presentation.expiredRepairCommitsPerMeasurementWindow.p50).toBe(0);
    expect(presentation.ordinaryMeasurementWindowExposureMs.p50).toBe(0);
    const raw = buildTerminalLatencyRawMetricSamples(events);
    expect(raw['presentation.commitsPerMeasurementWindow']).toEqual([1]);
    expect(raw['presentation.bytesPerMeasurementWindow']).toEqual([100]);
    expect(raw['mainThread.estimatedMissedFramesPerGap']).toEqual([]);
  });

  test('classifies only wholly FEC-reconstructed visual transactions as repair commits', () => {
    const reportFor = (fecRecovered: readonly boolean[], expired = false) => {
      const received = fecRecovered.map((recovered, index) => ({
        ...displayEvent('display_received', 104 + index, 1, 10 + index),
        presentationId: 7,
        presentationCoherent: true,
        fecRecovered: recovered,
      }));
      const applied = fecRecovered.map((recovered, index) => ({
        ...displayEvent('worker_display_applied', 106 + index, 1, 10 + index),
        presentationId: 7,
        presentationCoherent: true,
        fecRecovered: recovered,
      }));
      return buildTerminalLatencyReport([
        {
          kind: 'presentation_measurement_boundary',
          atMs: 100,
          measurementId: 1,
          phase: 'start',
          purpose: 'coherent-redraw',
        },
        inputQueued(101),
        ...received,
        ...applied,
        renderStart(110),
        renderEnd(111),
        presentationCommit(111, {
          ...(expired ? { reason: 'repair-deadline-expired' as const } : {}),
          firstDisplaySeq: 10,
          lastDisplaySeq: 9 + fecRecovered.length,
          datagramCount: fecRecovered.length,
          rowCount: fecRecovered.length,
          byteLength: fecRecovered.length * 32,
        }),
        frameComplete(112),
        {
          kind: 'presentation_measurement_boundary',
          atMs: 113,
          measurementId: 1,
          phase: 'end',
          purpose: 'coherent-redraw',
        },
      ] satisfies TerminalPerfEvent[]).presentation;
    };

    const pureRecovery = reportFor([true, true]);
    expect(pureRecovery.ordinaryCommitsPerMeasurementWindow.p50).toBe(0);
    expect(pureRecovery.repairCommitsPerMeasurementWindow.p50).toBe(1);

    const mixedOriginalAndRecovery = reportFor([false, true]);
    expect(mixedOriginalAndRecovery.ordinaryCommitsPerMeasurementWindow.p50).toBe(1);
    expect(mixedOriginalAndRecovery.repairCommitsPerMeasurementWindow.p50).toBe(0);

    const expiredPureRecovery = reportFor([true, true], true);
    expect(expiredPureRecovery.expiredRepairCommitsPerMeasurementWindow.p50).toBe(1);
    expect(expiredPureRecovery.repairCommitsPerMeasurementWindow.p50).toBe(0);
    expect(expiredPureRecovery.ordinaryCommitsPerMeasurementWindow.p50).toBe(0);
  });

  test('fails an exact workload window closed when a presentation transaction straddles its start', () => {
    const events = [
      { ...displayEvent('display_received', 89, 1, 10), presentationId: 7 },
      {
        ...displayEvent('worker_display_applied', 90, 1, 10),
        presentationId: 7,
        presentationTransactionSeq: 1,
      },
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      inputQueued(105),
      { ...displayEvent('display_received', 109, 1, 11), presentationId: 7 },
      {
        ...displayEvent('worker_display_applied', 110, 1, 11),
        presentationId: 7,
        presentationTransactionSeq: 1,
      },
      renderStart(112),
      renderEnd(115),
      presentationCommit(115, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 11,
        firstPresentationId: 7,
        lastPresentationId: 7,
        datagramCount: 2,
        rowCount: 2,
        byteLength: 64,
      }),
      frameComplete(118),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 120,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const presentation = buildTerminalLatencyReport(events).presentation;
    expect(presentation.datagramsPerMeasurementWindow.p50).toBe(2);
    expect(presentation.datagramsPerMeasurementWindow.complete).toBe(false);
    expect(presentation.measurementWindowExposureMs.complete).toBe(false);
  });

  test('accepts only an exactly accounted daemon timing batch', () => {
    const report = buildTerminalLatencyReport([
      daemonTimingStatus({
        inputAttributedTotal: 1,
        displayAttributedTotal: 1,
        recordCount: 2,
      }),
      daemonTiming(),
      daemonTiming({ inputSeq: 0 }),
    ]);

    expect(report.daemonPipeline.complete).toBe(true);
    expect(report.daemonPipeline.batchCount).toBe(1);
    expect(report.daemonPipeline.inputAttributedTotal).toBe(1);
    expect(report.daemonPipeline.displayAttributedTotal).toBe(1);
    expect(report.daemonPipeline.pendingInputs).toBe(0);
    expect(report.daemonPipeline.gridMutationToEncodedUs.p50).toBe(30);
    expect(report.daemonPipeline.queuedBeforeTransportSubmitUs.p50).toBe(15);
    expect(report.daemonPipeline.totalUs.p50).toBe(55);
  });

  test('reports the acknowledgment half only over inputs that observed it', () => {
    const report = buildTerminalLatencyReport([
      daemonTimingStatus({
        inputAttributedTotal: 2,
        displayAttributedTotal: 1,
        recordCount: 3,
      }),
      daemonTiming({ inputSeq: 1, writeCompletionUs: 30, ackTransmitUs: 7_000 }),
      daemonTiming({ inputSeq: 2, writeCompletionUs: 40, ackTransmitUs: null }),
      daemonTiming({ inputSeq: 0 }),
    ]);

    expect(report.daemonPipeline.complete).toBe(true);
    expect(report.daemonPipeline.writeCompletionUs).toMatchObject({ count: 2, complete: true });
    // An unobserved boundary is neither a zero nor a completed sample.
    expect(report.daemonPipeline.ackTransmitUs).toMatchObject({
      count: 1,
      p50: 7_000,
      complete: false,
    });
    expect(report.daemonPipeline.totalUs.count).toBe(2);
  });

  test('reports the owner over input spans and over display flushes separately', () => {
    const report = buildTerminalLatencyReport([
      daemonTimingStatus({
        inputAttributedTotal: 2,
        displayAttributedTotal: 1,
        recordCount: 3,
      }),
      daemonTiming({ inputSeq: 1, ownerOffCpuUs: 2_000, ownerQuinnWaitUs: 1_800 }),
      daemonTiming({ inputSeq: 2, ownerOffCpuUs: 40, ownerQuinnWaitUs: 0 }),
      daemonTiming({ inputSeq: 0, ownerOffCpuUs: 900, flushLockWaitUs: 850 }),
    ]);

    expect(report.daemonPipeline.complete).toBe(true);
    expect(report.daemonPipeline.ownerOffCpuUs).toMatchObject({ count: 2, max: 2_000 });
    expect(report.daemonPipeline.ownerQuinnWaitUs).toMatchObject({ count: 2, max: 1_800 });
    expect(report.daemonPipeline.displayOperationOwnerOffCpuUs).toMatchObject({
      count: 1,
      p50: 900,
    });
    expect(report.daemonPipeline.displayOperationLockWaitUs).toMatchObject({
      count: 1,
      p50: 850,
    });
    // A malformed account invalidates the record rather than reading as a zero.
    const withOwnerCpu = (ownerCpuUs: number) =>
      buildTerminalLatencyReport([
        daemonTimingStatus({ inputAttributedTotal: 1, displayAttributedTotal: 1, recordCount: 2 }),
        daemonTiming({ ownerCpuUs }),
        daemonTiming({ inputSeq: 0 }),
      ]).daemonPipeline.complete;
    expect(withOwnerCpu(3)).toBe(true);
    expect(withOwnerCpu(-1)).toBe(false);
  });

  test('sums egress refusals per hop and marks a replaced group incomplete', () => {
    const egress = (
      atMs: number,
      hop: 'daemon' | 'edge',
      blocked: number,
      waitedUs: number,
      series = 1,
    ): TerminalPerfEvent => ({
      kind: 'transport_egress',
      atMs,
      observationEpoch: 1,
      hop,
      series,
      interactive: { blocked, paced: 1, waitedUs },
      bulk: { blocked: 0, paced: 0, waitedUs: 0 },
    });
    const residence = (atMs: number, slow: number): TerminalPerfEvent => ({
      kind: 'edge_forward_residence',
      atMs,
      observationEpoch: 1,
      series: 1,
      buckets: [9, 0, 0, 0, 0, 0, 0, 0, 0, slow, 0, 0],
    });
    const report = buildTerminalLatencyReport([
      egress(1, 'daemon', 2, 100),
      egress(1, 'edge', 0, 0),
      residence(1, 0),
      egress(2, 'daemon', 5, 7_100),
      egress(2, 'edge', 4, 20_000),
      residence(2, 3),
    ]);
    expect(report.transportEgress).toEqual({
      complete: true,
      daemonSnapshotCount: 2,
      edgeSnapshotCount: 2,
      daemon: {
        interactive: { blocked: 3, paced: 0, waitedUs: 7_000 },
        bulk: { blocked: 0, paced: 0, waitedUs: 0 },
      },
      edge: {
        interactive: { blocked: 4, paced: 0, waitedUs: 20_000 },
        bulk: { blocked: 0, paced: 0, waitedUs: 0 },
      },
      edgeForwardResidence: [0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0],
    });

    // A new connection's group restarts its counters: that step counts from
    // zero, and the replaced group's unobserved tail makes the window partial.
    // The series says so, even where the new counters exceed the old.
    const replaced = buildTerminalLatencyReport([
      egress(1, 'daemon', 9, 900, 1),
      egress(2, 'daemon', 11, 1_000, 2),
    ]);
    expect(replaced.transportEgress.complete).toBe(false);
    expect(replaced.transportEgress.daemon.interactive).toEqual({
      blocked: 11,
      paced: 1,
      waitedUs: 1_000,
    });

    // Within one group a wrapped u32 counter is still an exact step.
    const wrapped = buildTerminalLatencyReport([
      egress(1, 'daemon', 9, 2 ** 32 - 10),
      egress(2, 'daemon', 10, 90),
    ]);
    expect(wrapped.transportEgress.complete).toBe(true);
    expect(wrapped.transportEgress.daemon.interactive).toEqual({
      blocked: 1,
      paced: 0,
      waitedUs: 100,
    });
  });

  test('accounts a complete daemon epoch starting at batch one after a recorder reset', () => {
    const report = buildTerminalLatencyReport([
      daemonTimingStatus({
        batchSeq: 1,
        inputAttributedTotal: 1,
        displayAttributedTotal: 1,
        recordCount: 2,
      }),
      daemonTiming({ batchSeq: 1, inputSeq: 3 }),
      daemonTiming({ batchSeq: 1, inputSeq: 0 }),
      daemonTimingStatus({
        batchSeq: 2,
        inputAttributedTotal: 2,
        displayAttributedTotal: 2,
        recordCount: 2,
      }),
      daemonTiming({ batchSeq: 2, inputSeq: 4 }),
      daemonTiming({ batchSeq: 2, inputSeq: 0 }),
    ]);

    expect(report.daemonPipeline.complete).toBe(true);
    expect(report.daemonPipeline.batchCount).toBe(2);
    expect(report.daemonPipeline.inputAttributedTotal).toBe(2);
    expect(report.daemonPipeline.displayAttributedTotal).toBe(2);
    expect(report.daemonPipeline.totalUs.count).toBe(2);
  });

  test('derives daemon compound stages per sample instead of adding percentiles', () => {
    const report = buildTerminalLatencyReport([
      daemonTimingStatus({ displayAttributedTotal: 2, recordCount: 2 }),
      daemonTiming({
        inputSeq: 0,
        displayCoalesceUs: 100,
        selectCaptureUs: 0,
        prepareQueueUs: 80,
        encodeUs: 0,
        compressionUs: 0,
        completionQueueUs: 0,
      }),
      daemonTiming({
        inputSeq: 0,
        displayCoalesceUs: 0,
        selectCaptureUs: 100,
        prepareQueueUs: 0,
        encodeUs: 0,
        compressionUs: 0,
        completionQueueUs: 80,
      }),
    ]);

    expect(report.daemonPipeline.gridMutationToEncodedUs.p50).toBe(100);
    expect(report.daemonPipeline.queuedBeforeTransportSubmitUs.p50).toBe(80);
  });

  test('fails closed on zero-record skipped, dropped, and pending tails', () => {
    for (const status of [
      daemonTimingStatus({ inputSkippedTotal: 1 }),
      daemonTimingStatus({ inputDroppedTotal: 1 }),
      daemonTimingStatus({ pendingInputs: 1 }),
      daemonTimingStatus({ displayDroppedTotal: 1 }),
    ]) {
      const pipeline = buildTerminalLatencyReport([status]).daemonPipeline;
      expect(pipeline.complete).toBe(false);
      expect(pipeline.totalUs.complete).toBe(false);
    }
  });

  test('does not call an empty or metadata-only daemon pipeline complete', () => {
    expect(buildTerminalLatencyReport([]).daemonPipeline.complete).toBe(false);
    const metadataOnly = buildTerminalLatencyReport([daemonTimingStatus()]).daemonPipeline;
    expect(metadataOnly.batchCount).toBe(1);
    expect(metadataOnly.inputAttributedTotal).toBe(0);
    expect(metadataOnly.complete).toBe(false);
    expect(metadataOnly.totalUs.complete).toBe(false);
  });

  test('rejects daemon records without status and status count mismatches', () => {
    expect(buildTerminalLatencyReport([daemonTiming()]).daemonPipeline.complete).toBe(false);
    expect(
      buildTerminalLatencyReport([
        daemonTimingStatus({ inputAttributedTotal: 1, recordCount: 0 }),
        daemonTiming(),
      ]).daemonPipeline.complete,
    ).toBe(false);
  });

  test('correlates worker stages by display generation and sequence', () => {
    const events = [
      inputQueued(100),
      displayEvent('display_received', 120, 2, 7),
      displayEvent('worker_display_queued', 125, 2, 7),
      // This event arrives late from another producer and reuses the sequence.
      displayEvent('worker_display_queued', 118, 1, 7),
      displayEvent('worker_display_applied', 130, 2, 7),
      frameComplete(135),
    ] satisfies TerminalPerfEvent[];

    const sample = buildTerminalLatencyReport(events).samples[0];

    expect(sample?.displayReceiveToWorkerQueueMs).toBe(5);
    expect(sample?.workerQueueToDisplayApplyMs).toBe(5);
    expect(sample?.inputToDisplayApplyMs).toBe(30);
  });

  test('uses the queue event for the frame that was actually applied', () => {
    const events = [
      inputQueued(100),
      displayEvent('display_received', 110, 1, 10),
      displayEvent('worker_display_queued', 112, 1, 10),
      displayEvent('display_received', 115, 1, 11),
      displayEvent('worker_display_queued', 116, 1, 11),
      displayEvent('worker_display_applied', 120, 1, 11),
      frameComplete(125),
    ] satisfies TerminalPerfEvent[];

    const sample = buildTerminalLatencyReport(events).samples[0];

    expect(sample?.displayReceiveToWorkerQueueMs).toBe(2);
    expect(sample?.workerQueueToDisplayApplyMs).toBe(4);
    expect(sample?.inputToDisplayPaintMs).toBe(25);
  });

  test('uses event timestamps when worker messages arrive out of order', () => {
    const events = [
      inputQueued(100),
      displayEvent('display_received', 150, 1, 2),
      displayEvent('worker_display_queued', 152, 1, 2),
      displayEvent('worker_display_applied', 160, 1, 2),
      displayEvent('display_received', 120, 1, 1),
      displayEvent('worker_display_queued', 122, 1, 1),
      displayEvent('worker_display_applied', 130, 1, 1),
      frameComplete(140),
    ] satisfies TerminalPerfEvent[];

    const sample = buildTerminalLatencyReport(events).samples[0];

    expect(sample?.inputToDisplayReceiveMs).toBe(20);
    expect(sample?.inputToDisplayApplyMs).toBe(30);
  });

  test('applies cumulative input acknowledgements to earlier inputs', () => {
    const events = [
      inputQueued(100, 1),
      inputQueued(105, 2),
      { kind: 'input_ack', atMs: 120, inputSeq: 2, networkRttMs: null },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);

    expect(report.samples[0]?.inputAckMs).toBe(20);
    expect(report.samples[1]?.inputAckMs).toBe(15);
    expect(report.inputAckMs.count).toBe(2);
  });

  test('uses the earliest duplicate input and acknowledgement timestamps', () => {
    const events = [
      inputQueued(110, 1),
      inputQueued(100, 1),
      { kind: 'input_ack', atMs: 130, inputSeq: 1, networkRttMs: null },
      { kind: 'input_ack', atMs: 120, inputSeq: 1, networkRttMs: null },
    ] satisfies TerminalPerfEvent[];

    expect(buildTerminalLatencyReport(events).samples[0]?.inputAckMs).toBe(20);
  });

  test('measures physical touch through commit and exact worker prediction submission without claiming completion', () => {
    const events = [
      inputQueued(110, 1),
      {
        kind: 'keyboard_commit',
        atMs: 109,
        touchStartedAtMs: 100,
        inputSeq: 1,
        repeat: false,
      },
      { kind: 'prediction_applied', atMs: 110.5, inputSeq: 1 },
      renderEnd(111, {
        displayInputSeq: 0,
        predictionInputSeq: 1,
        visiblePredictionInputSeqs: [1],
      }),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.samples[0]?.touchToCommitMs).toBe(9);
    expect(report.samples[0]?.touchToPredictionSubmissionMs).toBe(11);
    expect(report.samples[0]?.inputToPredictionSubmissionMs).toBe(1);
    expect(report.touchToCommitMs.count).toBe(1);
    expect(report.touchToPredictionSubmissionMs.count).toBe(1);
    expect(report.inputToPredictionSubmissionMs.count).toBe(1);
    expect(report.inputToPredictionPaintMs.count).toBe(0);
  });

  test('prediction submission requires exact accepted membership, not a high-water or later completion', () => {
    const base = [
      inputQueued(100, 1),
      inputQueued(101, 2),
      { kind: 'prediction_applied', atMs: 102, inputSeq: 1 },
      { kind: 'prediction_applied', atMs: 102, inputSeq: 2 },
    ] satisfies TerminalPerfEvent[];
    const end = renderEnd(105, {
      displayInputSeq: 0,
      predictionInputSeq: 2,
      visiblePredictionInputSeqs: [2],
    });
    const report = buildTerminalLatencyReport([...base, end]);
    expect(report.samples[0]?.inputToPredictionSubmissionMs).toBeNull();
    expect(report.samples[1]?.inputToPredictionSubmissionMs).toBe(4);
    expect(report.inputToPredictionPaintMs.count).toBe(0);
    for (const malformed of [
      { ...end, visiblePredictionInputSeqsTruncated: true },
      { ...end, visiblePredictionInputSeqs: [2, 2] },
      { ...end, predictionInputSeq: 3 },
    ]) {
      const rejected = buildTerminalLatencyReport([...base, malformed]);
      expect(rejected.inputToPredictionSubmissionMs.complete).toBe(false);
      expect(rejected.inputToPredictionSubmissionMs.count).toBe(0);
    }
    const duplicate = buildTerminalLatencyReport([...base, end, end]);
    expect(duplicate.inputToPredictionSubmissionMs.complete).toBe(false);
    expect(duplicate.inputToPredictionSubmissionMs.count).toBe(0);
    const confirmed = buildTerminalLatencyReport([...base, { ...end, displayInputSeq: 2 }]);
    expect(confirmed.inputToPredictionSubmissionMs.count).toBe(0);
    const inverted = buildTerminalLatencyReport([...base, { ...end, atMs: 99 }]);
    expect(inverted.inputToPredictionSubmissionMs.count).toBe(0);
  });

  test('excludes held-key repeats from tap-recognition latency', () => {
    const events = [
      inputQueued(200, 1),
      {
        kind: 'keyboard_commit',
        atMs: 200,
        touchStartedAtMs: 100,
        inputSeq: 1,
        repeat: true,
      },
      { kind: 'prediction_applied', atMs: 200.5, inputSeq: 1 },
      renderEnd(201, {
        displayInputSeq: 0,
        predictionInputSeq: 1,
        visiblePredictionInputSeqs: [1],
      }),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.samples[0]?.touchToCommitMs).toBeNull();
    expect(report.samples[0]?.touchToPredictionSubmissionMs).toBeNull();
    expect(report.samples[0]?.inputToPredictionSubmissionMs).toBe(1);
  });

  test('uses the earliest queue timestamp when duplicate events arrive out of order', () => {
    const events = [
      inputQueued(100),
      displayEvent('display_received', 110, 1, 10),
      displayEvent('worker_display_queued', 118, 1, 10),
      displayEvent('worker_display_queued', 112, 1, 10),
      displayEvent('worker_display_applied', 120, 1, 10),
      frameComplete(125),
    ] satisfies TerminalPerfEvent[];

    const sample = buildTerminalLatencyReport(events).samples[0];

    expect(sample?.displayReceiveToWorkerQueueMs).toBe(2);
    expect(sample?.workerQueueToDisplayApplyMs).toBe(8);
  });

  test('rejects causally impossible stage timings instead of reporting zero latency', () => {
    const events = [
      inputQueued(100),
      displayEvent('display_received', 110, 1, 10),
      // A malformed/clock-misaligned queue timestamp must not become a
      // suspiciously perfect 0ms stage through clamping.
      displayEvent('worker_display_queued', 105, 1, 10),
      displayEvent('worker_display_applied', 120, 1, 10),
      {
        ...frameComplete(115),
        displayInputSeq: 1,
      },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    const sample = report.samples[0];

    expect(sample?.displayReceiveToWorkerQueueMs).toBeNull();
    expect(sample?.displayApplyToPaintMs).toBeNull();
    expect(report.displayReceiveToWorkerQueueMs.count).toBe(0);
    expect(report.displayApplyToPaintMs.count).toBe(0);
  });

  test('rejects non-finite timestamps from corrupted diagnostic traces', () => {
    const events = [
      inputQueued(Number.NaN),
      { kind: 'input_ack', atMs: 120, inputSeq: 1, networkRttMs: null },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);

    expect(report.sampleCount).toBe(0);
    expect(report.inputAckMs.count).toBe(0);
    expect(report.inputAckMs.complete).toBe(false);
  });

  test('filters malformed indexed events without poisoning healthy timestamp order', () => {
    const events = [
      inputQueued(100, 1),
      inputQueued(101, 2),
      { kind: 'input_ack', atMs: Number.NaN, inputSeq: 2, networkRttMs: null },
      {
        kind: 'input_ack',
        atMs: 110,
        inputSeq: Number.POSITIVE_INFINITY,
        networkRttMs: null,
      },
      { kind: 'input_ack', atMs: 120, inputSeq: 2, networkRttMs: null },
      {
        ...displayEvent('display_received', Number.NaN, 1, 99),
        inputSeq: 2,
      },
      {
        ...displayEvent('display_received', 115, 1, 1),
        inputSeq: 2,
      },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.samples.map((sample) => sample.inputAckMs)).toEqual([20, 19]);
    expect(report.samples.map((sample) => sample.inputToDisplayReceiveMs)).toEqual([15, 14]);
    expect(report.inputAckMs.complete).toBe(false);
    expect(report.inputToDisplayReceiveMs.complete).toBe(false);
  });

  test('uses nearest-rank percentiles for exact tail boundaries', () => {
    const events: TerminalPerfEvent[] = [];
    for (let inputSeq = 1; inputSeq <= 100; inputSeq += 1) {
      events.push(inputQueued(inputSeq * 1_000, inputSeq));
      events.push({
        kind: 'input_ack',
        atMs: inputSeq * 1_000 + inputSeq,
        inputSeq,
        networkRttMs: null,
      });
    }

    const report = buildTerminalLatencyReport(events);

    expect(report.inputAckMs.p50).toBe(50);
    expect(report.inputAckMs.p95).toBe(95);
    expect(report.inputAckMs.p99).toBe(99);
  });

  test('handles large unmatched traces without inventing correlations', () => {
    const events: TerminalPerfEvent[] = [];
    for (let inputSeq = 1; inputSeq <= 2_000; inputSeq += 1) {
      events.push(inputQueued(inputSeq * 2, inputSeq));
      events.push({
        ...displayEvent('display_received', inputSeq * 2 + 1, 1, inputSeq),
        inputSeq: 0,
      });
      events.push({
        kind: 'input_ack',
        atMs: inputSeq * 2 + 1,
        inputSeq: 0,
        networkRttMs: null,
      });
    }

    const report = buildTerminalLatencyReport(events);

    expect(report.sampleCount).toBe(2_000);
    expect(report.inputToDisplayReceiveMs.count).toBe(0);
    expect(report.inputAckMs.count).toBe(0);
  });

  test('indexed correlations match a naive reference across adversarial traces', () => {
    let randomState = 0x6d2b_79f5;
    const random = (): number => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return randomState / 0x1_0000_0000;
    };

    for (let iteration = 0; iteration < 80; iteration += 1) {
      const inputs = Array.from({ length: 24 }, (_, index) =>
        inputQueued(index * 7 + 10, index + 1),
      );
      const receives: Extract<TerminalPerfEvent, { kind: 'display_received' }>[] = [];
      const applies: Extract<TerminalPerfEvent, { kind: 'worker_display_applied' }>[] = [];
      const paints: Extract<TerminalPerfEvent, { kind: 'frame_complete' }>[] = [];
      const acknowledgements: Extract<TerminalPerfEvent, { kind: 'input_ack' }>[] = [];
      const predictionApplied: Extract<TerminalPerfEvent, { kind: 'prediction_applied' }>[] =
        inputs.map((input) => ({
          kind: 'prediction_applied',
          atMs: input.atMs + 0.1,
          inputSeq: input.inputSeq,
        }));

      for (let eventIndex = 0; eventIndex < 48; eventIndex += 1) {
        const atMs = Math.floor(random() * 260) + eventIndex / 1_000;
        const cumulativeSeq = Math.floor(random() * 29);
        receives.push({
          ...displayEvent('display_received', atMs, 1, eventIndex + 1),
          inputSeq: cumulativeSeq,
        });
        applies.push({
          ...displayEvent('worker_display_applied', atMs + 0.2, 1, eventIndex + 1),
          inputSeq: cumulativeSeq,
        });
        const displayInputSeq = Math.floor(random() * 26);
        const visiblePredictionInputSeqs = Array.from(
          { length: Math.floor(random() * 5) },
          () => Math.floor(random() * 26) + 1,
        );
        paints.push({
          ...frameComplete(atMs + 0.4),
          displayInputSeq,
          predictionInputSeq: Math.max(0, ...visiblePredictionInputSeqs),
          visiblePredictionInputSeqs,
        });
        acknowledgements.push({
          kind: 'input_ack',
          atMs: atMs + 0.6,
          inputSeq: Math.floor(random() * 29),
          networkRttMs: null,
        });
      }

      const report = buildTerminalLatencyReport(
        [
          ...inputs,
          ...predictionApplied,
          ...receives,
          ...applies,
          ...paints,
          ...acknowledgements,
        ].reverse(),
      );
      const byTimestamp = <T extends { readonly atMs: number }>(events: readonly T[]): T[] =>
        [...events].sort((left, right) => left.atMs - right.atMs);
      const sortedReceives = byTimestamp(receives);
      const sortedApplies = byTimestamp(applies);
      let displayedInputHighWater = 0;
      const sortedPaints = byTimestamp(paints).filter((paint) => {
        if (paint.displayInputSeq < displayedInputHighWater) return false;
        displayedInputHighWater = paint.displayInputSeq;
        return true;
      });
      const earliestAckBySeq = new Map<number, (typeof acknowledgements)[number]>();
      for (const acknowledgement of acknowledgements) {
        const current = earliestAckBySeq.get(acknowledgement.inputSeq);
        if (current === undefined || acknowledgement.atMs < current.atMs) {
          earliestAckBySeq.set(acknowledgement.inputSeq, acknowledgement);
        }
      }
      const sortedAcks = byTimestamp([...earliestAckBySeq.values()]);

      for (const input of inputs) {
        const sample = report.samples[input.inputSeq - 1];
        const first = <T extends { readonly atMs: number }>(
          events: readonly T[],
          matches: (event: T) => boolean,
        ): T | undefined => events.find((event) => event.atMs >= input.atMs && matches(event));
        const receive = first(sortedReceives, (event) => event.inputSeq >= input.inputSeq);
        const apply = first(sortedApplies, (event) => event.inputSeq >= input.inputSeq);
        const paint = first(sortedPaints, (event) => event.displayInputSeq >= input.inputSeq);
        const predictionPaint = first(
          sortedPaints,
          (event) =>
            event.displayInputSeq < input.inputSeq &&
            event.visiblePredictionInputSeqs.includes(input.inputSeq),
        );
        const acknowledgement = first(sortedAcks, (event) => event.inputSeq >= input.inputSeq);

        expect(sample?.inputToDisplayReceiveMs).toBe(
          receive === undefined ? null : receive.atMs - input.atMs,
        );
        expect(sample?.inputToDisplayApplyMs).toBe(
          apply === undefined ? null : apply.atMs - input.atMs,
        );
        expect(sample?.inputToDisplayPaintMs).toBe(
          paint === undefined ? null : paint.atMs - input.atMs,
        );
        expect(sample?.inputToPredictionPaintMs).toBe(
          predictionPaint === undefined ? null : predictionPaint.atMs - input.atMs,
        );
        expect(sample?.inputAckMs).toBe(
          acknowledgement === undefined ? null : acknowledgement.atMs - input.atMs,
        );
      }
    }
  });

  test('paint latency waits for GPU completion rather than render submission', () => {
    const events = [
      inputQueued(100),
      renderEnd(110),
      frameComplete(130),
    ] satisfies TerminalPerfEvent[];

    expect(buildTerminalLatencyReport(events).samples[0]?.inputToDisplayPaintMs).toBe(30);
  });

  test('does not call a header-only causal barrier an authoritative visual fence', () => {
    const events = [
      inputQueued(100),
      {
        ...displayEvent('worker_display_applied', 120, 1, 1),
        presentationId: 7,
        presentationTransactionSeq: 0,
        authoritativeVisualMutation: false,
        rowCount: 0,
      },
      renderStart(122),
      renderEnd(124),
      frameComplete(130),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    const sample = report.samples[0];
    // The cumulative input high-water still makes the historical causal metric
    // complete, but no authoritative geometry changed in this submission.
    expect(sample?.inputToDisplayPaintMs).toBe(30);
    expect(sample?.inputToAuthoritativeVisualFenceMs).toBeNull();
    expect(sample?.inputToCompletedAuthoritativePresentationFenceMs).toBeNull();
    expect(report.presentation.commitCount).toBe(0);
    expect(report.presentation.partialPresentationExposureMs.complete).toBe(true);
    expect(report.presentation.commitsPerPresentation.complete).toBe(true);
  });

  test('reports exact worker decode, apply, and bounded display-pump stages', () => {
    const received = {
      ...displayEvent('display_received', 100, 1, 1),
      workerReceiptToDecodeMs: 1.25,
    } satisfies TerminalPerfEvent;
    const applied = {
      ...displayEvent('worker_display_applied', 106, 1, 1),
      presentationTransactionSeq: 0,
      authoritativeVisualMutation: false,
      decodeToApplyMs: 4.75,
    } satisfies TerminalPerfEvent;
    const pump = {
      kind: 'display_pump_complete',
      ringBytesAtStart: 8192,
      ringBytesAtEnd: 64,
      ringDroppedTotal: 2,
      atMs: 107,
      durationMs: 5.5,
      budgetMs: 4,
      processedDatagramCount: 1,
      processedRowCount: 3,
      queueHighWater: 2,
      queueRemaining: 1,
    } satisfies TerminalPerfEvent;
    const report = buildTerminalLatencyReport([received, applied, pump]);

    expect(report.displayPipeline.workerReceiptToDecodeMs.p50).toBe(1.25);
    expect(report.displayPipeline.workerReceiptToDecodeMs.complete).toBe(true);
    expect(report.displayPipeline.decodeToApplyMs.p50).toBe(4.75);
    expect(report.displayPipeline.decodeToApplyMs.complete).toBe(true);
    expect(report.displayPipeline.pumpDurationMs.max).toBe(5.5);
    expect(report.displayPipeline.pumpBudgetMs.p50).toBe(4);
    expect(report.displayPipeline.datagramsPerPump.p50).toBe(1);
    expect(report.displayPipeline.rowsPerPump.p50).toBe(3);
    expect(report.displayPipeline.encodedDeferralQueueHighWaterPerPump.p50).toBe(2);
    expect(report.displayPipeline.encodedDeferralQueueRemainingPerPump.p50).toBe(1);
    expect(report.displayPipeline.ringBytesAtPumpStart.p50).toBe(8192);
    expect(report.displayPipeline.ringBytesAtPumpEnd.p50).toBe(64);
    expect(report.displayPipeline.budgetExceededCount).toBe(1);

    const invalid = buildTerminalLatencyReport([{ ...received, workerReceiptToDecodeMs: null }]);
    expect(invalid.displayPipeline.workerReceiptToDecodeMs.count).toBe(0);
    expect(invalid.displayPipeline.workerReceiptToDecodeMs.complete).toBe(false);
  });

  test('does not label absent completion evidence as GPU queue completion', () => {
    const events = [
      inputQueued(100),
      {
        ...displayEvent('worker_display_applied', 120, 1, 1),
        presentationId: 7,
        presentationCoherent: true,
      },
      renderStart(122),
      renderEnd(124, { completionMode: 'none' }),
      presentationCommit(124, {
        firstApplyToCommitMs: 4,
        lastApplyToCommitMs: 4,
      }),
      frameComplete(130),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.samples[0]?.inputToAuthoritativeVisualFenceMs).toBeNull();
    expect(report.inputToAuthoritativeVisualFenceMs.count).toBe(0);
    expect(report.inputToAuthoritativeVisualFenceMs.complete).toBe(true);
    // A scheduler task boundary is not evidence of GPU completion, so neither
    // coherence distribution may claim complete data from this trace.
    expect(report.presentation.partialPresentationExposureMs.count).toBe(0);
    expect(report.presentation.partialPresentationExposureMs.complete).toBe(false);
    expect(report.presentation.commitsPerPresentation.complete).toBe(false);
    expect(report.presentation.measurementWindowExposureMs.complete).toBe(false);
    expect(report.presentation.commitsPerMeasurementWindow.complete).toBe(false);
  });

  test('measures one coherent multi-datagram update as one zero-exposure presentation', () => {
    const events = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 99,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      inputQueued(100),
      {
        ...displayEvent('display_received', 118, 1, 10),
        presentationId: 7,
        presentationCoherent: true,
      },
      {
        ...displayEvent('display_received', 119, 1, 11),
        presentationId: 7,
        presentationCoherent: true,
      },
      {
        ...displayEvent('display_received', 120, 1, 12),
        presentationId: 7,
        presentationCoherent: true,
        fecRecovered: false,
        presentationEnd: true,
      },
      {
        ...displayEvent('worker_display_applied', 120, 1, 10),
        presentationId: 7,
        presentationCoherent: true,
      },
      {
        ...displayEvent('worker_display_applied', 120.5, 1, 11),
        presentationId: 7,
        presentationCoherent: true,
      },
      {
        ...displayEvent('worker_display_applied', 121, 1, 12),
        presentationId: 7,
        presentationCoherent: true,
        fecRecovered: false,
        presentationEnd: true,
      },
      renderStart(124),
      renderEnd(126),
      presentationCommit(126, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 12,
        firstPresentationId: 7,
        lastPresentationId: 7,
        firstApplyToCommitMs: 6,
        lastApplyToCommitMs: 5,
        datagramCount: 3,
        rowCount: 3,
        byteLength: 96,
        endSeen: true,
      }),
      frameComplete(130),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 131,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    const sample = report.samples[0];
    expect(sample?.inputToAuthoritativeVisualFenceMs).toBe(30);
    expect(sample?.inputToCompletedAuthoritativePresentationFenceMs).toBe(30);
    expect(sample?.inputToCompletedSenderPresentationFenceMs).toBe(30);
    expect(
      report.presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs.p50,
    ).toBe(31);
    expect(report.presentation.commitCount).toBe(1);
    expect(report.presentation.datagramsPerCommit.p50).toBe(3);
    expect(report.presentation.firstReceiveToCommitMs.p50).toBe(8);
    expect(report.presentation.commitToGpuFenceMs.p50).toBe(4);
    expect(report.presentation.partialPresentationExposureMs.p50).toBe(0);
    expect(report.presentation.partialPresentationExposureMs.complete).toBe(true);
    expect(report.presentation.commitsPerPresentation.p50).toBe(1);
    expect(report.presentation.commitsPerPresentation.complete).toBe(true);
  });

  test('uses delayed GPU fences and every intermediate presentation ID', () => {
    const events = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 99,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      inputQueued(100),
      {
        ...displayEvent('worker_display_applied', 120, 1, 10),
        presentationId: 7,
        presentationCoherent: true,
      },
      {
        ...displayEvent('worker_display_applied', 120.5, 1, 11),
        presentationId: 8,
        presentationCoherent: true,
      },
      {
        ...displayEvent('worker_display_applied', 121, 1, 12),
        presentationId: 9,
        presentationCoherent: true,
      },
      renderStart(122),
      renderEnd(126),
      presentationCommit(126, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 12,
        firstPresentationId: 7,
        lastPresentationId: 9,
        firstApplyToCommitMs: 6,
        lastApplyToCommitMs: 5,
        deadlineOverrunMs: 0,
        datagramCount: 3,
        rowCount: 3,
        byteLength: 96,
      }),
      frameComplete(160),
      {
        ...displayEvent('worker_display_applied', 136, 1, 13),
        presentationId: 8,
        presentationTransactionSeq: 2,
        presentationCoherent: true,
      },
      renderStart(138, { renderSeq: 2 }),
      renderEnd(142, { renderSeq: 2 }),
      presentationCommit(142, {
        transactionSeq: 2,
        renderSeq: 2,
        firstDisplaySeq: 13,
        lastDisplaySeq: 13,
        firstPresentationId: 8,
        lastPresentationId: 8,
        firstApplyToCommitMs: 6,
        lastApplyToCommitMs: 6,
        deadlineOverrunMs: 0,
      }),
      frameComplete(220, { renderSeq: 2 }),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 221,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.presentation.groupCount).toBe(3);
    expect(report.presentation.groupsWithMultipleCommits).toBe(1);
    expect(report.presentation.commitsPerPresentation.p50).toBe(1);
    expect(report.presentation.commitsPerPresentation.p95).toBe(2);
    expect(report.presentation.commitsPerPresentation.complete).toBe(true);
    expect(report.presentation.partialPresentationExposureMs.p50).toBe(0);
    expect(report.presentation.partialPresentationExposureMs.p95).toBe(60);
    expect(report.presentation.partialPresentationExposureMs.max).toBe(60);
    expect(report.presentation.partialPresentationExposureMs.complete).toBe(true);
    // Completion uses the poll-observed GPU fences (160/220), not the render
    // submission timestamps (126/142). ID 8 is deliberately neither endpoint
    // of the first transaction and must still extend its coherent completion.
    expect(report.samples[0]?.inputToAuthoritativeVisualFenceMs).toBe(60);
    expect(report.samples[0]?.inputToCompletedAuthoritativePresentationFenceMs).toBe(120);
    expect(report.samples[0]?.inputToCompletedSenderPresentationFenceMs).toBe(120);
  });

  test('completes an explicit input workload at the last fence across distinct sender ids', () => {
    const events = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 95,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      inputQueued(100),
      {
        ...displayEvent('worker_display_applied', 120, 1, 10),
        presentationId: 7,
        presentationTransactionSeq: 1,
        presentationCoherent: true,
      },
      renderStart(122),
      renderEnd(126),
      presentationCommit(126, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        firstPresentationId: 7,
        lastPresentationId: 7,
        firstApplyToCommitMs: 6,
        lastApplyToCommitMs: 6,
      }),
      frameComplete(160),
      {
        ...displayEvent('worker_display_applied', 170, 1, 11),
        presentationId: 8,
        presentationTransactionSeq: 2,
        presentationCoherent: true,
      },
      renderStart(172, { renderSeq: 2 }),
      renderEnd(176, { renderSeq: 2 }),
      presentationCommit(176, {
        transactionSeq: 2,
        renderSeq: 2,
        firstDisplaySeq: 11,
        lastDisplaySeq: 11,
        firstPresentationId: 8,
        lastPresentationId: 8,
        firstApplyToCommitMs: 6,
        lastApplyToCommitMs: 6,
      }),
      frameComplete(220, { renderSeq: 2 }),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 225,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.samples[0]?.inputToCompletedSenderPresentationFenceMs).toBe(60);
    expect(report.samples[0]?.inputToCompletedAuthoritativePresentationFenceMs).toBe(120);
    expect(
      report.presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs.p50,
    ).toBe(125);
  });

  test('does not make completed input latency depend on later same-high-water output', () => {
    const firstResponse = [
      inputQueued(100),
      {
        ...displayEvent('worker_display_applied', 120, 1, 10),
        presentationId: 7,
      },
      renderStart(122),
      renderEnd(126),
      presentationCommit(126, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        firstPresentationId: 7,
        lastPresentationId: 7,
      }),
      frameComplete(130),
    ] satisfies TerminalPerfEvent[];
    const unrelatedSameHighWater = [
      {
        ...displayEvent('worker_display_applied', 4_990, 1, 11),
        presentationId: 8,
        presentationTransactionSeq: 2,
      },
      renderStart(4_992, { renderSeq: 2 }),
      renderEnd(4_996, { renderSeq: 2 }),
      presentationCommit(4_996, {
        transactionSeq: 2,
        renderSeq: 2,
        firstDisplaySeq: 11,
        lastDisplaySeq: 11,
        firstPresentationId: 8,
        lastPresentationId: 8,
      }),
      frameComplete(5_000, { renderSeq: 2 }),
    ] satisfies TerminalPerfEvent[];

    for (const events of [firstResponse, [...firstResponse, ...unrelatedSameHighWater]]) {
      const report = buildTerminalLatencyReport(events);
      expect(report.samples[0]?.inputToCompletedAuthoritativePresentationFenceMs).toBeNull();
      expect(report.inputToCompletedAuthoritativePresentationFenceMs.complete).toBe(false);
    }
  });

  test('uses only inputs admitted inside an explicit workload window as completion candidates', () => {
    const events = [
      inputQueued(90, 1),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 95,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      inputQueued(100, 2),
      {
        ...displayEvent('worker_display_applied', 120, 1, 10),
        inputSeq: 2,
        presentationId: 7,
      },
      renderStart(122, { displayInputSeq: 2 }),
      renderEnd(126, { displayInputSeq: 2 }),
      presentationCommit(126, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        displayInputSeq: 2,
        firstPresentationId: 7,
        lastPresentationId: 7,
      }),
      frameComplete(130, { displayInputSeq: 2 }),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 135,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.sampleCount).toBe(2);
    expect(report.samples[0]?.inputToCompletedAuthoritativePresentationFenceMs).toBeNull();
    expect(report.samples[1]?.inputToCompletedAuthoritativePresentationFenceMs).toBe(30);
    expect(report.inputToCompletedAuthoritativePresentationFenceMs.eligibleCount).toBe(1);
    expect(report.inputToCompletedAuthoritativePresentationFenceMs.censoredCount).toBe(0);
    expect(report.inputToCompletedAuthoritativePresentationFenceMs.count).toBe(1);
    expect(report.inputToCompletedAuthoritativePresentationFenceMs.complete).toBe(true);
  });

  test('attributes logical-workload completion only to the final trigger input', () => {
    const events = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 95,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      inputQueued(100, 1),
      inputQueued(200, 2),
      inputQueued(300, 3),
      {
        ...displayEvent('worker_display_applied', 320, 1, 10),
        inputSeq: 3,
        presentationId: 7,
      },
      renderStart(322, { displayInputSeq: 3 }),
      renderEnd(326, { displayInputSeq: 3 }),
      presentationCommit(326, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        displayInputSeq: 3,
        firstPresentationId: 7,
        lastPresentationId: 7,
      }),
      frameComplete(330, { displayInputSeq: 3 }),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 335,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.samples[0]?.inputToCompletedAuthoritativePresentationFenceMs).toBeNull();
    expect(report.samples[1]?.inputToCompletedAuthoritativePresentationFenceMs).toBeNull();
    expect(report.samples[2]?.inputToCompletedAuthoritativePresentationFenceMs).toBe(30);
    expect(report.inputToCompletedAuthoritativePresentationFenceMs.eligibleCount).toBe(1);
    expect(report.inputToCompletedAuthoritativePresentationFenceMs.censoredCount).toBe(0);
    expect(report.inputToCompletedAuthoritativePresentationFenceMs.count).toBe(1);
    expect(
      report.presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs.p50,
    ).toBe(235);
  });

  test('keeps timestamp-ordered cumulative joins coherent across a synthetic u32 wrap', () => {
    const sequences = [0xffff_fffe, 0xffff_ffff, 1, 2];
    const events: TerminalPerfEvent[] = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 95,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
    ];
    for (const [index, inputSeq] of sequences.entries()) {
      const inputAtMs = 100 + index * 20;
      const displaySeq = 20 + index;
      const transactionSeq = 30 + index;
      const renderSeq = 40 + index;
      const presentationId = 50 + index;
      events.push(
        inputQueued(inputAtMs, inputSeq),
        {
          ...displayEvent('display_received', inputAtMs + 10, 1, displaySeq),
          inputSeq,
          frameId: displaySeq,
          presentationId,
        },
        {
          ...displayEvent('worker_display_queued', inputAtMs + 11, 1, displaySeq),
          inputSeq,
          frameId: displaySeq,
          presentationId,
        },
        {
          ...displayEvent('worker_display_applied', inputAtMs + 12, 1, displaySeq),
          inputSeq,
          frameId: displaySeq,
          presentationId,
          presentationTransactionSeq: transactionSeq,
        },
        presentationCommit(inputAtMs + 14, {
          transactionSeq,
          renderSeq,
          firstDisplaySeq: displaySeq,
          lastDisplaySeq: displaySeq,
          displayInputSeq: inputSeq,
          firstPresentationId: presentationId,
          lastPresentationId: presentationId,
        }),
        renderStart(inputAtMs + 14, { renderSeq, displayInputSeq: inputSeq }),
        renderEnd(inputAtMs + 15, { renderSeq, displayInputSeq: inputSeq }),
        frameComplete(inputAtMs + 17, { renderSeq, displayInputSeq: inputSeq }),
      );
    }
    events.push({
      kind: 'presentation_measurement_boundary',
      atMs: 185,
      measurementId: 1,
      phase: 'end',
      purpose: 'streaming',
    });

    const report = buildTerminalLatencyReport(events);
    expect(report.samples.map((sample) => sample.inputSeq)).toEqual(sequences);
    expect(report.samples.map((sample) => sample.inputToDisplayReceiveMs)).toEqual([
      10, 10, 10, 10,
    ]);
    expect(report.samples.map((sample) => sample.inputToDisplayApplyMs)).toEqual([12, 12, 12, 12]);
    expect(report.samples.map((sample) => sample.inputToAuthoritativeVisualFenceMs)).toEqual([
      17, 17, 17, 17,
    ]);
    expect(
      report.samples.map((sample) => sample.inputToCompletedAuthoritativePresentationFenceMs),
    ).toEqual([null, null, null, 17]);
    expect(report.inputToAuthoritativeVisualFenceMs.complete).toBe(true);
    expect(report.inputToCompletedAuthoritativePresentationFenceMs.complete).toBe(true);
    expect(report.presentation.measurementWindowExposureMs.complete).toBe(true);
  });

  test('fails completed workload latency closed when the final fence does not cover its trigger', () => {
    const events = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 95,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      inputQueued(100, 2),
      {
        ...displayEvent('worker_display_applied', 120, 1, 10),
        inputSeq: 1,
        presentationId: 7,
      },
      renderStart(122),
      renderEnd(126),
      presentationCommit(126, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        displayInputSeq: 1,
        firstPresentationId: 7,
        lastPresentationId: 7,
      }),
      frameComplete(130),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 135,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const completed =
      buildTerminalLatencyReport(events).inputToCompletedAuthoritativePresentationFenceMs;
    expect(completed.eligibleCount).toBe(1);
    expect(completed.censoredCount).toBe(1);
    expect(completed.count).toBe(0);
    expect(completed.complete).toBe(false);
  });

  test('resolves a held visual transaction through an exact offscreen discard', () => {
    const applied = {
      ...displayEvent('worker_display_applied', 120, 1, 0xffff_ffff),
      presentationId: 7,
      presentationTransactionSeq: 9,
      rowCount: 2,
      byteLength: 40,
    } satisfies TerminalPerfEvent;
    const wrapped = {
      ...displayEvent('worker_display_applied', 121, 1, 0),
      presentationId: 7,
      presentationTransactionSeq: 9,
      rowCount: 3,
      byteLength: 60,
    } satisfies TerminalPerfEvent;
    const discard = {
      kind: 'presentation_transaction_discarded',
      atMs: 122,
      transactionSeq: 9,
      generation: 1,
      firstDisplaySeq: 0xffff_ffff,
      lastDisplaySeq: 0,
      appliedDatagramCount: 2,
      rowCount: 5,
      byteLength: 100,
      reason: 'resync',
    } satisfies TerminalPerfEvent;

    const report = buildTerminalLatencyReport([wrapped, applied, discard]);
    expect(report.presentation.discardedTransactionCount).toBe(1);
    expect(report.presentation.discardedDatagramCount).toBe(2);
    expect(report.presentation.discardedRowCount).toBe(5);
    expect(report.presentation.discardedByteCount).toBe(100);
    expect(report.presentation.discardedTransactionCountByReason.resync).toBe(1);
    expect(report.presentation.commitCount).toBe(0);
    expect(report.presentation.partialPresentationExposureMs.complete).toBe(true);
  });

  test('fails discard membership closed on late, incomplete, or doubly resolved attribution', () => {
    const applied = {
      ...displayEvent('worker_display_applied', 120, 1, 10),
      presentationId: 7,
      presentationTransactionSeq: 9,
    } satisfies TerminalPerfEvent;
    const exactDiscard = {
      kind: 'presentation_transaction_discarded',
      atMs: 121,
      transactionSeq: 9,
      generation: 1,
      firstDisplaySeq: 10,
      lastDisplaySeq: 10,
      appliedDatagramCount: 1,
      rowCount: 1,
      byteLength: 32,
      reason: 'epoch-reset',
    } satisfies TerminalPerfEvent;
    const commit = presentationCommit(126, {
      transactionSeq: 9,
      firstDisplaySeq: 10,
      lastDisplaySeq: 10,
      firstPresentationId: 7,
      lastPresentationId: 7,
    });
    for (const events of [
      [applied, { ...exactDiscard, atMs: 119 }],
      [applied, { ...exactDiscard, appliedDatagramCount: 2 }],
      [applied, exactDiscard, renderStart(122), renderEnd(126), commit, frameComplete(130)],
    ] satisfies TerminalPerfEvent[][]) {
      expect(
        buildTerminalLatencyReport(events).presentation.partialPresentationExposureMs.complete,
      ).toBe(false);
    }
  });

  test('keeps a held delta offscreen across resync and presents only the replacement snapshot', () => {
    const events = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      inputQueued(105),
      {
        ...displayEvent('worker_display_applied', 110, 1, 10),
        presentationId: 7,
        presentationTransactionSeq: 9,
        rowCount: 2,
        byteLength: 64,
      },
      {
        kind: 'presentation_transaction_discarded',
        atMs: 112,
        transactionSeq: 9,
        generation: 1,
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        appliedDatagramCount: 1,
        rowCount: 2,
        byteLength: 64,
        reason: 'resync',
      },
      {
        ...displayEvent('worker_display_applied', 120, 2, 1),
        presentationId: 8,
        presentationTransactionSeq: 10,
        displayKind: 'display_snapshot',
        rowCount: 24,
        byteLength: 768,
      },
      renderStart(122, { renderSeq: 2 }),
      renderEnd(126, { renderSeq: 2 }),
      presentationCommit(126, {
        transactionSeq: 10,
        renderSeq: 2,
        generation: 2,
        firstDisplaySeq: 1,
        lastDisplaySeq: 1,
        firstPresentationId: 8,
        lastPresentationId: 8,
        datagramCount: 1,
        rowCount: 24,
        byteLength: 768,
      }),
      frameComplete(130, { renderSeq: 2 }),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 135,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const presentation = buildTerminalLatencyReport(events).presentation;
    expect(presentation.discardedTransactionCount).toBe(1);
    expect(presentation.commitCount).toBe(1);
    expect(presentation.groupCount).toBe(1);
    expect(presentation.rowsPerMeasurementWindow.p50).toBe(24);
    expect(presentation.commitsPerMeasurementWindow.p50).toBe(1);
    expect(presentation.measurementWindowExposureMs.p50).toBe(0);
    expect(presentation.measurementWindowExposureMs.complete).toBe(true);
  });

  test('scopes presentation joins to the terminal worker epoch boundary', () => {
    const events = [
      // Main can publish the new session before the worker discards the old
      // transaction and releases its ring fence. Old render identity 2 must not
      // collide with the replacement snapshot's reused identity.
      { kind: 'session_start', atMs: 105 },
      renderStart(106, { renderSeq: 2 }),
      renderEnd(107, { renderSeq: 2 }),
      frameComplete(109, { renderSeq: 2 }),
      {
        kind: 'presentation_transaction_discarded',
        atMs: 110,
        transactionSeq: 9,
        generation: 1,
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        appliedDatagramCount: 1,
        rowCount: 1,
        byteLength: 32,
        reason: 'teardown',
      },
      { kind: 'presentation_epoch_boundary', atMs: 111, epoch: 2, preserved: false },
      {
        kind: 'presentation_measurement_boundary',
        atMs: 112,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      inputQueued(113),
      {
        ...displayEvent('worker_display_applied', 120, 2, 1),
        presentationId: 8,
        presentationTransactionSeq: 10,
        displayKind: 'display_snapshot',
        rowCount: 24,
        byteLength: 768,
      },
      renderStart(122, { renderSeq: 2 }),
      renderEnd(126, { renderSeq: 2 }),
      presentationCommit(126, {
        transactionSeq: 10,
        renderSeq: 2,
        generation: 2,
        firstDisplaySeq: 1,
        lastDisplaySeq: 1,
        firstPresentationId: 8,
        lastPresentationId: 8,
        rowCount: 24,
        byteLength: 768,
      }),
      frameComplete(130, { renderSeq: 2 }),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 135,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const presentation = buildTerminalLatencyReport(events).presentation;
    expect(presentation.epochBoundaryCount).toBe(1);
    expect(presentation.currentEpoch).toBe(2);
    expect(presentation.discardedTransactionCount).toBe(0);
    expect(presentation.commitCount).toBe(1);
    expect(presentation.rowsPerMeasurementWindow.p50).toBe(24);
    expect(presentation.measurementWindowExposureMs.p50).toBe(0);
    expect(presentation.measurementWindowExposureMs.complete).toBe(true);
  });

  test('fails current-session presentation evidence closed without a worker epoch boundary', () => {
    const events = [
      { kind: 'session_start', atMs: 100 },
      {
        ...displayEvent('worker_display_applied', 110, 1, 10),
        presentationId: 7,
      },
      renderStart(112),
      renderEnd(116),
      presentationCommit(116, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        firstPresentationId: 7,
        lastPresentationId: 7,
      }),
      frameComplete(120),
    ] satisfies TerminalPerfEvent[];

    const presentation = buildTerminalLatencyReport(events).presentation;
    expect(presentation.epochBoundaryCount).toBe(0);
    expect(presentation.currentEpoch).toBeNull();
    expect(presentation.partialPresentationExposureMs.complete).toBe(false);
  });

  test('accepts a production-shaped resync snapshot in the current terminal epoch', () => {
    const received = {
      ...displayEvent('display_received', 110, 2, 0),
      frameId: 77,
      presentationId: 88,
      presentationCoherent: false,
      fecRecovered: false,
      presentationEnd: true,
      displayKind: 'display_snapshot',
      rowCount: 24,
      byteLength: 768,
    } satisfies TerminalPerfEvent;
    const queued = {
      ...displayEvent('worker_display_queued', 112, 2, 0),
      frameId: 77,
      presentationId: 88,
      presentationCoherent: false,
      fecRecovered: false,
      presentationEnd: true,
      displayKind: 'display_snapshot',
      rowCount: 24,
      byteLength: 768,
    } satisfies TerminalPerfEvent;
    const applied = {
      ...displayEvent('worker_display_applied', 114, 2, 0),
      frameId: 77,
      presentationId: 88,
      presentationTransactionSeq: 10,
      presentationCoherent: false,
      fecRecovered: false,
      presentationEnd: true,
      displayKind: 'display_snapshot',
      rowCount: 24,
      byteLength: 768,
    } satisfies TerminalPerfEvent;
    const events = [
      { kind: 'session_start', atMs: 100 },
      { kind: 'presentation_epoch_boundary', atMs: 101, epoch: 2, preserved: false },
      inputQueued(105),
      {
        kind: 'display_resync',
        atMs: 106,
        reason: 'apply_rejected',
        generation: 1,
        alreadyPending: false,
      },
      received,
      queued,
      applied,
      renderStart(116, { renderSeq: 2 }),
      renderEnd(120, { renderSeq: 2 }),
      presentationCommit(120, {
        transactionSeq: 10,
        renderSeq: 2,
        generation: 2,
        firstDisplaySeq: 0,
        lastDisplaySeq: 0,
        firstPresentationId: 88,
        lastPresentationId: 88,
        displayInputSeq: 1,
        firstApplyToCommitMs: 6,
        lastApplyToCommitMs: 6,
        datagramCount: 1,
        rowCount: 24,
        byteLength: 768,
        coherent: false,
        endSeen: true,
        reason: 'urgent',
      }),
      frameComplete(125, { renderSeq: 2 }),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.inputToDisplayReceiveMs.complete).toBe(true);
    expect(report.displayReceiveToWorkerQueueMs.p50).toBe(2);
    expect(report.workerQueueToDisplayApplyMs.p50).toBe(2);
    expect(report.presentation.currentEpoch).toBe(2);
    expect(report.presentation.commitCount).toBe(1);
    expect(report.presentation.urgentCommitCount).toBe(1);
    expect(report.presentation.commitToGpuFenceMs.p50).toBe(5);
    expect(report.presentation.partialPresentationExposureMs.complete).toBe(true);
    expect(report.presentation.commitsPerPresentation.complete).toBe(true);
  });

  test('tracks a visible replacement and the following transaction as two real fences', () => {
    const events = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      {
        ...displayEvent('worker_display_applied', 110, 1, 10),
        presentationId: 7,
      },
      renderStart(111),
      renderEnd(112),
      presentationCommit(112, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        firstPresentationId: 7,
        lastPresentationId: 7,
      }),
      frameComplete(120),
      {
        ...displayEvent('worker_display_applied', 125, 1, 11),
        presentationId: 8,
        presentationTransactionSeq: 2,
      },
      renderStart(126, { renderSeq: 2 }),
      renderEnd(127, { renderSeq: 2 }),
      presentationCommit(127, {
        transactionSeq: 2,
        renderSeq: 2,
        firstDisplaySeq: 11,
        lastDisplaySeq: 11,
        firstPresentationId: 8,
        lastPresentationId: 8,
      }),
      frameComplete(140, { renderSeq: 2 }),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 145,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const presentation = buildTerminalLatencyReport(events).presentation;
    expect(presentation.commitsPerMeasurementWindow.p50).toBe(2);
    expect(presentation.measurementWindowExposureMs.p50).toBe(20);
    expect(presentation.measurementWindowExposureMs.complete).toBe(true);
  });

  test('measures the known 128.9ms singleton sweep inside an explicit workload window', () => {
    const events = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 4_600,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      {
        ...displayEvent('worker_display_applied', 4_646, 1, 10),
        presentationId: 7,
        presentationTransactionSeq: 1,
        presentationCoherent: true,
      },
      renderStart(4_648),
      renderEnd(4_650),
      presentationCommit(4_650, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        firstPresentationId: 7,
        lastPresentationId: 7,
        firstApplyToCommitMs: 4,
        lastApplyToCommitMs: 4,
      }),
      frameComplete(4_657),
      {
        ...displayEvent('worker_display_applied', 4_673.8, 1, 11),
        presentationId: 8,
        presentationTransactionSeq: 2,
        presentationCoherent: true,
      },
      renderStart(4_674, { renderSeq: 2 }),
      renderEnd(4_675, { renderSeq: 2 }),
      presentationCommit(4_675, {
        transactionSeq: 2,
        renderSeq: 2,
        firstDisplaySeq: 11,
        lastDisplaySeq: 11,
        firstPresentationId: 8,
        lastPresentationId: 8,
        firstApplyToCommitMs: 1.2,
        lastApplyToCommitMs: 1.2,
      }),
      frameComplete(4_676, { renderSeq: 2 }),
      {
        ...displayEvent('worker_display_applied', 4_767.23, 1, 12),
        presentationId: 9,
        presentationTransactionSeq: 3,
        presentationCoherent: true,
      },
      renderStart(4_767.5, { renderSeq: 3 }),
      renderEnd(4_768, { renderSeq: 3 }),
      presentationCommit(4_768, {
        transactionSeq: 3,
        renderSeq: 3,
        firstDisplaySeq: 12,
        lastDisplaySeq: 12,
        firstPresentationId: 9,
        lastPresentationId: 9,
        firstApplyToCommitMs: 0.77,
        lastApplyToCommitMs: 0.77,
      }),
      frameComplete(4_769.4, { renderSeq: 3 }),
      {
        ...displayEvent('worker_display_applied', 4_783.9, 1, 13),
        presentationId: 10,
        presentationTransactionSeq: 4,
        presentationCoherent: true,
      },
      renderStart(4_784.5, { renderSeq: 4 }),
      renderEnd(4_785, { renderSeq: 4 }),
      presentationCommit(4_785, {
        transactionSeq: 4,
        renderSeq: 4,
        firstDisplaySeq: 13,
        lastDisplaySeq: 13,
        firstPresentationId: 10,
        lastPresentationId: 10,
        firstApplyToCommitMs: 1.1,
        lastApplyToCommitMs: 1.1,
      }),
      frameComplete(4_785.9, { renderSeq: 4 }),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 4_800,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const presentation = buildTerminalLatencyReport(events).presentation;
    // The real failure's 27.8/93.43/16.67ms apply gaps defeat any proximity
    // heuristic. Exact sender groups are also individually zero-exposure; the
    // explicit workload provenance must retain all four fence observations.
    expect(presentation.groupCount).toBe(4);
    expect(presentation.groupsWithMultipleCommits).toBe(0);
    expect(presentation.partialPresentationExposureMs.max).toBe(0);
    expect(presentation.measurementWindowCount).toBe(1);
    expect(presentation.measurementWindowsWithMultipleCommits).toBe(1);
    expect(presentation.commitsPerMeasurementWindow.p50).toBe(4);
    expect(presentation.rowsPerMeasurementWindow.p50).toBe(4);
    expect(presentation.refreshPeriodPerMeasurementWindowMs.p50).toBeCloseTo(1000 / 60, 8);
    expect(presentation.fenceObservationIntervalPerMeasurementWindowMs.p50).toBe(7);
    expect(presentation.measurementWindowExposureMs.p50).toBeCloseTo(128.9, 8);
    expect(presentation.measurementWindowExposureMs.complete).toBe(true);
  });

  test('exposes the current 244.785ms real-artifact sweep when bracketed by the harness', () => {
    const origin = 1_788_524_760_000;
    const events = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: origin + 8_100,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      {
        ...displayEvent('worker_display_applied', origin + 8_143.46, 1, 18),
        presentationId: 17,
        presentationTransactionSeq: 1,
        presentationCoherent: true,
        rowCount: 20,
      },
      renderStart(origin + 8_160),
      renderEnd(origin + 8_170),
      presentationCommit(origin + 8_170, {
        firstDisplaySeq: 18,
        lastDisplaySeq: 18,
        firstPresentationId: 17,
        lastPresentationId: 17,
        firstApplyToCommitMs: 26.54,
        lastApplyToCommitMs: 26.54,
        refreshPeriodMs: 8.36,
        rowCount: 20,
      }),
      frameComplete(origin + 8_173.615),
      {
        ...displayEvent('worker_display_applied', origin + 8_408.625, 1, 19),
        presentationId: 18,
        presentationTransactionSeq: 2,
        presentationCoherent: true,
        rowCount: 20,
      },
      renderStart(origin + 8_410, { renderSeq: 2 }),
      renderEnd(origin + 8_415, { renderSeq: 2 }),
      presentationCommit(origin + 8_415, {
        transactionSeq: 2,
        renderSeq: 2,
        firstDisplaySeq: 19,
        lastDisplaySeq: 19,
        firstPresentationId: 18,
        lastPresentationId: 18,
        firstApplyToCommitMs: 6.375,
        lastApplyToCommitMs: 6.375,
        refreshPeriodMs: 8.36,
        rowCount: 20,
      }),
      frameComplete(origin + 8_418.4, { renderSeq: 2 }),
      {
        kind: 'presentation_measurement_boundary',
        atMs: origin + 8_425,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
    ] satisfies TerminalPerfEvent[];

    const presentation = buildTerminalLatencyReport(events).presentation;
    expect(presentation.partialPresentationExposureMs.max).toBe(0);
    expect(presentation.commitsPerMeasurementWindow.p50).toBe(2);
    expect(presentation.rowsPerMeasurementWindow.p50).toBe(40);
    expect(presentation.measurementWindowExposureMs.p50).toBeCloseTo(244.785, 3);
    expect(presentation.measurementWindowExposureMs.complete).toBe(true);
  });

  test('fails a workload window closed when a reordered redraw arrives after its end marker', () => {
    const events = [
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
      inputQueued(105),
      {
        ...displayEvent('worker_display_applied', 110, 1, 10),
        presentationId: 7,
      },
      renderStart(112),
      renderEnd(114),
      presentationCommit(114, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        firstPresentationId: 7,
        lastPresentationId: 7,
      }),
      frameComplete(120),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 125,
        measurementId: 1,
        phase: 'end',
        purpose: 'streaming',
      },
      // The marker-row presentation above cannot close the logical workload:
      // this independent row was reordered behind it and appears before any
      // newer local input could start another response.
      {
        ...displayEvent('worker_display_applied', 160, 1, 11),
        presentationId: 8,
        presentationTransactionSeq: 2,
      },
      renderStart(162, { renderSeq: 2 }),
      renderEnd(164, { renderSeq: 2 }),
      presentationCommit(164, {
        transactionSeq: 2,
        renderSeq: 2,
        firstDisplaySeq: 11,
        lastDisplaySeq: 11,
        firstPresentationId: 8,
        lastPresentationId: 8,
      }),
      frameComplete(170, { renderSeq: 2 }),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.presentation.measurementWindowExposureMs.complete).toBe(false);
    expect(
      report.presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs.complete,
    ).toBe(false);
    expect(report.inputToCompletedAuthoritativePresentationFenceMs.complete).toBe(false);
  });

  test('marks presentation coherence incomplete when an applied member postdates its commit', () => {
    const events = [
      {
        ...displayEvent('worker_display_applied', 127, 1, 10),
        presentationId: 7,
        presentationCoherent: true,
      },
      renderStart(122),
      renderEnd(126),
      presentationCommit(126, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        firstApplyToCommitMs: 6,
        lastApplyToCommitMs: 6,
      }),
      frameComplete(130),
    ] satisfies TerminalPerfEvent[];

    const presentation = buildTerminalLatencyReport(events).presentation;
    expect(presentation.partialPresentationExposureMs.complete).toBe(false);
    expect(presentation.commitsPerPresentation.complete).toBe(false);
    expect(presentation.measurementWindowExposureMs.complete).toBe(false);
    expect(presentation.commitsPerMeasurementWindow.complete).toBe(false);
  });

  test('rejects render and fence observations that precede their presentation commit', () => {
    for (const [renderEndAtMs, frameCompleteAtMs] of [
      [125, 130],
      [126, 125],
    ] as const) {
      const events = [
        {
          kind: 'presentation_measurement_boundary',
          atMs: 100,
          measurementId: 1,
          phase: 'start',
          purpose: 'streaming',
        },
        {
          ...displayEvent('worker_display_applied', 120, 1, 10),
          presentationId: 7,
          presentationCoherent: true,
        },
        renderStart(122),
        renderEnd(renderEndAtMs),
        presentationCommit(126, {
          firstDisplaySeq: 10,
          lastDisplaySeq: 10,
          firstApplyToCommitMs: 6,
          lastApplyToCommitMs: 6,
        }),
        frameComplete(frameCompleteAtMs),
        {
          kind: 'presentation_measurement_boundary',
          atMs: 140,
          measurementId: 1,
          phase: 'end',
          purpose: 'streaming',
        },
      ] satisfies TerminalPerfEvent[];

      const presentation = buildTerminalLatencyReport(events).presentation;
      expect(presentation.partialPresentationExposureMs.complete).toBe(false);
      expect(presentation.measurementWindowExposureMs.complete).toBe(false);
    }
  });

  /**
   * A carrier swap answered with repairs opens a new session epoch on the same
   * grid. The measurement that brackets the swap is one window: the repair it
   * exists to measure lands after the boundary, and the boundary discarded
   * nothing. Only an epoch that threw the grid away starts a new lineage, and
   * only that cut may drop the window's start.
   */
  test('a preserved epoch boundary keeps a measurement window whole; a discarding one cuts it', () => {
    const bracketed = (preserved: boolean): TerminalPerfEvent[] => [
      { kind: 'session_start', atMs: 100 },
      { kind: 'presentation_epoch_boundary', atMs: 101, epoch: 1, preserved: false },
      {
        kind: 'presentation_measurement_boundary',
        atMs: 110,
        measurementId: 1,
        phase: 'start',
        purpose: 'coherent-redraw',
      },
      {
        kind: 'display_ring_measurement_boundary',
        atMs: 110,
        measurementId: 1,
        phase: 'start',
        observationEpoch: 1,
        sessionEpoch: 1,
        ringDroppedTotal: 0,
      },
      { kind: 'presentation_epoch_boundary', atMs: 120, epoch: 2, preserved },
      {
        ...displayEvent('worker_display_applied', 130, 1, 10),
        presentationId: 7,
        presentationCoherent: true,
        presentationEnd: true,
      },
      renderStart(131),
      renderEnd(132),
      presentationCommit(133, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        firstApplyToCommitMs: 3,
        lastApplyToCommitMs: 3,
        reason: 'repair-target-satisfied',
      }),
      frameComplete(134),
      {
        kind: 'presentation_measurement_boundary',
        atMs: 140,
        measurementId: 1,
        phase: 'end',
        purpose: 'coherent-redraw',
      },
      {
        kind: 'display_ring_measurement_boundary',
        atMs: 140,
        measurementId: 1,
        phase: 'end',
        observationEpoch: 1,
        sessionEpoch: 2,
        ringDroppedTotal: 0,
      },
    ];

    const preservedReport = buildTerminalLatencyReport(bracketed(true));
    const preserved = preservedReport.presentation;
    expect(preserved.epochBoundaryCount).toBe(2);
    expect(preserved.currentEpoch).toBe(2);
    expect(preserved.measurementWindowCount).toBe(1);
    // The ring boundaries carry different session epochs on the same lineage:
    // the pair still describes one window, so the refusal count is exact.
    expect(preservedReport.displayPipeline.ringRefusedFrameCountPerMeasurementWindow.complete).toBe(
      true,
    );
    expect(preservedReport.displayPipeline.ringRefusedFrameCount).toBe(0);

    const wrapped = bracketed(true).map((event): TerminalPerfEvent => {
      if (event.kind === 'presentation_epoch_boundary') {
        return { ...event, epoch: event.epoch === 1 ? 0xffff_ffff : 1 };
      }
      if (event.kind === 'display_ring_measurement_boundary') {
        return { ...event, sessionEpoch: event.sessionEpoch === 1 ? 0xffff_ffff : 1 };
      }
      return event;
    });
    const wrappedReport = buildTerminalLatencyReport(wrapped);
    expect(wrappedReport.presentation.currentEpoch).toBe(1);
    expect(wrappedReport.presentation.measurementWindowCount).toBe(1);
    expect(wrappedReport.displayPipeline.ringRefusedFrameCountPerMeasurementWindow.complete).toBe(
      true,
    );

    const discarded = buildTerminalLatencyReport(bracketed(false)).presentation;
    expect(discarded.currentEpoch).toBe(2);
    expect(discarded.measurementWindowCount).toBe(0);

    // Epoch 2 may have discarded the grid. Seeing a preserved epoch 3 cannot
    // establish continuity with epoch 1 when that intervening event is lost.
    const missingBoundary = bracketed(true).map((event): TerminalPerfEvent => {
      if (event.kind === 'presentation_epoch_boundary' && event.epoch === 2) {
        return { ...event, epoch: 3 };
      }
      if (event.kind === 'display_ring_measurement_boundary' && event.sessionEpoch === 2) {
        return { ...event, sessionEpoch: 3 };
      }
      return event;
    });
    const incomplete = buildTerminalLatencyReport(missingBoundary);
    expect(incomplete.presentation.measurementWindowCount).toBe(0);
    expect(incomplete.displayPipeline.ringRefusedFrameCountPerMeasurementWindow.complete).toBe(
      false,
    );

    // The predecessor's own boundary predates the retained trace, which is the
    // ordinary shape after a profiling reset rather than an edge case: the
    // measurement starts in an epoch whose boundary was never recorded. A
    // preserved successor still certifies continuity with it, because that is
    // exactly what the terminal worker asserted when it kept the grid.
    const openingBoundaryLost = (preserved: boolean): TerminalPerfEvent[] =>
      bracketed(preserved).filter(
        (event) => !(event.kind === 'presentation_epoch_boundary' && event.epoch === 1),
      );
    const resumedMidLineage = buildTerminalLatencyReport(openingBoundaryLost(true));
    expect(resumedMidLineage.presentation.measurementWindowCount).toBe(1);
    expect(
      resumedMidLineage.displayPipeline.ringRefusedFrameCountPerMeasurementWindow.complete,
    ).toBe(true);
    expect(
      buildTerminalLatencyReport(openingBoundaryLost(false)).presentation.measurementWindowCount,
    ).toBe(0);
  });

  test('marks an unfinished presentation measurement window incomplete', () => {
    const report = buildTerminalLatencyReport([
      {
        kind: 'presentation_measurement_boundary',
        atMs: 100,
        measurementId: 1,
        phase: 'start',
        purpose: 'streaming',
      },
    ]);

    expect(report.presentation.measurementWindowCount).toBe(0);
    expect(report.presentation.measurementWindowExposureMs.complete).toBe(false);
    expect(report.presentation.commitsPerMeasurementWindow.complete).toBe(false);
  });

  test('rejects the zero presentation-ID sentinel from current display telemetry', () => {
    const events = [
      {
        ...displayEvent('worker_display_applied', 120, 1, 10),
        presentationId: 0,
        presentationCoherent: true,
      },
      renderStart(122),
      renderEnd(126),
      presentationCommit(126, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        firstPresentationId: 0,
        lastPresentationId: 0,
        firstApplyToCommitMs: 6,
        lastApplyToCommitMs: 6,
      }),
      frameComplete(130),
    ] satisfies TerminalPerfEvent[];

    const presentation = buildTerminalLatencyReport(events).presentation;
    expect(presentation.commitCount).toBe(0);
    expect(presentation.partialPresentationExposureMs.complete).toBe(false);
    expect(presentation.measurementWindowExposureMs.complete).toBe(false);
  });

  test('marks coherence distributions incomplete when one applied member is missing', () => {
    const events = [
      {
        ...displayEvent('worker_display_applied', 120, 1, 10),
        presentationId: 7,
        presentationCoherent: true,
      },
      renderStart(122),
      renderEnd(126),
      presentationCommit(126, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 11,
        firstPresentationId: 7,
        lastPresentationId: 8,
        firstApplyToCommitMs: 6,
        lastApplyToCommitMs: 5,
        datagramCount: 2,
      }),
      frameComplete(130),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.presentation.partialPresentationExposureMs.complete).toBe(false);
    expect(report.presentation.commitsPerPresentation.complete).toBe(false);
  });

  test('marks coherence distributions incomplete when an applied transaction has no commit', () => {
    const events = [
      {
        ...displayEvent('worker_display_applied', 120, 1, 10),
        presentationId: 7,
        presentationCoherent: true,
      },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.presentation.partialPresentationExposureMs.complete).toBe(false);
    expect(report.presentation.commitsPerPresentation.complete).toBe(false);
  });

  test('marks coherence distributions incomplete when the GPU fence is missing', () => {
    const events = [
      {
        ...displayEvent('worker_display_applied', 120, 1, 10),
        presentationId: 7,
        presentationCoherent: true,
      },
      renderStart(122),
      renderEnd(126),
      presentationCommit(126, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        firstApplyToCommitMs: 6,
        lastApplyToCommitMs: 6,
      }),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.presentation.partialPresentationExposureMs.complete).toBe(false);
    expect(report.presentation.commitsPerPresentation.complete).toBe(false);
  });

  test('keeps presentation durations sane across mixed realm time origins', () => {
    const workerTimeOriginMs = 1_788_000_000_000;
    const events = [
      {
        ...displayEvent('worker_display_applied', workerTimeOriginMs + 905, 1, 10),
        presentationId: 7,
        presentationCoherent: true,
      },
      renderStart(workerTimeOriginMs + 918),
      renderEnd(workerTimeOriginMs + 920),
      presentationCommit(workerTimeOriginMs + 920, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        firstApplyToCommitMs: 15,
        lastApplyToCommitMs: 15,
        deadlineOverrunMs: 2,
      }),
      frameComplete(workerTimeOriginMs + 925),
    ] satisfies TerminalPerfEvent[];

    const presentation = buildTerminalLatencyReport(events).presentation;
    expect(presentation.firstApplyToCommitMs.complete).toBe(true);
    expect(presentation.firstApplyToCommitMs.p50).toBe(15);
    expect(presentation.lastApplyToCommitMs.p50).toBe(15);
    expect(presentation.deadlineOverrunMs.p50).toBe(2);
    expect(presentation.firstApplyToCommitMs.max).toBeLessThan(100);
  });

  test('rejects a cross-realm clock value masquerading as a duration', () => {
    const events = [
      {
        ...displayEvent('worker_display_applied', 120, 1, 10),
        presentationId: 7,
        presentationCoherent: true,
      },
      renderStart(122),
      renderEnd(126),
      presentationCommit(126, {
        firstDisplaySeq: 10,
        lastDisplaySeq: 10,
        firstApplyToCommitMs: 1_788_000_000_015,
        lastApplyToCommitMs: 1_788_000_000_015,
      }),
      frameComplete(130),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.presentation.commitCount).toBe(0);
    expect(report.presentation.firstApplyToCommitMs.complete).toBe(false);
    expect(report.presentation.partialPresentationExposureMs.complete).toBe(false);
    expect(report.presentation.commitsPerPresentation.complete).toBe(false);
  });

  test('one coalesced prediction completion covers every undisplayed input', () => {
    const events = [
      inputQueued(100, 1),
      inputQueued(102, 2),
      { kind: 'prediction_applied', atMs: 101, inputSeq: 1 },
      { kind: 'prediction_applied', atMs: 103, inputSeq: 2 },
      {
        ...frameComplete(110),
        displayInputSeq: 0,
        predictionInputSeq: 2,
        visiblePredictionInputSeqs: [1, 2],
      },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.samples[0]?.inputToPredictionPaintMs).toBe(10);
    expect(report.samples[1]?.inputToPredictionPaintMs).toBe(8);
    expect(report.inputToPredictionPaintMs.count).toBe(2);
  });

  test('retains both A+B command-readiness tails but credits only latest-submitted prediction effects', () => {
    const a = {
      renderSeq: 11,
      displayInputSeq: 1,
      predictionInputSeq: 3,
      visiblePredictionInputSeqs: [3],
      queuedDisplayFrames: 7,
    };
    const b = {
      renderSeq: 12,
      displayInputSeq: 2,
      predictionInputSeq: 4,
      visiblePredictionInputSeqs: [4],
      queuedDisplayFrames: 9,
    };
    const events: TerminalPerfEvent[] = [
      inputQueued(80, 1),
      inputQueued(85, 2),
      inputQueued(100, 3),
      inputQueued(101, 4),
      displayEvent('worker_display_applied', 90, 1, 1),
      { kind: 'prediction_applied', atMs: 102, inputSeq: 3 },
      { kind: 'prediction_applied', atMs: 103, inputSeq: 4 },
      renderStart(104, a),
      renderEnd(105, a),
      displayEvent('worker_display_applied', 106, 2, 2),
      renderStart(107, b),
      renderEnd(108, b),
      frameComplete(110, { ...a, completionDisposition: 'superseded' }),
      frameComplete(120, { ...b, completionDisposition: 'latest-submitted' }),
    ];
    const report = buildTerminalLatencyReport(events);
    expect(report.renderInstrumentation).toMatchObject({
      joinedFenceRenderCount: 2,
      latestSubmittedFrameCount: 1,
      supersededFrameCount: 1,
    });
    expect(report.inputToDisplayPaintMs).toMatchObject({ count: 2, p50: 30, p95: 35, max: 35 });
    expect(buildTerminalLatencyRawMetricSamples(events).renderEndToDisplayPaintMs).toEqual([5, 12]);
    expect(report.samples.map((sample) => sample.inputToPredictionPaintMs)).toEqual([
      null,
      null,
      null,
      19,
    ]);
    expect(report.inputToPredictionPaintMs).toMatchObject({
      count: 1,
      eligibleCount: 2,
      coverageRatio: 0.5,
      complete: true,
    });

    // Never hide a paired mismatch by zeroing the old frame's membership or
    // dropping its authoritative readiness from the report.
    for (const mismatch of [
      { displayInputSeq: 0 },
      { predictionInputSeq: 0 },
      { queuedDisplayFrames: 0 },
      { visiblePredictionInputSeqs: [] },
      { visiblePredictionInputSeqsTruncated: true },
    ]) {
      const changed = events.map((event) =>
        event.kind === 'render_end' && event.renderSeq === 11 ? { ...event, ...mismatch } : event,
      );
      const invalid = buildTerminalLatencyReport(changed);
      expect(invalid.inputToDisplayPaintMs.count).toBe(2);
      expect(invalid.renderInstrumentation.supersededFrameCount).toBe(1);
      expect(invalid.inputToPredictionPaintMs.complete).toBe(false);
      expect(invalid.renderEndToDisplayPaintMs.complete).toBe(false);
    }
  });

  test('rejects missing or malformed completion dispositions without relabeling them', () => {
    for (const completionDisposition of [undefined, null, '', 'newer']) {
      const invalid = Object.assign(frameComplete(110), { completionDisposition });
      const report = buildTerminalLatencyReport([inputQueued(100), invalid]);
      expect(report.inputToDisplayPaintMs).toMatchObject({ count: 0, complete: false });
      expect(report.renderInstrumentation.latestSubmittedFrameCount).toBe(0);
      expect(report.renderInstrumentation.supersededFrameCount).toBe(0);
    }
  });

  test('invalidated latest work remains readiness evidence without prediction visibility', () => {
    const membership = {
      renderSeq: 31,
      displayInputSeq: 1,
      predictionInputSeq: 2,
      visiblePredictionInputSeqs: [2],
    };
    const report = buildTerminalLatencyReport([
      inputQueued(90, 1),
      inputQueued(100, 2),
      { kind: 'prediction_applied', atMs: 101, inputSeq: 2 },
      renderStart(102, membership),
      renderEnd(103, membership),
      frameComplete(120, { ...membership, completionDisposition: 'invalidated' }),
    ]);
    expect(report.inputToDisplayPaintMs).toMatchObject({ count: 1, p99: 30 });
    expect(report.inputToPredictionPaintMs).toMatchObject({
      count: 0,
      eligibleCount: 1,
      coverageRatio: 0,
    });
    expect(report.renderInstrumentation).toMatchObject({
      joinedFenceRenderCount: 1,
      latestSubmittedFrameCount: 0,
      supersededFrameCount: 0,
      invalidatedFrameCount: 1,
    });
  });

  test('fence gate attribution joins the exact completed owner, not the nearest timestamp', () => {
    for (const owner of [99, 98, 0, DEFAULT_RENDER_SEQ]) {
      const report = buildTerminalLatencyReport([
        inputQueued(90),
        displayEvent('worker_display_applied', 100, 1, 1),
        renderStart(101, { renderSeq: 99, displayInputSeq: 0 }),
        renderEnd(102, { renderSeq: 99, displayInputSeq: 0 }),
        frameComplete(118, {
          renderSeq: 99,
          displayInputSeq: 0,
          completionDisposition: 'superseded',
        }),
        renderStart(120, {
          wantedAtMs: 100,
          gate: 'fence',
          fenceReleasedAtMs: 118,
          fenceWaitMs: 18,
          fenceReleasedRenderSeq: owner,
        }),
        renderEnd(124),
        frameComplete(130),
      ]);
      expect(report.inputToDisplayPaintMs.count).toBe(1);
      expect(report.samples[0]?.renderFenceGateMs).toBe(owner === 99 ? 18 : null);
      expect(report.renderEndToDisplayPaintMs.complete).toBe(owner === 99);
    }
  });

  test('prediction completion excludes inputs already covered by authoritative display', () => {
    const events = [
      inputQueued(100, 1),
      inputQueued(102, 2),
      { kind: 'prediction_applied', atMs: 101, inputSeq: 1 },
      { kind: 'prediction_applied', atMs: 103, inputSeq: 2 },
      {
        ...frameComplete(110),
        displayInputSeq: 1,
        predictionInputSeq: 2,
        visiblePredictionInputSeqs: [1, 2],
      },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.samples[0]?.inputToPredictionPaintMs).toBeNull();
    expect(report.samples[1]?.inputToPredictionPaintMs).toBe(8);
  });

  test('rejects regressing render authority instead of fabricating a late prediction paint', () => {
    const events = [
      inputQueued(100, 1),
      { kind: 'prediction_applied', atMs: 101, inputSeq: 1 },
      {
        ...frameComplete(105),
        displayInputSeq: 1,
      },
      {
        ...frameComplete(335),
        displayInputSeq: 0,
        predictionInputSeq: 1,
        visiblePredictionInputSeqs: [1],
      },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.samples[0]?.inputToPredictionPaintMs).toBeNull();
    expect(report.inputToPredictionPaintMs.count).toBe(0);
    expect(report.inputToPredictionPaintMs.complete).toBe(false);
  });

  test('exact prediction provenance does not fill control or paste sequence gaps', () => {
    const events = [
      inputQueued(100, 1),
      inputQueued(101, 2),
      inputQueued(102, 3),
      { kind: 'prediction_applied', atMs: 103, inputSeq: 1 },
      { kind: 'prediction_applied', atMs: 104, inputSeq: 3 },
      {
        ...frameComplete(110),
        displayInputSeq: 0,
        predictionInputSeq: 3,
        visiblePredictionInputSeqs: [1, 3],
      },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.samples.map((sample) => sample.inputToPredictionPaintMs)).toEqual([10, null, 8]);
    expect(report.inputToPredictionPaintMs.count).toBe(2);
    expect(report.inputToPredictionPaintMs.eligibleCount).toBe(2);
    expect(report.inputToPredictionPaintMs.coverageRatio).toBe(1);
  });

  test('does not credit gate-off, expiry, mismatch, or flush clearing frames', () => {
    const clearingCauses = ['gate-off', 'expiry', 'mismatch', 'flush'] as const;
    for (const _cause of clearingCauses) {
      const events = [
        inputQueued(100, 1),
        { kind: 'prediction_applied', atMs: 101, inputSeq: 1 },
        {
          ...frameComplete(110),
          // A stale high-water used to turn any prediction-dirty clearing
          // render into a fabricated visible prediction.
          predictionInputSeq: 0,
          visiblePredictionInputSeqs: [],
        },
      ] satisfies TerminalPerfEvent[];

      const report = buildTerminalLatencyReport(events);
      expect(report.samples[0]?.inputToPredictionPaintMs).toBeNull();
      expect(report.inputToPredictionPaintMs.complete).toBe(true);
      expect(report.inputToPredictionPaintMs.coverageRatio).toBe(0);
    }
  });

  test('credits an accepted visible backspace clear by its exact input sequence', () => {
    const events = [
      inputQueued(100, 9),
      { kind: 'prediction_applied', atMs: 101, inputSeq: 9 },
      {
        ...frameComplete(108),
        displayInputSeq: 8,
        predictionInputSeq: 9,
        visiblePredictionInputSeqs: [9],
      },
    ] satisfies TerminalPerfEvent[];

    expect(buildTerminalLatencyReport(events).samples[0]?.inputToPredictionPaintMs).toBe(8);
  });

  test('requires the exact input to have been accepted by the prediction model', () => {
    const events = [
      inputQueued(100, 1),
      {
        ...frameComplete(110),
        displayInputSeq: 0,
        predictionInputSeq: 1,
        visiblePredictionInputSeqs: [1],
      },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.samples[0]?.inputToPredictionPaintMs).toBeNull();
    expect(report.inputToPredictionPaintMs.eligibleCount).toBe(0);
  });

  test('marks bounded prediction telemetry unavailable after an exact-set truncation', () => {
    const events = [
      inputQueued(100, 1),
      { kind: 'prediction_applied', atMs: 101, inputSeq: 1 },
      {
        ...frameComplete(110),
        displayInputSeq: 0,
        predictionInputSeq: 0,
        visiblePredictionInputSeqs: [],
        visiblePredictionInputSeqsTruncated: true,
      },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    expect(report.samples[0]?.inputToPredictionPaintMs).toBeNull();
    expect(report.inputToPredictionPaintMs.complete).toBe(false);
    expect(report.inputToPredictionPaintMs.count).toBe(0);
    expect(report.inputToPredictionPaintMs.coverageRatio).toBeNull();
  });

  test('scopes reused input sequences to the latest authenticated session', () => {
    const events = [
      { kind: 'session_start', atMs: 90 },
      inputQueued(100, 1),
      { kind: 'input_ack', atMs: 120, inputSeq: 1, networkRttMs: null },
      { kind: 'session_start', atMs: 200 },
      inputQueued(210, 1),
      { kind: 'input_ack', atMs: 235, inputSeq: 1, networkRttMs: null },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);

    expect(report.sampleCount).toBe(1);
    expect(report.samples[0]?.inputAckMs).toBe(25);
    expect(report.inputAckMs.complete).toBe(true);
  });

  test('a malformed session boundary cannot produce a complete metric', () => {
    const events = [
      { kind: 'session_start', atMs: Number.NaN },
      inputQueued(100, 1),
      { kind: 'input_ack', atMs: 120, inputSeq: 1, networkRttMs: null },
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);

    expect(report.samples[0]?.inputAckMs).toBe(20);
    expect(report.inputAckMs.complete).toBe(false);
  });
});

describe('apply-to-paint decomposition', () => {
  /** apply at 100, submit at 104, submitted at 110, fence observed at 126. */
  function decomposed(): TerminalPerfEvent[] {
    return [
      inputQueued(90),
      displayEvent('worker_display_applied', 100, 1, 1),
      renderStart(104, { wantedAtMs: 100 }),
      renderEnd(110),
      frameComplete(126),
    ];
  }

  test('the three sub-stages partition the whole stage exactly', () => {
    const sample = buildTerminalLatencyReport(decomposed()).samples[0];

    expect(sample?.displayApplyToPaintMs).toBe(26);
    expect(sample?.displayApplyToRenderStartMs).toBe(4);
    expect(sample?.renderStartToRenderEndMs).toBe(6);
    expect(sample?.renderEndToDisplayPaintMs).toBe(16);
    // The identity that makes the decomposition trustworthy at all.
    expect(
      (sample?.displayApplyToRenderStartMs ?? 0) +
        (sample?.renderStartToRenderEndMs ?? 0) +
        (sample?.renderEndToDisplayPaintMs ?? 0),
    ).toBe(sample?.displayApplyToPaintMs ?? -1);
  });

  // The design mistake this guards: `render_start` is emitted for every render
  // while `frame_complete` is emitted only for fenced ones, so a nearest-in-time
  // join can attribute another render's submit cost to this frame and produce
  // sub-terms that quietly stop summing to the whole.
  test('joins by render identity rather than by timestamp proximity', () => {
    const events = [
      inputQueued(90),
      displayEvent('worker_display_applied', 100, 1, 1),
      renderStart(104, { wantedAtMs: 100 }),
      // A second, unrelated render interleaves between the matched pair. It is
      // nearer in time to the completion than the real start is.
      renderStart(108, { renderSeq: 99, displayInputSeq: 0 }),
      renderEnd(110),
      frameComplete(126),
    ] satisfies TerminalPerfEvent[];

    const sample = buildTerminalLatencyReport(events).samples[0];

    // 104, not 108: the interloper must not be adopted.
    expect(sample?.displayApplyToRenderStartMs).toBe(4);
    expect(sample?.renderStartToRenderEndMs).toBe(6);
  });

  test('a frame missing its render half yields null sub-stages but keeps the whole', () => {
    for (const missing of ['start', 'end'] as const) {
      const events = [
        inputQueued(90),
        displayEvent('worker_display_applied', 100, 1, 1),
        ...(missing === 'start' ? [] : [renderStart(104)]),
        ...(missing === 'end' ? [] : [renderEnd(110)]),
        frameComplete(126),
      ] satisfies TerminalPerfEvent[];

      const report = buildTerminalLatencyReport(events);

      // The pre-existing metric must survive a gap in the new instrumentation.
      expect(report.samples[0]?.displayApplyToPaintMs, missing).toBe(26);
      expect(report.samples[0]?.displayApplyToRenderStartMs, missing).toBeNull();
      expect(report.samples[0]?.renderStartToRenderEndMs, missing).toBeNull();
      expect(report.samples[0]?.renderEndToDisplayPaintMs, missing).toBeNull();
      expect(report.displayApplyToPaintMs.complete, missing).toBe(true);
      expect(report.displayApplyToRenderStartMs.complete, missing).toBe(false);
      const instrumentation = report.renderInstrumentation;
      expect(
        missing === 'start'
          ? instrumentation.missingRenderStartCount
          : instrumentation.missingRenderEndCount,
        missing,
      ).toBe(1);
      expect(instrumentation.joinedFenceRenderCount, missing).toBe(0);
    }
  });

  test('absent completion evidence never reaches a GPU completion percentile', () => {
    const events = [
      inputQueued(90),
      displayEvent('worker_display_applied', 100, 1, 1),
      renderStart(104),
      renderEnd(110, { completionMode: 'none' }),
      frameComplete(126),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);

    // There is no fence in this mode, so a "completion" is a scheduler task
    // boundary. Every sub-term is withheld rather than averaged in.
    expect(report.samples[0]?.renderEndToDisplayPaintMs).toBeNull();
    expect(report.samples[0]?.renderStartToRenderEndMs).toBeNull();
    expect(report.renderEndToDisplayPaintMs.count).toBe(0);
    expect(report.renderInstrumentation.noFenceRenderCount).toBe(1);
    expect(report.renderInstrumentation.gpuQueueRenderCount).toBe(0);
    // Excluding a mode is a correct measurement, not a broken one.
    expect(report.renderEndToDisplayPaintMs.complete).toBe(true);
  });

  test('a fence-less render is counted and excluded', () => {
    const events = [
      inputQueued(90),
      displayEvent('worker_display_applied', 100, 1, 1),
      renderStart(104),
      renderEnd(110, { completionMode: 'none' }),
      frameComplete(126),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);

    expect(report.samples[0]?.renderEndToDisplayPaintMs).toBeNull();
    expect(report.renderInstrumentation.noFenceRenderCount).toBe(1);
  });

  test('a queue completion leaves the whole post-submit observation interval', () => {
    const sample = buildTerminalLatencyReport(decomposed()).samples[0];

    // A callback provides no intermediate poll evidence: physical completion
    // could have occurred at any point after submission.
    expect(sample?.renderEndToLastUnreadyPollMs).toBe(0);
    expect(sample?.fenceObservationIntervalMs).toBe(sample?.renderEndToDisplayPaintMs);
  });

  test('retired polling evidence cannot narrow a WebGPU completion interval', () => {
    const events = [
      inputQueued(90),
      displayEvent('worker_display_applied', 100, 1, 1),
      renderStart(104),
      renderEnd(110),
      frameComplete(126, { pollCount: 3, previousPollAtMs: 122 }),
    ] satisfies TerminalPerfEvent[];

    const sample = buildTerminalLatencyReport(events).samples[0];

    expect(sample?.renderEndToLastUnreadyPollMs).toBeNull();
    expect(sample?.fenceObservationIntervalMs).toBeNull();
  });

  test('retired polling evidence predating submission is rejected, not clamped', () => {
    const events = [
      inputQueued(90),
      displayEvent('worker_display_applied', 100, 1, 1),
      renderStart(104),
      renderEnd(110),
      // Stale from the previous frame; the fence still cannot precede its own submit.
      frameComplete(126, { pollCount: 2, previousPollAtMs: 105 }),
    ] satisfies TerminalPerfEvent[];

    const sample = buildTerminalLatencyReport(events).samples[0];

    expect(sample?.renderEndToLastUnreadyPollMs).toBeNull();
    expect(sample?.fenceObservationIntervalMs).toBeNull();
  });

  test('a poll postdating its own completion is rejected as corrupt', () => {
    const events = [
      inputQueued(90),
      displayEvent('worker_display_applied', 100, 1, 1),
      renderStart(104),
      renderEnd(110),
      frameComplete(126, { pollCount: 2, previousPollAtMs: 130 }),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);

    expect(report.samples[0]?.renderEndToLastUnreadyPollMs).toBeNull();
    expect(report.samples[0]?.fenceObservationIntervalMs).toBeNull();
    expect(report.renderEndToLastUnreadyPollMs.complete).toBe(false);
  });

  test('attributes each gate from the action the mailbox returned', () => {
    const gated = (
      overrides: Partial<Extract<TerminalPerfEvent, { readonly kind: 'render_start' }>>,
    ) =>
      buildTerminalLatencyReport([
        inputQueued(90),
        displayEvent('worker_display_applied', 100, 1, 1),
        ...(overrides.fenceReleasedAtMs === undefined
          ? []
          : [
              renderStart(101, { renderSeq: 99, displayInputSeq: 0 }),
              renderEnd(102, { renderSeq: 99, displayInputSeq: 0 }),
              frameComplete(overrides.fenceReleasedAtMs, { renderSeq: 99, displayInputSeq: 0 }),
            ]),
        renderStart(120, { wantedAtMs: 100, ...overrides }),
        renderEnd(124),
        frameComplete(130),
      ]);

    const immediate = gated({ wantedAtMs: 120 });
    expect(immediate.renderGate.immediateCount).toBe(1);
    expect(immediate.samples[0]?.renderFenceGateMs).toBeNull();
    expect(immediate.samples[0]?.renderOpportunityGateMs).toBeNull();

    const fence = gated({
      gate: 'fence',
      fenceReleasedAtMs: 118,
      fenceReleasedRenderSeq: 99,
      fenceWaitMs: 18,
    });
    expect(fence.renderGate.fenceCount).toBe(1);
    expect(fence.samples[0]?.renderFenceGateMs).toBe(18);
    expect(fence.samples[0]?.renderOpportunityGateMs).toBeNull();

    const opportunity = gated({
      gate: 'opportunity',
      opportunityEnteredAtMs: 104,
      opportunityDelayMs: 16,
      fenceWaitMs: 0,
      opportunityWaitMs: 16,
    });
    expect(opportunity.renderGate.opportunityCount).toBe(1);
    expect(opportunity.samples[0]?.renderOpportunityGateMs).toBe(16);
    expect(opportunity.samples[0]?.renderFenceGateMs).toBeNull();
    expect(opportunity.renderGate.opportunityDelayRequestedMs.p50).toBe(16);

    const both = gated({
      gate: 'fence-and-opportunity',
      fenceReleasedAtMs: 104,
      fenceReleasedRenderSeq: 99,
      opportunityEnteredAtMs: 104,
      opportunityDelayMs: 16,
      fenceWaitMs: 4,
      opportunityWaitMs: 16,
    });
    expect(both.renderGate.fenceAndOpportunityCount).toBe(1);
    // Disjoint in this sequence: the opportunity is entered by the action returned
    // FROM the fence release, so the two waits cannot overlap.
    const fenceWait = both.samples[0]?.renderFenceGateMs ?? 0;
    const opportunityWait = both.samples[0]?.renderOpportunityGateMs ?? 0;
    expect(fenceWait + opportunityWait).toBeLessThanOrEqual(
      both.samples[0]?.displayApplyToRenderStartMs ?? 0,
    );
    // Opportunity can precede capacity and recur after it. Descriptive first
    // entry/release timestamps overlap; only active-interval sums partition it.
    for (const [fenceWaitMs, opportunityWaitMs] of [
      [5, 10],
      [8, 11],
    ]) {
      const alternating = gated({
        gate: 'fence-and-opportunity',
        fenceReleasedAtMs: 116,
        fenceReleasedRenderSeq: 99,
        opportunityEnteredAtMs: 101,
        opportunityDelayMs: 8,
        fenceWaitMs,
        opportunityWaitMs,
      });
      expect(alternating.samples[0]?.renderFenceGateMs).toBe(fenceWaitMs);
      expect(alternating.samples[0]?.renderOpportunityGateMs).toBe(opportunityWaitMs);
    }
    const overlapping = gated({
      gate: 'fence-and-opportunity',
      fenceReleasedAtMs: 116,
      fenceReleasedRenderSeq: 99,
      opportunityEnteredAtMs: 101,
      opportunityDelayMs: 8,
      fenceWaitMs: 16,
      opportunityWaitMs: 19,
    });
    expect(overlapping.renderGate.fenceAndOpportunityCount).toBe(0);
  });

  test('reports low confidence without claiming the opportunity used a fallback period', () => {
    const withConfidence = (refreshConfidence01: number) =>
      buildTerminalLatencyReport([
        inputQueued(90),
        displayEvent('worker_display_applied', 100, 1, 1),
        renderStart(120, {
          wantedAtMs: 100,
          gate: 'opportunity',
          opportunityEnteredAtMs: 104,
          opportunityDelayMs: 16,
          fenceWaitMs: 0,
          opportunityWaitMs: 0,
          refreshConfidence01,
        }),
        renderEnd(124),
        frameComplete(130),
      ]).renderGate.opportunityLowConfidenceRatio;

    // Confidence is independent of the conservative observed presentation bound.
    expect(withConfidence(0.2)).toBe(1);
    expect(withConfidence(0.9)).toBe(0);
  });

  test('never joins a render identity across a session boundary', () => {
    const events = [
      // Pre-boundary render under the same identity the new session reuses.
      renderStart(10),
      renderEnd(12),
      { kind: 'session_start', atMs: 50 },
      inputQueued(90),
      displayEvent('worker_display_applied', 100, 1, 1),
      renderStart(104),
      renderEnd(110),
      frameComplete(126),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);

    expect(report.sampleCount).toBe(1);
    // 104/110, not the discarded 10/12 pair.
    expect(report.samples[0]?.displayApplyToRenderStartMs).toBe(4);
    expect(report.samples[0]?.renderStartToRenderEndMs).toBe(6);
    expect(report.displayApplyToRenderStartMs.complete).toBe(true);
  });

  test('a duplicate completion under one identity poisons only the sub-terms', () => {
    const events = [
      inputQueued(90),
      displayEvent('worker_display_applied', 100, 1, 1),
      renderStart(104),
      renderEnd(110),
      frameComplete(126),
      // An out-of-band repaint replaced the fence while these sequences were
      // still in flight. Which render the timestamps belong to is unknowable.
      frameComplete(140),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);

    expect(report.renderInstrumentation.duplicateRenderSeqFrameCount).toBe(1);
    expect(report.samples[0]?.renderStartToRenderEndMs).toBeNull();
    expect(report.samples[0]?.displayApplyToPaintMs).toBe(26);
  });

  test('drops malformed render events without poisoning healthy stages', () => {
    const events = [
      inputQueued(90),
      displayEvent('worker_display_applied', 100, 1, 1),
      renderStart(104, { refreshPeriodMs: Number.NaN }),
      renderEnd(110),
      frameComplete(126, { pollCount: -1 }),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);

    expect(report.inputToDisplayApplyMs.p50).toBe(10);
    expect(report.inputToDisplayApplyMs.complete).toBe(true);
    expect(report.displayApplyToRenderStartMs.complete).toBe(false);
  });

  test('separates steady-state submit cost from atlas and drain frames', () => {
    const events = [
      inputQueued(90),
      displayEvent('worker_display_applied', 100, 1, 1),
      renderStart(104),
      renderEnd(110),
      frameComplete(126),
      renderStart(200, { renderSeq: 2 }),
      renderEnd(240, { renderSeq: 2, atlasUploaded: true }),
      renderStart(300, { renderSeq: 3 }),
      renderEnd(360, { renderSeq: 3, drainedDisplay: true }),
    ] satisfies TerminalPerfEvent[];

    const report = buildTerminalLatencyReport(events);
    const instrumentation = report.renderInstrumentation;

    expect(instrumentation.atlasUploadRenderCount).toBe(1);
    expect(instrumentation.drainedDisplayRenderCount).toBe(1);
    // Only the 6ms frame is steady state; growing the atlas and coalescing a
    // backlog both make a frame's CPU cost unrepresentative.
    expect(instrumentation.renderStartToRenderEndSteadyMs.count).toBe(1);
    expect(instrumentation.renderStartToRenderEndSteadyMs.p50).toBe(6);
  });
});

describe('buildTerminalStartupReport', () => {
  test('transport and authoritative apply may precede presentation', () => {
    const report = buildTerminalStartupReport([
      startupMilestone('device_selected', 0),
      startupMilestone('terminal_mount_requested', 2),
      startupMilestone('transport_start', 3),
      startupMilestone('worker_ready', 5),
      startupMilestone('transport_connected', 6),
      startupMilestone('first_display_applied', 8),
      startupMilestone('terminal_view_presented', 16),
      startupMilestone('first_display_visible', 16),
    ]);
    expect(report.complete).toBe(true);
    expect(report.completedCount).toBe(1);
  });

  test('a GPU result under an unpresented terminal is not yet visible', () => {
    const report = buildTerminalStartupReport([
      startupMilestone('device_selected', 0),
      startupMilestone('terminal_mount_requested', 2),
      startupMilestone('transport_start', 3),
      startupMilestone('worker_ready', 5),
      startupMilestone('transport_connected', 6),
      startupMilestone('first_display_applied', 8),
      startupMilestone('first_display_visible', 10),
      startupMilestone('terminal_view_presented', 16),
    ]);
    expect(report.complete).toBe(false);
    expect(report.completedCount).toBe(0);
  });

  test('separates CPU apply from the first authoritative GPU fence', () => {
    const milestones = [
      ['device_selected', 0],
      ['terminal_mount_requested', 6],
      ['terminal_view_presented', 20],
      ['worker_ready', 24],
      ['transport_start', 22],
      ['transport_connected', 30],
      ['first_display_applied', 36],
      ['first_display_visible', 43],
    ] as const;
    const report = buildTerminalStartupReport(
      milestones.map(
        ([milestone, elapsedMs]) =>
          ({
            kind: 'startup_milestone',
            atMs: 1_000 + elapsedMs,
            attemptId: 7,
            deviceId: 'device-a',
            milestone,
            elapsedMs,
            traceId: '0af7651916cd43dd8448eb211c80319c',
            spanId: 'b7ad6b7169203331',
          }) satisfies TerminalPerfEvent,
      ),
    );

    expect(report.complete).toBe(true);
    expect(report.completedCount).toBe(1);
    expect(report.attempts[0]?.clickToFirstDisplayVisibleMs).toBe(43);
    expect(report.attempts[0]?.displayApplyToVisibleMs).toBe(7);
  });

  test('does not call an applied-only or causally inverted trace complete', () => {
    const report = buildTerminalStartupReport([
      startupMilestone('device_selected', 0),
      startupMilestone('first_display_applied', 20),
      startupMilestone('first_display_visible', 19),
    ]);

    expect(report.complete).toBe(false);
    expect(report.attempts[0]?.complete).toBe(false);
  });
});

describe('createTerminalPerfRecorder', () => {
  test('reset advances the daemon observation epoch and rejects prior-epoch batches', () => {
    const previous = globalThis.__merkurTerminalPerf;
    globalThis.__merkurTerminalPerf = undefined;
    const observed: number[] = [];
    const unsubscribe = onTerminalPerfObservationReset((epoch) => observed.push(epoch));
    try {
      const recorder = installTerminalPerfRecorder();
      const oldEpoch = terminalPerfObservationEpoch();
      recorder.reset();
      const newEpoch = terminalPerfObservationEpoch();
      expect(newEpoch).not.toBe(oldEpoch);
      expect(observed).toEqual([newEpoch]);

      recorder.record(daemonTiming({ observationEpoch: oldEpoch }));
      recorder.record(daemonTiming({ observationEpoch: newEpoch }));
      expect(recorder.events).toEqual([daemonTiming({ observationEpoch: newEpoch })]);
    } finally {
      unsubscribe();
      uninstallTerminalPerfRecorder();
      globalThis.__merkurTerminalPerf = previous;
    }
  });

  test('uses an ordered O(1) circular tail and exposes truncation', () => {
    const recorder = createTerminalPerfRecorder(3);
    recorder.record(inputQueued(100, 1));
    recorder.record(inputQueued(101, 2));
    recorder.record(inputQueued(102, 3));
    recorder.record(inputQueued(103, 4));

    expect(recorder.events.map((event) => ('inputSeq' in event ? event.inputSeq : 0))).toEqual([
      2, 3, 4,
    ]);
    expect(recorder.capacity).toBe(3);
    expect(recorder.retainedEventCount).toBe(3);
    expect(recorder.totalRecordedCount).toBe(4);
    expect(recorder.droppedEventCount).toBe(1);
    expect(recorder.report().inputAckMs.complete).toBe(false);

    recorder.reset();
    expect(recorder.events).toEqual([]);
    expect(recorder.totalRecordedCount).toBe(0);
    expect(recorder.droppedEventCount).toBe(0);
  });
});

function startupMilestone(
  milestone: Extract<TerminalPerfEvent, { kind: 'startup_milestone' }>['milestone'],
  elapsedMs: number,
): Extract<TerminalPerfEvent, { kind: 'startup_milestone' }> {
  return {
    kind: 'startup_milestone',
    atMs: 1_000 + elapsedMs,
    attemptId: 1,
    deviceId: 'device-a',
    milestone,
    elapsedMs,
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
  };
}

/**
 * The daemon read a key's echo before it had confirmed the key's write. The
 * echo's submission carries the older input barrier and the newer echo horizon;
 * a header-only frame raises the barrier afterwards, and nothing visual follows.
 */
describe('an echo read before its write was confirmed', () => {
  const PREVIOUS = 1428;
  const KEY = 1429;

  function trace(horizonSeq: number, confirmedAtMs: number): TerminalPerfEvent[] {
    const window = {
      kind: 'presentation_measurement_boundary',
      measurementId: 1,
      purpose: 'isolated-interactive',
    } as const;
    const headerOnly = { authoritativeVisualMutation: false, presentationTransactionSeq: 0 };

    return [
      { ...window, atMs: 9, phase: 'start' },
      inputQueued(10, KEY),
      {
        ...displayEvent('worker_display_applied', 11.2, 4, 2101),
        ...headerOnly,
        inputSeq: PREVIOUS,
        rowCount: 0,
      },
      {
        ...displayEvent('worker_display_applied', 11.3, 4, 2102),
        inputSeq: PREVIOUS,
        presentationTransactionSeq: 721,
      },
      renderStart(11.32, { renderSeq: 4374 }),
      renderEnd(11.38, { renderSeq: 4374 }),
      presentationCommit(11.38, {
        transactionSeq: 721,
        renderSeq: 4374,
        generation: 4,
        firstDisplaySeq: 2102,
        lastDisplaySeq: 2102,
        displayInputSeq: PREVIOUS,
        displayEchoHorizonSeq: horizonSeq,
        firstPresentationId: 2102,
        lastPresentationId: 2102,
        coherent: false,
        reason: 'urgent',
      }),
      frameComplete(12.16, { renderSeq: 4374 }),
      {
        ...displayEvent('worker_display_applied', confirmedAtMs, 4, 2103),
        ...headerOnly,
        inputSeq: KEY,
        rowCount: 0,
      },
      { ...window, atMs: 13, phase: 'end' },
    ];
  }

  function sample(events: readonly TerminalPerfEvent[]) {
    const ordered = [...events].sort((left, right) => left.atMs - right.atMs);

    return buildTerminalLatencyReport(ordered).samples.find((entry) => entry.inputSeq === KEY);
  }

  test('answers the key at the fence of the pixels that could hold its echo', () => {
    const answered = sample(trace(KEY, 11.41));

    expect(answered?.inputToAuthoritativeVisualFenceMs).toBeCloseTo(2.16, 9);
    expect(answered?.inputToCompletedAuthoritativePresentationFenceMs).toBeCloseTo(2.16, 9);
  });

  test('answers it at the confirming frame when the fence came first', () => {
    const answered = sample(trace(KEY, 12.5));

    expect(answered?.inputToAuthoritativeVisualFenceMs).toBeCloseTo(2.5, 9);
    expect(answered?.inputToCompletedAuthoritativePresentationFenceMs).toBeCloseTo(2.5, 9);
  });

  test('pixels applied before the key was queued answer nothing', () => {
    const unanswered = sample(trace(PREVIOUS, 11.41));

    expect(unanswered?.inputToAuthoritativeVisualFenceMs).toBeNull();
    expect(unanswered?.inputToCompletedAuthoritativePresentationFenceMs).toBeNull();
  });
});

function inputQueued(
  atMs: number,
  inputSeq = 1,
): Extract<TerminalPerfEvent, { readonly kind: 'input_queued' }> {
  return { kind: 'input_queued', atMs, admittedAtMs: atMs, inputSeq, byteLength: 1 };
}

function daemonTiming(
  overrides: Partial<Extract<TerminalPerfEvent, { readonly kind: 'daemon_timing' }>> = {},
): Extract<TerminalPerfEvent, { readonly kind: 'daemon_timing' }> {
  return {
    kind: 'daemon_timing',
    atMs: 10,
    inputSeq: 1,
    recvToPtyUs: 1,
    ptyToReadUs: 2,
    gridApplyUs: 3,
    displayCoalesceUs: 4,
    selectCaptureUs: 5,
    prepareQueueUs: 6,
    encodeUs: 7,
    compressionUs: 8,
    completionQueueUs: 9,
    transportSubmitUs: 10,
    writeCompletionUs: 11,
    ackTransmitUs: 12,
    ownerCpuUs: 13,
    ownerOffCpuUs: 14,
    ownerQuinnWaitUs: 15,
    ownerRegistryWaitUs: 16,
    flushLockWaitUs: 17,
    batchSeq: 1,
    observationEpoch: 1,
    ...overrides,
  };
}

function daemonTimingStatus(
  overrides: Partial<Extract<TerminalPerfEvent, { readonly kind: 'daemon_timing_status' }>> = {},
): Extract<TerminalPerfEvent, { readonly kind: 'daemon_timing_status' }> {
  return {
    kind: 'daemon_timing_status',
    atMs: 10,
    batchSeq: 1,
    inputAttributedTotal: 0,
    inputDroppedTotal: 0,
    inputSkippedTotal: 0,
    pendingInputs: 0,
    displayAttributedTotal: 0,
    displayDroppedTotal: 0,
    observationEpoch: 1,
    recordCount: 0,
    ...overrides,
  };
}

function displayEvent<
  TKind extends 'display_received' | 'worker_display_queued' | 'worker_display_applied',
>(
  kind: TKind,
  atMs: number,
  generation: number,
  displaySeq: number,
): Extract<TerminalPerfEvent, { kind: TKind }> {
  return {
    kind,
    atMs,
    displaySeq,
    generation,
    inputSeq: 1,
    frameId: displaySeq,
    chunkIndex: 0,
    chunkCount: 1,
    presentationId: displaySeq,
    presentationMemberIndex: 0,
    presentationMemberCount: 0,
    rowPredecessorPresentationId: 0,
    presentationTransactionSeq: kind === 'worker_display_applied' ? 1 : 0,
    presentationCoherent: false,
    fecRecovered: false,
    presentationEnd: false,
    authoritativeVisualMutation: kind === 'worker_display_applied' ? true : null,
    workerReceiptToDecodeMs: kind === 'display_received' ? 1 : null,
    decodeToApplyMs: kind === 'worker_display_applied' ? 2 : null,
    byteLength: 32,
    rowCount: 1,
    displayKind: 'display_delta',
  } as Extract<TerminalPerfEvent, { kind: TKind }>;
}

function browserIoEvent(
  stage: Extract<TerminalPerfEvent, { kind: 'browser_display_io' }>['stage'],
  atMs: number,
  overrides: Partial<Extract<TerminalPerfEvent, { kind: 'browser_display_io' }>> = {},
): Extract<TerminalPerfEvent, { kind: 'browser_display_io' }> {
  return {
    kind: 'browser_display_io',
    atMs,
    stage,
    ingressRoute:
      stage === 'transport_ingress' || stage === 'transport_fec_ingress' ? 'direct-datagram' : null,
    displaySeq: 1,
    generation: 1,
    frameId: stage === 'transport_fec_ingress' || stage === 'terminal_fec' ? 0 : 1,
    chunkIndex: 0,
    chunkCount: 1,
    payloadByteLength: 64,
    admitted: true,
    fecRecovered: false,
    explicitCopyCount: 0,
    explicitCopiedBytes: 0,
    explicitAllocationRequestCount: 0,
    explicitAllocationRequestedBytes: 0,
    explicitObjectAllocationRequestCount: 0,
    ...overrides,
  };
}

function presentationCommit(
  atMs: number,
  overrides: Partial<Extract<TerminalPerfEvent, { readonly kind: 'presentation_commit' }>> = {},
): Extract<TerminalPerfEvent, { readonly kind: 'presentation_commit' }> {
  return {
    kind: 'presentation_commit',
    atMs,
    releaseFrameTimeMs: atMs,
    releaseFrameCount: 2,
    membershipReleaseDisableBits: 0,
    transactionSeq: 1,
    renderSeq: DEFAULT_RENDER_SEQ,
    generation: 1,
    firstDisplaySeq: 1,
    lastDisplaySeq: 1,
    displayInputSeq: 1,
    // An echo read after its write was confirmed: the horizon is the barrier.
    displayEchoHorizonSeq: overrides.displayInputSeq ?? 1,
    firstPresentationId: 7,
    lastPresentationId: 7,
    firstApplyToCommitMs: 2,
    lastApplyToCommitMs: 1,
    deadlineOverrunMs: 0,
    refreshPeriodMs: 1000 / 60,
    datagramCount: 1,
    rowCount: 1,
    byteLength: 32,
    queueHighWater: 1,
    coherent: true,
    endSeen: false,
    authoritativeVisualChange: true,
    reason: 'deadline-vsync',
    ...overrides,
  };
}

/** Shared render identity, so the default triple joins without repeating it. */
const DEFAULT_RENDER_SEQ = 1;

function frameComplete(
  atMs: number,
  overrides: Partial<Extract<TerminalPerfEvent, { readonly kind: 'frame_complete' }>> = {},
): Extract<TerminalPerfEvent, { readonly kind: 'frame_complete' }> {
  return {
    kind: 'frame_complete',
    completionDisposition: 'latest-submitted',
    atMs,
    renderSeq: DEFAULT_RENDER_SEQ,
    displayInputSeq: 1,
    predictionInputSeq: 0,
    visiblePredictionInputSeqs: [],
    visiblePredictionInputSeqsTruncated: false,
    queuedDisplayFrames: 0,
    pollCount: 0,
    previousPollAtMs: 0,
    ...overrides,
  };
}

function renderStart(
  atMs: number,
  overrides: Partial<Extract<TerminalPerfEvent, { readonly kind: 'render_start' }>> = {},
): Extract<TerminalPerfEvent, { readonly kind: 'render_start' }> {
  return {
    kind: 'render_start',
    atMs,
    renderSeq: DEFAULT_RENDER_SEQ,
    displayInputSeq: 1,
    predictionInputSeq: 0,
    queuedDisplayFrames: 0,
    wantedAtMs: atMs,
    gate: 'immediate',
    fenceReleasedAtMs: 0,
    fenceReleasedRenderSeq: 0,
    opportunityEnteredAtMs: 0,
    opportunityDelayMs: 0,
    fenceWaitMs: 0,
    opportunityWaitMs: 0,
    refreshPeriodMs: 1000 / 60,
    refreshConfidence01: 1,
    ...overrides,
  };
}

function renderEnd(
  atMs: number,
  overrides: Partial<Extract<TerminalPerfEvent, { readonly kind: 'render_end' }>> = {},
): Extract<TerminalPerfEvent, { readonly kind: 'render_end' }> {
  return {
    kind: 'render_end',
    atMs,
    renderSeq: DEFAULT_RENDER_SEQ,
    displayInputSeq: 1,
    predictionInputSeq: 0,
    visiblePredictionInputSeqs: [],
    visiblePredictionInputSeqsTruncated: false,
    queuedDisplayFrames: 0,
    completionMode: 'gpu-queue',
    atlasUploaded: false,
    drainedDisplay: false,
    ...overrides,
  };
}
