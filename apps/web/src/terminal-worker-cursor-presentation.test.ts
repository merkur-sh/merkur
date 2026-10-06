import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRenderSubmissionState } from './terminal/render-submission-state';

const source = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');
function productionFunctions(names: readonly string[]): string {
  return new Bun.Transpiler({ loader: 'ts' }).transformSync(
    names
      .map((name) => {
        const at = source.indexOf(`function ${name}(`);
        const end = source.indexOf('\n}', at);
        if (at < 0 || end < at) throw new Error(`missing worker ${name}`);
        return source.slice(at, end + 2);
      })
      .join('\n'),
  );
}

test('exact completion ownership survives newer submissions, reordering and invalidation', () => {
  for (const invalidated of [false, true]) {
    const owners = createRenderSubmissionState();
    const writer = {};
    const first = owners.reserve();
    first.sessionEpoch = 3;
    first.generation = 4;
    first.renderSeq = 7;
    first.queueDepth = 5;
    first.perf = {
      displayInputSeq: 8,
      predictionInputSeq: 9,
      visiblePredictionInputSeqs: [9],
      visiblePredictionInputSeqsTruncated: false,
    };
    // Fake perf writer is opaque to the callback under test.
    const events: unknown[][] = [];
    const releases: number[][] = [];
    const context = {
      wasmTerminal: null,
      rendererContextLost: false,
      observeViewerPresentation() {},
      drainViewerOutputs() {},
      scheduleRenderFrame() {},
      renderSubmissions: owners,
      activeSessionEpoch: 3,
      displayEpoch: { generation: 4 },
      perfEnabled: true,
      perfWriter: writer,
      nowMs: () => 120,
      performance: { now: () => 20 },
      presentedPredictionSources: { discardFrame() {} },
      emitFrameComplete: (...args: unknown[]) => events.push(args),
      renderGateFenceEnteredAtMs: 100,
      renderGateFenceReleasedAtMs: 0,
      renderGateFenceReleasedRenderSeq: 0,
      renderGateWaitKind: 'fence',
      renderGateFenceReleasePending: true,
      renderGateWaitStartedAtMs: 100,
      renderGateFenceWaitMs: 0,
      renderGateOpportunityWaitMs: 0,
      renderer: { canSubmitFrame: () => true },
      renderMailbox: { noteFrameComplete: () => ({ kind: 'render-now' }) },
      dispatchMailboxAction() {
        releases.push([
          context.renderGateFenceReleasedRenderSeq,
          context.renderGateFenceReleasedAtMs,
        ]);
      },
    };
    // VM bindings keep the production callback and opaque writer in one realm.
    runInNewContext('first.perfWriter = writer;', { first, writer });
    owners.commit(first, 1);
    const second = owners.reserve();
    second.sessionEpoch = 3;
    second.generation = 4;
    owners.commit(second, 2);
    if (invalidated) owners.invalidateSemantics(() => {});
    runInNewContext(
      productionFunctions(['onGpuFrameComplete', 'accumulateRenderGateWait']),
      context,
    );
    runInNewContext('onGpuFrameComplete(1)', context);
    expect(events).toEqual([
      [writer, 120, 7, 8, 9, 5, [9], false, 0, 0, invalidated ? 'invalidated' : 'superseded'],
    ]);
    expect(releases).toEqual([[7, 120]]);
    expect(owners.count()).toBe(1);
    // Completion never carries its old cursor coordinates into a later submission.
    expect(
      source.slice(
        source.indexOf('function onGpuFrameComplete('),
        source.indexOf('function discardLatencyToken('),
      ),
    ).not.toContain('publishInFlightCursorPosition');
  }
});

test('only a callback opening real capacity owns the fence-release telemetry', () => {
  for (const paused of [false, true])
    for (const actionKind of ['none', 'wait-fence', 'wait-frame', 'render-now']) {
      for (const rendererReady of [false, true]) {
        const owners = createRenderSubmissionState();
        const frame = owners.reserve();
        frame.renderSeq = 77;
        owners.commit(frame, 1);
        const context = {
          wasmTerminal: null,
          rendererContextLost: false,
          observeViewerPresentation() {},
          drainViewerOutputs() {},
          scheduleRenderFrame() {},
          renderSubmissions: owners,
          activeSessionEpoch: 0,
          displayEpoch: { generation: 0 },
          perfEnabled: true,
          perfWriter: null,
          nowMs: () => 120,
          performance: { now: () => 20 },
          renderGateWaitKind: paused ? 'none' : 'fence',
          renderGateFenceReleasePending: true,
          renderGateWaitStartedAtMs: 100,
          renderGateFenceWaitMs: 0,
          renderGateOpportunityWaitMs: 0,
          renderGateFenceReleasedAtMs: 0,
          renderGateFenceReleasedRenderSeq: 0,
          renderer: { canSubmitFrame: () => rendererReady },
          renderMailbox: { noteFrameComplete: () => ({ kind: actionKind }) },
          dispatchMailboxAction() {},
        };
        runInNewContext(
          `${productionFunctions(['onGpuFrameComplete', 'accumulateRenderGateWait'])}; onGpuFrameComplete(1);`,
          context,
        );
        const released =
          rendererReady && (actionKind === 'wait-frame' || actionKind === 'render-now');
        expect(context.renderGateFenceReleasedRenderSeq).toBe(released ? 77 : 0);
        expect(context.renderGateFenceReleasedAtMs).toBe(released ? 120 : 0);
        expect(context.renderGateFenceWaitMs).toBe(released && !paused ? 20 : 0);
        expect(context.renderGateFenceReleasePending).toBe(!released);
        expect(owners.count()).toBe(0);
      }
    }
});

test('cursor UI anchor follows successful submission and cannot be moved by later GPU completion', () => {
  const messages: unknown[] = [];
  let col = 3;
  const context = {
    wasmTerminal: { cursorInfo: () => Uint16Array.of(col, 7, 1, 1) },
    drainCursorMotionJournal() {},
    inFlightCursorValid: false,
    inFlightCursorCol: 0,
    inFlightCursorRow: 0,
    inFlightCursorVisible: false,
    lastCursorCol: -1,
    lastCursorRow: -1,
    lastCursorVisible: -1,
    self: { postMessage: (message: unknown) => messages.push(message) },
  };
  runInNewContext(
    productionFunctions([
      'captureInFlightCursorPosition',
      'publishInFlightCursorPosition',
      'abandonInFlightCursorPosition',
    ]),
    context,
  );
  runInNewContext('captureInFlightCursorPosition(); publishInFlightCursorPosition()', context);
  col = 19;
  runInNewContext('captureInFlightCursorPosition(); publishInFlightCursorPosition()', context);
  expect(messages).toEqual([
    { kind: 'cursor_position', col: 3, row: 7, visible: true },
    { kind: 'cursor_position', col: 19, row: 7, visible: true },
  ]);
  col = 40;
  runInNewContext(
    'captureInFlightCursorPosition(); abandonInFlightCursorPosition(); publishInFlightCursorPosition()',
    context,
  );
  expect(messages).toHaveLength(2);
  const render = productionFunctions(['executeRender']);
  expect(render.indexOf('publishInFlightCursorPosition()')).toBeGreaterThan(
    render.indexOf('renderSubmissions.commit('),
  );
});

test('resize uses normal GPU admission and cannot clear the canvas before obtaining capacity', () => {
  const request = productionFunctions([
    'handleResize',
    'resizeAndRenderDisplaySurface',
    'queueSurfaceReplacement',
  ]);
  expect(request).not.toContain('resizeDisplaySurface(');
  expect(request).not.toContain('executeRender(');
  expect(request).toContain('scheduleRenderFrame()');
  const render = productionFunctions(['executeRender']);
  expect(render.indexOf('commitPendingDisplaySurfaceResize()')).toBeGreaterThan(
    render.indexOf('renderSubmissions.reserve()'),
  );
});
