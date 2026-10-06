import { describe, expect, test } from 'bun:test';
import {
  decodePerfEvent,
  emitGraphicsAsset,
  emitRenderStart,
  encodePerfEvent,
  PERF_ENUM_TABLES,
  PERF_KIND_BROWSER_DISPLAY_IO,
  PERF_KIND_FRAME_COMPLETE,
  PERF_KIND_RENDER_END,
  PERF_KIND_RENDER_START,
  PERF_VISIBLE_PREDICTION_WINDOW,
} from './perf-event-codec';
import {
  createPerfRingBuffer,
  createPerfRingReader,
  createPerfRingWriter,
  PERF_RECORD_BYTES,
} from './perf-ring';
import {
  createPerfStringInterner,
  createPerfStringResolver,
  createPerfStringTableBuffer,
  PERF_STRING_TABLE_SLOTS,
} from './perf-string-table';
import type {
  BrowserDisplayIngressRoute,
  BrowserDisplayIoStage,
  GraphicsAssetPhase,
  PredictionGateSuppressionReason,
  TerminalDisplayResyncReason,
  TerminalEgressHop,
  TerminalFrameCompletionDisposition,
  TerminalFrameCompletionModeLabel,
  TerminalPerfEvent,
  TerminalPresentationCommitReason,
  TerminalPresentationDiscardReason,
  TerminalPresentationMeasurementPhase,
  TerminalPresentationMeasurementPurpose,
  TerminalRenderGate,
  TerminalStartupMilestone,
} from './terminal-latency';

function roundTrip(events: readonly TerminalPerfEvent[]): (TerminalPerfEvent | null)[] {
  const sab = createPerfRingBuffer(64);
  const writer = createPerfRingWriter(sab);
  const reader = createPerfRingReader(sab);
  // Both sides over one shared buffer, exactly as the real system wires them.
  const table = createPerfStringTableBuffer();
  const resolver = createPerfStringResolver(table);
  const interner = createPerfStringInterner(table);

  for (const event of events) {
    expect(encodePerfEvent(writer, interner, event)).toBe(true);
  }

  const decoded: (TerminalPerfEvent | null)[] = [];
  reader.drain((record) => decoded.push(decodePerfEvent(record, resolver)));
  return decoded;
}

/** Widen a literal-union table so it compares against `Object.keys`. */
function sortedNames(table: readonly string[]): string[] {
  return [...table].sort();
}

function roundTripOne(event: TerminalPerfEvent): TerminalPerfEvent | null {
  const decoded = roundTrip([event]);
  expect(decoded).toHaveLength(1);
  return decoded[0] ?? null;
}

/**
 * One representative of every event kind, with distinct values in every field
 * so a slot collision between two fields cannot pass unnoticed.
 */
const SAMPLES: readonly TerminalPerfEvent[] = [
  {
    kind: 'recovery_outcome',
    atMs: 51.5,
    ownerId: '11111111-2222-3333-4444-555555555555',
    attemptId: 19,
    carrierId: 27,
    issuanceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    sessionId: '01234567-89ab-cdef-0123-456789abcdef',
    trigger: 'page-resumed',
    phase: 'auth_written',
    endReason: 'auth_timeout',
    cancellationInitiator: 'attempt',
    durationMs: 901.5,
    capabilityRemainingMs: 25000,
    retryIndex: 7,
    backoffDelayMs: 643.25,
    handshakeAdmissionMs: 2.5,
    signalingOutcome: 'ready',
    interactiveOutcome: 'closed',
    bulkOutcome: 'rejected',
  },
  {
    kind: 'egress_model',
    atMs: 9.9,
    observationEpoch: 17,
    hop: 'daemon',
    model: {
      epoch: 17,
      bw: 4294967311,
      rtpropUs: 120000,
      pacingRate: 8589934609,
      bulkCap: 65536,
      quantum: 1200,
      phase: 5,
      probesGated: 1,
      probesAborted: 2,
      interactiveInProbe: 3,
      queueGrowthCuts: 4,
      lossRounds: 5,
      ceRounds: 6,
      probeRtts: 7,
    },
  },

  {
    kind: 'startup_milestone',
    atMs: 1.5,
    attemptId: 3,
    deviceId: 'device-abc',
    milestone: 'first_display_visible',
    elapsedMs: 12.25,
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
  },
  { kind: 'session_start', atMs: 2.5 },
  { kind: 'input_queued', atMs: 3.5, admittedAtMs: 3.75, inputSeq: 11, byteLength: 22 },
  {
    kind: 'keyboard_commit',
    atMs: 4.5,
    touchStartedAtMs: 4.125,
    inputSeq: 12,
    repeat: true,
  },
  { kind: 'input_sent', atMs: 5.5, inputSeq: 13 },
  { kind: 'input_ack', atMs: 6.5, inputSeq: 14, networkRttMs: 27.5 },
  { kind: 'prediction_queued', atMs: 7.5, inputSeq: 15 },
  { kind: 'prediction_applied', atMs: 8.5, inputSeq: 16 },
  { kind: 'prediction_rejected', atMs: 9.75, inputSeq: 18, rejectKind: 4, rejectCauseCode: 28 },
  {
    kind: 'cursor_step',
    atMs: 9.8,
    causeCode: 29,
    fromRow: 3,
    fromCol: 27,
    toRow: 3,
    toCol: 26,
    flags: 0b101101,
    ops: 2,
    journalSeq: 7,
    predictionInputSeq: 19,
    displayInputSeq: 17,
  },
  {
    kind: 'cursor_shape',
    atMs: 9.9,
    shapeFrom: 1,
    visibleFrom: 1,
    shapeTo: 2,
    visibleTo: 0,
    flags: 0b100,
    displaySeq: 4_101,
  },
  {
    kind: 'daemon_timing',
    atMs: 9.875,
    inputSeq: 19,
    recvToPtyUs: 120,
    ptyToReadUs: 4_300,
    gridApplyUs: 100,
    displayCoalesceUs: 160,
    selectCaptureUs: 120,
    prepareQueueUs: 30,
    encodeUs: 240,
    compressionUs: 80,
    completionQueueUs: 20,
    transportSubmitUs: 150,
    writeCompletionUs: 45,
    ackTransmitUs: 7_380,
    // Past a u16 and up to the u32 ceiling: the f64 slots carry every value.
    ownerCpuUs: 910,
    ownerOffCpuUs: 70_000,
    ownerQuinnWaitUs: 0xffff_ffff,
    ownerRegistryWaitUs: 3,
    flushLockWaitUs: 65_537,
    batchSeq: 3,
    observationEpoch: 7,
  },
  // An unobserved acknowledgment boundary stays absent through the ring; a
  // codec that stored it as zero would report a perfect ACK.
  {
    kind: 'daemon_timing',
    atMs: 9.9375,
    inputSeq: 20,
    recvToPtyUs: 110,
    ptyToReadUs: 4_000,
    gridApplyUs: 90,
    displayCoalesceUs: 150,
    selectCaptureUs: 110,
    prepareQueueUs: 20,
    encodeUs: 230,
    compressionUs: 70,
    completionQueueUs: 10,
    transportSubmitUs: 140,
    writeCompletionUs: null,
    ackTransmitUs: null,
    ownerCpuUs: 0,
    ownerOffCpuUs: 0,
    ownerQuinnWaitUs: 0,
    ownerRegistryWaitUs: 0,
    flushLockWaitUs: 0,
    batchSeq: 3,
    observationEpoch: 7,
  },
  {
    kind: 'transport_egress',
    atMs: 9.95,
    observationEpoch: 7,
    hop: 'daemon',
    series: 0xffff_fffd,
    interactive: { blocked: 3, paced: 1, waitedUs: 6_900 },
    bulk: { blocked: 0xffff_fffe, paced: 12, waitedUs: 41 },
  },
  {
    kind: 'transport_egress',
    atMs: 9.95,
    observationEpoch: 7,
    hop: 'edge',
    series: 4,
    interactive: { blocked: 0, paced: 0, waitedUs: 0 },
    bulk: { blocked: 9, paced: 2, waitedUs: 17 },
  },
  {
    kind: 'edge_forward_residence',
    atMs: 9.95,
    observationEpoch: 7,
    series: 4,
    buckets: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0xffff_ffff],
  },
  {
    kind: 'daemon_timing_status',
    atMs: 10,
    batchSeq: 3,
    inputAttributedTotal: 19,
    inputDroppedTotal: 0,
    inputSkippedTotal: 1,
    pendingInputs: 2,
    displayAttributedTotal: 8,
    displayDroppedTotal: 0,
    observationEpoch: 7,
    recordCount: 1,
  },
  {
    kind: 'prediction_suppressed',
    atMs: 10.5,
    queuedPredictions: 4,
    failedPredictions: 5,
    discardedPredictions: 6,
  },
  {
    kind: 'transport_state',
    atMs: 11.5,
    state: 'disconnected',
    reason: 'network changed',
  },
  {
    kind: 'carrier_recovery',
    atMs: 11.75,
    phase: 'dial_started',
    reason: 'pong-deadline-lapsed',
  },
  // The two strikes share a reason and differ only in phase, so a codec that
  // conflated them would still round-trip the sample above.
  {
    kind: 'carrier_recovery',
    atMs: 11.8,
    phase: 'incumbent_failed',
    reason: 'pong-deadline-lapsed',
  },
  // The stall's exact end carries the reason of the dial that began it.
  {
    kind: 'carrier_recovery',
    atMs: 11.81,
    phase: 'first_ack',
    reason: 'connectivity-hint',
  },
  {
    kind: 'carrier_closed',
    atMs: 11.82,
    lane: 'interactive',
    source: 'session',
    closeCode: 0,
    lifetimeMs: 91_234.5,
  },
  {
    kind: 'carrier_closed',
    atMs: 11.83,
    lane: 'bulk',
    source: 'clean',
    closeCode: 4_000,
    lifetimeMs: 12.25,
  },
  {
    kind: 'graphics_asset',
    atMs: 11.85,
    phase: 'fin',
    jobId: 23,
    bytes: 266_521,
    failed: false,
  },
  {
    kind: 'graphics_asset',
    atMs: 11.9,
    phase: 'retired',
    jobId: 24,
    bytes: 0,
    failed: true,
  },
  {
    kind: 'prediction_gate',
    atMs: 12.5,
    state: 'suppressed',
    mode: 1049,
    suppressionReason: 'no_prompt_grant',
    trustConsecutive: 7,
    trustRatio: 0.95,
    trustWindow: 20,
  },
  {
    kind: 'display_received',
    atMs: 13.5,
    displaySeq: 21,
    generation: 22,
    inputSeq: 23,
    frameId: 24,
    chunkIndex: 0,
    chunkCount: 1,
    presentationId: 27,
    presentationMemberIndex: 2,
    presentationMemberCount: 3,
    rowPredecessorPresentationId: 19,
    presentationTransactionSeq: 0,
    presentationCoherent: true,
    fecRecovered: false,
    presentationEnd: false,
    authoritativeVisualMutation: null,
    workerReceiptToDecodeMs: 1.25,
    decodeToApplyMs: null,
    byteLength: 25,
    rowCount: 26,
    displayKind: 'display_delta',
  },
  {
    kind: 'worker_display_queued',
    atMs: 14.5,
    displaySeq: 31,
    generation: 32,
    inputSeq: 33,
    frameId: 34,
    chunkIndex: 0,
    chunkCount: 1,
    presentationId: 37,
    presentationMemberIndex: 0,
    presentationMemberCount: 1,
    rowPredecessorPresentationId: 29,
    presentationTransactionSeq: 0,
    presentationCoherent: true,
    fecRecovered: false,
    presentationEnd: true,
    authoritativeVisualMutation: null,
    workerReceiptToDecodeMs: null,
    decodeToApplyMs: null,
    byteLength: 35,
    rowCount: 36,
    displayKind: 'display_snapshot',
  },
  {
    kind: 'worker_display_applied',
    atMs: 15.5,
    displaySeq: 41,
    generation: 42,
    inputSeq: 43,
    frameId: 44,
    chunkIndex: 0,
    chunkCount: 1,
    presentationId: 47,
    presentationMemberIndex: 0,
    presentationMemberCount: 0,
    rowPredecessorPresentationId: 39,
    presentationTransactionSeq: 101,
    presentationCoherent: false,
    fecRecovered: false,
    presentationEnd: false,
    authoritativeVisualMutation: true,
    workerReceiptToDecodeMs: null,
    decodeToApplyMs: 2.75,
    byteLength: 45,
    rowCount: 46,
    displayKind: 'display_delta',
  },
  {
    kind: 'presentation_commit',
    atMs: 16.25,
    releaseFrameTimeMs: 15.875,
    releaseFrameCount: 2,
    membershipReleaseDisableBits: 0xa5,
    transactionSeq: 101,
    renderSeq: 102,
    generation: 103,
    firstDisplaySeq: 104,
    lastDisplaySeq: 105,
    displayInputSeq: 106,
    displayEchoHorizonSeq: 0xffff_fffe,
    firstPresentationId: 107,
    lastPresentationId: 108,
    firstApplyToCommitMs: 0.5,
    lastApplyToCommitMs: 0.25,
    deadlineOverrunMs: 0.125,
    refreshPeriodMs: 8.25,
    datagramCount: 109,
    rowCount: 110,
    byteLength: 111,
    queueHighWater: 112,
    coherent: true,
    endSeen: true,
    authoritativeVisualChange: true,
    reason: 'group-end-vsync',
  },
  {
    kind: 'presentation_transaction_discarded',
    atMs: 16.3125,
    transactionSeq: 121,
    generation: 122,
    firstDisplaySeq: 123,
    lastDisplaySeq: 124,
    appliedDatagramCount: 2,
    rowCount: 125,
    byteLength: 126,
    reason: 'epoch-reset',
  },
  {
    kind: 'presentation_epoch_boundary',
    atMs: 16.34375,
    epoch: 127,
    preserved: false,
  },
  {
    kind: 'main_frame_cadence',
    atMs: 16.35,
    gapMs: 8.3125,
    longTaskObserverSupported: true,
  },
  {
    kind: 'main_long_task',
    atMs: 16.36,
    durationMs: 51.25,
  },
  {
    kind: 'presentation_gate',
    atMs: 16.361,
    gates: 0x0e01_0081,
    viewerFrameAgeMs: 4_812.5,
    frameFenceToken: 7,
    gridCols: 48,
    gridRows: 41,
    presentationCols: 120,
    presentationRows: 40,
  },
  {
    kind: 'first_display_gate',
    atMs: 16.362,
    accepted: false,
    frameFenceToken: 6,
    currentFenceToken: 7,
  },
  {
    kind: 'browser_display_io',
    atMs: 16.37,
    stage: 'terminal_apply',
    ingressRoute: null,
    displaySeq: 201,
    generation: 202,
    frameId: 203,
    chunkIndex: 1,
    chunkCount: 2,
    payloadByteLength: 2048,
    admitted: true,
    fecRecovered: true,
    explicitCopyCount: 3,
    explicitCopiedBytes: 6144,
    explicitAllocationRequestCount: 1,
    explicitAllocationRequestedBytes: 2048,
    explicitObjectAllocationRequestCount: 4,
  },
  {
    kind: 'display_pump_complete',
    ringBytesAtStart: 8192,
    ringBytesAtEnd: 64,
    ringDroppedTotal: 2,
    atMs: 16.375,
    durationMs: 3.25,
    budgetMs: 4.5,
    processedDatagramCount: 5,
    processedRowCount: 17,
    queueHighWater: 8,
    queueRemaining: 3,
  },
  {
    kind: 'presentation_measurement_boundary',
    atMs: 16.375,
    measurementId: 113,
    phase: 'end',
    purpose: 'streaming',
  },
  {
    kind: 'display_ring_measurement_boundary',
    atMs: 16.375,
    measurementId: 113,
    phase: 'end',
    observationEpoch: 7,
    sessionEpoch: 3,
    ringDroppedTotal: 2,
  },
  {
    kind: 'render_start',
    atMs: 16.5,
    renderSeq: 51,
    displayInputSeq: 52,
    predictionInputSeq: 53,
    queuedDisplayFrames: 54,
    wantedAtMs: 16.125,
    gate: 'fence-and-opportunity',
    fenceReleasedAtMs: 16.25,
    fenceReleasedRenderSeq: 50,
    opportunityEnteredAtMs: 16.375,
    opportunityDelayMs: 8.125,
    fenceWaitMs: 0.25,
    opportunityWaitMs: 0.125,
    refreshPeriodMs: 8.333333,
    refreshConfidence01: 0.875,
  },
  {
    kind: 'render_end',
    atMs: 17.5,
    renderSeq: 61,
    displayInputSeq: 62,
    predictionInputSeq: 63,
    queuedDisplayFrames: 64,
    visiblePredictionInputSeqs: [71, 72, 73],
    visiblePredictionInputSeqsTruncated: false,
    completionMode: 'none',
    atlasUploaded: true,
    drainedDisplay: false,
  },
  {
    kind: 'display_resync',
    atMs: 17.75,
    reason: 'pending_assemblies_overflow',
    generation: 44,
    alreadyPending: true,
  },
  {
    kind: 'session_bound',
    atMs: 3.5,
    merkurSessionId: 'merkur-session-uuid',
    networkType: 'unavailable',
    effectiveType: 'unavailable',
  },
  {
    kind: 'frame_complete',
    completionDisposition: 'latest-submitted',
    atMs: 18.5,
    renderSeq: 81,
    displayInputSeq: 82,
    predictionInputSeq: 83,
    queuedDisplayFrames: 84,
    visiblePredictionInputSeqs: [91, 92],
    visiblePredictionInputSeqsTruncated: false,
    pollCount: 0,
    previousPollAtMs: 0,
  },
];

describe('perf event codec', () => {
  test('every event kind survives the round trip exactly', () => {
    // Deliberately one pass over all kinds in one ring: a slot collision between
    // two kinds sharing a physical record would show up here and not in
    // per-kind isolation, because `begin` zeroes what a kind does not set.
    expect(roundTrip(SAMPLES)).toEqual([...SAMPLES]);
  });

  test('covers every kind in the event union', () => {
    const covered = new Set(SAMPLES.map((event) => event.kind));
    // Mirrors the union in terminal-latency.ts. A kind added there without a
    // sample here means it silently stops being profiled.
    const expected: Record<TerminalPerfEvent['kind'], true> = {
      startup_milestone: true,
      session_start: true,
      session_bound: true,
      input_queued: true,
      keyboard_commit: true,
      input_sent: true,
      input_ack: true,
      prediction_queued: true,
      prediction_applied: true,
      prediction_rejected: true,
      cursor_step: true,
      cursor_shape: true,
      daemon_timing: true,
      daemon_timing_status: true,
      transport_egress: true,
      egress_model: true,
      edge_forward_residence: true,
      prediction_suppressed: true,
      carrier_recovery: true,
      carrier_closed: true,
      recovery_outcome: true,
      graphics_asset: true,
      transport_state: true,
      prediction_gate: true,
      display_received: true,
      worker_display_queued: true,
      worker_display_applied: true,
      display_pump_complete: true,
      presentation_commit: true,
      presentation_transaction_discarded: true,
      presentation_epoch_boundary: true,
      main_frame_cadence: true,
      main_long_task: true,
      presentation_gate: true,
      first_display_gate: true,
      browser_display_io: true,
      presentation_measurement_boundary: true,
      display_ring_measurement_boundary: true,
      display_resync: true,
      render_start: true,
      render_end: true,
      frame_complete: true,
    };
    expect(sortedNames([...covered])).toEqual(Object.keys(expected).sort());
  });

  test('enum tables list every member of their union', () => {
    // `satisfies` makes the compiler the checker: a union member missing from
    // one of these objects fails the build, and the runtime assertion then
    // catches a table that fell out of step with the object.
    const milestones = {
      device_selected: true,
      terminal_mount_requested: true,
      worker_ready: true,
      terminal_view_presented: true,
      transport_start: true,
      transport_connected: true,
      first_display_applied: true,
      first_display_visible: true,
    } satisfies Record<TerminalStartupMilestone, true>;
    const suppression = {
      mode_uninitialized: true,
      no_prompt_grant: true,
      unsafe_mode: true,
      unknown_mode: true,
    } satisfies Record<PredictionGateSuppressionReason, true>;
    const gates = {
      immediate: true,
      fence: true,
      opportunity: true,
      'fence-and-opportunity': true,
    } satisfies Record<TerminalRenderGate, true>;
    const completion = {
      'gpu-queue': true,
      none: true,
    } satisfies Record<TerminalFrameCompletionModeLabel, true>;
    const disposition = {
      'latest-submitted': true,
      superseded: true,
      invalidated: true,
    } satisfies Record<TerminalFrameCompletionDisposition, true>;
    const presentationCommitReasons = {
      urgent: true,
      'group-end-vsync': true,
      'deadline-vsync': true,
      'deadline-timer': true,
      'recovery-release': true,
      'repair-target-satisfied': true,
      'repair-deadline-expired': true,
      'safety-revocation': true,
      'membership-complete': true,
      'closure-complete': true,
      'paced-complete': true,
    } satisfies Record<TerminalPresentationCommitReason, true>;
    const presentationMeasurementPhases = {
      start: true,
      end: true,
    } satisfies Record<TerminalPresentationMeasurementPhase, true>;
    const presentationMeasurementPurposes = {
      'coherent-redraw': true,
      'isolated-interactive': true,
      streaming: true,
    } satisfies Record<TerminalPresentationMeasurementPurpose, true>;
    const presentationDiscardReasons = {
      resync: true,
      'epoch-reset': true,
      teardown: true,
    } satisfies Record<TerminalPresentationDiscardReason, true>;
    const browserDisplayIoStages = {
      transport_ingress: true,
      terminal_apply: true,
      transport_fec_ingress: true,
      terminal_fec: true,
    } satisfies Record<BrowserDisplayIoStage, true>;
    const browserDisplayIngressRoutes = {
      'direct-datagram': true,
      'direct-reliable': true,
      'relay-datagram': true,
      'relay-reliable': true,
    } satisfies Record<BrowserDisplayIngressRoute, true>;
    const resyncReasons = {
      queue_admission: true,
      frame_parse_failed: true,
      frame_stage_failed: true,
      ahead_delta_buffer_overflow: true,
      stale_generation_recovery: true,
      pending_frame_metadata: true,
      pending_frame_bytes: true,
      pending_frame_rows: true,
      pending_frame_mismatch: true,
      pending_frame_evicted: true,
      pending_assemblies_overflow: true,
      frame_validation_rejected: true,
      apply_rejected: true,
      hash_digest_generation_ahead: true,
      profiling_harness: true,
    } satisfies Record<TerminalDisplayResyncReason, true>;
    const graphicsAssetPhases = {
      demanded: true,
      requested: true,
      first_byte: true,
      fin: true,
      published: true,
      consumed: true,
      retired: true,
      refused: true,
      unavailable: true,
      cancelled: true,
      interrupted: true,
      resumed: true,
    } satisfies Record<GraphicsAssetPhase, true>;
    const egressHops = {
      daemon: true,
      edge: true,
    } satisfies Record<TerminalEgressHop, true>;

    expect(sortedNames(PERF_ENUM_TABLES.startupMilestones)).toEqual(Object.keys(milestones).sort());
    expect(sortedNames(PERF_ENUM_TABLES.suppressionReasons)).toEqual(
      Object.keys(suppression).sort(),
    );
    expect(sortedNames(PERF_ENUM_TABLES.renderGates)).toEqual(Object.keys(gates).sort());
    expect(sortedNames(PERF_ENUM_TABLES.completionModes)).toEqual(Object.keys(completion).sort());
    expect(sortedNames(PERF_ENUM_TABLES.completionDispositions)).toEqual(
      Object.keys(disposition).sort(),
    );
    expect(sortedNames(PERF_ENUM_TABLES.presentationCommitReasons)).toEqual(
      Object.keys(presentationCommitReasons).sort(),
    );
    expect(sortedNames(PERF_ENUM_TABLES.presentationMeasurementPhases)).toEqual(
      Object.keys(presentationMeasurementPhases).sort(),
    );
    expect(sortedNames(PERF_ENUM_TABLES.presentationMeasurementPurposes)).toEqual(
      Object.keys(presentationMeasurementPurposes).sort(),
    );
    expect(sortedNames(PERF_ENUM_TABLES.presentationDiscardReasons)).toEqual(
      Object.keys(presentationDiscardReasons).sort(),
    );
    expect(sortedNames(PERF_ENUM_TABLES.browserDisplayIoStages)).toEqual(
      Object.keys(browserDisplayIoStages).sort(),
    );
    expect(sortedNames(PERF_ENUM_TABLES.browserDisplayIngressRoutes)).toEqual(
      Object.keys(browserDisplayIngressRoutes).sort(),
    );
    expect(sortedNames(PERF_ENUM_TABLES.displayResyncReasons)).toEqual(
      Object.keys(resyncReasons).sort(),
    );
    expect(sortedNames(PERF_ENUM_TABLES.graphicsAssetPhases)).toEqual(
      Object.keys(graphicsAssetPhases).sort(),
    );
    expect(sortedNames(PERF_ENUM_TABLES.egressHops)).toEqual(Object.keys(egressHops).sort());
  });

  test('every graphics asset phase keeps its identity, and only its own phase carries a value', () => {
    const sab = createPerfRingBuffer(64);
    const writer = createPerfRingWriter(sab);
    const reader = createPerfRingReader(sab);
    const resolver = createPerfStringResolver(createPerfStringTableBuffer());
    for (const [index, phase] of PERF_ENUM_TABLES.graphicsAssetPhases.entries()) {
      expect(
        emitGraphicsAsset(
          writer,
          index + 0.5,
          phase,
          index + 1,
          phase === 'fin' ? 4_096 : 0,
          phase === 'retired',
        ),
      ).toBe(true);
    }
    // A failed flag outside `retired` and bytes outside `fin` cannot be faithful.
    emitGraphicsAsset(writer, 20, 'first_byte', 1, 0, true);
    emitGraphicsAsset(writer, 21, 'consumed', 1, 16, false);
    const decoded: (TerminalPerfEvent | null)[] = [];
    reader.drain((record) => decoded.push(decodePerfEvent(record, resolver)));
    expect(decoded.slice(0, PERF_ENUM_TABLES.graphicsAssetPhases.length)).toEqual(
      PERF_ENUM_TABLES.graphicsAssetPhases.map((phase, index) => ({
        kind: 'graphics_asset',
        atMs: index + 0.5,
        phase,
        jobId: index + 1,
        bytes: phase === 'fin' ? 4_096 : 0,
        failed: phase === 'retired',
      })),
    );
    expect(decoded.slice(PERF_ENUM_TABLES.graphicsAssetPhases.length)).toEqual([null, null]);
  });

  test("an ack's null path floor stays null, and a zero floor stays zero", () => {
    // Same confusion as the gate fields, on the term the ack round trip is
    // split by: a null decoding as zero would attribute the whole round trip to
    // the daemon on every ack taken before the floor has a sample.
    expect(
      roundTripOne({
        kind: 'input_ack',
        atMs: 1,
        inputSeq: 2,
        networkRttMs: null,
      }),
    ).toEqual({
      kind: 'input_ack',
      atMs: 1,
      inputSeq: 2,
      networkRttMs: null,
    });
    expect(
      roundTripOne({
        kind: 'input_ack',
        atMs: 1,
        inputSeq: 2,
        networkRttMs: 0,
      }),
    ).toEqual({
      kind: 'input_ack',
      atMs: 1,
      inputSeq: 2,
      networkRttMs: 0,
    });
  });

  test('all completion dispositions retain the full membership in the same 128-byte record', () => {
    const sample = SAMPLES.find((event) => event.kind === 'frame_complete');
    if (sample?.kind !== 'frame_complete') throw new Error('missing completion fixture');
    const seqs = Array.from({ length: PERF_VISIBLE_PREDICTION_WINDOW }, (_, index) => index + 1);
    expect(PERF_RECORD_BYTES).toBe(128);
    for (const completionDisposition of PERF_ENUM_TABLES.completionDispositions) {
      const event = {
        ...sample,
        completionDisposition,
        predictionInputSeq: 256,
        visiblePredictionInputSeqs: seqs,
        visiblePredictionInputSeqsTruncated: false,
      };
      expect(roundTripOne(event)).toEqual(event);
    }
  });

  test('absent and malformed disposition codes are rejected instead of becoming latest', () => {
    const sample = SAMPLES.find((event) => event.kind === 'frame_complete');
    if (sample?.kind !== 'frame_complete') throw new Error('missing completion fixture');
    for (const completionDisposition of [undefined, null, '', 'future']) {
      const writer = createPerfRingWriter(createPerfRingBuffer(1));
      const interner = createPerfStringInterner(createPerfStringTableBuffer());
      expect(
        encodePerfEvent(writer, interner, Object.assign({ ...sample }, { completionDisposition })),
      ).toBe(false);
      expect(writer.writtenCount).toBe(0);
    }
    for (const code of [0, 4, 7]) {
      const ring = createPerfRingBuffer(1);
      const writer = createPerfRingWriter(ring);
      writer.begin(PERF_KIND_FRAME_COMPLETE);
      writer.u32(6, code << 3);
      writer.commit();
      const decoded: (TerminalPerfEvent | null)[] = [];
      const resolver = createPerfStringResolver(createPerfStringTableBuffer());
      createPerfRingReader(ring).drain((record) => decoded.push(decodePerfEvent(record, resolver)));
      expect(decoded).toEqual([null]);
    }
  });

  test('render ends reject completion-disposition and unknown flag bits', () => {
    for (const flags of [1 << 3, 1 << 4, 1 << 5, 1 << 31]) {
      const ring = createPerfRingBuffer(1);
      const writer = createPerfRingWriter(ring);
      writer.begin(PERF_KIND_RENDER_END);
      writer.u32(6, flags);
      writer.commit();
      const decoded: (TerminalPerfEvent | null)[] = [];
      const resolver = createPerfStringResolver(createPerfStringTableBuffer());
      createPerfRingReader(ring).drain((record) => decoded.push(decodePerfEvent(record, resolver)));
      expect(decoded).toEqual([null]);
    }
  });

  test('gate ownership is required only for fence-gated starts and rejects self ownership', () => {
    const sample = SAMPLES.find((event) => event.kind === 'render_start');
    if (sample?.kind !== 'render_start') throw new Error('missing render fixture');
    for (const gate of PERF_ENUM_TABLES.renderGates) {
      const fenced = gate === 'fence' || gate === 'fence-and-opportunity';
      const event = {
        ...sample,
        gate,
        fenceReleasedRenderSeq: fenced ? 50 : 0,
        fenceReleasedAtMs: fenced ? 16.25 : 0,
      };
      expect(roundTripOne(event)).toEqual(event);
      for (const owner of fenced ? [0, event.renderSeq] : [50]) {
        const ring = createPerfRingBuffer(1);
        const writer = createPerfRingWriter(ring);
        expect(
          encodePerfEvent(writer, createPerfStringInterner(createPerfStringTableBuffer()), {
            ...event,
            fenceReleasedRenderSeq: owner,
          }),
        ).toBe(false);
        writer.begin(PERF_KIND_RENDER_START);
        writer.u32(1, event.renderSeq);
        writer.u32(5, PERF_ENUM_TABLES.renderGates.indexOf(gate));
        writer.u32(6, owner);
        writer.commit();
        const decoded: (TerminalPerfEvent | null)[] = [];
        const resolver = createPerfStringResolver(createPerfStringTableBuffer());
        createPerfRingReader(ring).drain((record) =>
          decoded.push(decodePerfEvent(record, resolver)),
        );
        expect(decoded).toEqual([null]);
      }
    }
  });

  test('opportunity names retain fixed gate codes and numeric slots without old-name acceptance', () => {
    for (const [gate, code] of [
      ['opportunity', 2],
      ['fence-and-opportunity', 3],
    ] as const) {
      const ring = createPerfRingBuffer(1);
      const writer = createPerfRingWriter(ring);
      expect(
        emitRenderStart(
          writer,
          120,
          9,
          8,
          7,
          6,
          100,
          gate,
          code === 3 ? 104 : 0,
          code === 3 ? 5 : 0,
          105.25,
          8.125,
          8.333,
          0.9,
          code === 3 ? 3.125 : 0,
          8.0625,
        ),
      ).toBe(true);
      let read = false;
      createPerfRingReader(ring).drain((record) => {
        read = true;
        expect(record.u32(5)).toBe(code);
        expect(record.f64(3)).toBe(105.25);
        expect(record.f64(4)).toBe(8.125);
        expect(record.f64(7)).toBe(code === 3 ? 3.125 : 0);
        const duration = new Float64Array(1);
        new Uint32Array(duration.buffer).set([record.u32(8), record.u32(9)]);
        expect(duration[0]).toBe(8.0625);
        expect(record.kind).toBe(PERF_KIND_RENDER_START);
        expect(record.u32(1)).toBe(9);
      });
      expect(read).toBe(true);
    }
    const sample = SAMPLES.find((event) => event.kind === 'render_start');
    if (sample?.kind !== 'render_start') throw new Error('missing render fixture');
    for (const gate of ['floor', 'fence-then-floor', 'fence-then-opportunity']) {
      const writer = createPerfRingWriter(createPerfRingBuffer(1));
      expect(
        encodePerfEvent(
          writer,
          createPerfStringInterner(createPerfStringTableBuffer()),
          Object.assign({ ...sample }, { gate }),
        ),
      ).toBe(false);
      expect(writer.writtenCount).toBe(0);
    }
  });

  test('a gate with no trust evidence decodes its zeros as zeros', () => {
    const decoded = roundTripOne({
      kind: 'prediction_gate',
      atMs: 1,
      state: 'learning',
      mode: -1,
      suppressionReason: null,
      trustConsecutive: 0,
      trustRatio: 0,
      trustWindow: 0,
    });
    expect(decoded).toEqual({
      kind: 'prediction_gate',
      atMs: 1,
      state: 'learning',
      mode: -1,
      suppressionReason: null,
      trustConsecutive: 0,
      trustRatio: 0,
      trustWindow: 0,
    });
  });

  test('transport_state without a reason decodes without the key', () => {
    const decoded = roundTripOne({
      kind: 'transport_state',
      atMs: 1,
      state: 'connected',
    });
    expect(decoded).toEqual({
      kind: 'transport_state',
      atMs: 1,
      state: 'connected',
    });
    expect(Object.hasOwn(decoded ?? {}, 'reason')).toBe(false);
  });

  test('display visual mutation is unknown before apply and exact afterwards', () => {
    const received = roundTripOne({
      kind: 'display_received',
      atMs: 1,
      displaySeq: 2,
      generation: 3,
      inputSeq: 4,
      frameId: 5,
      chunkIndex: 0,
      chunkCount: 1,
      presentationId: 6,
      presentationMemberIndex: 0,
      presentationMemberCount: 1,
      rowPredecessorPresentationId: 1,
      presentationTransactionSeq: 0,
      presentationCoherent: true,
      fecRecovered: false,
      presentationEnd: false,
      authoritativeVisualMutation: null,
      workerReceiptToDecodeMs: 0.25,
      decodeToApplyMs: null,
      byteLength: 7,
      rowCount: 0,
      displayKind: 'display_delta',
    });
    const applied = roundTripOne({
      kind: 'worker_display_applied',
      atMs: 2,
      displaySeq: 2,
      generation: 3,
      inputSeq: 4,
      frameId: 5,
      chunkIndex: 0,
      chunkCount: 1,
      presentationId: 6,
      presentationMemberIndex: 0,
      presentationMemberCount: 1,
      rowPredecessorPresentationId: 1,
      presentationTransactionSeq: 0,
      presentationCoherent: true,
      fecRecovered: false,
      presentationEnd: false,
      authoritativeVisualMutation: false,
      workerReceiptToDecodeMs: null,
      decodeToApplyMs: 0.5,
      byteLength: 7,
      rowCount: 0,
      displayKind: 'display_delta',
    });

    expect(received).toMatchObject({ authoritativeVisualMutation: null });
    expect(applied).toMatchObject({
      authoritativeVisualMutation: false,
      presentationTransactionSeq: 0,
    });
  });

  test('display presentation membership preserves u16 wire truth and rejects wider values', () => {
    const event = {
      kind: 'display_received',
      atMs: 1,
      displaySeq: 2,
      generation: 3,
      inputSeq: 4,
      frameId: 5,
      chunkIndex: 0,
      chunkCount: 1,
      presentationId: 6,
      presentationMemberIndex: 0xffff,
      presentationMemberCount: 0xffff,
      rowPredecessorPresentationId: 0xffff_fffe,
      presentationTransactionSeq: 0,
      presentationCoherent: true,
      fecRecovered: false,
      presentationEnd: false,
      authoritativeVisualMutation: null,
      workerReceiptToDecodeMs: 0.25,
      decodeToApplyMs: null,
      byteLength: 7,
      rowCount: 0,
      displayKind: 'display_delta',
    } satisfies Extract<TerminalPerfEvent, { kind: 'display_received' }>;
    expect(roundTripOne(event)).toMatchObject({
      presentationMemberIndex: 0xffff,
      presentationMemberCount: 0xffff,
      rowPredecessorPresentationId: 0xffff_fffe,
    });

    for (const invalid of [
      { presentationMemberIndex: 0x1_0000 },
      { presentationMemberCount: 0x1_0000 },
      { presentationMemberIndex: -1 },
      { presentationMemberCount: 0.5 },
      { rowPredecessorPresentationId: -1 },
      { rowPredecessorPresentationId: 0x1_0000_0000 },
    ]) {
      const sab = createPerfRingBuffer(1);
      const writer = createPerfRingWriter(sab);
      const interner = createPerfStringInterner(createPerfStringTableBuffer());
      expect(encodePerfEvent(writer, interner, { ...event, ...invalid })).toBe(false);
      expect(writer.writtenCount).toBe(0);
    }
  });

  test('every browser display I/O stage keeps its exact identity and counters', () => {
    expect(PERF_RECORD_BYTES).toBe(128);
    for (const stage of PERF_ENUM_TABLES.browserDisplayIoStages) {
      const fec = stage === 'transport_fec_ingress' || stage === 'terminal_fec';
      const transport = stage === 'transport_ingress' || stage === 'transport_fec_ingress';
      const ingressRoute = transport ? 'relay-reliable' : null;
      expect(
        roundTripOne({
          kind: 'browser_display_io',
          atMs: 3,
          stage,
          ingressRoute,
          displaySeq: 4,
          generation: 5,
          frameId: fec ? 0 : 6,
          chunkIndex: 0,
          chunkCount: 1,
          payloadByteLength: 64,
          admitted: true,
          fecRecovered: stage === 'terminal_apply',
          explicitCopyCount: 2,
          explicitCopiedBytes: 128,
          explicitAllocationRequestCount: 1,
          explicitAllocationRequestedBytes: 64,
          explicitObjectAllocationRequestCount: 3,
        }),
      ).toEqual({
        kind: 'browser_display_io',
        atMs: 3,
        stage,
        ingressRoute,
        displaySeq: 4,
        generation: 5,
        frameId: fec ? 0 : 6,
        chunkIndex: 0,
        chunkCount: 1,
        payloadByteLength: 64,
        admitted: true,
        fecRecovered: stage === 'terminal_apply',
        explicitCopyCount: 2,
        explicitCopiedBytes: 128,
        explicitAllocationRequestCount: 1,
        explicitAllocationRequestedBytes: 64,
        explicitObjectAllocationRequestCount: 3,
      });
    }
  });

  test('browser display ingress routes reject missing, cross-stage, and invalid raw codes', () => {
    const sample = {
      kind: 'browser_display_io',
      atMs: 3,
      stage: 'transport_ingress',
      ingressRoute: 'direct-datagram',
      displaySeq: 4,
      generation: 5,
      frameId: 6,
      chunkIndex: 0,
      chunkCount: 1,
      payloadByteLength: 64,
      admitted: true,
      fecRecovered: false,
      explicitCopyCount: 1,
      explicitCopiedBytes: 64,
      explicitAllocationRequestCount: 0,
      explicitAllocationRequestedBytes: 0,
      explicitObjectAllocationRequestCount: 0,
    } satisfies Extract<TerminalPerfEvent, { kind: 'browser_display_io' }>;
    const interner = createPerfStringInterner(createPerfStringTableBuffer());
    for (const invalid of [
      { ingressRoute: null },
      { ingressRoute: 'future-route' },
      { stage: 'terminal_apply', ingressRoute: 'direct-datagram' },
    ]) {
      const writer = createPerfRingWriter(createPerfRingBuffer(1));
      expect(encodePerfEvent(writer, interner, Object.assign({ ...sample }, invalid))).toBe(false);
      expect(writer.writtenCount).toBe(0);
    }

    for (const [stageCode, routeCode] of [
      [0, 0],
      [0, 5],
      [1, 1],
      [2, 0],
      [3, 4],
    ] as const) {
      const ring = createPerfRingBuffer(1);
      const writer = createPerfRingWriter(ring);
      writer.begin(PERF_KIND_BROWSER_DISPLAY_IO);
      writer.u32(1, stageCode);
      writer.u32(2, 4);
      writer.u32(3, 5);
      writer.u32(4, stageCode >= 2 ? 0 : 6);
      writer.u32(5, 0);
      writer.u32(6, 1);
      writer.u32(7, 64);
      writer.u32(8, 1);
      writer.u32(9, 1);
      writer.u32(10, 64);
      writer.u32(14, 0);
      writer.u32(15, routeCode);
      writer.commit();
      const decoded: (TerminalPerfEvent | null)[] = [];
      createPerfRingReader(ring).drain((record) =>
        decoded.push(
          decodePerfEvent(record, createPerfStringResolver(createPerfStringTableBuffer())),
        ),
      );
      expect(decoded).toEqual([null]);
    }
  });

  test('a full window of visible predictions round-trips exactly', () => {
    // The count a list-shaped record could never carry, and the reason this one
    // is a bitmap: an in-flight keystroke run is exactly this dense.
    const seqs = Array.from({ length: PERF_VISIBLE_PREDICTION_WINDOW }, (_, i) => i + 1000);
    const decoded = roundTripOne({
      kind: 'render_end',
      atMs: 1,
      renderSeq: 2,
      displayInputSeq: 3,
      predictionInputSeq: 4,
      queuedDisplayFrames: 5,
      visiblePredictionInputSeqs: seqs,
      visiblePredictionInputSeqsTruncated: false,
      completionMode: 'gpu-queue',
      atlasUploaded: false,
      drainedDisplay: true,
    });

    expect(decoded).toMatchObject({
      visiblePredictionInputSeqs: seqs,
      visiblePredictionInputSeqsTruncated: false,
      drainedDisplay: true,
      atlasUploaded: false,
    });
  });

  test('a sparse set keeps its holes and decodes ascending', () => {
    const decoded = roundTripOne({
      kind: 'frame_complete',
      completionDisposition: 'latest-submitted',
      atMs: 1,
      renderSeq: 2,
      displayInputSeq: 3,
      predictionInputSeq: 240,
      queuedDisplayFrames: 0,
      visiblePredictionInputSeqs: [240, 7, 8, 200],
      visiblePredictionInputSeqsTruncated: false,
      pollCount: 0,
      previousPollAtMs: 0,
    });

    expect(decoded).toMatchObject({
      visiblePredictionInputSeqs: [7, 8, 200, 240],
      visiblePredictionInputSeqsTruncated: false,
    });
  });

  test('a set wider than one window truncates and carries nothing', () => {
    const decoded = roundTripOne({
      kind: 'render_end',
      atMs: 1,
      renderSeq: 2,
      displayInputSeq: 3,
      predictionInputSeq: 4,
      queuedDisplayFrames: 5,
      visiblePredictionInputSeqs: [1, PERF_VISIBLE_PREDICTION_WINDOW + 1],
      visiblePredictionInputSeqsTruncated: false,
      completionMode: 'gpu-queue',
      atlasUploaded: false,
      drainedDisplay: true,
    });

    expect(decoded).toMatchObject({
      // Half a set is not a set: the analyzer refuses to compute coverage from
      // a truncated frame, so the record must not offer it a plausible subset.
      visiblePredictionInputSeqs: [],
      visiblePredictionInputSeqsTruncated: true,
      drainedDisplay: true,
      atlasUploaded: false,
    });
  });

  test('a non-positive visible sequence truncates rather than shifting the base', () => {
    const decoded = roundTripOne({
      kind: 'render_end',
      atMs: 1,
      renderSeq: 2,
      displayInputSeq: 3,
      predictionInputSeq: 4,
      queuedDisplayFrames: 5,
      visiblePredictionInputSeqs: [0, 9],
      visiblePredictionInputSeqsTruncated: false,
      completionMode: 'gpu-queue',
      atlasUploaded: false,
      drainedDisplay: false,
    });

    expect(decoded).toMatchObject({
      visiblePredictionInputSeqs: [],
      visiblePredictionInputSeqsTruncated: true,
    });
  });

  test('a repeated string is interned once and resolves for every record', () => {
    const decoded = roundTrip([
      { kind: 'session_start', atMs: 1 },
      { kind: 'session_start', atMs: 2 },
      { kind: 'session_start', atMs: 3 },
    ]);
    expect(decoded).toEqual([
      { kind: 'session_start', atMs: 1 },
      { kind: 'session_start', atMs: 2 },
      { kind: 'session_start', atMs: 3 },
    ]);
  });

  test('a string is readable by the resolver as soon as its record is', () => {
    // The ordering property the shared table exists for: with a postMessage
    // side channel the record can be drained before the string lands, and an
    // unresolvable record is dropped — losing precisely the session-start and
    // startup events that only happen once.
    const table = createPerfStringTableBuffer();
    const interner = createPerfStringInterner(table);
    const resolver = createPerfStringResolver(table);
    expect(resolver.resolve(interner.intern('device-1'))).toBe('device-1');
  });

  test('an exhausted string table drops new values rather than repointing live ids', () => {
    const table = createPerfStringTableBuffer();
    const interner = createPerfStringInterner(table);
    const resolver = createPerfStringResolver(table);

    const firstId = interner.intern('first');
    for (let index = 1; index < PERF_STRING_TABLE_SLOTS; index += 1) {
      interner.intern(`filler-${index}`);
    }
    // Table is full. Evicting would silently repoint records already written
    // against the evicted id, so the new value is refused instead.
    expect(interner.intern('overflow')).toBe(0);
    expect(resolver.resolve(firstId)).toBe('first');
  });

  test('an unpublished id resolves to null rather than reading stale bytes', () => {
    const table = createPerfStringTableBuffer();
    const resolver = createPerfStringResolver(table);
    expect(resolver.resolve(1)).toBeNull();
    expect(resolver.resolve(0)).toBeNull();
  });

  // Bun's TextDecoder accepts a SharedArrayBuffer-backed view; the browser's
  // rejects it outright. This table is shared by construction, so a resolver
  // that decodes the subarray in place works here and throws in Chrome — inside
  // the telemetry worker's drain, which kills the worker on its first tick and
  // leaves `dump` unanswered forever. Nothing in this suite would notice, so
  // this test supplies the constraint the runtime does not.
  test('resolving does not hand shared memory to TextDecoder', () => {
    const table = createPerfStringTableBuffer();
    const interner = createPerfStringInterner(table);
    const id = interner.intern('shared-decode-guard');

    const RealTextDecoder = globalThis.TextDecoder;
    class SharedRejectingTextDecoder extends RealTextDecoder {
      override decode(input?: AllowSharedBufferSource): string {
        const buffer =
          input instanceof ArrayBuffer || input instanceof SharedArrayBuffer
            ? input
            : input?.buffer;
        if (buffer instanceof SharedArrayBuffer) {
          throw new TypeError(
            "Failed to execute 'decode' on 'TextDecoder': The provided ArrayBufferView value must not be shared.",
          );
        }
        return super.decode(input as BufferSource | undefined);
      }
    }

    globalThis.TextDecoder = SharedRejectingTextDecoder as typeof globalThis.TextDecoder;
    try {
      expect(createPerfStringResolver(table).resolve(id)).toBe('shared-decode-guard');
    } finally {
      globalThis.TextDecoder = RealTextDecoder;
    }
  });

  test('an unknown record kind decodes to null rather than a plausible event', () => {
    const sab = createPerfRingBuffer(4);
    const writer = createPerfRingWriter(sab);
    const reader = createPerfRingReader(sab);
    writer.begin(9_999);
    writer.commit();

    const decoded: (TerminalPerfEvent | null)[] = [];
    reader.drain((record) =>
      decoded.push(
        decodePerfEvent(record, createPerfStringResolver(createPerfStringTableBuffer())),
      ),
    );
    expect(decoded).toEqual([null]);
  });
});

/**
 * Trace context must not consume the interning table.
 *
 * The string table is `PERF_STRING_TABLE_SLOTS` entries with **no eviction**, sized for the
 * handful of genuinely free-form values a session produces — a session id, a device id, a
 * disconnect reason. A trace and span id are fixed-width hex, so they are numbers, and a
 * fresh trace is minted for *every connect attempt*.
 *
 * Interning them would therefore exhaust the table after that many reconnects and silently
 * drop every startup milestone from then on — the profiling equivalent of going blind after
 * a long session. This asserts they are packed as words instead.
 */
test('a distinct trace per attempt never exhausts the string table', () => {
  const attempts = PERF_STRING_TABLE_SLOTS * 4;
  const events: TerminalPerfEvent[] = [];
  for (let index = 0; index < attempts; index += 1) {
    events.push({
      kind: 'startup_milestone',
      atMs: 1_000 + index,
      attemptId: index,
      // One device, as in reality: this is the only string here, and it interns once.
      deviceId: 'device-a',
      milestone: 'device_selected',
      elapsedMs: 0,
      traceId: index.toString(16).padStart(32, '0'),
      spanId: index.toString(16).padStart(16, '0'),
    });
  }

  // A ring large enough that overflow cannot be mistaken for table exhaustion: this test is
  // about the string table, and the default round-trip ring holds only 64 records.
  const sab = createPerfRingBuffer(attempts * 2);
  const writer = createPerfRingWriter(sab);
  const reader = createPerfRingReader(sab);
  const table = createPerfStringTableBuffer();
  const resolver = createPerfStringResolver(table);
  const interner = createPerfStringInterner(table);
  for (const event of events) {
    encodePerfEvent(writer, interner, event);
  }
  const decoded: (TerminalPerfEvent | null)[] = [];
  reader.drain((record) => {
    decoded.push(decodePerfEvent(record, resolver));
  });

  expect(decoded).toHaveLength(attempts);
  decoded.forEach((event, index) => {
    expect(event).not.toBeNull();
    if (event?.kind !== 'startup_milestone') throw new Error('wrong kind');
    expect(event.traceId).toBe(index.toString(16).padStart(32, '0'));
    expect(event.spanId).toBe(index.toString(16).padStart(16, '0'));
  });
});

test('trace and span ids round-trip byte-exactly', () => {
  const [decoded] = roundTrip([
    {
      kind: 'startup_milestone',
      atMs: 1_000,
      attemptId: 1,
      deviceId: 'device-a',
      milestone: 'first_display_visible',
      elapsedMs: 600,
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
    },
  ]);

  if (decoded?.kind !== 'startup_milestone') throw new Error('wrong kind');
  expect(decoded.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
  expect(decoded.spanId).toBe('b7ad6b7169203331');
});

test('presentation release disable bits round-trip without changing packed presentation flags', () => {
  const sample = SAMPLES.find((event) => event.kind === 'presentation_commit');
  if (sample?.kind !== 'presentation_commit') throw new Error('missing presentation fixture');
  for (const bits of [0, 1, 2, 4, 8, 16, 32, 64, 128, 255]) {
    const event = { ...sample, membershipReleaseDisableBits: bits };
    expect(roundTripOne(event)).toEqual(event);
  }
  const ring = createPerfRingBuffer(16);
  const writer = createPerfRingWriter(ring);
  const strings = createPerfStringInterner(createPerfStringTableBuffer());
  for (const bits of [-1, 256, 1.5, Number.NaN]) {
    expect(
      encodePerfEvent(writer, strings, { ...sample, membershipReleaseDisableBits: bits }),
    ).toBe(false);
  }
  const missing = { ...sample };
  Reflect.deleteProperty(missing, 'membershipReleaseDisableBits');
  expect(encodePerfEvent(writer, strings, missing)).toBe(false);
  expect(writer.writtenCount).toBe(0);
});
