import { execFileSync } from 'node:child_process';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CARRIER_IDLE_DEATH_MS } from '@merkur/config/reconnect-policy';
import type { Page } from '@playwright/test';
import type { TerminalPerfEvent } from '../../apps/web/src/perf/terminal-latency';
import { RECONNECT_OVERLAY_GRACE_MS } from '../../apps/web/src/terminal/status-presentation';
import { appConnection, expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';
import { partitionEdgeProxy } from './fixtures/test';
import { instrumentTransportWorker } from './fixtures/transport-worker-prelude';

/**
 * A carrier rebind restores a session in place after the network drops, without
 * the application server.
 *
 * This is the only gate that proves it. Unit tests cover the admission logic and
 * the key schedule; neither can show that a browser whose carrier actually died
 * comes back to a daemon tunnel the edge is still holding, that the terminal it
 * had is still the terminal it gets, and that typing across the gap applies
 * exactly once.
 *
 * The partition needs the delay proxy, so the spec skips when the harness runs
 * without it rather than asserting nothing.
 */

/**
 * Keep a real outage inside the 60 s retention window. Independent data repair
 * can now survive a partition without replacing signaling, so elapsed time is
 * NOT proof of carrier death. Rebind-specific tests close the real browser
 * transports explicitly; the separate promotion test uses only network faults.
 */
const PARTITION_MS = 5_000;
/**
 * Liveness bound on recovery once connectivity returns — not a latency
 * assertion.
 *
 * The rebind exchange itself is two relay round trips, but the browser only
 * runs it on its next reconnect attempt, and a blackholed UDP path raises no
 * `online` event to preempt the ladder the way a real interface drop does. So
 * the attempt can be sitting on up to the signaling retry ceiling of full-jittered
 * backoff at the moment the path comes back, and that wait is correct
 * behaviour. Budgeting under it made this spec fail on a loaded machine.
 *
 * Speed is not what this number is for: the rebind is proven fast by what it
 * did *not* do — the zero-issuance and committed-rebind assertions below.
 */
const RECOVERY_BUDGET_MS = 15_000;

/** Test-owned transport observation; no production hook or synthetic rebind. */
async function observeBrowserCarriers(
  page: Page,
  observeFinalFault = false,
): Promise<() => Promise<void>> {
  // An intercepted worker response has no local-address-space provenance in
  // Chromium. Grant the harness origin access to its real loopback QUIC edge.
  await page.context().grantPermissions(['local-network-access'], { origin: page.url() });
  const instrument = (observeFinalFault: boolean): void => {
    let uncertainCarrier: WebTransport | null = null;
    // Faults are armed explicitly after genesis. The write observer sees the
    // real framed signaling bytes, and the read observer drops successor data
    // only after the final flight was sent. Production has no test hooks.
    if (observeFinalFault) {
      const flights: string[] = [];
      Reflect.set(globalThis, '__rebindFlights', flights);
      const write = WritableStreamDefaultWriter.prototype.write;
      WritableStreamDefaultWriter.prototype.write = function (chunk: unknown) {
        if (chunk instanceof Uint8Array) {
          const kind = new TextDecoder().decode(chunk).match(/"type":"([^"]+)"/);
          if (kind) flights.push(`send ${kind[1]}`);
        }
        const mode = Reflect.get(globalThis, '__rebindFinalFault');
        if (
          mode &&
          chunk instanceof Uint8Array &&
          new TextDecoder().decode(chunk).includes('"type":"rebind_final"')
        ) {
          Reflect.set(globalThis, '__rebindFinalFault', null);
          Reflect.set(globalThis, '__rebindFinalObserved', true);
          if (mode === 'hold') {
            return new Promise<void>((resolve, reject) => {
              Reflect.set(globalThis, '__releaseRebindFinal', () => {
                void write.call(this, chunk).then(resolve, reject);
              });
            });
          }
          // Keep either outcome uncertain until the next carrier: otherwise a
          // predecessor ACK can resolve a dropped final before the test cuts it.
          const candidate = [...carriers];
          if (candidate.length !== 1 || candidate[0] === undefined)
            throw new Error('an uncertain final must hold one real candidate');
          uncertainCarrier = candidate[0];
          Reflect.set(globalThis, '__rebindDropInbound', true);
          if (mode === 'drop') return Promise.resolve();
        }
        return write.call(this, chunk);
      };
      const read = ReadableStreamDefaultReader.prototype.read;
      ReadableStreamDefaultReader.prototype.read = async function () {
        const result = await read.call(this);
        if (!result.done && result.value instanceof Uint8Array) {
          const kind = new TextDecoder().decode(result.value).match(/"type":"([^"]+)"/);
          if (kind)
            flights.push(
              `receive ${kind[1]} drop=${Reflect.get(globalThis, '__rebindDropInbound')}`,
            );
        }
        if (
          Reflect.get(globalThis, '__rebindDropInbound') &&
          !result.done &&
          result.value instanceof Uint8Array
        ) {
          return { done: false, value: new Uint8Array() };
        }
        return result.done
          ? { done: true, value: undefined }
          : { done: false, value: result.value };
      };
    }
    const NativeTransport = globalThis.WebTransport;
    const carriers = new Set<WebTransport>();
    const dials: Array<{ startedAtMs: number; readyAtMs: number | null }> = [];
    Reflect.set(globalThis, '__rebindTestDials', dials);
    globalThis.WebTransport = class extends NativeTransport {
      constructor(url: string | URL, options?: WebTransportOptions) {
        super(url, options);
        const dial = {
          startedAtMs: performance.timeOrigin + performance.now(),
          readyAtMs: null as number | null,
        };
        dials.push(dial);
        this.ready.then(
          () => {
            dial.readyAtMs = performance.timeOrigin + performance.now();
          },
          () => {},
        );
        carriers.add(this);
        this.closed.then(
          () => carriers.delete(this),
          () => carriers.delete(this),
        );
      }
      override close(info?: WebTransportCloseInfo): void {
        if (this === uncertainCarrier) {
          // Native reconciliation closes its timed-out candidate. End the fault
          // in that same worker turn, before its successor reads a routing preface.
          uncertainCarrier = null;
          Reflect.set(globalThis, '__rebindDropInbound', false);
          Reflect.set(globalThis, '__rebindFinalClosed', true);
        }
        super.close(info);
      }
    };
    Reflect.set(globalThis, '__closeRebindTestCarriers', () => {
      const count = carriers.size;
      for (const carrier of carriers) carrier.close();
      carriers.clear();
      // End the inbound fault in the same worker turn as the old carriers.
      // A separate page.evaluate lets the replacement dial receive (and lose)
      // its routing preface before that later task clears the fault.
      Reflect.set(globalThis, '__rebindDropInbound', false);
      return count;
    });
  };
  // Install before the lazy worker executes, including speculative cold dials.
  // This instruments only the harness's worker response, never production code.
  const removeInstrument = await instrumentTransportWorker(
    page.context(),
    `(${instrument.toString()})(${observeFinalFault});`,
  );
  // The daemon context spans tests; this observer belongs to this page only.
  page.once('close', () => void removeInstrument());
  return async () => {
    const counts = await Promise.all(
      page.workers().map((worker) =>
        worker.evaluate(() => {
          const close = Reflect.get(globalThis, '__closeRebindTestCarriers');
          return typeof close === 'function' ? Number(close()) : 0;
        }),
      ),
    );
    const count = counts.reduce((sum, count) => sum + count, 0);
    expect(count, 'close the three real browser attachments').toBeGreaterThanOrEqual(3);
  };
}

function transportStates(events: readonly TerminalPerfEvent[]): TerminalPerfEvent[] {
  return events.filter((event) => event.kind === 'transport_state');
}

/**
 * Rebinds the daemon actually committed in a slice of its log.
 *
 * The commit, not the acceptance: a request that authenticates but whose
 * successor never opens leaves the session on its old generation, and counting
 * acceptances would call that a success.
 *
 * A connected terminal alone can hide full re-issuance. Pair this count with
 * the issuance count to prove that the candidate committed the existing
 * session. Expired authorization receives an authenticated refusal and renews
 * its epoch on the held candidate; transport presence alone proves neither
 * acceptance nor refusal.
 */
function committedRebinds(log: string): number {
  return log.split('rebind committed').length - 1;
}

function countOf(log: string, needle: string): number {
  return log.split(needle).length - 1;
}

/**
 * Sized under the daemon's repair rule, not to fill the screen. A resume claim
 * with more than half its rows diverged is answered with a snapshot
 * (`resume_repair_beats_snapshot`, apps/daemon/dataplane/src/session/resume.rs),
 * because past that point the repair is more bytes and more visible tearing
 * than one atomic frame. The harness viewport is 37 rows; these rows plus the
 * cursor row must stay below 18 or the daemon takes the snapshot on purpose and
 * the repair oracle below can never be satisfied -- which is exactly how this
 * spec sat red from 2026-09-04, when the frame was widened to 24 rows, until
 * 2026-09-08. Still several datagrams of styled, high-entropy rows, so the
 * multi-unit repair path is exercised.
 */
const REPAIR_FRAME_ROWS = 14;

function deterministicRepairRow(row: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let state = (0x9e37_79b9 ^ Math.imul(row, 0x85eb_ca6b)) >>> 0;
  let result = '';
  for (let column = 0; column < 54; column += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    result += alphabet[state % alphabet.length];
  }
  return result;
}

/**
 * One PTY write whose final grid cannot fit one display datagram. The carrier
 * is blackholed before this runs, so the resumed browser is missing every row
 * and the retained generation must exercise the real multi-unit repair path.
 */
function gatedRepairFrameCommand(releasePath: string): string {
  const frame = Array.from({ length: REPAIR_FRAME_ROWS }, (_, index) => {
    const row = index + 1;
    const foreground = `${(row * 47) % 256};${(row * 83) % 256};${(row * 131) % 256}`;
    const background = `${(row * 149) % 256};${(row * 197) % 256};${(row * 229) % 256}`;
    // printf decodes the leading byte; the literal witness must never occur in
    // the echoed arming command or it could end measurement before the outage.
    const label = row === 12 ? '\\x67eneration-repair-gap' : `generation-repair-row-${row}`;
    return (
      `\\033[${row};1H\\033[38;2;${foreground}m\\033[48;2;${background}m` +
      `${label}-${deterministicRepairRow(row)}\\033[0m`
    );
  }).join('');
  // Job control off: bash would otherwise report the finished job at the next
  // prompt with the entire escaped command echoed back, a notice several times
  // longer than the accessibility mirror's 2 KiB announcement window that the
  // assertions below read through -- and the tail of that notice is what the
  // window kept, not the output typed after the recovery.
  const quotedPath = `'${releasePath.replaceAll("'", "'\\''")}'`;
  return `set +m; (IFS= read -r release < ${quotedPath}; printf '%b' '\\0337${frame}\\0338') & printf '\\x67eneration-repair-armed\\n'`;
}

test('repeated idle rebinds finish restoring without new terminal output', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  const closeCarriers = await observeBrowserCarriers(page);
  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  await expectConnected(page, 40_000);
  // Establish a resumable delta sequence after the initial seq-zero snapshot.
  // From the first carrier cut onward, the terminal produces no new output.
  await page.keyboard.type('echo idle-resume-ready');
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toContainText('idle-resume-ready');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Close the preceding display/ACK tail and prove the idle grid agrees before
    // cutting its carriers. Initial connection readiness alone leaves that tail open.
    await terminalPerf.reset();
    const logMark = linkedDaemon.logText().length;
    await closeCarriers();
    await expect
      .poll(() => committedRebinds(linkedDaemon.logText().slice(logMark)), {
        timeout: RECOVERY_BUDGET_MS,
      })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => linkedDaemon.logText().slice(logMark), {
        timeout: RECOVERY_BUDGET_MS,
      })
      .toContain('repaired_rows=0');
    await expectConnected(page, RECOVERY_BUDGET_MS);
  }
});

test('a partitioned carrier rebinds in place and keeps its terminal', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  // A 1 ms partition is an availability probe: it proves the control socket is
  // there without meaningfully interrupting anything.
  const partitioned = await partitionEdgeProxy(1).catch(() => false);
  test.skip(!partitioned, 'carrier rebind needs the delay proxy to partition the path');

  const closeCarriers = await observeBrowserCarriers(page);
  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  await expectConnected(page, 40_000);
  await terminalPerf.reset();

  // Leave a mark that must survive the gap. If the daemon's peer were rebuilt
  // rather than rebound, this is what would be lost.
  await page.keyboard.type('echo rebind-marker-alpha');
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toContainText('rebind-marker-alpha', { timeout: 10_000 });

  // The daemon is worker-scoped, so only what it logs from here on is ours.
  const logMark = linkedDaemon.logText().length;
  await partitionEdgeProxy(PARTITION_MS);
  await closeCarriers();

  // Type THROUGH the outage. The input outbox holds these, and because a rebind
  // preserves the daemon's keystroke sequence domain rather than restarting it,
  // the replay must apply exactly once — no duplicates, no drops.
  await page.keyboard.type('echo rebind-marker-beta');
  await page.keyboard.press('Enter');

  await expect(page.locator('body')).toContainText('rebind-marker-beta', {
    timeout: PARTITION_MS + RECOVERY_BUDGET_MS,
  });
  await expect(appConnection(page)).resolves.toBe('connected');

  // The pre-outage output is still on screen: the display cache and generation
  // survived, so the daemon repaired rather than repainted.
  await expect(page.locator('body')).toContainText('rebind-marker-alpha');

  const body = await page.locator('body').innerText();
  const betaEchoes = body.split('rebind-marker-beta').length - 1;
  expect(
    betaEchoes,
    'input typed across the gap must replay exactly once, not once per attempt',
  ).toBeLessThanOrEqual(3);

  // The daemon is the only witness that distinguishes a rebind from a carrier
  // that merely rode out the blackhole. Both leave the browser looking healthy.
  await expect
    .poll(() => committedRebinds(linkedDaemon.logText().slice(logMark)), {
      message: 'the session must come back by rebinding, not by the carrier surviving the outage',
      timeout: PARTITION_MS + RECOVERY_BUDGET_MS,
    })
    .toBeGreaterThanOrEqual(1);

  const snapshot = await terminalPerf.snapshot();
  expect(
    transportStates(snapshot.events).filter(
      (event) => event.kind === 'transport_state' && event.state === 'disconnected',
    ),
    'a partition inside the rebind window must not end the session',
  ).toEqual([]);
});

/**
 * A carrier that answers again before recovery replaces it returns the session
 * to ready on the lineage it already had: no fence, so no second first display.
 * The terminal on screen is still the terminal, and nothing may cover it. Main
 * used to rearm the first-display wait on every ready, and the "Restoring the
 * display" card then stayed over a terminal that kept taking input.
 */
test('a carrier that recovers on its own lineage leaves the terminal uncovered', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  const partitioned = await partitionEdgeProxy(1).catch(() => false);
  test.skip(!partitioned, 'the lineage-keeping recovery needs the delay proxy to stall the path');

  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  await expectConnected(page, 40_000);
  await page.keyboard.type('echo lineage-kept');
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toContainText('lineage-kept');
  await terminalPerf.reset();

  // Hold every path until the owner reports recovery, then restore only what
  // exists: the incumbent answers while no replacement can be dialled. Fixed
  // outage lengths depend on heartbeat phase and cannot prove this transition,
  // and a path restored to both lets the replacement's handshake race the
  // incumbent's next retransmission, which either may win.
  await partitionEdgeProxy(20_000);
  await expect
    .poll(
      async () =>
        transportStates((await terminalPerf.snapshot()).events).some(
          (event) => event.kind === 'transport_state' && event.state === 'signaling_reconnecting',
        ),
      { timeout: RECOVERY_BUDGET_MS },
    )
    .toBe(true);
  await partitionEdgeProxy(20_000, 'browser-dials');
  await expect
    .poll(
      async () => {
        const events = transportStates((await terminalPerf.snapshot()).events);
        const reconnecting = events.findIndex(
          (event) => event.kind === 'transport_state' && event.state === 'signaling_reconnecting',
        );
        return (
          reconnecting >= 0 &&
          events
            .slice(reconnecting)
            .some((event) => event.kind === 'transport_state' && event.state === 'connected')
        );
      },
      {
        message: 'the stalled carrier must start recovery and return',
        timeout: RECOVERY_BUDGET_MS,
      },
    )
    .toBe(true);
  await partitionEdgeProxy(1);
  const events = (await terminalPerf.snapshot()).events;
  expect(
    events.filter((event) => event.kind === 'presentation_epoch_boundary'),
    'the carrier must come back on its own lineage for this case to hold',
  ).toEqual([]);

  // Past the grace a preserved-display wait allows before it covers the screen.
  await page.waitForTimeout(RECONNECT_OVERLAY_GRACE_MS * 2);
  await page.keyboard.type('echo lineage-typed');
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toContainText('lineage-typed');
  await expect(page.locator('#terminal-status-overlay')).toBeHidden();
});

/** A replacement must complete its real dial before its authenticated final
 * commits; hold that final to observe both sides of the boundary independently. */
test('a dead carrier is replaced only after its replacement proves a working path', async ({
  page,
  linkedDaemon,
}) => {
  const partitioned = await partitionEdgeProxy(1, 'browser-established').catch(() => false);
  test.skip(!partitioned, 'this needs the delay proxy to cut established connections');
  await observeBrowserCarriers(page, true);
  let issuances = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/sessions/request') issuances += 1;
  });
  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  await expectConnected(page, 40_000);
  const initialIssuances = issuances;
  await page.keyboard.insertText("printf 'promote-%s-before\\n' path");
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toContainText('promote-path-before');

  const logMark = linkedDaemon.logText().length;
  for (const worker of page.workers())
    await worker.evaluate(() => Reflect.set(globalThis, '__rebindFinalFault', 'hold'));
  await partitionEdgeProxy(20_000, 'browser-established');
  await page.keyboard.insertText("printf 'promote-%s-after\\n' path");
  await page.keyboard.press('Enter');
  await expect
    .poll(
      async () =>
        (
          await Promise.all(
            page
              .workers()
              .map((worker) =>
                worker.evaluate(() => Reflect.get(globalThis, '__rebindFinalObserved') === true),
              ),
          )
        ).some(Boolean),
      { timeout: RECOVERY_BUDGET_MS },
    )
    .toBe(true);
  // A native ready promise proves the replacement path while the daemon still
  // has the incumbent. The held final cannot have committed the successor.
  const provedReplacement = await Promise.all(
    page.workers().map((worker) =>
      worker.evaluate(() => {
        const observed: unknown = Reflect.get(globalThis, '__rebindTestDials');
        if (!Array.isArray(observed)) return false;
        return observed.slice(3).some((entry: unknown) => {
          if (
            typeof entry !== 'object' ||
            entry === null ||
            !('startedAtMs' in entry) ||
            !('readyAtMs' in entry)
          )
            return false;
          return (
            typeof entry.startedAtMs === 'number' &&
            typeof entry.readyAtMs === 'number' &&
            entry.startedAtMs <= entry.readyAtMs
          );
        });
      }),
    ),
  );
  expect(provedReplacement.some(Boolean), 'the replacement native dial must prove a path').toBe(
    true,
  );
  expect(committedRebinds(linkedDaemon.logText().slice(logMark))).toBe(0);
  for (const worker of page.workers())
    await worker.evaluate(() => {
      const release = Reflect.get(globalThis, '__releaseRebindFinal');
      if (typeof release === 'function') release();
    });
  await expect
    .poll(() => committedRebinds(linkedDaemon.logText().slice(logMark)), {
      timeout: RECOVERY_BUDGET_MS,
    })
    .toBe(1);
  await expect(page.locator('body')).toContainText('promote-path-after', {
    timeout: RECOVERY_BUDGET_MS,
  });
  await expectConnected(page, RECOVERY_BUDGET_MS);
  await expect(page.locator('body')).toContainText('promote-path-before');
  expect(issuances, 'recovery must retain its authenticated session').toBe(initialIssuances);
});

/**
 * That recovery took the *rebind* path, not full re-authentication.
 *
 * Counting issuance requests is the other half of the proof: the daemon log
 * shows a rebind happened, and this shows nothing else did. The session
 * recovers either way, and an earlier version of the spec asserted only
 * recovery — and passed while the fast path silently never engaged. That is the
 * failure mode this guards against, which is why it asserts zero rather than
 * something softer.
 */
/**
 * The screen survives the gap because the daemon REPAIRED it, not because it
 * repainted it.
 *
 * This is the assertion the other two specs could not make. Both a repair and a
 * full snapshot leave the pre-outage text on screen, so reading the browser
 * cannot tell them apart -- and for a long time the daemon took the snapshot
 * every single time while `splice_rebound_peer` documented at length that it
 * did not. Only the daemon's own log distinguishes them.
 *
 * A carrier swap is the same screen over a different pipe: the display
 * generation is preserved, so the browser's resume claim still matches and is
 * answered with per-row repairs. If a future change reintroduces the generation
 * bump, `incremental resume rejected` appears here and this fails, while every
 * other assertion in this file keeps passing.
 */
test('a rebound carrier keeps its display generation and is repaired, not repainted', async ({
  page,
  linkedDaemon,
  terminalPerf,
}, testInfo) => {
  const partitioned = await partitionEdgeProxy(1).catch(() => false);
  test.skip(!partitioned, 'carrier rebind needs the delay proxy to partition the path');
  const closeCarriers = await observeBrowserCarriers(page);
  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  await expectConnected(page, 40_000);
  await terminalPerf.reset();

  await page.keyboard.type('echo generation-marker');
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toContainText('generation-marker', { timeout: 10_000 });

  // Arm one multi-row PTY write that runs only after the carrier is
  // blackholed. It exists in the daemon's retained generation while remaining
  // absent from the browser's resume claim. Its entropy and styled row count
  // deliberately force more than one independent display unit, so END-first
  // delivery or an interior loss cannot hide behind a one-row repair oracle.
  const releasePath = testInfo.outputPath('repair-release.fifo');
  await mkdir(path.dirname(releasePath), { recursive: true });
  execFileSync('mkfifo', [releasePath]);
  await page.keyboard.insertText(gatedRepairFrameCommand(releasePath));
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toContainText('generation-repair-armed', {
    timeout: 10_000,
  });

  // Close the arming command's display/GPU tail before the recovery window.
  // The writer is blocked on the test-owned FIFO, so resetting retains the real
  // future grid mutation while excluding prompt/marker presentation noise.
  await terminalPerf.reset();
  const logMark = linkedDaemon.logText().length;
  await expect(page.locator('body')).not.toContainText('generation-repair-gap');
  const repairMeasurementId = await terminalPerf.beginPresentationMeasurement('coherent-redraw');
  await partitionEdgeProxy(PARTITION_MS);
  await closeCarriers();
  await writeFile(releasePath, 'release\n');
  await unlink(releasePath);
  await expect(page.locator('body')).toContainText('generation-repair-gap', {
    timeout: PARTITION_MS + RECOVERY_BUDGET_MS,
  });
  await terminalPerf.endPresentationMeasurement(repairMeasurementId);

  // Keep ordinary post-recovery output outside the exact repair window. A
  // command queued during the outage would otherwise join the recovery
  // presentation and make a one-commit assertion unable to distinguish
  // incremental repair from unrelated fresh deltas.
  await page.keyboard.type('echo generation-after');
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toContainText('generation-after', {
    timeout: RECOVERY_BUDGET_MS,
  });

  const log = linkedDaemon.logText().slice(logMark);
  expect(
    committedRebinds(log),
    'nothing below means anything unless the session came back by rebinding',
  ).toBeGreaterThanOrEqual(1);
  expect(
    countOf(log, 'carrier rebound onto the retained display generation'),
    'the rebind must retire the dead carrier without opening a new display generation',
  ).toBeGreaterThanOrEqual(1);
  expect(
    countOf(log, 'incremental resume rejected'),
    'a preserved generation must let the browser resume claim match, not fall back to a snapshot',
  ).toBe(0);

  // Verify the actual repair transaction and its GPU fence after the daemon's
  // authenticated commit, independently of transport diagnostic events.
  const recoverySnapshot = await terminalPerf.snapshot();
  const boundaries = recoverySnapshot.events.filter(
    (event): event is Extract<TerminalPerfEvent, { kind: 'presentation_measurement_boundary' }> =>
      event.kind === 'presentation_measurement_boundary' &&
      event.measurementId === repairMeasurementId,
  );
  const start = boundaries.find((event) => event.phase === 'start');
  const end = boundaries.find((event) => event.phase === 'end');
  expect(start, 'the repair measurement must have its exact opening boundary').toBeDefined();
  expect(end, 'the repair measurement must have its exact closing boundary').toBeDefined();
  if (start === undefined || end === undefined)
    throw new Error('Missing repair measurement boundary');
  const repairCommits = recoverySnapshot.events.filter(
    (event) =>
      event.kind === 'presentation_commit' && event.atMs >= start.atMs && event.atMs <= end.atMs,
  );
  expect(
    repairCommits,
    'the retained generation must finish a real incremental repair presentation',
  ).toHaveLength(1);
  const repairCommit = repairCommits[0];
  if (repairCommit?.kind !== 'presentation_commit') return;
  expect(repairCommit.authoritativeVisualChange).toBe(true);
  expect(repairCommit.reason, 'complete repair members must release at a real frame').toBe(
    'group-end-vsync',
  );
  expect(repairCommit.coherent).toBe(true);
  expect(repairCommit.endSeen).toBe(true);
  expect(repairCommit.releaseFrameCount).toBe(1);
  expect(repairCommit.membershipReleaseDisableBits).toBe(0);
  expect(
    repairCommit.datagramCount,
    'the recovery oracle must span multiple independent display units',
  ).toBeGreaterThan(1);
  expect(repairCommit.rowCount).toBeGreaterThanOrEqual(REPAIR_FRAME_ROWS - 1);
  const repairMembers = recoverySnapshot.events.filter(
    (event): event is Extract<TerminalPerfEvent, { kind: 'worker_display_applied' }> =>
      event.kind === 'worker_display_applied' &&
      event.presentationTransactionSeq === repairCommit.transactionSeq,
  );
  expect(
    repairMembers,
    'every repair datagram must join the one committed transaction',
  ).toHaveLength(repairCommit.datagramCount);
  expect(repairMembers.reduce((rows, event) => rows + event.rowCount, 0)).toBe(
    repairCommit.rowCount,
  );
  expect(repairMembers.every((event) => event.generation === repairCommit.generation)).toBe(true);
  expect(repairMembers.some((event) => event.displaySeq === repairCommit.firstDisplaySeq)).toBe(
    true,
  );
  expect(repairMembers.some((event) => event.displaySeq === repairCommit.lastDisplaySeq)).toBe(
    true,
  );
  const repairRenderEnds = recoverySnapshot.events.filter(
    (event) =>
      event.kind === 'render_end' &&
      event.renderSeq === repairCommit.renderSeq &&
      event.completionMode === 'gpu-queue',
  );
  const repairFences = recoverySnapshot.events.filter(
    (event) => event.kind === 'frame_complete' && event.renderSeq === repairCommit.renderSeq,
  );
  expect(repairRenderEnds, 'repair presentation must submit a real GPU fence').toHaveLength(1);
  expect(repairFences, 'repair must become one GPU-fenced presentation').toHaveLength(1);
  const repairFenceExposureMs =
    Math.max(...repairFences.map((event) => event.atMs)) -
    Math.min(...repairFences.map((event) => event.atMs));
  expect(repairFenceExposureMs).toBe(0);
  const presentation = recoverySnapshot.report.presentation;
  expect(presentation.measurementWindowCount).toBe(1);
  expect(presentation.commitsPerMeasurementWindow.complete).toBe(true);
  expect(presentation.commitsPerMeasurementWindow.count).toBe(1);
  expect(presentation.commitsPerMeasurementWindow.max).toBe(1);
  expect(presentation.rowsPerMeasurementWindow.complete).toBe(true);
  expect(presentation.rowsPerMeasurementWindow.p50).toBeGreaterThanOrEqual(REPAIR_FRAME_ROWS - 1);
  expect(presentation.datagramsPerMeasurementWindow.complete).toBe(true);
  expect(presentation.datagramsPerMeasurementWindow.p50).toBeGreaterThan(1);
  expect(presentation.bytesPerMeasurementWindow.complete).toBe(true);
  expect(presentation.firstDisplayReceiveToCompletedPresentationFenceMs.complete).toBe(true);
  expect(presentation.firstDisplayReceiveToCompletedPresentationFenceMs.count).toBe(1);
  expect(presentation.measurementWindowExposureMs.complete).toBe(true);
  expect(presentation.measurementWindowExposureMs.max).toBe(0);
});

test('recovery takes the rebind path without a server round trip', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  const partitioned = await partitionEdgeProxy(1).catch(() => false);
  test.skip(!partitioned, 'carrier rebind needs the delay proxy to partition the path');

  const closeCarriers = await observeBrowserCarriers(page);
  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  await expectConnected(page, 40_000);
  await terminalPerf.reset();

  let issuanceRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/sessions/request')) issuanceRequests += 1;
  });

  const logMark = linkedDaemon.logText().length;
  await partitionEdgeProxy(PARTITION_MS);
  await closeCarriers();
  await page.keyboard.type('echo rebind-path-probe');
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toContainText('rebind-path-probe', {
    timeout: PARTITION_MS + RECOVERY_BUDGET_MS,
  });

  expect(
    committedRebinds(linkedDaemon.logText().slice(logMark)),
    'the outage must be recovered by a rebind for the issuance count below to mean anything',
  ).toBeGreaterThanOrEqual(1);
  expect(
    issuanceRequests,
    'a carrier rebind must recover the session without asking the server for a new one',
  ).toBe(0);
  // Freeze a post-rebind terminal/transport artifact for the matrix sentinel.
  await terminalPerf.snapshot();
});

/** Exercise budget exhaustion and the formerly listener-arming supersede branch. */
test('an unavailable renewal obtains a successor that page events cannot cancel', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  test.setTimeout(180_000);
  // An unavailable renewal exercises full issuance. A 401 is an authoritative
  // account denial and must close the session, never issue around the denial.
  await page.route('**/api/sessions/renew', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'renewal unavailable' }),
    }),
  );
  const closeCarriers = await observeBrowserCarriers(page);
  let issuanceRequests = 0;
  let cancellationRequests = 0;
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/sessions/request') issuanceRequests += 1;
    if (pathname === '/api/sessions/request/cancel') cancellationRequests += 1;
  });
  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  await expectConnected(page, 40_000);
  const initialIssuances = issuanceRequests;
  // A failed proactive renewal leaves the authorized incumbent usable. Exhaust
  // all eight commits before the next candidate must renew or issue afresh.
  for (let generation = 0; generation < 8; generation += 1) {
    await terminalPerf.reset();
    const mark = linkedDaemon.logText().length;
    await closeCarriers();
    await expect
      .poll(() => committedRebinds(linkedDaemon.logText().slice(mark)), {
        timeout: RECOVERY_BUDGET_MS,
      })
      .toBe(1);
    await expectConnected(page, RECOVERY_BUDGET_MS);
    await page.keyboard.insertText(`printf 'generation-%s-ready\\n' ${generation}`);
    await page.keyboard.press('Enter');
    await expect(page.locator('body')).toContainText(`generation-${generation}-ready`);
  }
  expect(issuanceRequests).toBe(initialIssuances);
  await closeCarriers();
  // The daemon refuses commit nine; failed renewal on that held candidate
  // issues a successor without waiting for the authentication watchdog.
  await expect.poll(() => issuanceRequests, { timeout: 5_000 }).toBe(initialIssuances + 1);
  await expectConnected(page, RECOVERY_BUDGET_MS);
  for (let event = 0; event < 3; event += 1) {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // The expected output never appears verbatim in the typed command.
    await page.keyboard.insertText(`printf 'event-%s-ok\\n' ${event}`);
    await page.keyboard.press('Enter');
    await expect(page.locator('body')).toContainText(`event-${event}-ok`);
  }
  expect(cancellationRequests).toBe(0);
  expect(issuanceRequests).toBe(initialIssuances + 1);
  const successorMark = linkedDaemon.logText().length;
  await closeCarriers();
  await expect
    .poll(() => committedRebinds(linkedDaemon.logText().slice(successorMark)), {
      timeout: RECOVERY_BUDGET_MS,
    })
    .toBe(1);
  await expectConnected(page, RECOVERY_BUDGET_MS);
  expect(cancellationRequests).toBe(0);
  expect(issuanceRequests).toBe(initialIssuances + 1);
});

test('authorization renewal retains one session across twenty committed carrier changes', async ({
  page,
  linkedDaemon,
}) => {
  test.setTimeout(180_000);
  const closeCarriers = await observeBrowserCarriers(page);
  let issuances = 0;
  let renewals = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/sessions/request') issuances += 1;
    if (path === '/api/sessions/renew') renewals += 1;
  });
  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  await expectConnected(page, 40_000);
  const initialIssuances = issuances;
  for (let generation = 0; generation < 20; generation += 1) {
    const mark = linkedDaemon.logText().length;
    await closeCarriers();
    await expect
      .poll(() => committedRebinds(linkedDaemon.logText().slice(mark)), {
        timeout: RECOVERY_BUDGET_MS,
      })
      .toBe(1);
    await expectConnected(page, RECOVERY_BUDGET_MS);
    await page.keyboard.insertText(`printf 'renewal-%s-ready\\n' ${generation}`);
    await page.keyboard.press('Enter');
    await expect(page.locator('body')).toContainText(`renewal-${generation}-ready`);
    expect(issuances).toBe(initialIssuances);
  }
  expect(renewals).toBeGreaterThanOrEqual(2);
  expect(issuances).toBe(initialIssuances);
});

test('an expired authorization renews on the held carrier without replacing its session', async ({
  page,
  linkedDaemon,
}) => {
  test.skip(process.env.SESSION_TOKEN_TTL_MS !== '2000', 'Run with a real two-second capability');
  const closeCarriers = await observeBrowserCarriers(page);
  const release = Promise.withResolvers<void>();
  let renewalRequested = false;
  await page.route('**/api/sessions/renew', async (route) => {
    renewalRequested = true;
    await release.promise;
    await route.continue();
  });
  let issuances = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/sessions/request') issuances += 1;
  });
  try {
    await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
    await expectConnected(page, 40_000);
    const initial = issuances;
    const mark = linkedDaemon.logText().length;
    // Native wall time expires the real server-signed grant. Hold proactive
    // renewal so this must take the authenticated refusal path after the cut.
    await page.waitForTimeout(2_100);
    await expect.poll(() => renewalRequested).toBe(true);
    await closeCarriers();
    await expect.poll(() => linkedDaemon.logText().slice(mark)).toContain('lineage_expired');
    release.resolve();
    await expect
      .poll(() => committedRebinds(linkedDaemon.logText().slice(mark)), { timeout: 5_000 })
      .toBe(1);
    await expectConnected(page, 5_000);
    await page.keyboard.insertText("printf 'renewed-%s-ok\\n' expiry");
    await page.keyboard.press('Enter');
    await expect(page.locator('body')).toContainText('renewed-expiry-ok');
    expect(issuances).toBe(initial);
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('input acknowledged on the incumbent during candidate proof keeps its sequence namespace', async ({
  page,
  linkedDaemon,
}) => {
  const partitioned = await partitionEdgeProxy(1, 'browser-established').catch(() => false);
  test.skip(!partitioned, 'requires an isolated browser-path fault');
  await observeBrowserCarriers(page, true);
  let issuances = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/sessions/request') issuances += 1;
  });
  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  await expectConnected(page, 40_000);
  const initial = issuances;
  const mark = linkedDaemon.logText().length;
  for (const worker of page.workers())
    await worker.evaluate(() => Reflect.set(globalThis, '__rebindFinalFault', 'hold'));
  await partitionEdgeProxy(20_000, 'browser-established');
  await page.keyboard.insertText("printf 'during-%s-ok\\n' candidate");
  await page.keyboard.press('Enter');
  await expect
    .poll(
      async () =>
        (
          await Promise.all(
            page
              .workers()
              .map((worker) =>
                worker.evaluate(() => Reflect.get(globalThis, '__rebindFinalObserved') === true),
              ),
          )
        ).some(Boolean),
      { timeout: 5_000 },
    )
    .toBe(true);
  await partitionEdgeProxy(1, 'browser-established');
  // The final is still held. This output proves the incumbent accepted input
  // after the daemon took the answer's next_expected_input_seq snapshot.
  await expect(page.locator('body')).toContainText('during-candidate-ok', { timeout: 5_000 });
  expect(committedRebinds(linkedDaemon.logText().slice(mark))).toBe(0);
  for (const worker of page.workers())
    await worker.evaluate(() => {
      const release = Reflect.get(globalThis, '__releaseRebindFinal');
      if (typeof release === 'function') release();
    });
  await expect.poll(() => committedRebinds(linkedDaemon.logText().slice(mark))).toBe(1);
  await expectConnected(page, 5_000);
  await page.keyboard.insertText("printf 'after-%s-ok\\n' candidate");
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toContainText('after-candidate-ok');
  expect(issuances).toBe(initial);
});

for (const outcome of ['drop', 'committed'] as const) {
  test(`an uncertain ${outcome} final flight reconciles without replacing the session`, async ({
    page,
    linkedDaemon,
  }) => {
    const closeCarriers = await observeBrowserCarriers(page, true);
    let issuances = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/sessions/request') issuances += 1;
    });
    await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
    await expectConnected(page, 40_000);
    const initial = issuances;
    const mark = linkedDaemon.logText().length;
    for (const worker of page.workers())
      await worker.evaluate((mode) => Reflect.set(globalThis, '__rebindFinalFault', mode), outcome);
    await closeCarriers();
    await expect
      .poll(
        async () => {
          const seen = await Promise.all(
            page
              .workers()
              .map((worker) =>
                worker.evaluate(() => Reflect.get(globalThis, '__rebindFinalObserved') === true),
              ),
          );
          return seen.some(Boolean);
        },
        { timeout: RECOVERY_BUDGET_MS },
      )
      .toBe(true);
    // Reconciliation owns the candidate deadline. Waiting for its real close
    // avoids a page round trip that can arrive after the candidate is already gone.
    await expect
      .poll(
        async () => {
          const closed = await Promise.all(
            page
              .workers()
              .map((worker) =>
                worker.evaluate(() => Reflect.get(globalThis, '__rebindFinalClosed') === true),
              ),
          );
          return closed.some(Boolean);
        },
        { timeout: RECOVERY_BUDGET_MS },
      )
      .toBe(true);
    await expect
      .poll(() => committedRebinds(linkedDaemon.logText().slice(mark)), {
        timeout: RECOVERY_BUDGET_MS,
      })
      .toBe(outcome === 'committed' ? 2 : 1)
      .catch(async (error: unknown) => {
        const flights = await Promise.all(
          page
            .workers()
            .map((worker) => worker.evaluate(() => Reflect.get(globalThis, '__rebindFlights'))),
        );
        await test.info().attach('rebind-flights', {
          body: JSON.stringify(flights),
          contentType: 'application/json',
        });
        throw error;
      });
    await expectConnected(page, RECOVERY_BUDGET_MS);
    await page.keyboard.insertText("printf 'reconciled-%s-ok\\n' session");
    await page.keyboard.press('Enter');
    await expect(page.locator('body')).toContainText('reconciled-session-ok');
    expect(issuances).toBe(initial);
  });
}

test('suspension during a partition recovers one owner without an issuance storm', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  test.setTimeout(90_000);
  test.skip(
    page.context().browser()?.browserType().name() !== 'chromium',
    'CDP suspension requires Chromium',
  );
  const partitioned = await partitionEdgeProxy(1).catch(() => false);
  test.skip(!partitioned, 'requires the edge delay proxy');
  const closeCarriers = await observeBrowserCarriers(page);
  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  await expectConnected(page, 40_000);
  await page.keyboard.insertText("recovery_count=0; printf 'owner-%s-ready\\n' retained");
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toContainText('owner-retained-ready');
  await terminalPerf.reset();
  let issuances = 0;
  let cancellations = 0;
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/sessions/request') issuances += 1;
    if (pathname === '/api/sessions/request/cancel') cancellations += 1;
  });
  const navigationIdentity = await page.evaluate(() => performance.timeOrigin);
  const suspensionMs = CARRIER_IDLE_DEATH_MS + PARTITION_MS;
  const cdp = await page.context().newCDPSession(page);
  try {
    await partitionEdgeProxy(suspensionMs);
    // Exact native closure makes the oracle independent of Chromium retaining
    // its network process while the page and dedicated workers are frozen.
    await closeCarriers();
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await new Promise<void>((resolve) => setTimeout(resolve, suspensionMs));
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.keyboard.insertText(
      'recovery_count=$((recovery_count+1)); printf \'recovered-%s-times\\n\' "$recovery_count"',
    );
    await page.keyboard.press('Enter');
    await expect(page.locator('body')).toContainText('recovered-1-times', {
      timeout: RECOVERY_BUDGET_MS,
    });
    await expectConnected(page, RECOVERY_BUDGET_MS);
    // Read the shell counter independently: duplicate input would have changed
    // it even if the terminal's accessibility mirror coalesced output rows.
    await page.keyboard.insertText('printf \'verified-%s-times\\n\' "$recovery_count"');
    await page.keyboard.press('Enter');
    await expect(page.locator('body')).toContainText('verified-1-times');
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(navigationIdentity);
    expect(issuances, 'retained lineage recovers by rebind').toBe(0);
    expect(cancellations, 'hints must not abandon an issuance').toBe(0);
  } finally {
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await cdp.detach();
  }
});
