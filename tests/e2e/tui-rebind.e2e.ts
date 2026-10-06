import { requestProxyControl } from '../../scripts/edge-network-control';
import { expect, test } from './fixtures/daemon-process';
import { floodAndSee, typeAndObserve, withHeadlessClient } from './fixtures/headless-client';

/**
 * Every carrier the client holds goes dark while new dials still reach the
 * edge. The liveness ladder notices, a candidate rebinds with the chaining
 * secret, and only the daemon's commit acknowledgement publishes it: the
 * second Ready is the fresh data attachment on the published candidate, and
 * the command typed after it runs under the successor keys. The grid carries
 * across the new carrier: the client claims it, the daemon answers the claim
 * with a repair rather than a snapshot, and its grants restart on it.
 *
 * The partition darkens every browser carrier the proxy holds, so this spec
 * runs alone in `test:e2e:rebind`, never in the parallel functional phase.
 */
test('the headless client rebinds onto a fresh carrier when its carriers go dark', async ({
  linkedDaemon,
  baseURL,
}) => {
  const controlPort = Number(process.env.EDGE_PROXY_CONTROL_PORT);
  expect(
    Number.isInteger(controlPort) && controlPort > 0,
    'the harness delay proxy is running',
  ).toBe(true);
  await withHeadlessClient(linkedDaemon, baseURL, async (client) => {
    const { child, events, next } = client;
    await typeAndObserve(child, 'before');
    const statuses = (status: string) =>
      events.filter((event) => event.event === 'status' && event.status === status).length;
    const count = (name: string) => events.filter((event) => event.event === name).length;
    expect(statuses('Ready')).toBe(1);
    // The first snapshot can precede the headless client's viewport claim.
    // Measure rebind snapshots only after the daemon applies that viewport.
    await next(
      (event) => event.event === 'snapshot' && event.cols === 80 && event.rows === 24,
      15_000,
    );
    const snapshots = count('snapshot');
    const logMark = linkedDaemon.logText().length;
    await requestProxyControl(controlPort, 'partition-browser-established', '30000', 'partitioned');
    await next(() => statuses('Ready') === 2, 20_000);
    // A fresh issuance authenticates flight 1 again; a rebind never does.
    expect(statuses('Authenticating'), 'a rebind, not a fresh issuance').toBe(1);
    await typeAndObserve(child, 'after');
    await floodAndSee(client, `tui-rebound-${process.pid}`, 200);

    // The rebound grid was claimed, repaired, and never repainted.
    const resumes = events.filter((event) => event.event === 'resume');
    expect(resumes.map((event) => event.kept)).toEqual([true]);
    expect(count('snapshot'), JSON.stringify(events.filter((e) => e.event !== 'screen'))).toBe(
      snapshots,
    );
    const screen = events.filter((event) => event.event === 'screen').at(-1);
    expect(screen?.repairs, JSON.stringify(screen)).toBe(1);
    const log = linkedDaemon.logText().slice(logMark);
    expect(log).toContain('incremental resume accepted');
    expect(log).not.toContain('incremental resume rejected');
  });
});
