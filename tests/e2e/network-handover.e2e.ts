import { RACE_DEADLINE_MS } from '@merkur/config/reconnect-policy';
import type { Page } from '@playwright/test';
import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';
import {
  DIRECT_PROXY_DIAL_MARKER,
  type DirectNetworkProxy,
  startDirectNetworkProxy,
} from './fixtures/direct-network-proxy';
import { moveEdgeProxyBrowserSource, partitionEdgeProxy } from './fixtures/test';

/**
 * The direct path follows the browser across a network change.
 *
 * The edge delay proxy moves where the edge sees the browser's connections come
 * from: `::1` (network A) or `127.0.0.1` (network B), both loopback, so the
 * daemon's manifest stays loopback-only and every direct dial crosses the
 * direct proxy. The direct proxy is blackholed while the browser is on a network
 * whose endpoints must be spent, so a dial there fails the way a filtered path
 * does, by never answering.
 *
 * Needs `FORCE_EDGE=0` and the edge delay proxy: `bun run test:e2e:handover`.
 */

const DIRECT_LABEL = /^Direct(?: · \d+ms)?$/;
const CONNECT_BUDGET_MS = 40_000;
const PATH_BUDGET_MS = 15_000;
/** Outlasts any race; the spec ends it explicitly with a 1 ms partition. */
const DIRECT_OUTAGE_MS = 60_000;
/** A dead carrier is noticed and replaced within this, as in `carrier-rebind`. */
const RECOVERY_BUDGET_MS = 15_000;
const BROWSER_OUTAGE_MS = 20_000;
const SEED = 0x6e_65_74_77;
const NETWORK_A = '::1';
const NETWORK_B = '127.0.0.1';

const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * The dataplane's own log lines, without colour. The daemon relays each one as
 * a `dataplane_stderr` JSON record; a record still being written is skipped.
 */
function dataplaneLines(log: string): string[] {
  const lines: string[] = [];
  for (const raw of log.split('\n')) {
    if (!raw.startsWith('{')) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const { message, context } = record as { message?: unknown; context?: { line?: unknown } };
    if (message !== 'dataplane_stderr' || typeof context?.line !== 'string') continue;
    for (const line of context.line.split('\n')) lines.push(line.replace(ANSI_SGR, ''));
  }
  return lines;
}

/** Dataplane log lines carrying every needle. */
function linesWith(log: string, ...needles: readonly string[]): string[] {
  return dataplaneLines(log).filter((line) => needles.every((needle) => line.includes(needle)));
}

function failedRaces(log: string): number {
  return linesWith(log, 'webtransport NAT outcome', 'outcome="failed"').length;
}

function pathMoves(log: string): string[] {
  return linesWith(log, 'browser signaling path moved');
}

function committedRebinds(log: string): number {
  return linesWith(log, 'rebind committed').length;
}

interface Handover {
  readonly proxy: DirectNetworkProxy;
  readonly dials: string[];
  readonly issuances: () => number;
}

/**
 * Connect on network A with the direct path blackholed, and return once the
 * race there has failed: every endpoint it dialled is spent for this visit.
 */
async function connectWithDirectSpent(
  page: Page,
  browserName: string,
  linkedDaemon: {
    readonly daemonName: string;
    readonly webTransportPort: number;
    logText(): string;
  },
): Promise<Handover> {
  test.skip(process.env.FORCE_EDGE !== '0', 'the direct path is disabled unless FORCE_EDGE=0');
  const moved = await moveEdgeProxyBrowserSource('configured').catch(() => null);
  test.skip(moved === null, 'a network change needs the edge delay proxy');
  // The linked daemon's page lives in its worker-scoped context, not the
  // test's own `context` fixture.
  const context = page.context();
  if (browserName === 'chromium') {
    await context.grantPermissions(['local-network-access'], {
      origin: new URL(page.url()).origin,
    });
  }
  const dials: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith(DIRECT_PROXY_DIAL_MARKER)) dials.push(message.text());
  });
  let issuances = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/sessions/request') issuances += 1;
  });
  const proxy = await startDirectNetworkProxy(context, linkedDaemon.webTransportPort, 'fast', SEED);
  try {
    await proxy.partition(DIRECT_OUTAGE_MS);
    const logMark = linkedDaemon.logText().length;
    await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
    await expectConnected(page, CONNECT_BUDGET_MS);
    await expect
      .poll(() => failedRaces(linkedDaemon.logText().slice(logMark)), {
        message: 'the race on network A must dial into the blackhole and give up',
        timeout: CONNECT_BUDGET_MS + RACE_DEADLINE_MS,
      })
      .toBe(1);
    expect(dials.length, 'the race must have dialled through the direct proxy').toBeGreaterThan(0);
    await expect(page.getByText(DIRECT_LABEL)).toHaveCount(0);
  } catch (error) {
    // The caller's `finally` owns the proxy only once this returns it.
    await proxy.close();
    throw error;
  }
  return { proxy, dials, issuances: () => issuances };
}

test('a migrating connection carries the direct path to each new network', async ({
  page,
  browserName,
  linkedDaemon,
}) => {
  const { proxy, dials, issuances } = await connectWithDirectSpent(page, browserName, linkedDaemon);
  const initialIssuances = issuances();
  try {
    const logMark = linkedDaemon.logText().length;
    const dialsOnA = dials.length;

    // A port-only move is a NAT rebinding, not another network: it moves
    // nothing. The move to B right behind it is reported first, and alone.
    await moveEdgeProxyBrowserSource('configured');
    await proxy.partition(DIRECT_OUTAGE_MS);
    await moveEdgeProxyBrowserSource('ipv4-loopback');
    await expect
      .poll(() => pathMoves(linkedDaemon.logText().slice(logMark)).length, {
        timeout: PATH_BUDGET_MS,
      })
      .toBe(1);
    expect(pathMoves(linkedDaemon.logText().slice(logMark))[0]).toContain(`address=${NETWORK_B}`);
    await expect
      .poll(
        () =>
          linesWith(
            linkedDaemon.logText().slice(logMark),
            'webtransport_manifest',
            `browser_address=${NETWORK_B}`,
          ).length,
        {
          message: 'the daemon re-sends its manifest for the new address',
          timeout: PATH_BUDGET_MS,
        },
      )
      .toBeGreaterThan(0);
    // What was spent on A is dialled again on B, and fails there too.
    await expect
      .poll(() => failedRaces(linkedDaemon.logText().slice(logMark)), {
        timeout: PATH_BUDGET_MS + RACE_DEADLINE_MS,
      })
      .toBe(1);
    expect(dials.length).toBeGreaterThan(dialsOnA);

    // Back on A: a new visit, so nothing is spent there any more.
    await proxy.partition(1);
    await moveEdgeProxyBrowserSource('configured');
    await expect(page.getByText(DIRECT_LABEL).first()).toBeVisible({ timeout: PATH_BUDGET_MS });
    const log = linkedDaemon.logText().slice(logMark);
    expect(pathMoves(log)).toHaveLength(2);
    expect(pathMoves(log)[1]).toContain(`address=${NETWORK_A}`);
    expect(committedRebinds(log), 'a migrated carrier needs no rebind').toBe(0);
    expect(issuances(), 'nor a new session').toBe(initialIssuances);
  } finally {
    await proxy.close();
  }
});

test('a network change that ends the carrier re-dials the direct path after the rebind', async ({
  page,
  browserName,
  linkedDaemon,
}) => {
  const partitioned = await partitionEdgeProxy(1, 'browser-established').catch(() => false);
  test.skip(!partitioned, 'this needs the delay proxy to cut established connections');
  const { proxy, issuances } = await connectWithDirectSpent(page, browserName, linkedDaemon);
  const initialIssuances = issuances();
  try {
    await proxy.partition(1);
    const logMark = linkedDaemon.logText().length;
    // The carrier on A dies for good; whatever dials now arrives from B. This
    // is how Chrome and Firefox change networks: a new connection, never a
    // migrated one.
    await partitionEdgeProxy(BROWSER_OUTAGE_MS, 'browser-established');
    await moveEdgeProxyBrowserSource('ipv4-loopback');
    await expect
      .poll(() => committedRebinds(linkedDaemon.logText().slice(logMark)), {
        message: 'the session must move to the new carrier by rebinding',
        timeout: RECOVERY_BUDGET_MS,
      })
      .toBeGreaterThanOrEqual(1);
    await expect(page.getByText(DIRECT_LABEL).first()).toBeVisible({ timeout: PATH_BUDGET_MS });
    expect(
      linesWith(
        linkedDaemon.logText().slice(logMark),
        'webtransport_manifest',
        `browser_address=${NETWORK_B}`,
      ).length,
      'the rebind carries the new address into the manifest',
    ).toBeGreaterThan(0);
    expect(issuances(), 'a rebind is not a new session').toBe(initialIssuances);
  } finally {
    await partitionEdgeProxy(1, 'browser-established').catch(() => false);
    await moveEdgeProxyBrowserSource('configured').catch(() => null);
    await proxy.close();
  }
});
