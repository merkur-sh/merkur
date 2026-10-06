import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { E2E_OPAQUE_PUBLIC_KEY } from '../../scripts/e2e-opaque-pin';
import { prepareE2EWebArtifact } from '../../scripts/e2e-web-artifacts';

import { prepareE2EDatabase, removeE2EDatabase, sweepOrphanedE2EDatabases } from './runtime-files';

const PROJECT_ROOT = path.resolve(import.meta.dir, '..', '..');
const SERVER_DIRECTORY = path.join(PROJECT_ROOT, 'apps', 'server');
const REDIS_HOST = '127.0.0.1';
const REDIS_START_TIMEOUT_MS = 10_000;
// Fixed test-only OPAQUE authority. Keeping both halves here makes the E2E
// server and the independently built browser share one explicit pin without
// consulting a developer's apps/server/.env.
const OPAQUE_SERVER_SETUP =
  'vyR7ewWtDdnfxU9MRNWEe8h5iNJ34K03Ebhh8kCjtN7gBCOX9zs6n9SHAFRwXcd4juUL6EWRm0IRF40gSSEc8Y6PwsHNbCpj5V94McaEgFt_ptz-wy2cZCUgVpJrSusGml8FeZBo9aSfBUDVW8bW5I5XwafKzgMQ4lMiFeZ8BCs';
const OPAQUE_SERVER_PUBLIC_KEY = E2E_OPAQUE_PUBLIC_KEY;

const serverPort = requiredPort('PW_E2E_PORT');
const redisPort = requiredPort('PW_E2E_REDIS_PORT');
// Email identity runs against a stand-in for Resend that keeps every message
// it is sent, so a spec can read the code a real mailbox would receive.
const mailPort =
  process.env.PW_E2E_AUTH_IDENTITY === 'email' ? requiredPort('PW_E2E_MAIL_PORT') : null;
const databasePath = requiredEnvironment('PW_E2E_DB_PATH');
const origin = `http://127.0.0.1:${serverPort}`;
const redisBinary = Bun.which('redis-server');

if (redisBinary === null) {
  throw new Error(
    'redis-server is required for hermetic E2E runs. Install Redis; no shared REDIS_URL is used.',
  );
}
const redisDirectory = mkdtempSync(path.join(tmpdir(), 'merkur-e2e-redis-'));

sweepOrphanedE2EDatabases();
prepareE2EDatabase(databasePath);

let redis: ReturnType<typeof Bun.spawn> | null = null;
let server: ReturnType<typeof Bun.spawn> | null = null;
let mail: ReturnType<typeof Bun.serve> | null = null;
let stopping = false;
const artifactAbort = new AbortController();
let artifactPreparation: Promise<string> | undefined;

async function stop(exitCode: number): Promise<never> {
  if (stopping) {
    return await new Promise<never>(() => undefined);
  }
  stopping = true;
  artifactAbort.abort();
  await artifactPreparation?.catch(() => undefined);
  server?.kill('SIGTERM');
  redis?.kill('SIGTERM');
  mail?.stop(true);
  const processes = [server, redis].filter(
    (processHandle): processHandle is ReturnType<typeof Bun.spawn> => processHandle !== null,
  );
  await Promise.race([
    Promise.allSettled(processes.map((processHandle) => processHandle.exited)),
    Bun.sleep(5_000),
  ]);
  for (const processHandle of processes) {
    if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
  }
  await Promise.allSettled(processes.map((processHandle) => processHandle.exited));
  removeE2EDatabase(databasePath);
  rmSync(redisDirectory, { recursive: true, force: true });
  process.exit(exitCode);
}

process.on('SIGINT', () => void stop(130));
process.on('SIGTERM', () => void stop(0));

try {
  redis = Bun.spawn(
    [
      redisBinary,
      '--bind',
      REDIS_HOST,
      '--port',
      String(redisPort),
      '--save',
      '',
      '--appendonly',
      'no',
      '--dir',
      redisDirectory,
      '--loglevel',
      'warning',
    ],
    {
      cwd: PROJECT_ROOT,
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  await waitForRedis(redis, redisPort);
  if (mailPort !== null) mail = startMailCapture(mailPort);

  const artifactRoot =
    process.env.PW_E2E_ARTIFACT_ROOT ??
    path.join(PROJECT_ROOT, 'test-results/verification/web-artifacts');
  artifactPreparation = prepareE2EWebArtifact(
    PROJECT_ROOT,
    process.env.PW_E2E_FORCE_EDGE === '1',
    artifactRoot,
    artifactAbort.signal,
  );
  const webDirectory = await artifactPreparation;

  process.stderr.write(
    `[e2e] starting server origin=${origin} db=${databasePath} redis=${REDIS_HOST}:${redisPort}\n`,
  );
  server = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      'run',
      path.join(PROJECT_ROOT, 'tests/e2e/start-app.ts'),
      webDirectory,
    ],
    {
      cwd: SERVER_DIRECTORY,
      env: serverEnvironment(),
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const serverExitCode = await server.exited;
  if (!stopping) {
    throw new Error(`server exited before Playwright teardown (exit ${serverExitCode})`);
  }
} catch (error) {
  process.stderr.write(
    `[e2e] startup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  await stop(1);
}

function serverEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    ...commonEnvironment(),
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
    HOST: '127.0.0.1',
    PORT: String(serverPort),
    PUBLIC_ORIGIN: origin,
    DB_PATH: databasePath,
    REDIS_URL: `redis://${REDIS_HOST}:${redisPort}`,
    AUTH_ALLOW_REGISTRATION: 'true',
    ...(mailPort === null
      ? { AUTH_IDENTITY: 'username' }
      : {
          AUTH_IDENTITY: 'email',
          RESEND_API_KEY: 're_e2e',
          EMAIL_FROM: 'Merkur <signin@merkur.test>',
          RESEND_API_URL: `http://127.0.0.1:${mailPort}`,
        }),
    // Trust one hop so each scenario's `x-forwarded-for` address becomes its own
    // rate-limit identity. With 0 hops every request resolves to the shared
    // 127.0.0.1 socket address, and the whole suite competes for one
    // 20-sign-ins-per-hour bucket.
    TRUSTED_PROXY_HOPS: '1',
    ACCESS_TOKEN_HMAC_KEY: randomBytes(64).toString('base64url'),
    JWT_ISSUER: 'merkur-e2e',
    JWT_AUDIENCE: 'merkur-e2e-clients',
    TOKEN_HMAC_SECRET: randomBytes(64).toString('base64url'),
    OPAQUE_SERVER_SETUP,
    OPAQUE_SERVER_PUBLIC_KEY,
    VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY: OPAQUE_SERVER_PUBLIC_KEY,
    SESSION_TOKEN_MLDSA87_SEED: Buffer.alloc(32, 0xe2).toString('base64url'),
    EDGE_REGISTRATION_KEYS_JSON: JSON.stringify({
      'local-harness-1': Buffer.alloc(64, 0x71).toString('base64url'),
    }),
    // Required config, so the server will not boot without it. The addresses
    // are deliberately unroutable: these harnesses assert session and transport
    // behaviour, and a daemon that actually reached a STUN server would make
    // their candidate sets depend on whatever NAT the machine running them sits
    // behind.
    STUN_TICKET_KEY: Buffer.alloc(64, 0x72).toString('base64url'),
    STUN_SERVERS: '192.0.2.1:3478,192.0.2.1:3479',
    // The harness edges run with this same key (`MERKUR_EDGE_ATTACH_TICKET_KEY`
    // in scripts/run-edge-harness.ts and run-edge-topology-harness.ts); an edge
    // with any other key closes every session this server issues.
    EDGE_ATTACH_TICKET_KEY: Buffer.alloc(64, 0x74).toString('base64url'),
  };

  copyEnvironment(environment, 'EDGE_REGISTRATION_KEYS_JSON');
  copyEnvironment(environment, 'STUN_TICKET_KEY');
  copyEnvironment(environment, 'EDGE_ATTACH_TICKET_KEY');
  copyEnvironment(environment, 'STUN_SERVERS');
  copyEnvironment(environment, 'SESSION_TOKEN_TTL_MS');
  return environment;
}

/**
 * Answers `POST /emails` as Resend does and keeps the message; `GET /captured`
 * returns everything kept, oldest first. Nothing is ever delivered.
 */
function startMailCapture(port: number): ReturnType<typeof Bun.serve> {
  const captured: unknown[] = [];
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === 'POST' && pathname === '/emails') {
        captured.push(await request.json());
        return Response.json({ id: `e2e-${captured.length}` });
      }
      if (request.method === 'GET' && pathname === '/captured') return Response.json(captured);
      return new Response('not found', { status: 404 });
    },
  });
}

function commonEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'CI', 'NO_COLOR']) {
    copyEnvironment(environment, name);
  }
  return environment;
}

function copyEnvironment(target: Record<string, string>, name: string): void {
  const value = process.env[name];
  if (value !== undefined) {
    target[name] = value;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set by the Playwright config`);
  }
  return value;
}

function requiredPort(name: string): number {
  const port = Number(requiredEnvironment(name));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return port;
}

async function waitForRedis(
  processHandle: ReturnType<typeof Bun.spawn>,
  port: number,
): Promise<void> {
  const deadline = Date.now() + REDIS_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`ephemeral redis-server exited early (${processHandle.exitCode})`);
    }
    if (await pingRedis(port)) {
      process.stderr.write(`[e2e] ephemeral Redis ready on ${REDIS_HOST}:${port}\n`);
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`ephemeral redis-server did not answer PING on ${REDIS_HOST}:${port} in 10s`);
}

function pingRedis(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: REDIS_HOST, port });
    const finish = (ready: boolean): void => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(250);
    socket.once('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'));
    socket.once('data', (data) => finish(data.toString('utf8').includes('PONG')));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
