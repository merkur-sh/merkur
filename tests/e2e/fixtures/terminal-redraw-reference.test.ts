import { describe, expect, test } from 'bun:test';

import {
  analyzeReferenceRedrawTrace,
  normalizeReferenceTerminalEvents,
  type ReferenceRedrawWindow,
  type ReferenceTerminalEvent,
  referenceDistribution,
} from './terminal-redraw-reference';

const WINDOW: ReferenceRedrawWindow = {
  index: 0,
  readyMarker: 'ready-0',
  finalMarker: 'final-0',
  openedAtMs: 100,
  triggerDispatchCompletedAtMs: 102,
  closedAtMs: 200,
};

describe('terminal redraw reference trace', () => {
  test('measures only GPU completions that cover newly applied authoritative rows', () => {
    const samples = analyzeReferenceRedrawTrace(WINDOWS, [
      input(101, 9),
      received(120, 9, 1, 12),
      applied(121, 9, 1, 12),
      start(122, 9, 1),
      frame(123, 9, 1),
      // No new apply: a cursor/animation frame is not another redraw sub-presentation.
      start(129, 9, 2),
      frame(130, 9, 2),
      received(140, 9, 2, 18),
      applied(141, 9, 2, 18),
      start(148, 9, 3),
      frame(150, 9, 3),
    ]);

    expect(samples).toEqual([
      {
        index: 0,
        inputSeq: 9,
        inputQueuedAtMs: 101,
        windowOpenedAtMs: 100,
        triggerDispatchCompletedAtMs: 102,
        windowClosedAtMs: 200,
        receivedDatagrams: 2,
        appliedDatagrams: 2,
        appliedBytes: 200,
        appliedRows: 30,
        completedAuthoritativeGpuFrames: 2,
        inputToFirstAuthoritativeGpuFenceMs: 22,
        inputToCompletedAuthoritativeGpuFenceMs: 49,
        partialPresentationExposureMs: 27,
        firstDisplayReceiptToCompletedAuthoritativeGpuFenceMs: 30,
        firstGpuFenceObservedAtMs: 123,
        lastGpuFenceObservedAtMs: 150,
      },
    ]);
  });

  test('does not treat render submission or a nonvisual fence as a paint fallback', () => {
    expect(() =>
      analyzeReferenceRedrawTrace(WINDOWS, [
        input(101, 9),
        received(120, 9, 1, 12),
        applied(121, 9, 1, 12),
        start(117, 9, 1),
        frame(119, 9, 1),
      ]),
    ).toThrow('no GPU frame-complete observation covering a row-bearing apply');
  });

  test('fails closed when an apply or its GPU fence lands after the bounded window tail', () => {
    expect(() =>
      analyzeReferenceRedrawTrace(WINDOWS, [
        input(101, 9),
        received(120, 9, 1, 12),
        applied(121, 9, 1, 12),
        start(122, 9, 1),
        frame(123, 9, 1),
        received(210, 9, 2, 18),
        applied(211, 9, 2, 18),
        start(212, 9, 2),
        frame(213, 9, 2),
      ]),
    ).toThrow('authoritative same-input tail 11 ms after close');
  });

  test('requires exactly one in-window trigger input', () => {
    expect(() =>
      analyzeReferenceRedrawTrace(WINDOWS, [
        input(101, 9),
        input(105, 10),
        received(120, 10, 1, 12),
        applied(121, 10, 1, 12),
        frame(123, 10, 1),
      ]),
    ).toThrow('contains 2 input_queued events');
  });

  test('normalizes the exact cross-checkout event subset and rejects malformed required fields', () => {
    expect(
      normalizeReferenceTerminalEvents([
        { kind: 'unrelated_event', atMs: 1 },
        { kind: 'input_queued', atMs: 2, inputSeq: 3, byteLength: 1, newerField: true },
        {
          kind: 'worker_display_applied',
          atMs: 3,
          displaySeq: 4,
          generation: 5,
          inputSeq: 3,
          frameId: 6,
          byteLength: 7,
          rowCount: 8,
          displayKind: 'display_delta',
          presentationTransactionSeq: 99,
        },
        {
          kind: 'render_start',
          atMs: 3.5,
          renderSeq: 5,
          displayInputSeq: 3,
        },
        {
          kind: 'frame_complete',
          atMs: 4,
          renderSeq: 5,
          displayInputSeq: 3,
          predictionInputSeq: 0,
          visiblePredictionInputSeqs: [],
          visiblePredictionInputSeqsTruncated: false,
          queuedDisplayFrames: 0,
          pollCount: 0,
          previousPollAtMs: 0,
          newerField: true,
        },
      ]),
    ).toEqual([
      { kind: 'input_queued', atMs: 2, inputSeq: 3, byteLength: 1 },
      {
        kind: 'worker_display_applied',
        atMs: 3,
        displaySeq: 4,
        generation: 5,
        inputSeq: 3,
        frameId: 6,
        byteLength: 7,
        rowCount: 8,
        displayKind: 'display_delta',
      },
      {
        kind: 'render_start',
        atMs: 3.5,
        renderSeq: 5,
        displayInputSeq: 3,
      },
      {
        kind: 'frame_complete',
        atMs: 4,
        renderSeq: 5,
        displayInputSeq: 3,
        predictionInputSeq: 0,
        visiblePredictionInputSeqs: [],
        visiblePredictionInputSeqsTruncated: false,
        queuedDisplayFrames: 0,
        pollCount: 0,
        previousPollAtMs: 0,
      },
    ]);
    expect(() => normalizeReferenceTerminalEvents([{ kind: 'frame_complete', atMs: 4 }])).toThrow(
      'frame_complete.visiblePredictionInputSeqs',
    );
  });

  test('an in-flight older frame cannot claim an apply that arrived after its build', () => {
    const events = [
      input(101, 9),
      received(120, 9, 1, 12),
      start(119, 9, 1),
      applied(121, 9, 1, 12),
      frame(123, 9, 1),
      start(124, 9, 2),
      frame(130, 9, 2),
    ];
    const sample = analyzeReferenceRedrawTrace(WINDOWS, events)[0];
    expect(sample?.firstGpuFenceObservedAtMs).toBe(130);
    expect(sample?.completedAuthoritativeGpuFrames).toBe(1);
    expect(sample?.partialPresentationExposureMs).toBe(0);
    expect(sample).not.toHaveProperty('partialPresentationExposureLowerBoundMs');
    expect(sample).not.toHaveProperty('partialPresentationExposureUpperBoundMs');
    expect(() => analyzeReferenceRedrawTrace(WINDOWS, events.slice(0, 5))).toThrow(
      'no GPU frame-complete observation covering a row-bearing apply',
    );
  });

  test('requires every final apply to be followed by its own rendered fence', () => {
    expect(() =>
      analyzeReferenceRedrawTrace(WINDOWS, [
        input(101, 9),
        received(120, 9, 1, 12),
        applied(121, 9, 1, 12),
        start(122, 9, 1),
        frame(130, 9, 1),
        received(125, 9, 2, 12),
        applied(126, 9, 2, 12),
      ]),
    ).toThrow('final row-bearing apply has no subsequent rendered GPU fence');
  });

  test('missing and inconsistent exact render identities invalidate the trace', () => {
    const events = [
      input(101, 9),
      received(120, 9, 1, 12),
      applied(121, 9, 1, 12),
      frame(123, 9, 1),
    ];
    expect(() => analyzeReferenceRedrawTrace(WINDOWS, events)).toThrow(
      'no valid exact render_start join',
    );
    expect(() => analyzeReferenceRedrawTrace(WINDOWS, [...events, start(122, 8, 1)])).toThrow(
      'no valid exact render_start join',
    );
  });

  test('uses nearest-rank percentiles without averaging percentile blocks', () => {
    expect(referenceDistribution([9, 1, 5, 3, 7])).toEqual({
      count: 5,
      p50: 5,
      p95: 9,
      p99: 9,
      max: 9,
    });
    expect(referenceDistribution([])).toEqual({
      count: 0,
      p50: null,
      p95: null,
      p99: null,
      max: null,
    });
  });
});

const WINDOWS = [WINDOW] as const;

function input(atMs: number, inputSeq: number): ReferenceTerminalEvent {
  return { kind: 'input_queued', atMs, inputSeq, byteLength: 1 };
}

function received(
  atMs: number,
  inputSeq: number,
  displaySeq: number,
  rowCount: number,
): ReferenceTerminalEvent {
  return display('display_received', atMs, inputSeq, displaySeq, rowCount);
}

function applied(
  atMs: number,
  inputSeq: number,
  displaySeq: number,
  rowCount: number,
): ReferenceTerminalEvent {
  return display('worker_display_applied', atMs, inputSeq, displaySeq, rowCount);
}

function display(
  kind: 'display_received' | 'worker_display_applied',
  atMs: number,
  inputSeq: number,
  displaySeq: number,
  rowCount: number,
): ReferenceTerminalEvent {
  return {
    kind,
    atMs,
    displaySeq,
    generation: 1,
    inputSeq,
    frameId: displaySeq,
    byteLength: 100,
    rowCount,
    displayKind: 'display_delta',
  };
}

function frame(atMs: number, displayInputSeq: number, renderSeq: number): ReferenceTerminalEvent {
  return {
    kind: 'frame_complete',
    atMs,
    renderSeq,
    displayInputSeq,
    predictionInputSeq: 0,
    visiblePredictionInputSeqs: [],
    visiblePredictionInputSeqsTruncated: false,
    queuedDisplayFrames: 0,
    pollCount: 0,
    previousPollAtMs: 0,
  };
}

function start(atMs: number, displayInputSeq: number, renderSeq: number): ReferenceTerminalEvent {
  return { kind: 'render_start', atMs, displayInputSeq, renderSeq };
}
