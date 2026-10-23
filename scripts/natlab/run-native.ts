/** One real-account/native-terminal session in the namespaces native.sh owns. */
import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { nativeProgram } from '../native-artifacts';
import { NATIVE_EDGE_URL } from './native-edge';
import { playwrightCli } from './playwright-cli';

const root = path.resolve(import.meta.dir, '../..');
const edgeId = 'local-harness-1';
const appPort = 24_331;
const EDGE_BIND_DEADLINE_MS = 15_000;
const CHILD_STOP_DEADLINE_MS = 5_000;
const children: ChildProcess[] = [];
let stopping = false;

function stop(): void {
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

const edge = spawn(nativeProgram(root, 'merkur-edge'), [], {
  cwd: root,
  env: {
    ...process.env,
    MERKUR_EDGE_PORT: '4433',
    MERKUR_EDGE_HOSTNAME: 'localhost',
    MERKUR_EDGE_REGISTER_URL: `http://127.0.0.1:${appPort}/api/edge/register`,
    MERKUR_EDGE_REGISTRATION_KEY: Buffer.alloc(64, 0x71).toString('base64url'),
    MERKUR_EDGE_ATTACH_TICKET_KEY: Buffer.alloc(64, 0x74).toString('base64url'),
    MERKUR_EDGE_ID: edgeId,
    MERKUR_EDGE_REGION: 'local',
    MERKUR_EDGE_PUBLIC_URL: NATIVE_EDGE_URL,
    MERKUR_EDGE_DATA_BUDGET_GB: '1000000',
    MERKUR_EDGE_SIGNALING_RESERVE_GB: '100000',
    MERKUR_EDGE_EGRESS_INTERFACE: 'lo',
    MERKUR_EDGE_IDENTITY_DIR: path.join('/tmp', `merkur-native-nat-edge-${process.pid}`),
    RUST_LOG: 'info',
    NO_COLOR: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(edge);

try {
  const certHash = await new Promise<string>((resolve, reject) => {
    let buffered = '';
    let hash: string | undefined;
    let bound = false;
    const timeout = setTimeout(
      () => reject(new Error('NAT-lab edge did not bind')),
      EDGE_BIND_DEADLINE_MS,
    );
    edge.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    edge.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`NAT-lab edge exited before readiness: ${code}`));
    });
    const data = (chunk: Buffer): void => {
      process.stderr.write(chunk);
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        hash ??= /cert_hash_b64=([A-Za-z0-9+/]{43}=)/u.exec(line)?.[1];
        bound ||= line.includes('WebTransport socket bound; registration pending');
      }
      if (hash !== undefined && bound) {
        clearTimeout(timeout);
        resolve(hash);
      }
    };
    edge.stdout.on('data', data);
    edge.stderr.on('data', data);
  });
  const playwright = spawn(
    'node',
    [
      playwrightCli,
      'test',
      'tui-nat.e2e.ts',
      '--config',
      'scripts/natlab/playwright.native.config.mjs',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        FORCE_EDGE: '0',
        PW_E2E_NATIVE_PROGRAMS_SYNCED: '1',
        PW_E2E_PORT: String(appPort),
        PW_E2E_REDIS_PORT: String(appPort + 1),
        PW_E2E_EDGE_ID: edgeId,
        PW_E2E_EDGE_URL: NATIVE_EDGE_URL,
        PW_E2E_EDGE_CERT_HASH: certHash,
      },
      stdio: 'inherit',
    },
  );
  children.push(playwright);
  const code = await new Promise<number>((resolve, reject) => {
    playwright.once('error', reject);
    playwright.once('exit', (status) => resolve(status ?? 1));
    edge.once('exit', (status) => {
      if (!stopping && playwright.exitCode === null) {
        playwright.kill('SIGTERM');
        reject(new Error(`NAT-lab edge exited during session: ${status}`));
      }
    });
  });
  if (code !== 0) throw new Error(`NAT-lab authenticated session failed: ${code}`);
} finally {
  stop();
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const deadline = setTimeout(() => child.kill('SIGKILL'), CHILD_STOP_DEADLINE_MS);
          child.once('close', () => {
            clearTimeout(deadline);
            resolve();
          });
        }),
    ),
  );
}
