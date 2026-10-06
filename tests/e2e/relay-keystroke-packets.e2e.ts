import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { requestProxyImpairmentStats } from '../../scripts/edge-network-control';
import { expect, test } from './fixtures/daemon-process';
import {
  type DaemonLegPackets,
  daemonLegPackets,
  proxyWindowCounts,
  RELAY_PACKETS_REPORT_SCHEMA,
  type RelayPacketWindow,
} from './fixtures/relay-keystroke-packets';
import { expectOutput, primeTerminal } from './terminal-e2e-helpers';

/**
 * Packet census of a relay-pinned typing session (`bench:relay-keystroke-packets`).
 *
 * Reproduces the 2026-09-25 relay bytes-per-keystroke method as a committed
 * harness: `cat > /dev/null` echoes each printable key through the tty, and
 * the windows are 30 s idle, 30 keys at 1/s, 10 s idle, then 180 keys at 6/s.
 * The delay proxy counts every packet each relay forwards, per window; with
 * profiling on, the daemon's native trace shows which of its datagrams shared
 * a QUIC packet during the 6/s window. Chromium's net log, when the run sets
 * `PW_E2E_NETLOG`, is analysed afterwards against the window bounds this spec
 * writes. Profiling off is the production default; profiling on adds the
 * daemon's timing batches to the interactive connection, which is one of the
 * things this census attributes.
 *
 * With `FORCE_EDGE=0` it measures the direct path instead: the session upgrades
 * and the census asserts it stays there. Direct packets never cross the delay
 * proxy, so that arm's browser leg comes from the net log alone, and its daemon
 * leg from the native trace, whose datagram observer covers every connection.
 *
 * A measurement, not a gate: it asserts only that each window carried traffic
 * where it should, so a broken census cannot pass as a quiet link.
 */

const CONTROL_PORT = Number(process.env.EDGE_PROXY_CONTROL_PORT);
const DIRECT = process.env.FORCE_EDGE === '0';
const REPORT_DIR = process.env.RELAY_PACKETS_REPORT_DIR;
const SETTLE_MS = 5_000;

interface WindowPlan {
  readonly name: string;
  readonly durationMs: number;
  readonly keys: number;
}

const WINDOWS: readonly WindowPlan[] = [
  { name: 'idle-30s', durationMs: 30_000, keys: 0 },
  { name: 'keys-1ps', durationMs: 30_000, keys: 30 },
  { name: 'idle-10s', durationMs: 10_000, keys: 0 },
  { name: 'keys-6ps', durationMs: 30_000, keys: 180 },
];

async function typeAtCadence(page: Page, keys: number, durationMs: number): Promise<void> {
  const startedAt = Date.now();
  const intervalMs = durationMs / keys;
  for (let index = 0; index < keys; index += 1) {
    const due = startedAt + index * intervalMs;
    const wait = due - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    await page.keyboard.press(String.fromCharCode(0x61 + (index % 26)));
  }
  const remaining = startedAt + durationMs - Date.now();
  if (remaining > 0) await page.waitForTimeout(remaining);
}

for (const profiling of [false, true] as const) {
  const arm = `${DIRECT ? 'direct-' : ''}${profiling ? 'profiling-on' : 'profiling-off'}`;
  test(`relay keystroke packet census [${arm}]`, async ({ page, linkedDaemon }, testInfo) => {
    test.setTimeout(300_000);
    test.skip(
      !Number.isInteger(CONTROL_PORT) || CONTROL_PORT <= 0,
      'needs the edge harness delay proxy: set EDGE_NETWORK_PROFILE',
    );
    if (!profiling) {
      // The fixture seeds the profiling opt-in; the production default is off.
      await page.addInitScript(() => localStorage.removeItem('merkur:telemetry-enabled'));
      await page.reload();
    }

    const output = await primeTerminal(page, linkedDaemon.daemonName);
    await expect(
      page.getByText(DIRECT ? /^Direct(?: · \d+ms)?$/ : /^Relay(?: · \d+ms)?$/).first(),
      DIRECT
        ? 'the direct arm must upgrade and stay direct'
        : 'the census must stay pinned to the edge relay',
    ).toBeVisible({ timeout: 20_000 });
    // The marker is assembled by printf, so the echoed command cannot match it.
    await page.keyboard.type("printf '__relay_%s__\\n' packets; cat > /dev/null\n");
    await expectOutput(output, '__relay_packets__');
    await page.waitForTimeout(SETTLE_MS);

    const windows: RelayPacketWindow[] = [];
    let daemonLeg: DaemonLegPackets | null = null;
    let nativeErrors: readonly string[] = [];
    for (const plan of WINDOWS) {
      const measuresNative = profiling && plan.name === 'keys-6ps';
      // Drain what the native recorder holds, so the capture after this window
      // covers this window alone.
      if (measuresNative) await linkedDaemon.capturePerfTrace();
      await requestProxyImpairmentStats(CONTROL_PORT, 'reset');
      const startedAtMs = Date.now();
      if (plan.keys === 0) await page.waitForTimeout(plan.durationMs);
      else await typeAtCadence(page, plan.keys, plan.durationMs);
      const stats = await requestProxyImpairmentStats(CONTROL_PORT, 'stats');
      const endedAtMs = Date.now();
      windows.push({
        name: plan.name,
        keys: plan.keys,
        startedAtMs,
        endedAtMs,
        ...proxyWindowCounts(stats),
      });
      if (measuresNative) {
        const capture = await linkedDaemon.capturePerfTrace();
        nativeErrors = capture.errors;
        daemonLeg = daemonLegPackets(capture.chunks.flatMap((chunk) => chunk.records));
      }
    }

    const report = {
      schemaVersion: RELAY_PACKETS_REPORT_SCHEMA,
      arm,
      profiling,
      path: DIRECT ? 'direct' : 'relay',
      networkProfile: process.env.EDGE_NETWORK_PROFILE ?? null,
      netlog: process.env.PW_E2E_NETLOG ?? null,
      windows,
      daemonLeg,
      nativeErrors,
    };
    const body = `${JSON.stringify(report, null, 2)}\n`;
    await testInfo.attach(`relay-keystroke-packets-${arm}.json`, {
      body,
      contentType: 'application/json',
    });
    if (REPORT_DIR !== undefined) {
      mkdirSync(REPORT_DIR, { recursive: true });
      writeFileSync(path.join(REPORT_DIR, `relay-keystroke-packets-${arm}.json`), body);
    }

    for (const window of windows) {
      // Direct packets never cross the proxy: the net log carries that leg.
      if (window.keys > 0 && !DIRECT) {
        expect(window.browser.up, `${window.name} carried no browser uplink`).toBeGreaterThan(0);
        expect(window.daemon.up, `${window.name} carried no daemon uplink`).toBeGreaterThan(0);
      }
    }
    if (profiling) {
      expect(nativeErrors, 'native capture must be complete').toEqual([]);
      expect(
        daemonLeg?.inputAckDatagrams ?? 0,
        'the 6/s window must carry input ACKs',
      ).toBeGreaterThan(0);
    }
  });
}
