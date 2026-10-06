import { type ChildProcess, spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import path from 'node:path';
import type { BrowserContext } from '@playwright/test';
import {
  requestProxyControl,
  requestProxyImpairmentStats,
} from '../../../scripts/edge-network-control';
import {
  EDGE_NETWORK_PROFILES,
  type EdgeNetworkLink,
  type EdgeNetworkProfileName,
  edgeNetworkLinkSpec,
} from '../../../scripts/edge-network-profile';
import type { ProxyImpairmentStats } from '../../../scripts/edge-network-stats';
import {
  redirectTransportWorker,
  type TransportWorkerRedirect,
  type TransportWorkerSource,
  transportWorkerPrelude,
} from './transport-worker-prelude';

const PROXY_BINARY = path.resolve(__dirname, '../../../target/rust/release/delay_proxy');
export const DIRECT_PROXY_DIAL_MARKER = '[merkur-direct-proxy-dial]';

function directRedirect(backendPort: number, proxyPort: number): TransportWorkerRedirect {
  return {
    from: backendPort,
    to: proxyPort,
    marker: DIRECT_PROXY_DIAL_MARKER,
    label: 'direct proxy',
    candidate: 'direct backend',
  };
}

/**
 * Test-only address translation, installed before the worker handles any
 * session. Native options, TLS certificate pins, QUIC and Merkur encryption
 * are untouched. There is no per-input/datagram/render observer on this path.
 */
export function directProxyWorkerPrelude(backendPort: number, proxyPort: number): string {
  return transportWorkerPrelude([directRedirect(backendPort, proxyPort)]);
}

/**
 * Where a declared link sits on the direct path's two hops. The browser dials
 * the outer hop, which relays to the inner hop, which relays to the daemon:
 * both hops see the browser side as their client. So the daemon's uplink is
 * the inner hop's downstream and the browser's downlink the outer hop's.
 */
function directHopLinks(links: readonly EdgeNetworkLink[]): {
  readonly inner: Record<string, string>;
  readonly outer: Record<string, string>;
} {
  const inner: Record<string, string> = {};
  const outer: Record<string, string> = {};
  for (const link of links) {
    // Daemon-side links are the inner hop's, reversed in direction.
    const hop = link.role === 'daemon' ? inner : outer;
    const direction =
      link.role === 'daemon'
        ? link.direction === 'up'
          ? 'DOWN'
          : 'UP'
        : link.direction.toUpperCase();
    hop[`BOTTLENECK_BROWSER_${direction}`] = edgeNetworkLinkSpec(link);
  }
  return { inner, outer };
}

export interface DirectNetworkProxy {
  readonly profile: EdgeNetworkProfileName;
  readonly targetRttMs: number;
  readonly backendPort: number;
  readonly proxyPorts: readonly number[];
  readonly sourceHashes: readonly TransportWorkerSource[];
  reset(): Promise<readonly ProxyImpairmentStats[]>;
  stats(): Promise<readonly ProxyImpairmentStats[]>;
  /** Phase-boundary drain only; never called between interactive keystrokes. */
  settledStats(): Promise<readonly ProxyImpairmentStats[]>;
  /**
   * Blackhole the direct path, new dials included, for `durationMs`. A later
   * call replaces the running one, so 1 ms ends it.
   */
  partition(durationMs: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Two transparent UDP hops provide four 1/4-RTT legs on the DIRECT carrier.
 * Unlike FORCE_EDGE=0 alone, this cannot silently bypass the edge emulator.
 * Both hops are clean here; impaired extensions must put loss/reordering at
 * only the outer downstream hop, never multiply the logical fault sites.
 * `links` puts a profile's capacity bottleneck on the hop nearest its peer.
 */
export async function startDirectNetworkProxy(
  context: BrowserContext,
  backendPort: number,
  profileName: EdgeNetworkProfileName,
  seed: number,
  links: readonly EdgeNetworkLink[] = [],
): Promise<DirectNetworkProxy> {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff)
    throw new Error('direct proxy seed must be a u32');
  const profile = EDGE_NETWORK_PROFILES[profileName];
  const ports: number[] = [];
  while (ports.length < 4) {
    const port = await unusedUdpPort();
    if (port !== backendPort && !ports.includes(port)) ports.push(port);
  }
  const [outerPort, innerPort, outerControl, innerControl] = ports;
  if (
    outerPort === undefined ||
    innerPort === undefined ||
    outerControl === undefined ||
    innerControl === undefined
  ) {
    throw new Error('direct proxy port reservation failed');
  }
  const children: ChildProcess[] = [];
  let failure: Error | null = null;
  let closing = false;
  let redirect: Awaited<ReturnType<typeof redirectTransportWorker>> | null = null;
  const hopLinks = directHopLinks(links);
  async function launch(
    listen: number,
    upstream: number,
    control: number,
    hopSeed: number,
    hopLinkEnvironment: Record<string, string>,
  ): Promise<void> {
    const child = spawn(PROXY_BINARY, [], {
      env: {
        ...process.env,
        ...hopLinkEnvironment,
        LISTEN_BROWSER: `[::1]:${listen}`,
        UPSTREAM: `[::1]:${upstream}`,
        CONTROL_LISTEN: `[::1]:${control}`,
        PROFILE: profileName,
        TARGET_RTT_MS: String(profile.targetRttMs),
        BASE_DELAY_US: String(profile.hopDelayUs),
        JITTER_RADIUS_US: String(profile.oneWayJitterUs / 4),
        DATAGRAM_LOSS_PERCENT: '0',
        REORDER: 'none',
        SCENARIO: 'steady',
        SEED: String(hopSeed),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let tail = '';
      const timer = setTimeout(
        () => reject(new Error(`direct proxy startup timeout: ${tail}`)),
        5_000,
      );
      const fail = (error: Error): void => {
        if (closing) return;
        failure = error;
        clearTimeout(timer);
        reject(error);
      };
      const observe = (chunk: Buffer): void => {
        tail = (tail + chunk.toString('utf8')).slice(-8192);
        if (/delay_proxy: dropped/.test(tail))
          fail(new Error(`direct proxy queue overflow: ${tail}`));
        if (!ready && tail.includes(`delay_proxy: ready browser=[::1]:${listen} `)) {
          ready = true;
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout?.on('data', observe);
      child.stderr?.on('data', observe);
      child.once('error', fail);
      child.once('exit', (code, signal) =>
        fail(new Error(`direct proxy exited ${code}/${signal}`)),
      );
    });
  }
  async function close(): Promise<void> {
    closing = true;
    try {
      await redirect?.remove();
    } finally {
      await Promise.all(children.map(stopChild));
    }
  }
  try {
    await launch(innerPort, backendPort, innerControl, (seed ^ 0x9e3779b9) >>> 0, hopLinks.inner);
    await launch(outerPort, innerPort, outerControl, seed >>> 0, hopLinks.outer);
    redirect = await redirectTransportWorker(context, directRedirect(backendPort, outerPort));
    const sourceHashes = redirect.sourceHashes;
    const request = async (kind: 'reset' | 'stats'): Promise<readonly ProxyImpairmentStats[]> => {
      if (failure !== null) throw failure;
      return Promise.all(
        [outerControl, innerControl].map((port) => requestProxyImpairmentStats(port, kind)),
      );
    };
    return {
      profile: profileName,
      targetRttMs: profile.targetRttMs,
      backendPort,
      proxyPorts: [outerPort, innerPort],
      sourceHashes,
      reset: () => request('reset'),
      stats: () => request('stats'),
      settledStats: async () => {
        const deadline = performance.now() + 5_000;
        do {
          const stats = await request('stats');
          if (stats.every((hop) => hop.pendingScheduledPackets === 0)) return stats;
          await new Promise((resolve) => setTimeout(resolve, 20));
        } while (performance.now() < deadline);
        throw new Error('direct proxy did not drain at phase boundary');
      },
      partition: async (durationMs) => {
        if (failure !== null) throw failure;
        await requestProxyControl(
          outerControl,
          'partition',
          String(Math.round(durationMs)),
          'partitioned',
        );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function unusedUdpPort(): Promise<number> {
  const socket = createSocket('udp6');
  return new Promise((resolve, reject) => {
    socket.once('error', (error) => {
      socket.close();
      reject(error);
    });
    socket.bind(0, '::1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
