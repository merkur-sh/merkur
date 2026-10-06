import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { AppPhase, ConnectionStatus } from '../apps/web/src/app/navigation';

const ROOT = path.resolve(import.meta.dir, '..');
const ARTIFACT_ROOT = path.join(ROOT, 'test-results', 'ios-webkit-harness', 'latest');
const SAFARIDRIVER = '/System/Cryptexes/App/usr/bin/safaridriver';
const DRIVER_PORT = 55_55;
const DEFAULT_DEVICE_NAME = 'iPhone 17 Pro';
const MIN_CONNECTED_SURFACE_SAMPLES = 8;

interface Options {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly daemonName: string;
  readonly deviceName: string;
  readonly timeoutMs: number;
}

interface WebDriverResponse<T> {
  readonly value: T;
}

interface WebDriverError {
  readonly error?: string;
  readonly message?: string;
  readonly stacktrace?: string;
}

const options = parseOptions(process.argv.slice(2));
rmSync(ARTIFACT_ROOT, { recursive: true, force: true });
mkdirSync(ARTIFACT_ROOT, { recursive: true });

const driverLog: string[] = [];
const driver = spawn(SAFARIDRIVER, ['--diagnose', '-p', String(DRIVER_PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
driver.stdout.on('data', (chunk: Buffer) => driverLog.push(chunk.toString('utf8')));
driver.stderr.on('data', (chunk: Buffer) => driverLog.push(chunk.toString('utf8')));

let sessionId: string | undefined;
try {
  await waitForDriver();
  const session = await request<{ sessionId: string }>('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'Safari',
        platformName: 'iOS',
        'safari:useSimulator': true,
        'safari:deviceName': options.deviceName,
      },
    },
  });
  sessionId = session.sessionId;
  await command('POST', '/url', { url: options.url });
  // The terminal renders only through WebGPU. The iOS Simulator's Safari exposes
  // `navigator.gpu` but returns no adapter, so no startup can be traced there;
  // report that fact instead of a disconnect.
  if (await hasWebGpuAdapter()) {
    await traceStartup();
  } else {
    process.stdout.write(
      `${JSON.stringify({ artifactRoot: ARTIFACT_ROOT, device: options.deviceName, reason: 'no-webgpu-adapter' })}\n`,
    );
  }
} catch (error) {
  if (sessionId !== undefined) {
    await saveTrace().catch((traceError: unknown) => {
      driverLog.push(`Trace collection failed: ${String(traceError)}\n`);
    });
  }
  throw error;
} finally {
  if (sessionId !== undefined) {
    await request('DELETE', `/session/${sessionId}`).catch(() => undefined);
  }
  driver.kill('SIGTERM');
  writeFileSync(path.join(ARTIFACT_ROOT, 'safaridriver.log'), driverLog.join(''));
}

/** Sign in if needed, then trace a cold and a repeat connection. */
async function traceStartup(): Promise<void> {
  const initialPhase = await waitForPhase(['auth', 'shell'], 30_000);
  if (initialPhase === 'auth') {
    await execute(loginScript(options.username, options.password));
    await waitForPhase(['shell'], 30_000);
  }
  await waitForConnectButton(options.daemonName, 30_000);
  await execute(collectorScript());

  await observeConnection('first', options.daemonName);
  await execute(
    `document.querySelector('#terminal [aria-label="Back to machines"]')?.click(); true`,
  );
  await waitForConnection(['idle', 'disconnected'], 20_000);
  await waitForConnectButton(options.daemonName, 20_000);
  await observeConnection('second', options.daemonName);

  const trace = await saveTrace();
  process.stdout.write(
    `${JSON.stringify({
      artifactRoot: ARTIFACT_ROOT,
      device: options.deviceName,
      reason: 'complete',
      sampleCount:
        typeof trace === 'object' &&
        trace !== null &&
        'samples' in trace &&
        Array.isArray(trace.samples)
          ? trace.samples.length
          : 0,
    })}\n`,
  );
}

async function saveTrace(): Promise<unknown> {
  const trace = await execute(`
    return (() => {
      window.clearInterval(window.__merkurIosTrace?.timer);
      return {
        ...window.__merkurIosTrace,
        body: document.body?.innerText,
        capabilities: {
          secureContext: isSecureContext,
          crossOriginIsolated,
          webTransport: typeof WebTransport,
          webGpu: typeof navigator.gpu,
          sharedArrayBuffer: typeof SharedArrayBuffer,
        },
        resources: performance.getEntriesByType('resource').map((entry) => ({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
          initiatorType: entry.initiatorType,
        })),
      };
    })()
  `);
  writeFileSync(
    path.join(ARTIFACT_ROOT, 'trace.json'),
    `${JSON.stringify({ schemaVersion: 1, deviceName: options.deviceName, trace }, null, 2)}\n`,
  );
  return trace;
}

async function observeConnection(label: string, daemonName: string): Promise<void> {
  await execute(`
    window.__merkurIosTrace.phase = ${JSON.stringify(label)};
    window.__merkurIosTrace.events.push({ kind: 'connect_click', phase: ${JSON.stringify(label)}, at: performance.now() });
    (() => {
      const title = ${JSON.stringify(`Connect to ${daemonName}`)};
      const target = [...document.querySelectorAll('[title]')].find((node) => node.getAttribute('title') === title);
      target?.click();
      return Boolean(target);
    })()
  `);
  const startedAt = performance.now();
  for (const targetMs of [0, 100, 500, 1_500]) {
    const remaining = targetMs - (performance.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
    await captureScreenshot(`${label}-${targetMs}ms.png`);
  }
  await waitForConnection(['connected'], 30_000);
  await waitForConnectedSurfaceSamples(label, MIN_CONNECTED_SURFACE_SAMPLES, 5_000);
  const remainder = 4_000 - (performance.now() - startedAt);
  if (remainder > 0) await sleep(remainder);
}

/**
 * Require real timer samples after the terminal is both connected and sized.
 *
 * SafariDriver screenshots can take seconds on a busy simulator. They are
 * intentionally part of the startup trace, but their latency must not consume
 * the observation window and let the first connection leave after a single
 * surface sample. Poll the collector's records rather than sleeping for a
 * guessed duration so timer throttling cannot weaken the evidence either.
 */
async function waitForConnectedSurfaceSamples(
  phase: string,
  minimum: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + Math.min(timeoutMs, options.timeoutMs);
  while (Date.now() < deadline) {
    const count = await execute(`
      return window.__merkurIosTrace.samples.filter(
        (sample) => sample.phase === ${JSON.stringify(phase)} &&
          sample.connection === 'connected' &&
          typeof sample.canvas?.cssWidth === 'string' &&
          sample.canvas.cssWidth.length > 0
      ).length
    `);
    if (typeof count === 'number' && count >= minimum) return;
    await sleep(25);
  }
  throw new Error(
    `Timed out waiting for ${minimum} connected terminal-surface samples in ${phase}`,
  );
}

async function waitForDriver(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await request('GET', '/status');
      return;
    } catch {
      if (driver.exitCode !== null) {
        throw new Error(`SafariDriver exited (${driver.exitCode}):\n${driverLog.join('')}`);
      }
      await sleep(100);
    }
  }
  throw new Error(`SafariDriver did not become ready:\n${driverLog.join('')}`);
}

/**
 * Wait for one of `document.body`'s navigation attributes to reach a value.
 *
 * `phase` and `connection` are orthogonal — which screen is mounted, and what
 * the transport is doing — and are typed here against the app's own unions, so
 * a rename on the writing side fails this file's type check instead of leaving
 * it polling forever. It used to read a single `data-state` enum that nothing
 * writes any more, which made every wait here a guaranteed timeout.
 */
async function waitForBodyAttribute<Value extends string>(
  attribute: 'phase' | 'connection',
  values: readonly Value[],
  timeoutMs: number,
): Promise<Value> {
  const deadline = Date.now() + Math.min(timeoutMs, options.timeoutMs);
  while (Date.now() < deadline) {
    const value = await execute(`return document.body?.dataset.${attribute} ?? ''`);
    if (typeof value === 'string' && (values as readonly string[]).includes(value)) {
      return value as Value;
    }
    if (
      attribute === 'connection' &&
      value === 'disconnected' &&
      (values as readonly string[]).includes('connected')
    ) {
      const failures = await execute(`return window.__merkurIosTrace?.events.filter((event) =>
        event.kind === 'console_error' || event.kind === 'worker_error' || event.kind === 'worker_status'
      ) ?? []`);
      throw new Error(`Terminal startup disconnected: ${JSON.stringify(failures)}`);
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for data-${attribute} to reach ${values.join(' or ')}`);
}

function waitForPhase(phases: readonly AppPhase[], timeoutMs: number): Promise<AppPhase> {
  return waitForBodyAttribute('phase', phases, timeoutMs);
}

function waitForConnection(
  connections: readonly ConnectionStatus[],
  timeoutMs: number,
): Promise<ConnectionStatus> {
  return waitForBodyAttribute('connection', connections, timeoutMs);
}

async function waitForConnectButton(daemonName: string, timeoutMs: number): Promise<void> {
  const title = `Connect to ${daemonName}`;
  const deadline = Date.now() + Math.min(timeoutMs, options.timeoutMs);
  while (Date.now() < deadline) {
    const found = await execute(`
      return [...document.querySelectorAll('[title]')].some(
        (node) => node.getAttribute('title') === ${JSON.stringify(title)}
      )
    `);
    if (found === true) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${title}`);
}

async function execute(script: string): Promise<unknown> {
  return command('POST', '/execute/sync', { script, args: [] });
}

async function hasWebGpuAdapter(): Promise<boolean> {
  const adapter = await command('POST', '/execute/async', {
    script: `const done = arguments[arguments.length - 1];
      Promise.resolve(navigator.gpu?.requestAdapter())
        .then((adapter) => done(adapter !== null && adapter !== undefined), () => done(false));`,
    args: [],
  });
  return adapter === true;
}

async function captureScreenshot(filename: string): Promise<void> {
  const png = await command('GET', '/screenshot');
  if (typeof png !== 'string') throw new Error('SafariDriver returned an invalid screenshot');
  writeFileSync(path.join(ARTIFACT_ROOT, filename), Buffer.from(png, 'base64'));
}

async function command(method: string, endpoint: string, body?: unknown): Promise<unknown> {
  if (sessionId === undefined) throw new Error('SafariDriver session is not available');
  return request(method, `/session/${sessionId}${endpoint}`, body);
}

async function request<T = unknown>(method: string, endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${DRIVER_PORT}${endpoint}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json()) as WebDriverResponse<T | WebDriverError>;
  if (
    !response.ok ||
    (typeof payload.value === 'object' && payload.value !== null && 'error' in payload.value)
  ) {
    const error = payload.value as WebDriverError;
    throw new Error(
      `WebDriver ${method} ${endpoint}: ${error.error ?? response.status} ${error.message ?? ''}`,
    );
  }
  return payload.value as T;
}

function loginScript(username: string, password: string): string {
  return `
    (() => {
      const username = document.querySelector('#field-username');
      const password = document.querySelector('#field-password');
      if (!(username instanceof HTMLInputElement) || !(password instanceof HTMLInputElement)) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(username, ${JSON.stringify(username)});
      username.dispatchEvent(new Event('input', { bubbles: true }));
      set.call(password, ${JSON.stringify(password)});
      password.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#auth-form')?.requestSubmit();
      return true;
    })()
  `;
}

function parseOptions(args: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error(`Expected --name value arguments`);
    }
    values.set(key.slice(2), value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing --${name}`);
    return value;
  };
  return {
    url: required('url'),
    username: required('username'),
    password: required('password'),
    daemonName: required('daemon-name'),
    deviceName: values.get('device-name') ?? DEFAULT_DEVICE_NAME,
    timeoutMs: Number(values.get('timeout-ms') ?? 90_000),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectorScript(): string {
  return `
  (() => {
    const trace = {
      startedAt: performance.now(),
      phase: 'ready',
      samples: [],
      events: [],
      timer: 0,
    };
    window.addEventListener('error', (event) => {
      trace.events.push({ kind: 'error', at: performance.now(), message: event.message });
    });
    window.addEventListener('unhandledrejection', (event) => {
      trace.events.push({ kind: 'unhandledrejection', at: performance.now(), message: String(event.reason) });
    });
    const NativeWorker = window.Worker;
    for (const level of ['warn', 'error']) {
      const original = console[level];
      console[level] = (...args) => {
        trace.events.push({
          kind: 'console_' + level,
          at: performance.now(),
          message: args.map((arg) => typeof arg === 'string' ? arg : String(arg?.error ?? arg?.message ?? '')).join(' '),
        });
        original.apply(console, args);
      };
    }
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.addEventListener('error', (event) => {
          trace.events.push({ kind: 'worker_error', at: performance.now(), url: String(url), message: event.message });
        });
        this.addEventListener('message', ({ data }) => {
          if (typeof data?.error === 'string' || typeof data?.reason === 'string') {
            trace.events.push({ kind: 'worker_status', at: performance.now(), url: String(url), type: data.kind, error: data.error, reason: data.reason });
          }
        });
      }
    };
    const sample = () => {
      const output = document.querySelector('#terminal-output');
      const canvas = output?.querySelector('canvas');
      const outputRect = output?.getBoundingClientRect();
      const canvasRect = canvas?.getBoundingClientRect();
      const mirror = document.querySelector('[role="log"]');
      const text = mirror?.textContent ?? '';
      let privateUseCodepoints = 0;
      for (const char of text) {
        const cp = char.codePointAt(0) ?? 0;
        if ((cp >= 0xE000 && cp <= 0xF8FF) || (cp >= 0xF0000 && cp <= 0xFFFFD)) privateUseCodepoints += 1;
      }
      trace.samples.push({
        at: performance.now(),
        phase: trace.phase,
        connection: document.body?.dataset.connection ?? '',
        innerWidth,
        innerHeight,
        dpr: devicePixelRatio,
        visualViewport: visualViewport ? {
          width: visualViewport.width,
          height: visualViewport.height,
          offsetTop: visualViewport.offsetTop,
          scale: visualViewport.scale,
        } : null,
        output: outputRect ? { width: outputRect.width, height: outputRect.height } : null,
        canvas: canvasRect ? {
          width: canvasRect.width,
          height: canvasRect.height,
          left: canvasRect.left,
          top: canvasRect.top,
          backingWidth: canvas.width,
          backingHeight: canvas.height,
          cssWidth: canvas.style.width,
          cssHeight: canvas.style.height,
        } : null,
        fontStatus: document.fonts.status,
        terminalFontFamily: output ? getComputedStyle(output).fontFamily : null,
        privateUseCodepoints,
      });
    };
    sample();
    trace.timer = window.setInterval(sample, 25);
    window.__merkurIosTrace = trace;
    return true;
  })()
`;
}
