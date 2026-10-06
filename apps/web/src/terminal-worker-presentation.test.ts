import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Receive/order/FEC/presentation authority is exercised by the shared Rust suite
// and terminal-worker-display-owner.test.ts against the generated WASM. These
// checks cover host-only seams requiring an OffscreenCanvas/WebGPU worker realm.
const source = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');
function body(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('terminal worker presentation host adapter', () => {
  test('a bounded SAB drain offers presentation once after complete leased receives', () => {
    const receive = body('consumeDisplayRingEntry');
    expect(receive).toContain('tryReadLeased()');
    expect(receive).toContain('terminal.receive(');
    expect(receive).toContain('entry.release();');
    expect(receive).not.toContain('present_now');
    const drain = body('drainDisplayQueue');
    expect(drain).toContain('performance.now() - started < budgetMs');
    expect(drain.indexOf('viewer.present_now')).toBeGreaterThan(
      drain.indexOf('consumeDisplayRingEntry'),
    );
    expect(drain.indexOf('scheduleRenderFrame()')).toBeGreaterThan(
      drain.indexOf('displayOwnerActive = false'),
    );
    expect(drain).toContain('const perfStarted = perfEnabled ? nowMs() : 0;');
    expect(drain.match(/emitDisplayPumpComplete\(/g)).toHaveLength(1);
  });

  test('the real frame clock supplies Rust with measured cadence, visibility and renderer capacity', () => {
    const frame = body('applyViewerFrame');
    expect(frame).toContain('WORKER_TIME_ORIGIN_MS + frameTimeMs');
    expect(frame).toContain('refreshRate.presentationPeriodMs()');
    expect(frame).toContain('graphicsVisible');
    expect(frame).toContain('srttMs ?? -1');
    expect(frame.indexOf('set_presentation_ready')).toBeLessThan(frame.indexOf('viewer.frame('));
    expect(frame.indexOf('observeViewerPresentation()')).toBeGreaterThan(
      frame.indexOf('viewer.frame('),
    );
  });

  test('GPU admission and actual submission precede semantic commit and accessibility output', () => {
    const render = body('executeRender');
    expect(render.indexOf('!renderer.canSubmitFrame()')).toBeLessThan(
      render.indexOf('commitPendingDisplaySurfaceResize()'),
    );
    expect(render.indexOf('submissionId === 0')).toBeLessThan(
      render.indexOf('renderSubmissions.commit('),
    );
    expect(render.indexOf('publishPresentedOutput()')).toBeGreaterThan(
      render.indexOf('renderSubmissions.commit('),
    );
    expect(body('publishPresentedOutput')).toContain('displayOutputSettle.noteFrame()');
    expect(render).toContain('renderSubmissions.abortReserved(submission)');
    expect(render).toContain('authoritativePresentationUrgent = false;');
  });

  test('calibration and font promotion wait for the exact first semantic GPU completion', () => {
    const complete = body('onGpuFrameComplete');
    expect(complete).toContain('frame.sessionEpoch === activeSessionEpoch');
    expect(complete).toContain('frame.generation === displayEpoch.generation');
    expect(complete).toContain('if (valid && frame.firstDisplayOwner)');
    expect(complete.indexOf('displayReceiverCalibrationScheduler.start(')).toBeGreaterThan(
      complete.indexOf('firstDisplayGpuFence.noteCompleted(true)'),
    );
    expect(complete).toContain('firstDisplayFrame !== null');
    expect(complete).toContain('renderSubmissions.release(frame)');
  });

  test('the core reads the frame clock and telemetry converts its times to epoch', () => {
    expect(body('viewerNowMs')).toContain('WORKER_TIME_ORIGIN_MS + performance.now()');
    expect(body('nowMs')).toContain('performance.timeOrigin + performance.now()');
    // WebKit moves performance.timeOrigin by each device sleep: no core call
    // may read the epoch clock, or every frame predates the hold it releases.
    expect(source).not.toMatch(/viewer\.\w+\(\s*nowMs\(\)/);
    expect(source).not.toMatch(/\.receive\(\s*nowMs\(\)/);
    expect(body('observeViewerPresentation')).toContain(
      'rebasePresentationTraceTimes(presentationTraceTimes, timeOriginDriftMs())',
    );
    const render = body('executeRender');
    expect(render).toContain('const submittedAtMs = nowMs();');
    expect(render).toContain(
      'emitViewerPresentationCommit(perfWriter, submittedAtMs, renderPerfSeq, changed)',
    );
    const commit = body('emitViewerPresentationCommit');
    for (const index of [0, 1, 2])
      expect(commit).toContain(`Math.max(0, at - (t[${index}] ?? at))`);
  });

  test('the peer fence retires SAB backlog and account authority before acknowledging custody', () => {
    const fence = body('applyPeerFence');
    expect(fence).toContain('terminal.viewer.reset_session()');
    expect(fence.indexOf('frameRingReader?.discardPending()')).toBeLessThan(
      fence.indexOf('terminal.viewer.fence('),
    );
    expect(fence.indexOf('drainViewerOutputs()')).toBeLessThan(
      fence.indexOf("kind: 'client_viewer_fenced'"),
    );
    expect(fence).toContain('frameFenceToken: fence.frameFenceToken');
    expect(fence).toContain('releaseSessionLineageFence(fence.frameFenceToken)');
    // An output held for a full ring belongs to the lineage that ends here: it
    // is dropped before the viewer's output buffer is reused.
    expect(fence.indexOf('viewerOutputPublisher?.reset()')).toBeGreaterThan(-1);
    expect(fence.indexOf('viewerOutputPublisher?.reset()')).toBeLessThan(
      fence.indexOf('terminal.viewer.reset_session()'),
    );
    // Each output is stamped with the lineage and fence it was polled under.
    expect(body('drainViewerOutputs')).toContain('activeSessionEpoch, activeFrameFenceToken');
  });

  test('bounded control slices yield to data work without overtaking ownership barriers', () => {
    const controls = body('runControlPump');
    expect(controls).toContain('processed < CONTROL_COMMANDS_PER_SLICE');
    expect(controls).toContain(
      'activeControlBlocksDataPlane = workerControlCommandBlocksDataPlane(cmd)',
    );
    expect(controls).toContain(
      'if (!controlQueue.hasDataPlaneBarrier()) commitPreparedFontFamilyUpdate()',
    );
    expect(controls.indexOf('runDataPlaneFairnessSlice()')).toBeLessThan(
      controls.indexOf('scheduleControlPumpContinuation()'),
    );
  });

  test('runtime retirement cancels asynchronous font work, timer claims and semantic GPU owners', () => {
    const retire = body('disposeInstalledRuntime');
    expect(body('cancelViewerDeadline')).toContain('viewerDeadline.cancel()');
    for (const call of [
      'cancelViewerDeadline()',
      'presentationAnimationFrame.cancel()',
      'cancelFontStyleUpgrade()',
      "abortActiveFontFamilyUpdate('runtime retirement')",
      'displayReceiverCalibrationScheduler.cancel()',
      'renderSubmissions.contextDestroyed(discardLatencyToken)',
      'wasmTerminal?.destroy()',
    ])
      expect(retire).toContain(call);
  });

  test('local prediction redraw never releases canonical presentation holds', () => {
    const prediction = body('renderPredictionIfDirty');
    expect(prediction).toContain('predictionRenderDirty()');
    expect(prediction).toContain('scheduleRenderFrame()');
    expect(prediction).not.toContain('present_now');
    expect(prediction).not.toContain('viewer.frame');
  });
});
