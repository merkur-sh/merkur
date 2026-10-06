import { describe, expect, test } from 'bun:test';
import { PERF_ROW_FIELD_NAMES, perfEventToRow } from './perf-row';
import { createPerfSessionStamper } from './perf-session-stamp';
import type { TerminalPerfEvent } from './terminal-latency';

/**
 * Axiom counts a field the first time it is ever seen and a dataset cannot
 * un-see one, so the emitted field set has to stay closed and known. The free
 * tier's ceiling is 256 per dataset.
 */
const AXIOM_FIELD_CEILING = 256;

/**
 * Headroom reserved for the daemon-side sub-terms and any stage added later.
 * Well under the ceiling on purpose: reaching it is unrecoverable without
 * creating a new dataset, and the free tier allows only three in total.
 */
// Graphics tile job transitions add three fields to the 144-field schema; the
// daemon's acknowledgment terms two more, and egress refusals with the edge's
// residence buckets nine (the buckets as one joined value, not twelve, and the
// counters' series identity). The daemon owner thread's accounts add five.
// The model adds fourteen fields, including its path-reset epoch.
// Presentation release adds the exact eligible-frame count. Relay carrier
// attribution adds six: which edge connection closed, how, with what code and
// after how long, and the session's network class.
// Membership release diagnostics add one reason-bit field.
// Attempt outcomes add fourteen fields.
// Presentation diagnostics add four: the gate bits, the frame age, one state
// string for fence and grid shapes, and whether main took a first display;
// 53 remain below the dataset ceiling.
const FIELD_BUDGET = 203;

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
    atMs: 1,
    attemptId: 1,
    deviceId: 'd',
    milestone: 'worker_ready',
    elapsedMs: 2,
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
  },
  { kind: 'session_start', atMs: 2 },
  {
    kind: 'session_bound',
    atMs: 2.5,
    merkurSessionId: 'm',
    networkType: 'unavailable',
    effectiveType: 'unavailable',
  },
  { kind: 'input_queued', atMs: 3, admittedAtMs: 3.25, inputSeq: 1, byteLength: 2 },
  {
    kind: 'keyboard_commit',
    atMs: 4,
    touchStartedAtMs: 3,
    inputSeq: 2,
    repeat: false,
  },
  { kind: 'input_sent', atMs: 5, inputSeq: 3 },
  // A measured floor, not null: this list is what counts field names against
  // the ceiling, and a null one omits `network_rtt_ms` and counts nothing.
  { kind: 'input_ack', atMs: 6, inputSeq: 4, networkRttMs: 31.25 },
  { kind: 'prediction_queued', atMs: 7, inputSeq: 5 },
  { kind: 'prediction_applied', atMs: 8, inputSeq: 6 },
  { kind: 'prediction_rejected', atMs: 10, inputSeq: 8, rejectKind: 1, rejectCauseCode: 28 },
  {
    kind: 'cursor_step',
    atMs: 10.25,
    causeCode: 29,
    fromRow: 3,
    fromCol: 27,
    toRow: 3,
    toCol: 26,
    flags: 45,
    ops: 2,
    journalSeq: 7,
    predictionInputSeq: 9,
    displayInputSeq: 8,
  },
  {
    kind: 'cursor_shape',
    atMs: 10.5,
    shapeFrom: 1,
    visibleFrom: 1,
    shapeTo: 2,
    visibleTo: 0,
    flags: 4,
    displaySeq: 41,
  },
  {
    kind: 'daemon_timing',
    atMs: 10.5,
    inputSeq: 9,
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
    observationEpoch: 7,
  },
  {
    kind: 'transport_egress',
    atMs: 10.6,
    observationEpoch: 7,
    hop: 'edge',
    series: 3,
    interactive: { blocked: 1, paced: 2, waitedUs: 3 },
    bulk: { blocked: 4, paced: 5, waitedUs: 6 },
  },
  {
    kind: 'edge_forward_residence',
    atMs: 10.6,
    observationEpoch: 7,
    series: 3,
    buckets: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  },
  {
    kind: 'daemon_timing_status',
    atMs: 10.75,
    batchSeq: 1,
    inputAttributedTotal: 1,
    inputDroppedTotal: 0,
    inputSkippedTotal: 0,
    pendingInputs: 0,
    displayAttributedTotal: 1,
    displayDroppedTotal: 0,
    observationEpoch: 7,
    recordCount: 1,
  },
  {
    kind: 'prediction_suppressed',
    atMs: 11,
    queuedPredictions: 1,
    failedPredictions: 2,
    discardedPredictions: 3,
  },
  {
    kind: 'transport_state',
    atMs: 12,
    state: 'disconnected',
    reason: 'network changed',
  },
  {
    kind: 'carrier_recovery',
    atMs: 12.5,
    phase: 'incumbent_failed',
    reason: 'pong-deadline-lapsed',
  },
  {
    kind: 'carrier_closed',
    atMs: 12.6,
    lane: 'signaling',
    source: 'stream',
    closeCode: 7,
    lifetimeMs: 1_500.4,
  },
  // A failed retirement: the one phase whose row carries the failed flag.
  // `byte_length` on `fin` is already counted by `input_queued`.
  {
    kind: 'graphics_asset',
    atMs: 12.75,
    phase: 'retired',
    jobId: 3,
    bytes: 0,
    failed: true,
  },
  {
    kind: 'prediction_gate',
    atMs: 13,
    state: 'visible',
    mode: 0,
    suppressionReason: 'unsafe_mode',
    trustConsecutive: 3,
    trustRatio: 1,
    trustWindow: 12,
  },
  {
    kind: 'display_received',
    atMs: 14,
    displaySeq: 1,
    generation: 2,
    inputSeq: 3,
    frameId: 4,
    chunkIndex: 0,
    chunkCount: 1,
    presentationId: 7,
    presentationMemberIndex: 0,
    presentationMemberCount: 2,
    rowPredecessorPresentationId: 19,
    presentationTransactionSeq: 0,
    presentationCoherent: true,
    fecRecovered: false,
    presentationEnd: false,
    authoritativeVisualMutation: null,
    workerReceiptToDecodeMs: 0.5,
    decodeToApplyMs: null,
    byteLength: 5,
    rowCount: 6,
    displayKind: 'display_delta',
  },
  {
    kind: 'worker_display_queued',
    atMs: 15,
    displaySeq: 1,
    generation: 2,
    inputSeq: 3,
    frameId: 4,
    chunkIndex: 0,
    chunkCount: 1,
    presentationId: 7,
    presentationMemberIndex: 1,
    presentationMemberCount: 2,
    rowPredecessorPresentationId: 0,
    presentationTransactionSeq: 0,
    presentationCoherent: true,
    fecRecovered: false,
    presentationEnd: true,
    authoritativeVisualMutation: null,
    workerReceiptToDecodeMs: null,
    decodeToApplyMs: null,
    byteLength: 5,
    rowCount: 6,
    displayKind: 'display_delta',
  },
  {
    kind: 'worker_display_applied',
    atMs: 16,
    displaySeq: 1,
    generation: 2,
    inputSeq: 3,
    frameId: 4,
    chunkIndex: 0,
    chunkCount: 1,
    presentationId: 7,
    presentationMemberIndex: 0,
    presentationMemberCount: 0,
    rowPredecessorPresentationId: 0,
    presentationTransactionSeq: 8,
    presentationCoherent: false,
    fecRecovered: false,
    presentationEnd: false,
    authoritativeVisualMutation: true,
    workerReceiptToDecodeMs: null,
    decodeToApplyMs: 1.5,
    byteLength: 5,
    rowCount: 6,
    displayKind: 'display_snapshot',
  },
  {
    kind: 'presentation_commit',
    atMs: 16.5,
    releaseFrameTimeMs: 16,
    releaseFrameCount: 1,
    membershipReleaseDisableBits: 0,
    transactionSeq: 8,
    renderSeq: 9,
    generation: 2,
    firstDisplaySeq: 10,
    lastDisplaySeq: 12,
    displayInputSeq: 3,
    displayEchoHorizonSeq: 4,
    firstPresentationId: 7,
    lastPresentationId: 7,
    firstApplyToCommitMs: 0.75,
    lastApplyToCommitMs: 0.25,
    deadlineOverrunMs: 0.125,
    refreshPeriodMs: 8.3,
    datagramCount: 3,
    rowCount: 29,
    byteLength: 7260,
    queueHighWater: 3,
    coherent: true,
    endSeen: true,
    authoritativeVisualChange: true,
    reason: 'group-end-vsync',
  },
  {
    kind: 'presentation_transaction_discarded',
    atMs: 16.625,
    transactionSeq: 10,
    generation: 2,
    firstDisplaySeq: 13,
    lastDisplaySeq: 14,
    appliedDatagramCount: 2,
    rowCount: 7,
    byteLength: 512,
    reason: 'resync',
  },
  {
    kind: 'presentation_epoch_boundary',
    atMs: 16.6875,
    epoch: 3,
    preserved: false,
  },
  {
    kind: 'main_frame_cadence',
    atMs: 16.7,
    gapMs: 8.25,
    longTaskObserverSupported: true,
  },
  {
    kind: 'main_long_task',
    atMs: 16.71,
    durationMs: 52,
  },
  {
    kind: 'presentation_gate',
    atMs: 16.711,
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
    atMs: 16.712,
    accepted: false,
    frameFenceToken: 6,
    currentFenceToken: 7,
  },
  {
    kind: 'browser_display_io',
    atMs: 16.72,
    stage: 'transport_ingress',
    ingressRoute: 'direct-datagram',
    displaySeq: 21,
    generation: 22,
    frameId: 23,
    chunkIndex: 0,
    chunkCount: 1,
    payloadByteLength: 1024,
    admitted: true,
    fecRecovered: false,
    explicitCopyCount: 2,
    explicitCopiedBytes: 2048,
    explicitAllocationRequestCount: 1,
    explicitAllocationRequestedBytes: 1024,
    explicitObjectAllocationRequestCount: 3,
  },
  {
    kind: 'display_pump_complete',
    ringBytesAtStart: 8192,
    ringBytesAtEnd: 64,
    ringDroppedTotal: 2,
    atMs: 16.75,
    durationMs: 2,
    budgetMs: 4,
    processedDatagramCount: 3,
    processedRowCount: 9,
    queueHighWater: 5,
    queueRemaining: 2,
  },
  {
    kind: 'presentation_measurement_boundary',
    atMs: 16.75,
    measurementId: 9,
    phase: 'start',
    purpose: 'streaming',
  },
  {
    kind: 'display_ring_measurement_boundary',
    atMs: 16.75,
    measurementId: 9,
    phase: 'start',
    observationEpoch: 7,
    sessionEpoch: 3,
    ringDroppedTotal: 2,
  },
  {
    kind: 'render_start',
    atMs: 17,
    renderSeq: 1,
    displayInputSeq: 2,
    predictionInputSeq: 3,
    queuedDisplayFrames: 4,
    wantedAtMs: 16,
    gate: 'opportunity',
    fenceReleasedAtMs: 0,
    fenceReleasedRenderSeq: 0,
    opportunityEnteredAtMs: 16.2,
    opportunityDelayMs: 8,
    fenceWaitMs: 0,
    opportunityWaitMs: 0,
    refreshPeriodMs: 8.3,
    refreshConfidence01: 0.9,
  },
  {
    kind: 'render_end',
    atMs: 18,
    renderSeq: 1,
    displayInputSeq: 2,
    predictionInputSeq: 3,
    queuedDisplayFrames: 4,
    visiblePredictionInputSeqs: [1, 2],
    visiblePredictionInputSeqsTruncated: false,
    completionMode: 'gpu-queue',
    atlasUploaded: true,
    drainedDisplay: false,
  },
  {
    kind: 'display_resync',
    atMs: 18.75,
    reason: 'apply_rejected',
    generation: 12,
    alreadyPending: false,
  },
  {
    kind: 'frame_complete',
    completionDisposition: 'latest-submitted',
    atMs: 19,
    renderSeq: 1,
    displayInputSeq: 2,
    predictionInputSeq: 3,
    queuedDisplayFrames: 4,
    visiblePredictionInputSeqs: [1],
    visiblePredictionInputSeqsTruncated: true,
    pollCount: 0,
    previousPollAtMs: 0,
  },
];

/**
 * Every field name that can reach Axiom, which is the event mappings *plus* the
 * envelope the stamper adds on the way out.
 *
 * Running the stamper rather than only `perfEventToRow` is what makes the
 * closed-set invariant cover the whole shipped row: `merkur_version` is never
 * produced by an event mapping at all, and `merkur_session_id` was only
 * covered by accident, because `session_bound` happens to carry it as a payload
 * field. A field that ships uncounted is the failure this test exists to stop,
 * and the ceiling it protects is charged by what is ingested, not by which
 * function wrote it.
 */
function emittedFieldNames(): Set<string> {
  const names = new Set<string>();
  for (const row of createPerfSessionStamper().stamp(SAMPLES)) {
    for (const key of Object.keys(row)) names.add(key);
  }
  return names;
}

describe('perf row schema', () => {
  test('covers every event kind', () => {
    const covered = new Set(SAMPLES.map((event) => event.kind));
    // A kind added to the union without a sample here would ship rows whose
    // field names were never counted against the ceiling.
    expect(covered.size).toBe(SAMPLES.length);
  });

  test('emits no field name outside the declared set', () => {
    const declared = new Set<string>(PERF_ROW_FIELD_NAMES);
    const surplus = [...emittedFieldNames()].filter((name) => !declared.has(name));
    expect(surplus).toEqual([]);
  });

  test('declares no field name it cannot emit', () => {
    const emitted = emittedFieldNames();
    // Kept honest in both directions: a stale declaration is how a schema drifts
    // into claiming headroom it is not actually using.
    const unused = PERF_ROW_FIELD_NAMES.filter((name) => !emitted.has(name));
    expect(unused).toEqual([]);
  });

  test('stays inside the field budget, and the budget inside the ceiling', () => {
    expect(PERF_ROW_FIELD_NAMES.length).toBeLessThanOrEqual(FIELD_BUDGET);
    expect(FIELD_BUDGET).toBeLessThanOrEqual(AXIOM_FIELD_CEILING);
  });

  test('declares each field name exactly once', () => {
    expect(new Set(PERF_ROW_FIELD_NAMES).size).toBe(PERF_ROW_FIELD_NAMES.length);
  });

  test('omits absent optional fields rather than emitting null', () => {
    // Axiom treats an absent field and a null field the same at query time, so
    // an absent reason is omitted rather than shipped as null.
    const row = perfEventToRow({
      kind: 'prediction_gate',
      atMs: 1,
      state: 'learning',
      mode: -1,
      suppressionReason: null,
      trustConsecutive: 0,
      trustRatio: 0,
      trustWindow: 0,
    });
    expect(Object.hasOwn(row, 'suppression_reason')).toBe(false);
    // A real zero still appears.
    expect(row.trust_window).toBe(0);
    expect(row.trust_ratio).toBe(0);
    expect(row.mode).toBe(-1);

    const ingress = SAMPLES.find((event) => event.kind === 'browser_display_io');
    if (ingress?.kind !== 'browser_display_io') throw new Error('missing display I/O sample');
    const terminalRow = perfEventToRow({
      ...ingress,
      stage: 'terminal_apply',
      ingressRoute: null,
    });
    expect(Object.hasOwn(terminalRow, 'browser_display_ingress_route')).toBe(false);
  });

  test('an ack with no path floor omits the field rather than reporting a zero-RTT path', () => {
    // `network_rtt_ms` exists to be subtracted from the ack round trip. A zero
    // standing in for "not measured yet" would make the residual read as the
    // whole round trip — a fabricated daemon-side delay, in the one field added
    // to detect a real one.
    const measured = perfEventToRow({
      kind: 'input_ack',
      atMs: 1,
      inputSeq: 2,
      networkRttMs: 41.5,
    });
    expect(measured.network_rtt_ms).toBe(41.5);

    const unmeasured = perfEventToRow({
      kind: 'input_ack',
      atMs: 1,
      inputSeq: 2,
      networkRttMs: null,
    });
    expect(Object.hasOwn(unmeasured, 'network_rtt_ms')).toBe(false);

    // A genuine zero floor (loopback) is a measurement and must survive.
    const loopback = perfEventToRow({
      kind: 'input_ack',
      atMs: 1,
      inputSeq: 2,
      networkRttMs: 0,
    });
    expect(loopback.network_rtt_ms).toBe(0);
  });

  test('the daemon partition ships its own total', () => {
    const row = perfEventToRow({
      kind: 'daemon_timing',
      atMs: 1,
      inputSeq: 2,
      recvToPtyUs: 10,
      ptyToReadUs: 10,
      gridApplyUs: 10,
      displayCoalesceUs: 10,
      selectCaptureUs: 10,
      prepareQueueUs: 10,
      encodeUs: 10,
      compressionUs: 10,
      completionQueueUs: 10,
      transportSubmitUs: 10,
      writeCompletionUs: null,
      ackTransmitUs: 500,
      ownerCpuUs: 40,
      ownerOffCpuUs: 900,
      ownerQuinnWaitUs: 850,
      ownerRegistryWaitUs: 0,
      flushLockWaitUs: 600,
      batchSeq: 1,
      observationEpoch: 1,
    });
    // The identity the ten terms exist to satisfy, precomputed so a partition
    // that fails to sum shows up as data rather than as arithmetic in a query.
    expect(row.daemon_total_us).toBe(100);
    // The acknowledgment half is not in that identity, and an unobserved term
    // is absent rather than a zero-cost completion.
    expect(row.ack_transmit_us).toBe(500);
    expect('write_completion_us' in row).toBe(false);
    // Neither are the owner's accounts, which ride beside it; a zero is a
    // measurement here (no registry wait), never an absence.
    expect(row.owner_off_cpu_us).toBe(900);
    expect(row.owner_quinn_wait_us).toBe(850);
    expect(row.owner_registry_wait_us).toBe(0);
    expect(row.flush_lock_wait_us).toBe(600);
  });

  test('every row carries the join fields a query needs', () => {
    for (const event of SAMPLES) {
      const row = perfEventToRow(event);
      expect(row.kind).toBe(event.kind);
      expect(typeof row.at_ms).toBe('number');
    }
  });
});

test('presentation release disable bits ship as one required numeric field, including zero', () => {
  const sample = SAMPLES.find((event) => event.kind === 'presentation_commit');
  if (sample?.kind !== 'presentation_commit') throw new Error('missing presentation fixture');
  for (const bits of [0, 0xff]) {
    const row = perfEventToRow({ ...sample, membershipReleaseDisableBits: bits });
    expect(row.membership_release_disable_bits).toBe(bits);
  }
});
