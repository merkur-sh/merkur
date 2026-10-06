/**
 * Focused actual-delivery EXPERIMENT, not the full terminal acceptance matrix.
 * The runner selects two detached product binaries; this driver never changes
 * packing policy, PTY scheduling, crypto, compression or browser presentation.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import type { TerminalPerfEvent } from '../../apps/web/src/perf/terminal-latency';
import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';
import { attachDirectArtifact } from './fixtures/direct-artifacts';
import { DIRECT_PROXY_DIAL_MARKER, startDirectNetworkProxy } from './fixtures/direct-network-proxy';
import { readDirectTuiViewportSnapshot } from './fixtures/direct-tui-workloads';
import {
  PACKING_INTER_WINDOW_QUIET_MS,
  packingInputOwnership,
} from './fixtures/packing-delivery-inputs';
import { requirePackingRunIdentity } from './fixtures/packing-delivery-provenance';
import {
  type PackingDeliveryShape,
  packingDeliveryApplication,
  packingExpectedViewport,
} from './fixtures/packing-delivery-workload';
import {
  collectApplicationDisplayOutcome,
  validateApplicationDisplayOutcomeEvidence,
  validateRecorderMetadata,
} from './fixtures/terminal-perf-artifacts';
import { verifyRawTerminalPerfTrace } from './fixtures/terminal-perf-replay';

const SHAPES: Record<string, PackingDeliveryShape> = {
  'ordinary-styled': { cols: 120, rows: 40, entropy: false },
  'maximum-styled': { cols: 384, rows: 256, entropy: false },
  'maximum-entropy': { cols: 384, rows: 256, entropy: true },
};
const shapeName = process.env.PACKING_SHAPE;
const shape = shapeName === undefined ? undefined : SHAPES[shapeName];
const population = process.env.PACKING_POPULATION;
const offsetMs = Number(process.env.PACKING_OFFSET_MS);
const samples = Number(process.env.PACKING_SAMPLES ?? 100);
const seed = Number(process.env.DIRECT_NETWORK_SEED);
if (
  !shape ||
  (population !== 'bulk-only' && population !== 'overlap-row' && population !== 'overlap-header') ||
  (population === 'bulk-only'
    ? process.env.PACKING_OFFSET_MS !== undefined
    : ![1, 8, 16].includes(offsetMs)) ||
  !Number.isInteger(samples) ||
  samples < 100 ||
  samples > 200 ||
  !Number.isInteger(seed) ||
  seed < 0 ||
  seed > 0xffff_ffff
)
  throw new Error(
    'packing delivery requires exact shape, bulk-only or overlap-row/header population, overlap-only 1/8/16ms offset, u32 seed, n100..200',
  );

test.use({
  trace: 'off',
  video: 'off',
  linkedDaemonContextOptions: {
    viewport: { width: 1600, height: 1000 },
    serviceWorkers: 'block',
  },
});
test.setTimeout(600_000);

test('whole-span contender preserves bulk and overlapping authoritative feedback', async ({
  page,
  linkedDaemon,
  terminalPerf,
  browserName,
}, testInfo) => {
  if (
    process.env.FORCE_EDGE !== '0' ||
    process.env.EDGE_NETWORK_ACTIVE !== '1' ||
    Number(process.env.EDGE_NETWORK_TARGET_RTT_MS) <= 50
  )
    throw new Error('packing delivery requires real Direct50 and a slower emulated companion edge');
  if (!shape) throw new Error('missing shape');
  if (population !== 'bulk-only' && population !== 'overlap-row' && population !== 'overlap-header')
    throw new Error('missing exact packing population');
  const interval = population === 'bulk-only' ? null : offsetMs;
  if (interval !== null && interval !== 1 && interval !== 8 && interval !== 16)
    throw new Error('missing exact packing input interval');
  const manifestPath = process.env.PACKING_RUN_MANIFEST;
  if (!manifestPath) throw new Error('packing delivery requires a durable pinned run manifest');
  const manifest = readFileSync(manifestPath);
  const manifestHash = hash(manifest);
  const browserExecutable = process.env.PACKING_BROWSER_BINARY;
  if (browserExecutable === undefined) throw new Error('missing sealed browser executable');
  const executionIdentity = requirePackingRunIdentity(
    process.cwd(),
    browserExecutable,
    manifestPath,
  );
  const dials: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith(DIRECT_PROXY_DIAL_MARKER)) dials.push(message.text());
  });
  if (browserName === 'chromium')
    await page
      .context()
      .grantPermissions(['local-network-access'], { origin: new URL(page.url()).origin });
  const proxy = await startDirectNetworkProxy(
    page.context(),
    linkedDaemon.webTransportPort,
    'fast',
    seed,
  );
  const applicationPath = testInfo.outputPath('packing-application.cjs');
  const statusPath = testInfo.outputPath('packing-application-status.json');
  const app = packingDeliveryApplication(shape, statusPath);
  const windows: unknown[] = [];
  let launched = false;
  let firstError: unknown = null;
  try {
    writeFileSync(applicationPath, app);
    await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
    await expectConnected(page, 40_000);
    await expect(page.getByText(/^Direct(?: · \d+ms)?$/).first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.insertText(
      `stty -echo -icanon min 1 time 0; ${shellQuote(executionIdentity.bun.path)} ${shellQuote(applicationPath)}; stty sane\n`,
    );
    launched = true;
    await fitViewport(page, statusPath, shape);
    await terminalPerf.settlePresentation();
    const ready = await page.evaluate(readDirectTuiViewportSnapshot);
    expect(ready.text).toContain(`PACK-READY ${shape.cols}x${shape.rows}`);
    expect(dials.length).toBe(1);
    expect(proxy.sourceHashes.length).toBe(1);
    for (let sample = 0; sample < samples; sample++) {
      // Full viewport/artifact work is outside the measured population and is
      // followed by the same predeclared quiet interval in both arms. This is
      // a control boundary, not a claim that engine GC/thermal state resets.
      await page.waitForTimeout(PACKING_INTER_WINDOW_QUIET_MS);
      // Each exact window is durably drained before a fresh observation. This
      // bounds recorder occupancy without resetting the peer planning model.
      await terminalPerf.reset();
      await proxy.settledStats();
      await proxy.reset();
      const measurementId = await terminalPerf.beginPresentationMeasurement('coherent-redraw');
      await page.keyboard.type('r');
      if (interval !== null) {
        await page.waitForTimeout(interval);
        await page.keyboard.type(population === 'overlap-row' ? 'x' : 'h');
      }
      await terminalPerf.endPresentationMeasurement(measurementId);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const snapshot = await terminalPerf.snapshot();
      const raw = gzipSync(JSON.stringify(snapshot.events));
      const name = `packing-window-${String(sample).padStart(3, '0')}`;
      // Write evidence BEFORE validation, including a failing/censored window.
      await attachDirectArtifact(testInfo, `${name}.events.json.gz`, {
        body: raw,
        contentType: 'application/gzip',
      });
      const outcome = collectApplicationDisplayOutcome(snapshot.events);
      const replay = verifyRawTerminalPerfTrace(
        raw,
        snapshot.events.length,
        snapshot.report,
        outcome,
      );
      const errors = [
        ...validateRecorderMetadata(snapshot.recorder),
        ...validateApplicationDisplayOutcomeEvidence(outcome, false, true, true),
      ];
      const inputs = snapshot.events.filter(
        (e): e is Extract<TerminalPerfEvent, { kind: 'input_queued' }> => e.kind === 'input_queued',
      );
      let inputOwnership: ReturnType<typeof packingInputOwnership> | null = null;
      try {
        inputOwnership = packingInputOwnership(snapshot.events, population, interval);
      } catch (error) {
        errors.push(String(error));
      }
      const applied = snapshot.events.filter(
        (e) => e.kind === 'worker_display_applied' && e.authoritativeVisualMutation,
      );
      const rowCount = applied.reduce(
        (sum, event) => sum + (event.kind === 'worker_display_applied' ? event.rowCount : 0),
        0,
      );
      if (rowCount < shape.rows)
        errors.push('window did not apply the required full row population');
      const viewport = await page.evaluate(readDirectTuiViewportSnapshot);
      const expectedViewport = packingExpectedViewport(
        shape,
        sample + 1,
        population === 'overlap-row' ? sample + 1 : 0,
        population === 'overlap-header' ? sample : 0,
      );
      if (viewport.text !== expectedViewport)
        errors.push('post-window grid does not match every expected application cell');
      const network = await proxy.settledStats();
      const evidence = {
        sample,
        planningState:
          sample === 0 ? 'first-genuine-session-redraw-diagnostic' : 'self-learned-trajectory',
        measurementId,
        population,
        inputOwnership,
        requestedOffsetMs: interval,
        actualInputOffsetMs: inputs[0] && inputs[1] ? inputs[1].atMs - inputs[0].atMs : null,
        inputs,
        appliedRows: rowCount,
        replay,
        rawSha256: hash(raw),
        outcome,
        recorder: snapshot.recorder,
        report: snapshot.report,
        viewport: {
          sha256: hash(viewport.text),
          requestedAtMs: viewport.requestedAtMs,
          completedAtMs: viewport.completedAtMs,
        },
        network,
        errors,
      };
      windows.push(evidence);
      await attachDirectArtifact(testInfo, `${name}.json`, {
        body: Buffer.from(JSON.stringify(evidence)),
        contentType: 'application/json',
      });
      if (errors.length) throw new Error(errors.join('; '));
    }
    await page.keyboard.type('q');
    launched = false;
    await terminalPerf.settlePresentation();
    const appRecords = readFileSync(`${statusPath}.events.json`);
    await attachDirectArtifact(testInfo, 'packing-application-events.json', {
      body: appRecords,
      contentType: 'application/json',
    });
    await terminalPerf.finalizeGridConvergence();
  } catch (error) {
    firstError = error;
  } finally {
    // All app I/O and tty restoration are outside judged windows. No telemetry
    // dump, viewport query, network polling or file read runs between the pair.
    if (launched) {
      try {
        await page.keyboard.type('q');
        await page.waitForTimeout(100);
      } catch (error) {
        firstError ??= error;
      }
    }
    await attachDirectArtifact(testInfo, 'packing-run.json', {
      body: Buffer.from(
        JSON.stringify({
          scope:
            'instrumented actual-delivery experiment; browser-observed GPU fence is not photons',
          productionAccepted: false,
          nativeVerdict: 'inconclusive-three-capture-p99-failures',
          shapeName,
          shape,
          samples,
          population,
          requestedOffsetMs: interval,
          interWindowQuietMs: PACKING_INTER_WINDOW_QUIET_MS,
          seed,
          manifestHash,
          executionIdentity,
          applicationSha256: hash(app),
          dials,
          transportWorkerHashes: proxy.sourceHashes,
          completedWindows: windows.length,
          error: firstError === null ? null : String(firstError),
        }),
      ),
      contentType: 'application/json',
    });
    try {
      await proxy.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== null) throw firstError;
});

async function fitViewport(
  page: Page,
  statusPath: string,
  target: PackingDeliveryShape,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    let size: { rows: number; cols: number } | undefined;
    await expect
      .poll(() => {
        try {
          size = JSON.parse(readFileSync(statusPath, 'utf8')).actual;
          return Boolean(size?.rows && size.cols);
        } catch {
          return false;
        }
      })
      .toBe(true);
    if (!size) throw new Error('application omitted PTY dimensions');
    if (size.cols === target.cols && size.rows === target.rows) return;
    const canvas = await page.locator('canvas').first().boundingBox();
    const viewport = page.viewportSize();
    if (!canvas || !viewport) throw new Error('terminal viewport dimensions unavailable');
    const width = Math.round(
      viewport.width + ((target.cols - size.cols) * canvas.width) / size.cols,
    );
    const height = Math.round(
      viewport.height + ((target.rows - size.rows) * canvas.height) / size.rows,
    );
    if (width < 300 || height < 300 || width > 8000 || height > 8000)
      throw new Error('packing viewport exceeds bounded fixture dimensions');
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
  }
  throw new Error('could not fit exact declared terminal grid');
}

const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
