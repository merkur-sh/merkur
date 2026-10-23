import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Schema } from 'effect';
import { expect, test } from './fixtures/daemon-process';
import {
  floodAndSee,
  type HeadlessClient,
  presentedScreen,
  withHeadlessClient,
} from './fixtures/headless-client';
import { expectOutput, primeTerminal } from './terminal-e2e-helpers';

const topologyScript = path.resolve(__dirname, '../../scripts/natlab/native-topology.sh');
const decodeScreenRows = Schema.decodeUnknownSync(Schema.Array(Schema.String));

async function topologyCommand(...args: string[]): Promise<void> {
  await promisify(execFile)('bash', [topologyScript, ...args]);
}

async function captureEvidence(prefix: string): Promise<void> {
  const output = process.env.PW_E2E_OUTPUT_DIR;
  if (output === undefined) throw new Error('NAT-lab evidence directory is required');
  const directory = path.dirname(output);
  await topologyCommand('evidence', directory);
  for (const role of ['daemon', 'client']) {
    for (const suffix of ['conntrack.txt', 'nft.json']) {
      renameSync(
        path.join(directory, `${role}-${suffix}`),
        path.join(directory, `${prefix}-${role}-${suffix}`),
      );
    }
  }
}

async function waitForPacketEvidence(
  mode: '--wait-for-rebind-context' | '--wait-for-port-rebind',
): Promise<void> {
  const output = process.env.PW_E2E_OUTPUT_DIR;
  if (output === undefined) throw new Error('NAT-lab evidence directory is required');
  const directory = path.dirname(output);
  await promisify(execFile)('python3', [
    path.resolve(__dirname, '../../scripts/natlab/verify-native.py'),
    '--case',
    'eim-pdf',
    '--capture',
    path.join(directory, 'wan.pcap'),
    '--peer-capture',
    path.join(directory, 'client.pcap'),
    '--state',
    directory,
    mode,
  ]);
}

async function appendOnce(
  client: HeadlessClient,
  file: string,
  lines: string[],
  marker: string,
): Promise<void> {
  lines.push(marker);
  client.child.stdin.write(`printf '%s\\n' '${marker}' >> '${file}'\n`);
  await expect
    .poll(() => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []), {
      timeout: 20_000,
    })
    .toEqual(lines);
}

async function expectSelectedDirect(client: HeadlessClient): Promise<void> {
  await expect
    .poll(() => client.events.filter((event) => event.event === 'path').at(-1)?.path, {
      timeout: 30_000,
    })
    .toBe('Direct');
}

async function waitForPathTransition(
  client: HeadlessClient,
  since: number,
  selected: 'Direct' | 'Relay',
  timeoutMs: number,
): Promise<void> {
  await client.next(
    () =>
      client.events.slice(since).some((event) => event.event === 'path' && event.path === selected),
    timeoutMs,
  );
}

test.describe('constrained browser baseline', () => {
  test.skip(process.env.MERKUR_NATLAB_CASE !== 'eim-pdf', 'the constrained browser baseline');
  test('the constrained browser retains authenticated relay input and display', async ({
    linkedDaemon,
    page,
  }) => {
    const output = await primeTerminal(page, linkedDaemon.daemonName);
    const marker = `browser-nat-relay-${process.pid}`;
    await page.keyboard.type(`printf '%s%s\\n' browser-nat-relay- ${process.pid}\n`);
    await expectOutput(output, marker);
    await expect(page.getByText(/^Relay(?: · \d+ms)?$/u).first()).toBeVisible();
    await expect(page.getByText(/^Direct(?: · \d+ms)?$/u)).toHaveCount(0);
  });
});

/** Runs only in the isolated Linux topology scripts/natlab/native.sh owns. */
test('native traversal carries an authenticated terminal across the configured NATs', async ({
  linkedDaemon,
  baseURL,
}) => {
  const topology = process.env.MERKUR_NATLAB_CASE;
  const direct = !['blocked', 'edm-pdf', 'edm-both', 'inner-lease'].includes(topology ?? '');
  test.skip(topology === undefined, 'the controlled NAT topology is required');
  expect(process.platform).toBe('linux');
  expect(process.env.FORCE_EDGE).toBe('0');
  expect(process.env.MERKUR_E2E_DAEMON_NETNS).toBe('merkur-natlab-daemon');
  expect(process.env.MERKUR_E2E_CLIENT_NETNS).toBe('merkur-natlab-client');
  await topologyCommand('native-phase');
  await withHeadlessClient(linkedDaemon, baseURL, async (client) => {
    if (direct) {
      await client.next((event) => event.event === 'path' && event.path === 'Direct', 30_000);
    }
    const marker = `nat-${topology}-${process.pid}`;
    await floodAndSee(client, marker, 40);
    const screen = await presentedScreen(client);
    const rows = decodeScreenRows(screen.rows);
    expect(rows.filter((row) => row.trim() === marker)).toHaveLength(1);
    const paths = client.events
      .filter((event) => event.event === 'path')
      .map((event) => event.path);
    if (!direct) {
      expect(paths).not.toContain('Direct');
    } else {
      expect(paths).toContain('Direct');
      await captureEvidence('initial');
    }
    if (topology === 'eim-pdf') {
      const file = path.join(linkedDaemon.daemonHome, 'native-network-input-once');
      const lines: string[] = [];
      await appendOnce(client, file, lines, 'direct');
      let since = client.events.length;
      await topologyCommand('block-peer');
      // This input begins while the direct carrier is blackholed. Its own sequence must
      // survive retransmission and the authenticated relay takeover exactly once.
      await appendOnce(client, file, lines, 'during-direct-loss');
      await waitForPathTransition(client, since, 'Relay', 20_000);
      await floodAndSee(client, `nat-relay-${process.pid}`, 40);
      since = client.events.length;
      await topologyCommand('unblock-peer');
      await topologyCommand('move-client');
      await appendOnce(client, file, lines, 'during-network-change');
      await waitForPathTransition(client, since, 'Direct', 30_000);
      await floodAndSee(client, `nat-recovered-${process.pid}`, 40);
      expect(readFileSync(file, 'utf8').trim().split('\n')).toEqual(lines);
    }
    if (topology === 'client-lease-pcp') {
      const file = path.join(linkedDaemon.daemonHome, 'native-gateway-input-once');
      const lines: string[] = [];
      await appendOnce(client, file, lines, 'before-gateway-reboot');
      await topologyCommand('gateway-reboot', 'client');
      await appendOnce(client, file, lines, 'during-gateway-reboot');
      await floodAndSee(client, `nat-gateway-reboot-${process.pid}`, 80);
      await topologyCommand('wait-reacquired-lease', 'client');
      await expectSelectedDirect(client);
      await appendOnce(client, file, lines, 'after-gateway-reboot');
      await floodAndSee(client, `nat-reacquired-lease-${process.pid}`, 80);
      await captureEvidence('reboot');
      expect(readFileSync(file, 'utf8').trim().split('\n')).toEqual(lines);
    }
  });
});

test.describe('strict-filtering lifecycle', () => {
  test.skip(process.env.MERKUR_NATLAB_CASE !== 'eim-pdf', 'the strict-filtering lifecycle cases');
  test('native input survives duplicated delayed packets, port rebinding and a same-IP route change', async ({
    linkedDaemon,
    baseURL,
  }) => {
    await topologyCommand('clear-peer-flows');
    await withHeadlessClient(linkedDaemon, baseURL, async (client) => {
      await client.next((event) => event.event === 'path' && event.path === 'Direct', 30_000);
      const file = path.join(linkedDaemon.daemonHome, 'native-fault-input-once');
      const lines: string[] = [];
      await appendOnce(client, file, lines, 'before-faults');
      const ready = client.events.filter(
        (event) => event.event === 'status' && event.status === 'Ready',
      ).length;
      await topologyCommand('impair-peer');
      await appendOnce(client, file, lines, 'during-delay-and-duplicates');
      await floodAndSee(client, `nat-duplicates-${process.pid}`, 80);
      await topologyCommand('clear-impair');
      await captureEvidence('fault-before');
      await topologyCommand('port-rebind');
      await appendOnce(client, file, lines, 'during-port-rebind');
      await captureEvidence('fault-rebind-started');
      await waitForPacketEvidence('--wait-for-port-rebind');
      await expectSelectedDirect(client);
      await floodAndSee(client, `nat-port-rebound-${process.pid}`, 80);
      await captureEvidence('fault-rebound');
      const since = client.events.length;
      await topologyCommand('same-ip-route');
      await appendOnce(client, file, lines, 'during-same-ip-route-change');
      // The exact route event preserves a healthy authenticated provider. Discovery
      // remains demand-driven; terminal and packet evidence prove its continuity.
      await floodAndSee(client, `nat-same-ip-route-${process.pid}`, 80);
      await captureEvidence('fault-after');
      expect(client.events.filter((event) => event.event === 'path').at(-1)?.path).toBe('Direct');
      expect(
        client.events.filter((event) => event.event === 'status' && event.status === 'Ready'),
      ).toHaveLength(ready);
      expect(
        client.events
          .slice(since)
          .filter((event) => event.event === 'status' && event.status === 'Authenticating'),
      ).toHaveLength(0);
      expect(readFileSync(file, 'utf8').trim().split('\n')).toEqual(lines);
    });
  });

  test('two native sessions retain independent direct carriers on the daemon socket', async ({
    linkedDaemon,
    baseURL,
  }) => {
    await withHeadlessClient(linkedDaemon, baseURL, async (first) => {
      await first.next((event) => event.event === 'path' && event.path === 'Direct', 30_000);
      await withHeadlessClient(linkedDaemon, baseURL, async (second) => {
        await second.next((event) => event.event === 'path' && event.path === 'Direct', 30_000);
        await floodAndSee(first, `nat-first-${process.pid}`, 40);
        await floodAndSee(second, `nat-second-${process.pid}`, 40);
      });
      // Closing the second context must leave the first context's socket/check authority alive.
      await floodAndSee(first, `nat-survivor-${process.pid}`, 40);
      expect(first.events.filter((event) => event.event === 'path').at(-1)?.path).toBe('Direct');
    });
  });

  test('a committed rebind replaces native checks while retaining exactly-once terminal input', async ({
    linkedDaemon,
    baseURL,
  }) => {
    await withHeadlessClient(linkedDaemon, baseURL, async (client) => {
      await client.next((event) => event.event === 'path' && event.path === 'Direct', 30_000);
      const file = path.join(linkedDaemon.daemonHome, 'native-rebind-input-once');
      const lines: string[] = [];
      await appendOnce(client, file, lines, 'before-commit');
      const logMark = linkedDaemon.logText().length;
      const ready = () =>
        client.events.filter((event) => event.event === 'status' && event.status === 'Ready')
          .length;
      expect(ready()).toBe(1);
      await topologyCommand('partition-established');
      await appendOnce(client, file, lines, 'during-commit');
      await client.next(() => ready() === 2, 20_000);
      await expect
        .poll(() => linkedDaemon.logText().slice(logMark), { timeout: 20_000 })
        .toContain('rebind committed');
      expect(
        client.events.filter(
          (event) => event.event === 'status' && event.status === 'Authenticating',
        ),
      ).toHaveLength(1);
      const since = client.events.length;
      await topologyCommand('rebind-committed');
      await topologyCommand('unblock-peer');
      await captureEvidence('rebind-started');
      await waitForPacketEvidence('--wait-for-rebind-context');
      await waitForPathTransition(client, since, 'Direct', 30_000);
      await appendOnce(client, file, lines, 'after-commit');
      await floodAndSee(client, `nat-rebind-${process.pid}`, 40);
      await captureEvidence('rebind-after');
      expect(readFileSync(file, 'utf8').trim().split('\n')).toEqual(lines);
    });
  });
});
