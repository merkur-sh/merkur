import { writeFile } from 'node:fs/promises';

import type { Page, TestInfo } from '@playwright/test';
import type {
  TerminalWorkerDiagnostics,
  WorkerEvent,
} from '../../apps/web/src/terminal-worker-protocol';

import { expect, test } from './fixtures/daemon-process';
import { connectTerminal, expectOutput, primeTerminal } from './terminal-e2e-helpers';

const EDGE_ACTIVE = process.env.EDGE_NETWORK_ACTIVE === '1';
const EDGE_TARGET_RTT_MS = EDGE_ACTIVE ? Number(process.env.EDGE_NETWORK_TARGET_RTT_MS ?? 0) : 0;
const EDGE_DATAGRAM_LOSS_PERCENT = EDGE_ACTIVE
  ? Number(process.env.EDGE_NETWORK_DATAGRAM_LOSS_PERCENT ?? 0)
  : 0;
const PROFILE_NAME = EDGE_ACTIVE
  ? `${process.env.EDGE_NETWORK_PROFILE ?? 'unknown'}(rtt=${EDGE_TARGET_RTT_MS}ms,datagram-loss=${EDGE_DATAGRAM_LOSS_PERCENT}%@edge-to-client)`
  : 'clean';
// The profile name carries `/` and `(`, which an attachment path cannot.
const PROFILE_SLUG = PROFILE_NAME.replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '');

/**
 * Resize stability.
 *
 * The latency matrix already drives real resizes, but it asserts only the
 * generic input gates, and `handleResize` abandons its in-flight latency frame
 * on purpose — so no existing percentile can see a resize at all. These tests
 * measure the thing a user actually reports: how much the terminal contents
 * move while a window edge is dragged.
 *
 * Each geometry commit writes the grid canvas's `style`, so a `MutationObserver`
 * on that attribute counts commits exactly, the same technique
 * `simulateKeyboardViewportAnimation` uses in the touch matrix.
 */

interface GeometryRecord {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
  readonly containerWidth: number;
  readonly containerHeight: number;
  readonly devicePixelRatio: number;
}

declare global {
  interface Window {
    __merkurGeometryRecords?: GeometryRecord[];
    __merkurRasterProbe?: {
      changeDensity(dpr: number): void;
      readHealth(): void;
      health: TerminalWorkerDiagnostics | null;
      applied: Extract<WorkerEvent, { kind: 'display_state_applied' }> | null;
    };
  }
}

test('raster density changes rebuild the live canvas and publish matching CSS metrics', async ({
  page,
  linkedDaemon,
}, testInfo) => {
  // Inject the environment edge, not a worker command: this exercises the
  // production matchMedia listener, worker owner, WASM, GPU and CSS consumer.
  // Physical screenshot fidelity is checked separately at real context DPRs.
  await page.evaluate(() => {
    const mediaQueries = new Set<MediaQueryList>();
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const media = matchMedia(query);
      if (query.startsWith('(resolution:')) mediaQueries.add(media);
      return media;
    };
    let terminal: Worker | null = null;
    const probe: NonNullable<Window['__merkurRasterProbe']> = {
      health: null,
      applied: null,
      readHealth() {
        terminal?.postMessage({ kind: 'worker_health_check' });
      },
      changeDensity(dpr) {
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr });
        probe.health = null;
        probe.applied = null;
        for (const media of [...mediaQueries]) media.dispatchEvent(new Event('change'));
      },
    };
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).includes('terminal-worker')) return;
        terminal = this;
        this.addEventListener('message', (event: MessageEvent<WorkerEvent>) => {
          if (event.data.kind === 'worker_health') probe.health = event.data.diagnostics;
          if (event.data.kind === 'display_state_applied') probe.applied = event.data;
        });
      }
    };
    window.__merkurRasterProbe = probe;
  });
  await connectTerminal(page, linkedDaemon.daemonName);
  const records: unknown[] = [];
  const initialDensity = await page.evaluate(() => window.devicePixelRatio);
  for (const dpr of [initialDensity === 2 ? 1 : 2, 1.25, 0.8, 3, 1]) {
    await page.evaluate((density) => window.__merkurRasterProbe?.changeDensity(density), dpr);
    await expect
      .poll(() => page.evaluate(() => window.__merkurRasterProbe?.applied ?? null))
      .not.toBeNull();
    await expect
      .poll(async () => {
        await page.evaluate(() => window.__merkurRasterProbe?.readHealth());
        return page.evaluate(() => window.__merkurRasterProbe?.health?.devicePixelRatio);
      })
      .toBe(dpr);
    await expectSettledGridFits(page);
    const sample = await page.evaluate(() => {
      const probe = window.__merkurRasterProbe;
      const canvas = document.querySelector('#terminal-output canvas');
      if (!probe?.health || !probe.applied || !(canvas instanceof HTMLCanvasElement)) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        health: probe.health,
        applied: probe.applied,
        cssWidth: rect.width,
        cssHeight: rect.height,
      };
    });
    expect(sample).not.toBeNull();
    if (sample === null) throw new Error('missing raster sample');
    expect(sample.health.pixelWidth).toBeCloseTo(sample.cssWidth * dpr, 0);
    expect(sample.health.pixelHeight).toBeCloseTo(sample.cssHeight * dpr, 0);
    expect(sample.applied.baseline * dpr).toBeCloseTo(Math.round(sample.applied.baseline * dpr), 5);
    records.push(sample);
  }
  await page.keyboard.insertText("printf 'density-change-ok\\n'\n");
  await expectOutput(page.getByRole('log', { name: 'Terminal output' }), 'density-change-ok');
  await attachJson(testInfo, 'raster-density-changes.json', records);
});

async function installGeometryRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const container = document.querySelector('#terminal-output');
    if (!(container instanceof HTMLElement)) throw new Error('terminal container missing');
    const canvas = container.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('grid canvas missing');

    const records: GeometryRecord[] = [];
    const capture = (): void => {
      const canvasRect = canvas.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      records.push({
        canvasWidth: canvasRect.width,
        canvasHeight: canvasRect.height,
        offsetLeft: canvasRect.left - containerRect.left,
        offsetTop: canvasRect.top - containerRect.top,
        containerWidth: containerRect.width,
        containerHeight: containerRect.height,
        devicePixelRatio: window.devicePixelRatio || 1,
      });
    };

    new MutationObserver(capture).observe(canvas, {
      attributes: true,
      attributeFilter: ['style'],
    });
    // Baseline, so the first drag step is compared against a real grid rather
    // than against nothing.
    capture();
    window.__merkurGeometryRecords = records;
  });
}

async function readGeometryRecords(page: Page): Promise<GeometryRecord[]> {
  return await page.evaluate(() => window.__merkurGeometryRecords ?? []);
}

/**
 * Attachments carrying only a `body` live in the reporter's memory and are gone
 * once the run ends, which is why the latency fixture writes its summary to
 * `outputPath` first. Same here: a measurement that does not survive its run is
 * not evidence.
 */
async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  const path = testInfo.outputPath(name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  await testInfo.attach(name, { contentType: 'application/json', path });
}

/**
 * The settled grid must fit the box that measured it. Only the settled state is
 * gated: between asking the worker for a grid and its painting one, the canvas
 * still shows the previous grid at its own size, so it can overhang the
 * container by up to a cell. That transient is reported below, not asserted —
 * clipping the old grid for a frame is correct, and the alternative is scaling
 * it.
 */
async function expectSettledGridFits(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.locator('#terminal-output').evaluate((container) => {
          const canvas = container.querySelector('canvas');
          if (!(canvas instanceof HTMLCanvasElement)) return false;
          const canvasRect = canvas.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          return (
            canvasRect.width <= containerRect.width + 0.5 &&
            canvasRect.height <= containerRect.height + 0.5
          );
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
}

/**
 * Asserts the invariants that make a drag look still, and attaches the counts
 * so a regression can be attributed rather than merely detected.
 */
async function expectStableGeometry(
  testInfo: TestInfo,
  name: string,
  records: readonly GeometryRecord[],
  stepCount: number,
): Promise<void> {
  expect(records.length).toBeGreaterThan(0);

  const gridChanges = records.filter(
    (record, index) =>
      index === 0 ||
      record.canvasWidth !== records[index - 1]?.canvasWidth ||
      record.canvasHeight !== records[index - 1]?.canvasHeight,
  ).length;
  const maxOvershootX = Math.max(
    0,
    ...records.map((record) => record.canvasWidth - record.containerWidth),
  );
  const maxOvershootY = Math.max(
    0,
    ...records.map((record) => record.canvasHeight - record.containerHeight),
  );

  await attachJson(testInfo, `geometry-${name}.json`, {
    stepCount,
    commits: records.length,
    gridChanges,
    maxOvershootX,
    maxOvershootY,
    records,
  });

  for (const [index, record] of records.entries()) {
    // The grid is anchored at the container's origin. A derived, re-centred
    // origin slid the contents by a sub-cell amount on every commit and, when
    // it landed off the device-pixel grid, made the compositor resample every
    // glyph rather than blit it.
    expect(record.offsetLeft, `record ${index} left`).toBeCloseTo(0, 5);
    expect(record.offsetTop, `record ${index} top`).toBeCloseTo(0, 5);
  }

  // Every commit must have moved the grid. A commit that rewrites identical
  // geometry still clears the selection and speculative backing stores, and it
  // is exactly what a settle loop that re-measured every frame produced at
  // each pause in pointer motion.
  expect(records.length, 'geometry commits').toBe(gridChanges);
}

test('resize stability: a horizontal drag commits only when the grid changes', async ({
  page,
  linkedDaemon,
}, testInfo) => {
  await page.setViewportSize({ width: 1_000, height: 700 });
  await connectTerminal(page, linkedDaemon.daemonName);
  await installGeometryRecorder(page);

  // One pixel at a time, the way a pointer drag delivers it: several steps per
  // column, so a rule that reacts to the container rather than to the grid has
  // many chances to commit.
  const stepCount = 40;
  for (let step = 1; step <= stepCount; step += 1) {
    await page.setViewportSize({ width: 1_000 - step, height: 700 });
  }
  await expect.poll(async () => (await readGeometryRecords(page)).length).toBeGreaterThan(0);

  await expectStableGeometry(testInfo, 'horizontal', await readGeometryRecords(page), stepCount);
  await expectSettledGridFits(page);
});

test('resize stability: a vertical drag never overshoots the viewport', async ({
  page,
  linkedDaemon,
}, testInfo) => {
  await page.setViewportSize({ width: 1_000, height: 700 });
  await connectTerminal(page, linkedDaemon.daemonName);
  await installGeometryRecorder(page);

  const stepCount = 40;
  for (let step = 1; step <= stepCount; step += 1) {
    await page.setViewportSize({ width: 1_000, height: 700 - step });
  }
  await expect.poll(async () => (await readGeometryRecords(page)).length).toBeGreaterThan(0);

  await expectStableGeometry(testInfo, 'vertical', await readGeometryRecords(page), stepCount);
  await expectSettledGridFits(page);
});

/**
 * Above the column clamp the *box* centres and the grid still starts at its
 * origin. That is the whole reason the derived origin could be deleted, and
 * until now nothing exercised it: the old centring offset was replaced by
 * `max-width` plus `margin-inline: auto`, and no viewport in the suite is wide
 * enough for 512 columns to stop filling it.
 */
test('resize stability: the column clamp centres the box, not the grid', async ({
  page,
  linkedDaemon,
}) => {
  await page.setViewportSize({ width: 1_000, height: 700 });
  await connectTerminal(page, linkedDaemon.daemonName);
  // Wider than 512 cells at any sane cell width, so the clamp has to bind.
  await page.setViewportSize({ width: 6_000, height: 700 });

  await expect
    .poll(
      () =>
        page.locator('#terminal-output').evaluate((container) => {
          const canvas = container.querySelector('canvas');
          const parent = container.parentElement;
          if (!(canvas instanceof HTMLCanvasElement) || parent === null) return null;
          const canvasRect = canvas.getBoundingClientRect();
          const boxRect = container.getBoundingClientRect();
          const parentRect = parent.getBoundingClientRect();
          return {
            boxIsClamped: boxRect.width < parentRect.width - 1,
            gridSitsAtBoxOrigin: Math.abs(canvasRect.left - boxRect.left) < 0.5,
            boxIsCentred:
              Math.abs(boxRect.left - parentRect.left - (parentRect.right - boxRect.right)) < 1.5,
          };
        }),
      { timeout: 20_000 },
    )
    .toEqual({ boxIsClamped: true, gridSitsAtBoxOrigin: true, boxIsCentred: true });
});

/**
 * The price of the atomic-resize option.
 *
 * The browser terminal cannot rewrap — no parser, no wrap flags — so the grid
 * it paints immediately after a resize is a truncate-and-pad guess that the
 * daemon's rewrapped snapshot then replaces. Committing only at the
 * authoritative edge would make each step atomic, at the cost of showing the
 * previous grid until that snapshot lands. That cost is exactly the window the
 * worker reports as `resize_authority_window`, so it is measured rather than
 * argued — and it is measured on the impaired profile, where it is largest.
 *
 * Reported, not gated: a limit set before the term was ever measured would be
 * arbitrary, which is the same rule the felt-latency sub-terms follow.
 */

interface ResizeAuthoritySample {
  readonly ms: number;
  readonly grid: string;
  readonly kind: string;
  /** The unparsed diagnostic, so an artifact carries fields this does not. */
  readonly detail: string;
  /** Rows the daemon's frame changed relative to the worker's own rewrap. */
  readonly corrected: number;
  readonly rows: number;
}

function collectResizeAuthorityWindows(page: Page): ResizeAuthoritySample[] {
  const samples: ResizeAuthoritySample[] = [];
  page.on('console', (message) => {
    if (!message.text().includes('terminal_display_diag')) return;
    const context = message.args()[1];
    if (context === undefined) return;
    void context
      .jsonValue()
      .then((value: unknown) => {
        if (value === null || typeof value !== 'object') return;
        const record = value as { event?: unknown; detail?: unknown };
        if (record.event !== 'resize_authority_window') return;
        const detail = typeof record.detail === 'string' ? record.detail : '';
        const ms = Number(/ms=([0-9.]+)/.exec(detail)?.[1]);
        if (!Number.isFinite(ms)) return;
        const correction = /corrected=(-?\d+)\/(\d+)/.exec(detail);
        samples.push({
          ms,
          grid: /grid=(\S+)/.exec(detail)?.[1] ?? '',
          kind: /kind=(\S+)/.exec(detail)?.[1] ?? '',
          detail,
          corrected: Number(correction?.[1] ?? Number.NaN),
          rows: Number(correction?.[2] ?? Number.NaN),
        });
      })
      .catch(() => {
        // A console handle can be disposed before it is read. Dropping a
        // sample is a smaller lie than fabricating one.
      });
  });
  return samples;
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}

/**
 * Ceiling on the share of rows a narrowing resize may leave for the daemon to
 * correct.
 *
 * Set from measurement, not from principle. Measured at 0 and 1 of 36 rows —
 * row 0, the leading fragment whose logical line starts in scrollback this
 * terminal does not hold. Before the row prefix carried a wrap bit the same
 * measurement read 33 of 36: with no way to know a line continued, the local
 * resize truncated every wrapped row and the daemon's frame rewrote the screen.
 * The limit sits between the two with room for the fragment and a prompt line,
 * far enough below 33/36 that losing the bit again fails here. See *Wrap flags
 * in the row prefix* in PERF.md.
 */
const REFLOW_CORRECTION_LIMIT = 4 / 36;

/** Lines wide enough to wrap, so the daemon's reflow really does differ. */
function wrappedOutputCommand(rows: number, width: number, marker: string): string {
  const fill = 'x'.repeat(width);
  return (
    `i=0; while [ $i -lt ${rows} ]; do ` +
    `printf 'wrap-%03d-${fill}\\n' "$i"; i=$((i+1)); done; printf '${marker}\\n'\n`
  );
}

test('resize authority: how long a guessed reflow stays on screen', async ({
  page,
  linkedDaemon,
}, testInfo) => {
  const marker = 'geometry-authority-ok';
  await page.setViewportSize({ width: 1_000, height: 700 });
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await page.keyboard.type(wrappedOutputCommand(40, 300, marker));
  await expectOutput(output, marker, 30_000);

  const samples = collectResizeAuthorityWindows(page);

  // Each step crosses several columns, so every one forces a real daemon
  // reflow rather than a no-op resize.
  const widths = [940, 880, 820, 880, 940, 1_000];
  for (const width of widths) {
    const before = samples.length;
    await page.setViewportSize({ width, height: 700 });
    await expect.poll(() => samples.length, { timeout: 30_000 }).toBeGreaterThan(before);
  }

  const observed = samples.map((sample) => sample.ms).sort((left, right) => left - right);
  await attachJson(testInfo, `resize-authority-${PROFILE_SLUG}.json`, {
    profile: PROFILE_NAME,
    edgeTargetRttMs: EDGE_TARGET_RTT_MS,
    edgeDatagramLossPercent: EDGE_DATAGRAM_LOSS_PERCENT,
    steps: widths.length,
    sampleCount: observed.length,
    p50Ms: nearestRank(observed, 0.5),
    p95Ms: nearestRank(observed, 0.95),
    maxMs: observed[observed.length - 1] ?? Number.NaN,
    samples,
  });

  expect(observed.length).toBeGreaterThanOrEqual(widths.length);
  // Every sample must be a real elapsed window, never a zero that would make
  // the option look free.
  expect(observed[0]).toBeGreaterThan(0);
});

/**
 * What the local rewrap gets right.
 *
 * `resize authority` above measures how long the guess is on screen. This
 * measures how *wrong* it is while it is there, which is the number the row
 * wrap bit was added to move: the worker hashes every row of the grid it
 * rewrapped for itself, and the daemon's authoritative frame is then compared
 * against it row for row. A row in that count is a row the user watched change
 * twice for one resize.
 *
 * Narrowing only. Widening rejoins wrapped rows and pulls scrollback down into
 * the space that frees; this terminal holds no scrollback, so it fills from the
 * top with blanks and those rows are corrected by definition. The daemon's own
 * grid is the one place that answer lives, and waiting for it is the option
 * already priced and rejected in PERF.md.
 */
test('resize reflow: the local rewrap already matches the daemon', async ({
  page,
  linkedDaemon,
}, testInfo) => {
  const marker = 'geometry-reflow-ok';
  await page.setViewportSize({ width: 1_000, height: 700 });
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await page.keyboard.type(wrappedOutputCommand(40, 300, marker));
  await expectOutput(output, marker, 30_000);

  // Park the shell in a foreground command before measuring. A `SIGWINCH` that
  // reaches readline makes bash redraw its prompt, which is real content change
  // originating at the daemon; counting it as a mis-guessed row would measure
  // bash rather than the reflow.
  await page.keyboard.type('sleep 60\n');
  await page.waitForTimeout(1_500);

  const samples = collectResizeAuthorityWindows(page);

  // Narrowing only, several columns per step so every one forces a real reflow
  // on both ends rather than a no-op resize.
  const widths = [940, 880, 820, 760, 700];
  for (const width of widths) {
    const before = samples.length;
    await page.setViewportSize({ width, height: 700 });
    await expect.poll(() => samples.length, { timeout: 30_000 }).toBeGreaterThan(before);
  }

  const measured = samples.filter((sample) => Number.isFinite(sample.corrected));
  const rows = measured[0]?.rows ?? 0;
  const correctedFractions = measured
    .map((sample) => sample.corrected / sample.rows)
    .sort((left, right) => left - right);
  await attachJson(testInfo, `resize-reflow-${PROFILE_SLUG}.json`, {
    profile: PROFILE_NAME,
    edgeTargetRttMs: EDGE_TARGET_RTT_MS,
    edgeDatagramLossPercent: EDGE_DATAGRAM_LOSS_PERCENT,
    steps: widths.length,
    rows,
    corrected: measured.map((sample) => sample.corrected),
    p50CorrectedFraction: nearestRank(correctedFractions, 0.5),
    p95CorrectedFraction: nearestRank(correctedFractions, 0.95),
    samples: measured,
  });

  expect(measured.length).toBeGreaterThanOrEqual(widths.length);
  expect(rows).toBeGreaterThan(0);
  // Every sample must be a real comparison. `-1` is the worker declining to
  // compare a grid whose row count moved under it, and averaging that in would
  // read as a perfect guess.
  for (const sample of measured) {
    expect(sample.corrected, `sample ${JSON.stringify(sample)}`).toBeGreaterThanOrEqual(0);
  }
  expect(nearestRank(correctedFractions, 0.95)).toBeLessThanOrEqual(REFLOW_CORRECTION_LIMIT);
});

/**
 * Renders per resize.
 *
 * A resize repaints synchronously, because `resizeDisplaySurface` clears the
 * backing store and the terminal would otherwise show a blank buffer. Whether
 * a second, scheduled render follows that one is the difference this measures.
 *
 * Reported, not gated: the background render rate of a live terminal is not
 * something this spec controls, so an absolute threshold would be arbitrary.
 * The number is here to be compared between two lineages on one machine.
 */
test('resize paints: renders per geometry commit', async ({
  page,
  linkedDaemon,
  terminalPerf,
}, testInfo) => {
  await page.setViewportSize({ width: 1_000, height: 700 });
  await connectTerminal(page, linkedDaemon.daemonName);
  await installGeometryRecorder(page);
  await terminalPerf.reset();

  const widths = [940, 880, 820, 880, 940, 1_000];
  for (const width of widths) {
    const before = (await readGeometryRecords(page)).length;
    await page.setViewportSize({ width, height: 700 });
    await expect
      .poll(async () => (await readGeometryRecords(page)).length, { timeout: 30_000 })
      .toBeGreaterThan(before);
  }

  const snapshot = await terminalPerf.snapshot();
  const renderStarts = snapshot.events.filter((event) => event.kind === 'render_start').length;
  const frameCompletes = snapshot.events.filter((event) => event.kind === 'frame_complete').length;
  const geometryCommits = (await readGeometryRecords(page)).length;
  // A paint submitted outside the scheduled renderer emits no `render_start`
  // and completes under a `renderSeq` already seen, so the report drops its
  // sub-terms. These two counts are how an unobservable paint shows up at all,
  // and they are the difference between painting less and merely measuring
  // less.
  const { duplicateRenderSeqFrameCount, missingRenderStartCount } =
    snapshot.report.renderInstrumentation;

  await attachJson(testInfo, `resize-paints-${PROFILE_SLUG}.json`, {
    profile: PROFILE_NAME,
    steps: widths.length,
    geometryCommits,
    renderStarts,
    frameCompletes,
    duplicateRenderSeqFrameCount,
    missingRenderStartCount,
    rendersPerCommit: geometryCommits > 0 ? renderStarts / geometryCommits : null,
  });

  // Only that the trace exists. A resize that painted nothing would make the
  // comparison meaningless, and that is the one failure worth catching here.
  expect(renderStarts).toBeGreaterThan(0);
  expect(geometryCommits).toBeGreaterThan(0);
});

/**
 * The reported symptom, gated directly.
 *
 * Everything else here measures a mechanism; this measures what a person sees.
 * A drag is sampled one pixel at a time and consecutive screenshots of a static
 * crop are compared byte for byte. A step that did not change the grid must not
 * change any pixel — that is the sub-cell jitter, and it is what a re-derived
 * origin, a settle loop committing at every pause, and a rounded row count all
 * produced.
 *
 * Content *does* still move once per grid change, a step or two later, when the
 * daemon's rewrapped snapshot replaces the local truncate-and-pad guess. That
 * is the documented remaining behaviour, priced and rejected under
 * *The atomic-resize option* in PERF.md, so the assertion is that every move is
 * attributable to a nearby grid change rather than that no move occurs.
 *
 * The fixed waits are the sampling interval, not a synchronisation: there is no
 * event for "a step that was supposed to change nothing has finished changing
 * nothing".
 */
test('resize stability: a sub-cell drag step changes no pixels', async ({
  page,
  linkedDaemon,
}, testInfo) => {
  await page.setViewportSize({ width: 1_000, height: 700 });
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await page.keyboard.type(wrappedOutputCommand(40, 300, 'pixmark-ok'));
  await expectOutput(output, 'pixmark-ok', 30_000);
  await page.waitForTimeout(1_500);

  // Upper-left of the terminal: static output rows, away from the prompt and
  // its blinking cursor, and unaffected by shrinking the right edge.
  const clip = { x: 0, y: 140, width: 560, height: 180 };
  const shots: { canvasWidth: number; png: string }[] = [];
  for (let step = 0; step <= 40; step += 1) {
    if (step > 0) await page.setViewportSize({ width: 1_000 - step, height: 700 });
    await page.waitForTimeout(150);
    const canvasWidth = await page
      .locator('#terminal-output')
      .evaluate((c) => c.querySelector('canvas')?.getBoundingClientRect().width ?? 0);
    shots.push({ canvasWidth, png: (await page.screenshot({ clip })).toString('base64') });
  }

  const gridChangeSteps: number[] = [];
  const movedSteps: number[] = [];
  let sameGridSteps = 0;
  for (let i = 1; i < shots.length; i += 1) {
    if (shots[i]?.canvasWidth !== shots[i - 1]?.canvasWidth) {
      gridChangeSteps.push(i);
      continue;
    }
    sameGridSteps += 1;
    if (shots[i]?.png !== shots[i - 1]?.png) movedSteps.push(i);
  }
  // A move that trails a grid change by a step or two is the daemon's
  // authoritative reflow landing; a move far from any grid change would be the
  // sub-cell jitter this change set exists to remove.
  const distanceToGridChange = movedSteps.map((step) =>
    Math.min(...gridChangeSteps.map((change) => Math.abs(step - change))),
  );
  await attachJson(testInfo, 'pixel-stability.json', {
    steps: 40,
    gridChangeSteps,
    sameGridSteps,
    movedSteps,
    distanceToGridChange,
  });

  expect(sameGridSteps).toBeGreaterThan(0);
  expect(gridChangeSteps.length).toBeGreaterThan(0);
  // Tolerance, not precision: the authoritative reflow lands within a step or
  // two of its grid change (measured at 1 on every one of five changes, and
  // bounded by the resize-authority window). A move further out than this has
  // no grid change to explain it, and is the jitter.
  for (const [index, distance] of distanceToGridChange.entries()) {
    expect(distance, `moved step ${movedSteps[index]} is unattributable`).toBeLessThanOrEqual(4);
  }
});

/**
 * What a continuous drag actually costs the daemon.
 *
 * Every other test here steps and waits, which models a slow drag. A pointer
 * drag arrives as a burst, and the difference is the whole point: the settle
 * loop collapses the burst, so 40 pixels of continuous motion cost **one**
 * daemon round trip rather than one per column crossed. A regression in that
 * loop would show up here as a round trip per step, which is what the previous
 * commit-at-every-pause behaviour would have produced.
 *
 * Deliberately generous: the bound catches a settle loop that stopped
 * collapsing, not a run that happened to cross one extra column.
 */
test('resize stability: a continuous drag costs one daemon round trip', async ({
  page,
  linkedDaemon,
}, testInfo) => {
  await page.setViewportSize({ width: 1_000, height: 700 });
  await connectTerminal(page, linkedDaemon.daemonName);
  const samples = collectResizeAuthorityWindows(page);

  for (let step = 1; step <= 40; step += 1) {
    await page.setViewportSize({ width: 1_000 - step, height: 700 });
  }
  // No event marks "the daemon has stopped being told about a drag"; this is
  // the quiescence window, comfortably past the measured authority p95.
  await page.waitForTimeout(4_000);

  await attachJson(testInfo, 'drag-daemon-resizes.json', {
    steps: 40,
    daemonResizes: samples.length,
    windowsMs: samples.map((sample) => sample.ms),
  });
  expect(samples.length).toBeGreaterThan(0);
  expect(samples.length, 'daemon round trips for a 40px continuous drag').toBeLessThanOrEqual(5);
});
