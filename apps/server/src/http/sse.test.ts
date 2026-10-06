import { describe, expect, test } from 'bun:test';
import type { DeviceDeltaFrame, DeviceEventsCursor } from '@merkur/shared';
import { Effect, Layer, ManagedRuntime } from 'effect';
import type { BrowserPresenceSignal } from '../services/browser-session-presence';
import type { DeviceEventSignal } from '../services/device-events-service';
import {
  createDeviceEventsSseLifetime,
  createDeviceEventsSseResponse,
  openDeviceEventsStreams,
} from './sse';

const DEVICE = {
  id: 'daemon-1',
  userId: 'user-1',
  name: 'Workstation',
  platform: 'linux',
  status: 'online',
  lastSeen: 1,
  version: '1.0.0',
  identitySealBackend: 'software',
} as const;

function delta(seq: number): DeviceDeltaFrame {
  return { seq, kind: 'presence', daemonId: 'daemon-1', status: 'offline' };
}

interface Harness {
  readonly response: Response;
  readonly lifetime: ReturnType<typeof createDeviceEventsSseLifetime>;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly errors: unknown[];
  readonly presenceReady: Promise<void>;
  /** Every close this stream reported, in order. */
  readonly closes: Array<{ reason: string; openForUser: number }>;
  readonly abort: () => void;
  readonly shutdown: () => Promise<void>;
  readonly released: { devices: number; presence: number };
  signal(signal: DeviceEventSignal): void;
  presence(signal: BrowserPresenceSignal): void;
  /** Resolves the pending snapshot read; until then deltas are buffered. */
  releaseSnapshot(): void;
}

const EPOCH = 'a1b2c3d4e5f60718';
/** A counter that restarted: same numbers, different epoch. */
const REBUILT_EPOCH = '00112233445566ff';

function createHarness(options: {
  readonly since: DeviceEventsCursor | null;
  readonly seq: number;
  readonly userId?: string;
  readonly holdSnapshot?: boolean;
  readonly loadSnapshot?: () => Promise<readonly (typeof DEVICE)[]>;
  readonly aborted?: boolean;
  readonly deviceRelease?: Effect.Effect<void>;
  readonly lifetime?: ReturnType<typeof createDeviceEventsSseLifetime>;
}): Harness {
  const requestController = new AbortController();
  if (options.aborted === true) requestController.abort();
  const runtime = ManagedRuntime.make(Layer.empty);
  const lifetime = options.lifetime ?? createDeviceEventsSseLifetime();
  const released = { devices: 0, presence: 0 };
  const errors: unknown[] = [];
  const closes: Array<{ reason: string; openForUser: number }> = [];
  let listener: ((signal: DeviceEventSignal) => void) | null = null;
  let presenceListener: ((signal: BrowserPresenceSignal) => void) | null = null;
  let resolvePresence = (): void => {};
  const presenceReady = new Promise<void>((resolve) => {
    resolvePresence = resolve;
  });
  let releaseSnapshot = (): void => {};
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  const response = createDeviceEventsSseResponse<unknown, never>({
    lifetime,
    run: (program, runOptions) => runtime.runPromise(program, runOptions),
    request: new Request('https://merkur.test/events', { signal: requestController.signal }),
    userId: options.userId ?? 'user-1',
    keepAliveMs: 60_000,
    since: options.since,
    subscribePresence: (next) =>
      Effect.sync(() => {
        presenceListener = next;
        resolvePresence();
        return Effect.sync(() => {
          presenceListener = null;
          released.presence += 1;
        });
      }),
    subscribe: (next) =>
      Effect.sync(() => {
        listener = next;
        return Effect.andThen(
          options.deviceRelease ?? Effect.void,
          Effect.sync(() => {
            listener = null;
            released.devices += 1;
          }),
        );
      }),
    readCursor: Effect.succeed({ epoch: EPOCH, seq: options.seq }),
    loadSnapshot: Effect.tryPromise({
      try: async () => {
        if (options.holdSnapshot === true) await snapshotGate;
        return options.loadSnapshot === undefined ? [DEVICE] : await options.loadSnapshot();
      },
      catch: (error) => error,
    }),
    onError: (error) => errors.push(error),
    onClosed: (reason, openForUser) => closes.push({ reason, openForUser }),
  });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('response body missing');
  return {
    response,
    lifetime,
    reader,
    errors,
    presenceReady,
    closes,
    abort: () => requestController.abort(),
    shutdown: () => runtime.dispose(),
    released,
    signal(signal) {
      if (listener === null) throw new Error('stream not subscribed yet');
      listener(signal);
    },
    presence(signal) {
      if (presenceListener === null) throw new Error('presence not subscribed yet');
      presenceListener(signal);
    },
    releaseSnapshot: () => releaseSnapshot(),
  };
}

describe('createDeviceEventsSseResponse', () => {
  test('pushes browser presence independently of the device cursor and closes on lost presence', async () => {
    const harness = createHarness({ since: { epoch: EPOCH, seq: 9 }, seq: 9 });
    await readUntil(harness.reader, (text) => text.includes('event: resume'));
    await harness.presenceReady;
    harness.presence({ _tag: 'presence', frame: { activeDelegationIds: ['browser-2'] } });
    const body = await readUntil(harness.reader, (text) =>
      text.includes('event: browser-presence'),
    );
    expect(body).toContain('"activeDelegationIds":["browser-2"]');
    harness.presence({ _tag: 'resync' });
    expect(harness.closes[0]?.reason).toBe('resync');
    await harness.reader.cancel();
  });
  test('sends session-ended before closing even while the initial snapshot is pending', async () => {
    const harness = createHarness({ since: null, seq: 0, holdSnapshot: true });
    await harness.presenceReady;
    harness.presence({ _tag: 'session-ended' });
    const body = await readUntil(harness.reader, (_text, done) => done);
    expect(body).toContain('event: browser-session-ended\ndata: null\n\n');
    expect(body).not.toContain('event: snapshot');
    expect(harness.closes.map((close) => close.reason)).toEqual(['session_ended']);
    harness.releaseSnapshot();
    await harness.reader.cancel();
  });

  test('forwards sessions-changed and keeps the stream open', async () => {
    const harness = createHarness({ since: { epoch: EPOCH, seq: 9 }, seq: 9 });
    await readUntil(harness.reader, (text) => text.includes('event: resume'));
    await harness.presenceReady;
    harness.presence({ _tag: 'sessions-changed' });
    const body = await readUntil(harness.reader, (text) =>
      text.includes('event: browser-sessions-changed'),
    );
    expect(body).toContain('event: browser-sessions-changed\ndata: null\n\n');
    expect(harness.closes).toHaveLength(0);
    await harness.reader.cancel();
  });

  test('opens with padding and declares the body already encoded', async () => {
    const harness = createHarness({ since: { epoch: EPOCH, seq: 9 }, seq: 9 });

    // Both defences against an intermediary that holds a stream of tiny writes
    // until it has something worth flushing. Without them the browser sees an
    // open connection that never yields a byte, cannot fault on it, and quietly
    // reconnects forever while the list stops updating.
    expect(harness.response.headers.get('content-encoding')).toBe('identity');
    expect(harness.response.headers.get('cache-control')).toContain('no-transform');
    // `no-store`, because `no-cache` stores: the entry it creates has a single
    // writer, and a second request for this URL blocks on that writer's lock
    // until the first body ends. This one does not end, so a reload parked its
    // own stream behind the page it replaced until the browser's lock timed
    // out — no headers, no bytes, no error, and nothing at the server to see.
    expect(harness.response.headers.get('cache-control')).toContain('no-store');
    expect(harness.response.headers.get('x-accel-buffering')).toBe('no');

    const body = await readUntil(harness.reader, (text) => text.includes('event: resume'));
    // A comment, so it is the parser's business to discard it.
    expect(body.startsWith(':')).toBe(true);
    expect(body.indexOf('\n\n')).toBeGreaterThan(2_048);

    harness.abort();
    await harness.reader.cancel();
  });

  test('opens with a sequenced snapshot and forwards later deltas in order', async () => {
    const harness = createHarness({ since: null, seq: 4 });
    let body = await readFramesUntil(harness.reader, (text) => text.includes('event: snapshot'));
    expect(body).toContain(
      `event: snapshot\ndata: {"epoch":"${EPOCH}","seq":4,"devices":[${JSON.stringify(DEVICE)}]}\n\n`,
    );

    harness.signal({ _tag: 'delta', frame: delta(5) });
    body = await readFramesUntil(harness.reader, (text) => text.includes('"seq":5'));
    expect(body).toContain(`event: delta\ndata: ${JSON.stringify(delta(5))}\n\n`);

    harness.abort();
    await harness.reader.cancel();
  });

  test('answers a current client with a resume frame and no snapshot', async () => {
    const harness = createHarness({
      since: { epoch: EPOCH, seq: 9 },
      seq: 9,
      loadSnapshot: async () => {
        throw new Error('snapshot must not be read');
      },
    });
    const body = await readFramesUntil(harness.reader, (text) => text.includes('event: resume'));
    expect(body).toBe(`event: resume\ndata: {"epoch":"${EPOCH}","seq":9}\n\n`);
    expect(harness.errors).toEqual([]);

    harness.abort();
    await harness.reader.cancel();
  });

  test('refuses to resume a matching sequence on a counter that restarted', async () => {
    // The counter this browser was following is gone — Redis restarted, or the
    // key was evicted — and the new one has climbed back to the same number
    // through entirely different transitions. Answering `resume` here is how a
    // list of machines silently keeps rendering presence from another era.
    const harness = createHarness({ since: { epoch: REBUILT_EPOCH, seq: 9 }, seq: 9 });
    const body = await readFramesUntil(harness.reader, (text) => text.includes('event: snapshot'));
    expect(body).toContain(`"epoch":"${EPOCH}","seq":9`);
    expect(harness.errors).toEqual([]);

    harness.abort();
    await harness.reader.cancel();
  });

  test('replays deltas buffered during the snapshot read, filtered by the snapshot sequence', async () => {
    const harness = createHarness({ since: null, seq: 2, holdSnapshot: true });
    // Subscription precedes the snapshot; a read that lands between the two
    // is in the snapshot and arrives again as a delta — harmless, because it
    // is absolute — while anything newer must follow the snapshot in order.
    await Bun.sleep(5);
    harness.signal({ _tag: 'delta', frame: delta(2) });
    harness.signal({ _tag: 'delta', frame: delta(3) });
    harness.signal({ _tag: 'delta', frame: delta(4) });
    harness.releaseSnapshot();

    const body = await readFramesUntil(harness.reader, (text) => text.includes('"seq":4'));
    const frames = body.split('\n\n').filter((frame) => frame.length > 0);
    expect(frames).toEqual([
      `event: snapshot\ndata: {"epoch":"${EPOCH}","seq":2,"devices":[${JSON.stringify(DEVICE)}]}`,
      `event: delta\ndata: ${JSON.stringify(delta(3))}`,
      `event: delta\ndata: ${JSON.stringify(delta(4))}`,
    ]);

    harness.abort();
    await harness.reader.cancel();
  });

  test('closes on a sequence gap and on a pub/sub resync so the client reopens', async () => {
    const gapped = createHarness({ since: null, seq: 1 });
    await readUntil(gapped.reader, (text) => text.includes('event: snapshot'));
    gapped.signal({ _tag: 'delta', frame: delta(3) });
    await readUntil(gapped.reader, (_text, done) => done);

    const resync = createHarness({ since: null, seq: 1 });
    await readUntil(resync.reader, (text) => text.includes('event: snapshot'));
    resync.signal({ _tag: 'resync' });
    await readUntil(resync.reader, (_text, done) => done);
  });

  /**
   * The count is the only thing in this process that can say a browser left
   * streams behind: a client that goes away without its request being aborted
   * looks exactly like a quiet one, and the accumulation is otherwise invisible
   * from both ends. It has to be exact in both directions — an undercount hides
   * the leak it exists to show, an overcount invents one.
   */
  test("counts a user's open streams and releases each one exactly once", async () => {
    const user = `census-${crypto.randomUUID()}`;
    expect(openDeviceEventsStreams(user)).toBe(0);

    const first = createHarness({ since: null, seq: 1, userId: user });
    await readUntil(first.reader, (text) => text.includes('event: snapshot'));
    expect(openDeviceEventsStreams(user)).toBe(1);

    const second = createHarness({ since: null, seq: 1, userId: user });
    await readUntil(second.reader, (text) => text.includes('event: snapshot'));
    expect(openDeviceEventsStreams(user)).toBe(2);

    // What a reload does: the request is aborted, and this one goes.
    first.abort();
    await readUntil(first.reader, (_text, done) => done);
    expect(first.closes).toEqual([{ reason: 'client_gone', openForUser: 1 }]);
    expect(openDeviceEventsStreams(user)).toBe(1);

    // A second abort of the same stream is not a second close.
    first.abort();
    expect(first.closes).toHaveLength(1);
    expect(openDeviceEventsStreams(user)).toBe(1);

    second.signal({ _tag: 'resync' });
    await readUntil(second.reader, (_text, done) => done);
    expect(second.closes).toEqual([{ reason: 'resync', openForUser: 0 }]);
    expect(openDeviceEventsStreams(user)).toBe(0);
  });

  test('stops enqueueing for a consumer that stops reading and releases its subscriptions', async () => {
    const harness = createHarness({ since: null, seq: 0 });
    await readUntil(harness.reader, (text) => text.includes('event: snapshot'));
    await harness.presenceReady;
    for (let seq = 1; seq <= 2_000 && harness.closes.length === 0; seq += 1) {
      harness.signal({ _tag: 'delta', frame: delta(seq) });
    }
    expect(harness.closes.map((close) => close.reason)).toEqual(['buffer_overflow']);
    await harness.reader.cancel();
    expect(harness.released).toEqual({ devices: 1, presence: 1 });
    expect(harness.errors).toEqual([]);
    await harness.shutdown();
  });

  test('delivers a snapshot larger than output credit and resumes admission after it drains', async () => {
    const harness = createHarness({
      since: null,
      seq: 0,
      loadSnapshot: async () => Array.from({ length: 500 }, () => DEVICE),
    });
    await harness.presenceReady;
    // Let the snapshot fill the queue without reading the initial padding.
    await Promise.resolve();
    const body = await readUntil(harness.reader, (text) => text.includes('event: snapshot'));
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(64 * 1024);
    expect(harness.closes).toEqual([]);
    harness.signal({ _tag: 'delta', frame: delta(1) });
    expect(await readUntil(harness.reader, (text) => text.includes('event: delta'))).toContain(
      '"seq":1',
    );
    await harness.reader.cancel();
    await harness.shutdown();
  });

  test('consumer cancellation awaits both subscription finalizers', async () => {
    const harness = createHarness({ since: null, seq: 0, holdSnapshot: true });
    await harness.presenceReady;
    await harness.reader.cancel();
    expect(harness.released).toEqual({ devices: 1, presence: 1 });
    expect(harness.closes.map((close) => close.reason)).toEqual(['consumer_cancelled']);
    harness.releaseSnapshot();
    await harness.shutdown();
  });

  test('cancellation remains pending until an asynchronous unsubscribe completes', async () => {
    let finishRelease = (): void => {};
    let releaseStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const harness = createHarness({
      since: null,
      seq: 0,
      deviceRelease: Effect.promise(() => {
        releaseStarted();
        return pending;
      }),
    });
    await harness.presenceReady;
    let cancelled = false;
    const cancellation = harness.reader.cancel().then(() => {
      cancelled = true;
    });
    await started;
    await Promise.resolve();
    expect(cancelled).toBe(false);
    expect(harness.released.devices).toBe(0);
    finishRelease();
    await cancellation;
    expect(harness.released).toEqual({ devices: 1, presence: 1 });
    await harness.shutdown();
  });

  test('runtime shutdown interrupts pending setup and closes the response', async () => {
    const userId = `shutdown-${crypto.randomUUID()}`;
    const harness = createHarness({ since: null, seq: 0, holdSnapshot: true, userId });
    await harness.presenceReady;
    await harness.shutdown();
    await readUntil(harness.reader, (_text, done) => done);
    expect(harness.released).toEqual({ devices: 1, presence: 1 });
    expect(harness.closes.map((close) => close.reason)).toEqual(['server_shutdown']);
    expect(openDeviceEventsStreams(userId)).toBe(0);
    expect(harness.errors).toEqual([]);
    harness.releaseSnapshot();
  });

  test('an already aborted request never acquires subscriptions', async () => {
    const harness = createHarness({ since: null, seq: 0, aborted: true });
    await harness.reader.cancel();
    await harness.shutdown();
    expect(harness.released).toEqual({ devices: 0, presence: 0 });
    expect(harness.closes.map((close) => close.reason)).toEqual(['client_gone']);
    expect(harness.errors).toEqual([]);
  });

  test('closes the stream when a snapshot fails so the client reconnects', async () => {
    const harness = createHarness({
      since: null,
      seq: 1,
      loadSnapshot: async () => {
        throw new Error('temporary database failure');
      },
    });
    await readFramesUntil(harness.reader, (_text, done) => done);
    expect(harness.errors).toHaveLength(1);
    expect(String(harness.errors[0])).toContain('temporary database failure');
  });
});

/**
 * Frames only. Every body opens with the proxy-flush comment, which one test
 * asserts directly; the rest are about what follows it.
 */
async function readFramesUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  complete: (text: string, done: boolean) => boolean,
): Promise<string> {
  const body = await readUntil(reader, (text, done) =>
    complete(stripProxyFlushPadding(text), done),
  );
  return stripProxyFlushPadding(body);
}

function stripProxyFlushPadding(body: string): string {
  const end = body.indexOf('\n\n');
  if (end === -1 || !body.startsWith(':')) return body;
  return body.slice(end + 2);
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  complete: (text: string, done: boolean) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for (let reads = 0; reads < 10; reads += 1) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(1_000).then(() => {
        throw new Error('timed out reading SSE response');
      }),
    ]);
    if (!next.done) text += decoder.decode(next.value, { stream: true });
    if (complete(text, next.done)) return text;
  }
  throw new Error('SSE response did not reach the expected state');
}
