/**
 * Runs the real-browser certificate-rollover and two-region edge topology test.
 * Two independent edge processes register replica-specific URLs with an
 * in-process control plane; Playwright dials both, with attach tickets the
 * control plane mints, and requests SIGHUP rotations.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { createEdgeAttachTicketIssuer } from '../apps/server/src/services/edge-attach-ticket';
import {
  EDGE_HARNESS_NATIVE_MANIFEST_ENV,
  provisionEdgeHarnessNativeArtifacts,
  verifyProvisionedNativeArtifacts,
} from './edge-harness-native-artifacts';
import { acquireHostHarnessLock } from './host-harness-lock';

interface Registration {
  readonly edgeId: string;
  readonly edgeRegion: string;
  readonly edgeWtUrl: string;
  readonly certHash: string;
  readonly certHashes: readonly string[];
}

const ROOT = path.resolve(import.meta.dir, '..');
const EDGE_BIN = path.join(ROOT, 'target', 'rust', 'release', 'merkur-edge');
const APP_PORT = Number(process.env.PW_E2E_PORT ?? 24_341);
const APP_REGISTER_URL = `http://127.0.0.1:${APP_PORT}/api/edge/register`;
const CONTROL_PORT = Number(process.env.EDGE_TOPOLOGY_CONTROL_PORT ?? 24_351);
const CONTROL_REGISTER_URL = `http://127.0.0.1:${CONTROL_PORT}/api/edge/register`;
const EDGE_PORTS = [
  Number(process.env.EDGE_TOPOLOGY_IAD_PORT ?? 24_352),
  Number(process.env.EDGE_TOPOLOGY_FRA_PORT ?? 24_353),
] as const;
const EDGE_REGISTRATION_KEYS = new Map([
  ['fra-1', Buffer.alloc(64, 0x61).toString('base64url')],
  ['iad-1', Buffer.alloc(64, 0x62).toString('base64url')],
]);
const EDGE_REGISTRATION_KEYS_JSON = JSON.stringify(Object.fromEntries(EDGE_REGISTRATION_KEYS));
// `EDGE_ATTACH_TICKET_KEY` in tests/e2e/start-server.ts, which mints the real session's.
const EDGE_ATTACH_TICKET_KEY = Buffer.alloc(64, 0x74);
const tickets = createEdgeAttachTicketIssuer(EDGE_ATTACH_TICKET_KEY);
const EDGE_AUTH_HEADERS = [
  'x-merkur-edge-id',
  'x-merkur-edge-timestamp',
  'x-merkur-edge-nonce',
  'x-merkur-edge-auth',
] as const;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

const children: ChildProcess[] = [];
const edges = new Map<string, ChildProcess>();
const registrations = new Map<string, Registration>();

const control = Bun.serve({
  hostname: '127.0.0.1',
  port: CONTROL_PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/api/edge/register') {
      const encodedBody = await request.text();
      let body: unknown;
      try {
        body = JSON.parse(encodedBody);
      } catch {
        return Response.json({ error: 'invalid registration' }, { status: 400 });
      }
      const registration = parseRegistration(body);
      if (registration === null || !edges.has(registration.edgeId)) {
        return Response.json({ error: 'invalid registration' }, { status: 400 });
      }
      let upstream: Response;
      try {
        upstream = await fetch(APP_REGISTER_URL, {
          method: 'POST',
          headers: forwardedRegistrationHeaders(request.headers),
          body: encodedBody,
        });
      } catch {
        return Response.json({ error: 'app server unavailable' }, { status: 503 });
      }
      if (!upstream.ok) {
        return new Response(await upstream.text(), {
          status: upstream.status,
          headers: { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' },
        });
      }
      registrations.set(registration.edgeId, registration);
      return Response.json({ ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/registrations') {
      return Response.json([...registrations.values()]);
    }
    if (request.method === 'GET' && url.pathname === '/tickets') {
      const daemonId = url.searchParams.get('daemon');
      const sessionId = url.searchParams.get('session');
      if (daemonId === null || sessionId === null) {
        return Response.json({ error: 'daemon and session are required' }, { status: 400 });
      }
      return Response.json({
        browser: tickets.forBrowser(daemonId, sessionId),
        daemon: tickets.forDaemon(daemonId, Date.now()),
      });
    }
    if (request.method === 'POST' && url.pathname.startsWith('/rotate/')) {
      const edgeId = decodeURIComponent(url.pathname.slice('/rotate/'.length));
      const edge = edges.get(edgeId);
      if (edge === undefined || edge.exitCode !== null || edge.signalCode !== null) {
        return Response.json({ error: 'edge not running' }, { status: 404 });
      }
      edge.kill('SIGHUP');
      return Response.json({ ok: true });
    }
    return new Response('not found\n', { status: 404 });
  },
});

function forwardedRegistrationHeaders(source: Headers): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const name of EDGE_AUTH_HEADERS) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function parseRegistration(value: unknown): Registration | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.edgeId !== 'string' ||
    typeof record.edgeRegion !== 'string' ||
    typeof record.edgeWtUrl !== 'string' ||
    typeof record.certHash !== 'string' ||
    !Array.isArray(record.certHashes) ||
    !record.certHashes.every((hash) => typeof hash === 'string')
  ) {
    return null;
  }
  return {
    edgeId: record.edgeId,
    edgeRegion: record.edgeRegion,
    edgeWtUrl: record.edgeWtUrl,
    certHash: record.certHash,
    certHashes: record.certHashes,
  };
}

function track<T extends ChildProcess>(child: T): T {
  children.push(child);
  return child;
}

function cleanup(): void {
  control.stop(true);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function buildEdge(): Promise<void> {
  const build = track(
    spawn('cargo', ['build', '--release', '--locked', '-p', 'merkur-edge'], {
      cwd: ROOT,
      stdio: 'inherit',
    }),
  );
  const code = await waitForExit(build);
  if (code !== 0) throw new Error(`merkur-edge build failed with exit code ${code}`);
  accessSync(EDGE_BIN, constants.X_OK);

  const dataplaneBuild = track(
    spawn('bun', ['run', 'build:dataplane'], {
      cwd: ROOT,
      stdio: 'inherit',
    }),
  );
  const dataplaneCode = await waitForExit(dataplaneBuild);
  if (dataplaneCode !== 0) {
    throw new Error(`daemon dataplane build failed with exit code ${dataplaneCode}`);
  }
}

async function startEdge(
  edgeId: string,
  edgeRegion: string,
  port: number,
): Promise<{ readonly edgeWtUrl: string; readonly certHash: string }> {
  const edgeWtUrl = `https://[::1]:${port}`;
  const registrationKey = EDGE_REGISTRATION_KEYS.get(edgeId);
  if (registrationKey === undefined) throw new Error(`missing registration key for ${edgeId}`);
  const edge = track(
    spawn(EDGE_BIN, [], {
      cwd: ROOT,
      env: {
        ...process.env,
        MERKUR_EDGE_PORT: String(port),
        MERKUR_EDGE_HOSTNAME: 'localhost',
        MERKUR_EDGE_REGISTER_URL: CONTROL_REGISTER_URL,
        MERKUR_EDGE_REGISTRATION_KEY: registrationKey,
        MERKUR_EDGE_ATTACH_TICKET_KEY: EDGE_ATTACH_TICKET_KEY.toString('base64url'),
        MERKUR_EDGE_ID: edgeId,
        MERKUR_EDGE_REGION: edgeRegion,
        MERKUR_EDGE_PUBLIC_URL: edgeWtUrl,
        MERKUR_EDGE_DATA_BUDGET_GB: '1000000',
        MERKUR_EDGE_SIGNALING_RESERVE_GB: '100000',
        MERKUR_EDGE_EGRESS_INTERFACE: process.platform === 'darwin' ? 'lo0' : 'lo',
        MERKUR_EDGE_IDENTITY_DIR: path.join(ROOT, 'target', 'edge-topology-identities', edgeId),
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
  edges.set(edgeId, edge);
  let bufferedLogs = '';
  const writeLog = (chunk: Buffer): void => {
    const text = chunk.toString('utf8').replace(ANSI, '');
    bufferedLogs += text;
    process.stderr.write(`[${edgeId}] ${text}`);
  };
  edge.stdout.on('data', writeLog);
  edge.stderr.on('data', writeLog);
  edge.once('exit', (code) => {
    if (code !== null && code !== 0) process.stderr.write(`[${edgeId}] exited with ${code}\n`);
  });
  const certHash = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${edgeId} did not generate a cert in 15s`)),
      15_000,
    );
    const inspect = (chunk: Buffer): void => {
      const text = chunk.toString('utf8').replace(ANSI, '');
      const match = /cert_hash_b64=([A-Za-z0-9+/]{43}=)/.exec(text);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    edge.stdout.on('data', inspect);
    edge.stderr.on('data', inspect);
    edge.once('error', reject);
    edge.once('exit', (code) =>
      reject(new Error(`${edgeId} exited before cert generation (${code})`)),
    );
    const existing = /cert_hash_b64=([A-Za-z0-9+/]{43}=)/.exec(bufferedLogs)?.[1];
    if (existing !== undefined) {
      clearTimeout(timer);
      resolve(existing);
    }
  });
  return { edgeWtUrl, certHash };
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const onSignal = (): void => {
    cleanup();
    process.exit(1);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  await acquireHostHarnessLock('run-edge-topology-harness');
  const nativeArtifacts = await provisionEdgeHarnessNativeArtifacts(
    ROOT,
    process.env[EDGE_HARNESS_NATIVE_MANIFEST_ENV],
    buildEdge,
  );
  await startEdge('iad-1', 'iad', EDGE_PORTS[0]);
  await startEdge('fra-1', 'fra', EDGE_PORTS[1]);

  const playwright = track(
    spawn('bunx', ['playwright', 'test', '-c', 'playwright.edge-topology.config.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        EDGE_TOPOLOGY_CONTROL_URL: `http://127.0.0.1:${CONTROL_PORT}`,
        EDGE_REGISTRATION_KEYS_JSON,
      },
      stdio: 'inherit',
    }),
  );
  const code = await waitForExit(playwright);
  verifyProvisionedNativeArtifacts(nativeArtifacts);
  cleanup();
  process.exit(code);
}

main().catch((error) => {
  process.stderr.write(`[edge-topology] ${String(error)}\n`);
  cleanup();
  process.exit(1);
});
