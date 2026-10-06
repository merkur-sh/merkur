import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import type { ConsoleMessage, Page, TestInfo } from '@playwright/test';
import {
  MAIN_THREAD_FRAME_BUDGET_TOLERANCE_MS,
  type TerminalLatencyPercentiles,
  type TerminalLatencyRawMetricSamples,
  type TerminalPerfEvent,
} from '../../apps/web/src/perf/terminal-latency';
import {
  collectWorkerCanvasCalls,
  parseExactChromeTrace,
} from '../../scripts/analyze-terminal-gpu-trace';
import {
  EDGE_NETWORK_PROFILES,
  type EdgeNetworkProfileName,
} from '../../scripts/edge-network-profile';
import type { ProxyImpairmentStats } from '../../scripts/edge-network-stats';
import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';
import { attachDirectArtifact } from './fixtures/direct-artifacts';
import {
  createDirectTraceWorkerClock,
  DIRECT_GPU_TRACE_CATEGORIES,
  markDirectTraceClock,
  startDirectCdpTrace,
  validateDirectTraceClockCoverage,
} from './fixtures/direct-cdp-trace';
import {
  compareDirectFrameControls,
  compareDirectRefreshPeriods,
  DIRECT_FRAME_CONTROL_MIN_INTERVALS,
  type DirectFrameControlPopulation,
  type DirectFrameControlPosition,
  type DirectFramePhasePopulation,
  type DirectRefreshPeriodCalibration,
} from './fixtures/direct-frame-control';
import {
  type DirectNeovimTransactionPopulation,
  summarizeDirectNeovimTransactions,
  validateDirectNeovimSteadyTransactions,
} from './fixtures/direct-neovim-transactions';
import {
  DIRECT_PROXY_DIAL_MARKER,
  type DirectNetworkProxy,
  startDirectNetworkProxy,
} from './fixtures/direct-network-proxy';
import {
  buildDirectRedrawLoopCommand,
  type DirectRedrawCoverage,
  directRedrawReadyMarker,
  summarizeDirectRedrawCoverage,
} from './fixtures/direct-redraw-coverage';
import {
  combineDirectRedrawObservationSegments,
  DIRECT_REDRAW_OBSERVATION_SEGMENT_SIZE,
  type DirectRedrawObservationSegment,
  type DirectRedrawSegmentHopCounters,
  type DirectSegmentedRedrawEvidence,
  directRedrawCumulativeHopDeltas,
  summarizeDirectSegmentedRedrawFramePhase,
} from './fixtures/direct-segmented-redraw';
import {
  beginDirectTuiActivationObservation,
  buildNeovimNavigationWorkload,
  buildTmuxSwitchWorkload,
  cleanupDirectTuiWorkload,
  type DirectCoherentInputPopulation,
  type DirectTuiApplication,
  type DirectTuiExternalToolsEvidence,
  type DirectTuiWorkloadPlan,
  findDirectTuiActivationFence,
  matchDirectTuiViewport,
  readDirectTuiViewportSnapshot,
  resolveRequiredDirectTuiTools,
  summarizeDirectCoherentInputWindows,
  validateDirectTuiActivationMeasurementBoundary,
  waitForDirectTuiViewportMarker,
} from './fixtures/direct-tui-workloads';
import { summarizeDirectTypingCadence } from './fixtures/direct-typing-cadence';
import {
  DIRECT_TYPING_INPUT_COUNT,
  DIRECT_TYPING_INPUTS_PER_CLASS,
  DIRECT_TYPING_ORDINAL_PATTERN,
  type DirectTypingParentCompleteness,
  type DirectTypingPopulationSummary,
  summarizeDirectTypingPopulations,
} from './fixtures/direct-typing-populations';
import {
  DIRECT_TYPING_WORKLOADS,
  type DirectDiagnosticWorkload,
  directIrregularTypingSteps,
  directTypingGpuTraceEnabled,
  directWorkloadSelection,
} from './fixtures/direct-workload-plan';
import { summarizeDisplayIngressRoutes } from './fixtures/display-ingress-routes';
import { resolveNativeBrowserSessionBinding } from './fixtures/native-display-boundaries';
import {
  collectApplicationDisplayOutcome,
  validateApplicationDisplayOutcomeEvidence,
  validateRecorderMetadata,
} from './fixtures/terminal-perf-artifacts';
import { verifyRawTerminalPerfTrace } from './fixtures/terminal-perf-replay';
import { referenceDistribution } from './fixtures/terminal-redraw-reference';
import type { TerminalPerfFixture, TerminalPerfSnapshot } from './fixtures/test';
import { readWebGpuIdentity } from './fixtures/webgpu-identity';

const PROFILE = directProfile();
const SEED = integerEnvironment('DIRECT_NETWORK_SEED', 1296388675, 0xffff_ffff);
const REDRAW_SAMPLES = integerEnvironment('DIRECT_REDRAW_SAMPLES', 100, 500);
const WORKLOAD_SELECTION = directWorkloadSelection(process.env.DIRECT_DIAGNOSTIC_WORKLOAD);
const DIRECT_GPU_TRACE = process.env.DIRECT_GPU_TRACE === '1';
const MAIN_THREAD_IDLE_CONTROL_MS = 4_000;
const MAIN_THREAD_KEYBOARD_CONTROL_REPETITIONS = 2;
// Keep the control actively injecting keys for roughly the same four seconds
// as the idle control. An unpaced burst completes in about half a second and
// cannot support the predeclared >=200-interval p99 population.
const MAIN_THREAD_KEYBOARD_CONTROL_CADENCE_MS = 8;
const DIRECT_VIEWPORT_MARKER_TIMEOUT_MS = 5_000;
const DIRECT_VIEWPORT_MARKER_POLL_MS = 25;
type DirectWorkload =
  | {
      kind: 'typing';
      cadenceMs: number;
      pattern: 'regular' | 'irregular';
      delayPatternMs: readonly number[];
      printableInputs: number;
      deletionInputs: number;
    }
  | {
      kind: 'redraw';
      population: 'small-multirow' | 'bounded-cat';
      samples: number;
      driver: 'pre-staged-shell-redraw-trigger';
      inputBytesPerWindow: 1;
    }
  | {
      kind: 'tui';
      application: DirectTuiApplication;
      operation: 'window-switch' | 'page-navigation';
      samples: number;
      inputBytesPerOperation: 1;
      viewportOracle: {
        readonly initialNeedle: string;
        readonly completedCycleNeedle: string;
        readonly operationCycleLength: number;
      };
    };

interface DirectMainThreadControl {
  readonly kind: 'idle' | 'keyboard-injection';
  readonly position: DirectFrameControlPosition;
  readonly activePatternRepetitions: number;
  readonly activePatternCadenceMs: number | null;
  readonly browserName: string;
  readonly measurementId: number;
  readonly startAtMs: number | null;
  readonly endAtMs: number | null;
  readonly terminalInputCount: number;
  readonly keyboardEventCount: number;
  readonly inputEventCount: number;
  readonly finalValueLength: number;
  readonly refreshPeriodMs: number | null;
  readonly refreshPeriodSourceAtMs: number | null;
  readonly refreshPeriodConfidence01: number | null;
  /** Recorder snapshot completed before any iframe removal or terminal refocus. */
  readonly traceCapturedAtMs: number | null;
  readonly teardownStartedAtMs: number;
  readonly frameBudgetToleranceMs: number;
  readonly frameBudgetTolerancePeriodFraction: number | null;
  readonly startsCovered: boolean;
  readonly endsCovered: boolean;
  readonly rafGapMs: ReturnType<typeof referenceDistribution>;
  readonly frameBudgetOverrunMs: ReturnType<typeof referenceDistribution>;
  readonly estimatedMissedFrameCount: number;
  readonly estimatedMissedIntervalCount: number;
  readonly frameBudgetExceededIntervalCount: number;
  readonly longTaskObserverSupported: boolean | null;
  readonly longTaskCount: number;
  readonly captureErrors: readonly string[];
}

interface DirectDisplayPeriodCalibrationLink {
  readonly rawArtifact: 'direct-display-period-calibration-events.json.gz';
  readonly evidenceArtifact: 'direct-display-period-calibration.json';
  readonly rawSha256: string;
  readonly reportSha256: string;
  readonly eventCount: number;
  readonly sourceEvent: Extract<TerminalPerfEvent, { kind: 'render_start' }> | null;
  readonly recorderCapturedAtMs: number | null;
  readonly calibrationMeasurementId: number;
  readonly observationEpoch: number | null;
  readonly sessionEpoch: number | null;
  readonly workerIdentityFence: 'same-page-strict-viewport-reader-reference';
}

interface DirectDisplayPeriodCalibrationEvidence {
  readonly calibration: DirectRefreshPeriodCalibration | null;
  readonly link: DirectDisplayPeriodCalibrationLink;
  readonly errors: readonly string[];
}

type DirectCaptureMode =
  | { readonly kind: 'standalone' }
  | {
      readonly kind: 'redraw-segment';
      readonly segmentIndex: number;
      readonly firstSampleOrdinal: number;
    };

interface DirectCaptureResult {
  readonly segment: DirectRedrawObservationSegment | null;
  readonly attemptedSegment: DirectRedrawSegmentAttempt | null;
}

interface DirectRedrawSegmentAttempt {
  readonly segmentIndex: number;
  readonly firstSampleOrdinal: number;
  readonly sampleCount: number;
  readonly raw: {
    readonly artifact: string;
    readonly sha256: string;
  };
  readonly report: {
    readonly artifact: string;
    readonly sha256: string;
  };
  readonly replay: {
    readonly eventCount: number;
    readonly reportSha256: string;
    readonly applicationDisplayOutcomeSha256: string;
  } | null;
  readonly errors: readonly string[];
}

test.use({
  // Playwright trace/video record the entire run and can induce browser GPU
  // readback/screencast work. This benchmark retains its own lossless raw
  // telemetry and report attachments instead.
  trace: 'off',
  video: 'off',
  linkedDaemonContextOptions: {
    viewport: { width: 1600, height: 1000 },
    serviceWorkers: 'block',
  },
});
test.setTimeout(900_000);

/**
 * Regression test for felt lag on the DIRECT carrier. The edge emulator alone
 * cannot measure this: a loopback direct upgrade bypasses it. This test keeps
 * the real QUIC/TLS/Noise/native WebTransport and translates only its initial
 * loopback destination through two transparent UDP hops. The slower companion
 * edge remains live, including production Critical input racing.
 *
 * The zero-delay phase is an overload/catch-up test, not simulated human typing.
 * No trace dumps, worker-drain polls or network-control requests run per key.
 */
test('direct input cadences and fast redraws retain exact GPU-fence evidence', async ({
  browserName,
  page,
  linkedDaemon,
  terminalPerf,
}, testInfo) => {
  if (process.env.MERKUR_E2E_FINAL_TRANSPORT_CAPTURE !== '1') {
    throw new Error('Direct capture requires MERKUR_E2E_FINAL_TRANSPORT_CAPTURE=1');
  }
  if (
    DIRECT_GPU_TRACE &&
    (browserName !== 'chromium' ||
      (WORKLOAD_SELECTION.diagnosticWorkload !== 'typing' &&
        WORKLOAD_SELECTION.diagnosticWorkload !== 'tmux' &&
        WORKLOAD_SELECTION.diagnosticWorkload !== 'neovim'))
  ) {
    throw new Error(
      'GPU tracing requires a separate Chromium typing, tmux or Neovim diagnostic run',
    );
  }
  if (DIRECT_GPU_TRACE) {
    testInfo.annotations.push({
      type: 'diagnostic-only',
      description: 'Chrome tracing enabled; all timing populations excluded from acceptance',
    });
  }
  if (process.env.FORCE_EDGE !== '0') throw new Error('direct benchmark requires FORCE_EDGE=0');
  const companionRtt = Number(process.env.EDGE_NETWORK_TARGET_RTT_MS);
  const targetRtt = EDGE_NETWORK_PROFILES[PROFILE].targetRttMs;
  if (process.env.EDGE_NETWORK_ACTIVE !== '1' || !(companionRtt > targetRtt)) {
    throw new Error('direct benchmark requires an actively emulated, slower companion edge');
  }
  if (
    process.env.EDGE_NETWORK_COMPANION_RTT_MS !== undefined &&
    (process.env.EDGE_NETWORK_ROLE !== 'direct-companion' ||
      process.env.EDGE_NETWORK_COMPANION_PRIMARY_PROFILE !== PROFILE ||
      Number(process.env.EDGE_NETWORK_COMPANION_RTT_MS) !== companionRtt)
  ) {
    throw new Error('explicit Direct companion identity does not match the actual harness RTT');
  }
  const tuiTools = resolveRequiredDirectTuiTools();
  const sourceBefore = sourceProvenance(tuiTools);
  let browserSessionBinding:
    | (ReturnType<typeof resolveNativeBrowserSessionBinding> & {
        rawArtifact: string;
        rawSha256: string;
      })
    | null = null;
  const captureNativeTrace = async (name: string, requireLossless: boolean): Promise<void> => {
    const evidence = await linkedDaemon.capturePerfTrace();
    const { rawLog, ...metadata } = evidence;
    const rawArtifact = `direct-${name}-native-log.gz`;
    const raw = gzipSync(Buffer.from(rawLog));
    const recordCoverageEligible =
      evidence.status === 'complete' &&
      evidence.chunks.length > 0 &&
      browserSessionBinding !== null &&
      evidence.chunks.every((chunk) => chunk.session_id === browserSessionBinding?.sessionId) &&
      evidence.chunks.every((chunk) => chunk.dropped === 0);
    await attachDirectArtifact(testInfo, rawArtifact, {
      body: raw,
      contentType: 'application/gzip',
    });
    await attachDirectArtifact(testInfo, `direct-${name}-native.json`, {
      body: JSON.stringify({
        ...metadata,
        recordCoverageEligible,
        browserSessionBinding,
        source: sourceBefore,
        interpretation:
          'Cold bounded native recorder drain; record ordinals and exact identities own joins, not wall-clock proximity. Current-owner drops invalidate coverage; stale counts discarded previous-observation records and is informational.',
        raw: { artifact: rawArtifact, sha256: createHash('sha256').update(raw).digest('hex') },
      }),
      contentType: 'application/json',
    });
    if (evidence.status !== 'complete') {
      throw new Error(`${name}: native capture ${evidence.status}: ${evidence.errors.join('; ')}`);
    }
    if (requireLossless && !recordCoverageEligible) {
      throw new Error(
        `${name}: native record coverage is incomplete (current-owner drops or session mismatch)`,
      );
    }
  };
  const withNativeTrace = async (name: string, action: () => Promise<void>): Promise<void> => {
    await captureNativeTrace(`${name}-before`, false);
    let actionError: unknown = null;
    let captureError: unknown = null;
    try {
      await action();
    } catch (error) {
      actionError = error;
    }
    try {
      await captureNativeTrace(`${name}-after`, true);
    } catch (error) {
      captureError = error;
    }
    throwCombinedErrors(actionError, captureError);
  };
  if (WORKLOAD_SELECTION.diagnosticWorkload !== null) {
    testInfo.annotations.push({
      type: 'direct-diagnostic-scope',
      description: `${WORKLOAD_SELECTION.diagnosticWorkload}-only; not the complete Direct acceptance population`,
    });
  }
  // Chromium's Private Network Access gate needs the same origin-scoped
  // consent a person grants to a local terminal. Firefox does not impose that
  // Chromium permission gate on this local-to-loopback path; keep both
  // engines' normal access checks enabled instead of adding launch bypasses.
  if (browserName === 'chromium') {
    await page.context().grantPermissions(['local-network-access'], {
      origin: new URL(page.url()).origin,
    });
  }
  const dials: string[] = [];
  let excessiveDials = false;
  const observeDial = (message: ConsoleMessage): void => {
    if (!message.text().startsWith(DIRECT_PROXY_DIAL_MARKER)) return;
    if (dials.length >= 16) {
      excessiveDials = true;
      return;
    }
    dials.push(message.text());
  };
  page.on('console', observeDial);
  const proxy = await startDirectNetworkProxy(
    page.context(),
    linkedDaemon.webTransportPort,
    PROFILE,
    SEED,
  );
  let finalizationAttempted = false;
  let primaryError: unknown = null;
  let finalizationError: unknown = null;
  let closeError: unknown = null;
  try {
    try {
      await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
      await expectConnected(page, 40_000);
      await expect(page.getByText(/^Direct(?: · \d+ms)?$/).first()).toBeVisible({
        timeout: 30_000,
      });
      expect(
        proxy.sourceHashes.length,
        'the production transport worker must be intercepted',
      ).toBeGreaterThan(0);
      expect(dials.length, 'native direct construction must traverse the proxy').toBeGreaterThan(0);
      const gpu = await readWebGpuIdentity(page);
      expect(gpu.api).toBe('webgpu');
      await terminalPerf.settlePresentation();
      await latchDirectWorkerIdentity(page);
      const sessionSnapshot = await snapshotDirectObservation(page, terminalPerf);
      const sessionRawArtifact = 'direct-native-browser-session-events.json.gz';
      const sessionRaw = gzipSync(Buffer.from(JSON.stringify(sessionSnapshot.events)));
      await attachDirectArtifact(testInfo, sessionRawArtifact, {
        body: sessionRaw,
        contentType: 'application/gzip',
      });
      browserSessionBinding = {
        ...resolveNativeBrowserSessionBinding(sessionSnapshot.events),
        rawArtifact: sessionRawArtifact,
        rawSha256: createHash('sha256').update(sessionRaw).digest('hex'),
      };
      await attachDirectArtifact(testInfo, 'direct-native-browser-session.json', {
        body: JSON.stringify({
          source: sourceBefore,
          binding: browserSessionBinding,
          recorder: sessionSnapshot.recorder,
        }),
        contentType: 'application/json',
      });
      expect(gpu.softwareEvidence, 'hardware WebGPU required for latency measurements').toBeNull();
      // The control must not infer a refresh period from the workload it is
      // judging: a chronically two-frame callback cadence would otherwise
      // normalize itself to a clean one-frame median. Capture the latest
      // confident terminal-render calibration first, in the same live session,
      // then reset the recorder for each isolated control.
      const calibrationMarker = `direct-calibration-${randomBytes(4).toString('hex')}`;
      const calibrationMeasurementId = await terminalPerf.beginPresentationMeasurement('streaming');
      await page.keyboard.insertText(
        `printf '\\033[2J\\033[H\\033[2K\\r%s\\n' '${calibrationMarker}'\n`,
      );
      await terminalPerf.endPresentationMeasurement(calibrationMeasurementId);
      await requireCurrentViewportMarker(page, calibrationMarker);
      await requireDirectWorkerIdentity(page);
      const displayPeriodCalibrationSnapshot = await snapshotDirectObservation(page, terminalPerf);
      const displayPeriodCalibrationEvidence = await captureDisplayPeriodCalibration(
        displayPeriodCalibrationSnapshot,
        calibrationMeasurementId,
        sourceBefore,
        testInfo,
      );
      const displayPeriodCalibration = displayPeriodCalibrationEvidence.calibration;
      const gateFailures = displayPeriodCalibrationEvidence.errors.map(
        (error) => `display-period-calibration: ${error}`,
      );
      const frameControls: DirectFrameControlPopulation[] = [];
      const framePhases: DirectFramePhasePopulation[] = [];
      let priorSegmentedDirectHopCounters: readonly DirectRedrawSegmentHopCounters[] | null = null;
      for (const kind of ['idle', 'keyboard-injection'] as const) {
        const control = await captureMainThreadControl(
          kind,
          'before',
          page,
          terminalPerf,
          testInfo,
          displayPeriodCalibration,
          displayPeriodCalibrationEvidence.link,
        );
        frameControls.push(toFrameControlPopulation(control));
        collectGateFailure(gateFailures, `main-thread-${kind}-control`, () => {
          assertMainThreadControl(control);
        });
      }
      if (WORKLOAD_SELECTION.typing) {
        for (const typingWorkload of DIRECT_TYPING_WORKLOADS) {
          const { cadenceMs, pattern, delayPatternMs } = typingWorkload;
          // A new genuine shell-editor boundary per phase. This does not alter any
          // daemon termios, foreground-group or authenticated-boundary gate.
          await page.keyboard.press('Control+c');
          const ready = `direct-ready-${typingWorkload.name}-${randomBytes(4).toString('hex')}`;
          await page.keyboard.insertText(`printf '\\033[2J\\033[H${ready}\\n\\033[?2004h'\n`);
          await terminalPerf.settlePresentation();
          await requireCurrentViewportMarker(page, ready);
          await page.keyboard.type('warmup');
          for (let i = 0; i < 6; i += 1) await page.keyboard.press('Backspace');
          await terminalPerf.settlePresentation();
          await withNativeTrace(typingWorkload.name, async () => {
            await resetDirectObservation(page, terminalPerf);
            await proxy.settledStats();
            await proxy.reset();
            // 120 printable characters and 120 deletes, all on one row; actual DOM
            // intervals are retained instead of assuming Playwright hit its target.
            await runDirectGpuTracePhase(
              directTypingGpuTraceEnabled(DIRECT_GPU_TRACE, typingWorkload),
              page,
              `direct-${typingWorkload.name}-gpu-trace`,
              sourceBefore,
              testInfo,
              gateFailures,
              async () => {
                await runPresentationMeasurement(terminalPerf, 'streaming', async () => {
                  if (pattern === 'regular') {
                    await driveTypingPattern(page, cadenceMs);
                  } else {
                    for (const step of directIrregularTypingSteps()) {
                      await page.keyboard.press(step.key, { delay: step.delayMs });
                    }
                  }
                });
              },
            );
            const snapshot = await snapshotDirectObservation(page, terminalPerf);
            await capture(
              typingWorkload.name,
              snapshot,
              {
                kind: 'typing',
                cadenceMs,
                pattern,
                delayPatternMs,
                printableInputs: 120,
                deletionInputs: 120,
              },
              proxy,
              dials,
              gpu,
              sourceBefore,
              displayPeriodCalibration,
              displayPeriodCalibrationEvidence.link,
              terminalPerf,
              testInfo,
              gateFailures,
              framePhases,
            );
          });
        }
      }
      if (WORKLOAD_SELECTION.redraw) {
        // Silent canonical read makes Enter the only input within each redraw
        // window; command-entry echo is outside it. Small and dense output are
        // separate populations rather than an average concealing different costs.
        await page.keyboard.press('Control+c');
        const quiet = `direct-quiet-${randomBytes(4).toString('hex')}`;
        await page.keyboard.insertText(`PS1=; stty -echo; printf '%s\\n' '${quiet}'\n`);
        await terminalPerf.settlePresentation();
        await requireCurrentViewportMarker(page, quiet);
        for (const workload of ['small-multirow', 'bounded-cat'] as const) {
          const token = randomBytes(5).toString('hex');
          const readyPrefix = `direct-${workload}-ready-${token}`;
          const finalMarker = `direct-${workload}-done-${token}`;
          const loopCommand = buildDirectRedrawLoopCommand(
            workload,
            readyPrefix,
            finalMarker,
            REDRAW_SAMPLES,
          );
          await attachDirectArtifact(testInfo, `direct-${workload}-driver.json`, {
            body: Buffer.from(
              JSON.stringify(
                {
                  schemaVersion: 1,
                  kind: 'pre-staged-shell-redraw-trigger',
                  interpretation:
                    'The shell loop is installed before the observation. Each judged window contains one Enter byte that triggers one ordinal-tagged redraw; this is not command-submission latency.',
                  workload,
                  samples: REDRAW_SAMPLES,
                  inputBytesPerWindow: 1,
                  initialReadyMarker: directRedrawReadyMarker(readyPrefix, 0),
                  finalMarker,
                  commandSha256: createHash('sha256').update(loopCommand).digest('hex'),
                },
                null,
                2,
              ),
            ),
            contentType: 'application/json',
          });
          let observationStarted = false;
          let phaseError: unknown = null;
          const segmented = workload === 'bounded-cat';
          const segments: DirectRedrawObservationSegment[] = [];
          const attemptedSegments: DirectRedrawSegmentAttempt[] = [];
          if (segmented && REDRAW_SAMPLES % DIRECT_REDRAW_OBSERVATION_SEGMENT_SIZE !== 0) {
            throw new Error(
              `bounded-cat samples must be divisible by ${DIRECT_REDRAW_OBSERVATION_SEGMENT_SIZE}`,
            );
          }
          try {
            await page.keyboard.insertText(loopCommand);
            await terminalPerf.settlePresentation();
            await requireCurrentViewportMarker(page, directRedrawReadyMarker(readyPrefix, 0));
            // Driver installation, command echo, and ready-000 are setup. The
            // lossless observation begins only after the shell is blocked on its
            // first read, so every retained input is one judged Enter byte.
            await resetDirectObservation(page, terminalPerf);
            observationStarted = true;
            await proxy.settledStats();
            await proxy.reset();
            for (let sample = 0; sample < REDRAW_SAMPLES; sample += 1) {
              await runPresentationMeasurement(terminalPerf, 'coherent-redraw', async () => {
                await page.keyboard.press('Enter');
              });
              // Wait for the end-covering rAF interval before the out-of-window
              // current-grid query. A late ready marker cannot supply missing
              // in-window authority or hide a causal display/fence tail.
              await page.evaluate(
                () =>
                  new Promise<void>((resolve) => {
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                  }),
              );
              const expectedMarker =
                sample + 1 === REDRAW_SAMPLES
                  ? finalMarker
                  : directRedrawReadyMarker(readyPrefix, sample + 1);
              await requireCurrentViewportMarker(page, expectedMarker);
              if (segmented && (sample + 1) % DIRECT_REDRAW_OBSERVATION_SEGMENT_SIZE === 0) {
                const segmentIndex = (sample + 1) / DIRECT_REDRAW_OBSERVATION_SEGMENT_SIZE - 1;
                const segmentSnapshot = await snapshotDirectObservation(page, terminalPerf);
                const result = await capture(
                  `${workload}-segment-${String(segmentIndex + 1).padStart(2, '0')}`,
                  segmentSnapshot,
                  {
                    kind: 'redraw',
                    population: workload,
                    samples: DIRECT_REDRAW_OBSERVATION_SEGMENT_SIZE,
                    driver: 'pre-staged-shell-redraw-trigger',
                    inputBytesPerWindow: 1,
                  },
                  proxy,
                  dials,
                  gpu,
                  sourceBefore,
                  displayPeriodCalibration,
                  displayPeriodCalibrationEvidence.link,
                  terminalPerf,
                  testInfo,
                  gateFailures,
                  framePhases,
                  {
                    kind: 'redraw-segment',
                    segmentIndex,
                    firstSampleOrdinal: segmentIndex * DIRECT_REDRAW_OBSERVATION_SEGMENT_SIZE,
                  },
                );
                if (result.segment !== null) segments.push(result.segment);
                if (result.attemptedSegment !== null) {
                  attemptedSegments.push(result.attemptedSegment);
                }
                if (sample + 1 < REDRAW_SAMPLES) {
                  // The shell remains blocked on the next exact read. Cut a new
                  // observation only after the prior segment is durably written
                  // and replayed. The direct-hop counters deliberately remain
                  // cumulative until the final segment, so traffic racing this
                  // recorder reset cannot be erased from the clean-path proof.
                  await resetDirectObservation(page, terminalPerf);
                }
              }
            }
          } catch (error) {
            phaseError = error;
          }

          let evidenceError: unknown = null;
          try {
            if (observationStarted) {
              if (segmented) {
                if (phaseError !== null) {
                  const failureSnapshot = await snapshotDirectObservation(page, terminalPerf);
                  const failureRaw = gzipSync(Buffer.from(JSON.stringify(failureSnapshot.events)));
                  await attachDirectArtifact(
                    testInfo,
                    `direct-${workload}-incomplete-segment-events.json.gz`,
                    { body: failureRaw, contentType: 'application/gzip' },
                  );
                  await attachDirectArtifact(
                    testInfo,
                    `direct-${workload}-incomplete-segment.json`,
                    {
                      body: Buffer.from(
                        JSON.stringify(
                          {
                            schemaVersion: 1,
                            error:
                              phaseError instanceof Error ? phaseError.message : String(phaseError),
                            completedSegmentCount: segments.length,
                            recorder: failureSnapshot.recorder,
                            raw: {
                              artifact: `direct-${workload}-incomplete-segment-events.json.gz`,
                              sha256: createHash('sha256').update(failureRaw).digest('hex'),
                              eventCount: failureSnapshot.events.length,
                              gzipBytes: failureRaw.byteLength,
                            },
                          },
                          null,
                          2,
                        ),
                      ),
                      contentType: 'application/json',
                    },
                  );
                }
                await captureSegmentedDirectRedrawAggregate(
                  workload,
                  segments,
                  attemptedSegments,
                  {
                    kind: 'redraw',
                    population: workload,
                    samples: REDRAW_SAMPLES,
                    driver: 'pre-staged-shell-redraw-trigger',
                    inputBytesPerWindow: 1,
                  },
                  proxy.targetRttMs,
                  gpu,
                  sourceBefore,
                  displayPeriodCalibration,
                  displayPeriodCalibrationEvidence.link,
                  testInfo,
                  gateFailures,
                  framePhases,
                );
                priorSegmentedDirectHopCounters = segments.at(-1)?.directHopCounters ?? null;
              } else {
                const snapshot = await snapshotDirectObservation(page, terminalPerf);
                await capture(
                  workload,
                  snapshot,
                  {
                    kind: 'redraw',
                    population: workload,
                    samples: REDRAW_SAMPLES,
                    driver: 'pre-staged-shell-redraw-trigger',
                    inputBytesPerWindow: 1,
                  },
                  proxy,
                  dials,
                  gpu,
                  sourceBefore,
                  displayPeriodCalibration,
                  displayPeriodCalibrationEvidence.link,
                  terminalPerf,
                  testInfo,
                  gateFailures,
                  framePhases,
                );
              }
            } else {
              const snapshot = await snapshotDirectObservation(page, terminalPerf);
              const setupRaw = gzipSync(Buffer.from(JSON.stringify(snapshot.events)));
              await attachDirectArtifact(
                testInfo,
                `direct-${workload}-setup-failure-events.json.gz`,
                { body: setupRaw, contentType: 'application/gzip' },
              );
              await attachDirectArtifact(testInfo, `direct-${workload}-setup-failure.json`, {
                body: Buffer.from(
                  JSON.stringify(
                    {
                      schemaVersion: 1,
                      error: phaseError instanceof Error ? phaseError.message : String(phaseError),
                      recorder: snapshot.recorder,
                      raw: {
                        sha256: createHash('sha256').update(setupRaw).digest('hex'),
                        eventCount: snapshot.events.length,
                        gzipBytes: setupRaw.byteLength,
                      },
                    },
                    null,
                    2,
                  ),
                ),
                contentType: 'application/json',
              });
            }
          } catch (error) {
            evidenceError = error;
          }
          const phaseErrors = [phaseError, evidenceError].filter((error) => error !== null);
          if (phaseErrors.length === 1) throw phaseErrors[0];
          if (phaseErrors.length > 1) {
            throw new AggregateError(
              phaseErrors,
              `${workload} redraw phase and durable capture both failed`,
            );
          }
        }
      }
      for (const plan of [
        buildTmuxSwitchWorkload(tuiTools.tmux, randomBytes(4).toString('hex')),
        buildNeovimNavigationWorkload(tuiTools.neovim, randomBytes(4).toString('hex')),
      ]) {
        if (!WORKLOAD_SELECTION[plan.application]) continue;
        const precedingSegmentedDirectHopCounters = priorSegmentedDirectHopCounters;
        priorSegmentedDirectHopCounters = null;
        await withNativeTrace(plan.application, async () => {
          await runDirectTuiPhase(
            plan,
            REDRAW_SAMPLES,
            page,
            terminalPerf,
            proxy,
            precedingSegmentedDirectHopCounters,
            dials,
            gpu,
            sourceBefore,
            displayPeriodCalibration,
            displayPeriodCalibrationEvidence.link,
            testInfo,
            gateFailures,
            framePhases,
          );
        });
      }
      for (const kind of ['idle', 'keyboard-injection'] as const) {
        const control = await captureMainThreadControl(
          kind,
          'after',
          page,
          terminalPerf,
          testInfo,
          displayPeriodCalibration,
          displayPeriodCalibrationEvidence.link,
        );
        frameControls.push(toFrameControlPopulation(control));
        collectGateFailure(gateFailures, `main-thread-${kind}-control-after`, () => {
          assertMainThreadControl(control);
        });
      }
      const frameControlComparison = compareDirectFrameControls(
        frameControls,
        framePhases,
        MAIN_THREAD_FRAME_BUDGET_TOLERANCE_MS,
      );
      await attachDirectArtifact(testInfo, 'direct-frame-control-comparison.json', {
        body: Buffer.from(
          JSON.stringify(
            {
              schemaVersion: 1,
              interpretation:
                'Absolute rAF overruns remain the target. Bracketed controls attribute browser/host callback noise; they never redefine a refresh period, turn an unmet absolute target into a pass, or stand in for compositor/scan-out evidence. A control-limited absolute miss is explicitly inconclusive.',
              comparison: frameControlComparison,
            },
            null,
            2,
          ),
        ),
        contentType: 'application/json',
      });
      gateFailures.push(
        ...frameControlComparison.errors.map((error) => `main-thread-control-relative: ${error}`),
        ...frameControlComparison.inconclusiveReasons.map(
          (error) => `main-thread-control-inconclusive: ${error}`,
        ),
      );
      await requireDirectWorkerIdentity(page);
      finalizationAttempted = true;
      const finalGridConvergence = await terminalPerf.finalizeGridConvergence();
      const finalDirectHops = await proxy.settledStats();
      await attachDirectArtifact(testInfo, 'direct-run-final.json', {
        body: Buffer.from(
          JSON.stringify(
            {
              schemaVersion: 1,
              source: sourceBefore,
              workloadSelection: WORKLOAD_SELECTION,
              finalGridConvergence,
              finalDirectHops,
              constructorDials: dials,
              fixedPreWorkloadCalibrationEvidence: displayPeriodCalibrationEvidence.link,
              gateFailures,
            },
            null,
            2,
          ),
        ),
        contentType: 'application/json',
      });
      expect(excessiveDials, 'unexpected repeated direct carrier creation').toBe(false);
      expect(
        sourceProvenance(resolveRequiredDirectTuiTools()),
        'source changed during the measurement',
      ).toEqual(sourceBefore);
      if (gateFailures.length > 0) {
        throw new Error(`Direct performance gates failed:\n${gateFailures.join('\n')}`);
      }
    } catch (error) {
      primaryError = error;
    }
    // Preserve the carrier through the one read-only final authority/grid
    // proof even when a setup, capture, or acceptance assertion failed.
    if (!finalizationAttempted) {
      finalizationAttempted = true;
      try {
        await terminalPerf.finalizeGridConvergence();
      } catch (error) {
        finalizationError = error;
      }
    }
  } finally {
    page.off('console', observeDial);
    try {
      await proxy.close();
    } catch (error) {
      closeError = error;
    }
  }
  throwCombinedErrors(primaryError, finalizationError, closeError);
});

async function driveTypingPattern(page: Page, cadenceMs: number): Promise<void> {
  const printable = '0123456789abcdefghij';
  for (const range of DIRECT_TYPING_ORDINAL_PATTERN) {
    const count = range.endOrdinal - range.firstOrdinal;
    if (range.inputClass === 'printable') {
      if (count !== printable.length) {
        throw new Error('direct typing ordinal metadata does not match the printable driver');
      }
      await page.keyboard.type(printable, { delay: cadenceMs });
      continue;
    }
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      await page.keyboard.press('Backspace', { delay: cadenceMs });
    }
  }
}

async function runDirectGpuTracePhase(
  enabled: boolean,
  page: Page,
  gpuTraceArtifactPrefix: string,
  source: ReturnType<typeof sourceProvenance>,
  testInfo: TestInfo,
  gateFailures: string[],
  action: () => Promise<void>,
): Promise<void> {
  if (!enabled) return action();
  const traceBrowser = page.context().browser();
  if (traceBrowser === null) throw new Error('missing diagnostic browser');
  const traceWorker = await createDirectTraceWorkerClock(page);
  let gpuTrace: Awaited<ReturnType<typeof startDirectCdpTrace>>;
  try {
    gpuTrace = await startDirectCdpTrace(traceBrowser);
  } catch (error) {
    traceWorker?.dispose();
    throw error;
  }
  type WorkerTraceMark = Awaited<ReturnType<NonNullable<typeof traceWorker>['mark']>>;
  let traceWorkerBegin: WorkerTraceMark | null = null;
  let traceWorkerEnd: WorkerTraceMark | null = null;
  let traceBegin: Awaited<ReturnType<typeof markDirectTraceClock>> | null = null;
  let traceEnd: Awaited<ReturnType<typeof markDirectTraceClock>> | null = null;
  let driveFailure: { error: unknown } | null = null;
  let traceFailure: { error: unknown } | null = null;
  try {
    if (gpuTrace !== null) traceBegin = await markDirectTraceClock(page, 'begin');
    if (traceWorker !== null) traceWorkerBegin = await traceWorker.mark('begin');
    await action();
  } catch (error) {
    driveFailure = { error };
  }
  try {
    if (gpuTrace !== null) {
      const traceErrors: string[] = [];
      try {
        if (traceWorker !== null) traceWorkerEnd = await traceWorker.mark('end');
      } catch (error) {
        traceErrors.push(`worker end clock mark failed: ${String(error)}`);
      }
      try {
        traceEnd = await markDirectTraceClock(page, 'end');
      } catch (error) {
        traceErrors.push(`end clock mark failed: ${String(error)}`);
      }
      const trace = await gpuTrace.stop();
      const { body, ...traceMetadata } = trace;
      await attachDirectArtifact(testInfo, `${gpuTraceArtifactPrefix}.json`, {
        body,
        contentType: 'application/json',
      });
      let coverage: ReturnType<typeof validateDirectTraceClockCoverage> | null = null;
      let workerCoverage: ReturnType<typeof validateDirectTraceClockCoverage> | null = null;
      let workerCanvasCalls: ReturnType<typeof collectWorkerCanvasCalls> | null = null;
      try {
        if (traceBegin === null || traceEnd === null) {
          traceErrors.push('missing trace clock boundary');
        } else {
          coverage = validateDirectTraceClockCoverage(body, traceBegin, traceEnd);
          traceErrors.push(...coverage.errors);
        }
        if (traceWorkerBegin === null || traceWorkerEnd === null) {
          traceErrors.push('missing terminal worker trace boundary');
        } else {
          workerCoverage = validateDirectTraceClockCoverage(body, traceWorkerBegin, traceWorkerEnd);
          traceErrors.push(...workerCoverage.errors);
          if (
            coverage?.epochOffsetMs == null ||
            workerCoverage.epochOffsetMs === null ||
            Math.abs(coverage.epochOffsetMs - workerCoverage.epochOffsetMs) > 1
          )
            traceErrors.push('page and terminal worker trace clocks disagree');
          if (workerCoverage.complete) {
            workerCanvasCalls = collectWorkerCanvasCalls(
              parseExactChromeTrace(body.toString('utf8')),
              traceWorkerBegin.name,
              traceWorkerEnd.name,
            );
            if (Object.values(workerCanvasCalls.counts).some((count) => count === 0))
              traceErrors.push('terminal worker trace lacks native canvas call stages');
          }
        }
      } catch (error) {
        traceErrors.push(String(error));
      }
      await attachDirectArtifact(testInfo, `${gpuTraceArtifactPrefix}-metadata.json`, {
        body: Buffer.from(
          JSON.stringify(
            {
              ...traceMetadata,
              complete: trace.complete && traceErrors.length === 0,
              errors: [...trace.errors, ...traceErrors],
              timingAcceptanceEligible: false,
              categories: DIRECT_GPU_TRACE_CATEGORIES,
              traceBegin,
              traceEnd,
              coverage,
              terminalWorker: {
                assetUrl: traceWorker?.assetUrl ?? null,
                assetSha256: traceWorker?.assetSha256 ?? null,
                begin: traceWorkerBegin,
                end: traceWorkerEnd,
                coverage: workerCoverage,
                canvasCalls: workerCanvasCalls,
              },
              source,
            },
            null,
            2,
          ),
        ),
        contentType: 'application/json',
      });
      if (!trace.complete || traceErrors.length > 0) {
        gateFailures.push(
          `GPU diagnostic trace incomplete: ${[...trace.errors, ...traceErrors].join('; ')}`,
        );
      }
    }
  } catch (error) {
    traceFailure = { error };
  } finally {
    traceWorker?.dispose();
  }
  if (driveFailure !== null && traceFailure !== null) {
    throw new AggregateError(
      [driveFailure.error, traceFailure.error],
      'Direct driver and trace finalization failed',
    );
  }
  if (driveFailure !== null) throw driveFailure.error;
  if (traceFailure !== null) throw traceFailure.error;
}

async function runDirectTuiPhase(
  plan: DirectTuiWorkloadPlan,
  samples: number,
  page: Page,
  terminalPerf: TerminalPerfFixture,
  proxy: DirectNetworkProxy,
  priorSegmentedDirectHopCounters: readonly DirectRedrawSegmentHopCounters[] | null,
  dials: readonly string[],
  gpu: Awaited<ReturnType<typeof readWebGpuIdentity>>,
  source: ReturnType<typeof sourceProvenance>,
  displayPeriodCalibration: DirectRefreshPeriodCalibration | null,
  displayPeriodCalibrationEvidence: DirectDisplayPeriodCalibrationLink,
  testInfo: TestInfo,
  gateFailures: string[],
  framePhases: DirectFramePhasePopulation[],
): Promise<void> {
  if (
    !Number.isSafeInteger(samples) ||
    samples <= 0 ||
    !Number.isSafeInteger(plan.operationCycleLength) ||
    plan.operationCycleLength <= 0 ||
    samples % plan.operationCycleLength !== 0
  ) {
    throw new Error(
      `${plan.application} Direct samples must contain complete ${plan.operationCycleLength}-operation cycles`,
    );
  }
  let activated = false;
  let phaseError: unknown = null;
  const cleanupErrors: unknown[] = [];
  try {
    await page.keyboard.insertText(plan.launchCommand);
    await terminalPerf.settlePresentation();
    let activationMeasurementId: number | null = null;
    const activatedAtMs = await beginDirectTuiActivationObservation({
      waitForReady: () => requireCurrentViewportMarker(page, plan.readyMarker),
      resetObservation: () => resetDirectObservation(page, terminalPerf),
      now: () => page.evaluate(() => performance.timeOrigin + performance.now()),
      activate: async () => {
        activationMeasurementId = await runPresentationMeasurement(
          terminalPerf,
          'coherent-redraw',
          async () => {
            await page.keyboard.press('Enter');
            activated = true;
          },
        );
      },
    });
    if (activationMeasurementId === null) {
      throw new Error(`${plan.application} activation measurement was not created`);
    }
    // Tool startup is outside every judged window. Exact viewport content
    // proves that the requested application—not a shell error or prompt—is
    // active. A single premeasurement dump then joins one authoritative apply
    // through its exact renderer transaction to its GPU-completion fence. No
    // per-navigation content observer or trace poll is installed.
    await page.waitForTimeout(250);
    await terminalPerf.settlePresentation();
    const initialViewportSnapshot = await page.evaluate(readDirectTuiViewportSnapshot);
    const activationProofCutAtMs = await page.evaluate(
      () => performance.timeOrigin + performance.now(),
    );
    const activation = await snapshotDirectObservation(page, terminalPerf);
    const activationRaw = gzipSync(Buffer.from(JSON.stringify(activation.events)));
    await attachDirectArtifact(
      testInfo,
      `direct-tui-${plan.application}-activation-events.json.gz`,
      {
        body: activationRaw,
        contentType: 'application/gzip',
      },
    );
    const activationBoundaryErrors = validateDirectTuiActivationMeasurementBoundary(
      activation.events,
      {
        measurementId: activationMeasurementId,
        activatedAtMs,
        proofCutAtMs: activationProofCutAtMs,
        sessionEpoch: displayPeriodCalibrationEvidence.sessionEpoch ?? 0,
      },
    );
    if (activationBoundaryErrors.length > 0) {
      throw new Error(
        `${plan.application} activation measurement boundary is invalid: ${activationBoundaryErrors.join('; ')}`,
      );
    }
    const activationProofCapturedAtMs = requireLosslessProofCapture(
      activation,
      activationProofCutAtMs,
      `${plan.application} activation`,
      displayPeriodCalibrationEvidence,
    );
    const initialViewport = matchDirectTuiViewport(
      initialViewportSnapshot.text,
      plan.initialViewportNeedle,
    );
    const activationFence = findDirectTuiActivationFence(activation.events, {
      activatedAtMs,
      viewportRequestedAtMs: initialViewportSnapshot.requestedAtMs,
      viewportCompletedAtMs: initialViewportSnapshot.completedAtMs,
      proofCutAtMs: activationProofCutAtMs,
      proofCapturedAtMs: activationProofCapturedAtMs,
    });
    if (activationFence === null) {
      throw new Error(`${plan.application} did not produce an authoritative GPU-complete frame`);
    }
    await attachDirectArtifact(testInfo, `direct-tui-${plan.application}-activation.json`, {
      body: Buffer.from(
        JSON.stringify(
          {
            viewportNeedle: plan.initialViewportNeedle,
            viewportMatch: initialViewport,
            viewportRead: {
              requestedAtMs: initialViewportSnapshot.requestedAtMs,
              completedAtMs: initialViewportSnapshot.completedAtMs,
            },
            activatedAtMs,
            activationMeasurementId,
            activationFence,
            fixedPreWorkloadCalibrationEvidence: displayPeriodCalibrationEvidence,
            recorder: activation.recorder,
            raw: {
              artifact: `direct-tui-${plan.application}-activation-events.json.gz`,
              sha256: createHash('sha256').update(activationRaw).digest('hex'),
              eventCount: activation.events.length,
              gzipBytes: activationRaw.byteLength,
            },
          },
          null,
          2,
        ),
      ),
      contentType: 'application/json',
    });

    await resetDirectObservation(page, terminalPerf);
    const preResetHops = await proxy.settledStats();
    if (priorSegmentedDirectHopCounters !== null) {
      const cumulativeCutErrors: string[] = [];
      const currentHopCounters = directHopCounters(preResetHops);
      let deltas: ReturnType<typeof directRedrawCumulativeHopDeltas> | null = null;
      collectGateFailure(cumulativeCutErrors, 'cumulative-hop-lineage', () => {
        deltas = directRedrawCumulativeHopDeltas(
          priorSegmentedDirectHopCounters,
          currentHopCounters,
        );
      });
      collectGateFailure(cumulativeCutErrors, 'cumulative-hop-clean', () => {
        expect(preResetHops).toHaveLength(2);
        for (const hop of preResetHops) assertCleanDirectHop(hop, proxy.targetRttMs);
      });
      await attachDirectArtifact(testInfo, 'direct-bounded-cat-final-proxy-cut.json', {
        body: Buffer.from(
          JSON.stringify(
            {
              schemaVersion: 1,
              kind: 'segmented-direct-redraw-final-proxy-cut',
              interpretation:
                'A second settled cumulative two-hop snapshot, taken after the final segment and immediately before the next proxy reset, closes packets that could arrive across the non-atomic two-hop segment snapshot.',
              source,
              priorSegmentedDirectHopCounters,
              preResetHops,
              deltas,
              errors: cumulativeCutErrors,
            },
            null,
            2,
          ),
        ),
        contentType: 'application/json',
      });
      for (const error of cumulativeCutErrors) {
        gateFailures.push(`bounded-cat/final-proxy-cut: ${error}`);
      }
    }
    await proxy.reset();
    await runDirectGpuTracePhase(
      DIRECT_GPU_TRACE,
      page,
      `direct-${plan.application}-gpu-trace`,
      source,
      testInfo,
      gateFailures,
      async () => {
        for (let sample = 0; sample < samples; sample += 1) {
          const key = plan.stepKeys[sample % plan.stepKeys.length];
          if (key === undefined) throw new Error(`${plan.application} step-key schedule is empty`);
          await runPresentationMeasurement(terminalPerf, 'coherent-redraw', async () => {
            await page.keyboard.press(key);
          });
        }
      },
    );
    const snapshot = await snapshotDirectObservation(page, terminalPerf);
    const operation = plan.application === 'tmux' ? 'window-switch' : 'page-navigation';
    await capture(
      `tui-${plan.application}-${operation}`,
      snapshot,
      {
        kind: 'tui',
        application: plan.application,
        operation,
        samples,
        inputBytesPerOperation: 1,
        viewportOracle: {
          initialNeedle: plan.initialViewportNeedle,
          completedCycleNeedle: plan.completedCycleViewportNeedle,
          operationCycleLength: plan.operationCycleLength,
        },
      },
      proxy,
      dials,
      gpu,
      source,
      displayPeriodCalibration,
      displayPeriodCalibrationEvidence,
      terminalPerf,
      testInfo,
      gateFailures,
      framePhases,
    );
    const finalViewportSnapshot = await page.evaluate(readDirectTuiViewportSnapshot);
    const finalProofCutAtMs = await page.evaluate(() => performance.timeOrigin + performance.now());
    const finalProof = await snapshotDirectObservation(page, terminalPerf);
    const finalProofRaw = gzipSync(Buffer.from(JSON.stringify(finalProof.events)));
    await attachDirectArtifact(
      testInfo,
      `direct-tui-${plan.application}-final-viewport-events.json.gz`,
      {
        body: finalProofRaw,
        contentType: 'application/gzip',
      },
    );
    const finalProofCapturedAtMs = requireLosslessProofCapture(
      finalProof,
      finalProofCutAtMs,
      `${plan.application} final viewport`,
      displayPeriodCalibrationEvidence,
    );
    const finalViewport = matchDirectTuiViewport(
      finalViewportSnapshot.text,
      plan.completedCycleViewportNeedle,
    );
    const finalViewportFence = findDirectTuiActivationFence(finalProof.events, {
      activatedAtMs,
      viewportRequestedAtMs: finalViewportSnapshot.requestedAtMs,
      viewportCompletedAtMs: finalViewportSnapshot.completedAtMs,
      proofCutAtMs: finalProofCutAtMs,
      proofCapturedAtMs: finalProofCapturedAtMs,
    });
    if (finalViewportFence === null) {
      throw new Error(`${plan.application} final viewport lacks a stable authoritative GPU fence`);
    }
    await attachDirectArtifact(testInfo, `direct-tui-${plan.application}-final-viewport.json`, {
      body: Buffer.from(
        JSON.stringify(
          {
            completedOperations: samples,
            operationCycleLength: plan.operationCycleLength,
            viewportNeedle: plan.completedCycleViewportNeedle,
            viewportMatch: finalViewport,
            viewportRead: {
              requestedAtMs: finalViewportSnapshot.requestedAtMs,
              completedAtMs: finalViewportSnapshot.completedAtMs,
            },
            viewportFence: finalViewportFence,
            fixedPreWorkloadCalibrationEvidence: displayPeriodCalibrationEvidence,
            recorder: finalProof.recorder,
            raw: {
              artifact: `direct-tui-${plan.application}-final-viewport-events.json.gz`,
              sha256: createHash('sha256').update(finalProofRaw).digest('hex'),
              eventCount: finalProof.events.length,
              gzipBytes: finalProofRaw.byteLength,
            },
          },
          null,
          2,
        ),
      ),
      contentType: 'application/json',
    });
  } catch (error) {
    phaseError = error;
  } finally {
    if (activated) {
      try {
        for (const key of plan.exitKeys) {
          if (key === ':q!') await page.keyboard.type(key);
          else await page.keyboard.press(key);
        }
        await terminalPerf.settlePresentation();
        await requireCurrentViewportMarker(page, plan.exitMarker);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await cleanupDirectTuiWorkload(plan);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const errors = phaseError === null ? cleanupErrors : [phaseError, ...cleanupErrors];
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `${plan.application} Direct phase/cleanup failures`);
  }
}

async function captureMainThreadControl(
  kind: DirectMainThreadControl['kind'],
  position: DirectFrameControlPosition,
  page: Page,
  terminalPerf: TerminalPerfFixture,
  testInfo: TestInfo,
  displayPeriodCalibration: DirectRefreshPeriodCalibration | null,
  displayPeriodCalibrationEvidence: DirectDisplayPeriodCalibrationLink,
): Promise<DirectMainThreadControl> {
  await resetDirectObservation(page, terminalPerf);
  const controlId = `merkur-direct-main-control-${kind}-${randomBytes(4).toString('hex')}`;
  await page.evaluate(async (id) => {
    const iframe = document.createElement('iframe');
    iframe.id = `${id}-frame`;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    const loaded = new Promise<void>((resolve) => {
      iframe.addEventListener('load', () => resolve(), { once: true });
    });
    iframe.srcdoc = '<!doctype html><html><body></body></html>';
    document.body.append(iframe);
    await loaded;
    const documentInFrame = iframe.contentDocument;
    if (documentInFrame === null) throw new Error('isolated keyboard-control frame is unavailable');
    const textarea = documentInFrame.createElement('textarea');
    textarea.id = id;
    textarea.dataset.keyboardEventCount = '0';
    textarea.dataset.inputEventCount = '0';
    textarea.setAttribute('aria-hidden', 'true');
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('spellcheck', 'false');
    textarea.style.cssText = 'width:1px;height:1px';
    textarea.addEventListener('keydown', () => {
      textarea.dataset.keyboardEventCount = String(
        Number(textarea.dataset.keyboardEventCount ?? 0) + 1,
      );
    });
    textarea.addEventListener('input', () => {
      textarea.dataset.inputEventCount = String(Number(textarea.dataset.inputEventCount ?? 0) + 1);
    });
    documentInFrame.body.append(textarea);
    textarea.focus();
  }, controlId);

  let measurementId = 0;
  await runPresentationMeasurement(terminalPerf, 'streaming', async (id) => {
    measurementId = id;
    if (kind === 'keyboard-injection') {
      for (
        let repetition = 0;
        repetition < MAIN_THREAD_KEYBOARD_CONTROL_REPETITIONS;
        repetition += 1
      ) {
        await driveTypingPattern(page, MAIN_THREAD_KEYBOARD_CONTROL_CADENCE_MS);
      }
    } else {
      await page.waitForTimeout(MAIN_THREAD_IDLE_CONTROL_MS);
    }
  });
  const dom = await page.evaluate((id) => {
    const iframe = document.getElementById(`${id}-frame`);
    const textarea =
      iframe instanceof HTMLIFrameElement ? iframe.contentDocument?.getElementById(id) : null;
    if (textarea?.tagName !== 'TEXTAREA') {
      return {
        present: false,
        keyboardEventCount: 0,
        inputEventCount: 0,
        finalValueLength: 0,
      };
    }
    const result = {
      present: true,
      keyboardEventCount: Number(textarea.dataset.keyboardEventCount ?? Number.NaN),
      inputEventCount: Number(textarea.dataset.inputEventCount ?? Number.NaN),
      finalValueLength: (textarea as HTMLTextAreaElement).value.length,
    };
    return result;
  }, controlId);
  // Snapshot through the end-covering rAF while the measured DOM state is
  // untouched. Removing the iframe or refocusing the terminal first would let
  // teardown work masquerade as the final control interval.
  const snapshot = await snapshotDirectObservation(page, terminalPerf);
  const raw = gzipSync(Buffer.from(JSON.stringify(snapshot.events)));
  await attachDirectArtifact(
    testInfo,
    `direct-main-thread-${kind}-${position}-control-events.json.gz`,
    {
      body: raw,
      contentType: 'application/gzip',
    },
  );
  const teardownStartedAtMs = await page.evaluate((id) => {
    const atMs = performance.timeOrigin + performance.now();
    document.getElementById(`${id}-frame`)?.remove();
    return atMs;
  }, controlId);
  await page.locator('#terminal-output').click({ position: { x: 20, y: 20 } });
  const captureErrors = validateRecorderMetadata(snapshot.recorder).map(
    (error) => `recorder: ${error}`,
  );
  captureErrors.push(
    ...fixedSessionLineageErrors(snapshot.events, displayPeriodCalibrationEvidence),
  );
  if (!dom.present) captureErrors.push('the isolated control textarea disappeared');
  if (!Number.isSafeInteger(dom.keyboardEventCount) || dom.keyboardEventCount < 0) {
    captureErrors.push('the control keydown count is invalid');
  }
  if (!Number.isSafeInteger(dom.inputEventCount) || dom.inputEventCount < 0) {
    captureErrors.push('the control input count is invalid');
  }

  const boundaries = snapshot.events.filter(
    (event): event is Extract<TerminalPerfEvent, { kind: 'presentation_measurement_boundary' }> =>
      event.kind === 'presentation_measurement_boundary' && event.measurementId === measurementId,
  );
  const starts = boundaries.filter((event) => event.phase === 'start');
  const ends = boundaries.filter((event) => event.phase === 'end');
  if (starts.length !== 1)
    captureErrors.push(`expected one start boundary, observed ${starts.length}`);
  if (ends.length !== 1) captureErrors.push(`expected one end boundary, observed ${ends.length}`);
  const startAtMs = starts[0]?.atMs ?? null;
  const endAtMs = ends[0]?.atMs ?? null;
  if (startAtMs !== null && endAtMs !== null && endAtMs < startAtMs) {
    captureErrors.push('the control measurement end precedes its start');
  }
  if (
    displayPeriodCalibration !== null &&
    startAtMs !== null &&
    displayPeriodCalibration.sourceAtMs >= startAtMs
  ) {
    captureErrors.push('the display-period calibration does not precede the control window');
  }
  if (snapshot.events.some((event) => event.kind === 'session_start')) {
    captureErrors.push('the terminal session changed after the display-period calibration');
  }

  const cadenceEvents =
    startAtMs === null || endAtMs === null
      ? []
      : snapshot.events.filter(
          (event): event is Extract<TerminalPerfEvent, { kind: 'main_frame_cadence' }> =>
            event.kind === 'main_frame_cadence' &&
            event.atMs >= startAtMs &&
            event.atMs - event.gapMs <= endAtMs,
        );
  const rafGapMs = referenceDistribution(cadenceEvents.map((event) => event.gapMs));
  const refreshPeriodMs = displayPeriodCalibration?.periodMs ?? null;
  const frameBudgetOverruns: number[] = [];
  const startsCovered =
    startAtMs !== null &&
    cadenceEvents.some((event) => event.atMs - event.gapMs <= startAtMs && event.atMs >= startAtMs);
  const endsCovered =
    endAtMs !== null &&
    cadenceEvents.some((event) => event.atMs - event.gapMs <= endAtMs && event.atMs >= endAtMs);
  const supports = new Set(cadenceEvents.map((event) => event.longTaskObserverSupported));
  const longTaskObserverSupported =
    supports.size === 1 ? (supports.values().next().value ?? null) : null;
  if (supports.size > 1)
    captureErrors.push('long-task observer support changed inside the control');
  let estimatedMissedFrameCount = 0;
  let estimatedMissedIntervalCount = 0;
  let frameBudgetExceededIntervalCount = 0;
  if (refreshPeriodMs === null || !(refreshPeriodMs > 0)) {
    captureErrors.push('the control has no calibrated main-thread frame period');
  } else {
    for (const event of cadenceEvents) {
      const overrunMs = Math.max(0, event.gapMs - refreshPeriodMs);
      frameBudgetOverruns.push(overrunMs);
      const missed = Math.max(0, Math.round(event.gapMs / refreshPeriodMs) - 1);
      estimatedMissedFrameCount += missed;
      if (missed > 0) estimatedMissedIntervalCount += 1;
      if (overrunMs > MAIN_THREAD_FRAME_BUDGET_TOLERANCE_MS) {
        frameBudgetExceededIntervalCount += 1;
      }
    }
  }
  const frameBudgetOverrunMs = referenceDistribution(frameBudgetOverruns);
  const longTaskCount =
    startAtMs === null || endAtMs === null
      ? 0
      : snapshot.events.filter(
          (event) =>
            event.kind === 'main_long_task' &&
            Math.min(event.atMs + event.durationMs, endAtMs) - Math.max(event.atMs, startAtMs) > 0,
        ).length;
  const terminalInputCount =
    startAtMs === null || endAtMs === null
      ? 0
      : snapshot.events.filter(
          (event) =>
            event.kind === 'input_queued' && event.atMs >= startAtMs && event.atMs <= endAtMs,
        ).length;
  const control: DirectMainThreadControl = {
    kind,
    position,
    activePatternRepetitions:
      kind === 'keyboard-injection' ? MAIN_THREAD_KEYBOARD_CONTROL_REPETITIONS : 0,
    activePatternCadenceMs:
      kind === 'keyboard-injection' ? MAIN_THREAD_KEYBOARD_CONTROL_CADENCE_MS : null,
    measurementId,
    startAtMs,
    endAtMs,
    terminalInputCount,
    keyboardEventCount: dom.keyboardEventCount,
    inputEventCount: dom.inputEventCount,
    finalValueLength: dom.finalValueLength,
    refreshPeriodMs,
    refreshPeriodSourceAtMs: displayPeriodCalibration?.sourceAtMs ?? null,
    refreshPeriodConfidence01: displayPeriodCalibration?.confidence01 ?? null,
    traceCapturedAtMs: snapshot.recorder.capturedAtMs,
    teardownStartedAtMs,
    frameBudgetToleranceMs: MAIN_THREAD_FRAME_BUDGET_TOLERANCE_MS,
    frameBudgetTolerancePeriodFraction:
      refreshPeriodMs === null ? null : MAIN_THREAD_FRAME_BUDGET_TOLERANCE_MS / refreshPeriodMs,
    startsCovered,
    endsCovered,
    rafGapMs,
    frameBudgetOverrunMs,
    estimatedMissedFrameCount,
    estimatedMissedIntervalCount,
    frameBudgetExceededIntervalCount,
    longTaskObserverSupported,
    longTaskCount,
    captureErrors,
    browserName: page.context().browser()?.browserType().name() ?? '',
  };
  const applicationDisplayOutcome = collectApplicationDisplayOutcome(snapshot.events);
  const replay = verifyRawTerminalPerfTrace(
    raw,
    snapshot.events.length,
    snapshot.report,
    applicationDisplayOutcome,
  );
  await attachDirectArtifact(testInfo, `direct-main-thread-${kind}-${position}-control.json`, {
    body: Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 2,
          boundary:
            'browser rAF and PerformanceObserver evidence under an isolated DOM target; no terminal input or GPU-frame claim',
          fixedPreWorkloadCalibrationEvidence: displayPeriodCalibrationEvidence,
          control,
          report: snapshot.report,
          applicationDisplayOutcome,
          replay: {
            eventCount: replay.eventCount,
            reportSha256: replay.reportSha256,
            applicationDisplayOutcomeSha256: replay.applicationDisplayOutcomeSha256,
          },
          recorder: snapshot.recorder,
          raw: {
            sha256: createHash('sha256').update(raw).digest('hex'),
            eventCount: snapshot.events.length,
            gzipBytes: raw.byteLength,
          },
          eventCounts: eventCounts(snapshot.events),
        },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });
  return control;
}

function assertMainThreadControl(control: DirectMainThreadControl): void {
  expect(control.captureErrors).toEqual([]);
  expect(control.startsCovered).toBe(true);
  expect(control.endsCovered).toBe(true);
  expect(control.rafGapMs.count).toBeGreaterThanOrEqual(DIRECT_FRAME_CONTROL_MIN_INTERVALS);
  expect(control.refreshPeriodMs).not.toBeNull();
  expect(control.refreshPeriodSourceAtMs).not.toBeNull();
  expect(control.refreshPeriodConfidence01).toBeGreaterThanOrEqual(0.5);
  expect(control.traceCapturedAtMs).not.toBeNull();
  expect(control.traceCapturedAtMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    control.teardownStartedAtMs,
  );
  expect(control.startAtMs).not.toBeNull();
  expect(control.refreshPeriodSourceAtMs ?? Number.POSITIVE_INFINITY).toBeLessThan(
    control.startAtMs ?? Number.NEGATIVE_INFINITY,
  );
  expect(control.frameBudgetToleranceMs).toBe(MAIN_THREAD_FRAME_BUDGET_TOLERANCE_MS);
  expect(control.frameBudgetTolerancePeriodFraction).toBeCloseTo(
    MAIN_THREAD_FRAME_BUDGET_TOLERANCE_MS / (control.refreshPeriodMs ?? Number.POSITIVE_INFINITY),
    10,
  );
  expect(control.frameBudgetOverrunMs.count).toBe(control.rafGapMs.count);
  expect(
    Math.abs(
      (control.rafGapMs.p50 ?? Number.POSITIVE_INFINITY) -
        (control.refreshPeriodMs ?? Number.NEGATIVE_INFINITY),
    ),
    'observed rAF cadence must agree with the independent terminal-render calibration',
  ).toBeLessThanOrEqual(MAIN_THREAD_FRAME_BUDGET_TOLERANCE_MS);
  expect(control.terminalInputCount, 'the control must bypass terminal input').toBe(0);
  const expectedEvents =
    control.kind === 'keyboard-injection'
      ? DIRECT_TYPING_INPUT_COUNT * control.activePatternRepetitions
      : 0;
  expect(control.keyboardEventCount).toBe(expectedEvents);
  expect(control.inputEventCount).toBe(expectedEvents);
  expect(control.finalValueLength).toBe(0);
  expect(control.estimatedMissedFrameCount).toBeGreaterThanOrEqual(0);
  expect(control.estimatedMissedIntervalCount).toBeGreaterThanOrEqual(0);
  expect(control.estimatedMissedIntervalCount).toBeLessThanOrEqual(control.rafGapMs.count);
  expect(control.frameBudgetExceededIntervalCount).toBeGreaterThanOrEqual(0);
  expect(control.frameBudgetExceededIntervalCount).toBeLessThanOrEqual(control.rafGapMs.count);
  assertLongTaskCapability(control.browserName, control.longTaskObserverSupported);
}

function toFrameControlPopulation(control: DirectMainThreadControl): DirectFrameControlPopulation {
  return {
    name: `${control.kind}-${control.position}`,
    kind: control.kind,
    position: control.position,
    intervalCount: control.rafGapMs.count,
    frameBudgetOverrunMs: control.frameBudgetOverrunMs,
    estimatedMissedFrameCount: control.estimatedMissedFrameCount,
    estimatedMissedIntervalCount: control.estimatedMissedIntervalCount,
    frameBudgetExceededIntervalCount: control.frameBudgetExceededIntervalCount,
  };
}

function collectGateFailure(errors: string[], scope: string, gate: () => void): void {
  try {
    gate();
  } catch (error) {
    errors.push(`${scope}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertLongTaskEvidence(
  browserName: string,
  supported: boolean | null,
  observedCount: number,
  metricComplete: boolean | null,
): void {
  expect(supported, 'main cadence must state Long Tasks API capability').not.toBeNull();
  if (supported === true) {
    if (metricComplete !== null) expect(metricComplete).toBe(true);
    expect(observedCount).toBe(0);
    return;
  }
  // Firefox may not expose PerformanceObserver's `longtask` entry type. Its
  // rAF missed-frame gates remain strict, but a missing API is recorded as
  // unavailable and must never be relabelled as an observed zero.
  expect(browserName).toBe('firefox');
  if (metricComplete !== null) expect(metricComplete).toBe(false);
  expect(observedCount).toBe(0);
}

function assertLongTaskCapability(browserName: string, supported: boolean | null): void {
  expect(supported, 'main cadence must state Long Tasks API capability').not.toBeNull();
  if (supported === false) expect(browserName).toBe('firefox');
}

function throwCombinedErrors(...errors: readonly unknown[]): void {
  const present = errors.filter((error) => error !== null);
  if (present.length === 0) return;
  if (present.length === 1) throw present[0];
  throw new AggregateError(
    present,
    'Direct benchmark, final grid convergence, and/or proxy teardown failed',
  );
}

async function runPresentationMeasurement(
  terminalPerf: TerminalPerfFixture,
  purpose: Parameters<TerminalPerfFixture['beginPresentationMeasurement']>[0],
  action: (measurementId: number) => Promise<void>,
): Promise<number> {
  const measurementId = await terminalPerf.beginPresentationMeasurement(purpose);
  let actionError: unknown = null;
  let closeError: unknown = null;
  try {
    await action(measurementId);
  } catch (error) {
    actionError = error;
  }
  try {
    await terminalPerf.endPresentationMeasurement(measurementId);
  } catch (error) {
    closeError = error;
  }
  if (actionError !== null && closeError !== null) {
    throw new AggregateError(
      [actionError, closeError],
      `presentation measurement ${measurementId} action and close both failed`,
    );
  }
  if (actionError !== null) throw actionError;
  if (closeError !== null) throw closeError;
  return measurementId;
}

async function capture(
  name: string,
  snapshot: TerminalPerfSnapshot,
  workload: DirectWorkload,
  proxy: DirectNetworkProxy,
  dials: readonly string[],
  gpu: Awaited<ReturnType<typeof readWebGpuIdentity>>,
  source: ReturnType<typeof sourceProvenance>,
  displayPeriodCalibration: DirectRefreshPeriodCalibration | null,
  displayPeriodCalibrationEvidence: DirectDisplayPeriodCalibrationLink,
  terminalPerf: TerminalPerfFixture,
  testInfo: TestInfo,
  gateFailures: string[],
  framePhases: DirectFramePhasePopulation[],
  mode: DirectCaptureMode = { kind: 'standalone' },
): Promise<DirectCaptureResult> {
  const rawArtifact = `direct-${name}-events.json.gz`;
  const reportArtifact = `direct-${name}.json`;
  const raw = gzipSync(Buffer.from(JSON.stringify(snapshot.events)));
  const rawSha256 = createHash('sha256').update(raw).digest('hex');
  await attachDirectArtifact(testInfo, rawArtifact, {
    body: raw,
    contentType: 'application/gzip',
  });
  const hops = await proxy.settledStats();
  const inputs = snapshot.events.filter((event) => event.kind === 'input_queued');
  const inputIntervals = intervals(inputs.map((event) => event.atMs));
  const uniqueFences = snapshot.events.filter((event) => event.kind === 'frame_complete');
  const captureErrors: string[] = [];
  let displayIngressRoutes: ReturnType<typeof summarizeDisplayIngressRoutes> | null = null;
  try {
    displayIngressRoutes = summarizeDisplayIngressRoutes(snapshot.events);
    captureErrors.push(
      ...displayIngressRoutes.errors.map((error) => `ingress route census: ${error}`),
    );
  } catch (error) {
    captureErrors.push(
      `ingress route census failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  captureErrors.push(
    ...fixedSessionLineageErrors(snapshot.events, displayPeriodCalibrationEvidence),
  );
  let applicationDisplayOutcome: ReturnType<typeof collectApplicationDisplayOutcome> | null = null;
  try {
    applicationDisplayOutcome = collectApplicationDisplayOutcome(snapshot.events);
    captureErrors.push(
      ...validateApplicationDisplayOutcomeEvidence(
        applicationDisplayOutcome,
        false,
        true,
        mode.kind === 'redraw-segment',
      ).map((error) => `application display outcome invalid: ${error}`),
    );
  } catch (error) {
    captureErrors.push(
      `application display outcome failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let replay: ReturnType<typeof verifyRawTerminalPerfTrace> | null = null;
  if (applicationDisplayOutcome !== null) {
    try {
      replay = verifyRawTerminalPerfTrace(
        raw,
        snapshot.events.length,
        snapshot.report,
        applicationDisplayOutcome,
      );
    } catch (error) {
      captureErrors.push(
        `raw trace replay failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // Reconstruct both homogeneous input classes from replayed exact input
  // identities. The retained ordinal ranges make the class split independently
  // reproducible from the raw gzip; aggregate report tails cannot satisfy it.
  let typingPopulations: DirectTypingPopulationSummary | null = null;
  if (workload.kind === 'typing') {
    try {
      typingPopulations = summarizeDirectTypingPopulations(
        snapshot.report.samples,
        snapshot.events,
        directTypingParentCompleteness(snapshot.report),
        DIRECT_TYPING_ORDINAL_PATTERN,
      );
      if (displayPeriodCalibration === null) {
        throw new Error('typing cadence is missing independent refresh calibration');
      }
      const cadence = summarizeDirectTypingCadence(
        snapshot.report.samples,
        snapshot.events,
        typingPopulations.ordinalRanges,
        displayPeriodCalibration.periodMs,
      );
      await attachDirectArtifact(testInfo, `direct-${name}-cadence.json`, {
        body: Buffer.from(
          JSON.stringify(
            {
              ...cadence,
              raw: {
                artifact: rawArtifact,
                sha256: rawSha256,
              },
              parentArtifact: `direct-${name}.json`,
              eligibility:
                'diagnostic-only; inherit parent capture failures, never upgrade acceptance',
            },
            null,
            2,
          ),
        ),
        contentType: 'application/json',
      });
    } catch (error) {
      captureErrors.push(
        `typing population reconstruction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let coherentInputPopulation: DirectCoherentInputPopulation | null = null;
  if (workload.kind !== 'typing') {
    try {
      coherentInputPopulation = summarizeDirectCoherentInputWindows(
        snapshot.events,
        workload.samples,
      );
    } catch (error) {
      captureErrors.push(
        `coherent input population reconstruction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let redrawCoverage: DirectRedrawCoverage | null = null;
  if (workload.kind !== 'typing' && replay !== null) {
    try {
      for (const metricName of [
        'presentation.rowsPerMeasurementWindow',
        'presentation.datagramsPerMeasurementWindow',
        'presentation.bytesPerMeasurementWindow',
      ] as const) {
        if (!replay.metricComplete[metricName]) {
          throw new Error(`${metricName} is incomplete`);
        }
      }
      redrawCoverage = summarizeDirectRedrawCoverage(
        workload.kind === 'redraw' ? workload.population : workload.application,
        replay.metricSamples['presentation.rowsPerMeasurementWindow'],
        replay.metricSamples['presentation.datagramsPerMeasurementWindow'],
        replay.metricSamples['presentation.bytesPerMeasurementWindow'],
        workload.samples,
      );
    } catch (error) {
      captureErrors.push(
        `redraw coverage reconstruction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let neovimTransactions: DirectNeovimTransactionPopulation | null = null;
  if (
    workload.kind === 'tui' &&
    workload.application === 'neovim' &&
    coherentInputPopulation !== null &&
    replay !== null
  ) {
    try {
      neovimTransactions = summarizeDirectNeovimTransactions(
        snapshot.events,
        coherentInputPopulation,
      );
    } catch (error) {
      captureErrors.push(
        `Neovim transaction reconstruction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const rtt = snapshot.report.inputAckNetworkRttFloorMs;
  const companion = await terminalPerf.proxyImpairment();
  const phaseDisplayPeriod = latestConfidentDisplayPeriod(snapshot.events);
  const expectedWindowCount = workload.kind === 'typing' ? 1 : workload.samples;
  const windowRefreshPeriods =
    replay?.metricSamples['presentation.refreshPeriodPerMeasurementWindowMs'] ?? [];
  if (
    replay !== null &&
    !replay.metricComplete['presentation.refreshPeriodPerMeasurementWindowMs']
  ) {
    captureErrors.push('refresh-period measurement-window evidence is incomplete');
  }
  if (windowRefreshPeriods.length !== expectedWindowCount) {
    captureErrors.push(
      `refresh-period measurement-window count ${windowRefreshPeriods.length} does not match ${expectedWindowCount}`,
    );
  }
  const refreshPeriodAgreement = compareDirectRefreshPeriods(
    displayPeriodCalibration,
    [
      {
        name: 'render-start',
        observations: snapshot.events
          .filter(
            (event): event is Extract<TerminalPerfEvent, { kind: 'render_start' }> =>
              event.kind === 'render_start',
          )
          .map((event) => ({ atMs: event.atMs, periodMs: event.refreshPeriodMs })),
      },
      {
        name: 'presentation-commit',
        observations: snapshot.events
          .filter(
            (event): event is Extract<TerminalPerfEvent, { kind: 'presentation_commit' }> =>
              event.kind === 'presentation_commit',
          )
          .map((event) => ({ atMs: event.atMs, periodMs: event.refreshPeriodMs })),
      },
      {
        name: 'measurement-window',
        observations: windowRefreshPeriods.map((periodMs) => ({ atMs: null, periodMs })),
      },
    ],
    MAIN_THREAD_FRAME_BUDGET_TOLERANCE_MS,
    snapshot.events
      .filter(
        (event): event is Extract<TerminalPerfEvent, { kind: 'session_start' }> =>
          event.kind === 'session_start',
      )
      .map((event) => event.atMs),
  );
  captureErrors.push(
    ...refreshPeriodAgreement.errors.map((error) => `refresh-period anchoring invalid: ${error}`),
  );
  const missedPerGap = replay?.metricSamples['mainThread.estimatedMissedFramesPerGap'] ?? [];
  if (
    replay !== null &&
    (missedPerGap.length !== snapshot.report.mainThread.intervalCount ||
      missedPerGap.reduce((sum, count) => sum + count, 0) !==
        snapshot.report.mainThread.estimatedMissedFrameCount)
  ) {
    captureErrors.push('raw missed-frame interval population does not match the replayed report');
  }
  collectGateFailure(captureErrors, 'recorder', () => {
    expect(validateRecorderMetadata(snapshot.recorder)).toEqual([]);
  });
  collectGateFailure(captureErrors, 'direct-hops', () => {
    expect(hops).toHaveLength(2);
    for (const hop of hops) assertCleanDirectHop(hop, proxy.targetRttMs);
  });
  collectGateFailure(captureErrors, 'application-rtt', () => {
    expect(rtt.count, 'every phase must contain application RTT evidence').toBeGreaterThanOrEqual(
      mode.kind === 'redraw-segment' && workload.kind === 'redraw' ? workload.samples : 100,
    );
    expect(rtt.complete).toBe(true);
    const jitterMs = EDGE_NETWORK_PROFILES[PROFILE].oneWayJitterUs / 1_000;
    expect(rtt.p50).toBeGreaterThanOrEqual(proxy.targetRttMs - 2 * jitterMs - 5);
    expect(rtt.p95).toBeLessThan(proxy.targetRttMs + 2 * jitterMs + 15);
  });
  collectGateFailure(captureErrors, 'companion-edge', () => {
    if (companion === null) throw new Error('companion edge impairment evidence is missing');
    expect(companion.config.targetRttMs).toBeGreaterThan(proxy.targetRttMs);
    expect(companion.config.baseDelayUs).toBe((companion.config.targetRttMs * 1_000) / 4);
    for (const direction of [companion.upstream, companion.downstream]) {
      expect(direction.actualResidenceUs.count).toBeGreaterThan(0);
      expect(direction.actualResidenceUs.p50).toBeGreaterThanOrEqual(
        companion.config.baseDelayUs - companion.config.jitterRadiusUs,
      );
    }
  });
  if (
    mode.kind === 'redraw-segment' &&
    replay !== null &&
    workload.kind === 'redraw' &&
    coherentInputPopulation !== null &&
    redrawCoverage !== null
  ) {
    collectGateFailure(captureErrors, 'structural-direct', () => {
      assertDirectPerformance(
        snapshot,
        replay.metricSamples,
        workload,
        null,
        coherentInputPopulation,
        redrawCoverage,
        null,
        proxy.targetRttMs,
        gpu.browser,
        displayPeriodCalibration,
        'structural-only',
      );
    });
  }
  if (mode.kind === 'standalone') {
    framePhases.push({
      name,
      matchedControl: workload.kind === 'typing' ? 'keyboard-injection' : 'idle',
      intervalCount: snapshot.report.mainThread.intervalCount,
      frameBudgetOverrunMs: snapshot.report.mainThread.frameBudgetOverrunMs,
      estimatedMissedFrameCount: snapshot.report.mainThread.estimatedMissedFrameCount,
      estimatedMissedIntervalCount:
        replay === null ? -1 : missedPerGap.filter((count) => count > 0).length,
      frameBudgetExceededIntervalCount: snapshot.report.mainThread.frameBudgetExceededIntervalCount,
    });
  }
  const reconstructionComplete =
    replay !== null &&
    displayIngressRoutes !== null &&
    applicationDisplayOutcome !== null &&
    (workload.kind === 'typing'
      ? typingPopulations !== null
      : coherentInputPopulation !== null &&
        redrawCoverage !== null &&
        (workload.kind !== 'tui' ||
          workload.application !== 'neovim' ||
          neovimTransactions !== null));
  const evidenceIntegrityEligible = reconstructionComplete && captureErrors.length === 0;
  const performanceGateErrors: string[] = [];
  let performanceGateStatus:
    | 'passed'
    | 'failed'
    | 'not-executed-ineligible-evidence'
    | 'not-applicable-structural-segment' =
    mode.kind === 'standalone'
      ? 'not-executed-ineligible-evidence'
      : 'not-applicable-structural-segment';
  if (mode.kind === 'standalone' && evidenceIntegrityEligible) {
    if (replay === null) throw new Error('complete Direct evidence lost its raw replay');
    performanceGateErrors.push(
      ...validateApplicationDisplayOutcomeEvidence(
        applicationDisplayOutcome,
        false,
        true,
        true,
      ).map((error) => `${name}: clean display outcome: ${error}`),
    );
    collectGateFailure(performanceGateErrors, name, () => {
      assertDirectPerformance(
        snapshot,
        replay.metricSamples,
        workload,
        typingPopulations,
        coherentInputPopulation,
        redrawCoverage,
        neovimTransactions,
        proxy.targetRttMs,
        gpu.browser,
        displayPeriodCalibration,
      );
    });
    performanceGateStatus = performanceGateErrors.length === 0 ? 'passed' : 'failed';
  }
  const reportBody = Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 11,
        metricBoundary:
          'DOM input timestamp to exact worker prediction submission and browser-observed WebGPU queue completion, separately; not compositor, scan-out or physical photons',
        source,
        timingAcceptanceEligible:
          !DIRECT_GPU_TRACE && mode.kind === 'standalone' && evidenceIntegrityEligible,
        timingAcceptanceScope:
          mode.kind === 'standalone'
            ? 'complete phase population'
            : 'structural segment only; timing is judged from the pooled raw n-window aggregate',
        performanceGate: {
          status: performanceGateStatus,
          errors: performanceGateErrors,
          interpretation:
            'evidence-integrity eligibility is independent of an executed UX-budget result; incomplete evidence never executes or passes the performance gate',
        },
        observationSegment:
          mode.kind === 'redraw-segment'
            ? {
                segmentIndex: mode.segmentIndex,
                firstSampleOrdinal: mode.firstSampleOrdinal,
                sampleCount: workload.kind === 'redraw' ? workload.samples : 0,
              }
            : null,
        workload,
        gpu,
        browser: { name: gpu.browser, version: gpu.version },
        network: {
          profile: PROFILE,
          seed: SEED,
          targetRttMs: proxy.targetRttMs,
          topology:
            mode.kind === 'redraw-segment'
              ? 'browser -> outer UDP proxy -> inner UDP proxy -> real direct daemon; four delay legs per RTT; segment counters are cumulative from the single pre-population reset through this settled cut, so no inter-segment proxy reset can erase loss; slower production companion edge remains live'
              : 'browser -> outer UDP proxy -> inner UDP proxy -> real direct daemon; four delay legs per RTT; slower production companion edge remains live',
          proxyPorts: proxy.proxyPorts,
          backendPort: proxy.backendPort,
          workerSources: proxy.sourceHashes,
          constructorDials: dials,
          hops,
          companionEdge: companion,
        },
        observedInputIntervalsMs: referenceDistribution(inputIntervals),
        observedWebglSyncReadinessIntervalsMs: referenceDistribution(
          intervals(uniqueFences.map((event) => event.atMs)),
        ),
        frameBudgetAcceptance: {
          schedulingAndMeasurementToleranceMs: MAIN_THREAD_FRAME_BUDGET_TOLERANCE_MS,
          fixedPreWorkloadCalibration: displayPeriodCalibration,
          fixedPreWorkloadCalibrationEvidence: displayPeriodCalibrationEvidence,
          latestPhaseCalibration: phaseDisplayPeriod,
          refreshPeriodAgreement,
          toleranceAsPeriodFraction:
            displayPeriodCalibration === null
              ? null
              : MAIN_THREAD_FRAME_BUDGET_TOLERANCE_MS / displayPeriodCalibration.periodMs,
          boundary:
            'raw rAF gap minus each recorded window period, with every phase period required to match the fixed confident pre-workload calibration; tolerance is not subtracted from retained samples and is not a compositor/scan-out claim',
        },
        diagnostics: directPhaseDiagnostics(snapshot.events),
        // Keep counts and null coverage: rapidly superseded edits are not
        // relabelled as an individually observable authoritative pixel.
        report: snapshot.report,
        typingPopulations,
        coherentInputPopulation,
        redrawCoverage,
        neovimTransactions,
        displayIngressRoutes,
        applicationDisplayOutcome,
        replay:
          replay === null
            ? null
            : {
                eventCount: replay.eventCount,
                reportSha256: replay.reportSha256,
                applicationDisplayOutcomeSha256: replay.applicationDisplayOutcomeSha256,
              },
        recorder: snapshot.recorder,
        captureErrors,
        gridConvergenceEvidence: 'direct-run-final.json',
        raw: {
          artifact: rawArtifact,
          sha256: rawSha256,
          eventCount: snapshot.events.length,
          gzipBytes: raw.byteLength,
        },
        eventCounts: eventCounts(snapshot.events),
      },
      null,
      2,
    ),
  );
  const reportSha256 = createHash('sha256').update(reportBody).digest('hex');
  await attachDirectArtifact(testInfo, reportArtifact, {
    body: reportBody,
    contentType: 'application/json',
  });
  const attemptedSegment: DirectRedrawSegmentAttempt | null =
    mode.kind === 'redraw-segment'
      ? {
          segmentIndex: mode.segmentIndex,
          firstSampleOrdinal: mode.firstSampleOrdinal,
          sampleCount: workload.kind === 'redraw' ? workload.samples : 0,
          raw: { artifact: rawArtifact, sha256: rawSha256 },
          report: { artifact: reportArtifact, sha256: reportSha256 },
          replay:
            replay === null
              ? null
              : {
                  eventCount: replay.eventCount,
                  reportSha256: replay.reportSha256,
                  applicationDisplayOutcomeSha256: replay.applicationDisplayOutcomeSha256,
                },
          errors: [...captureErrors],
        }
      : null;
  // Raw evidence is durable before validation, and the report records the
  // executed gate outcome before its errors are deferred to the whole-run end.
  for (const error of captureErrors) gateFailures.push(`${name}: ${error}`);
  gateFailures.push(...performanceGateErrors);
  if (
    replay === null ||
    applicationDisplayOutcome === null ||
    (workload.kind === 'typing' && typingPopulations === null) ||
    (workload.kind !== 'typing' && coherentInputPopulation === null) ||
    (workload.kind !== 'typing' && redrawCoverage === null) ||
    (workload.kind === 'tui' && workload.application === 'neovim' && neovimTransactions === null)
  ) {
    return { segment: null, attemptedSegment };
  }
  if (mode.kind === 'standalone' || workload.kind !== 'redraw') {
    return { segment: null, attemptedSegment };
  }
  const segmentInputPopulation = coherentInputPopulation;
  if (segmentInputPopulation === null) return { segment: null, attemptedSegment };
  const ringBoundaries = snapshot.events
    .filter(
      (event): event is Extract<TerminalPerfEvent, { kind: 'display_ring_measurement_boundary' }> =>
        event.kind === 'display_ring_measurement_boundary',
    )
    .map((event) => ({
      atMs: event.atMs,
      measurementId: event.measurementId,
      phase: event.phase,
      observationEpoch: event.observationEpoch,
      sessionEpoch: event.sessionEpoch,
      ringDroppedTotal: event.ringDroppedTotal,
    }));
  return {
    segment: {
      segmentIndex: mode.segmentIndex,
      firstSampleOrdinal: mode.firstSampleOrdinal,
      sampleCount: workload.samples,
      inputPopulation: segmentInputPopulation,
      ringBoundaries,
      metricSamples: replay.metricSamples,
      metricComplete: replay.metricComplete,
      directHopCounters: directHopCounters(hops),
      errors: [...captureErrors],
      artifacts: {
        rawArtifact,
        rawSha256,
        reportArtifact,
        reportSha256,
        replayEventCount: replay.eventCount,
        replayReportSha256: replay.reportSha256,
        replayApplicationDisplayOutcomeSha256: replay.applicationDisplayOutcomeSha256,
      },
    },
    attemptedSegment,
  };
}

async function captureSegmentedDirectRedrawAggregate(
  name: string,
  segments: readonly DirectRedrawObservationSegment[],
  attemptedSegments: readonly DirectRedrawSegmentAttempt[],
  workload: Extract<DirectWorkload, { kind: 'redraw' }>,
  rttMs: number,
  gpu: Awaited<ReturnType<typeof readWebGpuIdentity>>,
  source: ReturnType<typeof sourceProvenance>,
  displayPeriodCalibration: DirectRefreshPeriodCalibration | null,
  displayPeriodCalibrationEvidence: DirectDisplayPeriodCalibrationLink,
  testInfo: TestInfo,
  gateFailures: string[],
  framePhases: DirectFramePhasePopulation[],
): Promise<void> {
  const aggregateErrors = attemptedSegments.flatMap((segment) =>
    segment.errors.map((error) => `segment ${segment.segmentIndex}: ${error}`),
  );
  let evidence: DirectSegmentedRedrawEvidence | null = null;
  let redrawCoverage: DirectRedrawCoverage | null = null;
  let framePhase: DirectFramePhasePopulation | null = null;
  const sessionEpoch = displayPeriodCalibrationEvidence.sessionEpoch;
  try {
    if (sessionEpoch === null) {
      throw new Error('fixed display-period calibration has no worker session epoch');
    }
    evidence = combineDirectRedrawObservationSegments(segments, workload.samples, sessionEpoch);
    redrawCoverage = summarizeDirectRedrawCoverage(
      workload.population,
      evidence.metricSamples['presentation.rowsPerMeasurementWindow'],
      evidence.metricSamples['presentation.datagramsPerMeasurementWindow'],
      evidence.metricSamples['presentation.bytesPerMeasurementWindow'],
      workload.samples,
    );
    framePhase = summarizeDirectSegmentedRedrawFramePhase(
      name,
      evidence,
      MAIN_THREAD_FRAME_BUDGET_TOLERANCE_MS,
    );
    const pooledEvidence = evidence;
    collectGateFailure(aggregateErrors, 'pooled-redraw', () => {
      if (
        displayPeriodCalibration === null ||
        !Number.isFinite(displayPeriodCalibration.periodMs) ||
        displayPeriodCalibration.periodMs <= 0 ||
        displayPeriodCalibration.confidence01 < 0.5
      ) {
        throw new Error('segmented redraw requires a confident fixed display period');
      }
      expect(redrawCoverage?.windowCount).toBe(workload.samples);
      expect(redrawCoverage?.observedMinimumRows).toBeGreaterThanOrEqual(23);
      expect(redrawCoverage?.appliedDisplayUnitCount).toBeGreaterThanOrEqual(workload.samples);
      expect(redrawCoverage?.payloadByteCount).toBeGreaterThan(0);
      expect(
        (redrawCoverage?.singletonFullUpdateWindowCount ?? -1) +
          (redrawCoverage?.multiUnitWindowCount ?? -1),
      ).toBe(workload.samples);
      assertDirectRedrawRawTail(
        pooledEvidence.metricSamples,
        workload.samples,
        rttMs,
        displayPeriodCalibration.periodMs,
      );
    });
  } catch (error) {
    aggregateErrors.push(error instanceof Error ? error.message : String(error));
  }

  const reportBody = Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'segmented-direct-redraw-aggregate',
        metricBoundary:
          'Bounded lossless 20-window observations from one PTY/session are replayed independently; exact raw per-window samples, never segment percentiles or event timelines, form the judged complete population.',
        source,
        timingAcceptanceEligible:
          !DIRECT_GPU_TRACE && evidence !== null && aggregateErrors.length === 0,
        timingAcceptanceScope:
          'pooled exact raw per-window samples from independently lossless, replayed observation segments',
        workload,
        gpu,
        fixedPreWorkloadCalibration: displayPeriodCalibration,
        fixedPreWorkloadCalibrationEvidence: displayPeriodCalibrationEvidence,
        attemptedSegments,
        segmentedObservation: evidence,
        redrawCoverage,
        framePhase,
        captureErrors: aggregateErrors,
        finalProxyCutEvidence: 'direct-bounded-cat-final-proxy-cut.json',
        gridConvergenceEvidence: 'direct-run-final.json',
      },
      null,
      2,
    ),
  );
  await attachDirectArtifact(testInfo, `direct-${name}.json`, {
    body: reportBody,
    contentType: 'application/json',
  });
  for (const error of aggregateErrors) gateFailures.push(`${name}: ${error}`);
  if (framePhase !== null) framePhases.push(framePhase);
}

function assertDirectPerformance(
  snapshot: TerminalPerfSnapshot,
  raw: TerminalLatencyRawMetricSamples,
  workload: DirectWorkload,
  typingPopulations: DirectTypingPopulationSummary | null,
  coherentInputPopulation: DirectCoherentInputPopulation | null,
  redrawCoverage: DirectRedrawCoverage | null,
  neovimTransactions: DirectNeovimTransactionPopulation | null,
  rttMs: number,
  browserName: string,
  displayPeriodCalibration: DirectRefreshPeriodCalibration | null,
  redrawAcceptance: 'complete' | 'structural-only' = 'complete',
): void {
  const { report } = snapshot;
  const period = displayPeriodCalibration?.periodMs ?? null;
  if (
    period === null ||
    !Number.isFinite(period) ||
    period <= 0 ||
    (displayPeriodCalibration?.confidence01 ?? 0) < 0.5
  ) {
    throw new Error('direct performance requires a confident fixed pre-workload display period');
  }
  const jitterMs = EDGE_NETWORK_PROFILES[PROFILE].oneWayJitterUs / 1_000;
  expect(report.renderInstrumentation.missingRenderStartCount).toBe(0);
  expect(report.renderInstrumentation.missingRenderEndCount).toBe(0);
  expect(report.renderInstrumentation.noFenceRenderCount).toBe(0);
  expect(report.presentation.discardedTransactionCount).toBe(0);
  expect(snapshot.events.filter((event) => event.kind === 'display_resync')).toHaveLength(0);
  expect(
    report.displayPipeline.encodedDeferralQueueHighWaterPerPump.max ?? Number.POSITIVE_INFINITY,
  ).toBeLessThanOrEqual(256);
  const displayPumpCount = report.displayPipeline.pumpDurationMs.count;
  expect(report.displayPipeline.encodedDeferralQueueHighWaterPerPump.complete).toBe(true);
  expect(report.displayPipeline.encodedDeferralQueueHighWaterPerPump.count).toBe(displayPumpCount);
  expect(report.displayPipeline.encodedDeferralQueueRemainingPerPump.complete).toBe(true);
  expect(report.displayPipeline.encodedDeferralQueueRemainingPerPump.count).toBe(displayPumpCount);
  expect(report.displayPipeline.ringBytesAtPumpStart.complete).toBe(true);
  expect(report.displayPipeline.ringBytesAtPumpStart.count).toBe(displayPumpCount);
  expect(report.displayPipeline.ringBytesAtPumpEnd.complete).toBe(true);
  expect(report.displayPipeline.ringBytesAtPumpEnd.count).toBe(displayPumpCount);
  expect(report.displayPipeline.ringRefusalAccountingComplete).toBe(true);
  expect(report.displayPipeline.ringRefusedFrameCount).toBe(0);
  expect(report.displayPipeline.ringRefusedFrameCountPerMeasurementWindow.complete).toBe(true);
  expect(report.displayPipeline.ringRefusedFrameCountPerMeasurementWindow.count).toBe(
    workload.kind === 'typing' ? 1 : workload.samples,
  );
  expect(report.displayPipeline.ringRefusedFrameCountPerMeasurementWindow.max).toBe(0);
  const ringGapCount = Math.max(
    0,
    report.displayPipeline.ringRefusedFrameCountPerMeasurementWindow.count - 1,
  );
  expect(report.displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows.complete).toBe(true);
  expect(report.displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows.count).toBe(
    ringGapCount,
  );
  if (ringGapCount > 0) {
    expect(report.displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows.max).toBe(0);
  }
  expect(report.presentation.renderSubmissionMs.complete).toBe(true);
  expect(
    report.presentation.renderSubmissionMs.max ?? Number.POSITIVE_INFINITY,
  ).toBeLessThanOrEqual(period);
  expect(report.mainThread.complete).toBe(true);
  const expectedWindowCount = workload.kind === 'typing' ? 1 : workload.samples;
  expect(report.presentation.repairCommitsPerMeasurementWindow.complete).toBe(true);
  expect(report.presentation.repairCommitsPerMeasurementWindow.count).toBe(expectedWindowCount);
  expect(report.presentation.repairCommitsPerMeasurementWindow.max).toBe(0);
  expect(report.presentation.expiredRepairCommitsPerMeasurementWindow.complete).toBe(true);
  expect(report.presentation.expiredRepairCommitsPerMeasurementWindow.count).toBe(
    expectedWindowCount,
  );
  expect(report.presentation.expiredRepairCommitsPerMeasurementWindow.max).toBe(0);
  expect(report.mainThread.measurementWindowCount).toBe(expectedWindowCount);
  expect(report.mainThread.sampledMeasurementWindowCount).toBe(expectedWindowCount);
  expect(report.mainThread.frameBudgetOverrunMs.complete).toBe(true);
  expect(report.mainThread.frameBudgetOverrunMs.count).toBe(report.mainThread.intervalCount);
  expect(report.mainThread.estimatedMissedFramesPerMeasurementWindow.complete).toBe(true);
  expect(report.mainThread.estimatedMissedFramesPerMeasurementWindow.count).toBe(
    expectedWindowCount,
  );
  expect(report.mainThread.estimatedMissedFrameCount).toBeGreaterThanOrEqual(0);
  expect(report.mainThread.frameBudgetExceededIntervalCount).toBeGreaterThanOrEqual(0);
  expect(report.mainThread.frameBudgetExceededIntervalCount).toBeLessThanOrEqual(
    report.mainThread.intervalCount,
  );
  assertLongTaskEvidence(
    browserName,
    report.mainThread.longTaskObserverSupported,
    report.mainThread.longTaskCount,
    report.mainThread.longTaskDurationMs.complete,
  );
  if (report.mainThread.longTaskObserverSupported === true) {
    expect(report.mainThread.longTaskTotalMs).toBe(0);
  }

  if (workload.kind === 'tui') {
    if (coherentInputPopulation === null) throw new Error('Direct TUI input population is missing');
    expect(coherentInputPopulation.windowCount).toBe(workload.samples);
    expect(coherentInputPopulation.inputCount).toBe(workload.samples);
    expect(coherentInputPopulation.inputBytesPerWindow).toBe(workload.inputBytesPerOperation);
    expect(report.presentation.measurementWindowCountByPurpose['coherent-redraw']).toBe(
      workload.samples,
    );
    if (workload.application === 'neovim') {
      if (neovimTransactions === null) {
        throw new Error('Direct Neovim application-transaction population is missing');
      }
      expect(neovimTransactions.windowCount).toBe(workload.samples);
      expect(neovimTransactions.transactionCount).toBe(workload.samples * 2);
      expect(neovimTransactions.renderedTransactionCount).toBe(
        neovimTransactions.denseRenderedSegmentCount +
          neovimTransactions.showcmdOutcomeCounts.rendered,
      );
      expect(
        neovimTransactions.showcmdOutcomeCounts.rendered +
          neovimTransactions.showcmdOutcomeCounts['obsolete-before-receipt'],
      ).toBe(workload.samples);
      expect(validateDirectNeovimSteadyTransactions(neovimTransactions)).toEqual([]);
      expect(
        neovimTransactions.showcmdCompletionDispositionCounts['latest-submitted'] +
          neovimTransactions.showcmdCompletionDispositionCounts.superseded +
          neovimTransactions.showcmdCompletionDispositionCounts.invalidated,
      ).toBe(neovimTransactions.showcmdOutcomeCounts.rendered);
      expect(neovimTransactions.denseFinalCompletionDispositionCounts['latest-submitted']).toBe(
        workload.samples,
      );
      expect(neovimTransactions.denseFinalCompletionDispositionCounts.superseded).toBe(0);
      expect(neovimTransactions.denseFinalCompletionDispositionCounts.invalidated).toBe(0);
      expect(
        neovimTransactions.renderReadinessCensus.maximumOutstandingSubmissionCount,
      ).toBeGreaterThanOrEqual(1);
      expect(
        neovimTransactions.renderReadinessCensus.maximumOutstandingSubmissionCount,
      ).toBeLessThanOrEqual(2);
      expect(
        neovimTransactions.renderReadinessCensus.terminalLatestSubmittedWindowCount,
        'the terminal dense update must clear semantic publication debt before the next input',
      ).toBe(workload.samples);
      expect(
        neovimTransactions.windows.every(
          (window) =>
            (window.showcmd.outcome === 'obsolete-before-receipt' ||
              window.showcmd.senderPresentationCommitExposureMs === 0) &&
            window.dense.renderedSegmentCount === 1 &&
            window.dense.senderPresentationCommitExposureMs === 0,
        ),
        'each rendered Neovim sender presentation must own one zero-exposure renderer segment',
      ).toBe(true);
      expect(
        neovimTransactions.denseFinalGateCounts.fence +
          neovimTransactions.denseFinalGateCounts['fence-and-opportunity'],
      ).toBe(neovimTransactions.priorReadinessBlockedDensePageCount);
      for (const metric of [
        neovimTransactions.distributions.inputToShowcmdFirstReceiveMs,
        neovimTransactions.distributions.showcmdToDenseFirstReceiveMs,
        neovimTransactions.distributions.showcmdToDenseStateReadyMs,
        neovimTransactions.distributions.denseStateReadyToRenderStartMs,
        neovimTransactions.distributions.denseRenderCpuMs,
        neovimTransactions.distributions.denseRenderEndToObservedWebglSyncReadinessMs,
        neovimTransactions.distributions.inputToDenseObservedWebglSyncReadinessMs,
      ]) {
        expect(metric.count).toBe(workload.samples);
      }
      for (const metric of [
        neovimTransactions.distributions.inputToShowcmdObservedWebglSyncReadinessMs,
        neovimTransactions.distributions.showcmdToDenseRenderStartMs,
        neovimTransactions.distributions.showcmdToDenseCommitMs,
        neovimTransactions.distributions.showcmdToDenseObservedWebglSyncReadinessMs,
      ]) {
        expect(metric.count).toBe(neovimTransactions.showcmdOutcomeCounts.rendered);
      }
      expect(
        neovimTransactions.distributions.obsoleteDenseStateReadyBeforeShowcmdReceiptMs.count,
      ).toBe(neovimTransactions.showcmdOutcomeCounts['obsolete-before-receipt']);
      expect(neovimTransactions.distributions.denseRenderedSegmentCount.count).toBe(
        workload.samples,
      );
      expect(neovimTransactions.distributions.denseSenderPresentationCommitExposureMs.count).toBe(
        workload.samples,
      );
    } else {
      expect(neovimTransactions).toBeNull();
    }
  }

  if (workload.kind === 'redraw') {
    if (coherentInputPopulation === null)
      throw new Error('Direct redraw-trigger input population is missing');
    expect(coherentInputPopulation.windowCount).toBe(workload.samples);
    expect(coherentInputPopulation.inputCount).toBe(workload.samples);
    expect(coherentInputPopulation.inputBytesPerWindow).toBe(workload.inputBytesPerWindow);
    expect(report.presentation.measurementWindowCountByPurpose['coherent-redraw']).toBe(
      workload.samples,
    );
  }

  if (workload.kind === 'typing') {
    if (typingPopulations === null) throw new Error('direct typing populations are missing');
    expect(typingPopulations.printable.inputCount).toBe(DIRECT_TYPING_INPUTS_PER_CLASS);
    expect(typingPopulations.backspace.inputCount).toBe(DIRECT_TYPING_INPUTS_PER_CLASS);

    // Zero-delay overload is throughput/catch-up evidence only. Retain every
    // input through admission, send and ACK in each class, but make no per-key
    // latency, GPU, compositor, scan-out or photon claim.
    if (workload.cadenceMs === 0) {
      for (const population of [typingPopulations.printable, typingPopulations.backspace]) {
        requireCompleteCount(
          population.metrics.physicalInputToAdmissionMs,
          DIRECT_TYPING_INPUTS_PER_CLASS,
        );
        requireCompleteCount(
          population.metrics.admissionToInputSentMs,
          DIRECT_TYPING_INPUTS_PER_CLASS,
        );
        requireCompleteCount(population.metrics.inputSentToAckMs, DIRECT_TYPING_INPUTS_PER_CLASS);
        requireCompleteCount(population.metrics.inputAckMs, DIRECT_TYPING_INPUTS_PER_CLASS);
      }
      return;
    }

    // Gate each homogeneous 120-input class independently. A pooled percentile
    // across all 240 inputs cannot hide a censored or slower class.
    for (const population of [typingPopulations.printable, typingPopulations.backspace]) {
      requireTail(population.metrics.physicalInputToAdmissionMs, 120, 2, period, 2 * period);
      requireTail(population.metrics.admissionToInputSentMs, 120, 2, period, 2 * period);
      requireTail(
        population.metrics.inputSentToAckMs,
        120,
        rttMs + 2 * jitterMs + 2 * period,
        rttMs + 2 * jitterMs + 3 * period,
        rttMs + 2 * jitterMs + 6 * period,
      );
      requireTail(
        population.metrics.inputAckMs,
        120,
        rttMs + 2 * jitterMs + 2 * period,
        rttMs + 2 * jitterMs + 3 * period,
        rttMs + 2 * jitterMs + 6 * period,
      );
      requireCompleteCount(
        population.metrics.inputAckNetworkRttFloorMs,
        DIRECT_TYPING_INPUTS_PER_CLASS,
      );
      requireTail(
        population.metrics.inputToDisplayReceiveMs,
        100,
        rttMs + 2 * jitterMs + period,
        rttMs + 2 * jitterMs + 2 * period,
        rttMs + 2 * jitterMs + 4 * period,
      );
      expect(population.metrics.inputToDisplayReceiveMs.inputCoverageRatio).toBeGreaterThanOrEqual(
        100 / DIRECT_TYPING_INPUTS_PER_CLASS,
      );
      requireTail(
        population.metrics.inputToAuthoritativeVisualFenceMs,
        100,
        rttMs + 2 * jitterMs + 2 * period,
        rttMs + 2 * jitterMs + 3 * period,
        rttMs + 2 * jitterMs + 6 * period,
      );
      expect(
        population.metrics.inputToAuthoritativeVisualFenceMs.inputCoverageRatio,
      ).toBeGreaterThanOrEqual(100 / DIRECT_TYPING_INPUTS_PER_CLASS);
      expect(population.inputToPredictionPaintMs.modelAcceptedCount).toBeGreaterThanOrEqual(100);
      expect(
        population.inputToPredictionPaintMs.modelAcceptedFenceCoverageRatio ?? 0,
      ).toBeGreaterThanOrEqual(0.85);
      expect(population.inputToPredictionPaintMs.inputCoverageRatio).toBeGreaterThanOrEqual(
        100 / DIRECT_TYPING_INPUTS_PER_CLASS,
      );
      requireTail(population.inputToPredictionPaintMs, 100, 2 * period, 3 * period, 4 * period);
    }

    // Both input classes use the one worker-owned GPU submission. Exact visible
    // prediction membership measures submission, not GPU completion or scan-out.
    for (const population of [typingPopulations.printable, typingPopulations.backspace]) {
      requireTail(
        population.metrics.inputToPredictionSubmissionMs,
        100,
        2 * period,
        3 * period,
        4 * period,
      );
    }
    return;
  }

  if (redrawCoverage === null) throw new Error('direct redraw density coverage is missing');
  expect(redrawCoverage.windowCount).toBe(workload.samples);
  expect(redrawCoverage.observedMinimumRows).toBeGreaterThanOrEqual(
    redrawCoverage.minimumRowsPerWindow,
  );
  expect(redrawCoverage.appliedDisplayUnitCount).toBeGreaterThanOrEqual(workload.samples);
  expect(redrawCoverage.payloadByteCount).toBeGreaterThan(0);
  expect(redrawCoverage.singletonFullUpdateWindowCount + redrawCoverage.multiUnitWindowCount).toBe(
    workload.samples,
  );
  expect(report.inputToCompletedAuthoritativePresentationFenceMs.censoredCount).toBe(0);
  expect(report.inputToCompletedAuthoritativePresentationFenceMs.eligibleCount).toBe(
    workload.samples,
  );
  const presentation = report.presentation;
  expect(presentation.measurementWindowExposureMs.complete).toBe(true);
  expect(presentation.measurementWindowExposureMs.count).toBe(workload.samples);
  expect(presentation.commitsPerMeasurementWindow.complete).toBe(true);
  expect(presentation.commitsPerMeasurementWindow.count).toBe(workload.samples);
  expect(presentation.refreshPeriodPerMeasurementWindowMs.complete).toBe(true);
  expect(presentation.refreshPeriodPerMeasurementWindowMs.count).toBe(workload.samples);
  expect(presentation.fenceObservationIntervalPerMeasurementWindowMs.complete).toBe(true);
  expect(presentation.fenceObservationIntervalPerMeasurementWindowMs.count).toBe(workload.samples);
  if (redrawAcceptance === 'structural-only') return;
  if (workload.samples < 100)
    throw new Error('direct redraw tail acceptance requires at least100 independent windows');
  assertDirectRedrawRawTail(
    raw,
    workload.samples,
    rttMs,
    period,
    workload.kind === 'tui' && workload.application === 'neovim' ? neovimTransactions : null,
  );
}

function assertDirectRedrawRawTail(
  raw: TerminalLatencyRawMetricSamples,
  sampleCount: number,
  rttMs: number,
  period: number,
  neovimTransactions: DirectNeovimTransactionPopulation | null = null,
): void {
  if (sampleCount < 100)
    throw new Error('direct redraw tail acceptance requires at least100 independent windows');
  const jitterMs = EDGE_NETWORK_PROFILES[PROFILE].oneWayJitterUs / 1_000;
  const commits = referenceDistribution(raw['presentation.commitsPerMeasurementWindow']);
  expect(commits.count).toBe(sampleCount);
  if (neovimTransactions !== null) {
    expect(raw['presentation.commitsPerMeasurementWindow']).toHaveLength(sampleCount);
    for (let index = 0; index < sampleCount; index += 1) {
      const count = raw['presentation.commitsPerMeasurementWindow'][index];
      const window = neovimTransactions.windows[index];
      if (window === undefined) throw new Error(`missing Neovim transaction window ${index}`);
      expect(
        count,
        `Neovim window${index} commit count must match every exact sender-presentation renderer segment`,
      ).toBe(window.dense.renderedSegmentCount + (window.showcmd.outcome === 'rendered' ? 1 : 0));
    }
  } else {
    expect(commits.p95).toBe(1);
  }
  // Clean-path coherence includes EVERY visible commit, including parity-first
  // FEC recovery. Neovim's complete showcmd and dense updates are two distinct
  // application transactions; their cross-update span remains reported below.
  // The Neovim sender oracle retains every late-tail dense segment and its
  // first-to-last commit exposure, while the steady-workload gate requires one.
  const exposure = raw['presentation.measurementWindowExposureMs'];
  const refresh = raw['presentation.refreshPeriodPerMeasurementWindowMs'];
  const uncertainty = raw['presentation.fenceObservationIntervalPerMeasurementWindowMs'];
  expect(exposure).toHaveLength(sampleCount);
  expect(refresh).toHaveLength(sampleCount);
  expect(uncertainty).toHaveLength(sampleCount);
  if (neovimTransactions === null) {
    for (let index = 0; index < sampleCount; index += 1) {
      const elapsed = exposure[index];
      const refreshMs = refresh[index];
      const pollMs = uncertainty[index];
      if (elapsed === undefined || refreshMs === undefined || pollMs === undefined)
        throw new Error('incomplete per-window coherence provenance');
      expect(
        elapsed,
        `window${index} exposed progressive redraw beyond its own refresh/poll bound`,
      ).toBeLessThanOrEqual(refreshMs + pollMs);
    }
  }
  requireRawTail(
    raw['presentation.firstDisplayReceiveToCompletedPresentationFenceMs'],
    sampleCount,
    2 * jitterMs + 2 * period,
    2 * jitterMs + 3 * period,
    2 * jitterMs + 5 * period,
  );
  requireRawTail(
    raw.inputToCompletedAuthoritativePresentationFenceMs,
    sampleCount,
    rttMs + 2 * jitterMs + 2 * period,
    rttMs + 2 * jitterMs + 3 * period,
    rttMs + 2 * jitterMs + 5 * period,
  );
}

function requireRawTail(
  values: readonly number[],
  count: number,
  p95: number,
  p99: number,
  worst: number,
): void {
  const metric = referenceDistribution(values);
  expect(metric.count).toBeGreaterThanOrEqual(count);
  expect(metric.p95 ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(p95);
  expect(metric.p99 ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(p99);
  expect(metric.max ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(worst);
}

function directTypingParentCompleteness(
  report: TerminalPerfSnapshot['report'],
): DirectTypingParentCompleteness {
  return {
    physicalInputToAdmissionMs: report.physicalInputToAdmissionMs.complete,
    admissionToInputSentMs: report.admissionToInputSentMs.complete,
    inputSentToAckMs: report.inputSentToAckMs.complete,
    inputAckNetworkRttFloorMs: report.inputAckNetworkRttFloorMs.complete,
    inputAckMs: report.inputAckMs.complete,
    inputToDisplayReceiveMs: report.inputToDisplayReceiveMs.complete,
    inputToAuthoritativeVisualFenceMs: report.inputToAuthoritativeVisualFenceMs.complete,
    inputToPredictionSubmissionMs: report.inputToPredictionSubmissionMs.complete,
    inputToPredictionPaintMs: report.inputToPredictionPaintMs.complete,
  };
}

function requireCompleteCount(metric: TerminalLatencyPercentiles, count: number): void {
  expect(metric.complete).toBe(true);
  expect(metric.count).toBe(count);
}

function requireTail(
  metric: TerminalLatencyPercentiles,
  count: number,
  p95: number,
  p99: number,
  worst: number,
): void {
  expect(metric.complete).toBe(true);
  expect(metric.count).toBeGreaterThanOrEqual(count);
  expect(metric.p95 ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(p95);
  expect(metric.p99 ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(p99);
  expect(metric.max ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(worst);
}

function assertCleanDirectHop(stats: ProxyImpairmentStats, targetRttMs: number): void {
  expect(stats.config.targetRttMs).toBe(targetRttMs);
  expect(stats.config.baseDelayUs).toBe((targetRttMs * 1_000) / 4);
  expect(stats.config.jitterRadiusUs).toBe(EDGE_NETWORK_PROFILES[PROFILE].oneWayJitterUs / 4);
  expect(stats.config.datagramLossPercent).toBe(0);
  expect(stats.config.reorder).toBe('none');
  expect(stats.config.scenario).toBe('steady');
  expect(stats.pendingScheduledPackets).toBe(0);
  expect(stats.harnessDrops).toEqual({
    oversized: 0,
    admission: 0,
    leaseExhausted: 0,
    listenerMismatch: 0,
  });
  for (const direction of [stats.upstream, stats.downstream]) {
    // A heartbeat/handshake-only direct path is not enough to certify a phase.
    expect(direction.forwarded).toBeGreaterThanOrEqual(20);
    expect(direction.dropped).toBe(0);
    expect(direction.actualResidenceUs.count).toBeGreaterThan(0);
    expect(direction.actualResidenceUs.p50).toBeGreaterThanOrEqual(
      (targetRttMs * 1_000) / 4 - EDGE_NETWORK_PROFILES[PROFILE].oneWayJitterUs / 4,
    );
    expect(direction.releaseEarlyCount).toBe(0);
    expect(direction.releaseOvershootUs.p95).toBeLessThanOrEqual(2_000);
    expect(direction.releaseOvershootUs.p99).toBeLessThanOrEqual(5_000);
    expect(direction.releaseOvershootUs.max).toBeLessThanOrEqual(10_000);
    expect(direction.scheduledDelayUs.min).toBeGreaterThanOrEqual(
      stats.config.baseDelayUs - stats.config.jitterRadiusUs,
    );
    expect(direction.scheduledDelayUs.max).toBeLessThanOrEqual(
      stats.config.baseDelayUs + stats.config.jitterRadiusUs,
    );
  }
}

function directHopCounters(
  hops: readonly ProxyImpairmentStats[],
): readonly DirectRedrawSegmentHopCounters[] {
  return hops.map((hop) => ({
    epoch: hop.epoch,
    upstreamForwarded: hop.upstream.forwarded,
    downstreamForwarded: hop.downstream.forwarded,
  }));
}

async function requireCurrentViewportMarker(page: Page, marker: string): Promise<void> {
  await waitForDirectTuiViewportMarker(marker, {
    read: () => page.evaluate(readDirectTuiViewportSnapshot),
    assertReaderIdentity: () => requireDirectWorkerIdentity(page),
    wait: (delayMs) => page.waitForTimeout(delayMs),
    timeoutMs: DIRECT_VIEWPORT_MARKER_TIMEOUT_MS,
    pollIntervalMs: DIRECT_VIEWPORT_MARKER_POLL_MS,
  });
}

async function latchDirectWorkerIdentity(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __merkurTerminalPerfReadViewportText?: () => Promise<string>;
      __merkurDirectCalibrationViewportReader?: () => Promise<string>;
    };
    const reader = scope.__merkurTerminalPerfReadViewportText;
    if (typeof reader !== 'function') {
      throw new Error('terminal profiling viewport reader is unavailable for identity fencing');
    }
    const existing = scope.__merkurDirectCalibrationViewportReader;
    if (existing !== undefined && existing !== reader) {
      throw new Error('terminal profiling worker changed before its identity was latched');
    }
    scope.__merkurDirectCalibrationViewportReader = reader;
  });
}

async function requireDirectWorkerIdentity(page: Page): Promise<void> {
  const stable = await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __merkurTerminalPerfReadViewportText?: () => Promise<string>;
      __merkurDirectCalibrationViewportReader?: () => Promise<string>;
    };
    return (
      typeof scope.__merkurTerminalPerfReadViewportText === 'function' &&
      scope.__merkurTerminalPerfReadViewportText === scope.__merkurDirectCalibrationViewportReader
    );
  });
  if (!stable) throw new Error('terminal profiling worker identity changed after calibration');
}

async function resetDirectObservation(
  page: Page,
  terminalPerf: TerminalPerfFixture,
): Promise<void> {
  await requireDirectWorkerIdentity(page);
  await terminalPerf.reset();
  await requireDirectWorkerIdentity(page);
}

async function snapshotDirectObservation(
  page: Page,
  terminalPerf: TerminalPerfFixture,
): Promise<TerminalPerfSnapshot> {
  await requireDirectWorkerIdentity(page);
  const snapshot = await terminalPerf.snapshot();
  await requireDirectWorkerIdentity(page);
  return snapshot;
}

function intervals(timestamps: readonly number[]): number[] {
  const sorted = [...timestamps].sort((left, right) => left - right);
  return sorted.slice(1).map((atMs, index) => atMs - (sorted[index] ?? atMs));
}

function directPhaseDiagnostics(events: readonly TerminalPerfEvent[]): {
  readonly worstRafInterval: { readonly atMs: number; readonly gapMs: number } | null;
  readonly slowestWebglSyncReadiness: {
    readonly renderSeq: number;
    readonly renderEndAtMs: number;
    readonly frameCompleteAtMs: number;
    readonly renderEndToFrameCompleteMs: number;
    readonly pollCount: number;
    readonly previousPollAtMs: number;
    readonly displayInputSeq: number;
    readonly predictionInputSeq: number;
  } | null;
  readonly maximumInputInterarrivalMs: number | null;
} {
  const cadence = events.filter(
    (event): event is Extract<TerminalPerfEvent, { kind: 'main_frame_cadence' }> =>
      event.kind === 'main_frame_cadence',
  );
  const worstRaf = cadence.reduce<(typeof cadence)[number] | null>(
    (worst, event) => (worst === null || event.gapMs > worst.gapMs ? event : worst),
    null,
  );
  const renderEndBySeq = new Map(
    events
      .filter(
        (event): event is Extract<TerminalPerfEvent, { kind: 'render_end' }> =>
          event.kind === 'render_end',
      )
      .map((event) => [event.renderSeq, event] as const),
  );
  let slowestWebglSyncReadiness: ReturnType<
    typeof directPhaseDiagnostics
  >['slowestWebglSyncReadiness'] = null;
  for (const frame of events) {
    if (frame.kind !== 'frame_complete') continue;
    const renderEnd = renderEndBySeq.get(frame.renderSeq);
    if (renderEnd === undefined || frame.atMs < renderEnd.atMs) continue;
    const candidate = {
      renderSeq: frame.renderSeq,
      renderEndAtMs: renderEnd.atMs,
      frameCompleteAtMs: frame.atMs,
      renderEndToFrameCompleteMs: frame.atMs - renderEnd.atMs,
      pollCount: frame.pollCount,
      previousPollAtMs: frame.previousPollAtMs,
      displayInputSeq: frame.displayInputSeq,
      predictionInputSeq: frame.predictionInputSeq,
    };
    if (
      slowestWebglSyncReadiness === null ||
      candidate.renderEndToFrameCompleteMs > slowestWebglSyncReadiness.renderEndToFrameCompleteMs
    ) {
      slowestWebglSyncReadiness = candidate;
    }
  }
  const inputInterarrivals = intervals(
    events.filter((event) => event.kind === 'input_queued').map((event) => event.atMs),
  );
  return {
    worstRafInterval: worstRaf === null ? null : { atMs: worstRaf.atMs, gapMs: worstRaf.gapMs },
    slowestWebglSyncReadiness,
    maximumInputInterarrivalMs:
      inputInterarrivals.length === 0 ? null : Math.max(...inputInterarrivals),
  };
}

function eventCounts(events: readonly TerminalPerfEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  return counts;
}

function latestConfidentDisplayPeriod(
  events: readonly TerminalPerfEvent[],
): DirectRefreshPeriodCalibration | null {
  const latestSessionStartAtMs = events.reduce(
    (latest, event) =>
      event.kind === 'session_start' && Number.isFinite(event.atMs)
        ? Math.max(latest, event.atMs)
        : latest,
    Number.NEGATIVE_INFINITY,
  );
  let calibration: DirectRefreshPeriodCalibration | null = null;
  for (const event of events) {
    if (
      event.kind !== 'render_start' ||
      event.atMs < latestSessionStartAtMs ||
      !Number.isFinite(event.atMs) ||
      !Number.isFinite(event.refreshPeriodMs) ||
      event.refreshPeriodMs <= 0 ||
      !Number.isFinite(event.refreshConfidence01) ||
      event.refreshConfidence01 < 0.5 ||
      (calibration !== null && event.atMs <= calibration.sourceAtMs)
    ) {
      continue;
    }
    calibration = {
      sourceAtMs: event.atMs,
      periodMs: event.refreshPeriodMs,
      confidence01: event.refreshConfidence01,
    };
  }
  return calibration;
}

async function captureDisplayPeriodCalibration(
  snapshot: TerminalPerfSnapshot,
  calibrationMeasurementId: number,
  source: ReturnType<typeof sourceProvenance>,
  testInfo: TestInfo,
): Promise<DirectDisplayPeriodCalibrationEvidence> {
  const rawArtifact = 'direct-display-period-calibration-events.json.gz' as const;
  const evidenceArtifact = 'direct-display-period-calibration.json' as const;
  const raw = gzipSync(Buffer.from(JSON.stringify(snapshot.events)));
  const rawSha256 = createHash('sha256').update(raw).digest('hex');
  await attachDirectArtifact(testInfo, rawArtifact, {
    body: raw,
    contentType: 'application/gzip',
  });
  const reportSha256 = createHash('sha256').update(JSON.stringify(snapshot.report)).digest('hex');
  const calibration = latestConfidentDisplayPeriod(snapshot.events);
  const ringBoundaries = snapshot.events.filter(
    (event): event is Extract<TerminalPerfEvent, { kind: 'display_ring_measurement_boundary' }> =>
      event.kind === 'display_ring_measurement_boundary' &&
      event.measurementId === calibrationMeasurementId,
  );
  const sourceEvents =
    calibration === null
      ? []
      : snapshot.events.filter(
          (event): event is Extract<TerminalPerfEvent, { kind: 'render_start' }> =>
            event.kind === 'render_start' &&
            event.atMs === calibration.sourceAtMs &&
            event.refreshPeriodMs === calibration.periodMs &&
            event.refreshConfidence01 === calibration.confidence01,
        );
  const errors = validateRecorderMetadata(snapshot.recorder).map((error) => `recorder: ${error}`);
  let applicationDisplayOutcome: ReturnType<typeof collectApplicationDisplayOutcome> | null = null;
  let replay: ReturnType<typeof verifyRawTerminalPerfTrace> | null = null;
  try {
    applicationDisplayOutcome = collectApplicationDisplayOutcome(snapshot.events);
    errors.push(
      ...validateApplicationDisplayOutcomeEvidence(
        applicationDisplayOutcome,
        false,
        true,
        true,
      ).map((error) => `application display outcome invalid: ${error}`),
    );
    replay = verifyRawTerminalPerfTrace(
      raw,
      snapshot.events.length,
      snapshot.report,
      applicationDisplayOutcome,
    );
  } catch (error) {
    errors.push(
      `raw calibration replay failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (calibration === null) {
    errors.push('no confident render-start display-period calibration exists');
  } else if (sourceEvents.length !== 1) {
    errors.push(
      `fixed display-period tuple resolves to ${sourceEvents.length} raw render-start events`,
    );
  }
  const sourceEvent = sourceEvents.length === 1 ? (sourceEvents[0] ?? null) : null;
  const ringStarts = ringBoundaries.filter((event) => event.phase === 'start');
  const ringEnds = ringBoundaries.filter((event) => event.phase === 'end');
  if (ringStarts.length !== 1 || ringEnds.length !== 1) {
    errors.push(
      `calibration measurement ${calibrationMeasurementId} has ${ringStarts.length} ring START and ${ringEnds.length} ring END boundaries`,
    );
  }
  const sessionEpochs = new Set(ringBoundaries.map((event) => event.sessionEpoch));
  const observationEpochs = new Set(ringBoundaries.map((event) => event.observationEpoch));
  if (sessionEpochs.size !== 1 || observationEpochs.size !== 1) {
    errors.push('calibration measurement ring boundaries do not share one session/observation');
  }
  const sessionEpoch =
    sessionEpochs.size === 1 ? (sessionEpochs.values().next().value ?? null) : null;
  const observationEpoch =
    observationEpochs.size === 1 ? (observationEpochs.values().next().value ?? null) : null;
  const ringStart = ringStarts.length === 1 ? (ringStarts[0] ?? null) : null;
  const ringEnd = ringEnds.length === 1 ? (ringEnds[0] ?? null) : null;
  if (
    sourceEvent !== null &&
    (ringStart === null ||
      ringEnd === null ||
      sourceEvent.atMs <= ringStart.atMs ||
      sourceEvent.atMs >= ringEnd.atMs)
  ) {
    errors.push('fixed display-period source event is not strictly inside its calibration window');
  }
  if (
    sourceEvent !== null &&
    snapshot.events.some(
      (event) => event.kind === 'session_start' && event.atMs >= sourceEvent.atMs,
    )
  ) {
    errors.push('terminal session changed at or after the fixed display-period source event');
  }
  const capturedAtMs = snapshot.recorder.capturedAtMs;
  if (
    sourceEvent !== null &&
    (capturedAtMs === null || !Number.isFinite(capturedAtMs) || sourceEvent.atMs > capturedAtMs)
  ) {
    errors.push('fixed display-period source event is outside its recorder capture');
  }
  const link: DirectDisplayPeriodCalibrationLink = {
    rawArtifact,
    evidenceArtifact,
    rawSha256,
    reportSha256,
    eventCount: snapshot.events.length,
    sourceEvent,
    recorderCapturedAtMs: capturedAtMs,
    calibrationMeasurementId,
    observationEpoch,
    sessionEpoch,
    workerIdentityFence: 'same-page-strict-viewport-reader-reference',
  };
  await attachDirectArtifact(testInfo, evidenceArtifact, {
    body: Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 1,
          boundary:
            'lossless pre-workload terminal observation; the fixed tuple is copied from the linked raw render_start and is never recalibrated from a judged workload',
          source,
          calibration,
          link,
          report: snapshot.report,
          applicationDisplayOutcome,
          replay:
            replay === null
              ? null
              : {
                  eventCount: replay.eventCount,
                  reportSha256: replay.reportSha256,
                  applicationDisplayOutcomeSha256: replay.applicationDisplayOutcomeSha256,
                },
          recorder: snapshot.recorder,
          captureErrors: errors,
          eventCounts: eventCounts(snapshot.events),
        },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });
  return { calibration, link, errors };
}

function requireLosslessProofCapture(
  snapshot: TerminalPerfSnapshot,
  proofCutAtMs: number,
  label: string,
  calibration: DirectDisplayPeriodCalibrationLink,
): number {
  const recorderErrors = validateRecorderMetadata(snapshot.recorder);
  if (recorderErrors.length > 0) {
    throw new Error(`${label} proof recorder is incomplete: ${recorderErrors.join('; ')}`);
  }
  const lineageErrors = fixedSessionLineageErrors(snapshot.events, calibration);
  if (lineageErrors.length > 0) {
    throw new Error(`${label} proof lineage is invalid: ${lineageErrors.join('; ')}`);
  }
  const capturedAtMs = snapshot.recorder.capturedAtMs;
  if (capturedAtMs === null || !Number.isFinite(capturedAtMs) || capturedAtMs < proofCutAtMs) {
    throw new Error(`${label} proof capture does not cover its post-viewport cut`);
  }
  return capturedAtMs;
}

function fixedSessionLineageErrors(
  events: readonly TerminalPerfEvent[],
  calibration: DirectDisplayPeriodCalibrationLink,
): string[] {
  const errors: string[] = [];
  if (calibration.sessionEpoch === null || calibration.sourceEvent === null) {
    errors.push('fixed display-period calibration session lineage is unavailable');
    return errors;
  }
  const calibrationSourceAtMs = calibration.sourceEvent.atMs;
  const ringBoundaries = events.filter(
    (event): event is Extract<TerminalPerfEvent, { kind: 'display_ring_measurement_boundary' }> =>
      event.kind === 'display_ring_measurement_boundary',
  );
  if (ringBoundaries.length === 0) {
    errors.push('phase contains no worker display-ring session boundary');
  } else if (ringBoundaries.some((event) => event.sessionEpoch !== calibration.sessionEpoch)) {
    errors.push(
      `phase display-ring session differs from calibrated epoch ${calibration.sessionEpoch}`,
    );
  }
  if (
    events.some((event) => event.kind === 'session_start' && event.atMs >= calibrationSourceAtMs)
  ) {
    errors.push('terminal session changed after the fixed display-period calibration');
  }
  return errors;
}

function sourceProvenance(externalTools: DirectTuiExternalToolsEvidence): {
  head: string;
  trackedDiffSha256: string;
  harnessSha256: Readonly<Record<string, string>>;
  externalTools: DirectTuiExternalToolsEvidence;
  diagnosticWorkload: DirectDiagnosticWorkload | null;
  completeSuitePopulation: boolean;
  diagnosticGpuTrace: boolean;
  networkSetup: {
    directProfile: EdgeNetworkProfileName;
    directTargetRttMs: number;
    companionBaseProfile: string | null;
    companionActualRttMs: number;
    companionExplicitRttMs: number | null;
    companionRole: string | null;
  };
} {
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    trackedDiffSha256: createHash('sha256')
      .update(execFileSync('git', ['diff', 'HEAD', '--binary']))
      .digest('hex'),
    harnessSha256: Object.fromEntries(
      [
        'tests/e2e/terminal-direct-latency.e2e.ts',
        'tests/e2e/fixtures/direct-artifacts.ts',
        'tests/e2e/fixtures/direct-cdp-trace.ts',
        'scripts/analyze-terminal-gpu-trace.ts',
        'tests/e2e/fixtures/direct-frame-control.ts',
        'tests/e2e/fixtures/direct-neovim-transactions.ts',
        'tests/e2e/fixtures/direct-network-proxy.ts',
        'tests/e2e/fixtures/direct-redraw-coverage.ts',
        'tests/e2e/fixtures/direct-segmented-redraw.ts',
        'tests/e2e/fixtures/direct-tui-workloads.ts',
        'tests/e2e/fixtures/direct-typing-populations.ts',
        'tests/e2e/fixtures/direct-typing-cadence.ts',
        'tests/e2e/fixtures/direct-workload-plan.ts',
        'tests/e2e/fixtures/daemon-perf-trace-capture.ts',
        'tests/e2e/fixtures/native-display-boundaries.ts',
        'packages/shared/src/native-perf-trace.ts',
        'tests/e2e/fixtures/presentation-measurement-boundary.ts',
        'apps/web/src/terminal/profiling-viewport-read.ts',
        'playwright.edge.config.mjs',
        'target/rust/release/merkur-edge',
        'target/rust/release/delay_proxy',
        'apps/daemon/dist/merkur-dataplane',
        'apps/web/src/term-wasm/pkg/term_wasm.js',
        'apps/web/src/term-wasm/pkg/term_wasm_bg.wasm',
        'packages/e2e-wasm/pkg/e2e_wasm.js',
        'packages/e2e-wasm/pkg/e2e_wasm_bg.wasm',
      ].map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]),
    ),
    externalTools,
    diagnosticWorkload: WORKLOAD_SELECTION.diagnosticWorkload,
    completeSuitePopulation: WORKLOAD_SELECTION.completeSuitePopulation,
    diagnosticGpuTrace: DIRECT_GPU_TRACE,
    networkSetup: {
      directProfile: PROFILE,
      directTargetRttMs: EDGE_NETWORK_PROFILES[PROFILE].targetRttMs,
      companionBaseProfile: process.env.EDGE_NETWORK_PROFILE ?? null,
      companionActualRttMs: Number(process.env.EDGE_NETWORK_TARGET_RTT_MS),
      companionExplicitRttMs:
        process.env.EDGE_NETWORK_COMPANION_RTT_MS === undefined
          ? null
          : Number(process.env.EDGE_NETWORK_COMPANION_RTT_MS),
      companionRole: process.env.EDGE_NETWORK_ROLE ?? null,
    },
  };
}

function integerEnvironment(name: string, defaultValue: number, maximum: number): number {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
    throw new Error(`${name} must be in 1..${maximum}`);
  return value;
}

function directProfile(): EdgeNetworkProfileName {
  const value = process.env.DIRECT_NETWORK_PROFILE ?? 'fast';
  if (value !== 'fast' && value !== 'typical' && value !== 'difficult')
    throw new Error('invalid DIRECT_NETWORK_PROFILE');
  return value;
}
