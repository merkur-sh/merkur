/**
 * Orchestrates the real-browser-over-edge reproduction harness.
 *
 * Boots a local merkur-edge (optionally behind the deterministic network
 * profile proxy), captures
 * its self-signed cert hash, exports the edge coordinates, then runs the
 * Playwright edge spec (which links a real daemon and drives real Chromium
 * through the edge relay). The edge cert hash must be known BEFORE Playwright's
 * webServer starts the edge-configured server, which is why this runner exists
 * rather than a Playwright globalSetup (webServer env is fixed at config load).
 *
 * Env knobs:
 *   EDGE_PORT          edge UDP/QUIC port (default 4433)
 *   EDGE_NETWORK_PROFILE       fast (50 ms), typical (120 ms), or difficult
 *                              (200 ms). The proxy uses one quarter of that
 *                              application RTT on each of four traversed legs.
 *   EDGE_NETWORK_DATAGRAM_LOSS_PERCENT
 *                              seeded exact-rate UDP datagram loss at the sole
 *                              edge-to-client fault site: 0, 1, 3, or 9
 *   EDGE_NETWORK_REORDER       none, light (1%), or moderate (5%)
 *   EDGE_NETWORK_SCENARIO      steady, burst-loss, congestion, or
 *                              handshake-split. The last is the specific
 *                              coalesced-flight fault from PERF.md 2026-08-30.
 *   EDGE_NETWORK_SEED          unsigned 32-bit trace seed
 *   EDGE_NETWORK_BOTTLENECK    a capacity bottleneck from `EDGE_NETWORK_BOTTLENECKS`
 *                              (uplink-bloat, downlink-bloat, ...): one shared
 *                              drop-tail or flow-queued link on one peer's side
 *   EDGE_NETWORK_COMPETITOR    daemon or browser: a CUBIC bulk flow
 *                              (`bulk_competitor`) that shares that peer's link
 *   EDGE_NETWORK_COMPANION_RTT_MS
 *                              explicit slower companion only with FORCE_EDGE=0
 *                              and DIRECT_NETWORK_PROFILE; primary profiles stay
 *                              50/120/200 ms. Example: difficult base + 300 ms.
 *   FORCE_EDGE         defaults to 1 so tests cannot silently upgrade around
 *                      the impairment proxy; set to 0 only for direct-upgrade
 *                      tests
 *   MERKUR_EDGE_HARNESS_NATIVE_ARTIFACT_MANIFEST
 *                      absolute resolved path to the strict benchmark preflight
 *                      manifest. When supplied, its source closure, toolchain,
 *                      build flags and artifact bytes must all match; failure
 *                      aborts without falling back to a local rebuild.
 *   E2E_TRANSPORT_WORKERS  worker count for the default (no-filter) run's
 *                      parallel functional phase; defaults to one per three
 *                      cores (a worker runs Chromium + daemon + dataplane)
 *
 * One browser harness runs per host (`host-harness-lock.ts`): a second waits for
 * the first instead of loading the machine under its latency phase.
 *
 * Additional arguments are forwarded to Playwright for targeted runs, which
 * also opts out of the two-phase split below: a filtered run is a single
 * Playwright invocation with whatever workers/flags the caller passed, exactly
 * as before.
 *
 * With no arguments (the plain `test:e2e:transport` case), Playwright's
 * `workers: 1` config default runs all fourteen specs one at a time even though
 * most of them fixture a fully independent daemon, account, and browser
 * context per Playwright *worker* (`linkedDaemonWorker` in
 * `tests/e2e/fixtures/daemon-process.ts` — worker-scoped, so N workers means N
 * isolated daemons against the one shared edge process and one shared,
 * WAL-mode server DB, both already built for concurrent sessions). Three specs
 * — `transport-latency`, `terminal-performance-matrix`, `startup-latency` —
 * assert hard p95 millisecond budgets against a real GPU fence and must stay
 * uncontended, so they run alone, in a strictly serial phase FIRST: what runs
 * before a timing measurement is part of that measurement, and a host that has
 * just torn down a parallel phase is not a quiet one. `terminal-input-matrix.e2e.ts`
 * alone was 6.2 of the ~14 total minutes (PERF.md, 2026-08-25);
 * fully-parallelizing its ~40 independent tests is the actual win.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EDGE_HARNESS_NATIVE_BUILD_COMMANDS,
  EDGE_HARNESS_NATIVE_MANIFEST_ENV,
  type EdgeHarnessNativeArtifactProvenance,
  provisionEdgeHarnessNativeArtifacts,
  verifyProvisionedNativeArtifacts,
} from './edge-harness-native-artifacts';
import { requestProxyImpairmentStats } from './edge-network-control';
import {
  edgeNetworkLinkEnvironment,
  edgeNetworkPlaywrightEnvironment,
  resolveEdgeNetworkConfig,
} from './edge-network-profile';
import { type ProxyImpairmentStats, proxyLinkReleaseErrors } from './edge-network-stats';
import { acquireHostHarnessLock } from './host-harness-lock';

const ROOT = path.resolve(import.meta.dir, '..');
const EDGE_BIN = path.join(ROOT, 'target', 'rust', 'release', 'merkur-edge');
const PROXY_BIN = path.join(ROOT, 'target', 'rust', 'release', 'delay_proxy');
const COMPETITOR_BIN = path.join(ROOT, 'target', 'rust', 'release', 'bulk_competitor');

const EDGE_PORT = Number(process.env.EDGE_PORT ?? 4433);
const NETWORK = resolveEdgeNetworkConfig(process.env);
const PROXY_ACTIVE = NETWORK !== null;
// Each peer role owns a proxy listener. The edge registers the daemon's, and a
// transport-worker prelude points the browser at its own, so a relay's role is
// the listener it arrived on.
const PROXY_PORT = EDGE_PORT + 1;
const PROXY_CONTROL_PORT = EDGE_PORT + 2;
const PROXY_BROWSER_PORT = EDGE_PORT + 3;
const COMPETITOR_PROXY_PORT = EDGE_PORT + 4;
const COMPETITOR_SERVER_PORT = EDGE_PORT + 5;
const APP_PORT = Number(process.env.PW_E2E_PORT ?? 54_331);
const EDGE_ID = 'local-harness-1';
const EDGE_REGISTRATION_KEY = Buffer.alloc(64, 0x71).toString('base64url');
const EDGE_REGISTRATION_KEYS_JSON = JSON.stringify({ [EDGE_ID]: EDGE_REGISTRATION_KEY });
/** `EDGE_ATTACH_TICKET_KEY` in tests/e2e/start-server.ts: the harness server mints with it. */
const EDGE_ATTACH_TICKET_KEY = Buffer.alloc(64, 0x74).toString('base64url');
const EDGE_PUBLIC_URL = `https://[::1]:${PROXY_ACTIVE ? PROXY_PORT : EDGE_PORT}`;

// Must stay uncontended: each asserts a hard p95 millisecond budget against a
// real GPU fence, so any concurrent Chromium/daemon load on the host would
// skew or fail the budget rather than just add noise. Load that has just
// STOPPED counts too, which is why these run before the parallel phase rather
// than after it — see the ordering note in `main`. Every other spec in
// `playwright.edge.config.mjs`'s testMatch fixtures a fully independent
// worker-scoped daemon and is safe to run in parallel with the rest.
const LATENCY_SPECS = [
  'startup-latency.e2e.ts',
  'terminal-performance-matrix.e2e.ts',
  'transport-latency.e2e.ts',
];
const FUNCTIONAL_SPECS = [
  'carrier-rebind.e2e.ts',
  'client-idle-work.e2e.ts',
  'device-list-updates.e2e.ts',
  'edge-handshake-reorder.e2e.ts',
  'edge-sweep.e2e.ts',
  'ios-webkit-startup.e2e.ts',
  'terminal-cursor-motion.e2e.ts',
  'terminal-geometry-matrix.e2e.ts',
  'terminal-graphics.e2e.ts',
  'terminal-input-matrix.e2e.ts',
  'terminal-links.e2e.ts',
  'terminal-selection.e2e.ts',
  'terminal-touch-matrix.e2e.ts',
  'terminal-touch.e2e.ts',
  'terminal.e2e.ts',
  'tui-headless.e2e.ts',
];
// One worker per three cores, because a worker is not one process: it runs a
// Chromium, a merkur daemon and a dataplane, and competes for one GPU.
//
// Half the CPUs (7 here) is past the knee and silently destructive. Measured on
// this 14-core host, same specs, back to back: at 7 workers a whole spec file's
// worker never got its browser past the sign-in screen — 7 tests failing on the
// same 30s poll, twice running, while the server answered every register/login
// in 6-33ms, so the starvation was browser-side. At 4 workers those failures
// disappear (113 passed vs 106) and the wall time is unchanged: 1m37 against
// 1m40. Past the knee the extra workers buy nothing and cost correctness.
const FUNCTIONAL_WORKERS = Math.max(
  1,
  optionalNonNegativeInteger('E2E_TRANSPORT_WORKERS') ??
    Math.max(1, Math.floor(os.availableParallelism() / 3)),
);

/** CPU-only CI selects correctness explicitly; the default retains both phases. */
export function edgeHarnessPhases(args: readonly string[]): readonly (readonly string[])[] {
  const functional = [
    '--fully-parallel',
    `--workers=${FUNCTIONAL_WORKERS}`,
    ...FUNCTIONAL_SPECS.map((spec) => `tests/e2e/${spec}`),
  ];
  if (args[0] === '--functional') return [[...functional, ...args.slice(1)]];
  if (args.length > 0) return [args];
  return [['--workers=1', ...LATENCY_SPECS.map((spec) => `tests/e2e/${spec}`)], functional];
}

if (!Number.isInteger(EDGE_PORT) || EDGE_PORT < 1 || EDGE_PORT >= 65_535) {
  throw new Error('EDGE_PORT must be an integer from 1 to 65534');
}
if (PROXY_ACTIVE && EDGE_PORT > 65_530) {
  throw new Error('EDGE_PORT must leave five adjacent ports available for the impairment harness');
}
// ESC-safe ANSI SGR matcher (avoids a literal control char in source). tracing
// interleaves these inside `cert_hash_b64=<hash>`, so we strip them first.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

interface TrackedChild {
  readonly process: ChildProcess;
  readonly closed: Promise<void>;
}

const children: TrackedChild[] = [];
let cleaningUp = false;
let cleanupPromise: Promise<readonly string[]> | null = null;
const shutdownRequestErrors: string[] = [];
let infrastructureFailure: Error | null = null;
let activePlaywright: ChildProcess | null = null;
let activeNativeArtifactProvenance: EdgeHarnessNativeArtifactProvenance | null = null;
let edgeHandshakeTimeouts = 0;
let proxySplitObserved = false;
/** Every attachment the edge logged: which lane and role each proxy upstream port carried. */
const edgeAttachments: EdgeAttachment[] = [];
/** Every relay the proxy admitted, with the listener role it arrived on. */
const proxyRelays: ProxyRelayAdmission[] = [];

export interface ProxyRelayAdmission {
  readonly admissionSeq: number;
  readonly role: 'daemon' | 'browser';
  readonly competitor: boolean;
  readonly upstreamPort: number;
  /** Admission observed before an attachment; upstream ports can be reused. */
  readonly atMs: number;
}

/** The proxy's `relay` line, printed once per admitted relay. */
export function parseProxyRelayLine(line: string, atMs: number): ProxyRelayAdmission | null {
  const match =
    /delay_proxy: relay admission_seq=(\d+) role=(daemon|browser) competitor=(true|false) client=\S+ upstream_port=(\d+)/.exec(
      line,
    );
  if (match === null) return null;
  const [, admissionSeq, role, competitor, upstreamPort] = match;
  return {
    admissionSeq: Number(admissionSeq),
    role: role === 'daemon' ? 'daemon' : 'browser',
    competitor: competitor === 'true',
    upstreamPort: Number(upstreamPort),
    atMs,
  };
}

/**
 * Each edge attachment arrived through a relay of its own role: a browser
 * connection admitted on the daemon's listener would cross the daemon's links,
 * so a worker redirect that failed to apply invalidates the run.
 */
export function relayRoleErrors(
  attachments: readonly EdgeAttachment[],
  relays: readonly ProxyRelayAdmission[],
): string[] {
  const errors: string[] = [];
  for (const attachment of attachments) {
    let relay: ProxyRelayAdmission | undefined;
    for (const candidate of relays) {
      if (
        candidate.upstreamPort === attachment.remotePort &&
        candidate.atMs <= attachment.atMs &&
        (relay === undefined || candidate.admissionSeq > relay.admissionSeq)
      ) {
        relay = candidate;
      }
    }
    if (relay === undefined) {
      errors.push(
        `the edge's ${attachment.role} ${attachment.lane} attachment from port ${attachment.remotePort} came through no proxy relay`,
      );
    } else if (relay.role !== attachment.role || relay.competitor) {
      errors.push(
        `the edge's ${attachment.role} ${attachment.lane} attachment came through a ${relay.competitor ? 'competitor ' : ''}${relay.role} relay`,
      );
    }
  }
  return errors;
}

export interface EdgeAttachment {
  readonly role: 'daemon' | 'browser';
  readonly lane: 'signaling' | 'interactive' | 'bulk';
  /** The connection's remote port as the edge saw it: a proxy relay's upstream port. */
  readonly remotePort: number;
  readonly atMs: number;
}

/**
 * The edge's `peer attached to splice` line, which names the session label
 * (whose suffix is the lane), the role and the connection's remote address.
 * Behind the proxy that address is one relay's upstream socket, so the pair
 * classifies each relay exactly.
 */
export function parseEdgeAttachmentLine(line: string, atMs: number): EdgeAttachment | null {
  if (!line.includes('edge: peer attached to splice')) return null;
  const session = /session_id=(\S+)/.exec(line)?.[1];
  const role = /role=(Daemon|Browser)/.exec(line)?.[1];
  const port = /remote=\S*:(\d+)/.exec(line)?.[1];
  if (session === undefined || role === undefined || port === undefined) return null;
  return {
    role: role === 'Daemon' ? 'daemon' : 'browser',
    lane: session.endsWith('#signaling')
      ? 'signaling'
      : session.endsWith('#bulk')
        ? 'bulk'
        : 'interactive',
    remotePort: Number(port),
    atMs,
  };
}

/** Reassembles pipe chunks without assuming process writes map 1:1 to data events. */
export class LineBuffer {
  private buffered = '';

  push(chunk: string): string[] {
    this.buffered += chunk;
    const parts = this.buffered.split('\n');
    this.buffered = parts.pop() ?? '';
    return parts.map((line) => line.replace(/\r$/, ''));
  }
}

export type ProxyOutputKind = 'ready' | 'overload' | 'impairment' | 'reorder' | 'split' | 'other';

/** @public Kept pure so harness output/failure semantics have focused tests. */
export function classifyProxyOutputLine(line: string): ProxyOutputKind {
  if (line.includes('delay_proxy: dropped')) return 'overload';
  if (line.includes('delay_proxy: impaired')) return 'impairment';
  if (line.includes('delay_proxy: reordered')) return 'reorder';
  if (line.includes('delay_proxy: split')) return 'split';
  if (line.startsWith('delay_proxy: ready ') && line.includes(' -> ')) {
    return 'ready';
  }
  return 'other';
}

/**
 * The edge's own declaration that a session handshake deadlocked.
 *
 * `apps/edge/src/relay.rs` wraps the whole incoming-session/accept future in
 * `SESSION_HANDSHAKE_TIMEOUT` and warns exactly this on expiry. It is the
 * authoritative signal for the failure class in `PERF.md`, 2026-08-30
 * ("0.5-RTT SETTINGS reverted"): the server itself saying it waited the full
 * timeout for a CONNECT request that never came. Inferring the same thing from
 * a client-side wall-clock threshold cannot distinguish it from a slow host.
 */
export function isEdgeHandshakeTimeoutLine(line: string): boolean {
  return line.includes('edge: session handshake timed out');
}

function track<T extends ChildProcess>(child: T): T {
  const closed = new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('close', finish);
    // A failed spawn has no live process to reap. Other `error` events (for
    // example a failed signal) do not prove a started process has closed, so
    // those must still wait for its `close` event or the cleanup timeout.
    child.once('error', () => {
      if (child.pid === undefined) finish();
    });
  });
  children.push({ process: child, closed });
  if (cleaningUp) {
    child.kill('SIGKILL');
    throw new Error('refused to start a child after harness cleanup began');
  }
  return child;
}

function failInfrastructure(error: Error): void {
  if (cleaningUp || infrastructureFailure !== null) return;
  infrastructureFailure = error;
  activePlaywright?.kill('SIGKILL');
}

function currentInfrastructureFailure(): Error | null {
  return infrastructureFailure;
}

function requestChildShutdown(): void {
  for (const tracked of children) {
    const child = tracked.process;
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill('SIGKILL');
    } catch (error) {
      shutdownRequestErrors.push(
        `failed to stop child pid=${child.pid ?? 'unassigned'}: ${String(error)}`,
      );
    }
  }
}

function cleanup(): Promise<readonly string[]> {
  if (cleanupPromise !== null) return cleanupPromise;
  cleanupPromise = (async () => {
    cleaningUp = true;
    const errors = [...shutdownRequestErrors];
    requestChildShutdown();
    errors.push(...shutdownRequestErrors.slice(errors.length));
    await Promise.all(
      children.map(async ({ process: child, closed }) => {
        try {
          await awaitChildClose(closed, child.pid);
        } catch (error) {
          errors.push(String(error));
        }
      }),
    );
    activePlaywright = null;
    return errors;
  })();
  return cleanupPromise;
}

async function awaitChildClose(closed: Promise<void>, pid: number | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`child pid=${pid ?? 'unassigned'} did not close after SIGKILL`)),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function startEdge(): Promise<string> {
  requireExecutable(EDGE_BIN, 'cargo build --release -p merkur-edge --bins');
  const edge = track(
    spawn(EDGE_BIN, [], {
      env: {
        ...process.env,
        MERKUR_EDGE_PORT: String(EDGE_PORT),
        MERKUR_EDGE_HOSTNAME: 'localhost',
        MERKUR_EDGE_REGISTER_URL: `http://127.0.0.1:${APP_PORT}/api/edge/register`,
        MERKUR_EDGE_REGISTRATION_KEY: EDGE_REGISTRATION_KEY,
        MERKUR_EDGE_ATTACH_TICKET_KEY: EDGE_ATTACH_TICKET_KEY,
        MERKUR_EDGE_ID: EDGE_ID,
        MERKUR_EDGE_REGION: 'local',
        MERKUR_EDGE_PUBLIC_URL: EDGE_PUBLIC_URL,
        MERKUR_EDGE_DATA_BUDGET_GB: '1000000',
        MERKUR_EDGE_SIGNALING_RESERVE_GB: '100000',
        MERKUR_EDGE_EGRESS_INTERFACE: process.platform === 'darwin' ? 'lo0' : 'lo',
        MERKUR_EDGE_IDENTITY_DIR: path.join(ROOT, 'target', 'edge-harness-identity'),
        // Pinned, not inherited. Readiness is detected by parsing the edge's
        // own `info!` markers out of its stderr, so an ambient RUST_LOG of
        // `warn` silently hides them and the harness fails with a timeout that
        // names the edge rather than the filter.
        RUST_LOG: 'info',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  const certHash = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      } else {
        failInfrastructure(error);
      }
    };
    // Names the marker that never arrived. Readiness is inferred from two log
    // lines, so anything that suppresses one of them — a log filter, a rename,
    // a startup path that skips the bind — presents identically as a flat
    // fifteen-second timeout, and the message then blames the edge for what is
    // usually the harness's own environment.
    const timer = setTimeout(() => {
      const missing = [
        certHash === null ? 'cert_hash_b64' : null,
        socketBound ? null : 'WebTransport socket bound',
      ].filter((marker): marker is string => marker !== null);
      fail(
        new Error(
          `edge did not become ready in 15s; never saw ${missing.join(' or ')} on its output. ` +
            'These are `info!` lines, so a RUST_LOG filter that hides them stalls this wait.',
        ),
      );
    }, 15_000);
    let certHash: string | null = null;
    let socketBound = false;
    const finishIfReady = (): void => {
      if (settled || certHash === null || !socketBound) return;
      // The edge binds QUIC before its mandatory initial registration, while
      // Playwright owns the registration server. Hand off as soon as the pin
      // and post-bind marker exist so Playwright can boot that server and
      // unblock publication without racing an unbound UDP socket.
      settled = true;
      clearTimeout(timer);
      resolve(certHash);
    };
    const onLine = (rawLine: string): void => {
      const line = rawLine.replace(ANSI, '');
      const match = /cert_hash_b64=([A-Za-z0-9+/]{43}=)/.exec(line);
      if (match?.[1] !== undefined) certHash = match[1];
      if (line.includes('WebTransport socket bound; registration pending')) socketBound = true;
      if (isEdgeHandshakeTimeoutLine(line)) edgeHandshakeTimeouts += 1;
      const attachment = parseEdgeAttachmentLine(line, Date.now());
      if (attachment !== null) edgeAttachments.push(attachment);
      finishIfReady();
    };
    const stdoutLines = new LineBuffer();
    const stderrLines = new LineBuffer();
    const onData = (lines: LineBuffer, buf: Buffer): void => {
      const text = buf.toString('utf8');
      process.stderr.write(`[edge] ${text}`);
      for (const line of lines.push(text)) onLine(line);
    };
    edge.stdout.on('data', (buffer: Buffer) => onData(stdoutLines, buffer));
    edge.stderr.on('data', (buffer: Buffer) => onData(stderrLines, buffer));
    edge.once('error', (error) => {
      fail(new Error(`merkur-edge process error: ${error.message}`));
    });
    edge.once('exit', (code, signal) => {
      fail(new Error(`merkur-edge exited (code=${code}, signal=${signal})`));
    });
  });
  return certHash;
}

async function startProxy(): Promise<void> {
  if (NETWORK === null) throw new Error('cannot start delay_proxy without a network profile');
  requireExecutable(PROXY_BIN, 'cargo build --release -p merkur-edge --bins');
  const proxy = track(
    spawn(PROXY_BIN, [], {
      env: {
        ...process.env,
        LISTEN_DAEMON: `[::1]:${PROXY_PORT}`,
        LISTEN_BROWSER: `[::1]:${PROXY_BROWSER_PORT}`,
        UPSTREAM: `[::1]:${EDGE_PORT}`,
        CONTROL_LISTEN: `[::1]:${PROXY_CONTROL_PORT}`,
        ...edgeNetworkLinkEnvironment(NETWORK.bottleneck?.links ?? []),
        ...(NETWORK.competitor === null
          ? {}
          : {
              [`LISTEN_COMPETITOR_${NETWORK.competitor.toUpperCase()}`]: `[::1]:${COMPETITOR_PROXY_PORT}`,
              COMPETITOR_UPSTREAM: `[::1]:${COMPETITOR_SERVER_PORT}`,
            }),
        PROFILE: NETWORK.profile.name,
        TARGET_RTT_MS: String(NETWORK.profile.targetRttMs),
        BASE_DELAY_US: String(NETWORK.profile.hopDelayUs),
        JITTER_RADIUS_US: String(NETWORK.hopJitterRadiusUs),
        DATAGRAM_LOSS_PERCENT: String(NETWORK.datagramLossPercent),
        REORDER: NETWORK.reorder,
        SCENARIO: NETWORK.scenario,
        SEED: String(NETWORK.seed),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      } else {
        failInfrastructure(error);
      }
    };
    const timer = setTimeout(
      () => fail(new Error('delay_proxy did not become ready in 5s')),
      5_000,
    );
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const onLine = (line: string): void => {
      const kind = classifyProxyOutputLine(line);
      if (kind === 'overload') {
        failInfrastructure(new Error(`delay proxy overloaded; latency run is invalid: ${line}`));
      } else if (kind === 'split') {
        proxySplitObserved = true;
      } else if (kind === 'other') {
        const relay = parseProxyRelayLine(line, Date.now());
        if (relay !== null) proxyRelays.push(relay);
      } else if (kind === 'ready') {
        finish();
      }
    };
    const stdoutLines = new LineBuffer();
    const stderrLines = new LineBuffer();
    const onData = (lines: LineBuffer, buffer: Buffer): void => {
      const text = buffer.toString('utf8');
      process.stderr.write(`[proxy] ${text}`);
      for (const line of lines.push(text)) onLine(line);
    };
    proxy.stdout.on('data', (buffer: Buffer) => onData(stdoutLines, buffer));
    proxy.stderr.on('data', (buffer: Buffer) => onData(stderrLines, buffer));
    proxy.once('error', (error) => {
      fail(new Error(`delay_proxy process error: ${error.message}`));
    });
    proxy.once('exit', (code, signal) => {
      fail(new Error(`delay_proxy exited (code=${code}, signal=${signal})`));
    });
  });
}

/**
 * One long CUBIC flow across the competitor's listener, so it shares the
 * declared peer's link with the session: the server sends when the browser's
 * downlink is shared, the client when the daemon's uplink is.
 */
async function startCompetitor(): Promise<void> {
  if (NETWORK?.competitor == null) return;
  requireExecutable(COMPETITOR_BIN, 'cargo build --release -p merkur-edge --bins');
  const browserSide = NETWORK.competitor === 'browser';
  const server = track(
    spawn(COMPETITOR_BIN, ['serve'], {
      env: {
        ...process.env,
        LISTEN: `[::1]:${COMPETITOR_SERVER_PORT}`,
        SEND: browserSide ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  const certHash = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('bulk_competitor did not listen in 5s')),
      5_000,
    );
    const lines = new LineBuffer();
    server.stdout.on('data', (buffer: Buffer) => {
      for (const line of lines.push(buffer.toString('utf8'))) {
        const hash = /cert_hash_b64=(\S+)/.exec(line)?.[1];
        if (hash !== undefined) {
          clearTimeout(timer);
          resolve(hash);
        }
      }
    });
    server.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`bulk_competitor server exited (code=${code}, signal=${signal})`));
    });
  });
  const client = track(
    spawn(COMPETITOR_BIN, ['dial'], {
      env: {
        ...process.env,
        SERVER: `https://[::1]:${COMPETITOR_PROXY_PORT}`,
        CERT_HASH: certHash,
        SEND: browserSide ? '0' : '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  for (const child of [server, client]) {
    child.once('exit', (code, signal) =>
      failInfrastructure(
        new Error(`bulk_competitor ended during the run (code=${code}, signal=${signal})`),
      ),
    );
  }
}

async function requestProxyStats(): Promise<ProxyImpairmentStats | null> {
  if (!PROXY_ACTIVE) return null;
  return requestProxyImpairmentStats(PROXY_CONTROL_PORT, 'stats');
}

function requireExecutable(binaryPath: string, buildCommand: string): void {
  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    throw new Error(`required executable missing: ${binaryPath}\nBuild it with: ${buildCommand}`);
  }
}

/**
 * One Playwright invocation against the already-running edge (and proxy, if
 * active). Extracted so the default no-filter run can call it twice — once
 * fully parallel for the independent functional specs, once serial for the
 * latency-budget specs — while a filtered/targeted run still calls it exactly
 * once with the caller's own args, unchanged from before this split existed.
 */
async function runPlaywright(
  extraArgs: readonly string[],
  nativeArtifactProvenance: EdgeHarnessNativeArtifactProvenance,
  certHash: string,
): Promise<number> {
  verifyProvisionedNativeArtifacts(nativeArtifactProvenance);
  const outputRoot = process.env.PW_E2E_OUTPUT_DIR ?? path.join(ROOT, 'test-results', 'e2e-edge');
  mkdirSync(outputRoot, { recursive: true });
  const outputDirectory = mkdtempSync(path.join(outputRoot, 'phase-'));
  const pw = track(
    spawn('bunx', ['playwright', 'test', '-c', 'playwright.edge.config.mjs', ...extraArgs], {
      cwd: ROOT,
      env: {
        ...process.env,
        EDGE_REGISTRATION_KEYS_JSON,
        PW_E2E_EDGE_ID: EDGE_ID,
        PW_E2E_EDGE_URL: new URL(EDGE_PUBLIC_URL).href,
        PW_E2E_EDGE_CERT_HASH: certHash,
        PW_E2E_OUTPUT_DIR: outputDirectory,
        FORCE_EDGE: process.env.FORCE_EDGE ?? '1',
        ...edgeNetworkPlaywrightEnvironment(NETWORK),
        ...(PROXY_ACTIVE
          ? {
              EDGE_PROXY_CONTROL_PORT: String(PROXY_CONTROL_PORT),
              EDGE_PROXY_DAEMON_PORT: String(PROXY_PORT),
              EDGE_PROXY_BROWSER_PORT: String(PROXY_BROWSER_PORT),
            }
          : undefined),
      },
      stdio: 'inherit',
    }),
  );
  activePlaywright = pw;
  if (infrastructureFailure !== null) {
    throw infrastructureFailure;
  }
  const code: number = await new Promise((resolve, reject) => {
    pw.once('error', (error) => reject(new Error(`failed to start Playwright: ${error.message}`)));
    pw.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  activePlaywright = null;
  if (infrastructureFailure !== null) {
    throw infrastructureFailure;
  }
  return code;
}

async function main(
  runStartedAt: Date,
  runStartedMonotonicMs: number,
  stopAcceptingSignals: () => void,
): Promise<void> {
  // Held from before the native build: a build beside another harness's latency
  // phase is load that phase would measure.
  await acquireHostHarnessLock(
    `run-edge-harness on port ${EDGE_PORT} [${process.argv.slice(2).join(' ')}]`,
  );
  const nativeArtifactProvenance = await provisionEdgeHarnessNativeArtifacts(
    ROOT,
    process.env[EDGE_HARNESS_NATIVE_MANIFEST_ENV],
    buildEdgeArtifacts,
  );
  activeNativeArtifactProvenance = nativeArtifactProvenance;
  if (infrastructureFailure !== null) throw infrastructureFailure;
  process.stderr.write(`[harness-native-artifacts] ${JSON.stringify(nativeArtifactProvenance)}\n`);
  verifyProvisionedNativeArtifacts(nativeArtifactProvenance);
  const certHash = await startEdge();
  const dialPort = PROXY_ACTIVE ? PROXY_PORT : EDGE_PORT;
  if (PROXY_ACTIVE) {
    verifyProvisionedNativeArtifacts(nativeArtifactProvenance);
    await startProxy();
    await startCompetitor();
  }

  const edgeUrl = `https://[::1]:${dialPort}`;
  process.stderr.write(
    `[harness] edge cert=${certHash} url=${edgeUrl} network=${
      NETWORK === null
        ? 'loopback'
        : `${NETWORK.profile.name}/${NETWORK.profile.targetRttMs}ms/${NETWORK.companionPrimaryProfile === null ? 'primary' : `companion-for-${NETWORK.companionPrimaryProfile}`}/${NETWORK.datagramLossPercent}%@edge-to-client/${NETWORK.reorder}/${NETWORK.scenario}/seed-${NETWORK.seed}`
    }\n`,
  );
  if (infrastructureFailure !== null) {
    throw infrastructureFailure;
  }

  const explicitArgs = process.argv.slice(2);
  if (explicitArgs.length === 0) {
    process.stderr.write(
      `[harness] no spec filter given: running the ${LATENCY_SPECS.length} latency-budget specs alone, then the ${FUNCTIONAL_SPECS.length} independent functional specs fully parallel (workers=${FUNCTIONAL_WORKERS})\n`,
    );
    // The latency phase runs FIRST, and the order is the whole point.
    //
    // These specs assert hard p95 millisecond budgets against a real GPU
    // fence, so what precedes them is part of the measurement. Running them
    // after the parallel phase put them immediately downstream of seven
    // concurrent Chromium/daemon processes exiting at once, and OS teardown —
    // page cache, GPU driver state, process reaping — is not instantaneous:
    // measured first samples of 16.7s and 19.4s against a 5s budget, while the
    // same spec on a fresh harness reports 130ms cold and a 127.7ms repeat
    // p50. A 150x gap is host state, not code, and the gate cannot tell the
    // two apart.
    //
    // A settle delay between the phases was tried and is NOT the fix: 5s was
    // already in place for the 19.4s failure. Any such constant is a guess at
    // how long an unobserved teardown takes, and picking a bigger one only
    // moves the guess. Ordering removes the cause instead — nothing heavy runs
    // before the measurement, so there is nothing to wait out. The functional
    // specs assert no timing budget and do not care what ran before them,
    // which is what makes the asymmetry safe.
  }
  // Every phase runs, even after a failure, and no later success hides a failure.
  let code = 0;
  for (const args of edgeHarnessPhases(explicitArgs)) {
    const phaseCode = await runPlaywright(args, nativeArtifactProvenance, certHash);
    if (phaseCode !== 0) code = phaseCode;
  }
  const proxyStats = await requestProxyStats();
  if (proxyStats !== null) {
    process.stdout.write(`[harness-network-stats] ${JSON.stringify(proxyStats)}\n`);
  }
  const validationErrors: string[] = [];
  if (
    code === 0 &&
    NETWORK !== null &&
    NETWORK.datagramLossPercent > 0 &&
    (proxyStats?.downstream.exactLossDropped ?? 0) === 0
  ) {
    validationErrors.push(
      `datagram loss=${NETWORK.datagramLossPercent}% was configured at the edge-to-client ` +
        'fault site but the measured trace dropped no downstream packet; the run is invalid',
    );
  }
  if (
    code === 0 &&
    NETWORK?.scenario === 'burst-loss' &&
    (proxyStats?.downstream.burstLossDropped ?? 0) === 0
  ) {
    validationErrors.push(
      'burst-loss was configured but the measured trace exercised no downstream burst',
    );
  }
  if (
    code === 0 &&
    NETWORK !== null &&
    NETWORK.reorder !== 'none' &&
    (proxyStats?.downstream.reordered ?? 0) === 0
  ) {
    validationErrors.push(
      `reorder=${NETWORK.reorder} was configured but the measured trace reordered no packet; ` +
        'the run is invalid',
    );
  }
  if (
    code === 0 &&
    NETWORK?.scenario === 'congestion' &&
    (proxyStats?.downstream.congested ?? 0) === 0
  ) {
    validationErrors.push(
      'congestion was configured but the measured trace queued no downstream packet',
    );
  }
  if (code === 0 && PROXY_ACTIVE) {
    validationErrors.push(...relayRoleErrors(edgeAttachments, proxyRelays));
  }
  if (code === 0 && proxyStats !== null) {
    // A link's task released late: the proxy was not the configured network.
    validationErrors.push(...proxyLinkReleaseErrors(proxyStats));
    for (const link of proxyStats.links) {
      if (link.totals.arrivals === 0) {
        validationErrors.push(
          `the ${link.config.role} ${link.config.direction}link was declared but carried nothing; ` +
            'the run is invalid',
        );
      }
    }
  }
  if (code === 0 && NETWORK?.scenario === 'handshake-split' && !proxySplitObserved) {
    validationErrors.push(
      'handshake-split was configured but no coalesced datagram was split; the run is invalid',
    );
  }
  // Only asserted under a deliberate ordering fault. Suites that deliberately blackhole the path
  // -- `carrier-rebind` partitions it for seconds at a time -- can time a
  // handshake out legitimately, so this cannot be a blanket harness invariant.
  // With reordering and no partition, there is no legitimate cause: a handshake
  // that ran the full SESSION_HANDSHAKE_TIMEOUT is the deadlock itself.
  const orderingFault =
    NETWORK?.scenario === 'handshake-split' || (NETWORK !== null && NETWORK.reorder !== 'none');
  if (code === 0 && orderingFault && edgeHandshakeTimeouts > 0) {
    validationErrors.push(
      `the edge timed out ${edgeHandshakeTimeouts} session handshake(s) under an ordering fault. ` +
        'A fresh dial that needs SESSION_HANDSHAKE_TIMEOUT to unwedge it is the ' +
        'CONNECT_STATE_CONNECT_COMPLETE deadlock described in PERF.md (2026-08-30).',
    );
  }
  validationErrors.push(...(await cleanup()));
  stopAcceptingSignals();
  const supervisionError = currentInfrastructureFailure();
  if (supervisionError !== null) {
    validationErrors.push(`harness infrastructure failed: ${supervisionError.message}`);
  }
  try {
    verifyProvisionedNativeArtifacts(nativeArtifactProvenance);
  } catch (error) {
    validationErrors.push(`native artifacts changed during the run: ${String(error)}`);
  }
  const harnessExitCode = code === 0 && validationErrors.length > 0 ? 1 : code;
  const result = {
    schemaVersion: 2,
    startedAt: runStartedAt.toISOString(),
    durationMs: performance.now() - runStartedMonotonicMs,
    playwrightExitCode: code,
    harnessExitCode,
    network: NETWORK,
    nativeArtifactProvenance,
    proxyStats,
    edgeAttachments,
    proxyRelays,
    impairmentValidation: {
      complete: validationErrors.length === 0,
      errors: validationErrors,
    },
  };
  const resultPath = process.env.MERKUR_EDGE_HARNESS_RESULT_PATH;
  if (resultPath !== undefined) {
    await writeFile(path.resolve(resultPath), `${JSON.stringify(result, null, 2)}\n`);
  }
  if (validationErrors.length > 0) {
    for (const error of validationErrors) process.stderr.write(`[harness-invalid] ${error}\n`);
  }
  process.exitCode = harnessExitCode;
}

async function buildEdgeArtifacts(): Promise<void> {
  for (const command of EDGE_HARNESS_NATIVE_BUILD_COMMANDS) {
    await runBuild('edge, daemon dataplane, image worker and terminal client', [...command]);
  }
  for (const name of ['merkur-dataplane', 'merkur-image-worker']) {
    const source = path.join(ROOT, 'target', 'rust', 'release', name);
    const destination = path.join(ROOT, 'apps', 'daemon', 'dist', name);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

async function runBuild(name: string, command: string[]): Promise<void> {
  const [executable, ...args] = command;
  if (executable === undefined) throw new Error(`empty build command for ${name}`);
  const build = track(spawn(executable, args, { cwd: ROOT, stdio: 'inherit' }));
  const exitCode = await new Promise<number>((resolve, reject) => {
    build.once('error', reject);
    build.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`${name} build failed with exit code ${exitCode}`);
  }
}

function optionalNonNegativeInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

if (import.meta.main) {
  const runStartedAt = new Date();
  const runStartedMonotonicMs = performance.now();
  const onSignal = (signal: NodeJS.Signals): void => {
    if (infrastructureFailure === null) {
      infrastructureFailure = new Error(`harness interrupted by ${signal}`);
    }
    activePlaywright?.kill('SIGKILL');
    requestChildShutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const stopAcceptingSignals = (): void => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
  main(runStartedAt, runStartedMonotonicMs, stopAcceptingSignals)
    .catch(async (error) => {
      const errors = [`harness execution failed: ${String(error)}`, ...(await cleanup())];
      stopAcceptingSignals();
      if (activeNativeArtifactProvenance !== null) {
        try {
          verifyProvisionedNativeArtifacts(activeNativeArtifactProvenance);
        } catch (verificationError) {
          errors.push(`native artifacts changed during failed run: ${String(verificationError)}`);
        }
      }
      const resultPath = process.env.MERKUR_EDGE_HARNESS_RESULT_PATH;
      if (resultPath !== undefined) {
        try {
          await writeFile(
            path.resolve(resultPath),
            `${JSON.stringify(
              {
                schemaVersion: 2,
                startedAt: runStartedAt.toISOString(),
                durationMs: performance.now() - runStartedMonotonicMs,
                playwrightExitCode: 1,
                harnessExitCode: 1,
                network: NETWORK,
                nativeArtifactProvenance: activeNativeArtifactProvenance,
                proxyStats: null,
                impairmentValidation: { complete: false, errors },
              },
              null,
              2,
            )}\n`,
          );
        } catch (resultError) {
          errors.push(`failed to persist failed harness result: ${String(resultError)}`);
        }
      }
      for (const failure of errors) process.stderr.write(`[harness-invalid] ${failure}\n`);
      process.exitCode = 1;
    })
    .finally(stopAcceptingSignals);
}
