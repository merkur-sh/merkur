import { EDGE_ROUTING_PREFACE_VERSION } from '@merkur/shared/transport';
import type { Page } from '@playwright/test';
import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';

interface Registration {
  readonly edgeId: string;
  readonly edgeRegion: string;
  readonly edgeWtUrl: string;
  /** The certificate the edge serves; `certHashes` is it, then the next one. */
  readonly certHash: string;
  readonly certHashes: readonly string[];
}

interface Tickets {
  readonly browser: string;
  readonly daemon: string;
}

const CONTROL_URL = process.env.EDGE_TOPOLOGY_CONTROL_URL ?? '';
/**
 * The probe's splices name a daemon no account links, so the incarnation its
 * daemon role announces retires nothing the real daemon holds.
 */
const PROBE_DAEMON_ID = 'edge-topology-probe';
const PROBE_INCARNATION = 'ZWRnZS10b3BvbG9neS1wcg';
/** `DELIVERY_QUOTE_STREAM_PREFACE` in apps/edge/src/relay.rs. */
const DELIVERY_QUOTE_STREAM_PREFACE = 'merkur-edge-quote-v1';

/**
 * This spec dials the edges directly from the page to prove the splice relays
 * datagrams unchanged, which the document's own CSP forbids.
 *
 * That is not a hole in the CSP — it is the CSP working. `connect-src 'self'`
 * (apps/server/src/middleware/security-headers.ts) deliberately denies the
 * document any outbound origin, and only the transport worker's response widens
 * it to `https:`, so production Merkur never dials an edge from the document.
 * A probe written before that tightening landed does, so it needs the bypass.
 * The policy itself is asserted in `security-headers.test.ts`; relaxing it here
 * costs no coverage and keeps this spec about relay topology.
 */
test.use({ linkedDaemonContextOptions: { bypassCSP: true } });

test('real server and daemon use one replica and survive its certificate rotations', async ({
  page,
  baseURL,
  linkedDaemon,
}) => {
  expect(CONTROL_URL, 'EDGE_TOPOLOGY_CONTROL_URL must be set').not.toBe('');
  expect(baseURL).toBeDefined();
  await page.goto(baseURL ?? 'about:blank');

  let initial: Registration[] = [];
  await expect
    .poll(async () => {
      initial = await readRegistrations();
      return initial.length;
    })
    .toBe(2);
  expect(new Set(initial.map((edge) => edge.edgeRegion))).toEqual(new Set(['iad', 'fra']));
  expect(new Set(initial.map((edge) => edge.edgeWtUrl)).size).toBe(2);

  for (const edge of initial) {
    await expect(connect(page, edge, edge.edgeId)).resolves.toBe('ready');
  }

  const sessionStatuses: number[] = [];
  page.on('response', (response) => {
    if (response.url().endsWith('/api/sessions/request')) {
      sessionStatuses.push(response.status());
    }
  });
  const sessionResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/api/sessions/request'),
  );
  await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
  const sessionResponse = await sessionResponsePromise;
  const sessionBody = (await sessionResponse.json()) as { readonly edgeWtUrl?: unknown };
  const selectedEdge = initial.find((edge) => edge.edgeWtUrl === sessionBody.edgeWtUrl);
  expect(selectedEdge, 'server must select a registered replica-specific URL').toBeDefined();
  await expectConnected(page, 20_000);
  expect(sessionStatuses).toEqual([200]);

  const receivedBeforeRotation = await receivedBytes(page);
  await page.keyboard.type('echo before-edge-rotation\n');
  await expect
    .poll(() => receivedBytes(page), { timeout: 15_000 })
    .toBeGreaterThan(receivedBeforeRotation + 10);

  if (selectedEdge === undefined) throw new Error('selected edge was not observed');
  // A rotation serves the certificate the edge already published as its next,
  // so the pins a peer learned before it still dial.
  const rotated = await rotate(selectedEdge);
  expect(rotated.certHash).toBe(selectedEdge.certHashes[1]);
  expect(rotated.certHashes).toHaveLength(2);
  expect(rotated.certHashes).not.toContain(selectedEdge.certHash);

  const oldConnectionState = await page.evaluate(async (selectedEdgeId) => {
    const transports = (
      globalThis as unknown as { __edgeTopologyTransports?: Record<string, WebTransport> }
    ).__edgeTopologyTransports;
    const transport = transports?.[`${selectedEdgeId}-browser`];
    if (transport === undefined) return 'missing';
    return await Promise.race([
      transport.closed.then(() => 'closed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('open'), 750)),
    ]);
  }, selectedEdge.edgeId);
  expect(oldConnectionState).toBe('open');
  await expect(connect(page, selectedEdge, `${selectedEdge.edgeId}-pinned-before`)).resolves.toBe(
    'ready',
  );

  const receivedAfterRotation = await receivedBytes(page);
  await page.keyboard.type('echo after-edge-rotation\n');
  await expect
    .poll(() => receivedBytes(page), { timeout: 15_000 })
    .toBeGreaterThan(receivedAfterRotation + 10);

  // A second rotation retires both certificates the first pins named: only
  // the server's newest statement of them dials now.
  const twice = await rotate(rotated);
  expect(twice.certHash).toBe(rotated.certHashes[1]);
  await expect(connect(page, selectedEdge, `${selectedEdge.edgeId}-stale`)).rejects.toThrow();
  await expect(connect(page, twice, `${selectedEdge.edgeId}-current`)).resolves.toBe('ready');

  const receivedAfterSecondRotation = await receivedBytes(page);
  await page.keyboard.type('echo after-second-edge-rotation\n');
  await expect
    .poll(() => receivedBytes(page), { timeout: 15_000 })
    .toBeGreaterThan(receivedAfterSecondRotation + 10);

  await page.evaluate(() => {
    const global = globalThis as unknown as {
      __edgeTopologyTransports?: Record<string, WebTransport>;
      __edgeTopologyWriters?: Record<string, WritableStreamDefaultWriter<Uint8Array>>;
    };
    for (const writer of Object.values(global.__edgeTopologyWriters ?? {})) {
      void writer.close();
    }
    for (const transport of Object.values(global.__edgeTopologyTransports ?? {})) {
      transport.close();
    }
  });
});

/**
 * Region-aware selection, proven through the real server rather than in a unit.
 *
 * The daemon here runs on loopback, whose address carries no location, so the
 * daemon anchor abstains and the browser tie-break is what decides. That is the
 * seam worth exercising end to end: `zoneForIp` running on the server's own
 * trusted-proxy resolution, feeding `selectEdge`, choosing between two edges
 * that really are registered under different regions.
 *
 * `X-Forwarded-For` is honest here rather than a trick — the e2e server already
 * runs with `TRUSTED_PROXY_HOPS=1`, so this is the same header a real
 * deployment reads behind its proxy.
 */
for (const { zone, browserIp, expectedRegion } of [
  { zone: 'na', browserIp: '8.8.8.8', expectedRegion: 'iad' },
  { zone: 'eu', browserIp: '193.0.6.139', expectedRegion: 'fra' },
] as const) {
  test(`a browser in ${zone} is placed on the ${expectedRegion} edge`, async ({
    page,
    baseURL,
    linkedDaemon,
  }) => {
    expect(CONTROL_URL, 'EDGE_TOPOLOGY_CONTROL_URL must be set').not.toBe('');
    await page.route('**/api/sessions/request', async (route) => {
      await route.continue({
        headers: { ...route.request().headers(), 'x-forwarded-for': browserIp },
      });
    });

    const registrations = await readRegistrations();
    expect(new Set(registrations.map((edge) => edge.edgeRegion))).toEqual(new Set(['iad', 'fra']));

    const sessionResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith('/api/sessions/request'),
    );
    await page.goto(baseURL ?? 'about:blank');
    await page.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
    const sessionResponse = await sessionResponsePromise;
    expect(sessionResponse.status()).toBe(200);
    const body = (await sessionResponse.json()) as { readonly edgeWtUrl?: unknown };

    const selected = registrations.find((edge) => edge.edgeWtUrl === body.edgeWtUrl);
    expect(selected, 'server must select a registered replica').toBeDefined();
    expect(selected?.edgeRegion).toBe(expectedRegion);
  });
}

async function readRegistrations(): Promise<Registration[]> {
  const response = await fetch(`${CONTROL_URL}/registrations`);
  if (!response.ok) throw new Error(`registration control returned ${response.status}`);
  return (await response.json()) as Registration[];
}

/** SIGHUP one edge and wait for the pair it publishes once it serves the next certificate. */
async function rotate(before: Registration): Promise<Registration> {
  const response = await fetch(`${CONTROL_URL}/rotate/${before.edgeId}`, { method: 'POST' });
  expect(response.ok).toBe(true);
  let after: Registration | undefined;
  await expect
    .poll(async () => {
      after = (await readRegistrations()).find((edge) => edge.edgeId === before.edgeId);
      return after?.certHash;
    })
    .not.toBe(before.certHash);
  if (after === undefined) throw new Error(`${before.edgeId} stopped registering`);
  return after;
}

async function readTickets(sessionId: string): Promise<Tickets> {
  const query = new URLSearchParams({ daemon: PROBE_DAEMON_ID, session: sessionId });
  const response = await fetch(`${CONTROL_URL}/tickets?${query}`);
  if (!response.ok) throw new Error(`ticket control returned ${response.status}`);
  return (await response.json()) as Tickets;
}

async function receivedBytes(page: Page): Promise<number> {
  return page.evaluate(() => {
    const title =
      document.querySelector<HTMLElement>(
        '[role="img"][title*="Traffic: sent above, received below."]',
      )?.title ?? '';
    const value = /received ([\d,]+) B/.exec(title)?.[1];
    return value === undefined ? 0 : Number(value.replaceAll(',', ''));
  });
}

async function connect(page: Page, registration: Registration, key: string): Promise<string> {
  const sessionId = `topology-${key}`;
  const tickets = await readTickets(sessionId);
  return await page.evaluate(
    async ({ edge, transportKey, sessionId, tickets, probe }) => {
      const hashes = edge.certHashes.map((hash) => {
        const binary = atob(hash);
        const value = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          value[index] = binary.charCodeAt(index);
        }
        return { algorithm: 'sha-256', value };
      });
      const global = globalThis as unknown as {
        __edgeTopologyTransports?: Record<string, WebTransport>;
        __edgeTopologyWriters?: Record<string, WritableStreamDefaultWriter<Uint8Array>>;
      };
      const transports = global.__edgeTopologyTransports ?? {};
      const writers = global.__edgeTopologyWriters ?? {};
      global.__edgeTopologyTransports = transports;
      global.__edgeTopologyWriters = writers;

      const openRole = async (role: 'browser' | 'daemon'): Promise<WebTransport> => {
        const transport = new WebTransport(edge.edgeWtUrl, { serverCertificateHashes: hashes });
        await Promise.race([
          transport.ready,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`WebTransport ready timeout for ${edge.edgeId}`)),
              8_000,
            ),
          ),
        ]);
        const stream = await transport.createBidirectionalStream();
        const writer = stream.writable.getWriter();
        const json = new TextEncoder().encode(
          JSON.stringify({
            session_id: sessionId,
            role,
            version: probe.version,
            attachment:
              role === 'browser'
                ? { kind: 'primary' }
                : { kind: 'tunnel', incarnation: probe.incarnation },
            daemon_id: probe.daemonId,
            ticket: tickets[role],
          }),
        );
        const preface = new Uint8Array(4 + json.byteLength);
        new DataView(preface.buffer).setUint32(0, json.byteLength);
        preface.set(json, 4);
        await writer.write(preface);
        transports[`${transportKey}-${role}`] = transport;
        writers[`${transportKey}-${role}`] = writer;
        if (role === 'daemon') {
          // The edge attaches a daemon once it holds its delivery-quote stream.
          const quotes = (await transport.createBidirectionalStream()).writable.getWriter();
          await quotes.write(new TextEncoder().encode(probe.quoteStreamPreface));
          writers[`${transportKey}-quotes`] = quotes;
        }
        return transport;
      };

      const browser = await openRole('browser');
      const daemon = await openRole('daemon');
      await new Promise((resolve) => setTimeout(resolve, 200));

      const payload = new Uint8Array([0x71, 0x72, 0x73]);
      const reader = daemon.datagrams.readable.getReader();
      const browserDatagrams = browser.datagrams as WebTransportDatagramDuplexStream & {
        createWritable?: () => WritableStream<Uint8Array>;
      };
      const writer =
        typeof browserDatagrams.createWritable === 'function'
          ? browserDatagrams.createWritable().getWriter()
          : browserDatagrams.writable.getWriter();
      await writer.write(payload);
      const received = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`splice timeout for ${edge.edgeId}`)), 5_000),
        ),
      ]);
      writer.releaseLock();
      reader.releaseLock();
      if (
        received.done ||
        received.value.byteLength !== payload.byteLength ||
        !received.value.every((byte: number, index: number) => byte === payload[index])
      ) {
        throw new Error(`splice changed the datagram for ${edge.edgeId}`);
      }
      return 'ready';
    },
    {
      edge: registration,
      transportKey: key,
      sessionId,
      tickets,
      probe: {
        version: EDGE_ROUTING_PREFACE_VERSION,
        daemonId: PROBE_DAEMON_ID,
        incarnation: PROBE_INCARNATION,
        quoteStreamPreface: DELIVERY_QUOTE_STREAM_PREFACE,
      },
    },
  );
}
