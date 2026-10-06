import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { type DaemonConfig, validateDaemonConfig } from '@merkur/config';
import type { BrowserContext, BrowserContextOptions, Page, TestInfo } from '@playwright/test';
import {
  EDGE_HARNESS_NATIVE_MANIFEST_ENV,
  resolveVerifiedPrebuiltDataplanePath,
} from '../../../scripts/edge-harness-native-artifacts';

import { createAccount, expectLoggedIn } from './account';
import {
  collectDaemonPerfTraceCapture,
  type DaemonPerfTraceCapture,
} from './daemon-perf-trace-capture';
import { waitForFinalDaemonTransportCapture } from './daemon-transport-capture';
import { enableE2ETelemetryPreference } from './terminal-perf-artifacts';
import { test as base, expect } from './test';
import { redirectTransportWorker } from './transport-worker-prelude';

export const EDGE_PROXY_DIAL_MARKER = '[merkur-edge-proxy-dial]';

/**
 * Behind the edge harness's proxy each peer role owns a listener, and the edge
 * registers the daemon's. The browser's transport worker is pointed at its own
 * role's listener, so its connections cross the browser's links, never the
 * daemon's. The harness proves it: every edge attachment must have come
 * through a relay of its own role.
 */
async function redirectBrowserToItsProxyListener(
  context: BrowserContext,
  baseURL: string,
): Promise<void> {
  const daemonPort = process.env.EDGE_PROXY_DAEMON_PORT;
  const browserPort = process.env.EDGE_PROXY_BROWSER_PORT;
  if (daemonPort === undefined && browserPort === undefined) return;
  if (daemonPort === undefined || browserPort === undefined) {
    throw new Error('the edge harness exports both proxy role listeners or neither');
  }
  // Chromium's local network access gate refuses a loopback destination the
  // page was not handed; this is the consent a person grants a local terminal.
  if (context.browser()?.browserType().name() === 'chromium') {
    await context.grantPermissions(['local-network-access'], { origin: new URL(baseURL).origin });
  }
  await redirectTransportWorker(context, {
    from: Number(daemonPort),
    to: Number(browserPort),
    marker: EDGE_PROXY_DIAL_MARKER,
    label: 'edge proxy',
    candidate: 'edge',
  });
}

type DaemonChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

interface SpawnedProcess {
  readonly process: DaemonChildProcess;
  readonly logChunks: string[];
  readonly stdoutChunks: string[];
}

interface LinkedDaemonResources {
  readonly username: string;
  readonly password: string;
  readonly daemonId: string;
  readonly daemonName: string;
  readonly daemonHome: string;
  readonly webTransportPort: number;
  readonly process: DaemonChildProcess;
  readonly logChunks: string[];
  readonly context: BrowserContext;
}

export interface OfflineLinkedDaemon {
  readonly daemonId: string;
  readonly daemonName: string;
  readonly dispose: () => void;
}

interface CompletedDaemonLink {
  readonly daemonHome: string;
  readonly config: DaemonConfig;
  readonly daemonName: string;
  readonly logChunks: string[];
}

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DAEMON_ENTRY = path.join(PROJECT_ROOT, 'apps', 'daemon', 'src', 'index.ts');
const DAEMON_LINK_TIMEOUT_MS = 30_000;

function uniqueSuffix(): string {
  return `${Date.now()}-${randomBytes(3).toString('hex')}`;
}

async function registerUser(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#auth-screen')).toBeVisible();
  await createAccount(page, username, password);
  await expectLoggedIn(page);
}

/**
 * Reads the token out of the one command the UI offers.
 *
 * The command pipes the installer into `MERKUR_LINK_TOKEN=<token> sh`; this
 * suite links a source-tree daemon instead of installing a release, so it takes
 * the token from that environment assignment and hands it to `merkur link`
 * the same way.
 */
async function extractLinkToken(page: Page): Promise<string> {
  await openAddMachine(page);
  await expect(page.locator('#link-command')).toContainText('MERKUR_LINK_TOKEN=');
  const command = await page.locator('#link-command').innerText();
  const token = /MERKUR_LINK_TOKEN=([0-9A-HJ-NP-Z]{52}) /u.exec(command)?.[1];
  if (token === undefined) throw new Error(`link command carries no token: ${command}`);
  return token;
}

/**
 * Opens the "Add a machine" disclosure on the machine list.
 *
 * Linking is a once-a-month action, so it is folded behind the hint bar rather
 * than occupying a fifth of the home screen; with no machines it opens itself,
 * and with machines it does not. Everything inside it — the command, the token,
 * and Approve — is unrendered until it is open.
 */
export async function openAddMachine(page: Page): Promise<void> {
  const disclosure = page.locator('[data-add-machine]');
  await expect(disclosure).toBeAttached();
  if ((await disclosure.getAttribute('open')) === null) {
    await disclosure.locator('summary').click();
  }
  await expect(page.locator('#link-command')).toBeVisible();
}

async function spawnMerkur(
  args: readonly string[],
  daemonHome: string,
  existingLogChunks: string[] = [],
  linkToken: string | null = null,
): Promise<SpawnedProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERKUR_DAEMON_HOME: daemonHome,
    // With the shell itself (`E2E_SHELL`, written into the linked config), the
    // two variables below pin the *whole* shell environment, because pinning
    // part of it is what made this suite machine-dependent.
    //
    // `HOME` is the disposable per-test directory, so the shell finds no
    // `~/.inputrc` and only the `~/.bashrc` this fixture put there. Without
    // this the developer's own aliases, prompt, and `shopt`/`set -o vi`
    // settings are inside the system under test — the loudest possible source
    // of "passes for me".
    //
    // `INPUTRC` and that `.bashrc` are checked-in files rather than nothing,
    // because one default of each has to be overridden; see `inputrc` and
    // `bashrc` for which and why.
    HOME: daemonHome,
    INPUTRC: path.join(__dirname, 'inputrc'),
    // Listener readiness consumes the daemon's structured info events.
    LOG_LEVEL: 'info',
  };
  if (linkToken === null) delete env.MERKUR_LINK_TOKEN;
  else env.MERKUR_LINK_TOKEN = linkToken;
  // Drop an ambient installed-build override. In strict benchmark-manifest
  // mode, replace it with the just-reverified candidate-local dist path so an
  // executable beside Bun can never win the normal sidecar candidate search.
  //
  // `MERKUR_DATAPLANE_BIN` is how an *installed* Merkur points its daemon at
  // its own sidecar, so a developer machine with Merkur installed exports it.
  // Inheriting it silently swaps the system under test for whichever binary was
  // installed, whenever it was installed, and no amount of `build:dataplane`
  // can affect the run. Deleting it rather than pinning a path hands the choice
  // back to the daemon's own repo-relative resolution, which finds
  // `apps/daemon/dist` or `target/rust/release` — so this is correct whether or
  // not a given suite builds the dataplane itself. The explicit benchmark path
  // is accepted only after its source/toolchain/manifest bytes and every local
  // installed copy are checked again immediately before this daemon spawn.
  //
  // The failure it produces is not subtle but reads as anything but this: the
  // dataplane IPC contract is an exact key set on both sides, so the first
  // periodic telemetry event from a drifted binary is rejected, `invalid_event`
  // is fatal, and the daemon dies a few seconds into every session while the
  // server answers "failed to deliver session to daemon" forever after.
  const nativeManifestPath = process.env[EDGE_HARNESS_NATIVE_MANIFEST_ENV];
  if (nativeManifestPath === undefined) {
    delete env.MERKUR_DATAPLANE_BIN;
  } else {
    env.MERKUR_DATAPLANE_BIN = await resolveVerifiedPrebuiltDataplanePath(
      PROJECT_ROOT,
      nativeManifestPath,
    );
  }

  const proc = spawn('bun', ['run', DAEMON_ENTRY, ...args], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // No command reads stdin; closing it gives the first read EOF.
  proc.stdin.end();

  const stdoutChunks: string[] = [];
  const liveLog = process.env.DAEMON_LOG_FILE;
  const tee = (chunk: Buffer, stdout: boolean): void => {
    const text = chunk.toString('utf8');
    existingLogChunks.push(text);
    if (stdout) stdoutChunks.push(text);
    if (liveLog !== undefined) {
      try {
        appendFileSync(liveLog, text);
      } catch {
        // best-effort
      }
    }
  };
  proc.stdout.on('data', (chunk: Buffer) => tee(chunk, true));
  proc.stderr.on('data', (chunk: Buffer) => tee(chunk, false));
  return { process: proc, logChunks: existingLogChunks, stdoutChunks };
}

function spawnDaemon(daemonHome: string, logChunks: string[]): Promise<SpawnedProcess> {
  return spawnMerkur(['daemon'], daemonHome, logChunks);
}

async function killDaemon(proc: DaemonChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }
  proc.kill('SIGTERM');
  const result = await new Promise<'exited' | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 5_000);
    proc.once('close', () => {
      clearTimeout(timer);
      resolve('exited');
    });
  });
  if (result === 'timeout') {
    proc.kill('SIGKILL');
    if (proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>((resolve) => proc.once('close', () => resolve()));
    }
  }
}

async function waitForProcessExit(proc: DaemonChildProcess): Promise<number> {
  if (proc.exitCode !== null) return proc.exitCode;
  if (proc.signalCode !== null) return 1;
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('daemon link command did not exit after browser approval')),
      DAEMON_LINK_TIMEOUT_MS,
    );
    proc.once('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

function daemonLinkUrlFromLogs(stdoutChunks: readonly string[]): string | null {
  // `merkur link` prints the approval address on a line of its own.
  return /https?:\/\/\S+\/link#\S+/u.exec(stdoutChunks.join(''))?.[0] ?? null;
}

async function waitForDaemonLinkUrl(link: SpawnedProcess): Promise<string> {
  await expect
    .poll(
      () => {
        const code = daemonLinkUrlFromLogs(link.stdoutChunks);
        if (code !== null) return code;
        if (link.process.exitCode !== null || link.process.signalCode !== null) {
          throw new Error(
            `daemon link command exited before producing a code:\n${link.logChunks.join('')}`,
          );
        }
        return null;
      },
      { timeout: DAEMON_LINK_TIMEOUT_MS },
    )
    .not.toBeNull();
  const code = daemonLinkUrlFromLogs(link.stdoutChunks);
  if (code === null) throw new Error('daemon link URL disappeared from structured output');
  return code;
}

async function approveDaemonLink(page: Page, approvalUrl: string, password: string): Promise<void> {
  await page.goto(approvalUrl);
  const dialog = page.getByRole('dialog', { name: 'Approve a machine' });
  await expect(dialog).toBeVisible();
  // The address is rewritten before anything renders it.
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(dialog.locator('[data-link-machine]')).toContainText(hostname());
  await dialog.getByLabel('Merkur password').fill(password);
  await dialog.getByRole('button', { name: 'Approve machine' }).click();
  await expect(dialog).toBeHidden({ timeout: DAEMON_LINK_TIMEOUT_MS });
}

function readDaemonConfig(daemonHome: string): DaemonConfig {
  const configPath = path.join(daemonHome, '.merkur', 'config.json');
  const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
  return validateDaemonConfig(parsed);
}

/**
 * The shell every terminal of a test daemon opens. `merkur link` records the
 * account's login shell from the password database, which on a developer's
 * machine is their own fish or zsh, where every spec's bash setup line fails.
 *
 * `/bin/bash`, not `/bin/sh`: `sh` is bash on macOS and dash on Debian/Ubuntu,
 * and dash has no line editor, so every cursor-key escape the input matrix
 * sends is echoed literally instead of editing the line.
 */
const E2E_SHELL = '/bin/bash';

/**
 * The linked config with this run's shell and an unused WebTransport port, and
 * that shell's one setting in its home (`bashrc` says which and why).
 */
async function pinLinkedConfig(daemonHome: string): Promise<DaemonConfig> {
  copyFileSync(path.join(__dirname, 'bashrc'), path.join(daemonHome, '.bashrc'));

  const port = await new Promise<number>((resolve, reject) => {
    const socket = createSocket('udp6');
    socket.once('error', reject);
    socket.bind(0, '::', () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
  });
  const configPath = path.join(daemonHome, '.merkur', 'config.json');
  const config = validateDaemonConfig({
    ...readDaemonConfig(daemonHome),
    shell: E2E_SHELL,
    webtransport_port: port,
  });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return config;
}

async function waitForWebTransportListener(daemon: SpawnedProcess, port: number): Promise<void> {
  await expect
    .poll(
      () => {
        if (daemon.process.exitCode !== null || daemon.process.signalCode !== null) {
          throw new Error(
            `daemon exited before binding WebTransport port ${port} (exit=${daemon.process.exitCode}, signal=${daemon.process.signalCode})`,
          );
        }
        const logs = daemon.logChunks.join('');
        const failure = logs
          .split(/\r?\n/u)
          .find((line) => line.includes('WebTransport server maintenance failed'));
        if (failure !== undefined) throw new Error(failure);
        return logs.includes(`WebTransport server listening on port ${port},`);
      },
      {
        message: `daemon never bound its isolated WebTransport port ${port}`,
        timeout: DAEMON_LINK_TIMEOUT_MS,
      },
    )
    .toBe(true);
}

async function completeDaemonLink(
  page: Page,
  baseURL: string,
  password: string,
): Promise<CompletedDaemonLink> {
  const token = await extractLinkToken(page);
  const daemonHome = mkdtempSync(path.join(tmpdir(), 'merkur-e2e-daemon-'));
  const software = process.platform !== 'darwin' && process.env.MERKUR_TPM_SIM_ADDR === undefined;
  const link = await spawnMerkur(
    ['link', baseURL, ...(software ? ['--identity-backend', 'software'] : [])],
    daemonHome,
    [],
    token,
  );
  try {
    const approvalUrl = await waitForDaemonLinkUrl(link);
    await approveDaemonLink(page, approvalUrl, password);
    const exitCode = await waitForProcessExit(link.process);
    if (exitCode !== 0) {
      throw new Error(`daemon link command exited ${exitCode}:\n${link.logChunks.join('')}`);
    }
    const config = await pinLinkedConfig(daemonHome);
    expect(config.daemon_identity_seal.backend).toBe(software ? 'software' : 'hardware');
    return {
      daemonHome,
      config,
      daemonName: hostname(),
      logChunks: link.logChunks,
    };
  } catch (error) {
    await killDaemon(link.process);
    rmSync(daemonHome, { recursive: true, force: true });
    const daemonLog = link.logChunks.join('').trim();
    throw new Error(
      `Daemon link ceremony failed: ${error instanceof Error ? error.message : String(error)}${daemonLog.length > 0 ? `\n${daemonLog}` : ''}`,
      { cause: error },
    );
  }
}

export async function linkOfflineDaemon(
  page: Page,
  baseURL: string,
  password: string,
): Promise<OfflineLinkedDaemon> {
  const linked = await completeDaemonLink(page, baseURL, password);
  return {
    daemonId: linked.config.daemon_id,
    daemonName: linked.daemonName,
    dispose: () => rmSync(linked.daemonHome, { recursive: true, force: true }),
  };
}

interface LinkedDaemonFixture {
  username: string;
  password: string;
  daemonId: string;
  daemonName: string;
  /**
   * The disposable per-test directory the daemon's shell sees as `$HOME`. A
   * spec that needs a file in the shell's home writes it here directly instead
   * of typing it through the terminal.
   */
  daemonHome: string;
  /** Actual backend UDP port, for transparent test-only direct-path emulation. */
  webTransportPort: number;
  /**
   * Everything the daemon (and, through it, the dataplane) has logged so far.
   *
   * The daemon is worker-scoped, so this accumulates across the tests in a
   * file; a test that wants only its own window records the length first and
   * slices. Exposed because some behaviour is only observable on the daemon
   * side — a carrier rebind, for instance, leaves the browser looking exactly
   * like a session that never dropped, which is the point of it.
   */
  logText(): string;
  /** Bounded cold drain; call outside the measured input/display interval. */
  capturePerfTrace(): Promise<DaemonPerfTraceCapture>;
}

// The daemon, PTY, and trusted browser profile are worker-scoped. A fresh page
// is created for every test, while the live profile retains the nonextractable
// IndexedDB CryptoKey that Playwright storage-state serialization cannot clone.
// Context emulation is also a worker option so suites with different touch or
// viewport settings cannot reuse a mismatched manually-created context.
export const test = base.extend<
  { linkedDaemon: LinkedDaemonFixture },
  {
    linkedDaemonContextOptions: BrowserContextOptions;
    linkedDaemonWorker: LinkedDaemonResources;
  }
>({
  linkedDaemonContextOptions: [{}, { scope: 'worker', option: true }],
  linkedDaemonWorker: [
    async ({ browser, linkedDaemonContextOptions }, use, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL;
      if (typeof baseURL !== 'string') {
        throw new Error('baseURL is required for linkedDaemon fixture');
      }

      const context = await browser.newContext({ ...linkedDaemonContextOptions, baseURL });
      await redirectBrowserToItsProxyListener(context, baseURL);
      const setupPage = await context.newPage();
      let resources: LinkedDaemonResources | null = null;
      try {
        const suffix = uniqueSuffix();
        resources = await acquireLinkedDaemon({
          page: setupPage,
          baseURL,
          username: `e2e-${suffix}`,
          password: 'Password123!',
          context,
        });
        await setupPage.close();
        await use(resources);
      } finally {
        await context.close().catch(() => undefined);
        if (resources !== null) await releaseLinkedDaemon(resources);
      }
    },
    { scope: 'worker' },
  ],
  page: async ({ linkedDaemonWorker }, use, testInfo) => {
    const page = await linkedDaemonWorker.context.newPage();
    // This override replaces the base `page` fixture outright, so the telemetry
    // seed it installs does not apply here. Profiling has to be on before
    // `linkedDaemon` navigates: the app reads the preference once at boot and
    // latches `perfEnabled` per worker from it.
    await page.addInitScript(enableE2ETelemetryPreference);
    const diagnostics: string[] = [];
    page.on('console', (message) =>
      diagnostics.push(`[console:${message.type()}] ${message.text()}`),
    );
    page.on('pageerror', (error) =>
      diagnostics.push(`[pageerror] ${error.stack ?? error.message}`),
    );
    page.on('crash', () => diagnostics.push('[crash] browser page crashed'));
    page.on('requestfailed', (request) => {
      diagnostics.push(
        `[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
      );
    });
    try {
      await use(page);
    } finally {
      try {
        // Close the Rust telemetry window while the browser carrier and its
        // peer-owned counters still exist. Capturing from the worker finalizer
        // after context.close() loses unsampled per-peer deltas by construction.
        await captureLinkedDaemonTransport(linkedDaemonWorker);
      } finally {
        if (testInfo.status !== testInfo.expectedStatus && diagnostics.length > 0) {
          await testInfo.attach('browser-diagnostics.log', {
            body: `${diagnostics.join('\n')}\n`,
            contentType: 'text/plain',
          });
        }
        await page.close().catch(() => undefined);
      }
    }
  },
  linkedDaemon: async ({ page, linkedDaemonWorker }, use, testInfo) => {
    await page.goto('/');
    await expectLoggedIn(page);

    try {
      await expect(
        page.getByTitle(`Connect to ${linkedDaemonWorker.daemonName}`),
        'shared daemon never reported online',
      ).toBeVisible({ timeout: 30_000 });
      await use({
        username: linkedDaemonWorker.username,
        password: linkedDaemonWorker.password,
        daemonId: linkedDaemonWorker.daemonId,
        daemonName: linkedDaemonWorker.daemonName,
        daemonHome: linkedDaemonWorker.daemonHome,
        webTransportPort: linkedDaemonWorker.webTransportPort,
        logText: () => linkedDaemonWorker.logChunks.join(''),
        capturePerfTrace: () => captureLinkedDaemonPerfTrace(linkedDaemonWorker),
      });
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await attachDaemonLog(testInfo, linkedDaemonWorker.logChunks);
      }
    }
  },
});

interface AcquireOptions {
  readonly page: Page;
  readonly baseURL: string;
  readonly username: string;
  readonly password: string;
  readonly context: BrowserContext;
}

async function acquireLinkedDaemon(options: AcquireOptions): Promise<LinkedDaemonResources> {
  await registerUser(options.page, options.username, options.password);
  const linked = await completeDaemonLink(options.page, options.baseURL, options.password);
  const daemon = await spawnDaemon(linked.daemonHome, linked.logChunks);

  try {
    if (daemon.process.exitCode !== null || daemon.process.signalCode !== null) {
      throw new Error(
        `daemon exited before reporting online (exit=${daemon.process.exitCode}, signal=${daemon.process.signalCode})`,
      );
    }
    await expect(
      options.page.getByTitle(`Connect to ${linked.daemonName}`),
      'daemon never reported online',
    ).toBeVisible({ timeout: 30_000 });
    await waitForWebTransportListener(daemon, linked.config.webtransport_port);

    return {
      username: options.username,
      password: options.password,
      daemonId: linked.config.daemon_id,
      daemonName: linked.daemonName,
      daemonHome: linked.daemonHome,
      webTransportPort: linked.config.webtransport_port,
      process: daemon.process,
      logChunks: daemon.logChunks,
      context: options.context,
    };
  } catch (error) {
    await killDaemon(daemon.process);
    rmSync(linked.daemonHome, { recursive: true, force: true });
    const daemonLog = daemon.logChunks.join('').trim();
    throw new Error(
      `Linked daemon setup failed: ${error instanceof Error ? error.message : String(error)}${daemonLog.length > 0 ? `\n${daemonLog}` : ''}`,
      { cause: error },
    );
  }
}

async function releaseLinkedDaemon(resources: LinkedDaemonResources): Promise<void> {
  await killDaemon(resources.process);
  rmSync(resources.daemonHome, { recursive: true, force: true });
}

async function captureLinkedDaemonTransport(resources: LinkedDaemonResources): Promise<void> {
  if (process.env.MERKUR_E2E_FINAL_TRANSPORT_CAPTURE !== '1') return;
  if (resources.process.exitCode !== null || resources.process.signalCode !== null) {
    throw new Error('daemon exited before the final transport capture request');
  }
  const requestedAfterMs = Date.now();
  if (!resources.process.kill('SIGUSR2')) {
    throw new Error('daemon refused the final transport capture signal');
  }
  await waitForFinalDaemonTransportCapture(resources.logChunks, requestedAfterMs);
}

async function captureLinkedDaemonPerfTrace(
  resources: LinkedDaemonResources,
): Promise<DaemonPerfTraceCapture> {
  const firstChunk = resources.logChunks.length;
  const requestedAfterMs = Date.now();
  const read = () =>
    collectDaemonPerfTraceCapture(
      resources.logChunks.slice(firstChunk).join(''),
      resources.daemonId,
      requestedAfterMs,
    );
  if (process.env.MERKUR_E2E_FINAL_TRANSPORT_CAPTURE !== '1') {
    return {
      ...read(),
      status: 'failed',
      errors: ['native capture requires MERKUR_E2E_FINAL_TRANSPORT_CAPTURE=1 before daemon launch'],
    };
  }
  if (
    resources.process.exitCode !== null ||
    resources.process.signalCode !== null ||
    !resources.process.kill('SIGUSR2')
  ) {
    return { ...read(), status: 'failed', errors: ['daemon unavailable for native capture'] };
  }
  const deadlineAtMs = requestedAfterMs + 20_000;
  while (true) {
    const evidence = read();
    if (evidence.rawLog.length > 16 * 1024 * 1024) {
      return {
        ...evidence,
        status: 'invalid',
        errors: ['native capture exceeded 16 MiB log bound'],
      };
    }
    if (evidence.terminalMarkerSeen) return evidence;
    if (Date.now() >= deadlineAtMs) {
      return {
        ...evidence,
        status: 'failed',
        errors: ['native capture timed out after 20 seconds'],
      };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function attachDaemonLog(testInfo: TestInfo, chunks: readonly string[]): Promise<void> {
  await testInfo.attach('daemon.log', {
    body: chunks.length > 0 ? chunks.join('') : '(daemon produced no output)\n',
    contentType: 'text/plain',
  });
}

export { expect };
