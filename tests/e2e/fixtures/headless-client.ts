/**
 * The harness-built `merkur-tui headless`, driven as a child process: it signs
 * in with the password the browser registered and prints its session as JSON
 * lines.
 */
import { type ChildProcess, type ChildProcessByStdio, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { E2E_OPAQUE_PUBLIC_KEY } from '../../../scripts/e2e-opaque-pin';
import { expect, test } from './daemon-process';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TUI_BIN = path.join(PROJECT_ROOT, 'target', 'rust', 'release', 'merkur-tui');

export type HeadlessProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface HeadlessEvent {
  readonly event: string;
  readonly [field: string]: unknown;
}

/** The running client, as `withHeadlessClient` hands it to a test. */
export interface HeadlessClient {
  readonly child: HeadlessProcess;
  readonly events: HeadlessEvent[];
  readonly exited: Promise<number | null>;
  readonly next: (match: (event: HeadlessEvent) => boolean, timeoutMs: number) => Promise<void>;
}

/** Has the client print its presented screen (`SIGUSR1`), and returns it. */
export async function presentedScreen(client: HeadlessClient): Promise<HeadlessEvent> {
  const screens = () => client.events.filter((event) => event.event === 'screen');
  const seen = screens().length;
  client.child.kill('SIGUSR1');
  await client.next(() => screens().length > seen, 5_000);
  const screen = screens().at(-1);
  if (screen === undefined) throw new Error('headless client printed no screen');
  return screen;
}

/** Every JSON line the client has printed so far, and a way to wait for one. */
function readEvents(child: HeadlessProcess): {
  readonly events: HeadlessEvent[];
  readonly next: (match: (event: HeadlessEvent) => boolean, timeoutMs: number) => Promise<void>;
} {
  const events: HeadlessEvent[] = [];
  const waiters: (() => void)[] = [];
  let buffered = '';
  let ended = false;
  // Process exit may precede the last buffered stdout record. Only stream EOF
  // proves no terminal Closed status can still arrive.
  child.stdout.once('end', () => {
    ended = true;
    for (const wake of waiters.splice(0)) wake();
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length > 0) events.push(JSON.parse(line) as HeadlessEvent);
    }
    for (const wake of waiters.splice(0)) wake();
  });
  const next = async (match: (event: HeadlessEvent) => boolean, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (!events.some(match)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || ended) {
        throw new Error(`headless client never reported it: ${JSON.stringify(events)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  return { events, next };
}

export interface LinkedMachine {
  readonly username: string;
  readonly password: string;
  readonly daemonId: string;
}

/** Retires a client and keeps its evidence on a failed harness assertion. */
export async function finishClientFixture(
  child: ChildProcess,
  name: string,
  body: string,
): Promise<void> {
  if (child.exitCode === null) child.kill('SIGKILL');
  if (test.info().status !== test.info().expectedStatus) {
    await test.info().attach(name, { body, contentType: 'text/plain' });
  }
}

/**
 * Starts the harness-built client against `machine`, signed in with the
 * password the browser registered, and runs `body` while it is Ready. The
 * client's lines are attached to a failing test.
 */
export async function withHeadlessClient(
  machine: LinkedMachine,
  baseURL: string | undefined,
  body: (client: HeadlessClient) => Promise<void>,
  expectedExitCode: 0 | 1 = 0,
): Promise<void> {
  expect(existsSync(TUI_BIN), `${TUI_BIN} is built`).toBe(true);
  const edgePort = process.env.EDGE_PROXY_BROWSER_PORT;
  const child: HeadlessProcess = spawn(
    TUI_BIN,
    [
      'headless',
      '--origin',
      new URL(baseURL ?? '').origin,
      '--opaque-server-key',
      E2E_OPAQUE_PUBLIC_KEY,
      '--username',
      machine.username,
      '--machine',
      machine.daemonId,
      ...(edgePort === undefined ? [] : ['--edge-port', edgePort]),
      // The harness keeps sessions on the relay unless `FORCE_EDGE=0`, as the
      // web build's `VITE_FORCE_EDGE` keeps the browser's.
      ...(process.env.FORCE_EDGE === '0' ? [] : ['--relay-only']),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));
  const { events, next } = readEvents(child);
  try {
    child.stdin.write(`${machine.password}\n`);
    await next((event) => event.event === 'signed_in', 30_000);
    await next((event) => event.event === 'status' && event.status === 'Ready', 30_000);
    // The daemon's display opens under the session's keys and roots the grid.
    await next((event) => event.event === 'snapshot', 15_000);
    await body({ child, events, exited, next });

    // EOF or a daemon-owned terminal authorization rejection ends the client.
    if (child.exitCode === null) child.stdin.end();
    const code = await exited;
    expect(code, JSON.stringify(events)).toBe(expectedExitCode);
  } finally {
    await finishClientFixture(
      child,
      'headless-client.log',
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n${stderr.join('')}`,
    );
  }
}

/**
 * Types a command that prints `lines` numbered lines, each a separate display
 * state for a paced daemon, then `marker` split so that only the command's
 * output (never its echoed command line) contains it whole, and waits for the
 * grid the client holds to show it.
 */
export async function floodAndSee(
  client: HeadlessClient,
  marker: string,
  lines: number,
): Promise<void> {
  const half = Math.floor(marker.length / 2);
  client.child.stdin.write(
    `seq 1 ${lines}; printf '%s%s\\n' ${marker.slice(0, half)} ${marker.slice(half)}\n`,
  );
  const shows = (event: HeadlessEvent) =>
    event.event === 'screen' &&
    Array.isArray(event.rows) &&
    event.rows.some((row) => typeof row === 'string' && row.trim() === marker);
  await expect
    .poll(async () => shows(await presentedScreen(client)), { timeout: 20_000 })
    .toBe(true);
  const screen = client.events.filter(shows).at(-1);
  expect(screen?.resyncs, JSON.stringify(screen)).toBe(0);
  // Every row-hash digest the daemon sent agreed with the grid.
  expect(screen?.resync_rows, JSON.stringify(screen)).toBe(0);
}

/** Types a command that writes `text` to a fresh file and waits for the file. */
export async function typeAndObserve(child: HeadlessProcess, text: string): Promise<void> {
  const marker = path.join(tmpdir(), `merkur-tui-e2e-${process.pid}-${Date.now()}-${text}`);
  try {
    child.stdin.write(`printf ${text} > ${marker}\n`);
    await expect.poll(() => existsSync(marker), { timeout: 15_000 }).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe(text);
  } finally {
    rmSync(marker, { force: true });
  }
}
