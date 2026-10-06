import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  TEST_DAEMON_BINDING,
  TEST_DAEMON_P256_PUBLIC_KEY,
} from './auth/test-authorization-fixtures';
import { ApiError } from './lib/api-error';
import { clearMainPerfProducer, installMainPerfProducer } from './perf/main-perf-writer';
import { decodePerfEvent } from './perf/perf-event-codec';
import { createPerfRingBuffer, createPerfRingReader } from './perf/perf-ring';
import { createPerfStringResolver, createPerfStringTableBuffer } from './perf/perf-string-table';
import {
  installTerminalPerfRecorder,
  type TerminalPerfEvent,
  uninstallTerminalPerfRecorder,
} from './perf/terminal-latency';
import { createTerminalRingBundle } from './terminal/ring-bundle';
import { createInputRingReader } from './transport/input-ring';
import {
  createTransportSession,
  INPUT_DEFERRED,
  type TerminalSessionCallbacks,
} from './transport-worker-client';
import {
  INPUT_AVAILABLE_EDGE,
  type MainToTransport,
  type RequestSessionResult,
  type TransportHintParams,
  type TransportToMain,
} from './transport-worker-protocol';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const requestResult: RequestSessionResult = {
  daemonId: 'daemon-1',
  daemonIdentityPublicKey: Buffer.alloc(2_592, 9).toString('base64url'),
  daemonIdentityP256PublicKey: TEST_DAEMON_P256_PUBLIC_KEY,
  daemonBinding: TEST_DAEMON_BINDING,
  sessionToken: 'session-token',
  sessionTokenExpiresAtMs: 2_000_000_000_000,
  sessionTokenExpiresInMs: Number.MAX_SAFE_INTEGER,
  sessionId: 'session-id',
  edgeWtUrl: 'https://edge.example.test',
  edgeCertHashes: ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='],
  edgeAttachTicket: 'A'.repeat(35),
};

const SESSION_AUTH_FIELDS = {
  clientNonce: Buffer.alloc(32, 1).toString('base64url'),
  encapsulationKey: Buffer.alloc(1_568, 2).toString('base64url'),
} as const;

const BROWSER_AUTHORIZATION_BRIDGE = {
  renewSession: async () => {
    throw new Error('renewal not requested by this fixture');
  },
  getBrowserAuthorization: () => ({
    userId: 'user-1',
    delegationId: 'delegation-1',
  }),
} as const;

const transportHint: TransportHintParams = {
  profile: 1,
  chunkBytes: 16_384,
  snapshotBytes: 65_536,
};

class FakeWorker {
  static current: FakeWorker | null = null;
  static readonly instances: FakeWorker[] = [];

  readonly messages: MainToTransport[] = [];
  readonly transfers: ReadonlyArray<readonly Transferable[]> = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminateCalls = 0;
  inputWakes = 0;

  constructor() {
    FakeWorker.current = this;
    FakeWorker.instances.push(this);
  }

  postMessage(message: MainToTransport | number, transfer?: readonly Transferable[]): void {
    // The input ring's wake is a bare number, never a message.
    if (typeof message === 'number') {
      if (message !== INPUT_AVAILABLE_EDGE) throw new Error(`unknown numeric edge ${message}`);
      this.inputWakes += 1;
      return;
    }
    this.messages.push(message);
    if (transfer !== undefined) (this.transfers as Array<readonly Transferable[]>).push(transfer);
  }

  emit(message: TransportToMain): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }

  emitError(message: string): void {
    this.onerror?.({
      message,
      preventDefault: () => {},
    } as ErrorEvent);
  }

  emitMessageError(): void {
    this.onmessageerror?.({ data: undefined } as MessageEvent);
  }

  terminate(): void {
    this.terminateCalls += 1;
  }
}

const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(globalThis, name);
    return;
  }
  Object.defineProperty(globalThis, name, descriptor);
}

describe('transport worker client start ownership', () => {
  beforeEach(() => {
    FakeWorker.current = null;
    FakeWorker.instances.length = 0;
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: FakeWorker,
    });
    const eventTarget = new EventTarget();
    const documentTarget = new EventTarget();
    Object.defineProperty(documentTarget, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    // `writable` matters as much as `configurable` here. A data property defined
    // without it is readonly, and other suites in this shard install their own
    // fakes with plain assignment, which throws in strict-mode ESM against a
    // readonly global. Leaving it off makes those suites fail purely on shard
    // ordering, which is what it used to do.
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: eventTarget,
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: documentTarget,
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: {},
    });
  });

  afterEach(() => {
    restoreGlobal('Worker', originalWorker);
    restoreGlobal('window', originalWindow);
    restoreGlobal('document', originalDocument);
    restoreGlobal('navigator', originalNavigator);
    FakeWorker.current = null;
    FakeWorker.instances.length = 0;
  });

  test('worker failure records the pending attempt once and supervises the worker once', async () => {
    const ring = createPerfRingBuffer(32);
    const strings = createPerfStringTableBuffer();
    installMainPerfProducer(ring, strings);
    installTerminalPerfRecorder();
    let failures = 0;
    const session = createTransportSession(
      {
        onConnected: () => {},
        onDisconnected: () => {},
        onMetrics: () => {},
        onWorkerFailure: () => {
          failures += 1;
        },
      },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async () => requestResult,
        cancelSessionRequest: async () => {},
      },
    );
    try {
      const worker = FakeWorker.current;
      if (worker === null) throw new Error('worker missing');
      const started = session.start('daemon-a').catch(() => undefined);
      const start = worker.messages.find((message) => message.kind === 'start');
      if (start?.kind !== 'start') throw new Error('start missing');
      const outcome = {
        ownerId: '11111111-2222-3333-4444-555555555555',
        attemptId: 2,
        carrierId: 3,
        issuanceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        sessionId: '',
        trigger: 'initial',
        phase: 'auth_queued',
        endReason: 'carrier_failed',
        cancellationInitiator: 'none',
        durationMs: 20,
        capabilityRemainingMs: 50000,
        retryIndex: 1,
        backoffDelayMs: 80,
        handshakeAdmissionMs: 0,
        signalingOutcome: 'ready',
        interactiveOutcome: 'ready',
        bulkOutcome: 'ready',
      } as const;
      worker.emit({
        kind: 'recovery_event',
        startId: start.startId,
        outcome,
        ended: false,
        atMs: performance.timeOrigin + performance.now(),
      });
      worker.emitError('crashed');
      worker.emitError('queued duplicate');
      worker.emit({
        kind: 'recovery_event',
        startId: start.startId,
        outcome,
        ended: true,
        atMs: performance.timeOrigin + performance.now(),
      });
      await started;
      const events: TerminalPerfEvent[] = [];
      const resolver = createPerfStringResolver(strings);
      createPerfRingReader(ring).drain((record) => {
        const event = decodePerfEvent(record, resolver);
        if (event !== null && event.kind === 'recovery_outcome') events.push(event);
      });
      expect(failures).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        ownerId: outcome.ownerId,
        attemptId: 2,
        endReason: 'worker_failed',
        cancellationInitiator: 'worker',
        phase: 'auth_queued',
      });
    } finally {
      session.close();
      clearMainPerfProducer();
      uninstallTerminalPerfRecorder();
    }
  });

  test('abandoning an unknown HTTP outcome cancels only its issuance and fences its late response', async () => {
    const pending = deferred<RequestSessionResult>();
    const cancellations: string[] = [];
    const session = createTransportSession(
      { onConnected: () => {}, onDisconnected: () => {}, onMetrics: () => {} },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: () => pending.promise,
        cancelSessionRequest: async (id) => {
          cancellations.push(id);
        },
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('worker missing');
    const started = session.start('daemon-a').catch(() => undefined);
    const start = worker.messages.find((message) => message.kind === 'start');
    if (start?.kind !== 'start') throw new Error('start missing');
    worker.emit({
      kind: 'request_session',
      startId: start.startId,
      requestId: 1,
      daemonId: 'daemon-a',
      browserNodeId: 'owner',
      issuanceId: 'unknown',
      ...SESSION_AUTH_FIELDS,
    });
    window.dispatchEvent(new Event('online'));
    expect(cancellations).toEqual([]);
    worker.emit({ kind: 'abandon_issuance', issuanceId: 'unknown' });
    worker.emit({ kind: 'abandon_issuance', issuanceId: 'unknown' });
    pending.resolve(requestResult);
    await Bun.sleep(0);
    expect(cancellations).toEqual(['unknown']);
    expect(worker.messages.filter((message) => message.kind === 'request_session_result')).toEqual(
      [],
    );
    session.close();
    await started;
    worker.emit({ kind: 'shutdown_complete' });
  });

  test('init hands the worker its wake port, transferred, and the mode main resolved', () => {
    const rings = createTerminalRingBundle('task');
    const session = createTransportSession(
      { onConnected: () => {}, onDisconnected: () => {}, onMetrics: () => {} },
      rings,
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async () => {
          throw new Error('server bridge is not used in this harness');
        },
        cancelSessionRequest: async () => {},
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('transport worker was not created');
    const init = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'init' }> => message.kind === 'init',
    );
    if (init === undefined) throw new Error('init was not posted');
    expect(init.ringWakePort).toBe(rings.transportRingWakePort);
    expect(init.displayRingWakeMode).toBe('task');
    // The port is transferred (it has exactly one owner realm); the SABs are shared.
    expect(worker.transfers).toEqual([[rings.transportRingWakePort]]);
    session.close();
    worker.emit({ kind: 'shutdown_complete' });
  });

  test('direct dial admission survives worker replacement and settles only its own claim', async () => {
    const endpoint = 'https://192.0.2.42:443|test-certificate';
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const session = createTransportSession(
        { onConnected: () => {}, onDisconnected: () => {}, onMetrics: () => {} },
        createTerminalRingBundle('task'),
        {
          ...BROWSER_AUTHORIZATION_BRIDGE,
          requestSession: async () => requestResult,
          cancelSessionRequest: async () => {},
        },
      );
      const worker = FakeWorker.current;
      if (worker === null) throw new Error('worker missing');
      const started = session.start('daemon-a');
      const start = worker.messages.find((message) => message.kind === 'start');
      if (start === undefined || start.kind !== 'start') throw new Error('start missing');
      // The first worker's claim is still in flight when it shuts down: a
      // handshake the page stopped waiting for is spent for this visit.
      worker.emit({ kind: 'direct_dial', startId: start.startId, requestId: 1, endpoint });
      expect(worker.messages.at(-1)).toEqual({
        kind: 'direct_dial_result',
        startId: start.startId,
        requestId: 1,
        allowed: iteration === 0,
      });
      // A settlement from another start cannot release this claim.
      worker.emit({
        kind: 'direct_dial_settle',
        startId: start.startId + 1,
        requestId: 1,
        outcome: 'ready',
      });
      worker.emit({ kind: 'direct_dial', startId: start.startId, requestId: 2, endpoint });
      expect(worker.messages.at(-1)).toEqual({
        kind: 'direct_dial_result',
        startId: start.startId,
        requestId: 2,
        allowed: false,
      });
      const successfulEndpoint = endpoint + iteration;
      worker.emit({
        kind: 'direct_dial',
        startId: start.startId,
        requestId: 3,
        endpoint: successfulEndpoint,
      });
      worker.emit({
        kind: 'direct_dial_settle',
        startId: start.startId,
        requestId: 3,
        outcome: 'ready',
      });
      worker.emit({
        kind: 'direct_dial',
        startId: start.startId,
        requestId: 4,
        endpoint: successfulEndpoint,
      });
      expect(worker.messages.at(-1)).toEqual({
        kind: 'direct_dial_result',
        startId: start.startId,
        requestId: 4,
        allowed: true,
      });
      worker.emit({
        kind: 'connected',
        startId: start.startId,
        preserveDisplay: false,
        displayRingFenceToken: 3,
        sessionId: 'session-1',
      });
      await started;
      session.close();
      worker.emit({ kind: 'shutdown_complete' });
    }
  });

  test('issuance and renewal preserve final authorization denial without promoting transient failures', async () => {
    let failure: Error = new ApiError(403, 'forbidden');
    const session = createTransportSession(
      { onConnected: () => {}, onDisconnected: () => {}, onMetrics: () => {} },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async () => {
          throw failure;
        },
        renewSession: async () => {
          throw failure;
        },
        cancelSessionRequest: async () => {},
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('worker missing');
    const started = session.start('daemon-a');
    const start = worker.messages.find((message) => message.kind === 'start');
    if (start?.kind !== 'start') throw new Error('start missing');
    worker.emit({
      kind: 'connected',
      startId: start.startId,
      preserveDisplay: false,
      displayRingFenceToken: 3,
      sessionId: 'session-1',
    });
    await started;
    for (const [index, [error, errorCode]] of (
      [
        [new ApiError(403, 'forbidden'), 'authorization_rejected'],
        [new ApiError(401, 'unauthorized'), 'authorization_rejected'],
        [new ApiError(404, 'device_not_found'), 'daemon_unlinked'],
        [new ApiError(400, 'invalid_request'), 'request_rejected'],
        [new ApiError(200, 'invalid_session_response'), 'invalid_session_response'],
        [new ApiError(409, 'session_issuance_conflict'), 'session_issuance_conflict'],
        [new ApiError(408, 'unavailable'), undefined],
        [new ApiError(429, 'unavailable'), undefined],
        [new ApiError(503, 'unavailable'), undefined],
        [new Error('network interrupted'), undefined],
      ] as const
    ).entries()) {
      failure = error;
      const requestId = index + 1;
      worker.emit({
        kind: 'request_session',
        startId: start.startId,
        requestId,
        daemonId: 'daemon-a',
        browserNodeId: 'browser-a',
        issuanceId: `issuance-${index}`,
        ...SESSION_AUTH_FIELDS,
      });
      worker.emit({
        kind: 'renew_session',
        startId: start.startId,
        requestId,
        daemonId: 'daemon-a',
        browserNodeId: 'browser-a',
        sessionId: 'session-1',
        commitment: Buffer.alloc(64, 3).toString('base64url'),
        edgeWtUrl: 'https://edge.example:4433/',
      });
      await Bun.sleep(0);
      const replies = worker.messages.filter(
        (message) =>
          (message.kind === 'request_session_result' || message.kind === 'renew_session_result') &&
          message.requestId === requestId,
      );
      expect(replies).toHaveLength(2);
      for (const reply of replies) {
        expect('errorCode' in reply ? reply.errorCode : undefined).toBe(errorCode);
      }
    }
    session.close();
    worker.emit({ kind: 'shutdown_complete' });
  });

  test("only the active start's committed carrier moves the page's network visit", async () => {
    const endpoint = 'https://192.0.2.43:443|test-certificate';
    const session = createTransportSession(
      { onConnected: () => {}, onDisconnected: () => {}, onMetrics: () => {} },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async () => requestResult,
        cancelSessionRequest: async () => {},
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('worker missing');
    const started = session.start('daemon-a');
    const start = worker.messages.find((message) => message.kind === 'start');
    if (start === undefined || start.kind !== 'start') throw new Error('start missing');
    const dial = (requestId: number): unknown => {
      worker.emit({ kind: 'direct_dial', startId: start.startId, requestId, endpoint });
      return worker.messages.at(-1);
    };
    worker.emit({ kind: 'observed_path', startId: start.startId, address: '198.51.100.7' });
    dial(1);
    worker.emit({
      kind: 'direct_dial_settle',
      startId: start.startId,
      requestId: 1,
      outcome: 'failed',
    });
    expect(dial(2)).toMatchObject({ allowed: false });
    // Another start's carrier is not this page's network.
    worker.emit({ kind: 'observed_path', startId: start.startId + 1, address: '203.0.113.9' });
    expect(dial(3)).toMatchObject({ allowed: false });
    // The active carrier proved another address: nothing has failed there.
    worker.emit({ kind: 'observed_path', startId: start.startId, address: '203.0.113.9' });
    expect(dial(4)).toMatchObject({ allowed: true });
    worker.emit({
      kind: 'connected',
      startId: start.startId,
      preserveDisplay: false,
      displayRingFenceToken: 3,
      sessionId: 'session-1',
    });
    await started;
    session.close();
    worker.emit({ kind: 'shutdown_complete' });
  });

  test("'native': a keystroke posts no task wake at all", async () => {
    const rings = createTerminalRingBundle('native');
    const session = createTransportSession(
      { onConnected: () => {}, onDisconnected: () => {}, onMetrics: () => {} },
      rings,
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async () => {
          throw new Error('server bridge is not used in this harness');
        },
        cancelSessionRequest: async () => {},
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('transport worker was not created');
    const start = session.start('daemon-a');
    const startMessage = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> => message.kind === 'start',
    );
    if (startMessage === undefined) throw new Error('start was not posted');
    worker.emit({ kind: 'input_ready', startId: startMessage.startId });
    expect(session.sendKeystroke(Uint8Array.of(0x61))).toBe(1);
    expect(session.sendKeystroke(Uint8Array.of(0x62))).toBe(2);
    expect(worker.inputWakes).toBe(0);

    worker.emit({
      kind: 'connected',
      startId: startMessage.startId,
      preserveDisplay: false,
      displayRingFenceToken: 3,
      sessionId: 'session-1',
    });
    await start;
    session.close();
    worker.emit({ kind: 'shutdown_complete' });
  });

  test("'task': deferred input posts nothing until an awaited input or a release carries it", async () => {
    const rings = createTerminalRingBundle('task');
    const session = createTransportSession(
      { onConnected: () => {}, onDisconnected: () => {}, onMetrics: () => {} },
      rings,
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async () => {
          throw new Error('server bridge is not used in this harness');
        },
        cancelSessionRequest: async () => {},
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('transport worker was not created');
    const start = session.start('daemon-a');
    const startMessage = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> => message.kind === 'start',
    );
    if (startMessage === undefined) throw new Error('start was not posted');
    worker.emit({ kind: 'input_ready', startId: startMessage.startId });
    const wakes = (): number => worker.inputWakes;
    const reader = createInputRingReader(rings.inputRing);
    const sendDeferred = (): number | null =>
      session.sendKeystroke(Uint8Array.of(0x40), undefined, undefined, INPUT_DEFERRED);

    expect(sendDeferred()).toBe(1);
    expect(wakes()).toBe(0);
    expect(reader.tryReadNext()).toBe(-1);
    // The next awaited input carries it: one wake, both entries, in order.
    expect(session.sendKeystroke(Uint8Array.of(0x61))).toBe(2);
    expect(wakes()).toBe(1);
    expect(reader.localSeq(reader.tryReadNext())).toBe(1);
    expect(reader.localSeq(reader.tryReadNext())).toBe(2);

    expect(sendDeferred()).toBe(3);
    expect(reader.tryReadNext()).toBe(-1);
    session.releaseDeferredInput();
    expect(wakes()).toBe(2);
    expect(reader.localSeq(reader.tryReadNext())).toBe(3);
    // Nothing held: a release is free.
    session.releaseDeferredInput();
    expect(wakes()).toBe(2);

    worker.emit({
      kind: 'connected',
      startId: startMessage.startId,
      preserveDisplay: false,
      displayRingFenceToken: 3,
      sessionId: 'session-1',
    });
    await start;
    session.close();
    worker.emit({ kind: 'shutdown_complete' });
  });

  test("'task': posts one level-triggered input wake per empty→nonempty edge, and recovery re-releases every pump", async () => {
    let recoveries = 0;
    const connectedEpochs: Array<[boolean, number]> = [];
    const rings = createTerminalRingBundle('task');
    const session = createTransportSession(
      {
        onConnected: (preserveDisplay, displayRingFenceToken) => {
          connectedEpochs.push([preserveDisplay, displayRingFenceToken]);
        },
        onDisconnected: () => {},
        onMetrics: () => {},
        onRecoverDisplayReader: () => {
          recoveries += 1;
        },
      },
      rings,
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async () => {
          throw new Error('server bridge is not used in this harness');
        },
        cancelSessionRequest: async () => {},
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('transport worker was not created');

    const start = session.start('daemon-a');
    const startMessage = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> => message.kind === 'start',
    );
    if (startMessage === undefined) throw new Error('start was not posted');
    expect(session.sendKeystroke(Uint8Array.of(0x60))).toBeNull();
    expect(worker.inputWakes).toBe(0);

    worker.emit({ kind: 'input_ready', startId: startMessage.startId });
    expect(session.sendKeystroke(Uint8Array.of(0x61))).toBe(1);
    expect(session.sendKeystroke(Uint8Array.of(0x62))).toBe(2);
    expect(worker.inputWakes).toBe(1);

    const reader = createInputRingReader(rings.inputRing);
    expect(reader.tryReadNext()).toBe(0);
    expect(reader.tryReadNext()).toBe(1);
    // Reading both is what parks the consumer; the daemon's acknowledgement
    // (releasing the slots) is not what the next keystroke's edge waits on.
    expect(session.sendKeystroke(Uint8Array.of(0x63))).toBe(3);
    expect(worker.inputWakes).toBe(2);

    // Resume recovery: both task hints beside the native notifies, and the
    // terminal worker's reader re-released through main exactly once. No
    // per-frame or per-ACK edge exists on this channel to count.
    session.notifyResumed();
    expect(worker.inputWakes).toBe(3);
    expect(recoveries).toBe(1);

    worker.emit({
      kind: 'connected',
      startId: startMessage.startId,
      preserveDisplay: false,
      displayRingFenceToken: 3,
      sessionId: 'session-1',
    });
    await start;
    expect(connectedEpochs).toEqual([[false, 3]]);
    session.close();
    worker.emit({ kind: 'shutdown_complete' });
  });

  test('B settles while superseded A rejects and late A events cannot mutate B', async () => {
    const connected: string[] = [];
    const disconnected: string[] = [];
    const callbacks: TerminalSessionCallbacks = {
      onConnected: () => connected.push('connected'),
      onDisconnected: (reason) => disconnected.push(reason),
      onMetrics: () => {},
    };
    const session = createTransportSession(callbacks, createTerminalRingBundle('task'), {
      ...BROWSER_AUTHORIZATION_BRIDGE,
      requestSession: async () => {
        throw new Error('server bridge is not used in this harness');
      },
      cancelSessionRequest: async () => {},
    });
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('transport worker was not created');

    const firstStart = session.start('daemon-a');
    const firstOutcome = firstStart.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const firstMessage = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> =>
        message.kind === 'start' && message.daemonId === 'daemon-a',
    );
    if (firstMessage === undefined) throw new Error('first start was not posted');

    const secondStart = session.start('daemon-b');
    const secondMessage = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> =>
        message.kind === 'start' && message.daemonId === 'daemon-b',
    );
    if (secondMessage === undefined) throw new Error('second start was not posted');

    expect(secondMessage.startId).not.toBe(firstMessage.startId);
    expect(await firstOutcome).toBe('Session start superseded by a newer start');
    expect(session.sendKeystroke(Uint8Array.of(0x61))).toBeNull();
    worker.emit({ kind: 'input_ready', startId: firstMessage.startId });
    expect(session.sendKeystroke(Uint8Array.of(0x61))).toBeNull();
    worker.emit({ kind: 'input_ready', startId: secondMessage.startId });
    expect(session.sendKeystroke(Uint8Array.of(0x62))).toBe(1);

    worker.emit({
      kind: 'connected',
      startId: secondMessage.startId,
      preserveDisplay: false,
      displayRingFenceToken: 5,
      sessionId: 'session-1',
    });
    await secondStart;
    const offActivity = session.onTransportActivity(() => {}, 34);
    worker.emit({
      kind: 'link_tick',
      startId: secondMessage.startId,
      txBytes: 10,
      rxBytes: 20,
      subscriptionId: 1,
      sequence: 1,
      tick: 0,
      buckets: new Float64Array(128),
    });

    // A completes after B is already live. Every event in A's old lineage is
    // ignored: it cannot resolve B twice, close it, overwrite its metrics, or
    // notify application callbacks.
    worker.emit({
      kind: 'connected',
      startId: firstMessage.startId,
      preserveDisplay: false,
      displayRingFenceToken: 3,
      sessionId: 'session-1',
    });
    worker.emit({
      kind: 'link_tick',
      startId: firstMessage.startId,
      txBytes: 999,
      rxBytes: 999,
      subscriptionId: 1,
      sequence: 1,
      tick: 0,
      buckets: new Float64Array(128),
    });
    worker.emit({
      kind: 'disconnected',
      startId: firstMessage.startId,
      reason: 'late-a',
    });

    expect(connected).toEqual(['connected']);
    expect(disconnected).toEqual([]);
    expect(session.getConnectionQuality().state).toBe('ready');
    expect(session.getThroughput()).toEqual({ txBytes: 10, rxBytes: 20 });
    offActivity();

    session.close();
    worker.emit({ kind: 'shutdown_complete' });
    expect(worker.terminateCalls).toBe(1);
  });

  test('a current disconnect closes SAB input admission until a new start is fenced', async () => {
    const session = createTransportSession(
      {
        onConnected: () => {},
        onDisconnected: () => {},
        onMetrics: () => {},
      },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async () => {
          throw new Error('server bridge is not used in this harness');
        },
        cancelSessionRequest: async () => {},
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('transport worker was not created');

    const start = session.start('daemon-a');
    const startMessage = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> => message.kind === 'start',
    );
    if (startMessage === undefined) throw new Error('start was not posted');
    worker.emit({ kind: 'input_ready', startId: startMessage.startId });
    expect(session.sendKeystroke(Uint8Array.of(0x61))).toBe(1);

    const startOutcome = start.catch((error: unknown) => String(error));
    worker.emit({
      kind: 'disconnected',
      startId: startMessage.startId,
      reason: 'edge-failed',
    });
    await startOutcome;
    expect(session.sendKeystroke(Uint8Array.of(0x62))).toBeNull();

    session.close();
    worker.emit({ kind: 'shutdown_complete' });
  });

  test('aborting a start fences the worker and permits a clean replacement', async () => {
    const session = createTransportSession(
      {
        onConnected: () => {},
        onDisconnected: () => {},
        onMetrics: () => {},
      },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async () => {
          throw new Error('server bridge is not used in this harness');
        },
        cancelSessionRequest: async () => {},
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('transport worker was not created');

    const controller = new AbortController();
    const firstStart = session.start('daemon-a', controller.signal);
    const firstStartMessage = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> => message.kind === 'start',
    );
    if (firstStartMessage === undefined) throw new Error('first start was not posted');

    controller.abort(new Error('reconnect attempt timed out'));
    await expect(firstStart).rejects.toThrow('reconnect attempt timed out');
    expect(worker.messages).toContainEqual({ kind: 'stop_session', preserveInput: true });

    const replacement = session.start('daemon-a');
    const replacementMessage = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> =>
        message.kind === 'start' && message.startId !== firstStartMessage.startId,
    );
    if (replacementMessage === undefined) throw new Error('replacement start was not posted');
    worker.emit({
      kind: 'connected',
      startId: replacementMessage.startId,
      preserveDisplay: false,
      displayRingFenceToken: 3,
      sessionId: 'session-1',
    });
    await replacement;

    session.close();
    worker.emit({ kind: 'shutdown_complete' });
  });

  test('a stranded session request is interrupted and returned as a bounded failure', async () => {
    const requestSignal: { current: AbortSignal | null } = { current: null };
    const session = createTransportSession(
      {
        onConnected: () => {},
        onDisconnected: () => {},
        onMetrics: () => {},
      },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async (
          _daemonId,
          _browserNodeId,
          _issuanceId,
          _supersedesIssuanceId,
          _clientNonce,
          _encapsulationKey,
          signal,
        ) => {
          requestSignal.current = signal;
          return new Promise<RequestSessionResult>(() => undefined);
        },
        cancelSessionRequest: async () => {},
      },
      { sessionRequestTimeoutMs: 10 },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('transport worker was not created');

    const start = session.start('daemon-a');
    const startOutcome = start.catch((error: unknown) => String(error));
    const startMessage = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> => message.kind === 'start',
    );
    if (startMessage === undefined) throw new Error('start was not posted');

    worker.emit({
      kind: 'request_session',
      startId: startMessage.startId,
      requestId: 9,
      daemonId: 'daemon-a',
      browserNodeId: 'browser-a',
      issuanceId: 'issuance-a',
      ...SESSION_AUTH_FIELDS,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(requestSignal.current?.aborted).toBe(true);
    expect(worker.messages).toContainEqual({
      kind: 'request_session_result',
      startId: startMessage.startId,
      requestId: 9,
      error: 'Error: Session request timed out after 10 ms',
    });

    session.close();
    expect(await startOutcome).toBe('Error: Session closed');
    worker.emit({ kind: 'shutdown_complete' });
  });

  test('a worker crash rejects only its owned start and shuts the worker down once', async () => {
    const disconnected: string[] = [];
    const cancelledIssuanceIds: string[] = [];
    const pendingRequest = deferred<RequestSessionResult>();
    const session = createTransportSession(
      {
        onConnected: () => {},
        onDisconnected: (reason) => disconnected.push(reason),
        onMetrics: () => {},
      },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: () => pendingRequest.promise,
        cancelSessionRequest: async (issuanceId) => {
          cancelledIssuanceIds.push(issuanceId);
        },
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('transport worker was not created');

    const start = session.start('daemon-a');
    const startMessage = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> => message.kind === 'start',
    );
    if (startMessage === undefined) throw new Error('start was not posted');
    worker.emit({
      kind: 'request_session',
      startId: startMessage.startId,
      requestId: 1,
      daemonId: 'daemon-a',
      browserNodeId: 'browser-a',
      issuanceId: 'issuance-crashed-worker',
      ...SESSION_AUTH_FIELDS,
    });
    worker.emitError('boom');

    expect(await start.catch((error: unknown) => String(error))).toBe(
      'Error: Transport worker crashed: boom',
    );
    expect(disconnected).toEqual(['Transport worker crashed: boom']);
    expect(session.getConnectionQuality().state).toBe('closed');
    expect(session.sendKeystroke(Uint8Array.of(0x61))).toBeNull();
    expect(worker.terminateCalls).toBe(1);
    await Promise.resolve();
    expect(cancelledIssuanceIds).toEqual(['issuance-crashed-worker']);

    // Duplicate fatal events and close() are stale after the first ownership
    // revocation. They cannot notify or terminate a replacement twice.
    worker.emitMessageError();
    session.close();
    expect(disconnected).toEqual(['Transport worker crashed: boom']);
    expect(worker.terminateCalls).toBe(1);
    expect(await session.start('daemon-b').catch((error: unknown) => String(error))).toBe(
      'Error: Transport worker crashed: boom',
    );
  });

  test('reissuance and page events never cancel a live session; close abandons only unfinished requests', async () => {
    const cancelled: string[] = [];
    const session = createTransportSession(
      { onConnected: () => {}, onDisconnected: () => {}, onMetrics: () => {} },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async (_daemon, _browser, issuanceId) => ({
          ...requestResult,
          sessionId: `session-${issuanceId}`,
        }),
        cancelSessionRequest: async (issuanceId) => {
          cancelled.push(issuanceId);
        },
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('worker missing');
    const started = session.start('daemon-a');
    const start = worker.messages.find((message) => message.kind === 'start');
    if (start?.kind !== 'start') throw new Error('start missing');
    for (const [requestId, issuanceId, supersedesIssuanceId] of [
      [1, 'first', undefined],
      [2, 'second', 'first'],
    ] as const) {
      worker.emit({
        kind: 'request_session',
        startId: start.startId,
        requestId,
        daemonId: 'daemon-a',
        browserNodeId: 'browser-a',
        issuanceId,
        ...(supersedesIssuanceId === undefined ? {} : { supersedesIssuanceId }),
        ...SESSION_AUTH_FIELDS,
      });
      await Bun.sleep(0);
      // The supersede completion used to arm cancellation of the new issuance.
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      worker.emit({
        kind: 'connected',
        startId: start.startId,
        preserveDisplay: false,
        displayRingFenceToken: requestId * 2 - 1,
        sessionId: `session-${issuanceId}`,
      });
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      await Bun.sleep(0);
      expect(cancelled).toEqual([]);
    }
    await started;
    worker.emit({
      kind: 'request_session',
      startId: start.startId,
      requestId: 3,
      daemonId: 'daemon-a',
      browserNodeId: 'browser-a',
      issuanceId: 'unfinished',
      ...SESSION_AUTH_FIELDS,
    });
    session.close();
    await Bun.sleep(0);
    expect(cancelled).toEqual(['unfinished']);
    worker.emit({ kind: 'shutdown_complete' });
  });

  test('a failed cancellation is retained and reoffered on the next online event', async () => {
    let cancellationAttempts = 0;
    const session = createTransportSession(
      {
        onConnected: () => {},
        onDisconnected: () => {},
        onMetrics: () => {},
      },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: () => new Promise<RequestSessionResult>(() => undefined),
        cancelSessionRequest: async (issuanceId) => {
          expect(issuanceId).toBe('issuance-offline-close');
          cancellationAttempts += 1;
          if (cancellationAttempts === 1) throw new Error('offline');
        },
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('transport worker was not created');
    const startOutcome = session.start('daemon-a').catch(() => undefined);
    const startMessage = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> => message.kind === 'start',
    );
    if (startMessage === undefined) throw new Error('start was not posted');
    worker.emit({
      kind: 'request_session',
      startId: startMessage.startId,
      requestId: 1,
      daemonId: 'daemon-a',
      browserNodeId: 'browser-a',
      issuanceId: 'issuance-offline-close',
      ...SESSION_AUTH_FIELDS,
    });

    session.close();
    await startOutcome;
    await Bun.sleep(0);
    expect(cancellationAttempts).toBe(1);

    window.dispatchEvent(new Event('online'));
    await Bun.sleep(0);
    expect(cancellationAttempts).toBe(2);

    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
    expect(cancellationAttempts).toBe(2);
    worker.emit({ kind: 'shutdown_complete' });
  });

  test('a queued error from a closed worker cannot touch its replacement session', async () => {
    const oldDisconnected: string[] = [];
    const newConnected: string[] = [];
    const oldSession = createTransportSession(
      {
        onConnected: () => {},
        onDisconnected: (reason) => oldDisconnected.push(reason),
        onMetrics: () => {},
      },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async () => {
          throw new Error('server bridge is not used in this harness');
        },
        cancelSessionRequest: async () => {},
      },
    );
    const oldWorker = FakeWorker.current;
    if (oldWorker === null) throw new Error('old transport worker was not created');
    const oldStart = oldSession.start('daemon-old').catch((error: unknown) => String(error));
    oldSession.close();

    const replacement = createTransportSession(
      {
        onConnected: () => newConnected.push('connected'),
        onDisconnected: () => {
          throw new Error('replacement must not be disconnected by the old worker');
        },
        onMetrics: () => {},
      },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async () => {
          throw new Error('server bridge is not used in this harness');
        },
        cancelSessionRequest: async () => {},
      },
    );
    const replacementWorker = FakeWorker.current;
    if (replacementWorker === null || replacementWorker === oldWorker) {
      throw new Error('replacement transport worker was not created');
    }
    const replacementStart = replacement.start('daemon-new');
    const replacementStartMessage = replacementWorker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> => message.kind === 'start',
    );
    if (replacementStartMessage === undefined) throw new Error('replacement start was not posted');

    // This event was already queued by the old Worker before close(). Its
    // callback still runs, but the old session has revoked all ownership.
    oldWorker.emitError('late-old-worker-error');
    replacementWorker.emit({
      kind: 'connected',
      startId: replacementStartMessage.startId,
      preserveDisplay: false,
      displayRingFenceToken: 3,
      sessionId: 'session-1',
    });

    expect(await oldStart).toBe('Error: Session closed');
    await replacementStart;
    expect(oldDisconnected).toEqual([]);
    expect(newConnected).toEqual(['connected']);
    expect(oldWorker.terminateCalls).toBe(1);
    expect(replacementWorker.terminateCalls).toBe(0);
    expect(replacement.getConnectionQuality().state).toBe('ready');

    replacement.close();
    replacementWorker.emit({ kind: 'shutdown_complete' });
  });

  test('a superseded session RPC is aborted and cannot publish into its replacement start', async () => {
    const cancelledIssuanceIds: string[] = [];
    const requests: Array<{
      readonly daemonId: string;
      readonly signal: AbortSignal;
      readonly result: Deferred<RequestSessionResult>;
    }> = [];
    const session = createTransportSession(
      {
        onConnected: () => {},
        onDisconnected: () => {},
        onMetrics: () => {},
      },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: (
          daemonId,
          _browserNodeId,
          _issuanceId,
          _supersedesIssuanceId,
          _clientNonce,
          _encapsulationKey,
          signal,
        ) => {
          const result = deferred<RequestSessionResult>();
          requests.push({ daemonId, signal, result });
          return result.promise;
        },
        cancelSessionRequest: async (issuanceId) => {
          cancelledIssuanceIds.push(issuanceId);
        },
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('transport worker was not created');

    const firstStart = session.start('daemon-a').catch((error: unknown) => String(error));
    const firstMessage = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> =>
        message.kind === 'start' && message.daemonId === 'daemon-a',
    );
    if (firstMessage === undefined) throw new Error('first start was not posted');

    worker.emit({
      kind: 'request_session',
      startId: firstMessage.startId,
      requestId: 77,
      daemonId: 'daemon-a',
      browserNodeId: 'browser-a',
      issuanceId: 'issuance-a',
      ...SESSION_AUTH_FIELDS,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal.aborted).toBe(false);

    const secondStart = session.start('daemon-b');
    const secondMessage = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> =>
        message.kind === 'start' && message.daemonId === 'daemon-b',
    );
    if (secondMessage === undefined) throw new Error('second start was not posted');

    expect(await firstStart).toBe('Error: Session start superseded by a newer start');
    expect(requests[0]?.signal.aborted).toBe(true);

    // A request event already queued by the superseded worker start has no
    // authority to perform another server-side session mutation.
    worker.emit({
      kind: 'request_session',
      startId: firstMessage.startId,
      requestId: 78,
      daemonId: 'daemon-a-late',
      browserNodeId: 'browser-a',
      issuanceId: 'issuance-a',
      ...SESSION_AUTH_FIELDS,
    });
    expect(requests).toHaveLength(1);

    requests[0]?.result.resolve(requestResult);
    await Promise.resolve();
    expect(
      worker.messages.some(
        (message) =>
          message.kind === 'request_session_result' && message.startId === firstMessage.startId,
      ),
    ).toBe(false);

    worker.emit({
      kind: 'request_session',
      startId: secondMessage.startId,
      requestId: 1,
      daemonId: 'daemon-b',
      browserNodeId: 'browser-b',
      issuanceId: 'issuance-b',
      supersedesIssuanceId: 'issuance-a',
      ...SESSION_AUTH_FIELDS,
    });
    expect(requests).toHaveLength(2);
    requests[1]?.result.resolve(requestResult);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      worker.messages.filter(
        (message) =>
          message.kind === 'request_session_result' &&
          message.startId === secondMessage.startId &&
          message.requestId === 1,
      ),
    ).toEqual([
      {
        kind: 'request_session_result',
        startId: secondMessage.startId,
        requestId: 1,
        result: requestResult,
      },
    ]);

    worker.emit({
      kind: 'connected',
      startId: secondMessage.startId,
      preserveDisplay: false,
      displayRingFenceToken: 3,
      sessionId: 'session-1',
    });
    await secondStart;
    session.close();
    await Promise.resolve();
    expect(cancelledIssuanceIds).toEqual(['issuance-b']);
    worker.emit({ kind: 'shutdown_complete' });
  });

  test('equal network hints reach worker-local cadence and receive-depth deduplication', async () => {
    const session = createTransportSession(
      {
        onConnected: () => {},
        onDisconnected: () => {},
        onMetrics: () => {},
      },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async () => requestResult,
        cancelSessionRequest: async () => {},
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('transport worker was not created');

    const firstStart = session.start('daemon-a').catch((error: unknown) => String(error));
    session.sendTransportHint(transportHint);
    session.sendTransportHint(transportHint);
    expect(worker.messages.filter((message) => message.kind === 'transport_hint')).toHaveLength(2);

    const secondStart = session.start('daemon-b').catch((error: unknown) => String(error));
    expect(await firstStart).toBe('Error: Session start superseded by a newer start');
    session.sendTransportHint(transportHint);
    session.sendTransportHint(transportHint);
    expect(worker.messages.filter((message) => message.kind === 'transport_hint')).toHaveLength(4);

    session.close();
    worker.emit({ kind: 'shutdown_complete' });
    expect(await secondStart).toBe('Error: Session closed');
  });

  test('resume evidence only forwards hints to the existing worker', () => {
    const session = createTransportSession(
      {
        onConnected: () => {},
        onDisconnected: () => {},
        onMetrics: () => {},
      },
      createTerminalRingBundle('task'),
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async () => requestResult,
        cancelSessionRequest: async () => {},
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('transport worker was not created');

    session.notifyResumed();
    session.notifyResumed();

    expect(worker.messages.filter((message) => message.kind === 'stop_session')).toHaveLength(0);
    expect(
      worker.messages.filter(
        (message) => message.kind === 'hint' && message.hint === 'visibility_resume',
      ),
    ).toHaveLength(2);

    session.close();
    worker.emit({ kind: 'shutdown_complete' });
  });

  test('visible subscriptions own publications; keystrokes and quality never duplicate activity', async () => {
    const rings = createTerminalRingBundle('task');
    const session = createTransportSession(
      {
        onConnected: () => {},
        onDisconnected: () => {},
        onMetrics: () => {},
      },
      rings,
      {
        ...BROWSER_AUTHORIZATION_BRIDGE,
        requestSession: async () => {
          throw new Error('server bridge is not used in this harness');
        },
        cancelSessionRequest: async () => {},
      },
    );
    const worker = FakeWorker.current;
    if (worker === null) throw new Error('transport worker was not created');
    const start = session.start('daemon-a');
    const startMessage = worker.messages.find(
      (message): message is Extract<MainToTransport, { kind: 'start' }> => message.kind === 'start',
    );
    if (startMessage === undefined) throw new Error('start was not posted');
    worker.emit({ kind: 'input_ready', startId: startMessage.startId });

    let first = 0;
    let second = 0;
    const offFirst = session.onTransportActivity(() => {
      first += 1;
    }, 34);
    // No wider than the first: the worker's horizon is unchanged, so no new subscription.
    const offSecond = session.onTransportActivity(() => {
      second += 1;
    }, 20);
    expect(worker.messages.filter((m) => m.kind === 'observe_link')).toEqual([
      { kind: 'observe_link', subscriptionId: 1, enabled: true, columns: 34 },
    ]);
    expect(session.sendKeystroke(Uint8Array.of(0x61))).toBe(1);
    expect(first).toBe(0);
    expect(second).toBe(0);
    const tick = {
      kind: 'link_tick',
      startId: startMessage.startId,
      subscriptionId: 1,
      sequence: 1,
      tick: 0,
      buckets: new Float64Array(128),
      txBytes: 10,
      rxBytes: 20,
    } as const;
    worker.emit(tick);
    expect(first).toBe(1);
    expect(second).toBe(1);
    offFirst();
    offFirst();
    // The narrower strip now owns the subscription; deliveries carry its id.
    worker.emit({ ...tick, subscriptionId: 2, sequence: 2 });
    expect(first).toBe(1);
    expect(second).toBe(2);
    let qualityChanges = 0;
    const offQuality = session.onConnectionQualityChange(() => {
      qualityChanges += 1;
    });
    worker.emit({
      kind: 'metrics',
      startId: startMessage.startId,
      rttMs: 37,
      networkRttMs: 30,
      pathType: 'direct',
      availableOutgoingBitrateMbps: null,
      inputAckRttMs: 40,
      inputAckMs: 41,
      inputAckSeq: 3,
      resyncCount: 0,
      txBytes: 30,
      rxBytes: 40,
      degraded: false,
      linkState: 'ready',
    });
    expect(qualityChanges).toBe(1);
    expect(second).toBe(2);
    offSecond();
    offSecond();
    worker.emit({ ...tick, subscriptionId: 2, sequence: 3 });
    expect(second).toBe(2);
    expect(worker.messages.filter((m) => m.kind === 'link_tick_ack')).toHaveLength(2);
    expect(worker.messages.filter((m) => m.kind === 'observe_link')).toEqual([
      { kind: 'observe_link', subscriptionId: 1, enabled: true, columns: 34 },
      // The widest observer leaving narrows the horizon to the one that stayed.
      { kind: 'observe_link', subscriptionId: 2, enabled: true, columns: 20 },
      { kind: 'observe_link', subscriptionId: 3, enabled: false, columns: 0 },
    ]);
    const offResumed = session.onTransportActivity(() => {
      second += 1;
    }, 34);
    worker.emit({ ...tick, sequence: 4 }); // Previous visibility owner is stale.
    expect(second).toBe(2);
    worker.emit({ ...tick, subscriptionId: 4, sequence: 5, txBytes: 1000 });
    expect(second).toBe(3);
    expect(session.getThroughput().txBytes).toBe(1000);
    offResumed();
    offQuality();
    expect(session.sendKeystroke(Uint8Array.of(0x62))).toBe(2);
    expect(worker.inputWakes).toBe(1);

    worker.emit({
      kind: 'connected',
      startId: startMessage.startId,
      preserveDisplay: false,
      displayRingFenceToken: 3,
      sessionId: 'session-1',
    });
    await start;
    session.close();
    worker.emit({ kind: 'shutdown_complete' });
  });
});
