import { expect, test } from 'bun:test';
import { analyzeReferenceRedrawContent } from './reference-redraw-content';
import type { ReferenceRenderContent } from './reference-render-content';
import type { ReferenceRedrawSample, ReferenceTerminalEvent } from './terminal-redraw-reference';

const sample: ReferenceRedrawSample = {
  index: 0,
  inputSeq: 7,
  inputQueuedAtMs: 5,
  windowOpenedAtMs: 4,
  triggerDispatchCompletedAtMs: 6,
  windowClosedAtMs: 150,
  receivedDatagrams: 3,
  appliedDatagrams: 3,
  appliedBytes: 300,
  appliedRows: 108,
  completedAuthoritativeGpuFrames: 3,
  inputToFirstAuthoritativeGpuFenceMs: 7,
  inputToCompletedAuthoritativeGpuFenceMs: 137,
  partialPresentationExposureMs: 130,
  firstDisplayReceiptToCompletedAuthoritativeGpuFenceMs: 133,
  firstGpuFenceObservedAtMs: 12,
  lastGpuFenceObservedAtMs: 142,
};

function observation(ordinal: number, atMs: number, stateRevision: number): ReferenceRenderContent {
  return {
    ordinal,
    atMs,
    observedAtMs: atMs + 0.1,
    stateRevision,
    changedRows: ordinal === 4 ? 0 : 36,
    cursorChanged: false,
    cols: 120,
    rows: 36,
    viewportWidth: 1200,
    viewportHeight: 720,
    atlasGeneration: 1,
    atlasWidth: 1024,
    atlasHeight: 1024,
  };
}

function trace() {
  const observations = [
    observation(1, 1, 1),
    observation(2, 11, 2),
    observation(3, 21, 3),
    observation(4, 141, 3),
  ];
  const events: ReferenceTerminalEvent[] = [10, 20, 140].flatMap((atMs, index) => [
    { kind: 'render_start' as const, atMs, renderSeq: index + 1, displayInputSeq: 7 },
    {
      kind: 'render_end' as const,
      atMs: atMs + 1.5,
      renderSeq: index + 1,
      completionMode: 'gpu-queue' as const,
      atlasUploaded: false,
    },
    {
      kind: 'frame_complete' as const,
      atMs: atMs + 2,
      renderSeq: index + 1,
      displayInputSeq: 7,
      predictionInputSeq: 0,
      visiblePredictionInputSeqs: [],
      visiblePredictionInputSeqsTruncated: false,
      queuedDisplayFrames: 0,
      pollCount: 0,
      previousPollAtMs: 0,
    },
  ]);
  return { observations, events };
}

test('an identical retry remains acknowledged evidence but does not extend semantic exposure', () => {
  const { observations, events } = trace();
  const [result] = analyzeReferenceRedrawContent([sample], events, observations);
  expect(result).toMatchObject({
    submittedGpuFrames: 3,
    contentChangingGpuFrames: 2,
    identicalGpuFrames: 1,
    contentChangingObservedGpuFenceExposureMs: 10,
  });
  expect(result?.contentChanges.map((entry) => entry.renderSeq)).toEqual([1, 2]);
});

test('one content-changing submission has exactly zero exposure even with an identical tail', () => {
  const { observations, events } = trace();
  const same = observations.map((item) =>
    item.ordinal > 2 ? { ...item, stateRevision: 2, changedRows: 0 } : item,
  );
  expect(analyzeReferenceRedrawContent([sample], events, same)[0]).toMatchObject({
    contentChangingGpuFrames: 1,
    contentChangingObservedGpuFenceExposureMs: 0,
  });
});

test('missing observations, incomplete fences, predictions, and changed geometry fail closed', () => {
  const { observations, events } = trace();
  expect(() => analyzeReferenceRedrawContent([sample], events, observations.slice(1))).toThrow(
    'missing',
  );
  expect(() => analyzeReferenceRedrawContent([sample], events.slice(0, -1), observations)).toThrow(
    'unfenced',
  );
  expect(() =>
    analyzeReferenceRedrawContent(
      [sample],
      events.map((event) =>
        event.kind === 'frame_complete' ? { ...event, predictionInputSeq: 8 } : event,
      ),
      observations,
    ),
  ).toThrow('unpredicted');
  expect(() =>
    analyzeReferenceRedrawContent(
      [sample],
      events,
      observations.map((item) => (item.ordinal >= 3 ? { ...item, atlasGeneration: 2 } : item)),
    ),
  ).toThrow('atlas changed');
});

test('truncated or nonempty visible prediction membership never proves an unpredicted frame', () => {
  const { observations, events } = trace();
  for (const metadata of [
    { visiblePredictionInputSeqsTruncated: true, visiblePredictionInputSeqs: [] },
    { visiblePredictionInputSeqsTruncated: false, visiblePredictionInputSeqs: [8] },
  ])
    expect(() =>
      analyzeReferenceRedrawContent(
        [sample],
        events.map((event) =>
          event.kind === 'frame_complete' ? { ...event, ...metadata } : event,
        ),
        observations,
      ),
    ).toThrow('unpredicted');
});

test('an in-place glyph atlas upload invalidates a fixed-content signature window', () => {
  const { observations, events } = trace();
  expect(() =>
    analyzeReferenceRedrawContent(
      [sample],
      events.map((event) =>
        event.kind === 'render_end' ? { ...event, atlasUploaded: true } : event,
      ),
      observations,
    ),
  ).toThrow('atlas changed');
});

test('revision changes must exactly agree with semantic change metadata', () => {
  const { observations, events } = trace();
  for (const poison of [
    observations.map((item) => (item.ordinal === 4 ? { ...item, stateRevision: 4 } : item)),
    observations.map((item) => (item.ordinal === 3 ? { ...item, changedRows: 0 } : item)),
  ])
    expect(() => analyzeReferenceRedrawContent([sample], events, poison)).toThrow(
      'revision disagrees',
    );
});

test('a render spanning the window opening cannot be attributed to its redraw', () => {
  const { observations, events } = trace();
  expect(() =>
    analyzeReferenceRedrawContent(
      [sample],
      events.map((event) =>
        event.kind === 'render_start' && event.renderSeq === 1
          ? { ...event, atMs: sample.windowOpenedAtMs - 0.1 }
          : event,
      ),
      observations,
    ),
  ).toThrow('unpredicted render/fence owner');
});

test('equal-time render ownership and a fence poll after completion fail closed', () => {
  const { observations, events } = trace();
  expect(() =>
    analyzeReferenceRedrawContent(
      [sample],
      [...events, { kind: 'render_start', renderSeq: 99, atMs: 10, displayInputSeq: 7 }],
      observations,
    ),
  ).toThrow('equal-time');
  expect(() =>
    analyzeReferenceRedrawContent(
      [sample],
      events.map((event) =>
        event.kind === 'frame_complete' ? { ...event, previousPollAtMs: event.atMs + 1 } : event,
      ),
      observations,
    ),
  ).toThrow('unpredicted');
});
