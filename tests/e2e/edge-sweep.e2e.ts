/**
 * Real-browser-over-edge reproduction of the bulk-redraw sweep.
 *
 * Drives REAL Chromium against a REAL linked daemon whose terminal traffic flows
 * through a local merkur-edge relay (started by scripts/run-edge-harness.ts).
 * Types a command that emits one synchronized logical redraw as eight separately
 * drained PTY writes, then reads the terminal worker's own perf trace to prove
 * every row reached one authoritative GPU-fenced presentation.
 *
 *   coalesced (fix, clean/edge burst): paints << applied  -> one atomic repaint
 *   sweep     (paced/dribbled arrival): paints ~= applied  -> row-by-row
 *
 * Run: bun run scripts/run-edge-harness.ts           (fix / clean path)
 *      EDGE_NETWORK_PROFILE=typical EDGE_NETWORK_DATAGRAM_LOSS_PERCENT=9 \
 *        bun run scripts/run-edge-harness.ts edge-sweep.e2e.ts --workers=1
 */

import type { TerminalPerfEvent } from '../../apps/web/src/perf/terminal-latency';
import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';

interface PerfStats {
  readonly paints: number;
  readonly applied: number;
  readonly received: number;
  readonly total: number;
}

function readPerfStats(events: readonly { kind: string }[]): PerfStats {
  const count = (kind: string): number => events.filter((event) => event.kind === kind).length;
  return {
    paints: count('render_start'),
    applied: count('worker_display_applied'),
    received: count('display_received'),
    total: events.length,
  };
}

test('sparse redraw over the edge has one authoritative GPU fence', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  await expectConnected(page, 40_000);

  // Confirm the worker actually booted with perf on (guards the timing).
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (globalThis as unknown as { __merkurTerminalPerf?: unknown }).__merkurTerminalPerf !==
            undefined,
        ),
      { timeout: 5_000 },
    )
    .toBe(true);

  // Warm up the renderer and transport, then install the exact sparse writer
  // as a shell function. Its name shadows no command: the shell outlives this
  // test and serves the next one in the worker. Defining and typing the command
  // before the measurement keeps its line echo out of the redraw window; the
  // measured Enter keeps the daemon on the causal/interactive scheduling arm.
  // The canonical BSU/ESU pair makes the semantic transaction explicit; the
  // wall-clock duration of eight separately drained writes is host-dependent
  // and may span multiple refresh periods. After ESU the function stays asleep
  // so a prompt repaint is outside the window. Each os.write is deliberately
  // followed by 0.8 ms: this is the real path that used to look drained on every
  // PTY read and fragment one TUI redraw into four browser paints over 128.9 ms
  // (and, under the same seeded profile later, two paints over 244.8 ms).
  const sparseRedrawFunction =
    `sparse_redraw() { /usr/bin/python3 -c 'import os,time; os.write(1,b"\\x1b[?2026h"); ` +
    `[(os.write(1, f"\\x1b7\\x1b[{i};1Hrow-{i:02d}-".encode()+b"X"*60+b"\\x1b8"), ` +
    `time.sleep(0.0008)) for i in range(1,9)]; os.write(1,b"\\x1b[?2026l"); time.sleep(5)'; }`;
  await page.keyboard.insertText(sparseRedrawFunction);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await page.keyboard.type('clear\n');
  await page.waitForTimeout(500);
  await page.keyboard.insertText('sparse_redraw');
  await page.waitForTimeout(500);
  await terminalPerf.reset();
  const measurementId = await terminalPerf.beginPresentationMeasurement('coherent-redraw');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2_500);
  await terminalPerf.endPresentationMeasurement(measurementId);

  const snapshot = await terminalPerf.snapshot();
  const stats = readPerfStats(snapshot.events);
  const start = snapshot.events.find(
    (event) =>
      event.kind === 'presentation_measurement_boundary' &&
      event.measurementId === measurementId &&
      event.phase === 'start',
  );
  const end = snapshot.events.find(
    (event) =>
      event.kind === 'presentation_measurement_boundary' &&
      event.measurementId === measurementId &&
      event.phase === 'end',
  );
  expect(start, 'measurement start must be retained').toBeDefined();
  expect(end, 'measurement end must be retained').toBeDefined();
  if (start === undefined || end === undefined) return;

  // The measured Enter legitimately produces an urgent cursor/newline commit.
  // The addressed output is semantic redraw work and is therefore coherent;
  // scope the oracle to those transactions so preserving earliest causal
  // feedback cannot make a correct implementation fail.
  const visualCommits = snapshot.events.filter(
    (event): event is Extract<TerminalPerfEvent, { kind: 'presentation_commit' }> =>
      event.kind === 'presentation_commit' &&
      event.authoritativeVisualChange &&
      event.coherent &&
      event.atMs >= start.atMs &&
      event.atMs <= end.atMs,
  );
  const appliedRows = visualCommits.reduce((sum, event) => sum + event.rowCount, 0);
  const renderSeqs = new Set(visualCommits.map((event) => event.renderSeq));
  const authoritativeFences = snapshot.events.filter(
    (event): event is Extract<TerminalPerfEvent, { kind: 'frame_complete' }> =>
      event.kind === 'frame_complete' && renderSeqs.has(event.renderSeq),
  );
  const fenceTimes = authoritativeFences.map((event) => event.atMs);
  const fenceExposureMs =
    fenceTimes.length === 0
      ? Number.POSITIVE_INFINITY
      : Math.max(...fenceTimes) - Math.min(...fenceTimes);
  // biome-ignore lint/suspicious/noConsole: harness diagnostic output
  console.log(
    `[edge-sweep] ${JSON.stringify({ ...stats, appliedRows, visualCommits: visualCommits.length, authoritativeFences: authoritativeFences.length, fenceExposureMs })} ` +
      `profile=${process.env.EDGE_NETWORK_PROFILE ?? 'loopback'} datagram-loss=${process.env.EDGE_NETWORK_DATAGRAM_LOSS_PERCENT ?? '0'}%@edge-to-client`,
  );

  // This is scoped to the logical workload, not raw test totals. Command echo
  // and shell feedback are valid low-latency paints and must not make a redraw
  // coherence assertion fail (or, worse, make a sweep pass by dilution).
  expect(appliedRows, 'all eight addressed rows must reach the browser').toBeGreaterThanOrEqual(8);
  expect(visualCommits, 'the logical redraw must have one renderer submission').toHaveLength(1);
  expect(
    authoritativeFences,
    'that submission must complete through a real GPU fence',
  ).toHaveLength(1);
  expect(fenceExposureMs, 'one logical redraw cannot span multiple visible fences').toBe(0);

  // Keep the generic cross-presentation measurement live as an independent
  // trace oracle. Its raw count also includes the intentionally urgent Enter.
  expect(snapshot.report.presentation.measurementWindowCount).toBe(1);
  expect(snapshot.report.presentation.commitsPerMeasurementWindow.complete).toBe(true);
  expect(snapshot.report.presentation.measurementWindowExposureMs.complete).toBe(true);
});
