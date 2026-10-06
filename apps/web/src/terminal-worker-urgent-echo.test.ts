import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_PATCH_FLAG_PRESENTATION_COHERENT,
  DISPLAY_PATCH_FLAG_RESET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_ROW_PREFIX_BYTES,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  MESSAGE_TYPE_DISPLAY_PATCH,
  TRANSPORT_CHANNEL_ID,
  writeU32BE,
} from '@merkur/shared';
import loadWasm, { init_display_receiver_calibration } from './term-wasm/pkg/term_wasm.js';
import { createRenderMailbox } from './terminal/render-mailbox';
import {
  createFrameRingReader,
  createFrameRingWriter,
  FRAME_KIND_CLIENT_INGRESS_BASE,
  FRAME_RING_SIZE,
  FRAME_RING_SPACE_EDGE,
} from './terminal/shared-ring';
import {
  createWasmClientViewerHandleFromInstance,
  preloadWasmTerminalRuntime,
} from './wasm-loader';

const source = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  [
    'consumeDisplayRingEntry',
    'drainDisplayQueue',
    'observeViewerPresentation',
    'scheduleRenderFrame',
    'noteRenderWanted',
    'presentationRenderIsBlocked',
    'dispatchMailboxAction',
  ]
    .map((name) => {
      const start = source.indexOf(`function ${name}(`),
        end = source.indexOf('\n}', start);
      if (start < 0 || end < start) throw new Error(`missing worker ${name}`);
      return source.slice(start, end + 2);
    })
    .join('\n'),
);
const mapping = { epoch: 1, localMinusWire: 0, wireMin: 1, wireMax: 0xffff_ffff };

/** Complete opened protocol frames: only the row-bearing echo changes pixels. */
function frame(seq: number, rows = 1, held = false): Uint8Array {
  const bytes = new Uint8Array(DISPLAY_ROWS_OFFSET + rows * (DISPLAY_ROW_PREFIX_BYTES + 3));
  const view = new DataView(bytes.buffer),
    base = DISPLAY_STREAM_HEADER_BYTES;
  bytes[0] = MESSAGE_TYPE_DISPLAY_PATCH;
  writeU32BE(bytes, DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET, bytes.length - base);
  writeU32BE(bytes, DISPLAY_GENERATION_OFFSET, 1);
  writeU32BE(bytes, DISPLAY_SEQUENCE_OFFSET, seq);
  bytes[base] = DISPLAY_PROTOCOL_VERSION;
  bytes[base + 1] =
    seq === 0 ? DISPLAY_PATCH_FLAG_RESET : held ? DISPLAY_PATCH_FLAG_PRESENTATION_COHERENT : 0;
  view.setUint16(base + 2, 80);
  view.setUint16(base + 4, 24);
  bytes[base + 10] = 0x10;
  view.setUint32(base + 13, seq + 1);
  view.setUint32(base + 17, seq + 1);
  view.setUint16(base + 23, 1);
  view.setUint16(base + 25, rows);
  view.setUint16(base + 29, held ? 2 : 1);
  for (let row = 0; row < rows; row++) {
    const at = DISPLAY_ROWS_OFFSET + row * (DISPLAY_ROW_PREFIX_BYTES + 3);
    view.setUint16(at, row);
    view.setUint16(at + 4, 1);
    view.setUint16(at + 6, 3);
    bytes[at + DISPLAY_ROW_PREFIX_BYTES + 2] = 97 + seq;
  }
  return bytes;
}

async function harness() {
  await preloadWasmTerminalRuntime();
  const runtime = await loadWasm();
  const terminal = createWasmClientViewerHandleFromInstance(
    runtime.memory,
    init_display_receiver_calibration(80, 24),
  );
  terminal.viewer.fence(0, 1);
  expect(terminal.receive(0, TRANSPORT_CHANNEL_ID.displayCommit, frame(0), mapping)).toBe(true);
  terminal.viewer.present_now(0);
  const ring = new SharedArrayBuffer(FRAME_RING_SIZE);
  const reader = createFrameRingReader(ring),
    writer = createFrameRingWriter(ring);
  const mailbox = createRenderMailbox();
  let renders = 0;
  const context = {
    wasmTerminal: terminal,
    frameRingReader: reader,
    FRAME_KIND_CLIENT_INGRESS_BASE,
    FRAME_RING_SPACE_EDGE,
    ringWakePort: { postMessage() {} },
    performance,
    nowMs: () => performance.now(),
    viewerNowMs: () => performance.now(),
    displayOwnerActive: false,
    displayOwnerDatagrams: 0,
    controlQueue: { hasDataPlaneBarrier: () => false },
    controlQueueSize: () => 0,
    activeControlBlocksDataPlane: false,
    controlPumpActive: false,
    renderer: { canSubmitFrame: () => true },
    rendererContextLost: false,
    displayRenderExecuting: false,
    displayEpoch: { generation: 1, renderPending: false },
    renderMailbox: mailbox,
    authoritativePresentationUrgent: false,
    observedViewerFrames: terminal.viewer.applied_frames(),
    observedViewerSnapshots: terminal.viewer.applied_snapshots(),
    observedViewerPresentations: terminal.viewer.applied_presentations(),
    observedPresentationRevision: terminal.presentationRevision(),
    self: { postMessage() {} },
    graphicsOfferSpaceReleased: false,
    graphicsPresentationDirty: false,
    graphicsResidents: new Set(),
    publishViewerLinks() {},
    lastMouseMode: terminal.mouseMode(),
    firstDisplayGpuFence: { awaitingFirstApplied: () => false, resetEpoch() {} },
    perfEnabled: false,
    perfWriter: null,
    syncDimensionsFromWasm() {},
    updatePhysDimensions() {},
    offscreenCanvas: { width: 0, height: 0 },
    physW: 0,
    physH: 0,
    drainViewerOutputs() {},
    publishPredictionModel() {},
    renderPredictionIfDirty() {},
    armPresentationCommit() {},
    armViewerDeadline() {},
    cancelRenderOpportunity() {},
    armRenderOpportunity() {},
    executeRender() {
      renders++;
      context.displayEpoch.renderPending = false;
      context.authoritativePresentationUrgent = false;
      mailbox.noteSubmitted(renders, renders);
    },
  };
  runInNewContext(program, context);
  return {
    submitPrediction() {
      expect(mailbox.noteDirty().kind).toBe('render-now');
      context.executeRender();
    },
    drain(entries: readonly Uint8Array[]) {
      for (const bytes of entries)
        expect(
          writer.write(
            bytes,
            FRAME_KIND_CLIENT_INGRESS_BASE + TRANSPORT_CHANNEL_ID.displayDatagram,
            false,
            mapping,
          ),
        ).toBe(true);
      runInNewContext('drainDisplayQueue(16)', context);
    },
    complete(id: number) {
      expect(mailbox.noteFrameComplete(id).kind).not.toBe('render-now');
    },
    get renders() {
      return renders;
    },
    dispose() {
      terminal.destroy();
    },
  };
}

test('an urgent echo applied inside the drain renders behind an unconfirmed submission', async () => {
  const host = await harness();
  try {
    host.submitPrediction();
    host.drain([frame(1)]);
    expect(host.renders).toBe(2);
  } finally {
    host.dispose();
  }
});
test('an urgent header without changed rows owes no render ahead of the next opportunity', async () => {
  const host = await harness();
  try {
    host.submitPrediction();
    host.drain([frame(1, 0)]);
    expect(host.renders).toBe(1);
  } finally {
    host.dispose();
  }
});
test('an echo folded by a later member into a held transaction waits for its release', async () => {
  const host = await harness();
  try {
    host.submitPrediction();
    host.drain([frame(1), frame(2, 3, true)]);
    expect(host.renders).toBe(1);
  } finally {
    host.dispose();
  }
});
test('urgency does not outlive the drain that applied it', async () => {
  const host = await harness();
  try {
    host.submitPrediction();
    host.drain([frame(1)]);
    host.complete(2);
    host.drain([frame(2, 0)]);
    expect(host.renders).toBe(2);
  } finally {
    host.dispose();
  }
});
