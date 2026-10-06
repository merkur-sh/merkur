/** Real browser clocks exercise the Rust owner and production reusable ingress adapter. */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const REDRAW_FRAME_COUNT = 130;

function buildViewerBundle(): string {
  const workerTest = readFileSync(
    path.join(PROJECT_ROOT, 'apps/web/src/terminal-worker-display-owner.test.ts'),
    'utf8',
  );
  const protocolImport = workerTest
    .slice(workerTest.indexOf('import {\n  DISPLAY_CHUNK'), workerTest.indexOf('import loadWasm'))
    .replace(
      "'@merkur/shared'",
      JSON.stringify(path.join(PROJECT_ROOT, 'packages/shared/src/index.ts')),
    );
  const helpers = workerTest.slice(
    workerTest.indexOf('function writeU16BE('),
    workerTest.indexOf("describe('ClientViewer"),
  );
  const wrapper = path.join(tmpdir(), `viewer-wrap-${process.pid}.ts`);
  const wasm = readFileSync(
    path.join(PROJECT_ROOT, 'apps/web/src/term-wasm/pkg/term_wasm_bg.wasm'),
  ).toString('base64');
  writeFileSync(
    wrapper,
    `${protocolImport}
import { initSync, init_display_receiver_calibration } from ${JSON.stringify(path.join(PROJECT_ROOT, 'apps/web/src/term-wasm/pkg/term_wasm.js'))};
import { createWasmClientViewerHandleFromInstance } from ${JSON.stringify(path.join(PROJECT_ROOT, 'apps/web/src/wasm-loader.ts'))};
import { createRenderMailbox } from ${JSON.stringify(path.join(PROJECT_ROOT, 'apps/web/src/terminal/render-mailbox.ts'))};
const COLS = 80, ROWS = 24;
${helpers}
const memory = initSync({ module: Uint8Array.from(atob(${JSON.stringify(wasm)}), c => c.charCodeAt(0)) }).memory;
(globalThis as any).clientViewerHarness = {
  create: () => createWasmClientViewerHandleFromInstance(memory, init_display_receiver_calibration(COLS, ROWS)),
  createRenderMailbox, buildFrame, fullGridRows,
};
`,
  );
  try {
    const result = spawnSync('bun', ['build', wrapper, '--format=iife', '--target=browser'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`viewer bundle failed: ${result.stderr}`);
    return result.stdout;
  } finally {
    rmSync(wrapper, { force: true });
  }
}

type Terminal = import('../../apps/web/src/wasm-loader').WasmClientViewerHandle;
type Mailbox = ReturnType<
  typeof import('../../apps/web/src/terminal/render-mailbox').createRenderMailbox
>;
interface FrameSpec {
  generation: number;
  seq: number;
  frameId: number;
  presentationId: number;
  rows: readonly { row: number; text: string }[];
  snapshot?: boolean;
  coherent?: boolean;
  end?: boolean;
  memberIndex?: number;
  memberCount?: number;
}
interface HarnessApi {
  create(): Terminal;
  createRenderMailbox(): Mailbox;
  buildFrame(spec: FrameSpec): Uint8Array;
  fullGridRows(marker: string): { row: number; text: string }[];
}
interface HarnessResult {
  paints: number;
  appliedFrames: number;
  firstPaintFrameCount: number;
  urgentPaintedBeforeYield: boolean;
}
const HARNESS = ([frameCount, coherent]: readonly [number, boolean]) =>
  new Promise<HarnessResult>((resolve, reject) => {
    const api = (window as unknown as { clientViewerHarness: HarnessApi }).clientViewerHarness;
    const terminal = api.create(),
      viewer = terminal.viewer,
      mailbox = api.createRenderMailbox();
    const period = 1000 / 60,
      mapping = { epoch: 1, localMinusWire: 0, wireMin: 1, wireMax: 0xffff_ffff };
    viewer.set_tracing(true);
    viewer.fence(performance.now(), 1);
    terminal.receive(
      performance.now(),
      4,
      api.buildFrame({
        generation: 1,
        seq: 0,
        frameId: 1,
        presentationId: 0,
        snapshot: true,
        rows: api.fullGridRows('s'),
      }),
      mapping,
    );
    viewer.present_now(performance.now());
    viewer.take_presentation_trace();
    let revision = terminal.presentationRevision(),
      paints = 0,
      firstApplied = 0,
      eligibleFrames = 0,
      firstPaintFrameCount = -1;
    let yielded = false,
      urgentPaintedBeforeYield = false,
      frame = 0,
      finished = false;
    const watchdog = setTimeout(() => finish(new Error('viewer harness timed out')), 10_000);
    function finish(error?: Error): void {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      cancelAnimationFrame(frame);
      const appliedFrames = Number(viewer.applied_frames()) - 1;
      terminal.destroy();
      if (error) reject(error);
      else
        resolve({
          paints,
          appliedFrames,
          firstPaintFrameCount,
          urgentPaintedBeforeYield,
        });
    }
    function drain(): void {
      while (viewer.poll_output(performance.now()) !== 0) {}
    }
    function submit(
      action: import('../../apps/web/src/terminal/render-mailbox').MailboxAction,
    ): void {
      if (action.kind !== 'render-now') return;
      paints++;
      if (paints === 1) firstPaintFrameCount = eligibleFrames;
      if (!yielded) urgentPaintedBeforeYield = true;
      const id = paints;
      mailbox.noteSubmitted(performance.now(), id);
      setTimeout(() => {
        if (!finished) submit(mailbox.noteFrameComplete(id));
      }, 0);
      // Finish on the final applied display's actual submission, independently
      // of host scheduling speed or how many frames delivery took.
      if (
        Number(viewer.applied_frames()) - 1 === frameCount &&
        new Uint32Array(terminal.memory.buffer, viewer.trace_words_ptr(), 17)[2] === frameCount
      )
        queueMicrotask(() => finish());
    }
    function observe(): void {
      const next = terminal.presentationRevision();
      if (next !== revision) {
        revision = next;
        viewer.take_presentation_trace();
        submit(mailbox.noteDirty(true));
      }
      drain();
    }
    function arm(): void {
      if (frame !== 0 || !viewer.wants_frame(true) || finished) return;
      frame = requestAnimationFrame((at) => {
        frame = 0;
        if (at >= firstApplied) eligibleFrames++;
        viewer.set_presentation_ready(true);
        viewer.frame(at, period, true, -1);
        observe();
        arm();
      });
    }
    function apply(seq: number): void {
      const at = performance.now();
      if (firstApplied === 0) firstApplied = at;
      viewer.set_presentation_ready(true);
      terminal.receive(
        at,
        3,
        api.buildFrame({
          generation: 1,
          seq,
          frameId: seq + 1,
          presentationId: coherent ? 17 : seq,
          coherent,
          end: seq === frameCount,
          memberIndex: seq - 1,
          memberCount: coherent ? frameCount : 0,
          rows: [{ row: seq % 24, text: `member-${seq}`.padEnd(80, 'x') }],
        }),
        mapping,
      );
      viewer.present_now(performance.now());
      observe();
      arm();
    }
    if (!coherent) {
      apply(1);
      queueMicrotask(() => {
        yielded = true;
      });
      return;
    }
    let seq = 1;
    const delivery = new MessageChannel();
    delivery.port1.onmessage = () => {
      try {
        apply(seq++);
      } catch (error) {
        delivery.port1.close();
        delivery.port2.close();
        finish(new Error(String(error)));
        return;
      }
      if (seq <= frameCount) delivery.port2.postMessage(0);
      else {
        delivery.port1.close();
        delivery.port2.close();
        yielded = true;
      }
    };
    delivery.port2.postMessage(0);
  });

test('dribbled coherent redraw releases within two frames; urgent updates precede yielding', async ({
  page,
}) => {
  await page.goto('data:text/html,<!doctype html><title>viewer presentation</title>');
  await page.addScriptTag({ content: buildViewerBundle() });
  const coherent = await page.evaluate(HARNESS, [REDRAW_FRAME_COUNT, true] as const);
  const urgent = await page.evaluate(HARNESS, [1, false] as const);
  expect(coherent.appliedFrames).toBe(REDRAW_FRAME_COUNT);
  expect(coherent.paints).toBeGreaterThanOrEqual(1);
  expect(coherent.firstPaintFrameCount).toBeGreaterThanOrEqual(1);
  expect(coherent.firstPaintFrameCount).toBeLessThanOrEqual(2);
  expect(urgent.appliedFrames).toBe(1);
  expect(urgent.paints).toBe(1);
  expect(urgent.urgentPaintedBeforeYield).toBe(true);
  expect(urgent.firstPaintFrameCount).toBe(0);
});

test('generation adoption drops old membership and releases current members at a real frame', async ({
  page,
}) => {
  await page.goto('data:text/html,<!doctype html><title>viewer generation adoption</title>');
  await page.addScriptTag({ content: buildViewerBundle() });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { clientViewerHarness: HarnessApi }).clientViewerHarness;
    const terminal = api.create(),
      viewer = terminal.viewer;
    const mapping = { epoch: 1, localMinusWire: 0, wireMin: 1, wireMax: 0xffff_ffff };
    try {
      viewer.fence(performance.now(), 1);
      viewer.set_tracing(true);
      terminal.receive(
        performance.now(),
        4,
        api.buildFrame({
          generation: 10,
          seq: 0,
          frameId: 1,
          presentationId: 0,
          snapshot: true,
          rows: api.fullGridRows('s'),
        }),
        mapping,
      );
      terminal.receive(
        performance.now(),
        3,
        api.buildFrame({
          generation: 10,
          seq: 1,
          frameId: 2,
          presentationId: 21,
          coherent: true,
          memberIndex: 0,
          memberCount: 2,
          rows: [{ row: 0, text: 'old'.padEnd(80, 'o') }],
        }),
        mapping,
      );
      const revision = terminal.presentationRevision();
      terminal.receive(
        performance.now(),
        4,
        api.buildFrame({
          generation: 11,
          seq: 1,
          frameId: 1,
          presentationId: 22,
          snapshot: true,
          rows: api.fullGridRows('n'),
        }),
        mapping,
      );
      // Urgent snapshots commit at the pump boundary before coherent members.
      viewer.present_now(performance.now());
      terminal.receive(
        performance.now(),
        3,
        api.buildFrame({
          generation: 11,
          seq: 2,
          frameId: 2,
          presentationId: 23,
          coherent: true,
          end: true,
          memberIndex: 0,
          memberCount: 1,
          rows: [{ row: 0, text: 'new'.padEnd(80, 'n') }],
        }),
        mapping,
      );
      const applied = performance.now();
      await new Promise<void>((resolve) => {
        function frame(at: number): void {
          if (at < applied) {
            requestAnimationFrame(frame);
            return;
          }
          viewer.frame(at, 1000 / 60, true, -1);
          resolve();
        }
        requestAnimationFrame(frame);
      });
      if (!viewer.take_presentation_trace()) throw new Error('missing committed core trace');
      const words = new Uint32Array(terminal.memory.buffer, viewer.trace_words_ptr(), 17);
      return {
        generation: viewer.generation(),
        revisionChanged: terminal.presentationRevision() > revision,
        disableBits: words[14],
        frames: words[15],
        reason: words[16],
      };
    } finally {
      terminal.destroy();
    }
  });
  expect(result).toEqual({
    generation: 11,
    revisionChanged: true,
    disableBits: 0,
    frames: 1,
    reason: 1,
  });
});
