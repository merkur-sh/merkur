import type {
  TerminalLatencyReport,
  TerminalPerfEvent,
} from '../../apps/web/src/perf/terminal-latency';
import { appConnection, expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';
import { startTerminalGpuTraceWindow } from './fixtures/direct-cdp-trace';
import { pixelCounts } from './fixtures/graphics-pixels';
import { readWebGpuIdentity } from './fixtures/webgpu-identity';

const EDGE_NETWORK_ACTIVE = process.env.EDGE_NETWORK_ACTIVE === '1';
const TERMINAL_GPU_TRACE = process.env.TERMINAL_GPU_TRACE === '1';
const EXPECTED_TARGET_RTT_MS = Number(
  EDGE_NETWORK_ACTIVE ? (process.env.EDGE_NETWORK_TARGET_RTT_MS ?? 0) : 0,
);
const EXPECTED_ONE_WAY_JITTER_MS = Number(
  EDGE_NETWORK_ACTIVE ? (process.env.EDGE_NETWORK_ONE_WAY_JITTER_MS ?? 0) : 0,
);
const EXPECTED_DATAGRAM_LOSS_PERCENT = Number(
  EDGE_NETWORK_ACTIVE ? (process.env.EDGE_NETWORK_DATAGRAM_LOSS_PERCENT ?? 0) : 0,
);
const EXPECT_RELAY = process.env.FORCE_EDGE !== '0';
const HAS_LOSS = EXPECTED_DATAGRAM_LOSS_PERCENT > 0;
const IMPAIRED = EDGE_NETWORK_ACTIVE;
const EXPECT_PREDICTION = EXPECTED_TARGET_RTT_MS >= 50;
const MIN_COMPLETE_RATIO = 0.95;
const MIN_PREDICTION_QUEUE_RATIO = 0.95;
// The bounded one-row shadow intentionally stops before the right margin and
// never predicts Enter or wrapped-row mutations. Keep a separate eligibility
// floor for that fail-closed model, then require strong coverage of the actions
// it actually accepted.
const MIN_PREDICTION_ELIGIBILITY_RATIO = 0.7;
const MIN_PREDICTION_COVERAGE_RATIO = 0.85;
const MIN_SAMPLES = 180;

// These are GPU-fence upper bounds, not compositor/scan-out claims. The proxy
// target is the four-leg browser -> daemon -> browser RTT, not twice one proxy
// hop. Loss gets a quarter-RTT of recovery headroom; ACKs get half because they
// consistently carry the wider tail.
const RECEIVE_P95_LIMIT_MS = IMPAIRED
  ? Math.max(
      100,
      50 +
        EXPECTED_TARGET_RTT_MS +
        (HAS_LOSS ? EXPECTED_TARGET_RTT_MS * 0.25 : EXPECTED_ONE_WAY_JITTER_MS),
    )
  : 25;
const APPLY_P95_LIMIT_MS = IMPAIRED ? RECEIVE_P95_LIMIT_MS + 16 : 30;
const AUTHORITATIVE_VISUAL_GPU_FENCE_P95_LIMIT_MS = IMPAIRED ? RECEIVE_P95_LIMIT_MS + 50 : 50;
const ACK_P95_LIMIT_MS = IMPAIRED
  ? Math.max(
      150,
      100 +
        EXPECTED_TARGET_RTT_MS +
        (HAS_LOSS ? EXPECTED_TARGET_RTT_MS * 0.5 : EXPECTED_ONE_WAY_JITTER_MS),
    )
  : 100;
const WORKER_HANDOFF_P95_LIMIT_MS = 8;
const APPLY_TO_GPU_FENCE_P95_LIMIT_MS = 50;
const PREDICTION_GPU_FENCE_P95_LIMIT_MS = 50;

for (const scene of ['pristine', 'deleted', 'offscreen'] as const) {
  test(`terminal input remains responsive and observable end to end [${scene}]${TERMINAL_GPU_TRACE ? ' [diagnostic GPU trace; no timing acceptance]' : ''}`, async ({
    page,
    browser,
    linkedDaemon,
    terminalPerf,
  }) => {
    if (TERMINAL_GPU_TRACE)
      test.info().annotations.push({
        type: 'diagnostic-only',
        description: 'CDP Dawn tracing; timing acceptance ineligible',
      });
    const gpu = await readWebGpuIdentity(page);
    await test.info().attach('webgpu-adapter-probe.json', {
      body: JSON.stringify(gpu),
      contentType: 'application/json',
    });
    test.skip(
      gpu.softwareEvidence !== null,
      'wall-clock latency budgets require a GPU; see docs/performance.md',
    );
    await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
    await expectConnected(page, 20_000);
    const startupSnapshot = await terminalPerf.snapshot();
    const startupAttempt = startupSnapshot.report.startup.attempts.at(-1);
    expect(startupSnapshot.report.startup.complete, 'startup trace must be causally valid').toBe(
      true,
    );
    expect(
      startupAttempt?.complete,
      'CONNECTED must follow the first authoritative visual GPU fence',
    ).toBe(true);
    expect(
      startupAttempt?.displayApplyToVisibleMs,
      'startup telemetry must distinguish CPU apply from GPU completion',
    ).not.toBeNull();
    if (EXPECT_RELAY) {
      await expect(
        page.getByText(/^Relay(?: · \d+ms)?$/).first(),
        'latency measurements must stay pinned to the edge relay',
      ).toBeVisible({ timeout: 20_000 });
    }

    // Exercise the return to text after the full native/asset/GPU path was active.
    // Screenshots occur before the measurement window and prove actual pixels,
    // rather than treating an upload acknowledgement as successful presentation.
    if (scene !== 'pristine') {
      await page.keyboard.type(
        "printf '\\033[2J\\033[H\\033_Ga=T,f=32,s=1,v=1,i=987,c=8,r=4,C=1,q=2;/wAA/w==\\033\\\\'\n",
      );
      await expect.poll(async () => (await pixelCounts(page)).red).toBeGreaterThan(1000);
      if (scene === 'deleted') {
        await page.keyboard.type("printf '\\033_Ga=d,d=A,q=2\\033\\\\'\n");
      } else {
        // Retain the image in scrollback, outside the visible viewport.
        await page.keyboard.type('python3 -c \'import os; os.write(1, b"\\n" * 128)\'\n');
      }
      await expect.poll(async () => (await pixelCounts(page)).red).toBe(0);
    }

    // The daemon/PTY is worker-scoped, so this test can inherit a full viewport
    // after the preceding interaction matrix. Clear it and wait for the exact
    // authoritative input high-water mark before opening the measurement
    // window. Otherwise a startup/resize snapshot or a full-screen scroll can
    // correctly invalidate speculative cursor state and turn this into a
    // scrollback test rather than an interactive-latency test.
    //
    // The portable fixture deliberately runs `/bin/sh`, which does not emit an
    // editor boundary on every platform. End priming with bracketed-paste enable
    // so this high-RTT test exercises the daemon's fresh-boundary + PTY-state
    // prediction gate; production zsh/fish/readline editors emit the same
    // semantic boundary themselves.
    await terminalPerf.reset();
    await page.keyboard.type("printf '\\033[2J\\033[H__merkur_latency_ready__\\n\\033[?2004h'\n");
    await expect
      .poll(
        async () => {
          const prime = await terminalPerf.snapshot();
          const latestInputSeq = prime.events.reduce(
            (latest, event) =>
              event.kind === 'input_queued' ? Math.max(latest, event.inputSeq) : latest,
            0,
          );
          return (
            latestInputSeq > 0 &&
            prime.events.some(
              (event) =>
                event.kind === 'worker_display_applied' && event.inputSeq >= latestInputSeq,
            )
          );
        },
        {
          timeout: 20_000,
          intervals: [10, 25, 50, 100],
          message: 'latency viewport priming never reached authoritative display',
        },
      )
      .toBe(true);
    // A continuously nonempty shadow keeps the visibility it had at admission.
    // Train on three edits, let their echoes settle, then erase them before the
    // measurement. With no outstanding ops the next edit can take the learned
    // visibility gate without changing any existing speculative pixels.
    if (EXPECT_PREDICTION) {
      await page.keyboard.type('abc', { delay: 12 });
      await expect
        .poll(
          async () => {
            const prime = await terminalPerf.snapshot();
            const latestInputSeq = prime.events.reduce(
              (latest, event) =>
                event.kind === 'input_queued' ? Math.max(latest, event.inputSeq) : latest,
              0,
            );
            return (
              prime.events.some(
                (event) => event.kind === 'prediction_gate' && event.state === 'visible',
              ) &&
              prime.events.some(
                (event) =>
                  event.kind === 'frame_complete' && event.displayInputSeq >= latestInputSeq,
              )
            );
          },
          {
            timeout: 20_000,
            message: 'prediction priming must establish trust and authoritative echo',
          },
        )
        .toBe(true);
      for (let index = 0; index < 3; index += 1) await page.keyboard.press('Backspace');
      await expect
        .poll(
          async () => {
            const prime = await terminalPerf.snapshot();
            const latestInputSeq = prime.events.reduce(
              (latest, event) =>
                event.kind === 'input_queued' ? Math.max(latest, event.inputSeq) : latest,
              0,
            );
            return prime.events.some(
              (event) => event.kind === 'frame_complete' && event.displayInputSeq >= latestInputSeq,
            );
          },
          { timeout: 20_000, message: 'prediction priming erasure must reach a GPU fence' },
        )
        .toBe(true);
    }
    await terminalPerf.reset();
    // This stream measures first feedback for each individual edit. It does not
    // open one logical-workload window around all 192 keys: assigning that
    // window's final fence to each earlier key would fold later typing time into
    // an alleged per-key completion latency. Exact trigger-to-final-fence and
    // window-start-to-final-fence are gated by terminal-performance-matrix's
    // explicitly bounded workloads instead.
    // Exercise several input/refresh phases. A fixed 12ms cadence and 42 samples
    // made p99 equal the maximum and could accidentally phase-lock with a 60/120Hz
    // renderer; this produces 192 samples with fast-repeat, ordinary, and
    // deliberate cadences while remaining one deterministic shell command.
    // A 4ms phase generated a 250Hz serial-key stream (paste uses chunked input
    // instead) and measured deterministic loss-repair backlog rather than felt
    // interactive latency, so the fastest human-interaction phase stays at 10ms.
    //
    // Alternate bounded insert/delete runs instead of crossing the right margin.
    // A margin rejection is deliberately unmodelled: exact wire provenance then
    // revokes the daemon's editor boundary until the shell emits a fresh one.
    // Continuing to count keys after that safety boundary would profile remote
    // authority, not the shadow terminal. The cycles below keep all 191 editable
    // inputs inside one row and exercise both printable and Backspace prediction.
    // Diagnostic capture does not change the driver, carrier, or input population.
    // Stop before assertions so a reproduced latency failure retains its trace.
    const trace = TERMINAL_GPU_TRACE
      ? await startTerminalGpuTraceWindow(browser, page, test.info())
      : null;
    let snapshot: Awaited<ReturnType<typeof terminalPerf.snapshot>>;
    try {
      await page.keyboard.type('echo merkur-transport-latency-', { delay: 12 });
      await page.keyboard.type('0123456789'.repeat(4), { delay: 10 });
      for (let index = 0; index < 40; index += 1) {
        await page.keyboard.press('Backspace', { delay: 10 });
      }
      await page.keyboard.type('abcdef0123'.repeat(4), { delay: 12 });
      for (let index = 0; index < 40; index += 1) {
        await page.keyboard.press('Backspace', { delay: 25 });
      }
      await page.keyboard.press('Enter');

      const deadline = Date.now() + 20_000;
      snapshot = await terminalPerf.snapshot();
      while (!isComplete(snapshot.report) && Date.now() < deadline) {
        await page.waitForTimeout(250);
        snapshot = await terminalPerf.snapshot();
      }
    } finally {
      await trace?.stop();
    }
    if (TERMINAL_GPU_TRACE) {
      // This diagnostic run is intentionally not an acceptance test, even if all
      // timing thresholds happen to pass. Its normal raw recorder remains intact.
      return;
    }
    const { report } = snapshot;
    const measurementSnapshots = snapshot.events.filter(
      (event): event is Extract<TerminalPerfEvent, { kind: 'display_received' }> =>
        event.kind === 'display_received' && event.displayKind === 'display_snapshot',
    );
    expect(
      measurementSnapshots.every((event) => event.inputSeq > 0),
      'a loss-recovery snapshot after priming must preserve authoritative input lineage',
    ).toBe(true);

    const diagnostic = JSON.stringify({
      samples: report.sampleCount,
      predictionPaints: report.inputToPredictionPaintMs.count,
      predictionEligible: report.inputToPredictionPaintMs.eligibleCount,
      predictionCoverage: report.inputToPredictionPaintMs.coverageRatio,
      authoritativeVisualGpuFences: report.inputToAuthoritativeVisualFenceMs.count,
      inputAcks: report.inputAckMs.count,
      displayReceives: report.inputToDisplayReceiveMs.count,
      receiveQueues: report.displayReceiveToWorkerQueueMs.count,
      displayApplies: report.inputToDisplayApplyMs.count,
      queueApplies: report.workerQueueToDisplayApplyMs.count,
      applyPaints: report.displayApplyToPaintMs.count,
      // The apply-to-paint decomposition. Reported rather than gated: these terms
      // have never been measured, so any p95 limit chosen now would be a number
      // invented to match this hardware. Their sum is already bounded by
      // APPLY_TO_GPU_FENCE_P95_LIMIT_MS.
      applyToPaintP95: report.displayApplyToPaintMs.p95,
      applyToRenderStartP50: report.displayApplyToRenderStartMs.p50,
      applyToRenderStartP95: report.displayApplyToRenderStartMs.p95,
      submitCpuP50: report.renderStartToRenderEndMs.p50,
      submitCpuP95: report.renderStartToRenderEndMs.p95,
      submitCpuSteadyP50: report.renderInstrumentation.renderStartToRenderEndSteadyMs.p50,
      fenceObservedP50: report.renderEndToDisplayPaintMs.p50,
      fenceObservedP95: report.renderEndToDisplayPaintMs.p95,
      lastUnreadyPollP50: report.renderEndToLastUnreadyPollMs.p50,
      lastUnreadyPollP95: report.renderEndToLastUnreadyPollMs.p95,
      fenceObservationP50: report.fenceObservationIntervalMs.p50,
      fenceObservationP95: report.fenceObservationIntervalMs.p95,
      gates: {
        immediate: report.renderGate.immediateCount,
        fence: report.renderGate.fenceCount,
        opportunity: report.renderGate.opportunityCount,
        fenceAndOpportunity: report.renderGate.fenceAndOpportunityCount,
        unknown: report.renderGate.unknownCount,
      },
      fenceGateWaitP95: report.renderGate.fenceGateWaitMs.p95,
      opportunityGateWaitP95: report.renderGate.opportunityGateWaitMs.p95,
      opportunityDelayRequestedP95: report.renderGate.opportunityDelayRequestedMs.p95,
      opportunityPeriodP50: report.renderGate.opportunityPeriodMs.p50,
      opportunityLowConfidenceRatio: report.renderGate.opportunityLowConfidenceRatio,
      renderInstrumentation: report.renderInstrumentation,
    });
    const requiredMetrics = [
      ['input acknowledgement', report.inputAckMs],
      ['display receive', report.inputToDisplayReceiveMs],
      ['receive-to-worker queue', report.displayReceiveToWorkerQueueMs],
      ['worker queue-to-apply', report.workerQueueToDisplayApplyMs],
      ['display apply', report.inputToDisplayApplyMs],
      ['authoritative visual GPU fence', report.inputToAuthoritativeVisualFenceMs],
      ['display apply-to-GPU fence', report.displayApplyToPaintMs],
    ] as const;
    for (const [name, metric] of requiredMetrics) {
      expect(metric.complete, `${name} telemetry must be complete; ${diagnostic}`).toBe(true);
    }
    expect(report.sampleCount, diagnostic).toBeGreaterThanOrEqual(MIN_SAMPLES);
    expect(report.inputToAuthoritativeVisualFenceMs.count, diagnostic).toBeGreaterThanOrEqual(
      Math.ceil(report.sampleCount * MIN_COMPLETE_RATIO),
    );
    expect(report.inputAckMs.count, diagnostic).toBeGreaterThanOrEqual(
      Math.ceil(report.sampleCount * MIN_COMPLETE_RATIO),
    );
    expect(report.inputToDisplayReceiveMs.count, diagnostic).toBeGreaterThanOrEqual(
      Math.ceil(report.sampleCount * MIN_COMPLETE_RATIO),
    );
    expect(report.inputToDisplayApplyMs.count, diagnostic).toBeGreaterThanOrEqual(
      Math.ceil(report.sampleCount * MIN_COMPLETE_RATIO),
    );
    expect(report.displayReceiveToWorkerQueueMs.count, diagnostic).toBeGreaterThanOrEqual(
      Math.ceil(report.sampleCount * MIN_COMPLETE_RATIO),
    );
    expect(report.workerQueueToDisplayApplyMs.count, diagnostic).toBeGreaterThanOrEqual(
      Math.ceil(report.sampleCount * MIN_COMPLETE_RATIO),
    );
    expect(report.displayApplyToPaintMs.count, diagnostic).toBeGreaterThanOrEqual(
      Math.ceil(report.sampleCount * MIN_COMPLETE_RATIO),
    );

    const minimumQueuedPredictions = Math.ceil(report.sampleCount * MIN_PREDICTION_QUEUE_RATIO);
    const minimumEligiblePredictions = Math.ceil(
      report.sampleCount * MIN_PREDICTION_ELIGIBILITY_RATIO,
    );
    const minimumCoveredPredictions = Math.ceil(
      report.inputToPredictionPaintMs.eligibleCount * MIN_PREDICTION_COVERAGE_RATIO,
    );
    const queuedPredictionSeqs = new Set(
      snapshot.events
        .filter(
          (event): event is Extract<TerminalPerfEvent, { kind: 'prediction_queued' }> =>
            event.kind === 'prediction_queued' &&
            Number.isSafeInteger(event.inputSeq) &&
            event.inputSeq > 0,
        )
        .map((event) => event.inputSeq),
    );
    const appliedPredictionSeqs = new Set(
      snapshot.events
        .filter(
          (event): event is Extract<TerminalPerfEvent, { kind: 'prediction_applied' }> =>
            event.kind === 'prediction_applied' &&
            Number.isSafeInteger(event.inputSeq) &&
            event.inputSeq > 0,
        )
        .map((event) => event.inputSeq),
    );

    const expectP95AtMost = (
      name: string,
      metric: { readonly p95: number | null },
      limitMs: number,
    ): void => {
      expect(
        metric.p95 ?? Number.POSITIVE_INFINITY,
        `${name} p95 exceeded ${limitMs}ms; ${diagnostic}`,
      ).toBeLessThanOrEqual(limitMs);
    };

    // Assert individual browser stages before their aggregate so a regression
    // names the queue or paint boundary that actually caused it.
    expectP95AtMost(
      'display receive-to-worker queue',
      report.displayReceiveToWorkerQueueMs,
      WORKER_HANDOFF_P95_LIMIT_MS,
    );
    expectP95AtMost(
      'worker queue-to-authoritative apply',
      report.workerQueueToDisplayApplyMs,
      WORKER_HANDOFF_P95_LIMIT_MS,
    );
    expectP95AtMost(
      'authoritative apply-to-GPU fence',
      report.displayApplyToPaintMs,
      APPLY_TO_GPU_FENCE_P95_LIMIT_MS,
    );

    // The decomposition of that stage is deliberately NOT gated on a p95 -- these
    // sub-terms are newly measured and any limit would be arbitrary. What is
    // gated is that the decomposition remains structurally sound, because the
    // failure mode is silent: a protocol-validator regression drops the render
    // events entirely and the terms would simply report nothing.
    let decomposedSampleCount = 0;
    for (const sample of report.samples) {
      const { displayApplyToRenderStartMs, renderStartToRenderEndMs, renderEndToDisplayPaintMs } =
        sample;
      if (
        displayApplyToRenderStartMs === null ||
        renderStartToRenderEndMs === null ||
        renderEndToDisplayPaintMs === null ||
        sample.displayApplyToPaintMs === null
      ) {
        continue;
      }
      decomposedSampleCount += 1;
      // Three subtractions of the same doubles differ from one only in the last ulp.
      expect(
        displayApplyToRenderStartMs + renderStartToRenderEndMs + renderEndToDisplayPaintMs,
        `apply-to-paint sub-stages must partition the whole stage; ${diagnostic}`,
      ).toBeCloseTo(sample.displayApplyToPaintMs, 6);
      if (sample.renderEndToLastUnreadyPollMs !== null) {
        expect(
          sample.renderEndToLastUnreadyPollMs,
          `the last unready poll cannot follow the readiness observation; ${diagnostic}`,
        ).toBeLessThanOrEqual(renderEndToDisplayPaintMs);
      }
    }
    expect(
      decomposedSampleCount,
      `at least one sample must decompose, or the render event stream is not arriving; ${diagnostic}`,
    ).toBeGreaterThan(0);
    // A `task-yield` completion is a scheduler task boundary, not a GPU signal.
    // Chromium here always has real fences, so a non-zero count means a fence
    // claim was about to be contaminated.
    expect(
      report.renderInstrumentation.noFenceRenderCount,
      `this harness must observe real GPU fences, not task-yield completions; ${diagnostic}`,
    ).toBe(0);
    expectP95AtMost(
      'input-to-authoritative display receive',
      report.inputToDisplayReceiveMs,
      RECEIVE_P95_LIMIT_MS,
    );
    expectP95AtMost(
      'input-to-authoritative display apply',
      report.inputToDisplayApplyMs,
      APPLY_P95_LIMIT_MS,
    );
    expectP95AtMost(
      'input-to-authoritative visual GPU fence',
      report.inputToAuthoritativeVisualFenceMs,
      AUTHORITATIVE_VISUAL_GPU_FENCE_P95_LIMIT_MS,
    );
    expectP95AtMost('input acknowledgement', report.inputAckMs, ACK_P95_LIMIT_MS);

    if (EXPECT_PREDICTION) {
      expect(
        report.inputToPredictionPaintMs.complete,
        'exact prediction telemetry must not be malformed or truncated',
      ).toBe(true);
      expect(
        queuedPredictionSeqs.size,
        'high-RTT printable inputs must enter the bounded prediction queue',
      ).toBeGreaterThanOrEqual(minimumQueuedPredictions);
      expect(
        report.inputToPredictionPaintMs.eligibleCount,
        'the bounded shadow must accept most non-wrapping high-RTT edits',
      ).toBeGreaterThanOrEqual(minimumEligiblePredictions);
      expect(
        appliedPredictionSeqs.size,
        'the terminal worker must apply high-RTT prediction actions',
      ).toBeGreaterThanOrEqual(minimumCoveredPredictions);
      expect(
        report.inputToPredictionPaintMs.count,
        'accepted high-RTT predictions must retain GPU-complete provenance',
      ).toBeGreaterThanOrEqual(minimumCoveredPredictions);
      expect(
        report.inputToPredictionPaintMs.coverageRatio ?? 0,
        'accepted predictions must retain exact visible provenance through GPU completion',
      ).toBeGreaterThanOrEqual(MIN_PREDICTION_COVERAGE_RATIO);
      expect(
        report.inputToPredictionPaintMs.p95 ?? Number.POSITIVE_INFINITY,
        'a visible local prediction must reach GPU completion within the local-stage budget',
      ).toBeLessThanOrEqual(PREDICTION_GPU_FENCE_P95_LIMIT_MS);
    } else if (report.inputToPredictionPaintMs.count > 0) {
      expect(
        report.inputToPredictionPaintMs.p95 ?? Number.POSITIVE_INFINITY,
        'a visible local prediction must reach GPU completion within the local-stage budget',
      ).toBeLessThanOrEqual(PREDICTION_GPU_FENCE_P95_LIMIT_MS);
    }

    if (EDGE_NETWORK_ACTIVE) {
      expect(report.inputToDisplayReceiveMs.p50 ?? 0).toBeGreaterThanOrEqual(
        EXPECTED_TARGET_RTT_MS - EXPECTED_ONE_WAY_JITTER_MS,
      );
    }

    await page.waitForTimeout(12_000);
    const stableSnapshot = await terminalPerf.snapshot();
    const unstableTransitions = stableSnapshot.events.filter(
      (event) =>
        event.kind === 'transport_state' &&
        (event.state === 'disconnected' || event.state === 'signaling_reconnecting'),
    );
    expect(unstableTransitions, 'the impaired edge path should remain connected').toEqual([]);
    await expect(appConnection(page)).resolves.toBe('connected');
  });
}

function isComplete(report: TerminalLatencyReport): boolean {
  const minimumEligiblePredictions = Math.ceil(
    report.sampleCount * MIN_PREDICTION_ELIGIBILITY_RATIO,
  );
  const minimumCoveredPredictions = Math.ceil(
    report.inputToPredictionPaintMs.eligibleCount * MIN_PREDICTION_COVERAGE_RATIO,
  );
  const predictionComplete =
    !EXPECT_PREDICTION ||
    (report.inputToPredictionPaintMs.complete &&
      report.inputToPredictionPaintMs.eligibleCount >= minimumEligiblePredictions &&
      report.inputToPredictionPaintMs.count >= minimumCoveredPredictions &&
      (report.inputToPredictionPaintMs.coverageRatio ?? 0) >= MIN_PREDICTION_COVERAGE_RATIO);
  const requiredMetricsComplete =
    report.inputAckMs.complete &&
    report.inputToDisplayReceiveMs.complete &&
    report.displayReceiveToWorkerQueueMs.complete &&
    report.workerQueueToDisplayApplyMs.complete &&
    report.inputToDisplayApplyMs.complete &&
    report.inputToAuthoritativeVisualFenceMs.complete &&
    report.displayApplyToPaintMs.complete &&
    report.displayApplyToRenderStartMs.complete &&
    report.renderStartToRenderEndMs.complete &&
    report.renderEndToDisplayPaintMs.complete;
  // The decomposition's failure mode is silence: a protocol-validator regression
  // drops the render events and the sub-terms simply report nothing, which looks
  // identical to a passing run. Every frame that COMPLETED must therefore have
  // found both of its halves. Deliberately not compared against
  // `gpuQueueRenderCount`: a render submitted just before capture has been
  // counted there but has no completion yet, which the impaired run showed as a
  // legitimate 137-of-138. The "enough samples decomposed" half of the check is
  // the `renderEndToDisplayPaintMs` ratio below.
  const instrumentation = report.renderInstrumentation;
  const joinComplete =
    instrumentation.missingRenderStartCount === 0 && instrumentation.missingRenderEndCount === 0;
  return (
    requiredMetricsComplete &&
    joinComplete &&
    report.sampleCount >= MIN_SAMPLES &&
    report.inputToAuthoritativeVisualFenceMs.count >= report.sampleCount * MIN_COMPLETE_RATIO &&
    report.inputAckMs.count >= report.sampleCount * MIN_COMPLETE_RATIO &&
    report.inputToDisplayReceiveMs.count >= report.sampleCount * MIN_COMPLETE_RATIO &&
    report.inputToDisplayApplyMs.count >= report.sampleCount * MIN_COMPLETE_RATIO &&
    report.displayReceiveToWorkerQueueMs.count >= report.sampleCount * MIN_COMPLETE_RATIO &&
    report.workerQueueToDisplayApplyMs.count >= report.sampleCount * MIN_COMPLETE_RATIO &&
    report.displayApplyToPaintMs.count >= report.sampleCount * MIN_COMPLETE_RATIO &&
    report.renderEndToDisplayPaintMs.count >= report.sampleCount * MIN_COMPLETE_RATIO &&
    predictionComplete
  );
}
