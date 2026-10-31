import type { Page, Worker } from '@playwright/test';
import { expectShellPhase } from './app-state';
import { expect, test } from './fixtures/daemon-process';
import { setPerformanceReporting } from './fixtures/telemetry-consent';
import { connectTerminal } from './terminal-e2e-helpers';

/**
 * Count the terminal worker's real GPU queue separately from page work. A page
 * init script cannot reach workers. Empty submits count too: Gecko may need
 * them to deliver an awaited completion, but a settled idle session owes none.
 * Reporting off also parks main's frame monitor. Reporting on keeps that
 * diagnostic monitor, while the terminal and waveform must still park.
 * Controls exercise actual terminal output before the eight-second idle window.
 * The strip's final empty publication and cleared recovery state open the window.
 */

const CONTROL_WINDOW_MS = 600;
const IDLE_WINDOW_MS = 8_000;

interface IdleCounts {
  readonly animationFrames: number;
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

/** Installed before the app boots; watches main-thread work and worker publications. */
function installIdleAudit(): void {
  const RING_COLUMNS = 64;
  const counts = { animationFrames: 0, canvasFills: 0, linkTicks: 0 };
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

  // The link strip draws through an OffscreenCanvas transferred from its element.
  const fillRect = OffscreenCanvasRenderingContext2D.prototype.fillRect;
  OffscreenCanvasRenderingContext2D.prototype.fillRect = function (
    this: OffscreenCanvasRenderingContext2D,
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

  const audit: IdleAudit = {
    counts: () => ({ ...counts }),
    evidence: () => ({ stripEmpty, recoveryClear, events: [...events] }),
    reset: () => {
      counts.animationFrames = 0;
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

function installTerminalGpuAudit(worker: Worker) {
  return worker.evaluateHandle(() => {
    const counts = { submits: 0, emptySubmits: 0 };
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (commands): void {
      counts.submits += 1;
      if (Array.isArray(commands) && commands.length === 0) counts.emptySubmits += 1;
      submit.call(this, commands);
    };
    return {
      counts: () => ({ ...counts }),
      reset: () => {
        counts.submits = 0;
        counts.emptySubmits = 0;
      },
    };
  });
}

for (const reporting of [false, true]) {
  test(`a connected idle terminal submits no GPU work [reporting=${reporting}]`, async ({
    page,
    linkedDaemon,
  }, testInfo) => {
    try {
      // Consent must be set before this session creates its workers.
      await setPerformanceReporting(page, reporting);
      await page.addInitScript(installIdleAudit);
      await page.reload();
      await expectShellPhase(page);
      await expect(page.getByTitle(`Connect to ${linkedDaemon.daemonName}`)).toBeVisible({
        timeout: 30_000,
      });
      const counters = audit(page);

      // Control: main's animation-frame counter observes a delivered callback.
      await counters.reset();
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      const control = await counters.counts();
      expect(control.animationFrames).toBeGreaterThan(0);

      if (!reporting) {
        // The machine list itself is idle: the screen that stays open draws nothing.
        // Its entrance is still finishing when its rows first show, so the window
        // opens once two frames pass with nothing but this probe's own two callbacks
        // in them; a loop that never stops never gets there.
        await expect
          .poll(async () => {
            await counters.reset();
            await page.evaluate(
              () =>
                new Promise<void>((resolve) => {
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                }),
            );
            return (await counters.counts()).animationFrames;
          })
          .toBe(2);
        await counters.reset();
        await page.waitForTimeout(CONTROL_WINDOW_MS);
        const listing = await counters.counts();
        expect(listing.animationFrames).toBe(0);
      }

      await connectTerminal(page, linkedDaemon.daemonName);

      const worker = page
        .workers()
        .find((candidate) => new URL(candidate.url()).pathname.includes('/terminal-worker-'));
      if (worker === undefined) throw new Error('terminal worker not found');
      const gpu = await installTerminalGpuAudit(worker);

      // Control: real terminal output must reach the worker's GPU queue.
      await counters.reset();
      await gpu.evaluate((installed) => installed.reset());
      await page.keyboard.type("printf 'idle-audit-%s\\n' control\n");
      await expect(page.getByRole('log', { name: 'Terminal output' })).toContainText(
        'idle-audit-control',
      );
      await expect.poll(async () => (await counters.counts()).linkTicks).toBeGreaterThan(0);
      await expect.poll(async () => (await counters.counts()).canvasFills).toBeGreaterThan(0);

      await expect
        .poll(async () => {
          const counts = await gpu.evaluate((installed) => installed.counts());
          return counts.submits - counts.emptySubmits;
        })
        .toBeGreaterThan(0);
      const outputControl = {
        page: await counters.counts(),
        gpu: await gpu.evaluate((installed) => installed.counts()),
      };

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
      await gpu.evaluate((installed) => installed.reset());
      const startedAtMs = Date.now();
      await page.waitForTimeout(IDLE_WINDOW_MS);
      const endedAtMs = Date.now();
      const idle = await counters.counts();
      const evidence = await counters.evidence();
      const gpuIdle = await gpu.evaluate((installed) => installed.counts());
      await testInfo.attach('idle-terminal.png', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      // The session stays live while parked: input and authoritative output still draw.
      await gpu.evaluate((installed) => installed.reset());
      await page.keyboard.type("printf 'idle-audit-%s\\n' resumed\n");
      await expect(page.getByRole('log', { name: 'Terminal output' })).toContainText(
        'idle-audit-resumed',
      );
      const resumed = await gpu.evaluate((installed) => installed.counts());
      expect(resumed.submits - resumed.emptySubmits).toBeGreaterThan(0);
      await gpu.dispose();
      const measurement = {
        reporting,
        startedAtMs,
        endedAtMs,
        outputControl,
        idle,
        gpuIdle,
        resumed,
      };
      process.stdout.write(`[idle-work] ${JSON.stringify(measurement)}\n`);
      await testInfo.attach('idle-work.json', {
        body: JSON.stringify(measurement, null, 2),
        contentType: 'application/json',
      });
      expect(gpuIdle).toEqual({ submits: 0, emptySubmits: 0 });
      expect(idle.canvasFills, evidence.events.join('\n')).toBe(0);
      expect(idle.linkTicks, evidence.events.join('\n')).toBe(0);
      if (!reporting) expect(idle.animationFrames, evidence.events.join('\n')).toBe(0);
    } finally {
      await setPerformanceReporting(page, true);
    }
  });
}
