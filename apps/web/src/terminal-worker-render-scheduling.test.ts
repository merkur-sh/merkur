import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  DISPLAY_FRAME_ID_OFFSET,
  DISPLAY_PATCH_FLAG_PRESENTATION_COHERENT,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_PRESENTATION_ID_OFFSET,
  DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  writeU32BE,
} from '@merkur/shared';
import { createViewerDriver } from '../../../scripts/perf/client-viewer-driver';
import { ingressFixture } from '../../../scripts/term-wasm-ingress-fixture';
import { createRenderMailbox, type MailboxAction } from './terminal/render-mailbox';

const source = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');
function workerFunction(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}', start);
  if (start < 0 || end < start) throw new Error(`missing worker callback ${name}`);
  return source.slice(start, end + 2);
}
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  `${workerFunction('dispatchMailboxAction')}\nglobalThis.dispatch = dispatchMailboxAction;`,
);

function harness() {
  const mailbox = createRenderMailbox();
  let held = false;
  let renders = 0;
  let now = 0;
  let armed = false;
  const dispatch = runInNewContext(`${program}\nglobalThis.dispatch;`, {
    renderMailbox: mailbox,
    presentationRenderIsBlocked: () => held,
    cancelRenderOpportunity: () => {
      armed = false;
    },
    armRenderOpportunity: () => {
      armed = true;
    },
    perfEnabled: false,
    executeRender: () => {
      renders += 1;
      dispatch(mailbox.noteSubmitted(now, renders));
    },
  }) as (action: MailboxAction) => void;
  return {
    mailbox,
    dispatch,
    offer(atMs: number) {
      now = atMs;
      dispatch(mailbox.noteDirty());
    },
    frame(atMs: number) {
      now = atMs;
      dispatch(mailbox.noteOpportunity(atMs));
    },
    complete(atMs: number, id: number) {
      now = atMs;
      dispatch(mailbox.noteFrameComplete(id));
    },
    hold(value: boolean) {
      held = value;
    },
    get renders() {
      return renders;
    },
    get armed() {
      return armed;
    },
  };
}

test('idle echo submits now; busy updates use opportunities without inventing GPU capacity', () => {
  const host = harness();
  host.offer(0);
  expect(host.renders).toBe(1);
  expect(host.armed).toBe(true);
  // Genuine idle capacity must not wait for a later animation callback.
  host.complete(1, 1);
  for (let at = 1; at < 16; at++) host.offer(at);
  expect(host.renders).toBe(2);
  host.frame(16);
  expect(host.renders).toBe(3);
  host.offer(17);
  host.frame(32);
  expect(host.renders).toBe(3);
  expect(host.armed).toBe(false);
  // Both owners are occupied: a refresh cannot manufacture a completion.
  host.complete(40, 2);
  expect(host.renders).toBe(4);
  host.complete(41, 3);
  host.frame(48);
  host.offer(90);
  expect(host.renders).toBe(5);
});

test('a held authoritative transaction cannot leak through a completion credit', () => {
  const host = harness();
  host.offer(0);
  host.offer(1);
  host.frame(16);
  host.hold(true);
  host.offer(17);
  host.complete(24, 1);
  host.frame(32);
  expect(host.renders).toBe(2);
  host.hold(false);
  host.offer(33);
  expect(host.renders).toBe(3);
});

test('GPU completion wiring contains no terminal cursor or prediction publication', () => {
  const completion = workerFunction('onGpuFrameComplete');
  expect(completion).not.toContain('publishInFlightCursorPosition');
  expect(completion).not.toContain('publishPresented');
  expect(completion).not.toContain('buildGeometry');
  expect(completion).toContain('renderSubmissions.retire(submissionId)');
  expect(completion).toContain('renderSubmissions.release(frame)');
  expect(source).not.toContain('pollFrameComplete');
  expect(source).not.toContain('scheduleFloorWakeup');
});

test('resource refusal preserves canvas, pending state and semantic ownership', () => {
  const events: string[] = [];
  const context = {
    displayEpoch: { renderPending: true },
    wasmTerminal: {},
    rendererContextLost: false,
    renderer: { canSubmitFrame: () => false },
    renderMailbox: createRenderMailbox(),
    perfEnabled: false,
    commitPendingRasterMetrics: () => events.push('raster'),
    commitPendingDisplaySurfaceResize: () => events.push('canvas'),
    renderSubmissions: { reserve: () => events.push('owner') },
    sendPendingDisplayStateReady: () => events.push('semantic'),
    buildAndRender: () => events.push('submit'),
  };
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(workerFunction('executeRender'));
  runInNewContext(`${code}\nexecuteRender();`, context);
  expect(events).toEqual([]);
  expect(context.displayEpoch.renderPending).toBe(true);
});

test('held Rust presentation requests exactly one real animation opportunity without a wall-clock release', () => {
  const driver = createViewerDriver(20, 2);
  try {
    const held = ingressFixture(20, 2, 1, 0, false);
    held[DISPLAY_PATCH_FLAGS_OFFSET] = DISPLAY_PATCH_FLAG_PRESENTATION_COHERENT;
    writeU32BE(held, DISPLAY_SEQUENCE_OFFSET, 1);
    writeU32BE(held, DISPLAY_FRAME_ID_OFFSET, 2);
    writeU32BE(held, DISPLAY_PRESENTATION_ID_OFFSET, 1);
    new DataView(held.buffer).setUint16(DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET, 2);
    driver.receive(held, 3, 1);
    expect(driver.viewer.presentation_held()).toBe(true);
    let armed = false,
      opportunities = 0,
      callbacks = 0;
    const context = {
      wasmTerminal: { viewer: driver.viewer },
      graphicsVisible: true,
      presentationAnimationFrame: {
        isArmed: () => armed,
        arm: () => {
          armed = true;
          opportunities++;
        },
      },
      onViewerAnimationFrame: () => callbacks++,
    };
    const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
      workerFunction('armPresentationCommit'),
    );
    runInNewContext(`${code}\narmPresentationCommit(); armPresentationCommit();`, context);
    expect(opportunities).toBe(1);
    expect(callbacks).toBe(0);
    expect(driver.viewer.presentation_held()).toBe(true);
    expect(workerFunction('armRenderOpportunity')).not.toContain('Timer');
    expect(source).not.toContain('renderOpportunityTimer');
    expect(source).not.toContain('presentationDeadlineTimer');
  } finally {
    driver.close();
  }
});
