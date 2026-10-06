import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  writeU32BE,
} from '@merkur/shared';
import { createViewerDriver } from '../../../scripts/perf/client-viewer-driver';
import { ingressFixture } from '../../../scripts/term-wasm-ingress-fixture';
import {
  createPredictionFastPathBuffer,
  createPredictionFastPathConsumer,
  createPredictionFastPathWriter,
} from './terminal/prediction-fast-path';

const source = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');
function production(name: string) {
  const start = source.indexOf(`function ${name}(`),
    end = source.indexOf('\n}', start);
  if (start < 0 || end < start) throw new Error(`missing production ${name}`);
  return source.slice(start, end + 2);
}

test('production teardown frees the Rust owner, retires every host wake, and replaces host epoch state', () => {
  const driver = createViewerDriver(20, 2);
  const events: string[] = [],
    rejected: number[] = [];
  const sab = createPredictionFastPathBuffer(),
    consumer = createPredictionFastPathConsumer(sab),
    writer = createPredictionFastPathWriter(sab);
  writer.beginEpoch();
  consumer.adoptRequiredEpoch();
  expect(writer.writePrintable(7, 97, 1, true)).toBe(true);
  const epoch = {
    generation: 9,
    renderPending: true,
    pumpScheduled: true,
    stateReadyPending: true,
    stateAppliedPending: true,
    outputPresentedPending: true,
    lastFrameAtMs: 7,
    lastSnapshotAtMs: 3,
  };
  const edge = (name: string) => () => events.push(name);
  const context = {
    displayEpoch: epoch,
    renderer: { destroy: edge('renderer') },
    wasmTerminal: {
      viewer: { discard_presentation: edge('discard') },
      destroy: () => {
        events.push('viewer');
        driver.close();
      },
    },
    predictionFastPath: consumer,
    predictionAdmissionResolver: { reject: (sequence: number) => rejected.push(sequence) },
    stopFrameRingPump: edge('frame-pump'),
    stopPredictionRingPump: edge('prediction-pump'),
    viewerDeadline: { cancel: edge('deadline') },
    armedViewerDeadline: 5,
    presentationAnimationFrame: { cancel: edge('animation') },
    displayOutputSettle: { reset: edge('settle') },
    cancelFontStyleUpgrade: edge('font-style'),
    abortActiveFontFamilyUpdate: edge('font-family'),
    refreshCalibrator: { stop: edge('refresh') },
    displayReceiverCalibrationScheduler: { cancel: edge('calibration') },
    renderMailbox: { reset: edge('mailbox') },
    cancelRenderOpportunity: edge('opportunity'),
    renderSubmissions: { contextDestroyed: edge('submissions') },
    discardLatencyToken() {},
    resetRenderGateAccumulators() {},
    retireWaitingGraphicsAsset: edge('asset'),
    provisionalPreview: { clear: edge('preview') },
    presentedPredictionSources: { reset: edge('sources') },
    firstDisplayGpuFence: { resetEpoch: edge('first-gpu') },
    graphicsResidents: new Set(['old']),
  };
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `${production('clearQueuedPredictions')}\n${production('cancelViewerDeadline')}\n${production('disposeInstalledRuntime')}`,
  );
  runInNewContext(`${code}\ndisposeInstalledRuntime();`, context);
  expect(context.wasmTerminal).toBeNull();
  expect(context.renderer).toBeNull();
  expect(context.displayEpoch).not.toBe(epoch);
  expect(context.displayEpoch).toEqual({
    generation: 0,
    renderPending: false,
    pumpScheduled: false,
    stateReadyPending: false,
    stateAppliedPending: false,
    outputPresentedPending: false,
    lastFrameAtMs: 0,
    lastSnapshotAtMs: 0,
  });
  expect(context.armedViewerDeadline).toBeNaN();
  expect(epoch.generation).toBe(9);
  expect(rejected).toEqual([7]);
  expect(consumer.pendingCount()).toBe(0);
  expect(context.graphicsResidents.size).toBe(0);
  for (const name of [
    'deadline',
    'animation',
    'calibration',
    'font-family',
    'asset',
    'preview',
    'submissions',
    'renderer',
    'discard',
    'viewer',
  ])
    expect(events.filter((event) => event === name)).toHaveLength(1);
  // What the viewer held offscreen is told while the viewer still exists.
  expect(events.indexOf('discard')).toBeLessThan(events.indexOf('viewer'));
  expect(events.indexOf('frame-pump')).toBeLessThan(events.indexOf('viewer'));
  expect(events.indexOf('prediction-pump')).toBeLessThan(events.indexOf('viewer'));
});

test('a retained-session fence keeps eligible paint and resume identity but releases old ahead frames', () => {
  const driver = createViewerDriver(20, 2);
  try {
    const paint = driver.viewer.presentation_viewport_rows();
    const ahead = ingressFixture(20, 2, 1, 7, false);
    writeU32BE(ahead, DISPLAY_SEQUENCE_OFFSET, 2);
    writeU32BE(ahead, DISPLAY_GENERATION_OFFSET, 2);
    driver.receive(ahead, 3, 1);
    expect(driver.viewer.applied_sequence()).toBe(0);
    driver.viewer.fence(2, 2);
    expect(driver.viewer.presentation_viewport_rows()).toBe(paint);
    const resume = driver.pollOutput(2);
    expect(resume?.kind).toBe(6);
    expect(resume?.words.slice(0, 2)).toEqual(new Uint32Array([1, 0]));
    const snapshot = ingressFixture(20, 2, 2, 8, false);
    snapshot[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
    writeU32BE(snapshot, DISPLAY_GENERATION_OFFSET, 2);
    driver.receive(snapshot, 4, 3);
    const next = ingressFixture(20, 2, 1, 9, false);
    writeU32BE(next, DISPLAY_GENERATION_OFFSET, 2);
    driver.apply(next);
    expect(driver.viewer.applied_sequence()).toBe(1);
    expect(driver.viewer.applied_frames()).toBe(3);
  } finally {
    driver.close();
  }
});

test('an account reset owns a fresh Viewer that accepts lineage one and cannot replay the prior account backlog', () => {
  const driver = createViewerDriver(20, 2);
  try {
    const ahead = ingressFixture(20, 2, 1, 7, false);
    writeU32BE(ahead, DISPLAY_SEQUENCE_OFFSET, 2);
    writeU32BE(ahead, DISPLAY_GENERATION_OFFSET, 2);
    driver.receive(ahead, 3, 1);
    driver.viewer.fence(2, 9);
    driver.viewer.reset_session();
    driver.viewer.set_presentation_ready(true);
    driver.viewer.fence(3, 1);
    expect(driver.viewer.generation()).toBe(0);
    expect(driver.viewer.applied_frames()).toBe(0);
    expect(driver.viewer.presentation_viewport_rows().trim()).toBe('');
    expect(driver.viewer.has_predictions()).toBe(false);
    const snapshot = ingressFixture(20, 2, 2, 8, false);
    snapshot[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
    writeU32BE(snapshot, DISPLAY_GENERATION_OFFSET, 2);
    driver.receive(snapshot, 4, 4);
    driver.viewer.present_now(4);
    const next = ingressFixture(20, 2, 1, 9, false);
    writeU32BE(next, DISPLAY_GENERATION_OFFSET, 2);
    driver.apply(next);
    expect(driver.viewer.generation()).toBe(2);
    expect(driver.viewer.applied_sequence()).toBe(1);
    expect(driver.viewer.applied_frames()).toBe(2);
  } finally {
    driver.close();
  }
});
