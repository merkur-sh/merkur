import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';

import type {
  TelemetryGraphicsAssetStatus,
  TelemetryInputFrontierStatus,
} from '../../apps/web/src/perf/telemetry-drain-status';
import type {
  TerminalLatencyPercentiles,
  TerminalLatencyReport,
  TerminalPerfEvent,
} from '../../apps/web/src/perf/terminal-latency';
import type { EdgeNetworkLink } from '../../scripts/edge-network-profile';
import type {
  ProxyLinkStatus,
  ProxyRelayLinks,
  ProxySettleStatus,
} from '../../scripts/edge-network-stats';
import { pairedTail, signTestMedianUpper } from '../../scripts/perf/paired-tail';
import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';
import { type DirectNetworkProxy, startDirectNetworkProxy } from './fixtures/direct-network-proxy';
import {
  type GraphicsDaemonTerms,
  type GraphicsEgressDelta,
  graphicsContentionAttribution,
  graphicsDaemonTerms,
  graphicsEgressBetween,
} from './fixtures/graphics-contention';
import {
  type GraphicsDataLaneRecovery,
  type GraphicsMissedOverlap,
  type GraphicsMissedQuad,
  type GraphicsTypingStratum,
  type GraphicsVoidReason,
  graphicsDataLaneRecoveries,
  graphicsTimedCloseErrors,
  graphicsTypingStratum,
  proxyHarnessDropErrors,
  voidedBatchErrors,
  withoutMissedQuads,
} from './fixtures/graphics-typing-batch';
import type { TimedInputClose } from './fixtures/presentation-measurement-settle';
import {
  isCompleteLatencyDistribution,
  writeGzipJsonArray,
} from './fixtures/terminal-perf-artifacts';
import {
  markProxyTrace,
  readBrowserDrainStatus,
  requestProxySettleStatus,
  requestProxyStats,
  type TerminalPerfFixture,
  type TerminalPerfSnapshot,
} from './fixtures/test';
import {
  connectTerminal,
  dispatchWindowPaste,
  SHELL_RESET_COMMAND,
  shellQuote,
  waitForMirrorBaseline,
  waitForTerminalLog,
} from './terminal-e2e-helpers';

// Every report key whose value is a percentile block. Selected by shape rather
// than by exclusion list, so a report field that is not a percentile -- the
// `renderGate` and `renderInstrumentation` groupings -- cannot be handed to
// `assertMetric` and fail on a missing `p95`.
type LatencyMetric = {
  [K in keyof TerminalLatencyReport]: TerminalLatencyReport[K] extends TerminalLatencyPercentiles
    ? K
    : never;
}[keyof TerminalLatencyReport];

const EDGE_ACTIVE = process.env.EDGE_NETWORK_ACTIVE === '1';
const EDGE_TARGET_RTT_MS = EDGE_ACTIVE
  ? readNonNegativeNumber(process.env.EDGE_NETWORK_TARGET_RTT_MS)
  : 0;
const EDGE_DATAGRAM_LOSS_PERCENT = EDGE_ACTIVE
  ? readNonNegativeNumber(process.env.EDGE_NETWORK_DATAGRAM_LOSS_PERCENT)
  : 0;
const EDGE_ONE_WAY_JITTER_MS = EDGE_ACTIVE
  ? readNonNegativeNumber(process.env.EDGE_NETWORK_ONE_WAY_JITTER_MS)
  : 0;
const EDGE_MAX_EXTRA_DELAY_MS = EDGE_ACTIVE
  ? readNonNegativeNumber(process.env.EDGE_NETWORK_MAX_EXTRA_DELAY_MS)
  : 0;
const IMPAIRED = EDGE_ACTIVE;
const CLEAN_DELIVERY =
  !EDGE_ACTIVE ||
  (EDGE_DATAGRAM_LOSS_PERCENT === 0 &&
    process.env.EDGE_NETWORK_REORDER === 'none' &&
    process.env.EDGE_NETWORK_SCENARIO === 'steady');
const PROFILE_NAME = IMPAIRED
  ? `${process.env.EDGE_NETWORK_PROFILE ?? 'unknown'}(rtt=${EDGE_TARGET_RTT_MS}ms,datagram-loss=${EDGE_DATAGRAM_LOSS_PERCENT}%@edge-to-client)`
  : 'clean';

// Tail budgets are the calibrated four-leg application RTT plus the profile's
// complete delivery-skew envelope and a small bounded local residual. Loss
// repair remains covered by the larger liveness timeouts above; it is not an
// excuse to turn a p95 performance gate into a one-second watchdog.
const REMOTE_TAIL_BASE_MS = EDGE_TARGET_RTT_MS + EDGE_ONE_WAY_JITTER_MS + EDGE_MAX_EXTRA_DELAY_MS;
const LIMITS = {
  // Controlled marker workloads have an exact completion oracle. Missing
  // samples are censored tails, not a population to percentile-filter away.
  completeRatio: 1,
  telemetryTimeoutMs: IMPAIRED ? 25_000 : 15_000,
  markerTimeoutMs: IMPAIRED ? 25_000 : 15_000,
  longMarkerTimeoutMs: IMPAIRED ? 35_000 : 25_000,
  inputAckP95Ms: IMPAIRED ? REMOTE_TAIL_BASE_MS + 80 : 600,
  inputToReceiveP95Ms: IMPAIRED ? REMOTE_TAIL_BASE_MS + 100 : 800,
  inputToApplyP95Ms: IMPAIRED ? REMOTE_TAIL_BASE_MS + 120 : 850,
  inputToAuthoritativeVisualFenceP95Ms: IMPAIRED ? REMOTE_TAIL_BASE_MS + 150 : 900,
  inputToCompletedPresentationFenceP95Ms: IMPAIRED ? REMOTE_TAIL_BASE_MS + 150 : 900,
  workerStageP95Ms: IMPAIRED ? 50 : 250,
  workerReceiptToDecodeP95Ms: IMPAIRED ? 16 : 50,
  decodeToApplyP95Ms: IMPAIRED ? 16 : 50,
  displayPumpP95Ms: IMPAIRED ? 16 : 50,
} as const;

const CORE_METRICS = [
  'inputAckMs',
  'inputToAuthoritativeVisualFenceMs',
  'inputToCompletedAuthoritativePresentationFenceMs',
] as const satisfies readonly LatencyMetric[];

const DAEMON_INPUT_PIPELINE_TERMS = [
  'recvToPtyUs',
  'ptyToReadUs',
  'gridApplyUs',
  'totalUs',
] as const;

const DAEMON_DISPLAY_PIPELINE_TERMS = [
  'displayCoalesceUs',
  'selectCaptureUs',
  'prepareQueueUs',
  'encodeUs',
  'compressionUs',
  'completionQueueUs',
  'transportSubmitUs',
  'gridMutationToEncodedUs',
  'queuedBeforeTransportSubmitUs',
  'displayOperationTotalUs',
] as const;

interface MetricCase {
  readonly title: string;
  readonly metric: LatencyMetric;
  readonly p95LimitMs: number;
}

const METRIC_CASES: readonly MetricCase[] = [
  {
    title: 'input ACK remains bounded',
    metric: 'inputAckMs',
    p95LimitMs: LIMITS.inputAckP95Ms,
  },
  {
    title: 'input-to-display receive remains bounded',
    metric: 'inputToDisplayReceiveMs',
    p95LimitMs: LIMITS.inputToReceiveP95Ms,
  },
  {
    title: 'input-to-display apply remains bounded',
    metric: 'inputToDisplayApplyMs',
    p95LimitMs: LIMITS.inputToApplyP95Ms,
  },
  {
    title: 'input-to-authoritative visual GPU fence remains bounded',
    metric: 'inputToAuthoritativeVisualFenceMs',
    p95LimitMs: LIMITS.inputToAuthoritativeVisualFenceP95Ms,
  },
  {
    title: 'input-to-completed authoritative presentation GPU fence remains bounded',
    metric: 'inputToCompletedAuthoritativePresentationFenceMs',
    p95LimitMs: LIMITS.inputToCompletedPresentationFenceP95Ms,
  },
  {
    title: 'display receive-to-worker queue remains bounded',
    metric: 'displayReceiveToWorkerQueueMs',
    p95LimitMs: LIMITS.workerStageP95Ms,
  },
  {
    title: 'worker queue-to-display apply remains bounded',
    metric: 'workerQueueToDisplayApplyMs',
    p95LimitMs: LIMITS.workerStageP95Ms,
  },
];

const RAPID_INPUT_CASES = [
  {
    id: 'keydown',
    title: 'zero-delay keydown stream',
    method: 'type',
    size: 192,
  },
  {
    id: 'insert',
    title: 'single committed-text burst',
    method: 'insertText',
    size: 1_024,
  },
] as const;

const OUTPUT_BURST_CASES = [
  { id: 'rows', title: 'dense row burst', rows: 240, width: 24 },
  { id: 'wide', title: 'wide-cell burst', rows: 96, width: 160 },
] as const;

const RESIZE_CASES = [
  {
    id: 'narrow-wide',
    title: 'narrow-to-wide resize under output load',
    rows: 90,
    sizes: [
      { width: 360, height: 640 },
      { width: 1_440, height: 900 },
    ],
  },
  {
    id: 'storm',
    title: 'resize storm under output load',
    rows: 120,
    sizes: [
      { width: 420, height: 700 },
      { width: 900, height: 500 },
      { width: 375, height: 667 },
      { width: 1_280, height: 720 },
      { width: 768, height: 840 },
    ],
  },
] as const;

const IDLE_CASES = [
  { id: 'short', title: 'short idle resume', idleMs: 1_250 },
  { id: 'heartbeat', title: 'multi-heartbeat idle resume', idleMs: 2_500 },
] as const;

const SEQUENTIAL_CASES = [
  {
    id: 'typed',
    title: 'rapid typed command sequence',
    method: 'type',
    count: 24,
  },
  {
    id: 'pasted',
    title: 'large pasted command sequence',
    method: 'paste',
    count: 180,
  },
] as const;

// One hundred independent observations make p99 an observed tail rather than
// the maximum of a token smoke sample. Large redraws use twenty exact logical
// windows per test, which is the minimum population that makes p95 meaningful.
const ISOLATED_INTERACTION_SAMPLES = 100;
const COHERENT_PRESENTATION_SAMPLES = 20;

/**
 * Graphics-transfer typing comparison. Pair `i` is two adjacent members that
 * run the same arming sequence (place a fresh, never-requested image, await its
 * first request) under the same proxy trace keys: a control that places a 1×1
 * image and an image member whose timed key overlaps a full tile transfer. The
 * image must sample at level zero (displayed width above half the source
 * width), so its tile count is exact: `projectImageScene` in `graphics/scene.ts`.
 * `GRAPHICS_TYPING_BYTES` picks the transfer: one 256 KiB tile (several
 * edge↔browser RTTs of loss-limited transfer, the lossy profiles' default),
 * eight tiles, 2 MiB (the default otherwise), or 64 tiles, 16 MiB, whose key
 * waits for the eighth tile's FIN so a queue a bottleneck builds is standing
 * when it is typed. A batch uploads its sources at once, so the 16 MiB batch is
 * one quad: four 16 MiB sources stay inside the terminal's 128 MiB store.
 */
const GRAPHICS_TYPING_SIZES = {
  '256KiB': {
    width: 256,
    height: 256,
    columns: 32,
    imageTiles: 1,
    batchPairs: 40,
    timedAfter: { phase: 'firstByte', count: 1 },
  },
  '2MiB': {
    width: 1_024,
    height: 512,
    columns: 72,
    imageTiles: 8,
    batchPairs: 16,
    timedAfter: { phase: 'firstByte', count: 1 },
  },
  '16MiB': {
    width: 1_024,
    height: 4_096,
    columns: 72,
    imageTiles: 64,
    batchPairs: 4,
    timedAfter: { phase: 'fin', count: 8 },
  },
} as const;
/**
 * Loss (exact or burst) at the fault site defines the U/L strata and the
 * lossy stopping rule. A profile that only bounds capacity drops no packet the
 * trace chose, so it runs the clean rule.
 */
const GRAPHICS_LOSSY =
  EDGE_ACTIVE &&
  (EDGE_DATAGRAM_LOSS_PERCENT > 0 || process.env.EDGE_NETWORK_SCENARIO === 'burst-loss');
const GRAPHICS_TYPING =
  GRAPHICS_TYPING_SIZES[graphicsTypingSize(process.env.GRAPHICS_TYPING_BYTES)];
/** The links a bottleneck profile declares; empty without one. */
const EDGE_LINKS: readonly EdgeNetworkLink[] = JSON.parse(process.env.EDGE_NETWORK_LINKS ?? '[]');
const EDGE_BOTTLENECK = process.env.EDGE_NETWORK_BOTTLENECK ?? null;
/**
 * A member settles only once its tiles have all landed. Liveness, not a
 * budget: four times the transfer at the slowest declared link, and never
 * below the fixture's 15 s.
 */
const GRAPHICS_SETTLE_TIMEOUT_MS = Math.max(
  15_000,
  ...EDGE_LINKS.map((link) =>
    Math.ceil(
      (4 * GRAPHICS_TYPING.imageTiles * 256 * 1024 * 8 * 1_000) /
        Math.min(link.rateBps, link.step?.rateBps ?? link.rateBps),
    ),
  ),
);
const GRAPHICS_CONTROL_TILES = 1;
/**
 * The A/A run, selected by `GRAPHICS_TYPING_A_A=1`: the image arm places a
 * second fresh 1×1 image exactly as the control does, so both arms are
 * controls under the same keys, order and rules. It must reach the sample-size
 * rule and pass C1 and C2 on both metrics before an impaired A/B verdict is
 * accepted; it also bounds how much closing the ledger at the control's own
 * completion favours fast controls.
 */
const GRAPHICS_TYPING_A_A = graphicsTypingAA(process.env.GRAPHICS_TYPING_A_A);
const GRAPHICS_IMAGE_ARM = GRAPHICS_TYPING_A_A
  ? { width: 1, height: 1, tiles: GRAPHICS_CONTROL_TILES }
  : {
      width: GRAPHICS_TYPING.width,
      height: GRAPHICS_TYPING.height,
      tiles: GRAPHICS_TYPING.imageTiles,
    };
/**
 * Pre-declared impaired sample size, from the A/A calibration
 * (ledger/2026-09-19-graphics-typing-sample-size-rule.md): stop at |U| ≥ 100
 * and |L| ≥ 44, fail inconclusive at 920 valid pairs. There U, no drop and no
 * hold by the close, was 51 of 280 pairs and L 122. Identical arms resampled
 * from it passed C1 and C2 in every one of 2,000 runs (the fence's upper95 at
 * |U| = 100 has p95 3.55 ms), and the rule reaches a verdict by 920 pairs with
 * predictive probability 0.9992, at a median of 548.
 */
const GRAPHICS_TYPING_U_PAIRS = 100;
const GRAPHICS_TYPING_L_PAIRS = 44;
const GRAPHICS_TYPING_MAX_PAIRS = 920;
const GRAPHICS_TYPING_CLEAN_PAIRS = 220;
/** ABBA/BAAB at the pair level, by pair index mod 4. */
const GRAPHICS_PAIR_ORDERS = [
  ['C', 'I'],
  ['I', 'C'],
  ['I', 'C'],
  ['C', 'I'],
] as const;
const GRAPHICS_TYPING_METRICS = [
  'inputToCompletedAuthoritativePresentationFenceMs',
  'inputAckMs',
] as const;
/**
 * A carrier change rebinds, resets the presentation epoch and usually
 * snapshots, so no window in its batch is a single-row typing sample. A spare
 * dial (`dial_started`) changes nothing measured: per-relay traces isolate it.
 */
const GRAPHICS_VOIDING_CARRIER_PHASES: ReadonlySet<string> = new Set([
  'incumbent_failed',
  'promoted',
  'evicted',
  'restored',
  'rebind_sent',
]);
const GRAPHICS_SUCCESS_PHASES = [
  'demanded',
  'requested',
  'first_byte',
  'fin',
  'published',
  'consumed',
  'retired',
] as const;

test.describe('terminal performance matrix', () => {
  test('graphics: cold tile transfers preserve paired single-row typing latency', async ({
    page,
    linkedDaemon,
    terminalPerf,
  }, testInfo) => {
    // A direct run under a bottleneck crosses the same links on the direct
    // path: two proxy hops in front of the daemon's own port.
    const direct =
      process.env.FORCE_EDGE === '0' && EDGE_BOTTLENECK !== null
        ? await startGraphicsDirectProxy(page, linkedDaemon.webTransportPort)
        : null;
    try {
      await measureGraphicsTypingCase(page, linkedDaemon, terminalPerf, testInfo, direct !== null);
    } finally {
      await direct?.close();
    }
  });

  async function measureGraphicsTypingCase(
    page: Page,
    linkedDaemon: { readonly daemonName: string; readonly daemonHome: string },
    terminalPerf: TerminalPerfFixture,
    testInfo: TestInfo,
    viaDirectProxy: boolean,
  ): Promise<void> {
    const output = await prepareTerminal(page, linkedDaemon.daemonName, terminalPerf);
    if (viaDirectProxy) {
      await expect(page.getByText(/^Direct(?: · \d+ms)?$/).first()).toBeVisible({
        timeout: 30_000,
      });
    }
    // Declare the added-latency budget from an independent idle refresh sample,
    // before either measured arm: one actual delivered browser frame. This is
    // an observed GPU-completion comparison, not an input-to-photon claim.
    const frameBudgetMs = await page.evaluate(async () => {
      const times: number[] = [];
      for (let index = 0; index < 61; index++) {
        times.push(await new Promise<number>((resolve) => requestAnimationFrame(resolve)));
      }
      const periods = times.slice(1).map((time, index) => time - (times[index] ?? time));
      periods.sort((a, b) => a - b);
      const period = periods[30];
      if (period === undefined || period <= 0) throw new Error('missing refresh calibration');
      return period;
    });
    const client = join(linkedDaemon.daemonHome, 'graphics-typing.py');
    await writeFile(client, graphicsTypingClient(randomUUID()));
    await page.keyboard.insertText(`python3 ${shellQuote(client)}\n`);
    await expectExactMarker(output, 'GRAPHICS-TYPING-READY', 90_000);
    // Liveness only, and only for the measurement: setup above stays inside the
    // default timeout. The pre-declared stopping rule decides how many pairs
    // run; every member already carries its own 15-second waits.
    test.setTimeout(
      120_000 + (GRAPHICS_TYPING_MAX_PAIRS + 2 * GRAPHICS_TYPING.batchPairs) * 2 * 30_000,
    );
    try {
      await measureGraphicsTyping({ page, output, terminalPerf, testInfo, frameBudgetMs });
    } finally {
      await page.keyboard.type('!');
    }
  }

  test('interaction: isolated single-character feedback is independently fenced', async ({
    page,
    linkedDaemon,
    terminalPerf,
  }) => {
    await prepareTerminal(page, linkedDaemon.daemonName, terminalPerf);
    for (let index = 0; index < ISOLATED_INTERACTION_SAMPLES; index += 1) {
      const measurementId = await terminalPerf.beginPresentationMeasurement('isolated-interactive');
      await page.keyboard.type(String.fromCharCode(97 + (index % 26)));
      await terminalPerf.endPresentationMeasurement(measurementId);
    }

    const snapshot = await waitForTelemetry(
      terminalPerf,
      ISOLATED_INTERACTION_SAMPLES,
      ['inputToPredictionSubmissionMs', 'inputToPredictionPaintMs'],
      false,
    );
    assertExactIsolatedCompletion(snapshot.report, ISOLATED_INTERACTION_SAMPLES);
    assertDaemonPipeline(snapshot.report, ISOLATED_INTERACTION_SAMPLES);
    assertSpeculativeFeedback(
      snapshot.report,
      snapshot.events,
      EDGE_TARGET_RTT_MS >= 120,
      ISOLATED_INTERACTION_SAMPLES,
    );
    await assertTransportStable(page, snapshot);
    // Cleanup is deliberately after the frozen assertion snapshot so it does
    // not enter the isolated sample population retained by the fixture.
    await page.keyboard.press('Control+u');
  });

  test('interaction: isolated cursor-only changes are independently fenced', async ({
    page,
    linkedDaemon,
    terminalPerf,
  }) => {
    await prepareTerminal(page, linkedDaemon.daemonName, terminalPerf);
    await page.keyboard.insertText('cursor-probe');
    await waitForLatestInputAuthoritativeGpuFence(terminalPerf);
    await terminalPerf.reset();

    for (let index = 0; index < ISOLATED_INTERACTION_SAMPLES; index += 1) {
      const measurementId = await terminalPerf.beginPresentationMeasurement('isolated-interactive');
      await page.keyboard.press(index % 2 === 0 ? 'ArrowLeft' : 'ArrowRight');
      await terminalPerf.endPresentationMeasurement(measurementId);
    }

    const snapshot = await waitForTelemetry(terminalPerf, ISOLATED_INTERACTION_SAMPLES, [], false);
    assertExactIsolatedCompletion(snapshot.report, ISOLATED_INTERACTION_SAMPLES);
    await assertTransportStable(page, snapshot);
    await page.keyboard.press('Control+u');
  });

  test('interaction: command submission reaches its first authoritative output', async ({
    page,
    linkedDaemon,
    terminalPerf,
  }) => {
    const marker = 'perf-command-first-output-ok';
    const output = await prepareTerminal(page, linkedDaemon.daemonName, terminalPerf);
    await page.keyboard.insertText(markerPrint(marker));
    await waitForLatestInputAuthoritativeGpuFence(terminalPerf);
    await terminalPerf.reset();

    const measurementId = await terminalPerf.beginPresentationMeasurement('streaming');
    await page.keyboard.press('Enter');
    await expectExactMarker(output, marker, LIMITS.markerTimeoutMs);
    await terminalPerf.endPresentationMeasurement(measurementId);

    const snapshot = await waitForTelemetry(terminalPerf, 1, [], false);
    assertExactIsolatedCompletion(snapshot.report, 1);
    assertMetric(
      snapshot.report,
      'inputToAuthoritativeVisualFenceMs',
      LIMITS.inputToAuthoritativeVisualFenceP95Ms,
    );
    await assertTransportStable(page, snapshot);
  });

  test('interaction: remote line editing remains authoritative and ordered', async ({
    page,
    linkedDaemon,
    terminalPerf,
  }) => {
    const marker = 'perf-line-editing-ok';
    await runMeasuredWorkload({
      page,
      daemonName: linkedDaemon.daemonName,
      terminalPerf,
      marker,
      minSamples: 12,
      action: async () => {
        await page.keyboard.type("printf '%s\\n' wrong-value");
        await page.keyboard.press('Control+w');
        await page.keyboard.type(`${shellQuote(marker)}\n`);
      },
    });
  });

  // One typed workload measures every stage at once; each stage keeps its own p95
  // budget over the same 24-sample floor, and every stage that misses is reported.
  test('telemetry: every input stage remains bounded', async ({
    page,
    linkedDaemon,
    terminalPerf,
  }) => {
    const marker = 'perf-stage-ok';
    const snapshot = await runMeasuredWorkload({
      page,
      daemonName: linkedDaemon.daemonName,
      terminalPerf,
      marker,
      minSamples: 24,
      requiredMetrics: METRIC_CASES.map((metricCase) => metricCase.metric),
      action: async () => {
        await page.keyboard.type(`${markerPrint(marker)}\n`, { delay: 8 });
      },
    });

    const missed: string[] = [];
    for (const metricCase of METRIC_CASES) {
      try {
        assertMetric(snapshot.report, metricCase.metric, metricCase.p95LimitMs);
        if (
          EDGE_TARGET_RTT_MS > 0 &&
          (metricCase.metric === 'inputAckMs' || metricCase.metric === 'inputToDisplayReceiveMs')
        ) {
          expect(
            snapshot.report[metricCase.metric].p50 ?? 0,
            telemetryDiagnostic(snapshot.report),
          ).toBeGreaterThanOrEqual(EDGE_TARGET_RTT_MS - EDGE_ONE_WAY_JITTER_MS);
        }
      } catch (error) {
        missed.push(`${metricCase.title}: ${error instanceof Error ? error.message : error}`);
      }
    }
    expect(missed, 'input stages outside their budget').toEqual([]);
  });

  test('telemetry: prediction paint is bounded whenever the visibility gate enables it', async ({
    page,
    linkedDaemon,
    terminalPerf,
  }) => {
    const marker = 'perf-prediction-paint-ok';
    const snapshot = await runMeasuredWorkload({
      page,
      daemonName: linkedDaemon.daemonName,
      terminalPerf,
      marker,
      minSamples: 24,
      action: async () => {
        // This spans the gate's one-second telemetry heartbeat and gives a
        // visible gate enough distinct frames to produce a correlated sample.
        await page.keyboard.type(`${markerPrint(marker)}\n`, { delay: 25 });
      },
    });

    assertSpeculativeFeedback(snapshot.report, snapshot.events, EDGE_TARGET_RTT_MS >= 120);
    await assertTransportStable(page, snapshot);
  });

  for (const rapidCase of RAPID_INPUT_CASES) {
    test(`rapid typing: ${rapidCase.title}`, async ({ page, linkedDaemon, terminalPerf }) => {
      const marker = `perf-rapid-${rapidCase.id}-ok`;
      const value =
        rapidCase.id === 'keydown' ? 'ab'.repeat(rapidCase.size / 2) : 'z'.repeat(rapidCase.size);
      await runMeasuredWorkload({
        page,
        daemonName: linkedDaemon.daemonName,
        terminalPerf,
        marker,
        minSamples: rapidCase.method === 'type' ? 64 : 1,
        action: async () => {
          const command = checkedValueCommand(value, marker);
          if (rapidCase.method === 'type') await page.keyboard.type(command);
          else await page.keyboard.insertText(command);
        },
      });
    });
  }

  for (const burstCase of OUTPUT_BURST_CASES) {
    test(`burst output: ${burstCase.title}`, async ({ page, linkedDaemon, terminalPerf }) => {
      const marker = `perf-burst-${burstCase.id}-ok`;
      const readyMarker = `perf-burst-${burstCase.id}-ready`;
      const snapshot = await runMeasuredWorkload({
        page,
        daemonName: linkedDaemon.daemonName,
        terminalPerf,
        marker,
        timeoutMs: LIMITS.longMarkerTimeoutMs,
        requirePresentationCoherence: true,
        presentationSamples: COHERENT_PRESENTATION_SAMPLES,
        presentationStartMarker: readyMarker,
        triggerPresentation: async () => {
          await page.keyboard.press('Enter');
        },
        finishPresentation: async () => {
          await page.keyboard.press('Enter');
        },
        action: async (_output, sample) => {
          if (sample === undefined) throw new Error('coherent burst sample identity is missing');
          await page.keyboard.insertText(
            outputBurstCommand(burstCase.rows, burstCase.width, sample.startMarker, sample.marker),
          );
        },
      });
      // Plain burst: nothing on the wire says where this update ends.
      assertPresentationCoherence(snapshot, { framed: false });
    });
  }

  test('burst output: deterministic cat-style file stream', async ({
    page,
    linkedDaemon,
    terminalPerf,
  }) => {
    const marker = 'perf-cat-stream-ok';
    const readyMarker = 'perf-cat-stream-ready';
    const snapshot = await runMeasuredWorkload({
      page,
      daemonName: linkedDaemon.daemonName,
      terminalPerf,
      marker,
      timeoutMs: LIMITS.longMarkerTimeoutMs,
      requirePresentationCoherence: true,
      presentationSamples: COHERENT_PRESENTATION_SAMPLES,
      presentationStartMarker: readyMarker,
      triggerPresentation: async () => page.keyboard.press('Enter'),
      finishPresentation: async () => page.keyboard.press('Enter'),
      action: async (_output, sample) => {
        if (sample === undefined) throw new Error('coherent cat sample identity is missing');
        await page.keyboard.insertText(catStyleOutputCommand(sample.startMarker, sample.marker));
      },
    });
    // Plain stream: no BSU/ESU, so the unframed per-refresh bound applies.
    assertPresentationCoherence(snapshot, { framed: false });
  });

  test('redraw: alternate-screen truecolor TUI commits coherently', async ({
    page,
    linkedDaemon,
    terminalPerf,
  }) => {
    const marker = 'perf-alt-tui-redraw-ok';
    const readyMarker = 'perf-alt-tui-redraw-ready';
    const output = await prepareTerminal(page, linkedDaemon.daemonName, terminalPerf);
    for (let index = 0; index < COHERENT_PRESENTATION_SAMPLES; index += 1) {
      const suffix = `-${String(index).padStart(3, '0')}`;
      const sampleMarker = `${marker}${suffix}`;
      const sampleReadyMarker = `${readyMarker}${suffix}`;
      await page.keyboard.insertText(
        fullScreenTruecolorRedrawCommand(sampleReadyMarker, sampleMarker),
      );

      // The accessibility mirror deliberately suppresses alternate-screen
      // contents. Gate on READY while still in the primary screen, then use
      // exact renderer transaction/fence telemetry as the completion oracle.
      await expectExactMarker(output, sampleReadyMarker, LIMITS.longMarkerTimeoutMs);
      await waitForSettledPresentationPipeline(terminalPerf);
      const measurementId = await terminalPerf.beginPresentationMeasurement('coherent-redraw');
      let measurementFailure: unknown;
      try {
        await page.keyboard.press('Enter');
        await waitForLargeCoherentGpuFencedCommit(terminalPerf, measurementId, 20);
      } catch (error) {
        measurementFailure = error;
      }
      try {
        await terminalPerf.endPresentationMeasurement(measurementId);
      } catch (error) {
        measurementFailure ??= error;
      }

      // Close the window before leaving alternate screen. The command leaves
      // one full accessibility settle interval between restoration and the
      // cleanup marker, so the mirror can silently resync the restored primary
      // screen before it observes the separate witness burst.
      await page.keyboard.press('Enter');
      await expectExactMarker(output, sampleMarker, LIMITS.longMarkerTimeoutMs);
      await waitForLatestInputAuthoritativeGpuFence(terminalPerf);
      if (measurementFailure !== undefined) throw measurementFailure;
    }

    const snapshot = await waitForTelemetry(
      terminalPerf,
      COHERENT_PRESENTATION_SAMPLES,
      [],
      true,
      COHERENT_PRESENTATION_SAMPLES,
    );
    assertMetric(snapshot.report, 'inputAckMs', LIMITS.inputAckP95Ms);
    assertMetric(
      snapshot.report,
      'inputToAuthoritativeVisualFenceMs',
      LIMITS.inputToAuthoritativeVisualFenceP95Ms,
    );
    assertMetric(
      snapshot.report,
      'inputToCompletedAuthoritativePresentationFenceMs',
      LIMITS.inputToCompletedPresentationFenceP95Ms,
    );
    assertDisplayPipeline(snapshot.report);
    assertDaemonPipeline(snapshot.report);
    // The redraw declares itself with synchronized output, so the exact tier
    // applies: one commit, zero partial exposure.
    assertPresentationCoherence(snapshot, { framed: true });
    const presentation = snapshot.report.presentation;
    const diagnostic = telemetryDiagnostic(snapshot.report);
    expect(presentation.measurementWindowCount, diagnostic).toBe(COHERENT_PRESENTATION_SAMPLES);
    expect(presentation.commitsPerMeasurementWindow.complete, diagnostic).toBe(true);
    expect(presentation.rowsPerMeasurementWindow.p50 ?? 0, diagnostic).toBeGreaterThanOrEqual(20);
    await assertTransportStable(page, snapshot);
  });

  test('paste: multiline command ordering remains responsive', async ({
    page,
    linkedDaemon,
    terminalPerf,
  }) => {
    const marker = 'perf-paste-multiline-ok';
    await runMeasuredWorkload({
      page,
      daemonName: linkedDaemon.daemonName,
      terminalPerf,
      marker,
      setup: async (output) => {
        await prepareQuietShell(page, output, terminalPerf, 'perf-paste-multiline-ready');
      },
      action: async () => {
        await dispatchWindowPaste(page, sequentialAssignmentBatch(80, marker, true));
      },
    });
  });

  test('paste: input chunks preserve a 10 KB command stream', async ({
    page,
    linkedDaemon,
    terminalPerf,
  }) => {
    const marker = 'perf-paste-chunked-ok';
    await runMeasuredWorkload({
      page,
      daemonName: linkedDaemon.daemonName,
      terminalPerf,
      marker,
      minSamples: 2,
      timeoutMs: LIMITS.longMarkerTimeoutMs,
      // The quiet shell prints only the marker, after it has run the 480 pasted
      // assignments and a check that forks 480 times: its completed presentation
      // is the shell's runtime (`ptyToReadUs` alone is a third of a second).
      completedPresentationLatency: 'application-runtime',
      setup: async (output) => {
        await prepareQuietShell(page, output, terminalPerf, 'perf-paste-chunked-ready');
      },
      action: async () => {
        await dispatchWindowPaste(page, sequentialAssignmentBatch(480, marker, true));
      },
    });
  });

  for (const resizeCase of RESIZE_CASES) {
    test(`resize under load: ${resizeCase.title}`, async ({ page, linkedDaemon, terminalPerf }) => {
      const marker = `perf-resize-${resizeCase.id}-ok`;
      await runMeasuredWorkload({
        page,
        daemonName: linkedDaemon.daemonName,
        terminalPerf,
        marker,
        timeoutMs: LIMITS.longMarkerTimeoutMs,
        completedPresentationLatency: 'application-runtime',
        action: async () => {
          await page.keyboard.insertText(backgroundOutputCommand(resizeCase.rows, marker));
          for (const size of resizeCase.sizes) await page.setViewportSize(size);
        },
      });
    });
  }

  for (const idleCase of IDLE_CASES) {
    test(`idle resume: ${idleCase.title}`, async ({ page, linkedDaemon, terminalPerf }) => {
      const marker = `perf-idle-${idleCase.id}-ok`;
      await runMeasuredWorkload({
        page,
        daemonName: linkedDaemon.daemonName,
        terminalPerf,
        marker,
        minSamples: 24,
        action: async () => {
          // Elapsed idle time is the condition under test, not synchronization
          // with terminal output, so there is no event that can replace it.
          await page.waitForTimeout(idleCase.idleMs);
          await page.keyboard.type(`${markerPrint(marker)}\n`, { delay: 5 });
        },
      });
    });
  }

  for (const sequentialCase of SEQUENTIAL_CASES) {
    test(`sequential commands: ${sequentialCase.title}`, async ({
      page,
      linkedDaemon,
      terminalPerf,
    }) => {
      const marker = `perf-sequential-${sequentialCase.id}-ok`;
      await runMeasuredWorkload({
        page,
        daemonName: linkedDaemon.daemonName,
        terminalPerf,
        marker,
        minSamples: sequentialCase.method === 'type' ? 64 : 1,
        timeoutMs: LIMITS.longMarkerTimeoutMs,
        setup:
          sequentialCase.method === 'paste'
            ? async (output) => {
                await prepareQuietShell(page, output, terminalPerf, 'perf-sequential-paste-ready');
              }
            : undefined,
        action: async () => {
          const quiet = sequentialCase.method === 'paste';
          const commands = sequentialAssignmentBatch(sequentialCase.count, marker, quiet);
          if (sequentialCase.method === 'type') await page.keyboard.type(commands);
          else await dispatchWindowPaste(page, commands);
        },
      });
    });
  }

  test('mixed load: foreground input stays responsive during background output', async ({
    page,
    linkedDaemon,
    terminalPerf,
  }) => {
    const marker = 'perf-pressure-input-ok';
    const witnessPath = '/tmp/merkur-perf-pressure-witness';
    await runMeasuredWorkload({
      page,
      daemonName: linkedDaemon.daemonName,
      terminalPerf,
      marker,
      minSamples: 64,
      timeoutMs: LIMITS.longMarkerTimeoutMs,
      completedPresentationLatency: 'application-runtime',
      action: async () => {
        await page.keyboard.insertText(backgroundOutputWithWitnessCommand(140, witnessPath));
        await page.keyboard.type(
          checkedValueWitnessCommand('foreground-'.repeat(16), marker, witnessPath),
        );
      },
    });
  });

  test('stability: sustained output completes without disconnect or signaling reconnect', async ({
    page,
    linkedDaemon,
    terminalPerf,
  }) => {
    const marker = 'perf-sustained-connected-ok';
    await runMeasuredWorkload({
      page,
      daemonName: linkedDaemon.daemonName,
      terminalPerf,
      marker,
      timeoutMs: LIMITS.longMarkerTimeoutMs,
      completedPresentationLatency: 'application-runtime',
      action: async () => {
        await page.keyboard.type(backgroundOutputCommand(180, marker), {
          delay: 2,
        });
      },
    });
  });
});

interface MeasuredWorkloadOptions {
  readonly page: Page;
  readonly daemonName: string;
  readonly terminalPerf: TerminalPerfFixture;
  readonly marker: string;
  readonly minSamples?: number;
  readonly requiredMetrics?: readonly LatencyMetric[];
  readonly requirePresentationCoherence?: boolean;
  readonly presentationSamples?: number;
  /** Visible prelude marker after which only the logical redraw remains. */
  readonly presentationStartMarker?: string;
  /** Input that releases a staged redraw after the measurement boundary opens. */
  readonly triggerPresentation?: (sample: PresentationWorkloadSample) => Promise<void>;
  /** Releases staged shell cleanup only after the measurement boundary closes. */
  readonly finishPresentation?: (sample: PresentationWorkloadSample) => Promise<void>;
  readonly timeoutMs?: number;
  /** Whether completed-presentation time is terminal latency or deliberate application runtime. */
  readonly completedPresentationLatency?: 'bounded' | 'application-runtime';
  readonly setup?: (output: Locator) => Promise<void>;
  readonly action: (output: Locator, sample?: PresentationWorkloadSample) => Promise<void>;
}

interface PresentationWorkloadSample {
  readonly index: number;
  readonly marker: string;
  readonly startMarker: string;
}

async function runMeasuredWorkload(
  options: MeasuredWorkloadOptions,
): Promise<TerminalPerfSnapshot> {
  const output = await prepareTerminal(options.page, options.daemonName, options.terminalPerf);
  await options.setup?.(output);
  if (!options.requirePresentationCoherence) {
    const presentationMeasurementId =
      await options.terminalPerf.beginPresentationMeasurement('streaming');
    try {
      await options.action(output);
      await expectExactMarker(output, options.marker, options.timeoutMs ?? LIMITS.markerTimeoutMs);
    } finally {
      await options.terminalPerf.endPresentationMeasurement(presentationMeasurementId);
    }
  } else {
    if (
      options.presentationStartMarker === undefined ||
      options.triggerPresentation === undefined
    ) {
      throw new Error(
        'presentation coherence workloads require an explicit start marker and trigger',
      );
    }
    const sampleCount = options.presentationSamples ?? 1;
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
      throw new Error('presentation coherence sample count must be a positive integer');
    }
    for (let index = 0; index < sampleCount; index += 1) {
      const suffix = sampleCount === 1 ? '' : `-${String(index).padStart(3, '0')}`;
      const sample: PresentationWorkloadSample = {
        index,
        marker: `${options.marker}${suffix}`,
        startMarker: `${options.presentationStartMarker}${suffix}`,
      };
      await options.action(output, sample);
      await expectExactMarker(
        output,
        sample.startMarker,
        options.timeoutMs ?? LIMITS.markerTimeoutMs,
      );
      await waitForSettledPresentationPipeline(options.terminalPerf);
      const measurementId =
        await options.terminalPerf.beginPresentationMeasurement('coherent-redraw');
      try {
        await options.triggerPresentation(sample);
        await expectExactMarker(output, sample.marker, options.timeoutMs ?? LIMITS.markerTimeoutMs);
      } finally {
        try {
          await options.terminalPerf.endPresentationMeasurement(measurementId);
        } finally {
          await options.finishPresentation?.(sample);
        }
      }
      if (options.finishPresentation !== undefined) {
        await waitForLatestInputAuthoritativeGpuFence(options.terminalPerf);
      }
    }
  }

  const snapshot = await waitForTelemetry(
    options.terminalPerf,
    Math.max(
      options.minSamples ?? 1,
      options.requirePresentationCoherence ? (options.presentationSamples ?? 1) : 1,
    ),
    options.requiredMetrics ?? [],
    options.requirePresentationCoherence ?? false,
    options.requirePresentationCoherence ? (options.presentationSamples ?? 1) : 0,
  );
  assertMetric(snapshot.report, 'inputAckMs', LIMITS.inputAckP95Ms);
  assertMetric(
    snapshot.report,
    'inputToAuthoritativeVisualFenceMs',
    LIMITS.inputToAuthoritativeVisualFenceP95Ms,
  );
  if (options.completedPresentationLatency === 'application-runtime') {
    assertCompletedPresentationComplete(snapshot.report);
  } else {
    assertMetric(
      snapshot.report,
      'inputToCompletedAuthoritativePresentationFenceMs',
      LIMITS.inputToCompletedPresentationFenceP95Ms,
    );
  }
  assertDisplayPipeline(snapshot.report);
  assertDaemonPipeline(snapshot.report);
  await assertTransportStable(options.page, snapshot);
  return snapshot;
}

async function prepareTerminal(
  page: Page,
  daemonName: string,
  terminalPerf: TerminalPerfFixture,
): Promise<Locator> {
  await connectTerminal(page, daemonName);
  const output = page.getByRole('log', { name: 'Terminal output' });
  // Unique per prepare. The shell is shared by every test in the file and its
  // screen keeps the previous prepare's markers, so a fixed marker can be
  // satisfied by a stale row the mirror announces at connect — a resize that
  // pulls a line in from scrollback shifts every row.
  const nonce = Math.random().toString(36).slice(2, 8);
  const baselineMarker = `perf-prime-baseline-${nonce}`;
  const readyMarker = `perf-prime-ready-${nonce}`;

  // The accessibility mirror's first read is intentionally silent. It marks
  // itself once that read has landed; the ready marker printed after that is
  // then announced, so its appearance proves the shell and mirror are current.
  await page.keyboard.insertText(`${SHELL_RESET_COMMAND}; ${markerPrint(baselineMarker)}\n`);
  await waitForMirrorBaseline(page, LIMITS.markerTimeoutMs);
  await page.keyboard.insertText(`${markerPrint(readyMarker)}\n`);
  await expectExactMarker(output, readyMarker, LIMITS.markerTimeoutMs);
  // Marker visibility proves terminal-state application, not that a delayed
  // independent datagram or its GPU fence cannot still be in flight. Open a
  // disposable boundary solely to reuse the exact proxy+presentation drain;
  // the following reset removes it from the measured artifact.
  const settleMeasurementId = await terminalPerf.beginPresentationMeasurement('streaming');
  await terminalPerf.endPresentationMeasurement(settleMeasurementId);
  await terminalPerf.reset();
  return output;
}

async function expectExactMarker(
  output: Locator,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  await waitForTerminalLog(output.page(), marker, 'line', timeoutMs);
}

async function waitForTelemetry(
  terminalPerf: TerminalPerfFixture,
  minSamples: number,
  extraMetrics: readonly LatencyMetric[],
  requirePresentationCoherence: boolean,
  expectedPresentationWindows = 0,
): Promise<TerminalPerfSnapshot> {
  await expect
    .poll(
      async () => {
        const { report } = await terminalPerf.snapshot();
        if (report.sampleCount < minSamples) return false;
        const completeSamples = Math.max(1, Math.ceil(report.sampleCount * LIMITS.completeRatio));
        if (
          !CORE_METRICS.every((metric) => {
            const result = report[metric];
            if (metric === 'inputToCompletedAuthoritativePresentationFenceMs') {
              const completed = report.inputToCompletedAuthoritativePresentationFenceMs;
              return (
                completed.complete &&
                completed.eligibleCount > 0 &&
                completed.censoredCount === 0 &&
                completed.count === completed.eligibleCount
              );
            }
            return isCompleteLatencyDistribution(result, completeSamples);
          })
        ) {
          return false;
        }
        // Prediction is conditional on the authenticated shell/termios/fg-pgrp
        // security gates. A complete zero-count distribution means the gate
        // correctly stayed closed; it is not missing telemetry.
        if (!extraMetrics.every((metric) => report[metric].complete)) return false;
        if (
          !report.displayPipeline.workerReceiptToDecodeMs.complete ||
          report.displayPipeline.workerReceiptToDecodeMs.count === 0 ||
          !report.displayPipeline.decodeToApplyMs.complete ||
          report.displayPipeline.decodeToApplyMs.count === 0 ||
          !report.displayPipeline.pumpDurationMs.complete ||
          report.displayPipeline.pumpDurationMs.count === 0 ||
          !report.displayPipeline.ringBytesAtPumpStart.complete ||
          report.displayPipeline.ringBytesAtPumpStart.count !==
            report.displayPipeline.pumpDurationMs.count ||
          !report.displayPipeline.ringBytesAtPumpEnd.complete ||
          report.displayPipeline.ringBytesAtPumpEnd.count !==
            report.displayPipeline.pumpDurationMs.count ||
          !report.displayPipeline.ringRefusalAccountingComplete ||
          !report.displayPipeline.ringRefusedFrameCountPerMeasurementWindow.complete ||
          report.displayPipeline.ringRefusedFrameCountPerMeasurementWindow.count !==
            report.presentation.measurementWindowCount ||
          !report.displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows.complete ||
          report.displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows.count !==
            Math.max(0, report.presentation.measurementWindowCount - 1)
        ) {
          return false;
        }
        if (!daemonPipelineComplete(report)) return false;
        if (!requirePresentationCoherence) return true;
        return (
          report.presentation.measurementWindowCount === expectedPresentationWindows &&
          report.presentation.partialPresentationExposureMs.complete &&
          report.presentation.partialPresentationExposureMs.count > 0 &&
          report.presentation.commitsPerPresentation.complete &&
          report.presentation.commitsPerPresentation.count > 0 &&
          report.presentation.measurementWindowExposureMs.complete &&
          report.presentation.measurementWindowExposureMs.count === expectedPresentationWindows &&
          report.presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs
            .complete &&
          report.presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs.count >
            0 &&
          report.presentation.commitsPerMeasurementWindow.complete &&
          report.presentation.commitsPerMeasurementWindow.count === expectedPresentationWindows &&
          report.presentation.ordinaryCommitsPerMeasurementWindow.complete &&
          report.presentation.ordinaryCommitsPerMeasurementWindow.count ===
            expectedPresentationWindows &&
          report.presentation.repairCommitsPerMeasurementWindow.complete &&
          report.presentation.repairCommitsPerMeasurementWindow.count ===
            expectedPresentationWindows &&
          report.presentation.expiredRepairCommitsPerMeasurementWindow.complete &&
          report.presentation.expiredRepairCommitsPerMeasurementWindow.count ===
            expectedPresentationWindows &&
          report.presentation.ordinaryMeasurementWindowExposureMs.complete &&
          report.presentation.ordinaryMeasurementWindowExposureMs.count ===
            expectedPresentationWindows &&
          report.presentation.rowsPerMeasurementWindow.complete &&
          report.presentation.rowsPerMeasurementWindow.count === expectedPresentationWindows &&
          report.presentation.refreshPeriodPerMeasurementWindowMs.complete &&
          report.presentation.refreshPeriodPerMeasurementWindowMs.count > 0 &&
          report.presentation.fenceObservationIntervalPerMeasurementWindowMs.complete &&
          report.presentation.fenceObservationIntervalPerMeasurementWindowMs.count > 0 &&
          report.presentation.commitToGpuFenceMs.complete &&
          report.presentation.commitToGpuFenceMs.count > 0
        );
      },
      {
        timeout: LIMITS.telemetryTimeoutMs,
        intervals: [50, 100, 250],
        message: `terminal telemetry did not complete for the ${PROFILE_NAME} profile`,
      },
    )
    .toBe(true);
  return terminalPerf.snapshot();
}

async function waitForSettledPresentationPipeline(
  terminalPerf: TerminalPerfFixture,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const { report } = await terminalPerf.snapshot();
        return (
          report.presentation.commitCount > 0 &&
          report.presentation.authoritativeVisualCommitCount > 0 &&
          report.presentation.partialPresentationExposureMs.complete &&
          report.presentation.commitsPerPresentation.complete
        );
      },
      {
        timeout: LIMITS.telemetryTimeoutMs,
        intervals: [25, 50, 100],
        message: 'primary-screen presentation work did not reach an observed GPU fence',
      },
    )
    .toBe(true);
}

async function waitForLatestInputAuthoritativeGpuFence(
  terminalPerf: TerminalPerfFixture,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const { events } = await terminalPerf.snapshot();
        const input = events.findLast((event) => event.kind === 'input_queued');
        if (input?.kind !== 'input_queued') return false;
        const commit = events.find(
          (event) =>
            event.kind === 'presentation_commit' &&
            event.authoritativeVisualChange &&
            event.displayInputSeq >= input.inputSeq &&
            event.atMs >= input.atMs,
        );
        if (commit?.kind !== 'presentation_commit') return false;
        const renderEnd = events.find(
          (event) =>
            event.kind === 'render_end' &&
            event.renderSeq === commit.renderSeq &&
            event.completionMode === 'gpu-queue' &&
            event.atMs >= commit.atMs,
        );
        return (
          renderEnd?.kind === 'render_end' &&
          events.some(
            (event) =>
              event.kind === 'frame_complete' &&
              event.renderSeq === commit.renderSeq &&
              event.atMs >= renderEnd.atMs,
          )
        );
      },
      {
        timeout: LIMITS.telemetryTimeoutMs,
        intervals: [10, 25, 50, 100],
        message: 'staged input did not reach an authoritative observed GPU fence',
      },
    )
    .toBe(true);
}

async function waitForLargeCoherentGpuFencedCommit(
  terminalPerf: TerminalPerfFixture,
  measurementId: number,
  minimumRowCount: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const { events } = await terminalPerf.snapshot();
        const start = events.find(
          (event) =>
            event.kind === 'presentation_measurement_boundary' &&
            event.measurementId === measurementId &&
            event.phase === 'start',
        );
        if (start === undefined) return false;

        const renderEnds = new Map<number, Extract<TerminalPerfEvent, { kind: 'render_end' }>>();
        const completedFrames = new Map<
          number,
          Extract<TerminalPerfEvent, { kind: 'frame_complete' }>
        >();
        for (const event of events) {
          if (event.kind === 'render_end') renderEnds.set(event.renderSeq, event);
          else if (event.kind === 'frame_complete') completedFrames.set(event.renderSeq, event);
        }

        return events.some((event) => {
          if (
            event.kind !== 'presentation_commit' ||
            event.atMs < start.atMs ||
            !event.coherent ||
            !event.authoritativeVisualChange ||
            event.rowCount < minimumRowCount
          ) {
            return false;
          }
          const renderEnd = renderEnds.get(event.renderSeq);
          const completedFrame = completedFrames.get(event.renderSeq);
          return (
            renderEnd?.completionMode === 'gpu-queue' &&
            renderEnd.atMs >= event.atMs &&
            completedFrame !== undefined &&
            completedFrame.atMs >= renderEnd.atMs &&
            completedFrame.previousPollAtMs <= completedFrame.atMs
          );
        });
      },
      {
        timeout: LIMITS.longMarkerTimeoutMs,
        intervals: [25, 50, 100],
        message: `alternate-screen redraw never produced a coherent ${minimumRowCount}-row GPU-fenced presentation`,
      },
    )
    .toBe(true);
}

function assertMetric(
  report: TerminalLatencyReport,
  metric: LatencyMetric,
  p95LimitMs: number,
): void {
  const result = report[metric];
  const diagnostic = telemetryDiagnostic(report);
  const completeSamples = Math.max(1, Math.ceil(report.sampleCount * LIMITS.completeRatio));
  expect(result.complete, diagnostic).toBe(true);
  if (metric === 'inputToCompletedAuthoritativePresentationFenceMs') {
    const completed = report.inputToCompletedAuthoritativePresentationFenceMs;
    expect(completed.eligibleCount, diagnostic).toBeGreaterThan(0);
    expect(completed.censoredCount, diagnostic).toBe(0);
    expect(completed.count, diagnostic).toBe(completed.eligibleCount);
  } else {
    expect(result.count, diagnostic).toBeGreaterThanOrEqual(completeSamples);
  }
  expect(result.p95, diagnostic).not.toBeNull();
  expect(result.p95 ?? Number.POSITIVE_INFINITY, diagnostic).toBeLessThanOrEqual(p95LimitMs);
}

function assertCompletedPresentationComplete(report: TerminalLatencyReport): void {
  const completed = report.inputToCompletedAuthoritativePresentationFenceMs;
  const diagnostic = telemetryDiagnostic(report);
  expect(completed.complete, diagnostic).toBe(true);
  expect(completed.eligibleCount, diagnostic).toBeGreaterThan(0);
  expect(completed.censoredCount, diagnostic).toBe(0);
  expect(completed.count, diagnostic).toBe(completed.eligibleCount);
}

function assertDisplayPipeline(report: TerminalLatencyReport): void {
  const pipeline = report.displayPipeline;
  const diagnostic = telemetryDiagnostic(report);
  assertCompleteDistributionP95(
    pipeline.workerReceiptToDecodeMs,
    LIMITS.workerReceiptToDecodeP95Ms,
    diagnostic,
  );
  assertCompleteDistributionP95(pipeline.decodeToApplyMs, LIMITS.decodeToApplyP95Ms, diagnostic);
  assertCompleteDistributionP95(pipeline.pumpDurationMs, LIMITS.displayPumpP95Ms, diagnostic);
  expect(pipeline.pumpBudgetMs.complete, diagnostic).toBe(true);
  expect(pipeline.pumpBudgetMs.count, diagnostic).toBeGreaterThan(0);
  expect(pipeline.pumpBudgetMs.max, diagnostic).not.toBeNull();
  expect(pipeline.pumpDurationMs.max, diagnostic).not.toBeNull();
  expect(pipeline.encodedDeferralQueueHighWaterPerPump.complete, diagnostic).toBe(true);
  expect(pipeline.encodedDeferralQueueHighWaterPerPump.count, diagnostic).toBe(
    pipeline.pumpDurationMs.count,
  );
  expect(pipeline.encodedDeferralQueueRemainingPerPump.complete, diagnostic).toBe(true);
  expect(pipeline.encodedDeferralQueueRemainingPerPump.count, diagnostic).toBe(
    pipeline.pumpDurationMs.count,
  );
  expect(pipeline.ringBytesAtPumpStart.complete, diagnostic).toBe(true);
  expect(pipeline.ringBytesAtPumpStart.count, diagnostic).toBe(pipeline.pumpDurationMs.count);
  expect(pipeline.ringBytesAtPumpEnd.complete, diagnostic).toBe(true);
  expect(pipeline.ringBytesAtPumpEnd.count, diagnostic).toBe(pipeline.pumpDurationMs.count);
  expect(pipeline.ringRefusalAccountingComplete, diagnostic).toBe(true);
  expect(pipeline.ringRefusedFrameCountPerMeasurementWindow.complete, diagnostic).toBe(true);
  expect(pipeline.ringRefusedFrameCountPerMeasurementWindow.count, diagnostic).toBe(
    report.presentation.measurementWindowCount,
  );
  expect(pipeline.ringRefusedFrameCountPerMeasurementWindow.max, diagnostic).toBe(0);
  const ringGapCount = Math.max(0, report.presentation.measurementWindowCount - 1);
  expect(pipeline.ringRefusedFrameCountBetweenMeasurementWindows.complete, diagnostic).toBe(true);
  expect(pipeline.ringRefusedFrameCountBetweenMeasurementWindows.count, diagnostic).toBe(
    ringGapCount,
  );
  if (ringGapCount > 0) {
    expect(pipeline.ringRefusedFrameCountBetweenMeasurementWindows.max, diagnostic).toBe(0);
  }
  expect(pipeline.ringRefusedFrameCount, diagnostic).toBe(0);
  expect(pipeline.budgetExceededCount, diagnostic).toBe(0);
  // The pump owns one bounded scheduling slice. Permit 1 ms of timestamp and
  // loop-exit overhead beyond its advertised budget, but never another frame.
  expect(pipeline.pumpDurationMs.max ?? Number.POSITIVE_INFINITY, diagnostic).toBeLessThanOrEqual(
    (pipeline.pumpBudgetMs.max ?? 0) + 1,
  );
}

function assertExactIsolatedCompletion(
  report: TerminalLatencyReport,
  expectedSamples: number,
): void {
  const diagnostic = telemetryDiagnostic(report);
  const completed = report.inputToCompletedAuthoritativePresentationFenceMs;
  expect(completed.complete, diagnostic).toBe(true);
  expect(completed.eligibleCount, diagnostic).toBe(expectedSamples);
  expect(completed.censoredCount, diagnostic).toBe(0);
  expect(completed.count, diagnostic).toBe(expectedSamples);
  expect(
    report.presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs.complete,
    diagnostic,
  ).toBe(true);
  expect(
    report.presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs.count,
    diagnostic,
  ).toBe(expectedSamples);
}

function assertSpeculativeFeedback(
  report: TerminalLatencyReport,
  events: readonly TerminalPerfEvent[],
  required: boolean,
  expectedEligibleInputs?: number,
): void {
  const diagnostic = telemetryDiagnostic(report);
  // Prediction crosses main -> worker -> renderer and may encounter the
  // current frame's submission/fence gate. Bound it in display periods rather
  // than accepting a fixed 50 ms that means six frames at 120 Hz. The 4 ms
  // residual covers worker dispatch and fence polling; 50 ms remains a hard
  // ceiling on unusually slow/headless refresh observations.
  const refreshPeriodMs = report.presentation.refreshPeriodPerMeasurementWindowMs.p95 ?? 1_000 / 60;
  const predictionPaintP95Ms = Math.min(50, Math.max(8, refreshPeriodMs * 2 + 4));
  const drawIssued = report.inputToPredictionSubmissionMs;
  expect(drawIssued.complete, diagnostic).toBe(true);
  if (required) expect(drawIssued.count, diagnostic).toBeGreaterThan(0);
  if (required && expectedEligibleInputs !== undefined) {
    expect(drawIssued.count, diagnostic).toBe(expectedEligibleInputs);
  }
  if (drawIssued.count > 0) {
    expect(drawIssued.p95, diagnostic).not.toBeNull();
    expect(drawIssued.p95 ?? Number.POSITIVE_INFINITY, diagnostic).toBeLessThanOrEqual(
      predictionPaintP95Ms,
    );
  }

  const workerPredictionFence = report.inputToPredictionPaintMs;
  expect(workerPredictionFence.complete, diagnostic).toBe(true);
  const visibleGateRecorded = events.some(
    (event) => event.kind === 'prediction_gate' && event.state === 'visible',
  );
  if (required) {
    expect(visibleGateRecorded, diagnostic).toBe(true);
    expect(workerPredictionFence.eligibleCount, diagnostic).toBeGreaterThan(0);
    if (expectedEligibleInputs !== undefined) {
      expect(workerPredictionFence.eligibleCount, diagnostic).toBe(expectedEligibleInputs);
    }
    expect(workerPredictionFence.count, diagnostic).toBe(workerPredictionFence.eligibleCount);
    expect(workerPredictionFence.coverageRatio, diagnostic).toBe(1);
    expect(
      events.some((event) => event.kind === 'prediction_queued'),
      diagnostic,
    ).toBe(true);
    expect(
      events.some((event) => event.kind === 'prediction_applied'),
      diagnostic,
    ).toBe(true);
  } else if (workerPredictionFence.count === 0) {
    // A low-latency path may deliberately keep safe prediction hidden. Its
    // absence is valid only when telemetry agrees that visibility never armed.
    expect(visibleGateRecorded, diagnostic).toBe(false);
  }
  if (workerPredictionFence.count > 0) {
    expect(workerPredictionFence.p95, diagnostic).not.toBeNull();
    expect(workerPredictionFence.p95 ?? Number.POSITIVE_INFINITY, diagnostic).toBeLessThanOrEqual(
      predictionPaintP95Ms,
    );
  }
}

function daemonPipelineComplete(report: TerminalLatencyReport): boolean {
  const pipeline = report.daemonPipeline;
  return (
    pipeline.complete &&
    pipeline.batchCount > 0 &&
    pipeline.inputAttributedTotal > 0 &&
    pipeline.displayAttributedTotal > 0 &&
    pipeline.inputDroppedTotal === 0 &&
    pipeline.inputSkippedTotal === 0 &&
    pipeline.pendingInputs === 0 &&
    pipeline.displayDroppedTotal === 0 &&
    DAEMON_INPUT_PIPELINE_TERMS.every((term) => {
      const distribution = pipeline[term];
      return distribution.complete && distribution.count === pipeline.inputAttributedTotal;
    }) &&
    DAEMON_DISPLAY_PIPELINE_TERMS.every((term) => {
      const distribution = pipeline[term];
      return distribution.complete && distribution.count === pipeline.displayAttributedTotal;
    })
  );
}

function assertDaemonPipeline(report: TerminalLatencyReport, expectedInputs?: number): void {
  const pipeline = report.daemonPipeline;
  const diagnostic = telemetryDiagnostic(report);
  expect(pipeline.complete, diagnostic).toBe(true);
  expect(pipeline.batchCount, diagnostic).toBeGreaterThan(0);
  expect(pipeline.inputAttributedTotal, diagnostic).toBeGreaterThan(0);
  if (expectedInputs !== undefined) {
    expect(pipeline.inputAttributedTotal, diagnostic).toBe(expectedInputs);
  }
  expect(pipeline.displayAttributedTotal, diagnostic).toBeGreaterThan(0);
  expect(pipeline.inputDroppedTotal, diagnostic).toBe(0);
  expect(pipeline.inputSkippedTotal, diagnostic).toBe(0);
  expect(pipeline.pendingInputs, diagnostic).toBe(0);
  expect(pipeline.displayDroppedTotal, diagnostic).toBe(0);
  for (const term of DAEMON_INPUT_PIPELINE_TERMS) {
    const distribution = pipeline[term];
    expect(distribution.complete, `${diagnostic}; daemonTerm=${term}`).toBe(true);
    expect(distribution.count, `${diagnostic}; daemonTerm=${term}`).toBe(
      pipeline.inputAttributedTotal,
    );
  }
  for (const term of DAEMON_DISPLAY_PIPELINE_TERMS) {
    const distribution = pipeline[term];
    expect(distribution.complete, `${diagnostic}; daemonTerm=${term}`).toBe(true);
    expect(distribution.count, `${diagnostic}; daemonTerm=${term}`).toBe(
      pipeline.displayAttributedTotal,
    );
  }
}

function assertCompleteDistributionP95(
  distribution: TerminalLatencyPercentiles,
  limitMs: number,
  diagnostic: string,
): void {
  expect(distribution.complete, diagnostic).toBe(true);
  expect(distribution.count, diagnostic).toBeGreaterThan(0);
  expect(distribution.p95, diagnostic).not.toBeNull();
  expect(distribution.p95 ?? Number.POSITIVE_INFINITY, diagnostic).toBeLessThanOrEqual(limitMs);
}

/**
 * Presentation coherence, in the two tiers the design actually guarantees.
 *
 * FRAMED (`framed: true`) — the workload declares its redraw with synchronized
 * output (`DECSET 2026` BSU/ESU). The daemon holds framed output until ESU, so
 * the whole update reaches the browser as one presentation and commits exactly
 * once with zero partial exposure. Nothing here is probabilistic; assert the
 * exact numbers.
 *
 * UNFRAMED (`framed: false`) — a plain burst with no end-of-update statement on
 * the wire. The daemon no longer holds output for a coalescing interval, so one
 * logical redraw arrives as however many chunks its kernel PTY reads produced,
 * a millisecond or two apart. The browser's guarantee is therefore not "one
 * commit" but "at most one ordinary commit per refresh interval": every chunk
 * applied before the next worker animation frame folds into that frame's single
 * commit, and a chunk that straddles a vsync legitimately paints in the next
 * one instead. So the commit bound is the window's own measured exposure
 * divided by its own measured refresh period. Tightening this to exactly one
 * commit would be asserting that the sender framed an update it never framed.
 *
 * The exposure budget is `mainThread.rafGapMs.max`, not the estimated refresh
 * period. Those are different quantities and the difference is exactly what a
 * one-frame exposure measures: the estimator publishes a *converged* period —
 * 8.2-8.4 ms on the harness — while the compositor's actual interval between
 * two consecutive callbacks in the same run was 8.6-8.8 ms. Budgeting against
 * the converged period asserts that no single frame interval ever exceeds the
 * mean, which is false by construction. `rafGapMs` is the observed interval, so
 * it is the honest term; the main-thread and worker rAF share the compositor's
 * BeginFrame, so the main-thread distribution bounds the worker's.
 */
function assertPresentationCoherence(
  { report, events }: TerminalPerfSnapshot,
  options: { readonly framed: boolean },
): void {
  const presentation = report.presentation;
  const diagnostic = telemetryDiagnostic(report);
  expect(presentation.commitCount, diagnostic).toBeGreaterThan(0);
  expect(presentation.authoritativeVisualCommitCount, diagnostic).toBeGreaterThan(0);
  expect(presentation.frameBudgetExceededCount, diagnostic).toBe(0);
  expect(presentation.partialPresentationExposureMs.complete, diagnostic).toBe(true);
  expect(presentation.partialPresentationExposureMs.count, diagnostic).toBeGreaterThan(0);
  expect(presentation.commitsPerPresentation.complete, diagnostic).toBe(true);
  expect(presentation.commitsPerPresentation.count, diagnostic).toBeGreaterThan(0);
  expect(presentation.measurementWindowExposureMs.complete, diagnostic).toBe(true);
  expect(presentation.measurementWindowExposureMs.count, diagnostic).toBeGreaterThan(0);
  expect(
    presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs.complete,
    diagnostic,
  ).toBe(true);
  expect(
    presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs.count,
    diagnostic,
  ).toBeGreaterThan(0);
  expect(
    presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs.p95 ??
      Number.POSITIVE_INFINITY,
    diagnostic,
  ).toBeLessThanOrEqual(LIMITS.inputToCompletedPresentationFenceP95Ms);
  expect(presentation.commitsPerMeasurementWindow.complete, diagnostic).toBe(true);
  expect(presentation.commitsPerMeasurementWindow.count, diagnostic).toBeGreaterThan(0);
  expect(presentation.ordinaryCommitsPerMeasurementWindow.complete, diagnostic).toBe(true);
  expect(presentation.ordinaryCommitsPerMeasurementWindow.count, diagnostic).toBe(
    presentation.measurementWindowCount,
  );
  expect(presentation.repairCommitsPerMeasurementWindow.complete, diagnostic).toBe(true);
  expect(presentation.repairCommitsPerMeasurementWindow.count, diagnostic).toBe(
    presentation.measurementWindowCount,
  );
  expect(presentation.expiredRepairCommitsPerMeasurementWindow.complete, diagnostic).toBe(true);
  expect(presentation.expiredRepairCommitsPerMeasurementWindow.count, diagnostic).toBe(
    presentation.measurementWindowCount,
  );
  expect(presentation.ordinaryMeasurementWindowExposureMs.complete, diagnostic).toBe(true);
  expect(presentation.ordinaryMeasurementWindowExposureMs.count, diagnostic).toBe(
    presentation.measurementWindowCount,
  );
  expect(presentation.rowsPerMeasurementWindow.complete, diagnostic).toBe(true);
  expect(presentation.rowsPerMeasurementWindow.count, diagnostic).toBeGreaterThan(0);
  expect(presentation.rowsPerMeasurementWindow.p50 ?? 0, diagnostic).toBeGreaterThan(1);
  expect(presentation.datagramsPerMeasurementWindow.complete, diagnostic).toBe(true);
  expect(presentation.datagramsPerMeasurementWindow.count, diagnostic).toBeGreaterThan(0);
  expect(presentation.datagramsPerMeasurementWindow.p50 ?? 0, diagnostic).toBeGreaterThan(0);
  expect(presentation.bytesPerMeasurementWindow.complete, diagnostic).toBe(true);
  expect(presentation.bytesPerMeasurementWindow.count, diagnostic).toBeGreaterThan(0);
  expect(presentation.bytesPerMeasurementWindow.p50 ?? 0, diagnostic).toBeGreaterThan(0);
  expect(presentation.firstDisplayReceiveToCompletedPresentationFenceMs.complete, diagnostic).toBe(
    true,
  );
  expect(
    presentation.firstDisplayReceiveToCompletedPresentationFenceMs.count,
    diagnostic,
  ).toBeGreaterThan(0);
  expect(presentation.refreshPeriodPerMeasurementWindowMs.complete, diagnostic).toBe(true);
  expect(presentation.fenceObservationIntervalPerMeasurementWindowMs.complete, diagnostic).toBe(
    true,
  );
  expect(presentation.firstApplyToCommitMs.complete, diagnostic).toBe(true);
  expect(presentation.firstApplyToCommitMs.max, diagnostic).not.toBeNull();
  expect(presentation.commitToGpuFenceMs.complete, diagnostic).toBe(true);
  expect(presentation.commitToGpuFenceMs.count, diagnostic).toBeGreaterThan(0);
  expect(presentation.commitToGpuFenceMs.max, diagnostic).not.toBeNull();

  const refreshPeriodMs =
    presentation.refreshPeriodPerMeasurementWindowMs.max ?? Number.POSITIVE_INFINITY;
  const fencePollUncertaintyMs =
    presentation.fenceObservationIntervalPerMeasurementWindowMs.max ?? Number.POSITIVE_INFINITY;
  expect(Number.isFinite(refreshPeriodMs), diagnostic).toBe(true);
  expect(Number.isFinite(fencePollUncertaintyMs), diagnostic).toBe(true);

  // The presentation hold consumes at most two eligible worker rAFs. Callback
  // dispatch delay is not the estimated refresh period, and GPU-fence polling
  // happens after commit, so neither supplies a wall-clock bound for this hold.
  // Check its actual opportunities below. Keep firstApplyToCommit diagnostic
  // and the unchanged end-to-end fence latency limit above.

  // Transport impairment never relaxes ordinary presentation coherence. A
  // sender presentation id can legitimately be reused when a lost independent
  // datagram arrives later through exact FEC/row repair, so the per-id totals
  // above remain diagnostic. Acceptance is against the logical window after
  // repair-provenance commits are classified separately.
  const ordinaryExposureMs =
    presentation.ordinaryMeasurementWindowExposureMs.max ?? Number.POSITIVE_INFINITY;
  let exposureBudgetMs = 0;
  if (!options.framed) {
    // The observed interval between two consecutive animation frames, not the
    // converged period estimate. See the two-tier note above.
    expect(report.mainThread.complete, diagnostic).toBe(true);
    const observedFrameGapMs = report.mainThread.rafGapMs.max ?? Number.POSITIVE_INFINITY;
    expect(Number.isFinite(observedFrameGapMs), diagnostic).toBe(true);
    exposureBudgetMs = observedFrameGapMs + fencePollUncertaintyMs;
  }
  expect(ordinaryExposureMs, diagnostic).toBeLessThanOrEqual(exposureBudgetMs);
  // Count actual opportunities. GPU completion gaps are not frame intervals:
  // a quicker second submission can complete less than one estimated period
  // after its predecessor even though they committed on consecutive rAFs.
  // Every unframed ordinary commit must instead own a distinct, increasing rAF,
  // unless it was released early, inside the task that closed it: a met
  // closure claim or a paced close, which the worker admits at most once per
  // frame and which carries no rAF (`releaseFrameTimeMs` 0).
  let windowOpen = false;
  let lastReleaseFrameTimeMs = 0;
  let commitsInWindow = 0;
  let maxOrdinaryCommits = 0;
  for (const event of events.toSorted((left, right) => left.atMs - right.atMs)) {
    if (event.kind === 'presentation_measurement_boundary') {
      windowOpen = event.phase === 'start';
      lastReleaseFrameTimeMs = 0;
      commitsInWindow = 0;
    } else if (
      windowOpen &&
      event.kind === 'presentation_commit' &&
      event.authoritativeVisualChange &&
      event.reason !== 'repair-target-satisfied' &&
      event.reason !== 'repair-deadline-expired'
    ) {
      expect(Number.isInteger(event.releaseFrameCount), diagnostic).toBe(true);
      expect(event.releaseFrameCount, diagnostic).toBeGreaterThanOrEqual(0);
      expect(event.releaseFrameCount, diagnostic).toBeLessThanOrEqual(2);
      if (event.reason === 'group-end-vsync' || event.reason === 'deadline-vsync') {
        expect(event.releaseFrameCount, diagnostic).toBeGreaterThan(0);
      }
      if (!options.framed && event.releaseFrameTimeMs === 0) {
        expect(['paced-complete', 'closure-complete'], diagnostic).toContain(event.reason);
      } else if (!options.framed) {
        expect(event.releaseFrameTimeMs, diagnostic).toBeGreaterThan(lastReleaseFrameTimeMs);
        lastReleaseFrameTimeMs = event.releaseFrameTimeMs;
      }
      maxOrdinaryCommits = Math.max(maxOrdinaryCommits, ++commitsInWindow);
    }
  }
  const ordinaryCommitBound = options.framed ? 1 : maxOrdinaryCommits;
  expect(
    presentation.ordinaryCommitsPerMeasurementWindow.max ?? Number.POSITIVE_INFINITY,
    diagnostic,
  ).toBeLessThanOrEqual(ordinaryCommitBound);
  expect(presentation.repairCommitsPerMeasurementWindow.max ?? 2, diagnostic).toBeLessThanOrEqual(
    CLEAN_DELIVERY ? 0 : 1,
  );
  expect(presentation.expiredRepairCommitsPerMeasurementWindow.max, diagnostic).toBe(0);

  const repairCount =
    presentation.repairCommitsPerMeasurementWindow.max ?? Number.POSITIVE_INFINITY;
  if (repairCount === 0) {
    expect(
      presentation.commitsPerMeasurementWindow.max ?? Number.POSITIVE_INFINITY,
      diagnostic,
    ).toBeLessThanOrEqual(ordinaryCommitBound);
    expect(
      presentation.measurementWindowExposureMs.max ?? Number.POSITIVE_INFINITY,
      diagnostic,
    ).toBeLessThanOrEqual(exposureBudgetMs);
  } else {
    expect(
      presentation.commitsPerMeasurementWindow.max ?? Number.POSITIVE_INFINITY,
      diagnostic,
    ).toBeLessThanOrEqual(ordinaryCommitBound + 1);
  }
}

async function assertTransportStable(page: Page, snapshot: TerminalPerfSnapshot): Promise<void> {
  const unstable = snapshot.events.filter(
    (event) =>
      event.kind === 'transport_state' &&
      (event.state === 'disconnected' || event.state === 'signaling_reconnecting'),
  );
  expect(unstable, `transport instability under ${PROFILE_NAME}`).toEqual([]);
  // Through the shared helper rather than an inline literal. This assertion
  // still compared against the uppercase `CONNECTED` the app stopped exposing,
  // so it could only ever fail on its polling timeout.
  await expectConnected(page, LIMITS.telemetryTimeoutMs);
}

function markerPrint(marker: string): string {
  const splitAt = Math.max(1, Math.floor(marker.length / 2));
  const first = marker.slice(0, splitAt);
  const second = marker.slice(splitAt);
  // Clear the whole physical row before the marker. Large redraw tests leave
  // long cells behind; a shorter marker otherwise inherits their untouched
  // suffix and the accessibility mirror correctly refuses the non-exact row.
  return `printf '\\033[2K\\r%s%s\\n' ${shellQuote(first)} ${shellQuote(second)}`;
}

function checkedValueCommand(value: string, marker: string): string {
  const quoted = shellQuote(value);
  return `actual=${quoted}; [ "$actual" = ${quoted} ] && ${markerPrint(marker)}\n`;
}

function outputBurstCommand(
  rows: number,
  width: number,
  readyMarker: string,
  marker: string,
): string {
  const fill = 'x'.repeat(width);
  return (
    `stty -echo; ${markerPrint(readyMarker)}; IFS= read -r _start; ` +
    `i=0; while [ $i -lt ${rows} ]; do ` +
    `printf 'burst-%03d-${fill}\\n' "$i"; i=$((i+1)); done; ${markerPrint(marker)}; ` +
    `IFS= read -r _finish; stty echo\n`
  );
}

function catStyleOutputCommand(readyMarker: string, marker: string): string {
  const file = `/tmp/merkur-perf-${marker}`;
  const fill = 'cat-payload-'.repeat(8);
  return (
    `stty -echo; file=${shellQuote(file)}; : > "$file"; i=0; ` +
    `while [ $i -lt 180 ]; do printf 'cat-%03d-${fill}\\n' "$i" >> "$file"; ` +
    `i=$((i+1)); done; ${markerPrint(readyMarker)}; IFS= read -r _start; ` +
    `cat "$file"; ${markerPrint(marker)}; IFS= read -r _finish; ` +
    `rm -f "$file"; stty echo\n`
  );
}

/**
 * A dependency-free alternate-screen application workload. It changes every
 * visible row, uses 24-bit foreground/background styles, positions the cursor
 * like a TUI, and leaves the completed frame installed until the test observes
 * its GPU fence. Separate shell `printf` calls intentionally model an
 * application issuing a redraw as a short PTY-write burst rather than one
 * monolithic write. READY and the final cleanup witness are printed on the
 * primary screen because the accessibility mirror intentionally hides this
 * alternate-screen frame.
 */
/**
 * A real TUI redraw: alternate screen, 24 truecolor rows, one header line —
 * wrapped in synchronized output (`DECSET 2026` BSU/ESU).
 *
 * The framing is load-bearing for the presentation oracle. A TUI that declares
 * its redraw gives the daemon an exact statement of where the update ends, so
 * the daemon holds the whole thing until ESU and the browser presents it as one
 * commit with zero partial exposure. Without the framing the sender has no such
 * statement, and this becomes the unframed tier below — which is exactly why
 * the two tiers are asserted separately rather than averaged into one bound.
 */
function fullScreenTruecolorRedrawCommand(readyMarker: string, marker: string): string {
  const fill = 'TUI-CELL-'.repeat(10);
  return (
    `stty -echo; ${markerPrint(readyMarker)}; IFS= read -r _start; ` +
    `printf '\\033[?2026h\\033[?1049h\\033[2J\\033[H'; i=1; while [ $i -le 24 ]; do ` +
    `r=$((i*37%256)); g=$((i*67%256)); b=$((i*97%256)); ` +
    `printf '\\033[%d;1H\\033[38;2;%d;%d;%dm\\033[48;2;%d;%d;%dmTUI-%02d-${fill}\\033[0m' ` +
    `"$i" "$r" "$g" "$b" "$b" "$r" "$g" "$i"; i=$((i+1)); done; ` +
    `printf '\\033[1;1H\\033[2K\\033[0mTUI-REDRAW-COMPLETE\\033[?2026l'; ` +
    `IFS= read -r _continue; printf '\\033[?1049l'; stty echo; ` +
    `sleep 0.55; ${markerPrint(marker)}\n`
  );
}

function backgroundOutputCommand(rows: number, marker: string): string {
  return (
    `(i=0; while [ $i -lt ${rows} ]; do printf 'load-%03d\\n' "$i"; ` +
    `i=$((i+1)); sleep 0.01; done; ${markerPrint(marker)}) &\n`
  );
}

function sequentialAssignmentBatch(count: number, marker: string, restoreQuiet = false): string {
  const tokens = Array.from({ length: count }, (_, index) => `t${String(index).padStart(3, '0')}`);
  const assignments = tokens.map((token) => `value=\${value}${token}\n`).join('');
  const restore = restoreQuiet ? 'actual=$value\nPS1=$saved_ps1\nstty echo\n' : '';
  const actual = restoreQuiet ? '$actual' : '$value';
  const verification =
    `expected=; i=0; while [ $i -lt ${count} ]; do ` +
    `expected="\${expected}t$(printf '%03d' "$i")"; i=$((i+1)); done\n` +
    `if [ "${actual}" = "$expected" ]; then ${markerPrint(marker)}; else ` +
    `printf 'actual-length=%s\\n' "\${#actual}"; printf '%s\\n' "${actual}" | fold -w 40; fi\n`;
  return `value=\n${assignments}${restore}${verification}`;
}

async function prepareQuietShell(
  page: Page,
  output: Locator,
  terminalPerf: TerminalPerfFixture,
  marker: string,
): Promise<void> {
  await page.keyboard.insertText(`saved_ps1=$PS1; PS1=; stty -echo; ${markerPrint(marker)}\n`);
  await expectExactMarker(output, marker, LIMITS.markerTimeoutMs);
  await terminalPerf.reset();
}

function backgroundOutputWithWitnessCommand(rows: number, witnessPath: string): string {
  return (
    `rm -f ${shellQuote(witnessPath)}; ` +
    `(i=0; while [ $i -lt ${rows} ]; do printf 'load-%03d\\n' "$i"; ` +
    `i=$((i+1)); sleep 0.01; done; ` +
    `if [ -f ${shellQuote(witnessPath)} ]; then cat ${shellQuote(witnessPath)}; ` +
    `rm -f ${shellQuote(witnessPath)}; fi) &\n`
  );
}

function checkedValueWitnessCommand(value: string, marker: string, witnessPath: string): string {
  const quoted = shellQuote(value);
  return (
    `actual=${quoted}; [ "$actual" = ${quoted} ] && ` +
    `${markerPrint(marker)} | tee ${shellQuote(witnessPath)}\n`
  );
}

function telemetryDiagnostic(report: TerminalLatencyReport): string {
  return JSON.stringify({
    profile: PROFILE_NAME,
    samples: report.sampleCount,
    ack: report.inputAckMs,
    receive: report.inputToDisplayReceiveMs,
    receiveToQueue: report.displayReceiveToWorkerQueueMs,
    queueToApply: report.workerQueueToDisplayApplyMs,
    apply: report.inputToDisplayApplyMs,
    authoritativeVisualGpuFence: report.inputToAuthoritativeVisualFenceMs,
    completedAuthoritativePresentationGpuFence:
      report.inputToCompletedAuthoritativePresentationFenceMs,
    gpuFenceObservationInterval: report.fenceObservationIntervalMs,
    daemonPipeline: report.daemonPipeline,
    displayPipeline: report.displayPipeline,
    presentation: report.presentation,
    prediction: report.inputToPredictionPaintMs,
  });
}

function readNonNegativeNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

type GraphicsArm = 'C' | 'I';
type GraphicsTypingMetric = (typeof GRAPHICS_TYPING_METRICS)[number];
type GraphicsAssetEvent = Extract<TerminalPerfEvent, { kind: 'graphics_asset' }>;
type InputQueuedEvent = Extract<TerminalPerfEvent, { kind: 'input_queued' }>;

/** What the member procedure recorded, before the batch trace is read. */
interface GraphicsTypingMember {
  readonly arm: GraphicsArm;
  readonly pair: number;
  readonly armingKey: number;
  readonly timedKey: number;
  readonly measurementId: number;
  /** Page clock just before the arming snapshot; asset events count from here. */
  readonly armAtMs: number;
  readonly assetsBefore: TelemetryGraphicsAssetStatus;
  /** Relays as each mark found them; pending counts are recorded, never asserted. */
  readonly armingMark: ProxySettleStatus | null;
  readonly timedMark: ProxySettleStatus | null;
  /** The input frontier of the first settle poll that saw the timed input complete. */
  readonly closedInput: TelemetryInputFrontierStatus;
  /**
   * Every relay's ledger since the timed mark as that same poll read it, right
   * after the completion: the trace-wide one, which keeps a relay that
   * detached, and each live relay's. It defines the stratum.
   */
  readonly closedLedger: ProxySettleStatus | null;
  /** The same ledgers read after the end settle. Diagnostic only. */
  readonly ledger: ProxySettleStatus | null;
  /**
   * Under a bottleneck: every link's totals and each relay's residence and
   * bytes on its role's links since the timed mark, after the end settle.
   */
  readonly links: {
    readonly links: readonly ProxyLinkStatus[];
    readonly relays: readonly ProxyRelayLinks[];
  } | null;
}

/** The member's single timed sample and its tile jobs, read from the batch trace. */
interface GraphicsMemberObservation {
  readonly inputSeq: number;
  readonly inputQueuedAtMs: number;
  readonly inputSentAtMs: number;
  readonly displayReceivedAtMs: number;
  readonly windowEndAtMs: number;
  readonly metrics: Readonly<Record<GraphicsTypingMetric, number>>;
  readonly jobIds: readonly number[];
  readonly firstByteAtMs: number | null;
  readonly maxFinAtMs: number | null;
  /** Spare dials inside the member: allowed, recorded. */
  readonly dialStarted: number;
  /** Diagnostics: the timed input's daemon record, when it reported one. */
  readonly daemon: GraphicsDaemonTerms | null;
  /** Diagnostics: refusals and relay residence reported from arm to the next arm. */
  readonly egress: GraphicsEgressDelta;
}

interface GraphicsTypingPairRecord {
  readonly pair: number;
  readonly batch: number;
  readonly order: readonly GraphicsArm[];
  /** Defined by the control member alone; null on the clean profile. */
  readonly stratum: GraphicsTypingStratum | null;
  readonly control: GraphicsTypingMember & { readonly observation: GraphicsMemberObservation };
  readonly image: GraphicsTypingMember & { readonly observation: GraphicsMemberObservation };
  /** Diagnostics only: the relays that carried traffic in the control window. */
  readonly relays: readonly GraphicsRelayDiagnostic[] | null;
}

interface GraphicsRelayDiagnostic {
  readonly admissionSeq: number;
  /** The control's downstream packets and drops since its timed mark, at its close. */
  readonly controlClosedDownSeen: number | null;
  readonly controlClosedDownDropped: number | null;
  /** The same after the end settle. */
  readonly controlDownSeen: number | null;
  readonly imageMinusControlDownSeen: number | null;
  readonly controlDownDropped: number | null;
  readonly imageDownDropped: number | null;
  /** The most packets each of the control's delay lines held at once by the settle. */
  readonly controlMaxInFlight: { readonly up: number; readonly down: number } | null;
  readonly pending: {
    readonly control: { readonly arming: number | null; readonly timed: number | null };
    readonly image: { readonly arming: number | null; readonly timed: number | null };
  };
}

interface GraphicsVoidedBatch {
  readonly batch: number;
  readonly pairs: readonly number[];
  readonly reason: GraphicsVoidReason;
  readonly carrierPhases: readonly { readonly atMs: number; readonly phase: string }[];
  readonly dataLaneRecoveries: readonly GraphicsDataLaneRecovery[];
  /** A member failure inside the batch: voided with it, and kept on record. */
  readonly error: string | null;
}

/** The pairs a run ran that its sample does not hold. */
interface GraphicsSpentPairs {
  readonly voided: GraphicsVoidedBatch[];
  readonly missedQuads: GraphicsMissedQuad[];
}

interface GraphicsTypingContext {
  readonly page: Page;
  readonly output: Locator;
  readonly terminalPerf: TerminalPerfFixture;
  readonly testInfo: TestInfo;
  readonly frameBudgetMs: number;
}

/**
 * The PTY client. Every command is one byte. `U` uploads the next batch's
 * fresh sources, `C`/`I` place the next tiny/large one at the same geometry
 * and print nothing, `a`–`z` echo one row, `D` deletes the batch's sources,
 * `!` exits. In the A/A run the `I` sources are tiny as well, uploaded and
 * placed exactly as the control's. Uploading per batch keeps resident
 * originals bounded however long the run; a quota refusal fails the upload and
 * READY never prints.
 */
function graphicsTypingClient(runNonce: string): string {
  const { columns, batchPairs } = GRAPHICS_TYPING;
  const { width, height } = GRAPHICS_IMAGE_ARM;
  return String.raw`
import base64, hashlib, os, select, termios, time, tty
saved = termios.tcgetattr(0)
NONCE, PAIRS = ${JSON.stringify(runNonce)}, ${batchPairs}
WIDTH, HEIGHT, COLUMNS = ${width}, ${height}, ${columns}
CONTROL_TWIN = ${GRAPHICS_TYPING_A_A ? 'True' : 'False'}
def write(data):
    while data:
        count = os.write(1, data)
        if count <= 0: raise RuntimeError("closed PTY")
        data = data[count:]
def response():
    result = b""
    deadline = time.monotonic() + 20
    while not result.endswith(b"\x1b\\"):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
            raise RuntimeError("upload response timeout")
        result += os.read(0, 4096)
    if b";OK\x1b\\" not in result: raise RuntimeError(repr(result))
def upload_tiny(image):
    upload(image, 1, 1, bytes(((image >> 16) & 255, (image >> 8) & 255, image & 255, 255)))
def upload(image, width, height, pixels):
    encoded = base64.b64encode(pixels)
    for offset in range(0, len(encoded), 4096):
        more = int(offset + 4096 < len(encoded))
        header = f"a=t,i={image},f=32,s={width},v={height},m={more}" if offset == 0 else f"m={more}"
        write(b"\x1b_G" + header.encode() + b";" + encoded[offset:offset + 4096] + b"\x1b\\")
    response()
def marker(text):
    # The accessibility mirror never announces the cursor row, so a marker
    # leaves it.
    write(f"\x1b[20;1H{text}\x1b[K\r\n".encode())
try:
    tty.setraw(0)
    write(b"\x1b[2J\x1b[H")
    marker("GRAPHICS-TYPING-READY")
    batch, large, tiny, placed, ordinal = -1, [], [], {b"C": 0, b"I": 0}, 0
    while True:
        key = os.read(0, 1)
        if not key or key == b"!": break
        if key == b"U":
            batch += 1
            base = batch * 2 * PAIRS
            large = list(range(base + 1, base + PAIRS + 1))
            tiny = list(range(base + PAIRS + 1, base + 2 * PAIRS + 1))
            placed = {b"C": 0, b"I": 0}
            # Unique content per run and id: tile keys are content roots, so
            # both arms are cold in the browser's asset cache.
            for image in large:
                if CONTROL_TWIN:
                    upload_tiny(image)
                    continue
                pixels = bytearray(hashlib.shake_256(f"{NONCE}:{image}".encode()).digest(WIDTH * HEIGHT * 4))
                pixels[3::4] = b"\xff" * (WIDTH * HEIGHT)
                upload(image, WIDTH, HEIGHT, pixels)
            for image in tiny:
                upload_tiny(image)
            marker(f"BATCH-{batch}-READY")
        elif key in (b"C", b"I"):
            image = (tiny if key == b"C" else large)[placed[key]]
            placed[key] += 1
            write(b"\x1b_Ga=d,d=a\x1b\\\x1b[22;1H" + f"\x1b_Ga=p,i={image},c={COLUMNS},r=1,z=-1,C=1,q=2\x1b\\".encode())
        elif key == b"D":
            write(b"".join(f"\x1b_Ga=d,d=I,i={image}\x1b\\".encode() for image in large + tiny))
            marker(f"BATCH-{batch}-DELETED")
        elif b"a" <= key <= b"z":
            ordinal += 1
            write(f"\x1b[22;1H{ordinal:04d}-".encode() + key)
        else:
            raise RuntimeError(f"unexpected key {key!r}")
finally:
    write(b"\x1b_Ga=d,d=A\x1b\\\x1b[2J\x1b[H")
    termios.tcsetattr(0, termios.TCSANOW, saved)
`;
}

/**
 * Runs batches until the pre-declared sample-size rule is met, then applies C1
 * (and C2 when impaired) against the idle refresh period `frameBudgetMs`.
 */
async function measureGraphicsTyping(context: GraphicsTypingContext): Promise<void> {
  const pairs: GraphicsTypingPairRecord[] = [];
  const spent: GraphicsSpentPairs = { voided: [], missedQuads: [] };
  try {
    await runGraphicsTypingBatches(context, pairs, spent.voided, spent.missedQuads);
  } catch (error) {
    // The valid pairs so far stay inspectable; the failure itself is not excused.
    await writeGraphicsTypingPaired(context, pairs, spent, formatGraphicsError(error));
    throw error;
  }
  const verdict = await writeGraphicsTypingPaired(context, pairs, spent, null);
  // A bottleneck run is an experiment: its pre-declared criteria compare it
  // with loopback runs and other commits using the retained paired-tail and
  // link measurements (docs/performance.md), so this run asserts only validity.
  if (EDGE_BOTTLENECK !== null) return;
  for (const metric of GRAPHICS_TYPING_METRICS) {
    expect(
      verdict.c1[metric]?.upper95 ?? Number.POSITIVE_INFINITY,
      `C1: upper bound of the p95 ${metric} the image transfer adds`,
    ).toBeLessThan(context.frameBudgetMs);
    if (GRAPHICS_LOSSY) {
      expect(
        verdict.c2[metric]?.bound ?? Number.POSITIVE_INFINITY,
        `C2: upper bound of the median ${metric} the image transfer adds under loss`,
      ).toBeLessThan(context.frameBudgetMs);
    }
  }
}

/** Runs batches until the sample-size rule is met; throws when it cannot be. */
async function runGraphicsTypingBatches(
  context: GraphicsTypingContext,
  pairs: GraphicsTypingPairRecord[],
  voided: GraphicsVoidedBatch[],
  missedQuads: GraphicsMissedQuad[],
): Promise<void> {
  let ordinal = 0;
  for (let batch = 0; ; batch += 1) {
    // Pair indices and trace keys are run-global and never reused, so a
    // replacement batch gets fresh ones in the same quad phase.
    const outcome = await runGraphicsTypingBatch(context, {
      batch,
      firstPair: batch * GRAPHICS_TYPING.batchPairs,
      plannedPairs: GRAPHICS_LOSSY
        ? GRAPHICS_TYPING.batchPairs
        : Math.min(GRAPHICS_TYPING.batchPairs, GRAPHICS_TYPING_CLEAN_PAIRS - pairs.length),
      validPairs: pairs,
      firstOrdinal: ordinal,
    });
    ordinal = outcome.nextOrdinal;
    if (outcome.voided !== null) {
      voided.push(outcome.voided);
      // Under a bottleneck a retired data attachment voids its pairs, which
      // are counted, not excused: the run still has to reach its sample.
      if (EDGE_BOTTLENECK === null && voided.length > 1) {
        throw new Error(`a second graphics typing batch was voided: ${JSON.stringify(voided)}`);
      }
    } else {
      pairs.push(...outcome.pairs);
      missedQuads.push(...outcome.missedQuads);
      if (
        GRAPHICS_LOSSY
          ? graphicsTypingSampleComplete(pairs)
          : pairs.length === GRAPHICS_TYPING_CLEAN_PAIRS
      ) {
        return;
      }
    }
    // A voided batch's pairs and a missed quad's are spent like any other: the
    // run replaces them, and reaches its sample inside one cap or not at all.
    const voidedPairs = voided.reduce((sum, batch) => sum + batch.pairs.length, 0);
    const missedPairs = missedQuads.reduce((sum, quad) => sum + quad.pairs.length, 0);
    if (pairs.length + voidedPairs + missedPairs >= GRAPHICS_TYPING_MAX_PAIRS) {
      throw new Error(
        `graphics typing is inconclusive: ${pairs.length} valid pairs, ${voidedPairs} voided and ` +
          `${missedPairs} in quads a missed overlap took out, without ` +
          (GRAPHICS_LOSSY
            ? `|U| ≥ ${GRAPHICS_TYPING_U_PAIRS} and |L| ≥ ${GRAPHICS_TYPING_L_PAIRS}`
            : `${GRAPHICS_TYPING_CLEAN_PAIRS} valid pairs`),
      );
    }
  }
}

function graphicsTypingSampleComplete(
  pairs: readonly { readonly stratum: GraphicsTypingStratum | null }[],
) {
  let unmatched = 0;
  let lossy = 0;
  for (const pair of pairs) {
    if (pair.stratum === 'U') unmatched += 1;
    else if (pair.stratum === 'L') lossy += 1;
  }
  return unmatched >= GRAPHICS_TYPING_U_PAIRS && lossy >= GRAPHICS_TYPING_L_PAIRS;
}

async function runGraphicsTypingBatch(
  context: GraphicsTypingContext,
  plan: {
    readonly batch: number;
    readonly firstPair: number;
    readonly plannedPairs: number;
    readonly validPairs: readonly GraphicsTypingPairRecord[];
    readonly firstOrdinal: number;
  },
): Promise<{
  readonly voided: GraphicsVoidedBatch | null;
  readonly pairs: readonly GraphicsTypingPairRecord[];
  readonly missedQuads: readonly GraphicsMissedQuad[];
  readonly nextOrdinal: number;
}> {
  const { page, output, terminalPerf } = context;
  const { batch } = plan;
  await page.keyboard.type('U');
  await expectExactMarker(output, `BATCH-${batch}-READY`, 90_000);
  await terminalPerf.settlePresentation();
  await terminalPerf.reset();
  const proxyAtStart = await requestProxySettleStatus();
  const members: GraphicsTypingMember[] = [];
  const pairsRun: { readonly pair: number; readonly order: readonly GraphicsArm[] }[] = [];
  let ordinal = plan.firstOrdinal;
  let failure: unknown = null;
  let snapshot: TerminalPerfSnapshot | null = null;
  try {
    for (let offset = 0; offset < plan.plannedPairs; offset += 1) {
      const pair = plan.firstPair + offset;
      const order = GRAPHICS_PAIR_ORDERS[pair % 4] ?? GRAPHICS_PAIR_ORDERS[0];
      for (const arm of order) {
        members.push(await runGraphicsTypingMember(context, arm, pair, ordinal));
        ordinal += 1;
      }
      pairsRun.push({ pair, order });
      // After each complete quad, the stopping rule reads only control drops and holds.
      if (GRAPHICS_LOSSY && pairsRun.length % 4 === 0) {
        const strata = [
          ...plan.validPairs,
          ...pairsRun.map(({ pair: index }) => ({
            stratum: graphicsTypingStratum(graphicsMember(members, index, 'C')),
          })),
        ];
        if (graphicsTypingSampleComplete(strata) || strata.length >= GRAPHICS_TYPING_MAX_PAIRS) {
          break;
        }
      }
    }
    snapshot = await waitForTelemetry(terminalPerf, members.length, [], false);
  } catch (error) {
    failure = error;
  }

  // A failed member can leave a tile job that never retires, and the settled
  // snapshot waits for none to be open. A failure settles first: every job that
  // does retire, such as an interrupted one that resumes, is then in the trace,
  // and a job that never retires ends the settle at its liveness bound. Either
  // way the trace is read as it stands.
  const traceSettled =
    snapshot !== null ||
    (await terminalPerf.settlePresentation().then(
      () => true,
      () => false,
    ));
  const events =
    snapshot?.events ??
    (await terminalPerf.unsettledEvents().then(
      (value) => value,
      () => null,
    ));
  const carrierPhases = (events ?? [])
    .filter(
      (event): event is Extract<TerminalPerfEvent, { kind: 'carrier_recovery' }> =>
        event.kind === 'carrier_recovery' && GRAPHICS_VOIDING_CARRIER_PHASES.has(event.phase),
    )
    .map((event) => ({ atMs: event.atMs, phase: event.phase }));
  const dataLaneRecoveries = graphicsDataLaneRecoveries(events ?? []).recovered;
  const voidReason: GraphicsVoidReason | null =
    carrierPhases.length > 0 ? 'carrier' : dataLaneRecoveries.length > 0 ? 'data-lane' : null;
  if (voidReason !== null) {
    // The whole batch counts toward nothing; its artifacts stay, marked void. A
    // data lane's retirement is a transport event like a carrier change; its
    // exact record is a tile job's own interruption and resume. The void takes
    // the batch out of the sample, not out of the run: a lost session, a proxy
    // queue drop, and beside a data-lane void any failure phase it does not
    // explain, still fail it, and a member failure stays on record.
    const proxyAtEnd = await requestProxySettleStatus();
    const errors = voidedBatchErrors(events ?? [], voidReason, proxyAtStart, proxyAtEnd);
    const error = failure === null ? null : formatGraphicsError(failure);
    await writeGraphicsTypingBatch(context, batch, events ?? [], {
      batch,
      void: true,
      reason: voidReason,
      carrierPhases,
      dataLaneRecoveries,
      traceSettled,
      errors,
      proxyHarnessDrops: {
        start: proxyAtStart?.harnessDrops ?? null,
        end: proxyAtEnd?.harnessDrops ?? null,
      },
      error,
      failedMember: failure instanceof GraphicsMemberFailure ? failure.evidence : null,
      members,
    });
    expect(errors, `graphics typing voided batch ${batch} validity`).toEqual([]);
    await deleteGraphicsTypingBatch(context, batch);
    return {
      voided: {
        batch,
        pairs: pairsRun.map(({ pair }) => pair),
        reason: voidReason,
        carrierPhases,
        dataLaneRecoveries,
        error,
      },
      pairs: [],
      missedQuads: [],
      nextOrdinal: ordinal,
    };
  }
  if (failure !== null || snapshot === null) {
    await writeGraphicsTypingBatch(context, batch, events ?? [], {
      batch,
      void: false,
      traceSettled,
      error: formatGraphicsError(failure),
      failedMember: failure instanceof GraphicsMemberFailure ? failure.evidence : null,
      members,
    });
    throw failure;
  }

  const errors: string[] = [];
  const missed: GraphicsMissedOverlap[] = [];
  const records = observeGraphicsTypingBatch(snapshot, batch, members, pairsRun, errors, missed);
  const { valid, missedQuads } = withoutMissedQuads(batch, records, missed);
  const proxyAtEnd = await requestProxySettleStatus();
  errors.push(...proxyHarnessDropErrors(proxyAtStart, proxyAtEnd));
  await writeGraphicsTypingBatch(context, batch, snapshot.events, {
    batch,
    void: false,
    profile: PROFILE_NAME,
    arms: GRAPHICS_TYPING_A_A ? 'A/A' : 'A/B',
    frameBudgetMs: context.frameBudgetMs,
    errors,
    missedQuads,
    proxyHarnessDrops: {
      start: proxyAtStart?.harnessDrops ?? null,
      end: proxyAtEnd?.harnessDrops ?? null,
    },
    members,
    pairs: records,
    report: snapshot.report,
  });
  expect(errors, `graphics typing batch ${batch} validity`).toEqual([]);
  assertExactIsolatedCompletion(snapshot.report, members.length);
  expect(snapshot.report.presentation.rowsPerMeasurementWindow.max).toBe(1);
  await assertTransportStable(page, snapshot);
  await deleteGraphicsTypingBatch(context, batch);
  return { voided: null, pairs: valid, missedQuads, nextOrdinal: ordinal };
}

/**
 * One member: arm `arm` of pair `pair`. Both members of a pair run the same
 * trigger → display → request sequence under the same two trace keys; they
 * differ only in transfer size.
 */
async function runGraphicsTypingMember(
  { page, terminalPerf }: GraphicsTypingContext,
  arm: GraphicsArm,
  pair: number,
  ordinal: number,
): Promise<GraphicsTypingMember> {
  const armingKey = 2 * pair + 1;
  const timedKey = 2 * pair + 2;
  // The precondition is the previous end settle or the batch reset: the full
  // quiet oracle, which includes no open tile job.
  const armAtMs = await page.evaluate(() => performance.timeOrigin + performance.now());
  const assetsBefore = (await readBrowserDrainStatus(page)).activity.graphicsAsset;
  const armingMark = await markProxyTrace(armingKey);
  await page.keyboard.type(arm);
  // The image member's key rides its remaining transfer; the control's tiny
  // tile is uploaded before its key, so its window holds no asset work. The
  // window opens in the page task that sees the transition: a clean 2 MiB
  // transfer lasts about 20 ms, which one more harness round trip can use up.
  // The same task's last drain read is the timed input's baseline.
  let measurementId: number;
  try {
    measurementId = await terminalPerf.beginPresentationMeasurement('isolated-interactive', {
      afterGraphicsAsset: graphicsArmIsControl(arm)
        ? {
            phase: 'consumed',
            atLeast: assetsBefore.consumed + 1,
            failedBaseline: assetsBefore.failed,
          }
        : {
            phase: GRAPHICS_TYPING.timedAfter.phase,
            atLeast:
              assetsBefore[GRAPHICS_TYPING.timedAfter.phase] + GRAPHICS_TYPING.timedAfter.count,
            failedBaseline: assetsBefore.failed,
          },
      timedInput: true,
    });
  } catch (error) {
    // No timed mark followed, so every relay's ledger counts since the arming
    // mark: what each connection carried while the transition never came.
    throw new GraphicsMemberFailure(error, {
      arm,
      pair,
      armingKey,
      armAtMs,
      assetsBefore,
      armingMark,
      failedAtMs: await page.evaluate(() => performance.timeOrigin + performance.now()),
      assetsAtFailure: await readBrowserDrainStatus(page).then(
        (status) => status.activity.graphicsAsset,
        (readError: unknown) => formatGraphicsError(readError),
      ),
      ledgerSinceArming: await requestProxySettleStatus().catch((readError: unknown) =>
        formatGraphicsError(readError),
      ),
    });
  }
  // Before the timed key, so its ledger covers the key's whole round trip.
  const timedMark = await markProxyTrace(timedKey);
  await page.keyboard.type(String.fromCharCode(97 + (ordinal % 26)));
  // The settle closes the ledger at the first poll that sees the key's ACK and
  // authoritative fence; nothing decided after that can reach the sample.
  let close: TimedInputClose | null;
  try {
    close = await terminalPerf.endPresentationMeasurement(
      measurementId,
      GRAPHICS_SETTLE_TIMEOUT_MS,
    );
  } catch (error) {
    throw new GraphicsMemberFailure(error, {
      arm,
      pair,
      timedKey,
      armAtMs,
      timedMark,
      failedAtMs: await page.evaluate(() => performance.timeOrigin + performance.now()),
      activityAtFailure: await readBrowserDrainStatus(page).then(
        (status) => status.activity,
        (readError: unknown) => formatGraphicsError(readError),
      ),
      ledgerSinceTimedMark: await requestProxySettleStatus().catch((readError: unknown) =>
        formatGraphicsError(readError),
      ),
    });
  }
  if (close === null) throw new Error(`pair ${pair} ${arm}: its timed window returned no close`);
  const ledger = await requestProxySettleStatus();
  // Each relay's use of the links since the timed mark, read once the member
  // has settled: where its packets queued, and how much each relay carried.
  const links = EDGE_BOTTLENECK === null ? null : await requestProxyStats();
  return {
    arm,
    pair,
    armingKey,
    timedKey,
    measurementId,
    armAtMs,
    assetsBefore,
    armingMark,
    timedMark,
    closedInput: close.input,
    closedLedger: close.proxyStatus,
    ledger,
    links: links === null ? null : { links: links.links, relays: links.relayLinks },
  };
}

/** In the A/A run both arms are controls; otherwise only `C` is. */
function graphicsArmIsControl(arm: GraphicsArm): boolean {
  return arm === 'C' || GRAPHICS_TYPING_A_A;
}

/**
 * The direct path's two proxy hops, carrying the profile's delay and its
 * declared links, before the page dials: the transport worker's direct dial is
 * redirected to the outer hop.
 */
async function startGraphicsDirectProxy(
  page: Page,
  backendPort: number,
): Promise<DirectNetworkProxy> {
  const profile = process.env.EDGE_NETWORK_PROFILE;
  if (profile !== 'fast' && profile !== 'typical' && profile !== 'difficult') {
    throw new Error('a direct bottleneck run needs EDGE_NETWORK_PROFILE');
  }
  if (page.context().browser()?.browserType().name() === 'chromium') {
    await page.context().grantPermissions(['local-network-access'], {
      origin: new URL(page.url()).origin,
    });
  }
  return startDirectNetworkProxy(
    page.context(),
    backendPort,
    profile,
    Number(process.env.EDGE_NETWORK_SEED ?? 0),
    EDGE_LINKS,
  );
}

function graphicsTypingSize(value: string | undefined): keyof typeof GRAPHICS_TYPING_SIZES {
  if (value === undefined) return GRAPHICS_LOSSY ? '256KiB' : '2MiB';
  if (value === '256KiB' || value === '2MiB' || value === '16MiB') return value;
  throw new Error(
    `GRAPHICS_TYPING_BYTES must be unset, 256KiB, 2MiB or 16MiB, not ${JSON.stringify(value)}`,
  );
}

function graphicsTypingAA(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`GRAPHICS_TYPING_A_A must be unset or 1, not ${JSON.stringify(value)}`);
}

function graphicsMember(
  members: readonly GraphicsTypingMember[],
  pair: number,
  arm: GraphicsArm,
): GraphicsTypingMember {
  const member = members.find((candidate) => candidate.pair === pair && candidate.arm === arm);
  if (member === undefined) throw new Error(`pair ${pair} has no ${arm} member`);
  return member;
}

/**
 * The hard §5 checks for one batch. Violations are collected, never excluded.
 * A missed overlap is not one of them: it is collected in `missed`, and its
 * quad leaves the sample (`withoutMissedQuads`).
 */
function observeGraphicsTypingBatch(
  { events, report }: TerminalPerfSnapshot,
  batch: number,
  members: readonly GraphicsTypingMember[],
  pairsRun: readonly { readonly pair: number; readonly order: readonly GraphicsArm[] }[],
  errors: string[],
  missed: GraphicsMissedOverlap[],
): GraphicsTypingPairRecord[] {
  const assets = events.filter(
    (event): event is GraphicsAssetEvent => event.kind === 'graphics_asset',
  );
  for (const event of assets) {
    if (event.failed || !(GRAPHICS_SUCCESS_PHASES as readonly string[]).includes(event.phase)) {
      errors.push(`batch ${batch}: tile job ${event.jobId} ${event.phase} at ${event.atMs}`);
    }
  }
  const records: GraphicsTypingPairRecord[] = [];
  // Members run one after another, so each owns the daemon's egress snapshots
  // from its own arm up to the next member's.
  const nextArmAtMs = (member: GraphicsTypingMember) =>
    members.reduce(
      (next, candidate) =>
        candidate.armAtMs > member.armAtMs && candidate.armAtMs < next ? candidate.armAtMs : next,
      Number.POSITIVE_INFINITY,
    );
  for (const { pair, order } of pairsRun) {
    const control = graphicsMember(members, pair, 'C');
    const image = graphicsMember(members, pair, 'I');
    const controlObservation = observeGraphicsTypingMember(
      events,
      assets,
      report,
      control,
      GRAPHICS_CONTROL_TILES,
      nextArmAtMs(control),
      errors,
    );
    const imageObservation = observeGraphicsTypingMember(
      events,
      assets,
      report,
      image,
      GRAPHICS_IMAGE_ARM.tiles,
      nextArmAtMs(image),
      errors,
    );
    if (controlObservation === null || imageObservation === null) continue;
    const stratum = graphicsTypingStratum(control);
    // Every image input must leave inside its transfer, and the pairs C1 reads
    // must overlap it by more than an echo. Overlap is judged against the twin
    // control's echo, never the image member's own: a repair it caused cannot
    // make the pair look non-overlapping. The A/A run has no transfer to overlap.
    if (!GRAPHICS_TYPING_A_A) {
      const remainingTransferMs =
        (imageObservation.maxFinAtMs ?? Number.NEGATIVE_INFINITY) - imageObservation.inputSentAtMs;
      const controlEchoMs =
        controlObservation.displayReceivedAtMs - controlObservation.inputSentAtMs;
      const overlapMs = stratum === 'U' || stratum === null ? controlEchoMs : 0;
      if (!(remainingTransferMs > overlapMs)) {
        missed.push({ pair, remainingTransferMs, controlEchoMs });
      }
    }
    records.push({
      pair,
      batch,
      order,
      stratum,
      control: { ...control, observation: controlObservation },
      image: { ...image, observation: imageObservation },
      relays: graphicsRelayDiagnostics(control, image),
    });
  }
  return records;
}

function observeGraphicsTypingMember(
  events: readonly TerminalPerfEvent[],
  assets: readonly GraphicsAssetEvent[],
  report: TerminalLatencyReport,
  member: GraphicsTypingMember,
  tiles: number,
  nextArmAtMs: number,
  errors: string[],
): GraphicsMemberObservation | null {
  const label = `pair ${member.pair} ${member.arm === 'C' ? 'control' : 'image'}`;
  let startAtMs = Number.NaN;
  let endAtMs = Number.NaN;
  for (const event of events) {
    if (
      event.kind === 'presentation_measurement_boundary' &&
      event.measurementId === member.measurementId
    ) {
      if (event.phase === 'start') startAtMs = event.atMs;
      else endAtMs = event.atMs;
    }
  }
  if (!Number.isFinite(startAtMs) || !Number.isFinite(endAtMs)) {
    errors.push(`${label}: its measurement window has no boundaries`);
    return null;
  }
  // The single input inside the window is the timed one; arming inputs fall
  // outside every window.
  const inputs = events.filter(
    (event): event is InputQueuedEvent =>
      event.kind === 'input_queued' && event.atMs >= startAtMs && event.atMs <= endAtMs,
  );
  const input = inputs[0];
  if (inputs.length !== 1 || input === undefined) {
    errors.push(`${label}: ${inputs.length} inputs in its window`);
    return null;
  }
  const sample = report.samples.find((candidate) => candidate.inputSeq === input.inputSeq);
  const sent = events.find(
    (event) => event.kind === 'input_sent' && event.inputSeq === input.inputSeq,
  );
  const completed = sample?.inputToCompletedAuthoritativePresentationFenceMs ?? null;
  const ack = sample?.inputAckMs ?? null;
  const receive = sample?.inputToDisplayReceiveMs ?? null;
  if (sent === undefined || completed === null || ack === null || receive === null) {
    errors.push(`${label}: input ${input.inputSeq} has a censored sample`);
    return null;
  }
  // The ledger that defines the stratum closed where this very sample completed.
  errors.push(
    ...graphicsTimedCloseErrors(label, member, input, {
      inputAckMs: ack,
      inputToCompletedAuthoritativePresentationFenceMs: completed,
    }),
  );

  const own = assets.filter((event) => event.atMs >= member.armAtMs && event.atMs <= endAtMs);
  const jobs = new Map<number, GraphicsAssetEvent[]>();
  for (const event of own) {
    const job = jobs.get(event.jobId) ?? [];
    job.push(event);
    jobs.set(event.jobId, job);
  }
  if (jobs.size !== tiles) errors.push(`${label}: ${jobs.size} tile jobs, expected ${tiles}`);
  for (const [jobId, job] of jobs) {
    for (const phase of GRAPHICS_SUCCESS_PHASES) {
      const count = job.filter((event) => event.phase === phase && !event.failed).length;
      if (count !== 1) errors.push(`${label}: tile job ${jobId} saw ${phase} ${count} times`);
    }
    if (job.length !== GRAPHICS_SUCCESS_PHASES.length) {
      errors.push(`${label}: tile job ${jobId} made ${job.length} transitions`);
    }
  }
  let firstByteAtMs: number | null = null;
  let maxFinAtMs: number | null = null;
  for (const event of own) {
    if (event.phase === 'first_byte')
      firstByteAtMs = Math.min(firstByteAtMs ?? event.atMs, event.atMs);
    if (event.phase === 'fin') maxFinAtMs = Math.max(maxFinAtMs ?? event.atMs, event.atMs);
  }
  if (graphicsArmIsControl(member.arm)) {
    if (own.some((event) => event.atMs >= sent.atMs)) {
      errors.push(`${label}: its tile job was still moving when the timed input was sent`);
    }
    if (assets.some((event) => event.atMs >= sent.atMs && event.atMs <= endAtMs)) {
      errors.push(`${label}: asset work fell inside its timed window`);
    }
  } else if (firstByteAtMs === null || maxFinAtMs === null || !(firstByteAtMs < sent.atMs)) {
    // An input that left after the last FIN is a missed overlap, which the
    // batch takes out with its quad; one before the first byte is a member
    // that never waited for its transfer.
    errors.push(
      `${label}: the timed input at ${sent.atMs} did not follow the first byte ${firstByteAtMs} of a transfer whose last FIN was ${maxFinAtMs}`,
    );
  }
  return {
    inputSeq: input.inputSeq,
    inputQueuedAtMs: input.atMs,
    inputSentAtMs: sent.atMs,
    displayReceivedAtMs: input.atMs + receive,
    windowEndAtMs: endAtMs,
    metrics: {
      inputToCompletedAuthoritativePresentationFenceMs: completed,
      inputAckMs: ack,
    },
    jobIds: [...jobs.keys()],
    firstByteAtMs,
    maxFinAtMs,
    dialStarted: events.filter(
      (event) =>
        event.kind === 'carrier_recovery' &&
        event.phase === 'dial_started' &&
        event.atMs >= member.armAtMs &&
        event.atMs <= endAtMs,
    ).length,
    daemon: graphicsDaemonTerms(events, input.inputSeq),
    egress: graphicsEgressBetween(events, member.armAtMs, nextArmAtMs),
  };
}

/**
 * Relays active in the control window, at its close and after its settle, and
 * how the image member saw them. The closed counts are what a relay could lose
 * before the control's sample completed.
 */
function graphicsRelayDiagnostics(
  control: GraphicsTypingMember,
  image: GraphicsTypingMember,
): GraphicsRelayDiagnostic[] | null {
  const settled = control.ledger;
  const imageLedger = image.ledger;
  if (settled === null || imageLedger === null) return null;
  const closedRelays = control.closedLedger?.relays ?? [];
  const pendingAt = (status: ProxySettleStatus | null, admissionSeq: number): number | null =>
    status?.relays.find((relay) => relay.admissionSeq === admissionSeq)?.pending ?? null;
  const active = new Set(
    [...closedRelays, ...settled.relays]
      .filter((relay) => relay.upSeen + relay.downSeen > 0)
      .map((relay) => relay.admissionSeq),
  );
  return [...active]
    .sort((left, right) => left - right)
    .map((admissionSeq) => {
      const closedRelay = closedRelays.find((relay) => relay.admissionSeq === admissionSeq);
      const settledRelay = settled.relays.find((relay) => relay.admissionSeq === admissionSeq);
      const imageRelay = imageLedger.relays.find(
        (candidate) => candidate.admissionSeq === admissionSeq,
      );
      return {
        admissionSeq,
        controlClosedDownSeen: closedRelay?.downSeen ?? null,
        controlClosedDownDropped: closedRelay?.downDropped ?? null,
        controlDownSeen: settledRelay?.downSeen ?? null,
        imageMinusControlDownSeen:
          imageRelay === undefined || settledRelay === undefined
            ? null
            : imageRelay.downSeen - settledRelay.downSeen,
        controlDownDropped: settledRelay?.downDropped ?? null,
        imageDownDropped: imageRelay?.downDropped ?? null,
        controlMaxInFlight:
          settledRelay === undefined
            ? null
            : { up: settledRelay.upMaxInFlight, down: settledRelay.downMaxInFlight },
        pending: {
          control: {
            arming: pendingAt(control.armingMark, admissionSeq),
            timed: pendingAt(control.timedMark, admissionSeq),
          },
          image: {
            arming: pendingAt(image.armingMark, admissionSeq),
            timed: pendingAt(image.timedMark, admissionSeq),
          },
        },
      };
    });
}

async function deleteGraphicsTypingBatch(
  { page, output, terminalPerf }: GraphicsTypingContext,
  batch: number,
): Promise<void> {
  await page.keyboard.type('D');
  await expectExactMarker(output, `BATCH-${batch}-DELETED`, LIMITS.markerTimeoutMs);
  await terminalPerf.settlePresentation();
}

async function writeGraphicsTypingBatch(
  { testInfo }: GraphicsTypingContext,
  batch: number,
  events: readonly TerminalPerfEvent[],
  artifact: Record<string, unknown>,
): Promise<void> {
  const name = `graphics-typing-batch-${batch}`;
  const path = testInfo.outputPath(`${name}.json`);
  const eventsPath = testInfo.outputPath(`${name}-events.json.gz`);
  await writeFile(path, JSON.stringify(artifact));
  await writeGzipJsonArray(eventsPath, events);
  await testInfo.attach(name, { path, contentType: 'application/json' });
  await testInfo.attach(`${name}-events`, { path: eventsPath, contentType: 'application/gzip' });
}

/**
 * Computes C1/C2 over the valid pairs and writes the paired artifact. A run that
 * failed (`failure` set) still records them, as diagnostics only.
 */
async function writeGraphicsTypingPaired(
  { testInfo, frameBudgetMs }: GraphicsTypingContext,
  pairs: readonly GraphicsTypingPairRecord[],
  { voided, missedQuads }: GraphicsSpentPairs,
  failure: string | null,
): Promise<{
  readonly c1: Partial<Record<GraphicsTypingMetric, ReturnType<typeof pairedTail>>>;
  readonly c2: Partial<Record<GraphicsTypingMetric, ReturnType<typeof signTestMedianUpper>>>;
}> {
  const unmatched = GRAPHICS_LOSSY ? pairs.filter((pair) => pair.stratum === 'U') : pairs;
  const lossy = GRAPHICS_LOSSY ? pairs.filter((pair) => pair.stratum === 'L') : [];
  const c1: Partial<Record<GraphicsTypingMetric, ReturnType<typeof pairedTail>>> = {};
  const c2: Partial<Record<GraphicsTypingMetric, ReturnType<typeof signTestMedianUpper>>> = {};
  const statisticErrors: string[] = [];
  for (const metric of GRAPHICS_TYPING_METRICS) {
    try {
      c1[metric] = pairedTail(
        unmatched.map((pair) => pair.control.observation.metrics[metric]),
        unmatched.map((pair) => pair.image.observation.metrics[metric]),
      );
    } catch (error) {
      statisticErrors.push(`C1 ${metric}: ${formatGraphicsError(error)}`);
    }
    if (!GRAPHICS_LOSSY) continue;
    try {
      c2[metric] = signTestMedianUpper(
        lossy.map(
          (pair) =>
            pair.image.observation.metrics[metric] - pair.control.observation.metrics[metric],
        ),
      );
    } catch (error) {
      statisticErrors.push(`C2 ${metric}: ${formatGraphicsError(error)}`);
    }
  }
  const path = testInfo.outputPath('graphics-typing-paired.json');
  await writeFile(
    path,
    JSON.stringify({
      outcome: failure === null ? 'complete' : 'failed',
      failure,
      arms: GRAPHICS_TYPING_A_A ? 'A/A' : 'A/B',
      profile: PROFILE_NAME,
      scenario: process.env.EDGE_NETWORK_SCENARIO ?? 'steady',
      reorder: process.env.EDGE_NETWORK_REORDER ?? 'none',
      forceEdge: process.env.FORCE_EDGE ?? '1',
      geometry: GRAPHICS_TYPING,
      imageArm: GRAPHICS_IMAGE_ARM,
      frameBudgetMs,
      bottleneck: EDGE_BOTTLENECK,
      links: EDGE_LINKS,
      sampleSizeRule: GRAPHICS_LOSSY
        ? {
            uPairs: GRAPHICS_TYPING_U_PAIRS,
            lPairs: GRAPHICS_TYPING_L_PAIRS,
            maxPairs: GRAPHICS_TYPING_MAX_PAIRS,
          }
        : { pairs: GRAPHICS_TYPING_CLEAN_PAIRS },
      strata: GRAPHICS_LOSSY
        ? {
            U: unmatched.length,
            L: lossy.length,
            R: pairs.filter((pair) => pair.stratum === 'R').length,
          }
        : null,
      // Downstream packets every relay carried since the control's timed mark:
      // at its close, which defines the stratum, and after its settle.
      controlDownSeen: GRAPHICS_LOSSY
        ? {
            closed: graphicsCountSummary(
              pairs.map((pair) => pair.control.closedLedger?.sinceMark.downSeen ?? null),
            ),
            settled: graphicsCountSummary(
              pairs.map((pair) => pair.control.ledger?.sinceMark.downSeen ?? null),
            ),
          }
        : null,
      c1,
      c2: GRAPHICS_LOSSY ? c2 : null,
      // Diagnostics only: where the added ACK time was spent, per hop.
      contention: graphicsContentionAttribution(
        unmatched.map((pair) => ({
          control: contentionMember(pair.control.observation),
          image: contentionMember(pair.image.observation),
        })),
      ),
      statisticErrors,
      voidedBatches: voided,
      missedQuads,
      pairs,
    }),
  );
  await testInfo.attach('graphics-typing-paired', { path, contentType: 'application/json' });
  return { c1, c2 };
}

function contentionMember(observation: GraphicsMemberObservation) {
  return {
    inputAckMs: observation.metrics.inputAckMs,
    fenceMs: observation.metrics.inputToCompletedAuthoritativePresentationFenceMs,
    daemon: observation.daemon,
    egress: observation.egress,
  };
}

/** Median and p95 by the paired-tail rank, `sorted[ceil(q·n) − 1]`, over the counts present. */
function graphicsCountSummary(values: readonly (number | null)[]): {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
} {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  const rank = (quantile: number): number | null =>
    sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? null;
  return { count: sorted.length, p50: rank(0.5), p95: rank(0.95), max: sorted.at(-1) ?? null };
}

function formatGraphicsError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/** A member whose window never opened or never closed, with what moved while it waited. */
class GraphicsMemberFailure extends Error {
  constructor(
    cause: unknown,
    readonly evidence: Readonly<Record<string, unknown>>,
  ) {
    super(
      `graphics typing pair ${String(evidence.pair)} ${String(evidence.arm)}: ${formatGraphicsError(cause)}`,
      { cause },
    );
  }
}
