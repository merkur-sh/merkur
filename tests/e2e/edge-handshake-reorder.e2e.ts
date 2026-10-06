import { emitPerfMetric, summarizeSamples } from '../../scripts/perf/harness';
import { expectConnected, expectShellPhase } from './app-state';
import { expect, test } from './fixtures/daemon-process';

/**
 * A fresh WebTransport dial must not deadlock when the client's handshake
 * packets arrive out of order.
 *
 * This is the gate `PERF.md` (2026-08-30, "0.5-RTT SETTINGS reverted") named as
 * missing. `22a10f7` had the edge write H3 SETTINGS in its 0.5-RTT flight,
 * saving a round trip per dial; in production a majority of fresh browser
 * connections then stalled for the edge's full `SESSION_HANDSHAKE_TIMEOUT`
 * (10s, `apps/edge/src/relay.rs`) because Chromium discards a 1-RTT packet it
 * cannot yet decrypt — the SETTINGS frame — when the Handshake flight that
 * installs those keys is reordered behind it, and never replays it. The client
 * sits in `CONNECT_STATE_CONNECT_COMPLETE`, the server in `accept_settings()`,
 * and only that 10s timeout breaks it. It was reverted in `2d23f71`.
 *
 * Nothing in the gate suite could see it: the delay proxy added fixed latency
 * and loss, both of which preserve arrival order. `EDGE_NETWORK_REORDER`
 * (`ed07f6b`) is what changed, and this spec is its first consumer.
 *
 * The measured interval is `transport_start` to `transport_connected` — the
 * `browser.session.connect` span, which is the WebTransport dial plus the
 * signaling handshake riding it — rather than click-to-connected, which also
 * contains session issuance, daemon control dispatch and the PTY spawn. Those
 * dominate the total and would bury a stall inside ordinary variance. The
 * deadlock happens inside the dial, so the narrowest interval containing it is
 * what this bounds.
 *
 * The spec measures a *rate* rather than dying on the first stall. A stall is
 * recorded, given the full recovery window the incident's signature needs, and
 * the loop continues: failing fast would report "it broke" where the
 * reproduction work needs "it broke 23 times in 40" — the number that
 * distinguishes the production failure from a flake.
 */

const EDGE_NETWORK_ACTIVE = process.env.EDGE_NETWORK_ACTIVE === '1';
const EDGE_TARGET_RTT_MS = EDGE_NETWORK_ACTIVE
  ? Number(process.env.EDGE_NETWORK_TARGET_RTT_MS ?? 0)
  : 0;
const EDGE_REORDER = EDGE_NETWORK_ACTIVE ? (process.env.EDGE_NETWORK_REORDER ?? 'none') : 'none';
const EDGE_SCENARIO = EDGE_NETWORK_ACTIVE
  ? (process.env.EDGE_NETWORK_SCENARIO ?? 'steady')
  : 'steady';
const ATTEMPT_COUNT = Number(process.env.REORDER_ATTEMPTS ?? 40);
/**
 * Bounds session connect, and is deliberately a separator rather than a latency
 * target: the healthy path and a 10s server timeout are an order of magnitude
 * apart, so this only has to sit cleanly between them.
 *
 * 8s is calibrated, not guessed, and is a coarse backstop rather than the
 * primary gate. Two control runs on this host (delay=25ms, reorder=1/2, 40
 * dials each, 0.5-RTT SETTINGS reverted) measured p50 1009ms/max 1592ms
 * unloaded and p50 1530ms/max 3856ms while a web build competed for CPU. A
 * wall-clock bound on this path is therefore load-sensitive by nature, so it is
 * set at roughly 2x the worst value observed under contention and still under
 * `SESSION_HANDSHAKE_TIMEOUT`, where a deadlock must land. Earlier bounds of
 * 1500ms and 5000ms were both tried: the first failed 40/40 on a healthy build,
 * the second left only 23% headroom over a contended run. Widening it further
 * would start to overlap the failure it exists to separate.
 *
 * The authority is `run-edge-harness.ts`, which fails the run outright when the
 * edge logs `session handshake timed out` under reordering — the server
 * declaring the deadlock rather than a client inferring it from wall-clock, and
 * sensitive to a single occurrence. This bound only additionally catches a
 * stall gross enough to be visible client-side without the edge's timeout
 * firing.
 */
const DIAL_BUDGET_MS = Number(process.env.REORDER_DIAL_BUDGET_MS ?? 8_000);
/**
 * Past the 10s server timeout plus the browser's own retry, so a stalled
 * attempt is still resolved and the run keeps producing a rate.
 */
const RECOVERY_BUDGET_MS = 30_000;

// The healthy path finishes far inside this; the ceiling binds only when dials
// are actually deadlocking, which is exactly when the run must not be cut off
// before it has counted them.
test.setTimeout(ATTEMPT_COUNT * (RECOVERY_BUDGET_MS + 5_000));

test('a fresh WebTransport dial never stalls on reordered handshake packets', async ({
  page,
  linkedDaemon,
  terminalPerf,
}, testInfo) => {
  test.skip(
    !EDGE_NETWORK_ACTIVE || (EDGE_REORDER === 'none' && EDGE_SCENARIO !== 'handshake-split'),
    'needs a network profile with an ordering fault: EDGE_NETWORK_SCENARIO=handshake-split ' +
      '(which separates a coalesced flight) or EDGE_NETWORK_REORDER (whole datagrams)',
  );

  const attempts: Array<{
    index: number;
    dialMs: number | null;
    clickToConnectedMs: number;
    recovered: boolean;
  }> = [];
  let overBudget = 0;

  for (let index = 0; index < ATTEMPT_COUNT; index += 1) {
    const startedAt = performance.now();
    await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();

    let recovered = false;
    try {
      await expectConnected(page, Math.max(RECOVERY_BUDGET_MS, DIAL_BUDGET_MS));
    } catch {
      recovered = true;
      await expectConnected(page, RECOVERY_BUDGET_MS);
    }
    const clickToConnectedMs = performance.now() - startedAt;

    // The dial interval is the assertion; click-to-connected is retained only
    // so a regression can be attributed to the dial rather than to everything
    // else the click also starts.
    const snapshot = await terminalPerf.snapshot();
    const attempt = snapshot.report.startup.attempts.at(-1);
    const start = attempt?.elapsedMsByMilestone.transport_start;
    const connected = attempt?.elapsedMsByMilestone.transport_connected;
    const dialMs = start === undefined || connected === undefined ? null : connected - start;
    if (dialMs === null || dialMs > DIAL_BUDGET_MS) overBudget += 1;
    attempts.push({ index, dialMs, clickToConnectedMs, recovered });

    if (index + 1 < ATTEMPT_COUNT) {
      // Drain and verify this terminal before navigation destroys its workers.
      // Keep the final terminal alive for the fixture's read-only grid proof.
      await terminalPerf.reset();
      await page.getByRole('button', { name: 'Back to machines', exact: true }).click();
      await expectShellPhase(page);
      await expect(page.getByTitle(`Connect to ${linkedDaemon.daemonName}`)).toBeVisible();
    }
  }

  const dials = attempts
    .map((attempt) => attempt.dialMs)
    .filter((value): value is number => value !== null);
  const summary = summarizeSamples(dials);
  // Printed, not only attached: a reproduction sweep reads the distribution
  // straight from the run output, and an attachment inlined into the HTML
  // report is not reachable from a terminal.
  // biome-ignore lint/suspicious/noConsole: harness diagnostic output
  console.log(
    `[reorder] target_rtt=${EDGE_TARGET_RTT_MS}ms reorder=${EDGE_REORDER} ` +
      `scenario=${EDGE_SCENARIO} ` +
      `dial p50=${summary.median.toFixed(1)}ms max=${Math.max(...dials).toFixed(1)}ms ` +
      `overBudget=${overBudget}/${ATTEMPT_COUNT} budget=${DIAL_BUDGET_MS}ms`,
  );

  emitPerfMetric({
    name: 'edge-handshake-reorder-stalled-dials',
    value: overBudget,
    unit: 'dials',
    direction: 'lower',
    sampleSize: ATTEMPT_COUNT,
  });
  emitPerfMetric({
    name: 'edge-handshake-reorder-dial-p50',
    value: summary.median,
    unit: 'ms/dial',
    direction: 'lower',
    percentile: 0.5,
    sampleSize: dials.length,
  });

  await testInfo.attach('edge-handshake-reorder-attempts.json', {
    body: `${JSON.stringify(
      {
        targetRttMs: EDGE_TARGET_RTT_MS,
        reorder: EDGE_REORDER,
        scenario: EDGE_SCENARIO,
        dialBudgetMs: DIAL_BUDGET_MS,
        overBudget,
        attempts,
      },
      null,
      2,
    )}\n`,
    contentType: 'application/json',
  });

  expect(
    overBudget,
    `${overBudget}/${ATTEMPT_COUNT} dials exceeded ${DIAL_BUDGET_MS}ms from transport_start to ` +
      "transport_connected. A dial that needs the edge's handshake timeout to unwedge it is the " +
      'CONNECT_STATE_CONNECT_COMPLETE deadlock described in PERF.md (2026-08-30).',
  ).toBe(0);
});
