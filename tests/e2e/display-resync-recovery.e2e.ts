import { configuredProxyFaultEvidenceErrors } from '../../scripts/edge-network-stats';
import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';
import { collectApplicationDisplayOutcome } from './fixtures/terminal-perf-artifacts';

/**
 * Positive end-to-end resynchronization proof for the network matrix.
 *
 * The harness command only asks the terminal worker to enter its normal resync
 * path. Everything after that edge is production traffic: the worker posts a
 * snapshot request, main forwards it over the authenticated session, the
 * daemon encodes an authoritative snapshot, and the browser decodes, applies,
 * submits, and observes its GPU fence. This avoids relying on accidental
 * corruption or a mock handler to claim resync coverage.
 */
test('a forced profiling resync completes through an authoritative GPU-fenced snapshot', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  await expectConnected(page, 40_000);

  const marker = `resync-marker-${Date.now().toString(36)}`;
  await page.keyboard.insertText(`printf '${marker}\\n'`);
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toContainText(marker, { timeout: 20_000 });
  await terminalPerf.reset();

  // PTY writes are coalesced, so a source-side write count is not evidence
  // that any seeded fault selector fired. Generate independently flushable
  // updates in bounded rounds and inspect this reset epoch's actual proxy
  // counters before claiming loss/reorder/congestion recovery coverage.
  let impairmentErrors = ['the impairment trace was not exercised'];
  for (let attempt = 0; attempt < 10 && impairmentErrors.length > 0; attempt += 1) {
    const impairmentPrimed = `${marker}-impairment-primed-${attempt}`;
    const prime =
      `/usr/bin/python3 -c 'import os,time; ` +
      `[(os.write(1, "".join("impairment-${attempt}-%03d-%02d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n"%(i,j) ` +
      `for j in range(16)).encode()), time.sleep(0.012)) ` +
      `for i in range(96)]; os.write(1,b"\\r${impairmentPrimed}\\n")'`;
    await page.keyboard.insertText(prime);
    await page.keyboard.press('Enter');
    await expect(page.locator('body')).toContainText(impairmentPrimed, { timeout: 30_000 });
    const proxyStats = await terminalPerf.proxyImpairment();
    if (proxyStats === null) {
      impairmentErrors = ['delay proxy impairment stats are unavailable'];
      continue;
    }
    impairmentErrors = configuredProxyFaultEvidenceErrors(proxyStats, {
      requireDrained: false,
      requireConfiguredFaultsObserved: true,
    });
  }
  expect(impairmentErrors, 'configured recovery impairments were never observed').toEqual([]);
  // Priming proves the configured fault selectors fired, but must not bleed a
  // late display/fence into the exact resync window. This quiet oracle neither
  // resets the proxy epoch nor records a synthetic measurement window.
  await terminalPerf.settlePresentation();
  const measurementId = await terminalPerf.beginPresentationMeasurement('coherent-redraw');
  await terminalPerf.forceDisplayResync();

  await expect
    .poll(
      async () => {
        const { events } = await terminalPerf.snapshot();
        const resync = events.find(
          (event) => event.kind === 'display_resync' && event.reason === 'profiling_harness',
        );
        if (resync?.kind !== 'display_resync') {
          return {
            resync: false,
            received: false,
            applied: false,
            committed: false,
            fenced: false,
          };
        }
        const received = events.find(
          (event) =>
            event.kind === 'display_received' &&
            event.displayKind === 'display_snapshot' &&
            event.displaySeq === 0 &&
            event.frameId > 0 &&
            event.presentationId > 0 &&
            event.atMs >= resync.atMs,
        );
        const applied = events.find(
          (event) =>
            event.kind === 'worker_display_applied' &&
            event.displayKind === 'display_snapshot' &&
            event.displaySeq === 0 &&
            event.frameId > 0 &&
            event.presentationId > 0 &&
            received?.kind === 'display_received' &&
            event.generation === received.generation &&
            event.frameId === received.frameId &&
            event.presentationId === received.presentationId &&
            event.chunkCount === received.chunkCount &&
            event.atMs >= resync.atMs,
        );
        const commit =
          applied?.kind === 'worker_display_applied'
            ? events.find(
                (event) =>
                  event.kind === 'presentation_commit' &&
                  event.transactionSeq === applied.presentationTransactionSeq &&
                  event.authoritativeVisualChange,
              )
            : undefined;
        const fence =
          commit?.kind === 'presentation_commit'
            ? events.find(
                (event) =>
                  event.kind === 'frame_complete' &&
                  event.renderSeq === commit.renderSeq &&
                  event.atMs >= commit.atMs,
              )
            : undefined;
        return {
          resync: !resync.alreadyPending,
          received: received?.kind === 'display_received',
          applied: applied?.kind === 'worker_display_applied',
          committed: commit?.kind === 'presentation_commit',
          fenced: fence?.kind === 'frame_complete',
        };
      },
      {
        timeout: 30_000,
        intervals: [25, 50, 100, 250],
        message: 'the real snapshot resynchronization path did not reach its GPU fence',
      },
    )
    .toEqual({ resync: true, received: true, applied: true, committed: true, fenced: true });
  await terminalPerf.endPresentationMeasurement(measurementId);

  await expect(page.locator('body')).toContainText(marker);
  const snapshot = await terminalPerf.snapshot();
  expect(
    snapshot.events.filter(
      (event) => event.kind === 'display_resync' && event.reason === 'profiling_harness',
    ).length,
    'the dedicated recovery phase must record a positive, non-vacuous resync count',
  ).toBe(1);
  const outcome = collectApplicationDisplayOutcome(snapshot.events);
  expect(outcome.complete, JSON.stringify(outcome)).toBe(true);
  expect(outcome.snapshotReceivedCount, JSON.stringify(outcome)).toBe(1);
  expect(outcome.snapshotAppliedCount, JSON.stringify(outcome)).toBe(outcome.snapshotReceivedCount);
  expect(outcome.snapshotAppliedChunkCount, JSON.stringify(outcome)).toBe(
    outcome.snapshotReceivedChunkCount,
  );
  expect(outcome.appliedWithoutReceiveCount, JSON.stringify(outcome)).toBe(0);
  expect(snapshot.report.presentation.commitToGpuFenceMs.complete).toBe(true);
  expect(snapshot.report.presentation.commitToGpuFenceMs.count).toBeGreaterThanOrEqual(1);
  expect(snapshot.report.presentation.partialPresentationExposureMs.complete).toBe(true);
  const presentation = snapshot.report.presentation;
  expect(presentation.measurementWindowCount).toBe(1);
  expect(presentation.commitsPerMeasurementWindow.complete).toBe(true);
  expect(presentation.commitsPerMeasurementWindow.count).toBe(1);
  expect(presentation.commitsPerMeasurementWindow.max).toBe(1);
  expect(presentation.rowsPerMeasurementWindow.complete).toBe(true);
  expect(presentation.rowsPerMeasurementWindow.count).toBe(1);
  expect(presentation.rowsPerMeasurementWindow.p50).toBeGreaterThan(0);
  expect(presentation.datagramsPerMeasurementWindow.complete).toBe(true);
  expect(presentation.datagramsPerMeasurementWindow.count).toBe(1);
  expect(presentation.datagramsPerMeasurementWindow.p50).toBeGreaterThan(0);
  expect(presentation.measurementWindowExposureMs.complete).toBe(true);
  expect(presentation.measurementWindowExposureMs.count).toBe(1);
  expect(presentation.measurementWindowExposureMs.max).toBe(0);
  expect(presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs.complete).toBe(
    true,
  );
  expect(presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs.count).toBe(1);
  expect(presentation.firstDisplayReceiveToCompletedPresentationFenceMs.complete).toBe(true);
  expect(presentation.firstDisplayReceiveToCompletedPresentationFenceMs.count).toBe(1);

  const resync = snapshot.events.find(
    (event) => event.kind === 'display_resync' && event.reason === 'profiling_harness',
  );
  const applied = snapshot.events.find(
    (event) =>
      event.kind === 'worker_display_applied' &&
      event.displayKind === 'display_snapshot' &&
      resync?.kind === 'display_resync' &&
      event.atMs >= resync.atMs,
  );
  const commit = snapshot.events.find(
    (event) =>
      event.kind === 'presentation_commit' &&
      applied?.kind === 'worker_display_applied' &&
      event.transactionSeq === applied.presentationTransactionSeq,
  );
  const fence = snapshot.events.find(
    (event) =>
      event.kind === 'frame_complete' &&
      commit?.kind === 'presentation_commit' &&
      event.renderSeq === commit.renderSeq &&
      event.atMs >= commit.atMs,
  );
  expect(resync?.kind).toBe('display_resync');
  expect(fence?.kind).toBe('frame_complete');
  if (resync?.kind !== 'display_resync' || fence?.kind !== 'frame_complete') {
    throw new Error('resync request-to-fence evidence disappeared after presentation drain');
  }
  expect(fence.atMs - resync.atMs).toBeLessThanOrEqual(resyncFenceBudgetMs());
});

function resyncFenceBudgetMs(): number {
  const targetRttMs = finiteProfileValue(process.env.EDGE_NETWORK_TARGET_RTT_MS);
  const jitterMs = finiteProfileValue(process.env.EDGE_NETWORK_ONE_WAY_JITTER_MS);
  const maxExtraDelayMs = finiteProfileValue(process.env.EDGE_NETWORK_MAX_EXTRA_DELAY_MS);
  return Math.max(250, targetRttMs * 3 + jitterMs * 2 + maxExtraDelayMs * 2 + 150);
}

function finiteProfileValue(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid network profile value ${raw}`);
  return value;
}
