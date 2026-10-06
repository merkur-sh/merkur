import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRenderMailbox } from './terminal/render-mailbox';

const source = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');

function production(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}', start);
  if (start < 0 || end < start) throw new Error(`missing ${name}`);

  return source.slice(start, end + 2);
}

// The render and the commit record it writes at the same submission instant.
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  `${production('executeRender')}\n${production('emitViewerPresentationCommit')}\nglobalThis.render = executeRender;`,
);

function harness() {
  const mailbox = createRenderMailbox();
  let submissionId = 0;
  let commits = 0;
  let abandoned = 0;
  let fail = false;
  let retryClaims = 0;
  const context = {
    displayEpoch: { renderPending: true, stateAppliedPending: false },
    wasmTerminal: { viewer: { authoritative_input: () => 7 }, presentationRevision: () => 1 },
    syncDimensionsFromWasm() {},
    updatePhysDimensions() {},
    authoritativePresentationUrgent: false,
    renderer: { canSubmitFrame: () => true },
    rendererContextLost: false,

    commitPendingRasterMetrics: () => {},
    displayRenderExecuting: false,
    renderSubmissions: {
      reserve: () => ({ submissionId: 0 }),
      abortReserved: () => {
        abandoned += 1;
      },
      commit: (entry: { submissionId: number }, id: number) => {
        entry.submissionId = id;
        commits += 1;
      },
    },
    sendPendingDisplayStateReady: () => {},
    authoritativeInputHighWater: 0,
    pendingRenderDisplayInputSeq: 0,
    committedInputHighWater: 0,

    displaySurfaceResizePending: false,
    displaySurfaceReplacementPending: false,
    geometryRenderState: { versions: { bg: 0, glyph: 0, deco: 0, cursor: 0 } },
    perfEnabled: false,
    perfWriter: null,
    renderStateRevision: 0,
    renderPredictionRevision: 0,
    commitPendingDisplaySurfaceResize: () => {},
    committedPhysW: 0,
    committedPhysH: 0,
    physW: 800,
    physH: 600,
    localPresentationPending: false,
    buildAndRender: () => {
      if (fail) throw new Error('injected submission failure');
      return submissionId;
    },
    publishPredictionModel: () => {},
    displayQueueSize: () => 0,
    activeSessionEpoch: 1,
    renderViewportEpoch: 1,
    publishInFlightCursorPosition: () => {},
    renderedPredictionMayBeVisible: false,
    provisionalPreview: { geometry: { bgCount: 0 } },
    displayOutputSettle: { noteFrame: () => {} },
    publishPresentedOutput: () => {},
    snapshotPredictionPerfEffects: () => ({}),
    renderPerfSeq: 0,
    firstDisplayGpuFence: { hasInFlight: () => false, noteSubmitted: () => {} },
    recordLatencyFrameSubmitted: () => null,
    pendingPresentationCommitReason: null,
    presentationAnimationFrame: { cancel: () => {} },
    safetyPresentationPending: false,
    pendingRenderPredictionInputSeq: 0,
    abandonInFlightCursorPosition: () => {},
    displayOwnerActive: false,
    hasDisplayOwnerWork: () => false,
    scheduleDisplayPumpContinuation: () => {},
    renderMailbox: mailbox,
    performance: { now: () => 117 },
    presentationRenderIsBlocked: () => false,
    noteRenderWanted: () => {
      retryClaims += 1;
      return mailbox.noteDirty();
    },
    armRenderOpportunity: () => {},
    dispatchMailboxAction: () => {},
  };
  const render = runInNewContext(`${program}\nglobalThis.render;`, context) as () => void;
  return {
    context,
    mailbox,
    render,
    setResult: (id: number) => {
      submissionId = id;
    },
    throwOnSubmit: () => {
      fail = true;
    },
    counts: () => ({ commits, abandoned, retryClaims }),
  };
}

test('zero submission preserves pending display until a later real opportunity', () => {
  const h = harness();
  let armed = 0;
  h.context.armRenderOpportunity = () => {
    armed += 1;
  };
  expect(h.mailbox.noteDirty().kind).toBe('render-now');
  h.render();
  expect(h.context.displayEpoch.renderPending).toBe(true);
  expect(h.counts().commits).toBe(0);
  expect(h.counts().retryClaims).toBe(0);
  expect(armed).toBe(1);
  h.setResult(1);
  expect(h.mailbox.noteOpportunity(132).kind).toBe('render-now');
  h.render();
  expect(h.counts().commits).toBe(1);
  expect(h.context.displayEpoch.renderPending).toBe(false);
});

for (const reason of ['context-lost', 'resource-pressure', 'held'] as const) {
  test(`aborted work leaves its wake with ${reason} instead of polling frames`, () => {
    const h = harness();
    let armed = 0;
    h.context.armRenderOpportunity = () => {
      armed += 1;
    };
    h.context.buildAndRender = () => {
      if (reason === 'context-lost') h.context.rendererContextLost = true;
      else if (reason === 'resource-pressure') h.context.renderer.canSubmitFrame = () => false;
      else h.context.presentationRenderIsBlocked = () => true;
      return 0;
    };
    expect(h.mailbox.noteDirty().kind).toBe('render-now');
    h.render();
    expect(h.context.displayEpoch.renderPending).toBe(true);
    expect(h.counts().retryClaims).toBe(0);
    expect(armed).toBe(0);
  });
}

test('a thrown render retains pending work and does not immediately reclaim its mailbox', () => {
  const h = harness();
  expect(h.mailbox.noteDirty().kind).toBe('render-now');
  h.throwOnSubmit();
  expect(() => h.render()).toThrow('injected submission failure');
  expect(h.context.displayEpoch.renderPending).toBe(true);
  expect(h.counts()).toEqual({ commits: 0, abandoned: 1, retryClaims: 0 });
  expect(h.mailbox.noteOpportunity(132).kind).toBe('render-now');
});

test('a presentation commit and render end name the same successful submission instant', () => {
  const h = harness();
  const observations: { kind: string; at: number }[] = [];
  let clock = 100;
  Object.assign(h.context, {
    perfEnabled: true,
    perfWriter: {},
    nowMs: () => ++clock,
    renderGateWantedAtMs: 100,
    renderGateLabel: () => 'immediate',
    renderGateFenceReleasedAtMs: 0,
    renderGateFenceReleasedRenderSeq: 0,
    renderGateOpportunityEnteredAtMs: 0,
    renderGateOpportunityDelayMs: 0,
    renderGateFenceWaitMs: 0,
    renderGateOpportunityWaitMs: 0,
    refreshRate: { presentationPeriodMs: () => 16, confidence01: () => 1 },
    resetRenderGateAccumulators: () => {},
    lastRenderUploadedAtlas: false,
    pendingPresentationTrace: true,
    presentationTransactionSeq: 0,
    presentationTraceWords: new Uint32Array(18),
    presentationTraceTimes: new Float64Array(5),
    presentationCommitReason: () => 'urgent',
    emitRenderStart: (_writer: unknown, at: number) => observations.push({ kind: 'start', at }),
    emitRenderEnd: (_writer: unknown, at: number) => {
      observations.push({ kind: 'end', at });
      clock += 0.25; // Writing telemetry takes time; it creates no new submission.
    },
    emitPresentationCommit: (_writer: unknown, at: number) =>
      observations.push({ kind: 'commit', at }),
  });
  h.setResult(1);
  expect(h.mailbox.noteDirty().kind).toBe('render-now');
  h.render();
  expect(observations.map((event) => event.kind)).toEqual(['start', 'end', 'commit']);
  expect(observations[0]?.at).toBeLessThan(observations[1]?.at ?? 0);
  expect(observations[2]?.at).toBe(observations[1]?.at);
});
