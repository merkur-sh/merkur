import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import type { Locator, Page } from '@playwright/test';
import {
  EDGE_NETWORK_PROFILES,
  type EdgeNetworkProfileName,
} from '../../scripts/edge-network-profile';
import { expectConnected } from './app-state';
import { expect, test as linkedTest } from './fixtures/daemon-process';
import { attachDirectArtifact } from './fixtures/direct-artifacts';
import { DIRECT_PROXY_DIAL_MARKER, startDirectNetworkProxy } from './fixtures/direct-network-proxy';
import {
  buildDirectRedrawLoopCommand,
  directRedrawReadyMarker,
} from './fixtures/direct-redraw-coverage';
import {
  analyzeDirectReferenceInputs,
  DIRECT_REFERENCE_CONTRACT,
  validateDirectReferenceDump,
  validateDirectReferenceInputCoverage,
  validateDirectReferenceNetworkEvidence,
  validateDirectReferenceRedrawCoverage,
} from './fixtures/direct-reference-events';
import {
  buildNeovimNavigationWorkload,
  buildTmuxSwitchWorkload,
  cleanupDirectTuiWorkload,
  type DirectTuiWorkloadPlan,
  resolveRequiredDirectTuiTools,
} from './fixtures/direct-tui-workloads';
import { installE2ETerminalPerfRecorder } from './fixtures/terminal-perf-artifacts';
import {
  analyzeReferenceRedrawTrace,
  normalizeReferenceTerminalEvents,
  type ReferenceRedrawWindow,
  referenceDistribution,
} from './fixtures/terminal-redraw-reference';
import { readWebGpuIdentity } from './fixtures/webgpu-identity';

// Auto fixture runs before linkedDaemon navigates. Do not use terminalPerf:
// its newer observation handshake is deliberately absent from release 60f.
const test = linkedTest.extend<{ commonRecorder: boolean }>({
  commonRecorder: [
    async ({ page }, use) => {
      await page.addInitScript(installE2ETerminalPerfRecorder);
      await page.evaluate(installE2ETerminalPerfRecorder);
      await use(true);
    },
    { auto: true },
  ],
});
test.use({
  linkedDaemonContextOptions: { viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' },
});
test.setTimeout(1_200_000);

const CADENCES = [0, 8, 16, 33, 80] as const;
const CLASSES = Array.from({ length: 6 }, () => [
  ...Array<string>(20).fill('printable'),
  ...Array<string>(20).fill('backspace'),
]).flat();
const PROFILE = profile();
const RTT = EDGE_NETWORK_PROFILES[PROFILE].targetRttMs;
const SEED = integer('DIRECT_REFERENCE_SEED', 1296388675);
const SAMPLES = integer('DIRECT_REFERENCE_SAMPLES', 100);
if (SAMPLES < 100 || SAMPLES > 500)
  throw new Error('Direct reference sample count must be between 100 and 500');
const TAIL_MS = RTT * 2 + 100;
const CONTROL_MIN_RAF_INTERVALS = 200;
const KEYBOARD_CONTROL_REPETITIONS = 2;
const KEYBOARD_CONTROL_CADENCE_MS = 8;
const APP_RTT_TOLERANCE_MS = EDGE_NETWORK_PROFILES[PROFILE].oneWayJitterUs / 1_000 + 10;

/**
 * Same test overlay on exact historical and final production sources. All
 * measurements consume only their existing raw intersection. The only worker
 * rewrite translates the Direct endpoint before construction; it never
 * observes/decorates terminal, display, input, decode, render or GPU methods.
 */
test('common Direct release/final typing and application comparison', async ({
  page,
  linkedDaemon,
  browserName,
}, testInfo) => {
  if (browserName !== 'chromium' || process.env.FORCE_EDGE !== '0')
    throw new Error('common Direct comparison requires Chromium and FORCE_EDGE=0');
  if (
    process.env.EDGE_NETWORK_ACTIVE !== '1' ||
    Number(process.env.EDGE_NETWORK_TARGET_RTT_MS) <= RTT
  )
    throw new Error('companion edge must be actively emulated and slower than Direct');
  const tools = resolveRequiredDirectTuiTools();
  const manifestPath = process.env.DIRECT_REFERENCE_MANIFEST;
  if (manifestPath === undefined)
    throw new Error('run through the fingerprinted Direct reference runner');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const phases: unknown[] = [];
  const phaseErrors: { phase: string; error: string }[] = [];
  const selectionProofs: unknown[] = [];
  const dials: string[] = [];
  page.on('console', (message) => {
    if (!message.text().startsWith(DIRECT_PROXY_DIAL_MARKER)) return;
    if (dials.length >= 16) throw new Error('unexpected repeated Direct dials');
    dials.push(message.text());
  });
  await page
    .context()
    .grantPermissions(['local-network-access'], { origin: new URL(page.url()).origin });
  const proxy = await startDirectNetworkProxy(
    page.context(),
    linkedDaemon.webTransportPort,
    PROFILE,
    SEED,
  );
  const capture = async (
    name: string,
    startAtMs: number,
    inputEndAtMs: number,
    inputClasses: readonly string[],
    mode: 'completeness-only' | 'latency' | 'control',
    extra: unknown = null,
    frameWindows?: readonly { readonly startAtMs: number; readonly endAtMs: number }[],
  ) => {
    await page.waitForTimeout(TAIL_MS);
    const endAtMs = await now(page);
    const proof = await outsideWindowRafProof(page);
    // Exactly one terminal trace materialization after the whole phase, none
    // between keys and none during a presentation observation.
    const window = {
      startAtMs,
      inputEndAtMs,
      endAtMs,
      proofAtMs: proof.proofAtMs,
      expectedInputCount: inputClasses.length,
    };
    const rawDump: unknown = await page.evaluate(readCommonDumpInPage);
    const body = gzipSync(
      JSON.stringify({ window, proof, workload: extra, mode, inputClasses, workerDump: rawDump }),
    );
    const rawName = `${name}.common-events.json.gz`;
    // Persist before every parser, proxy and coverage assertion so a failure
    // cannot make the common trace reporter-dependent.
    await attachDirectArtifact(testInfo, rawName, {
      body,
      contentType: 'application/gzip',
    });
    const errors: string[] = [];
    let phaseCompletion: { complete: boolean } | null = null;
    const addError = (error: unknown): void => {
      const message = errorMessage(error);
      errors.push(message);
      phaseErrors.push({ phase: name, error: message });
      if (phaseCompletion !== null) phaseCompletion.complete = false;
    };
    let dump: ReturnType<typeof validateDirectReferenceDump> | null = null;
    try {
      dump = validateDirectReferenceDump(rawDump);
    } catch (error) {
      addError(error);
    }
    const events = dump?.events ?? rawDumpEvents(rawDump);
    let report: ReturnType<typeof analyzeDirectReferenceInputs> | null = null;
    if (dump !== null && mode !== 'control') {
      try {
        report = analyzeDirectReferenceInputs(dump.events, window, inputClasses);
      } catch (error) {
        addError(error);
      }
    } else if (
      mode === 'control' &&
      events.some(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          Reflect.get(event, 'kind') === 'input_queued' &&
          typeof Reflect.get(event, 'atMs') === 'number' &&
          Number(Reflect.get(event, 'atMs')) >= startAtMs &&
          Number(Reflect.get(event, 'atMs')) <= proof.proofAtMs,
      )
    ) {
      addError(new Error('isolated control emitted terminal input'));
    }
    const browserFrames = framePopulation(events, frameWindows ?? [{ startAtMs, endAtMs }]);
    let cleanTransport: ReturnType<typeof cleanReferenceTransportEvidence> | null = null;
    try {
      cleanTransport = cleanReferenceTransportEvidence(events, startAtMs, proof.proofAtMs);
    } catch (error) {
      addError(error);
    }
    let packetCounters: Awaited<ReturnType<typeof proxy.settledStats>> | null = null;
    try {
      packetCounters = await proxy.settledStats();
    } catch (error) {
      addError(error);
    }
    try {
      await expect(page.getByText(/^Direct(?: · \d+ms)?$/).first()).toBeVisible();
    } catch (error) {
      addError(error);
    }
    const expectedClassCounts = Object.fromEntries(
      [...new Set(inputClasses)].map((inputClass) => [
        inputClass,
        inputClasses.filter((value) => value === inputClass).length,
      ]),
    );
    let coverage: ReturnType<typeof validateDirectReferenceInputCoverage> | null = null;
    if (mode !== 'control' && report !== null) {
      try {
        coverage = validateDirectReferenceInputCoverage(report, {
          mode,
          expectedClassCounts,
          minimumCausalSamplesPerClass: Math.min(100, ...Object.values(expectedClassCounts)),
          targetRttMs: RTT,
          appRttToleranceMs: APP_RTT_TOLERANCE_MS,
        });
      } catch (error) {
        addError(error);
      }
    }
    let networkEvidence: ReturnType<typeof validateDirectReferenceNetworkEvidence> | null = null;
    if (mode !== 'control' && packetCounters !== null) {
      try {
        networkEvidence = validateDirectReferenceNetworkEvidence(packetCounters, {
          profile: PROFILE,
          targetRttMs: RTT,
          baseDelayUs: RTT * 250,
          jitterRadiusUs: EDGE_NETWORK_PROFILES[PROFILE].oneWayJitterUs / 4,
          seed: SEED,
          backendPort: proxy.backendPort,
          proxyPorts: requireProxyPorts(proxy.proxyPorts),
          minimumDirectionalPackets: 20,
          dials,
          workerSources: proxy.sourceHashes,
        });
      } catch (error) {
        addError(error);
      }
    }
    const phase = {
      name,
      complete: errors.length === 0,
      errors,
      window,
      proof,
      report,
      coverage,
      browserFrames,
      packetCounters,
      networkEvidence,
      cleanTransport,
      extra,
      rawName,
      rawSha256: hash(body),
    };
    phaseCompletion = phase;
    phases.push(phase);
    await attachDirectArtifact(testInfo, `${name}.common-report.json`, {
      body: JSON.stringify(phase, null, 2),
      contentType: 'application/json',
    });
    return { events, report, browserFrames, window, proof, addError };
  };
  const control = async (position: 'before' | 'after', cadenceMs: number | null) => {
    const id = `direct-reference-control-${randomBytes(6).toString('hex')}`;
    await page.evaluate(async (id) => {
      const frame = document.createElement('iframe');
      frame.id = id;
      frame.style.cssText = 'position:fixed;left:-10000px;width:1px;height:1px;opacity:0';
      const loaded = new Promise<void>((resolve) =>
        frame.addEventListener('load', () => resolve(), { once: true }),
      );
      frame.srcdoc = '<!doctype html><textarea aria-label="Reference keyboard control"></textarea>';
      document.body.append(frame);
      await loaded;
      const input = frame.contentDocument?.querySelector('textarea');
      if (input === undefined || input === null) throw new Error('control input missing');
      input.dataset.keyboardEventCount = '0';
      input.dataset.inputEventCount = '0';
      input.addEventListener('keydown', () => {
        input.dataset.keyboardEventCount = String(
          Number(input.dataset.keyboardEventCount ?? 0) + 1,
        );
      });
      input.addEventListener('input', () => {
        input.dataset.inputEventCount = String(Number(input.dataset.inputEventCount ?? 0) + 1);
      });
      input.focus();
    }, id);
    try {
      await page.waitForTimeout(100);
      const started = await now(page);
      if (cadenceMs === null) await page.waitForTimeout(4_000);
      else {
        for (let repetition = 0; repetition < KEYBOARD_CONTROL_REPETITIONS; repetition += 1) {
          await typing(page, cadenceMs);
        }
      }
      const stopped = await now(page);
      const captured = await capture(
        `control-${position}-${cadenceMs ?? 'idle'}`,
        started,
        stopped,
        [],
        'control',
        {
          kind: cadenceMs === null ? 'idle' : 'keyboard-injection',
          cadenceMs,
          position,
          repetitions: cadenceMs === null ? 0 : KEYBOARD_CONTROL_REPETITIONS,
        },
      );
      if (captured.browserFrames.rafGapMs.count < CONTROL_MIN_RAF_INTERVALS) {
        captured.addError(
          new Error(
            `common ${position} ${cadenceMs === null ? 'idle' : 'keyboard'} control has fewer than ${CONTROL_MIN_RAF_INTERVALS} complete rAF intervals`,
          ),
        );
      }
      const dom = await page.evaluate((id) => {
        const frame = document.getElementById(id);
        const input =
          frame instanceof HTMLIFrameElement
            ? frame.contentDocument?.querySelector('textarea')
            : null;
        return {
          keyboardEventCount: Number(input?.dataset.keyboardEventCount ?? Number.NaN),
          inputEventCount: Number(input?.dataset.inputEventCount ?? Number.NaN),
          valueLength: input?.value.length ?? Number.NaN,
        };
      }, id);
      const expectedEvents = cadenceMs === null ? 0 : CLASSES.length * KEYBOARD_CONTROL_REPETITIONS;
      if (
        dom.keyboardEventCount !== expectedEvents ||
        dom.inputEventCount !== expectedEvents ||
        dom.valueLength !== 0
      ) {
        captured.addError(
          new Error('common isolated keyboard-control event population is incomplete'),
        );
      }
    } finally {
      await page.evaluate((id) => document.getElementById(id)?.remove(), id);
      await page.locator('#terminal-output').click({ position: { x: 10, y: 10 } });
    }
  };
  let primaryError: unknown = null;
  try {
    await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
    await expectConnected(page, 40_000);
    await expect(page.getByText(/^Direct(?: · \d+ms)?$/).first()).toBeVisible({ timeout: 30_000 });
    expect(dials.length).toBeGreaterThan(0);
    expect(proxy.sourceHashes.length).toBeGreaterThan(0);
    const gpu = await readWebGpuIdentity(page);
    expect(gpu.softwareEvidence, 'hardware WebGPU required for latency measurements').toBeNull();
    const browser = await browserIdentity(page);
    await attachDirectArtifact(testInfo, 'direct-reference-provenance.json', {
      body: JSON.stringify(
        {
          manifest,
          browser,
          gpu,
          tools,
          profile: PROFILE,
          targetRttMs: RTT,
          seed: SEED,
          samples: SAMPLES,
          contract: DIRECT_REFERENCE_CONTRACT,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    await page.waitForTimeout(TAIL_MS);
    await control('before', null);
    await control('before', KEYBOARD_CONTROL_CADENCE_MS);
    const output = page.getByRole('log', { name: 'Terminal output' });
    for (const cadenceMs of CADENCES) {
      await page.keyboard.press('Control+c');
      const ready = `reference-ready-${cadenceMs}-${randomBytes(4).toString('hex')}`;
      await page.keyboard.insertText(`printf '\\033[2J\\033[H${ready}\\n\\033[?2004h'\n`);
      await exactMarker(output, ready);
      await page.keyboard.type('warmup');
      for (let index = 0; index < 6; index++) await page.keyboard.press('Backspace');
      await page.waitForTimeout(TAIL_MS);
      await proxy.settledStats();
      await proxy.reset();
      const start = await now(page);
      await typing(page, cadenceMs);
      const end = await now(page);
      await capture(
        `typing-${cadenceMs}ms`,
        start,
        end,
        CLASSES,
        cadenceMs === 0 ? 'completeness-only' : 'latency',
        { kind: 'typing', cadenceMs },
      );
    }
    await page.keyboard.press('Control+c');
    const shellReady = `reference-shell-${randomBytes(4).toString('hex')}`;
    await page.keyboard.insertText(
      `_merkur_saved_ps1=$PS1; PS1=''; stty -echo; printf '\\033[2J\\033[H${shellReady}\\n'\n`,
    );
    await exactMarker(output, shellReady);
    for (const workload of [
      { name: 'small-multirow', minimumRows: 2 },
      { name: 'bounded-cat', minimumRows: 23 },
    ] as const) {
      const token = randomBytes(5).toString('hex');
      const readyPrefix = `reference-${workload.name}-ready-${token}`;
      const finalMarker = `reference-${workload.name}-done-${token}`;
      await page.keyboard.insertText(
        buildDirectRedrawLoopCommand(workload.name, readyPrefix, finalMarker, SAMPLES),
      );
      await exactMarker(output, directRedrawReadyMarker(readyPrefix, 0));
      await page.waitForTimeout(TAIL_MS);
      await proxy.settledStats();
      await proxy.reset();
      const startAtMs = await now(page);
      const windows: ReferenceRedrawWindow[] = [];
      let inputEndAtMs = startAtMs;
      for (let index = 0; index < SAMPLES; index += 1) {
        const ready = directRedrawReadyMarker(readyPrefix, index);
        const final =
          index + 1 === SAMPLES ? finalMarker : directRedrawReadyMarker(readyPrefix, index + 1);
        await exactMarker(output, ready);
        const openedAtMs = await now(page);
        await page.keyboard.press('Enter');
        const triggerDispatchCompletedAtMs = await now(page);
        inputEndAtMs = triggerDispatchCompletedAtMs;
        await page.waitForTimeout(TAIL_MS);
        windows.push({
          index,
          readyMarker: ready,
          finalMarker: final,
          openedAtMs,
          triggerDispatchCompletedAtMs,
          closedAtMs: await now(page),
        });
      }
      await exactMarker(output, finalMarker);
      const captured = await capture(
        workload.name,
        startAtMs,
        inputEndAtMs,
        Array<string>(SAMPLES).fill(workload.name),
        'latency',
        { kind: 'redraw', workload, windows },
        windows.map((window) => ({
          startAtMs: window.openedAtMs,
          endAtMs: window.closedAtMs,
        })),
      );
      try {
        const samples = analyzeReferenceRedrawTrace(
          windows,
          normalizeReferenceTerminalEvents(captured.events),
        );
        phases.push({
          name: `${workload.name}-redraw-coverage`,
          coverage: validateDirectReferenceRedrawCoverage(
            workload.name,
            samples,
            SAMPLES,
            workload.minimumRows,
          ),
          rowBearingGpuFenceSpanMs: referenceDistribution(
            samples.map((sample) => sample.partialPresentationExposureMs),
          ),
          samples,
        });
      } catch (error) {
        captured.addError(error);
      }
    }
    const tuiPlans = [
      buildTmuxSwitchWorkload(tools.tmux, randomBytes(6).toString('hex')),
      buildNeovimNavigationWorkload(tools.neovim, randomBytes(6).toString('hex')),
    ];
    for (const plan of tuiPlans) {
      if (SAMPLES % plan.operationCycleLength !== 0) {
        throw new Error(
          `Direct reference sample count must contain whole ${plan.application} operation cycles`,
        );
      }
    }
    for (const plan of tuiPlans) {
      try {
        await page.keyboard.insertText(plan.launchCommand);
        await exactMarker(output, plan.readyMarker);
        await page.keyboard.press('Enter');
        selectionProofs.push({
          application: plan.application,
          stage: 'initial',
          ...(await selectionProof(page, plan.initialViewportNeedle)),
        });
        await page.waitForTimeout(TAIL_MS);
        await proxy.settledStats();
        await proxy.reset();
        const startAtMs = await now(page);
        const windows: ReferenceRedrawWindow[] = [];
        let inputEndAtMs = startAtMs;
        for (let index = 0; index < SAMPLES; index += 1) {
          const key = plan.stepKeys[index % plan.stepKeys.length];
          if (key === undefined) throw new Error('TUI key contract missing');
          const openedAtMs = await now(page);
          await page.keyboard.press(key);
          const triggerDispatchCompletedAtMs = await now(page);
          inputEndAtMs = triggerDispatchCompletedAtMs;
          await page.waitForTimeout(TAIL_MS);
          windows.push({
            index,
            readyMarker: plan.initialViewportNeedle,
            finalMarker: plan.completedCycleViewportNeedle,
            openedAtMs,
            triggerDispatchCompletedAtMs,
            closedAtMs: await now(page),
          });
        }
        const captured = await capture(
          plan.application,
          startAtMs,
          inputEndAtMs,
          Array<string>(SAMPLES).fill(plan.application),
          'latency',
          { kind: 'tui', application: plan.application, windows },
          windows.map((window) => ({
            startAtMs: window.openedAtMs,
            endAtMs: window.closedAtMs,
          })),
        );
        try {
          const samples = analyzeReferenceRedrawTrace(
            windows,
            normalizeReferenceTerminalEvents(captured.events),
          );
          phases.push({
            name: `${plan.application}-redraw-coverage`,
            coverage: validateDirectReferenceRedrawCoverage(plan.application, samples, SAMPLES, 23),
            rowBearingGpuFenceSpanMs: referenceDistribution(
              samples.map((sample) => sample.partialPresentationExposureMs),
            ),
            samples,
          });
        } catch (error) {
          captured.addError(error);
        }
        selectionProofs.push({
          application: plan.application,
          stage: 'final',
          ...(await selectionProof(page, plan.completedCycleViewportNeedle)),
        });
        await exitTui(page, plan);
        await exactMarker(output, plan.exitMarker);
      } catch (error) {
        phaseErrors.push({ phase: `${plan.application}-lifecycle`, error: errorMessage(error) });
      } finally {
        cleanupDirectTuiWorkload(plan);
      }
    }
    await control('after', KEYBOARD_CONTROL_CADENCE_MS);
    await control('after', null);
    await attachDirectArtifact(testInfo, 'direct-reference.json', {
      body: JSON.stringify(
        {
          schema: 1,
          contract: DIRECT_REFERENCE_CONTRACT,
          profile: PROFILE,
          seed: SEED,
          targetRttMs: RTT,
          samples: SAMPLES,
          browser,
          gpu,
          tools,
          manifest,
          proxyWorkerSources: proxy.sourceHashes,
          dials,
          phases,
          selectionProofs,
          phaseErrors,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    if (phaseErrors.length > 0) {
      throw new AggregateError(
        phaseErrors.map(({ phase, error }) => new Error(`${phase}: ${error}`)),
        'common Direct reference phases failed',
      );
    }
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    await proxy.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError !== null || closeError !== null) {
    throw new AggregateError(
      [primaryError, closeError].filter(
        (error): error is NonNullable<typeof error> => error !== null,
      ),
      'common Direct reference run or teardown failed',
    );
  }
});

async function typing(page: Page, cadenceMs: number): Promise<void> {
  for (let cycle = 0; cycle < 6; cycle++) {
    await page.keyboard.type('0123456789abcdefghij', { delay: cadenceMs });
    for (let index = 0; index < 20; index++)
      await page.keyboard.press('Backspace', { delay: cadenceMs });
  }
}

async function exactMarker(output: Locator, marker: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (await output.locator('div').allTextContents()).some((entry) =>
          entry.split(/\r?\n/u).some((line) => line.trimEnd() === marker),
        ),
      { timeout: 30_000, intervals: [20, 50, 100] },
    )
    .toBe(true);
}

/** Public UI only, outside every timed phase. No viewport profiling hook. */
async function selectionProof(page: Page, needle: string) {
  const beforeDump = validateDirectReferenceDump(await page.evaluate(readCommonDumpInPage));
  const beforeInputSeqs = commonInputIdentities(beforeDump.events);
  await page.keyboard.down('Shift');
  try {
    const layer = page.locator('.terminal-selection-layer');
    await expect(layer).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => (await layer.locator(':scope > div').allTextContents()).join('\n'), {
        timeout: 30_000,
      })
      .toContain(needle);
  } finally {
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await page.keyboard.up('Shift');
    await expect(page.locator('.terminal-selection-layer')).toBeHidden();
  }
  await page.waitForTimeout(TAIL_MS);
  const proof = await outsideWindowRafProof(page);
  const afterDump = validateDirectReferenceDump(await page.evaluate(readCommonDumpInPage));
  const afterInputSeqs = commonInputIdentities(afterDump.events);
  if (JSON.stringify(afterInputSeqs) !== JSON.stringify(beforeInputSeqs)) {
    throw new Error('public selection proof emitted terminal input');
  }
  const lastAtMs = Math.max(
    ...afterDump.events.map((event) =>
      typeof event === 'object' && event !== null && typeof Reflect.get(event, 'atMs') === 'number'
        ? Number(Reflect.get(event, 'atMs'))
        : Number.NEGATIVE_INFINITY,
    ),
  );
  if (lastAtMs < proof.proofAtMs) {
    throw new Error('public selection proof lacks an outside-window retained suffix');
  }
  return {
    needle,
    beforeInputCount: beforeInputSeqs.length,
    afterInputCount: afterInputSeqs.length,
    proofAtMs: proof.proofAtMs,
    proofCompletedAtMs: proof.completedAtMs,
  };
}
async function exitTui(page: Page, plan: DirectTuiWorkloadPlan): Promise<void> {
  for (const key of plan.exitKeys) {
    if (key.startsWith(':')) await page.keyboard.type(key);
    else await page.keyboard.press(key);
  }
}
function framePopulation(
  raw: readonly unknown[],
  windows: readonly { readonly startAtMs: number; readonly endAtMs: number }[],
) {
  const cadence: number[] = [];
  const longTasks: { atMs: number; durationMs: number }[] = [];
  for (const event of raw) {
    if (typeof event !== 'object' || event === null) continue;
    const record = event as Record<string, unknown>;
    const atMs = record.atMs;
    if (typeof atMs !== 'number') continue;
    const gapMs = record.gapMs;
    if (
      record.kind === 'main_frame_cadence' &&
      typeof gapMs === 'number' &&
      windows.some((window) => atMs <= window.endAtMs && atMs - gapMs >= window.startAtMs)
    )
      cadence.push(gapMs);
    const durationMs = record.durationMs;
    if (
      record.kind === 'main_long_task' &&
      typeof durationMs === 'number' &&
      windows.some((window) => atMs < window.endAtMs && atMs + durationMs > window.startAtMs)
    )
      longTasks.push({ atMs, durationMs });
  }
  return {
    scope:
      'complete rAF intervals inside the observation; long tasks intersecting it; compare bracketing identical controls, never infer refresh period from a slow workload',
    rafGapSamplesMs: cadence,
    rafGapMs: referenceDistribution(cadence),
    longTasks,
  };
}
async function now(page: Page): Promise<number> {
  return page.evaluate(() => performance.timeOrigin + performance.now());
}

async function outsideWindowRafProof(
  page: Page,
): Promise<{ readonly proofAtMs: number; readonly completedAtMs: number }> {
  return page.evaluate(
    () =>
      new Promise<{ proofAtMs: number; completedAtMs: number }>((resolve) => {
        requestAnimationFrame((first) => {
          requestAnimationFrame((second) => {
            resolve({
              proofAtMs: performance.timeOrigin + first,
              completedAtMs: performance.timeOrigin + second,
            });
          });
        });
      }),
  );
}

function requireProxyPorts(ports: readonly number[]): readonly [number, number] {
  if (
    ports.length !== 2 ||
    !ports.every((port) => Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535)
  ) {
    throw new Error('common Direct proxy did not expose exactly two valid data ports');
  }
  const first = ports[0];
  const second = ports[1];
  if (first === undefined || second === undefined || first === second) {
    throw new Error('common Direct proxy data-port identity is incomplete');
  }
  return [first, second];
}

function cleanReferenceTransportEvidence(
  raw: readonly unknown[],
  startAtMs: number,
  endAtMs: number,
) {
  let resyncCount = 0;
  let fecRecoveredApplyCount = 0;
  let repairCommitCount = 0;
  for (const event of raw) {
    if (typeof event !== 'object' || event === null) continue;
    const record = event as Record<string, unknown>;
    if (
      typeof record.atMs !== 'number' ||
      !Number.isFinite(record.atMs) ||
      record.atMs < startAtMs ||
      record.atMs > endAtMs
    ) {
      continue;
    }
    if (record.kind === 'display_resync') resyncCount += 1;
    if (record.kind === 'worker_display_applied' && record.fecRecovered === true) {
      fecRecoveredApplyCount += 1;
    }
    if (
      record.kind === 'presentation_commit' &&
      (record.reason === 'repair-target-satisfied' || record.reason === 'repair-deadline-expired')
    ) {
      repairCommitCount += 1;
    }
  }
  if (resyncCount !== 0 || fecRecoveredApplyCount !== 0 || repairCommitCount !== 0) {
    throw new Error('clean common Direct phase used resync, FEC recovery, or display repair');
  }
  return {
    complete: true,
    resyncCount,
    fecRecoveredApplyCount,
    repairCommitCount,
    receiveRingRefusal: {
      available: false,
      reason: 'receive-ring refusal boundary events are absent from the release/final intersection',
    },
  } as const;
}
/** Self-contained because page.evaluate serializes the function into the page. */
async function readCommonDumpInPage(): Promise<unknown> {
  const dump: unknown = Reflect.get(globalThis, '__merkurPerfDump');
  if (typeof dump !== 'function') throw new Error('common dump unavailable');
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result: unknown = await Promise.race([
      dump(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('common dump timed out')), 10_000);
      }),
    ]);
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
function rawDumpEvents(raw: unknown): readonly unknown[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const events = Reflect.get(raw, 'events');
  return Array.isArray(events) ? events : [];
}
function commonInputIdentities(events: readonly unknown[]): number[] {
  const identities: number[] = [];
  for (const event of events) {
    if (
      typeof event !== 'object' ||
      event === null ||
      Reflect.get(event, 'kind') !== 'input_queued'
    ) {
      continue;
    }
    const value = Reflect.get(event, 'inputSeq');
    if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > 0xffff_ffff) {
      throw new Error('public selection proof found malformed terminal input identity');
    }
    identities.push(Number(value));
  }
  return identities;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
async function browserIdentity(page: Page) {
  const browser = page.context().browser();
  if (browser === null) throw new Error('browser identity unavailable');
  // executablePath() can name full Chromium while headless launch actually
  // runs headless-shell. Ask the running browser once, before measurement.
  const session = await browser.newBrowserCDPSession();
  try {
    const command = await session.send('Browser.getBrowserCommandLine');
    const executable = command.arguments[0];
    if (executable === undefined || !executable.startsWith('/'))
      throw new Error('running browser executable unavailable');
    return {
      name: browser.browserType().name(),
      version: browser.version(),
      commandLine: command.arguments,
      executable,
      executableSha256: hash(readFileSync(executable)),
    };
  } finally {
    await session.detach();
  }
}
function hash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function integer(key: string, fallback: number): number {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff)
    throw new Error(`invalid ${key}`);
  return value;
}
function profile(): EdgeNetworkProfileName {
  const value = process.env.DIRECT_REFERENCE_PROFILE;
  if (value !== 'fast' && value !== 'typical' && value !== 'difficult')
    throw new Error('explicit Direct reference profile required');
  return value;
}
