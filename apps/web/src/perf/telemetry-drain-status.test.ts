import { describe, expect, test } from 'bun:test';
import {
  appendBoundedTelemetryPending,
  createTelemetryDrainActivityTracker,
  createTelemetryRetainedEventRing,
} from './telemetry-drain-status';
import type { GraphicsAssetPhase, TerminalPerfEvent } from './terminal-latency';

describe('telemetry drain activity status', () => {
  test('tracks presentation activity and its authoritative GPU fence incrementally', () => {
    const tracker = createTelemetryDrainActivityTracker(7, 100);
    tracker.observe(displayApplied(110, 1));
    tracker.observe(presentationCommit(120, 9, true));
    tracker.observe(frameComplete(130, 9));

    expect(tracker.snapshot()).toEqual({
      observationEpoch: 7,
      observationStartedAtMs: 100,
      activityRevision: 3,
      activityEventCount: 3,
      latestActivityAtMs: 130,
      pendingAuthoritativeRenderCount: 0,
      trackingOverflow: false,
      graphicsAsset: {
        eventCount: 0,
        open: 0,
        demanded: 0,
        requested: 0,
        firstByte: 0,
        fin: 0,
        published: 0,
        consumed: 0,
        retired: 0,
        failed: 0,
      },
      // The fenced authoritative commit carried input 1's barrier.
      input: {
        queuedCount: 0,
        queuedSeq: 0,
        ackedSeq: 0,
        ackAtMs: 0,
        fencedSeq: 1,
        fenceAtMs: 130,
      },
    });
  });

  test('an input completes on the first ACK and the first authoritative fence that cover it', () => {
    const tracker = createTelemetryDrainActivityTracker(1, 100);
    tracker.observe(inputQueued(101, 7));
    tracker.observe(inputAck(140, 6));
    // A header-only commit advertises the barrier without an authoritative
    // upload, and a fence of a render nobody committed retires nothing.
    tracker.observe(presentationCommit(150, 4, false, 7));
    tracker.observe(frameComplete(151, 4));
    tracker.observe(frameComplete(152, 99));
    // An authoritative commit whose barrier stops short of the input.
    tracker.observe(presentationCommit(153, 5, true, 6));
    tracker.observe(frameComplete(154, 5));
    expect(tracker.snapshot().input).toEqual({
      queuedCount: 1,
      queuedSeq: 7,
      ackedSeq: 6,
      ackAtMs: 140,
      fencedSeq: 6,
      fenceAtMs: 154,
    });

    tracker.observe(inputAck(160, 7));
    // The other transport's copy of the same ACK arrives later.
    tracker.observe(inputAck(161, 7));
    tracker.observe(presentationCommit(170, 6, true, 7));
    expect(tracker.snapshot().input.fencedSeq).toBe(6);
    tracker.observe(frameComplete(180, 6));
    expect(tracker.snapshot()).toMatchObject({
      // Queue and ACK events restart no quiet interval; commits and fences do.
      activityEventCount: 5,
      input: {
        queuedCount: 1,
        queuedSeq: 7,
        ackedSeq: 7,
        ackAtMs: 160,
        fencedSeq: 7,
        fenceAtMs: 180,
      },
    });
  });

  test('a replacement commit carries the fence frontier, never the render it retired', () => {
    const tracker = createTelemetryDrainActivityTracker(1, 100);
    tracker.observe(inputQueued(101, 3));
    tracker.observe(presentationCommit(110, 4, true, 3));
    tracker.observe(presentationCommit(111, 5, true, 3));
    tracker.observe(frameComplete(112, 4));
    expect(tracker.snapshot().input).toMatchObject({ fencedSeq: 0, fenceAtMs: 0 });
    tracker.observe(frameComplete(113, 5));
    expect(tracker.snapshot().input).toMatchObject({ fencedSeq: 3, fenceAtMs: 113 });
  });

  test('each input high-water advances in serial order across the u32 wrap; reset clears it', () => {
    const tracker = createTelemetryDrainActivityTracker(1, 100);
    tracker.observe(inputQueued(101, 0xffff_ffff));
    tracker.observe(inputQueued(102, 1));
    tracker.observe(inputAck(110, 0xffff_ffff));
    tracker.observe(inputAck(111, 1));
    tracker.observe(inputAck(112, 0xffff_ffff));
    tracker.observe(presentationCommit(120, 8, true, 0xffff_ffff));
    tracker.observe(frameComplete(121, 8));
    tracker.observe(presentationCommit(122, 9, true, 1));
    tracker.observe(frameComplete(123, 9));
    expect(tracker.snapshot().input).toEqual({
      queuedCount: 2,
      queuedSeq: 1,
      ackedSeq: 1,
      ackAtMs: 111,
      fencedSeq: 1,
      fenceAtMs: 123,
    });

    tracker.reset(2, 200);
    tracker.observe(inputQueued(150, 2));
    expect(tracker.snapshot().input).toEqual({
      queuedCount: 0,
      queuedSeq: 0,
      ackedSeq: 0,
      ackAtMs: 0,
      fencedSeq: 0,
      fenceAtMs: 0,
    });
  });

  test('counts every graphics job transition and holds a job open until it retires', () => {
    const tracker = createTelemetryDrainActivityTracker(1, 100);
    tracker.observe(graphicsAsset(99, 'demanded', 1));
    const lifecycle = [
      'demanded',
      'requested',
      'first_byte',
      'fin',
      'published',
      'consumed',
    ] as const;
    for (const [index, phase] of lifecycle.entries()) {
      tracker.observe(graphicsAsset(101 + index, phase, 2));
    }
    expect(tracker.snapshot().graphicsAsset).toEqual({
      eventCount: 6,
      open: 1,
      demanded: 1,
      requested: 1,
      firstByte: 1,
      fin: 1,
      published: 1,
      consumed: 1,
      retired: 0,
      failed: 0,
    });
    tracker.observe(graphicsAsset(110, 'retired', 2));
    tracker.observe(graphicsAsset(111, 'demanded', 3));
    for (const phase of [
      'refused',
      'unavailable',
      'cancelled',
      'interrupted',
      'resumed',
    ] as const) {
      tracker.observe(graphicsAsset(112, phase, 3));
    }
    tracker.observe({ ...graphicsAsset(113, 'retired', 3), failed: true });
    expect(tracker.snapshot()).toMatchObject({
      // Asset transitions never restart the presentation quiet interval.
      activityEventCount: 0,
      graphicsAsset: { eventCount: 14, open: 0, demanded: 2, retired: 2, failed: 5 },
    });

    tracker.reset(2, 200);
    expect(tracker.snapshot().graphicsAsset).toMatchObject({ eventCount: 0, open: 0, failed: 0 });
  });

  test('ignores pre-boundary and continuous non-presentation diagnostics', () => {
    const tracker = createTelemetryDrainActivityTracker(3, 500);
    tracker.observe(displayApplied(499, 1));
    tracker.observe({
      kind: 'main_frame_cadence',
      atMs: 501,
      gapMs: 8,
      longTaskObserverSupported: true,
    });
    expect(tracker.snapshot().activityEventCount).toBe(0);
  });

  test('reset changes lineage exactly and drops retired renderer membership', () => {
    const tracker = createTelemetryDrainActivityTracker(1, 0);
    tracker.observe(presentationCommit(10, 4, true));
    expect(tracker.snapshot().pendingAuthoritativeRenderCount).toBe(1);

    tracker.reset(2, 20);
    tracker.observe(frameComplete(21, 4));
    tracker.observe(displayApplied(22, 2));
    expect(tracker.snapshot()).toMatchObject({
      observationEpoch: 2,
      observationStartedAtMs: 20,
      activityRevision: 1,
      activityEventCount: 1,
      latestActivityAtMs: 22,
      pendingAuthoritativeRenderCount: 0,
    });
  });

  test('an epoch replacement itself restarts quiet after clearing retired renders', () => {
    const tracker = createTelemetryDrainActivityTracker(1, 0);
    tracker.observe(presentationCommit(10, 4, true));
    tracker.observe({ kind: 'presentation_epoch_boundary', atMs: 20, epoch: 2, preserved: false });
    expect(tracker.snapshot()).toMatchObject({
      activityRevision: 2,
      activityEventCount: 2,
      latestActivityAtMs: 20,
      pendingAuthoritativeRenderCount: 0,
    });
  });

  test('a replacement commit retires the superseded single renderer gate', () => {
    const tracker = createTelemetryDrainActivityTracker(1, 0);
    tracker.observe(presentationCommit(10, 4, true));
    tracker.observe(presentationCommit(11, 5, true));

    tracker.observe(frameComplete(12, 4));
    expect(tracker.snapshot().pendingAuthoritativeRenderCount).toBe(1);

    tracker.observe(frameComplete(13, 5));
    expect(tracker.snapshot()).toMatchObject({
      activityRevision: 3,
      activityEventCount: 3,
      latestActivityAtMs: 13,
      pendingAuthoritativeRenderCount: 0,
    });
  });

  test('status payload shape stays fixed as the cumulative trace grows', () => {
    const tracker = createTelemetryDrainActivityTracker(1, 0);
    const emptyKeys = Object.keys(tracker.snapshot()).sort();
    for (let index = 0; index < 100_000; index += 1) {
      tracker.observe(displayApplied(index + 1, (index % 0xffff_fffe) + 1));
    }
    const status = tracker.snapshot();
    expect(Object.keys(status).sort()).toEqual(emptyKeys);
    expect(Object.values(status).some(Array.isArray)).toBe(false);
    expect(JSON.stringify(status).length).toBeLessThan(512);
    expect(status.activityEventCount).toBe(100_000);
  });
});

/**
 * The daemon read a key's echo before it had confirmed the key's write: the
 * echo frame carries the older input barrier and the newer echo horizon, and a
 * header-only frame raises the barrier afterwards.
 */
describe('an echo read before its write was confirmed', () => {
  const PREVIOUS = 1428;
  const KEY = 1429;

  function tracked() {
    const tracker = createTelemetryDrainActivityTracker(1, 0);
    tracker.observe(inputQueued(10, KEY));
    tracker.observe(inputAck(11, KEY));
    // The echo: one visual row under the older barrier, committed.
    tracker.observe(displayApplied(11.3, 2102, PREVIOUS));
    tracker.observe(presentationCommit(11.4, 4374, true, PREVIOUS, KEY));
    return tracker;
  }

  test('completes at the fence when the barrier was raised before it', () => {
    const tracker = tracked();
    tracker.observe(displayApplied(11.5, 2103, KEY));
    expect(tracker.snapshot().input).toMatchObject({ fencedSeq: 0 });

    tracker.observe(frameComplete(12.2, 4374));
    expect(tracker.snapshot().input).toMatchObject({ fencedSeq: KEY, fenceAtMs: 12.2 });
  });

  test('completes at the frame that raises the barrier when the echo was already fenced', () => {
    const tracker = tracked();
    tracker.observe(frameComplete(12.2, 4374));
    expect(tracker.snapshot().input).toMatchObject({ fencedSeq: PREVIOUS, fenceAtMs: 12.2 });

    tracker.observe(displayApplied(12.6, 2103, KEY));
    expect(tracker.snapshot().input).toMatchObject({ fencedSeq: KEY, fenceAtMs: 12.6 });
  });

  test('a raised barrier completes nothing that no fenced pixels could answer', () => {
    const tracker = createTelemetryDrainActivityTracker(1, 0);
    // The ordinary order: the header-only frame first, the echo after it.
    tracker.observe(displayApplied(10, 2100, PREVIOUS));
    tracker.observe(presentationCommit(10.1, 4372, true, PREVIOUS));
    tracker.observe(frameComplete(10.9, 4372));
    tracker.observe(inputQueued(11, KEY));
    tracker.observe(displayApplied(11.2, 2101, KEY));
    expect(tracker.snapshot().input).toMatchObject({ fencedSeq: PREVIOUS, fenceAtMs: 10.9 });

    tracker.observe(displayApplied(11.3, 2102, KEY));
    tracker.observe(presentationCommit(11.4, 4373, true, KEY));
    tracker.observe(frameComplete(12, 4373));
    expect(tracker.snapshot().input).toMatchObject({ fencedSeq: KEY, fenceAtMs: 12 });
  });

  test('pixels an epoch boundary replaced answer nothing confirmed after it', () => {
    const tracker = tracked();
    tracker.observe(frameComplete(12.2, 4374));
    tracker.observe({
      kind: 'presentation_epoch_boundary',
      atMs: 12.4,
      epoch: 2,
      preserved: false,
    });
    tracker.observe(displayApplied(12.6, 2103, KEY));
    expect(tracker.snapshot().input).toMatchObject({ fencedSeq: PREVIOUS });
  });
});

describe('telemetry pending egress queue', () => {
  test('refuses additional copies at fixed capacity while retained input can keep growing', () => {
    const pending: number[] = [];
    let refused = 0;
    for (let value = 0; value < 100_000; value += 1) {
      if (!appendBoundedTelemetryPending(pending, value, 4)) refused += 1;
    }
    expect(pending).toEqual([0, 1, 2, 3]);
    expect(refused).toBe(99_996);
  });
});

describe('telemetry retained event ring', () => {
  test('append cost and storage remain capacity-bounded until an explicit snapshot', () => {
    const ring = createTelemetryRetainedEventRing<number>(4);
    let evictions = 0;
    for (let value = 0; value < 100_000; value += 1) {
      if (ring.push(value)) evictions += 1;
    }
    expect(ring.size).toBe(4);
    expect(evictions).toBe(99_996);
    expect(ring.snapshot()).toEqual([99_996, 99_997, 99_998, 99_999]);
  });

  test('compacts an exact post-boundary suffix and releases it explicitly', () => {
    const ring = createTelemetryRetainedEventRing<{ atMs: number; id: number }>(5);
    for (let id = 0; id < 5; id += 1) ring.push({ atMs: 98 + id, id });

    ring.retain((event) => event.atMs >= 100);
    expect(ring.snapshot()).toEqual([
      { atMs: 100, id: 2 },
      { atMs: 101, id: 3 },
      { atMs: 102, id: 4 },
    ]);
    expect(ring.push({ atMs: 103, id: 5 })).toBe(false);
    expect(ring.snapshot().map((event) => event.id)).toEqual([2, 3, 4, 5]);

    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.snapshot()).toEqual([]);
  });
});

function displayApplied(atMs: number, displaySeq: number, inputSeq = 1): TerminalPerfEvent {
  return {
    kind: 'worker_display_applied',
    atMs,
    displaySeq,
    generation: 1,
    inputSeq,
    frameId: displaySeq,
    chunkIndex: 0,
    chunkCount: 1,
    presentationId: displaySeq,
    presentationMemberIndex: 0,
    presentationMemberCount: 1,
    rowPredecessorPresentationId: 0,
    presentationTransactionSeq: displaySeq,
    presentationCoherent: true,
    presentationEnd: true,
    fecRecovered: false,
    authoritativeVisualMutation: true,
    workerReceiptToDecodeMs: null,
    decodeToApplyMs: 0.1,
    byteLength: 32,
    rowCount: 1,
    displayKind: 'display_delta',
  };
}

function inputQueued(atMs: number, inputSeq: number): TerminalPerfEvent {
  return { kind: 'input_queued', atMs, admittedAtMs: atMs, inputSeq, byteLength: 1 };
}

function inputAck(atMs: number, inputSeq: number): TerminalPerfEvent {
  return { kind: 'input_ack', atMs, inputSeq, networkRttMs: 120 };
}

function presentationCommit(
  atMs: number,
  renderSeq: number,
  authoritativeVisualChange: boolean,
  displayInputSeq = 1,
  displayEchoHorizonSeq = displayInputSeq,
): TerminalPerfEvent {
  return {
    kind: 'presentation_commit',
    atMs,
    releaseFrameTimeMs: atMs,
    releaseFrameCount: 1,
    membershipReleaseDisableBits: 0,
    transactionSeq: renderSeq,
    renderSeq,
    generation: 1,
    firstDisplaySeq: renderSeq,
    lastDisplaySeq: renderSeq,
    displayInputSeq,
    displayEchoHorizonSeq,
    firstPresentationId: renderSeq,
    lastPresentationId: renderSeq,
    firstApplyToCommitMs: 1,
    lastApplyToCommitMs: 1,
    deadlineOverrunMs: 0,
    refreshPeriodMs: 16.67,
    datagramCount: 1,
    rowCount: 1,
    byteLength: 32,
    queueHighWater: 1,
    coherent: true,
    endSeen: true,
    authoritativeVisualChange,
    reason: 'group-end-vsync',
  };
}

function frameComplete(atMs: number, renderSeq: number): TerminalPerfEvent {
  return {
    kind: 'frame_complete',
    completionDisposition: 'latest-submitted',
    atMs,
    renderSeq,
    displayInputSeq: 1,
    predictionInputSeq: 0,
    queuedDisplayFrames: 0,
    visiblePredictionInputSeqs: [],
    visiblePredictionInputSeqsTruncated: false,
    pollCount: 0,
    previousPollAtMs: 0,
  };
}

function graphicsAsset(
  atMs: number,
  phase: GraphicsAssetPhase,
  jobId: number,
): Extract<TerminalPerfEvent, { kind: 'graphics_asset' }> {
  return {
    kind: 'graphics_asset',
    atMs,
    phase,
    jobId,
    bytes: phase === 'fin' ? 1_024 : 0,
    failed: false,
  };
}
