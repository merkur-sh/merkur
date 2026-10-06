import type { Page } from '@playwright/test';
import { expectShellPhase } from './app-state';
import { expect, test } from './fixtures/daemon-process';
import { connectTerminal } from './terminal-e2e-helpers';

/**
 * A connected terminal that nobody is typing at, and that prints nothing, costs
 * the main thread nothing per frame. Four counters, all of which must read zero
 * across an idle window in the real production build against the real daemon
 * and edge:
 *
 * - animation frames on main: the terminal's own rendering lives in a worker,
 *   and the shell has nothing to animate once it has arrived;
 * - WebGL draws: the machine-list mark is still mounted behind the terminal at
 *   opacity zero, and used to keep drawing there for the whole session;
 * - 2D canvas fills: the link-status waveform repaints only when its pixels
 *   change, and nothing changes them while the terminal is quiet;
 * - waveform publications from the transport worker: the heartbeat is link
 *   traffic, not terminal traffic, and must not keep the strip scrolling.
 *
 * Telemetry is off, as it is for anyone who never opted in, so the frame
 * monitor profiling installs is not part of the measurement. The two control
 * phases prove each counter can move before the idle window asserts that none
 * of them does, so a broken counter cannot pass as a quiet page. The window
 * opens on an exact signal rather than a settle guess: the worker's latest
 * publication shows no traffic in the strip's visible columns, which is the
 * publication after which it parks.
 */

const CONTROL_WINDOW_MS = 600;
const IDLE_WINDOW_MS = 8_000;

interface IdleCounts {
  readonly animationFrames: number;
  readonly webglDraws: number;
  readonly canvasFills: number;
  readonly linkTicks: number;
}

/** What moved and when, for the failure message; times are ms since the last reset. */
interface IdleEvidence {
  /** The latest waveform publication showed no traffic in the visible columns. */
  readonly stripEmpty: boolean;
  /**
   * The latest heartbeat projection carried no recent display recovery. A
   * session start counts as one, and the strip recolours once when its window
   * closes, so the idle window opens only after that projection has arrived.
   */
  readonly recoveryClear: boolean;
  readonly events: readonly string[];
}

interface IdleAudit {
  counts(): IdleCounts;
  evidence(): IdleEvidence;
  reset(): void;
}

/** Installed before the app boots; wraps the four primitives the counters watch. */
function installIdleAudit(): void {
  const RING_COLUMNS = 64;
  const counts = { animationFrames: 0, webglDraws: 0, canvasFills: 0, linkTicks: 0 };
  const events: string[] = [];
  let epoch = performance.now();
  let stripColumns = 0;
  let stripEmpty = false;
  let recoveryClear = false;
  const note = (label: string): void => {
    events.push(`${(performance.now() - epoch).toFixed(0)}ms ${label}`);
  };

  const requestFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    requestFrame((time) => {
      counts.animationFrames += 1;
      callback(time);
    });

  const drawArrays = WebGL2RenderingContext.prototype.drawArrays;
  WebGL2RenderingContext.prototype.drawArrays = function (
    this: WebGL2RenderingContext,
    mode: number,
    first: number,
    count: number,
  ): void {
    counts.webglDraws += 1;
    drawArrays.call(this, mode, first, count);
  };

  const fillRect = CanvasRenderingContext2D.prototype.fillRect;
  CanvasRenderingContext2D.prototype.fillRect = function (
    this: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    counts.canvasFills += 1;
    note(`fill ${this.canvas.width}x${this.canvas.height} rect(${x},${y},${w},${h})`);
    fillRect.call(this, x, y, w, h);
  };

  // The strip's width reaches the worker in the subscription; the worker's
  // publications come back through `onmessage`. Both cross `Worker`.
  const postMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]): void {
    const message = args[0];
    if (typeof message === 'object' && message !== null) {
      const { kind, columns } = message as { kind?: unknown; columns?: unknown };
      if (kind === 'observe_link' && typeof columns === 'number') stripColumns = columns;
    }
    Reflect.apply(postMessage, this, args);
  };
  const onmessage = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage');
  if (onmessage?.get !== undefined && onmessage.set !== undefined) {
    const getHandler = onmessage.get;
    const setHandler = onmessage.set;
    Object.defineProperty(Worker.prototype, 'onmessage', {
      configurable: true,
      get(this: Worker) {
        return getHandler.call(this);
      },
      set(this: Worker, handler: ((event: MessageEvent) => void) | null) {
        setHandler.call(
          this,
          handler === null
            ? null
            : (event: MessageEvent) => {
                const data: unknown = event.data;
                if (typeof data === 'object' && data !== null) {
                  const message = data as {
                    kind?: unknown;
                    tick?: unknown;
                    buckets?: unknown;
                    rttMs?: unknown;
                    linkState?: unknown;
                    degraded?: unknown;
                    pathType?: unknown;
                  };
                  if (message.kind === 'link_tick') {
                    counts.linkTicks += 1;
                    if (
                      typeof message.tick === 'number' &&
                      message.buckets instanceof Float64Array
                    ) {
                      let empty = true;
                      for (let at = message.tick - stripColumns + 1; at <= message.tick; at += 1) {
                        if (at < 0) continue;
                        const slot = (at % RING_COLUMNS) * 2;
                        if (message.buckets[slot] !== 0 || message.buckets[slot + 1] !== 0) {
                          empty = false;
                          break;
                        }
                      }
                      stripEmpty = empty;
                      note(`link_tick tick=${message.tick} empty=${String(empty)}`);
                    }
                  } else if (message.kind === 'metrics') {
                    recoveryClear = message.degraded === false;
                    note(
                      `metrics rtt=${String(message.rttMs)} state=${String(message.linkState)} degraded=${String(message.degraded)} path=${String(message.pathType)}`,
                    );
                  } else if (message.kind !== 'ready') {
                    note(`worker ${String(message.kind)}`);
                  }
                }
                handler.call(this, event);
              },
        );
      },
    });
  }

  // The fixture seeds the opt-in for every other spec; this one measures the
  // default a user who never opened preferences gets.
  localStorage.removeItem('merkur:telemetry-enabled');

  const audit: IdleAudit = {
    counts: () => ({ ...counts }),
    evidence: () => ({ stripEmpty, recoveryClear, events: [...events] }),
    reset: () => {
      counts.animationFrames = 0;
      counts.webglDraws = 0;
      counts.canvasFills = 0;
      counts.linkTicks = 0;
      events.length = 0;
      epoch = performance.now();
    },
  };
  (window as unknown as { __merkurIdleAudit: IdleAudit }).__merkurIdleAudit = audit;
}

/** Each reader is serialized into the page, so each resolves the audit itself. */
function audit(page: Page): {
  counts(): Promise<IdleCounts>;
  evidence(): Promise<IdleEvidence>;
  reset(): Promise<void>;
} {
  return {
    counts: () =>
      page.evaluate(() => {
        const installed = (window as unknown as { __merkurIdleAudit?: IdleAudit })
          .__merkurIdleAudit;
        if (installed === undefined) throw new Error('idle audit is not installed');
        return installed.counts();
      }),
    evidence: () =>
      page.evaluate(() => {
        const installed = (window as unknown as { __merkurIdleAudit?: IdleAudit })
          .__merkurIdleAudit;
        if (installed === undefined) throw new Error('idle audit is not installed');
        return installed.evidence();
      }),
    reset: () =>
      page.evaluate(() => {
        const installed = (window as unknown as { __merkurIdleAudit?: IdleAudit })
          .__merkurIdleAudit;
        if (installed === undefined) throw new Error('idle audit is not installed');
        installed.reset();
      }),
  };
}

test('a connected idle terminal runs no frames, draws, or waveform publications', async ({
  page,
  linkedDaemon,
}) => {
  await page.addInitScript(installIdleAudit);
  await page.reload();
  await expectShellPhase(page);
  await expect(page.getByTitle(`Connect to ${linkedDaemon.daemonName}`)).toBeVisible({
    timeout: 30_000,
  });
  expect(await page.evaluate(() => localStorage.getItem('merkur:telemetry-enabled'))).toBeNull();
  const counters = audit(page);

  // Control: on the machine list the mark is showing, so frames and draws move.
  await counters.reset();
  await page.waitForTimeout(CONTROL_WINDOW_MS);
  const listing = await counters.counts();
  expect(listing.animationFrames).toBeGreaterThan(0);
  expect(listing.webglDraws).toBeGreaterThan(0);

  await connectTerminal(page, linkedDaemon.daemonName);

  // Control: terminal output publishes snapshots and paints the strip.
  await counters.reset();
  await page.keyboard.type("printf 'idle-audit-control\\n'\n");
  await expect.poll(async () => (await counters.counts()).linkTicks).toBeGreaterThan(0);
  await expect.poll(async () => (await counters.counts()).canvasFills).toBeGreaterThan(0);

  // The burst scrolls off the strip. The publication that shows the empty strip
  // is the one the worker parks after; its paint lands on the next frame. The
  // session start's display recovery has to have aged out too: the strip
  // recolours once when that window closes, on the heartbeat that reports it.
  await expect
    .poll(
      async () => {
        const evidence = await counters.evidence();
        return evidence.stripEmpty && evidence.recoveryClear;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

  await counters.reset();
  await page.waitForTimeout(IDLE_WINDOW_MS);
  const idle = await counters.counts();
  const evidence = await counters.evidence();
  expect(idle, evidence.events.join('\n')).toEqual({
    animationFrames: 0,
    webglDraws: 0,
    canvasFills: 0,
    linkTicks: 0,
  } satisfies IdleCounts);
});
