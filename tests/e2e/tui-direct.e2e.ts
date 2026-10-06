import { expect, test } from './fixtures/daemon-process';
import { floodAndSee, typeAndObserve, withHeadlessClient } from './fixtures/headless-client';

/**
 * The headless client races the daemon's direct WebTransport server beside the
 * edge relay and adopts it: the harness daemon offers loopback candidates, so
 * the race needs no punch. The daemon acks the upgrade only after the proof
 * under the session's direct-upgrade key verifies, and `path: Direct` follows
 * that ack. Input and display then ride the direct attachment.
 *
 * Needs `FORCE_EDGE=0`: `bun run test:e2e:handover`.
 */
test('the headless client upgrades to the direct path and types over it', async ({
  linkedDaemon,
  baseURL,
}) => {
  test.skip(process.env.FORCE_EDGE !== '0', 'the direct path is disabled unless FORCE_EDGE=0');
  await withHeadlessClient(linkedDaemon, baseURL, async (client) => {
    const paths = () =>
      client.events.filter((event) => event.event === 'path').map((event) => event.path);
    await client.next((event) => event.event === 'path' && event.path === 'Direct', 15_000);
    await typeAndObserve(client.child, 'direct');
    await floodAndSee(client, `tui-direct-${process.pid}`, 200);
    expect(paths(), 'the direct path is kept').toEqual(['Direct']);
  });
});
