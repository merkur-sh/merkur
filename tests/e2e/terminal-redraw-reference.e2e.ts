import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ConsoleMessage, Locator, Page, Route } from '@playwright/test';
import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';
import {
  analyzeReferenceRedrawContent,
  summarizeReferenceRedrawContent,
} from './fixtures/reference-redraw-content';
import {
  instrumentReferenceRenderContent,
  parseReferenceRenderContent,
  type ReferenceRenderContent,
} from './fixtures/reference-render-content';
import {
  analyzeReferenceRedrawTrace,
  normalizeReferenceTerminalEvents,
  type ReferenceRedrawWindow,
  summarizeReferenceRedrawSamples,
  TERMINAL_REDRAW_REFERENCE_RAW_SCHEMA_VERSION,
  TERMINAL_REDRAW_REFERENCE_SCHEMA_VERSION,
} from './fixtures/terminal-redraw-reference';
import { readWebGpuIdentity } from './fixtures/webgpu-identity';

const SAMPLE_COUNT = positiveIntegerEnvironment('REFERENCE_REDRAW_SAMPLE_COUNT', 100, 500);
const PROFILE = process.env.REFERENCE_REDRAW_PROFILE ?? 'unknown';
const OUTPUT =
  process.env.REFERENCE_REDRAW_OUTPUT ?? `/tmp/merkur-redraw-reference-${PROFILE}.json`;
const TARGET_RTT_MS = nonNegativeNumberEnvironment('REFERENCE_REDRAW_TARGET_RTT_MS', 0);
const BASE_DELAY_US = nonNegativeNumberEnvironment('REFERENCE_REDRAW_BASE_DELAY_US', 0);
const JITTER_RADIUS_US = nonNegativeNumberEnvironment('REFERENCE_REDRAW_JITTER_RADIUS_US', 0);
const ONE_WAY_JITTER_MS = JITTER_RADIUS_US > 0 ? (JITTER_RADIUS_US * 4) / 1_000 : 0;
const DATAGRAM_LOSS_PERCENT = nonNegativeNumberEnvironment(
  'REFERENCE_REDRAW_DATAGRAM_LOSS_PERCENT',
  0,
);
const REORDER = process.env.REFERENCE_REDRAW_REORDER ?? 'none';
const SCENARIO = process.env.REFERENCE_REDRAW_SCENARIO ?? 'steady';
const SEED = nonNegativeNumberEnvironment('REFERENCE_REDRAW_SEED', 0);
const PRE_TRIGGER_QUIET_MS = Math.max(100, Math.ceil(TARGET_RTT_MS / 2 + ONE_WAY_JITTER_MS + 50));
const POST_MARKER_TAIL_MS = Math.max(
  150,
  Math.ceil(TARGET_RTT_MS + ONE_WAY_JITTER_MS + 4 * (1_000 / 60)),
);
const ROWS_PER_SAMPLE = 240;
const VISIBLE_COLUMNS_PER_ROW = 104;

test.setTimeout(
  Math.max(240_000, SAMPLE_COUNT * (PRE_TRIGGER_QUIET_MS + POST_MARKER_TAIL_MS + 1_000)),
);

test('large redraw reference distinguishes content changes from identical GPU submissions', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  const contentObserver = await installContentObserver(page);
  try {
    await page.context().grantPermissions(['local-network-access'], {
      origin: new URL(page.url()).origin,
    });
    await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
    await expectConnected(page, 40_000);
    const output = page.getByRole('log', { name: 'Terminal output' });
    const nonce = randomBytes(5).toString('hex');
    const quietMarker = `redraw-reference-quiet-${nonce}`;

    await page.keyboard.insertText(
      `saved_ps1=$PS1; PS1=; stty -echo; printf '%s\\n' 'row-0123456789abcdefghijklmnopqrstuvwxyz' '${quietMarker}'\n`,
    );
    await expectExactMarker(output, quietMarker, 30_000);
    await page.waitForTimeout(PRE_TRIGGER_QUIET_MS);

    // The one recorder/proxy cut for the entire run. No snapshot or worker dump
    // occurs inside the sample loop, so trace size cannot perturb later samples.
    await terminalPerf.reset();
    const recordingStartedAtMs = await browserNowMs(page);
    const gpu = await readWebGpuIdentity(page);
    const windows: ReferenceRedrawWindow[] = [];

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const suffix = `${nonce}-${String(index).padStart(3, '0')}`;
      const readyMarker = `redraw-reference-ready-${suffix}`;
      const finalMarker = `redraw-reference-final-${suffix}`;
      const fill = String(index % 10).repeat(96);

      // Stage the complete logical redraw behind one silent canonical read. The
      // subsequent Enter is therefore the sole input admitted inside the window.
      await page.keyboard.insertText(
        `printf '%s\\n' '${readyMarker}'; IFS= read -r _merkur_redraw_go; ` +
          `i=0; while [ $i -lt ${ROWS_PER_SAMPLE} ]; do ` +
          `printf 'row-%03d-${fill}\\n' "$i"; i=$((i+1)); done; ` +
          `printf '%s\\n' '${finalMarker}'\n`,
      );
      await expectExactMarker(output, readyMarker, 30_000);
      await page.waitForTimeout(PRE_TRIGGER_QUIET_MS);

      const openedAtMs = await browserNowMs(page);
      await page.keyboard.press('Enter');
      const triggerDispatchCompletedAtMs = await browserNowMs(page);
      await expectExactMarker(output, finalMarker, 30_000);
      // Marker visibility is terminal-state evidence, not a GPU or delivery
      // fence. Observe a bounded tail and validate it from the final raw trace.
      await page.waitForTimeout(POST_MARKER_TAIL_MS);
      const closedAtMs = await browserNowMs(page);
      windows.push({
        index,
        readyMarker,
        finalMarker,
        openedAtMs,
        triggerDispatchCompletedAtMs,
        closedAtMs,
      });
    }

    const dumpRequestedAtMs = await browserNowMs(page);
    const dump = await readOneFinalWorkerDump(page);
    const dumpCompletedAtMs = await browserNowMs(page);
    const allCommonEvents = normalizeReferenceTerminalEvents(dump.events);
    const commonEvents = allCommonEvents.filter((event) => event.atMs >= recordingStartedAtMs);
    const samples = analyzeReferenceRedrawTrace(windows, commonEvents);
    contentObserver.assertComplete();
    const contentSamples = analyzeReferenceRedrawContent(
      samples,
      commonEvents,
      contentObserver.observations,
    );
    expect(samples).toHaveLength(SAMPLE_COUNT);
    const recordsLost = numericProperty(dump.stats, 'recordsLost');
    expect(recordsLost, 'the shared perf rings lost records during the reference capture').toBe(0);

    const source = sourceProvenance();
    const rawPath = rawArtifactPath(OUTPUT);
    const rawBody = Buffer.from(
      `${JSON.stringify({
        schemaVersion: TERMINAL_REDRAW_REFERENCE_RAW_SCHEMA_VERSION,
        metricBoundary:
          'browser input_queued to worker-observed WebGL GPU command-completion fence; not compositor, vsync, scan-out, or physical photons',
        capture: {
          recordingStartedAtMs,
          dumpRequestedAtMs,
          dumpCompletedAtMs,
        },
        windows,
        events: commonEvents,
        workerEvents: dump.events,
        displayDiagnostics: contentObserver.diagnostics,
        contentObservations: contentObserver.observations,
        telemetryWorkerStats: dump.stats,
      })}\n`,
    );
    const compressedRaw = gzipSync(rawBody, { level: 9 });
    atomicWrite(rawPath, compressedRaw);

    const artifact = {
      schemaVersion: TERMINAL_REDRAW_REFERENCE_SCHEMA_VERSION,
      metricContractVersion: 3,
      instrumentation: {
        purpose: 'semantic-content coherence only; never uninstrumented latency acceptance',
        observer:
          'exact authoritative row-hash words plus final cursor geometry; fixed theme/font/geometry, no prediction or atlas mutation within a window',
        cost: 'row-hash refresh plus bounded word comparison and one console record per submission; signatureComputePrefixMs excludes JSON serialization and console delivery, so is not full observer overhead',
        workerSources: contentObserver.sources,
      },
      source,
      browser: {
        name: page.context().browser()?.browserType().name() ?? null,
        version: page.context().browser()?.version() ?? null,
        headless: process.env.HEADED !== '1',
        launchFlags:
          page.context().browser()?.browserType().name() === 'chromium'
            ? ['--enable-experimental-web-platform-features', '--enable-gpu']
            : [],
        gpu,
      },
      profile: PROFILE,
      targetRttMs: TARGET_RTT_MS,
      impairment: {
        topology:
          'browser and daemon each traverse a blind edge through four seeded proxy legs per input/display application RTT',
        baseDelayUsPerLeg: BASE_DELAY_US,
        jitterRadiusUsPerLeg: JITTER_RADIUS_US,
        datagramLossPercent: DATAGRAM_LOSS_PERCENT,
        reorder: REORDER,
        scenario: SCENARIO,
        seed: SEED,
      },
      workload: {
        command:
          'print READY; block on one silent Enter; print 240 rows of 104 visible characters; print FINAL',
        rowsPerSample: ROWS_PER_SAMPLE,
        visibleColumnsPerRow: VISIBLE_COLUMNS_PER_ROW,
        preTriggerQuietMs: PRE_TRIGGER_QUIET_MS,
        postMarkerTailObservationMs: POST_MARKER_TAIL_MS,
        recorderResetCount: 1,
        workerDumpCountAfterRecordingStart: 1,
      },
      metricBoundary: {
        inputStart: 'input_queued.atMs from the browser transport admission producer',
        visibleSubUpdate:
          'contentSamples: exact render/fence join only when the observer sees a changed semantic terminal state; samples retain the conservative row-bearing submission upper bound',
        completedPresentation:
          'last such frame_complete for the exact trigger input after every row-bearing apply',
        partialPresentationExposure:
          'contentChangingObservedGpuFenceExposureMs is last minus first content-changing GPU fence; it is not a compositor or physical-photon timestamp',
        excluded:
          'render_start/render_end establish ownership and fence bounds, not presentation timestamps; task-yield completion, compositor/vsync/scan-out inference, and physical-photon claims are excluded',
      },
      sampleCount: samples.length,
      contentSummary: summarizeReferenceRedrawContent(contentSamples),
      summary: summarizeReferenceRedrawSamples(samples),
      rawTrace: {
        path: rawPath,
        compression: 'gzip',
        uncompressedBytes: rawBody.byteLength,
        compressedBytes: compressedRaw.byteLength,
        sha256: sha256(compressedRaw),
        commonEventCount: commonEvents.length,
        telemetryRecordsLost: recordsLost,
      },
      samples,
      contentSamples,
    };
    atomicWrite(OUTPUT, Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`));
  } finally {
    await contentObserver.dispose();
  }
});

async function installContentObserver(page: Page) {
  const observations: ReferenceRenderContent[] = [];
  const diagnostics: string[] = [];
  const sources: { url: string; productionSha256: string; instrumentedSha256: string }[] = [];
  let failure: Error | null = null;
  const onConsole = (message: ConsoleMessage): void => {
    if (failure !== null) return;
    try {
      const text = message.text();
      if (text.includes('wasmError=') || text.includes('display_diag') || text.includes('resync')) {
        if (diagnostics.length >= 1024)
          throw new Error('reference display diagnostic capacity exceeded');
        diagnostics.push(text);
      }
      const value = parseReferenceRenderContent(text);
      if (value === null) return;
      if (observations.length >= 16384)
        throw new Error('reference content observation capacity exceeded');
      observations.push(value);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  };
  const workerUrl = /\/terminal-worker[^/]*\.js(?:\?.*)?$/;
  const routeWorker = async (route: Route): Promise<void> => {
    const response = await route.fetch();
    if (!response.ok() || sources.length >= 4)
      throw new Error('reference terminal worker load failed');
    const production = await response.text();
    const instrumented = instrumentReferenceRenderContent(production);
    sources.push({
      url: route.request().url(),
      productionSha256: sha256(Buffer.from(production)),
      instrumentedSha256: sha256(Buffer.from(instrumented)),
    });
    await route.fulfill({ response, body: instrumented });
  };
  page.on('console', onConsole);
  await page.context().route(workerUrl, routeWorker);
  return {
    observations,
    diagnostics,
    sources,
    assertComplete(): void {
      if (failure !== null) throw failure;
      if (sources.length !== 1 || observations.length === 0)
        throw new Error('reference content capture requires one observed terminal worker');
    },
    async dispose(): Promise<void> {
      page.off('console', onConsole);
      await page.context().unroute(workerUrl, routeWorker);
    },
  };
}

async function expectExactMarker(
  output: Locator,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const entries = await output.locator('div').allTextContents();
        return entries.some((entry) =>
          entry.split(/\r?\n/).some((line) => line.trimEnd() === marker),
        );
      },
      { timeout: timeoutMs, intervals: [20, 50, 100] },
    )
    .toBe(true);
}

async function browserNowMs(page: { evaluate<T>(callback: () => T): Promise<T> }): Promise<number> {
  return page.evaluate(() => performance.timeOrigin + performance.now());
}

async function readOneFinalWorkerDump(page: {
  evaluate<T>(callback: () => Promise<T>): Promise<T>;
}): Promise<{ readonly events: readonly unknown[]; readonly stats: unknown }> {
  return page.evaluate(async () => {
    const dump = (
      globalThis as unknown as {
        __merkurPerfDump?: () => Promise<{ events?: unknown; stats?: unknown }>;
      }
    ).__merkurPerfDump;
    if (typeof dump !== 'function') throw new Error('telemetry worker dump is unavailable');
    const result = await Promise.race([
      dump(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('telemetry worker dump timed out')), 10_000);
      }),
    ]);
    if (!Array.isArray(result.events)) throw new Error('telemetry worker dump has no event array');
    return { events: result.events, stats: result.stats };
  });
}

function sourceProvenance(): {
  readonly commit: string;
  readonly dirty: boolean;
  readonly statusSha256: string;
  readonly trackedDiffSha256: string;
  readonly harnessSha256: string;
  readonly analyzerSha256: string;
  readonly contentObserverSha256: string;
  readonly contentAnalyzerSha256: string;
  readonly termWasmSha256: string;
  readonly runnerSha256: string | null;
  readonly boundaryFingerprintSha256: string;
} {
  const commit = gitOutput(['rev-parse', 'HEAD']).toString('utf8').trim();
  const status = gitOutput(['status', '--porcelain=v1']);
  const trackedDiff = gitOutput(['diff', '--binary', 'HEAD']);
  const harnessSha256 = sha256(
    readFileSync(path.join(__dirname, 'terminal-redraw-reference.e2e.ts')),
  );
  const analyzerSha256 = sha256(
    readFileSync(path.join(__dirname, 'fixtures', 'terminal-redraw-reference.ts')),
  );
  const contentObserverSha256 = sha256(
    readFileSync(path.join(__dirname, 'fixtures', 'reference-render-content.ts')),
  );
  const contentAnalyzerSha256 = sha256(
    readFileSync(path.join(__dirname, 'fixtures', 'reference-redraw-content.ts')),
  );
  const termWasmSha256 = sha256(
    readFileSync(path.resolve(__dirname, '../../packages/term-wasm/pkg/term_wasm_bg.wasm')),
  );
  const runnerPath = path.resolve(
    __dirname,
    '..',
    '..',
    'scripts',
    'run-terminal-redraw-reference.ts',
  );
  const runnerSha256 = readOptionalSha256(runnerPath);
  const statusSha256 = sha256(status);
  const trackedDiffSha256 = sha256(trackedDiff);
  return {
    commit,
    dirty: status.length > 0,
    statusSha256,
    trackedDiffSha256,
    harnessSha256,
    analyzerSha256,
    contentObserverSha256,
    contentAnalyzerSha256,
    termWasmSha256,
    runnerSha256,
    boundaryFingerprintSha256: sha256(
      [
        commit,
        statusSha256,
        trackedDiffSha256,
        harnessSha256,
        analyzerSha256,
        contentObserverSha256,
        contentAnalyzerSha256,
        termWasmSha256,
        runnerSha256 ?? 'runner-unavailable',
      ].join('\n'),
    ),
  };
}

function gitOutput(args: readonly string[]): Buffer {
  return execFileSync('git', args, { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
}

function readOptionalSha256(filePath: string): string | null {
  try {
    return sha256(readFileSync(filePath));
  } catch {
    return null;
  }
}

function rawArtifactPath(summaryPath: string): string {
  return summaryPath.endsWith('.json')
    ? `${summaryPath.slice(0, -'.json'.length)}.events.json.gz`
    : `${summaryPath}.events.json.gz`;
}

function atomicWrite(filePath: string, body: Buffer): void {
  const directory = path.dirname(path.resolve(filePath));
  mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, body, { flag: 'wx' });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function numericProperty(value: unknown, key: string): number {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`telemetry worker stats.${key} is unavailable`);
  }
  const property = (value as Record<string, unknown>)[key];
  if (typeof property !== 'number' || !Number.isFinite(property)) {
    throw new Error(`telemetry worker stats.${key} is unavailable`);
  }
  return property;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function positiveIntegerEnvironment(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be an integer in [1, ${maximum}]`);
  }
  return value;
}

function nonNegativeNumberEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
  return value;
}
