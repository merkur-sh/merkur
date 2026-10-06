import { emitPerfMetric, summarizeSamples } from '../../scripts/perf/harness';
import { expectShellPhase } from './app-state';
import { expect, test } from './fixtures/daemon-process';

const ATTEMPT_COUNT = 3;
const FIRST_VISIBLE_BUDGET_MS = Number(process.env.STARTUP_VISIBLE_BUDGET_MS ?? 5_000);
const MEASURED_MILESTONES = [
  'terminal_mount_requested',
  'worker_ready',
  'terminal_view_presented',
  'transport_start',
  'transport_connected',
  'first_display_applied',
  'first_display_visible',
] as const;

test('device selection reaches an authoritative GPU-visible terminal promptly', async ({
  page,
  linkedDaemon,
  terminalPerf,
}, testInfo) => {
  const attempts: Array<
    Record<(typeof MEASURED_MILESTONES)[number], number> & { firstInputGpuMs: number }
  > = [];

  for (let index = 0; index < ATTEMPT_COUNT; index += 1) {
    await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
    await page.waitForFunction(() => document.body.dataset.connection === 'connected', undefined, {
      polling: 'raf',
      timeout: 20_000,
    });

    // Exercise the first visible screen before any priming command, resize
    // settlement, or direct-upgrade wait can hide a stalled input carrier.
    await page.keyboard.type('x');
    await expect
      .poll(
        async () => {
          const firstInput = await terminalPerf.snapshot();
          const input = firstInput.events.find((event) => event.kind === 'input_queued');
          return (
            input !== undefined &&
            firstInput.events.some(
              (event) =>
                event.kind === 'frame_complete' &&
                event.atMs >= input.atMs &&
                event.displayInputSeq >= input.inputSeq,
            )
          );
        },
        { timeout: 5_000, intervals: [10, 25, 50] },
      )
      .toBe(true);

    const snapshot = await terminalPerf.snapshot();
    const input = snapshot.events.find((event) => event.kind === 'input_queued');
    if (input === undefined) throw new Error('first input was not queued');
    const echo = snapshot.events.find(
      (event) =>
        event.kind === 'frame_complete' &&
        event.atMs >= input.atMs &&
        event.displayInputSeq >= input.inputSeq,
    );
    if (echo === undefined) throw new Error('first input was not rendered');
    const firstInputGpuMs = echo.atMs - input.atMs;
    expect(firstInputGpuMs, 'first input must work before startup priming').toBeLessThan(
      500 + 2 * Number(process.env.EDGE_NETWORK_TARGET_RTT_MS ?? 0),
    );
    await page.keyboard.press('Control+u');
    const attempt = snapshot.report.startup.attempts.at(-1);
    expect(snapshot.report.startup.complete, 'startup trace must be causally valid').toBe(true);
    expect(attempt?.complete, 'CONNECTED must follow an authoritative GPU fence').toBe(true);
    if (attempt === undefined) throw new Error('startup attempt was not recorded');

    const elapsed = {} as Record<(typeof MEASURED_MILESTONES)[number], number>;
    for (const milestone of MEASURED_MILESTONES) {
      const value = attempt.elapsedMsByMilestone[milestone];
      if (value === undefined) throw new Error(`startup milestone missing: ${milestone}`);
      elapsed[milestone] = value;
    }
    expect(elapsed.first_display_visible).toBeLessThanOrEqual(FIRST_VISIBLE_BUDGET_MS);
    expect(elapsed.transport_start).toBeLessThanOrEqual(elapsed.terminal_view_presented);
    attempts.push({ ...elapsed, firstInputGpuMs });

    if (index + 1 < ATTEMPT_COUNT) {
      // Fence and clear the completed attempt while its telemetry worker still
      // owns the live terminal rings. Returning to the machine list tears that
      // worker down, so an exact reset cannot be requested after the click.
      await terminalPerf.reset();
      await page.getByRole('button', { name: 'Back to machines', exact: true }).click();
      await expectShellPhase(page);
      await expect(page.getByTitle(`Connect to ${linkedDaemon.daemonName}`)).toBeVisible();
    }
  }

  for (const milestone of MEASURED_MILESTONES) {
    const samples = attempts.map((attempt) => attempt[milestone]);
    emitPerfMetric({
      name: `terminal-startup-cold-click-to-${milestone.replaceAll('_', '-')}`,
      value: samples[0] ?? 0,
      unit: 'ms/attempt',
      direction: 'lower',
      sampleSize: 1,
    });
    emitPerfMetric({
      name: `terminal-startup-repeat-click-to-${milestone.replaceAll('_', '-')}-p50`,
      value: summarizeSamples(samples).median,
      unit: 'ms/attempt',
      direction: 'lower',
      percentile: 0.5,
      sampleSize: samples.length,
    });
  }

  await testInfo.attach('terminal-startup-attempts.json', {
    body: `${JSON.stringify({ budgetMs: FIRST_VISIBLE_BUDGET_MS, attempts }, null, 2)}\n`,
    contentType: 'application/json',
  });
});
