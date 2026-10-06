import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installTerminalPerfRecorder } from './perf/terminal-latency';
import { createTelemetryWorkerClient } from './telemetry-worker-client';
import type {
  TelemetryWorkerCommand,
  TelemetryWorkerDrainStatus,
} from './telemetry-worker-protocol';
import { createTerminalRingBundle } from './terminal/ring-bundle';

class FakeWorker {
  static current: FakeWorker | null = null;

  readonly messages: TelemetryWorkerCommand[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  constructor() {
    FakeWorker.current = this;
  }

  postMessage(message: TelemetryWorkerCommand): void {
    this.messages.push(message);
  }

  emitError(message: string): void {
    this.onerror?.({ message, preventDefault: () => {} } as ErrorEvent);
  }

  emitMessageError(): void {
    this.onmessageerror?.({ data: undefined } as MessageEvent);
  }
}

const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
const activeClients: ReturnType<typeof createTelemetryWorkerClient>[] = [];

function createClient(flushMainThreadObservations = () => {}) {
  const client = createTelemetryWorkerClient({
    rings: createTerminalRingBundle('native'),
    origin: 'https://example.test',
    accessToken: 'token',
    byteBudget: 1_024,
    flushMainThreadObservations,
  });
  activeClients.push(client);
  return client;
}

function activeWorker(): FakeWorker {
  const worker = FakeWorker.current;
  if (worker === null) throw new Error('telemetry worker was not created');
  return worker;
}

describe('telemetry worker client failure surfacing', () => {
  beforeEach(() => {
    FakeWorker.current = null;
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  });

  afterEach(() => {
    for (const client of activeClients.splice(0)) client.stop();
    if (originalWorker === undefined) Reflect.deleteProperty(globalThis, 'Worker');
    else Object.defineProperty(globalThis, 'Worker', originalWorker);
  });

  // The regression this file exists for: the worker used to die on its first
  // drain with no handler anywhere, so `dump()` stayed pending forever and the
  // only visible symptom was a caller that never resumed.
  test('a crashed worker rejects the pending dump instead of hanging', async () => {
    const client = createClient();
    const pending = client.dump();
    activeWorker().emitError('boom');
    await expect(pending).rejects.toThrow(/boom/);
  });

  test('flushes main observations before dump but keeps compact polling observer-free', async () => {
    const precedingCommands: Array<string | undefined> = [];
    const client = createClient(() => {
      precedingCommands.push(activeWorker().messages.at(-1)?.kind);
    });
    const dump = client.dump();
    const status = client.drainStatus();
    expect(precedingCommands).toEqual(['init']);
    activeWorker().emitError('finished');
    await expect(dump).rejects.toThrow('finished');
    await expect(status).rejects.toThrow('finished');
  });

  test('a dump requested after a crash rejects without waiting on the worker', async () => {
    const client = createClient();
    activeWorker().emitError('boom');
    const before = activeWorker().messages.length;
    await expect(client.dump()).rejects.toThrow(/boom/);
    expect(activeWorker().messages.length).toBe(before);
  });

  test('an undeserializable message fails the dump too', async () => {
    const client = createClient();
    const pending = client.dump();
    activeWorker().emitMessageError();
    await expect(pending).rejects.toThrow(/deserialize/);
  });

  test('shares one in-flight dump and ignores its stale reply after the next request', async () => {
    const client = createClient();
    const first = client.dump();
    const second = client.dump();
    expect(second).toBe(first);
    expect(activeWorker().messages.filter((message) => message.kind === 'dump')).toEqual([
      { kind: 'dump', requestId: 1 },
    ]);
    activeWorker().onmessage?.({
      data: dumpEvent(1),
    } as MessageEvent);
    await expect(first).resolves.toMatchObject({ events: [] });
    await expect(second).resolves.toMatchObject({ events: [] });

    const third = client.dump();
    expect(activeWorker().messages.at(-1)).toEqual({ kind: 'dump', requestId: 2 });
    activeWorker().onmessage?.({
      data: dumpEvent(1),
    } as MessageEvent);
    let settled = false;
    void third.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    activeWorker().onmessage?.({
      data: dumpEvent(2),
    } as MessageEvent);
    await expect(third).resolves.toMatchObject({ events: [] });
  });

  test('stopping settles a dump the worker will never answer', async () => {
    const client = createClient();
    const pending = client.dump();
    client.stop();
    await expect(pending).rejects.toThrow(/stopped/);
  });

  test('drain status uses a correlated constant-size response with no event array', async () => {
    const client = createClient();
    const pending = client.drainStatus();
    const command = activeWorker().messages.at(-1);
    expect(command).toEqual({ kind: 'drain_status', requestId: 1 });

    const status = drainStatus(7, 123);
    activeWorker().onmessage?.({
      data: {
        kind: 'drain_status',
        requestId: 1,
        status: status.activity,
        stats: status.stats,
      },
    } as MessageEvent);
    await expect(pending).resolves.toEqual(status);
    expect(activeWorker().messages.filter((message) => message.kind === 'dump')).toEqual([]);
  });

  test('flushes buffered main observations before posting the PREPARE fence', async () => {
    const precedingCommands: Array<string | undefined> = [];
    const client = createClient(() => {
      precedingCommands.push(activeWorker().messages.at(-1)?.kind);
    });
    const prepared = client.prepareObservation();
    expect(precedingCommands).toEqual(['init']);
    expect(activeWorker().messages.at(-1)).toEqual({
      kind: 'prepare_observation',
      requestId: 1,
    });
    activeWorker().onmessage?.({
      data: { kind: 'observation_prepared', requestId: 1, stats: workerStats() },
    } as MessageEvent);
    await expect(prepared).resolves.toBe(1);
  });

  test('a stale drain reply cannot settle a superseding request', async () => {
    const client = createClient();
    const first = client.drainStatus();
    const second = client.drainStatus();
    await expect(first).rejects.toThrow(/Superseded/);
    activeWorker().onmessage?.({
      data: {
        kind: 'drain_status',
        requestId: 1,
        ...drainStatusEvent(1),
      },
    } as MessageEvent);
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    activeWorker().onmessage?.({
      data: {
        kind: 'drain_status',
        requestId: 2,
        ...drainStatusEvent(2),
      },
    } as MessageEvent);
    await expect(second).resolves.toEqual(drainStatus(2, 2));
  });

  test('recorder reset publishes one exact observation lineage before later requests', () => {
    createClient();
    const worker = activeWorker();
    const initial = worker.messages[0];
    expect(initial?.kind).toBe('init');
    if (initial?.kind !== 'init') throw new Error('missing telemetry init');
    const recorder = installTerminalPerfRecorder();
    recorder.reset();
    const observation = worker.messages.at(-1);
    expect(observation?.kind).toBe('observation');
    if (observation?.kind !== 'observation') throw new Error('missing observation reset');
    expect(observation.preparationRequestId).toBe(0);
    expect(observation.observationEpoch).toBeGreaterThan(initial.observationEpoch);
    expect(observation.observationStartedAtMs).toBeGreaterThan(0);
  });

  test('fences one prepared reset through an exact correlated completion', async () => {
    const client = createClient();
    const worker = activeWorker();
    const prepared = client.prepareObservation();
    expect(worker.messages.at(-1)).toEqual({ kind: 'prepare_observation', requestId: 1 });
    worker.onmessage?.({
      data: { kind: 'observation_prepared', requestId: 1, stats: workerStats() },
    } as MessageEvent);
    await expect(prepared).resolves.toBe(1);

    const recorder = installTerminalPerfRecorder();
    recorder.reset();
    const command = worker.messages.at(-1);
    expect(command?.kind).toBe('observation');
    if (command?.kind !== 'observation') throw new Error('missing observation reset');
    expect(command.preparationRequestId).toBe(1);
    const ready = client.observationReady();
    const capture = observationCapture(command.observationEpoch, command.observationStartedAtMs, 1);
    worker.onmessage?.({
      data: {
        kind: 'observation_complete',
        preparationRequestId: 1,
        observationEpoch: command.observationEpoch,
        observationStartedAtMs: command.observationStartedAtMs,
        capture,
        stats: workerStats(),
      },
    } as MessageEvent);
    await expect(ready).resolves.toEqual({
      preparationRequestId: 1,
      observationEpoch: command.observationEpoch,
      observationStartedAtMs: command.observationStartedAtMs,
      capture,
    });
  });

  test('replacement worker inherits the active browser observation identity', async () => {
    const client = createClient();
    const worker = activeWorker();
    const prepared = client.prepareObservation();
    worker.onmessage?.({
      data: { kind: 'observation_prepared', requestId: 1, stats: workerStats() },
    } as MessageEvent);
    await prepared;

    installTerminalPerfRecorder().reset();
    const command = worker.messages.at(-1);
    if (command?.kind !== 'observation') throw new Error('missing observation reset');
    const capture = observationCapture(command.observationEpoch, command.observationStartedAtMs, 1);
    worker.onmessage?.({
      data: {
        kind: 'observation_complete',
        preparationRequestId: 1,
        observationEpoch: command.observationEpoch,
        observationStartedAtMs: command.observationStartedAtMs,
        capture,
        stats: workerStats(),
      },
    } as MessageEvent);
    await client.observationReady();
    client.stop();

    createClient();
    expect(activeWorker().messages[0]).toMatchObject({
      kind: 'init',
      preparationRequestId: 1,
      observationEpoch: command.observationEpoch,
      observationStartedAtMs: command.observationStartedAtMs,
    });
  });

  test('rejects mismatched completion and blocks dump while the boundary is half prepared', async () => {
    const client = createClient();
    const worker = activeWorker();
    const prepared = client.prepareObservation();
    await expect(client.dump()).rejects.toThrow(/boundary is not complete/);
    await expect(client.drainStatus()).rejects.toThrow(/boundary is not complete/);
    worker.onmessage?.({
      data: { kind: 'observation_prepared', requestId: 1, stats: workerStats() },
    } as MessageEvent);
    await prepared;

    installTerminalPerfRecorder().reset();
    const command = worker.messages.at(-1);
    if (command?.kind !== 'observation') throw new Error('missing observation reset');
    const ready = client.observationReady();
    worker.onmessage?.({
      data: {
        kind: 'observation_complete',
        preparationRequestId: 1,
        observationEpoch: command.observationEpoch,
        observationStartedAtMs: command.observationStartedAtMs + 1,
        capture: observationCapture(
          command.observationEpoch,
          command.observationStartedAtMs + 1,
          1,
        ),
        stats: workerStats(),
      },
    } as MessageEvent);
    await expect(ready).rejects.toThrow(/mismatched/);
    await expect(client.dump()).rejects.toThrow(/boundary is not complete/);
  });
});

function workerStats() {
  return {
    recordsDrained: 10,
    recordsLost: 0,
    rowsShipped: 0,
    bytesShipped: 0,
    sendFailures: 0,
    pendingRows: 0,
    pendingRowsDropped: 0,
    budgetExhausted: false,
  } as const;
}

function drainStatus(
  observationEpoch: number,
  activityEventCount: number,
): TelemetryWorkerDrainStatus {
  return {
    activity: {
      observationEpoch,
      observationStartedAtMs: 100,
      activityRevision: activityEventCount,
      activityEventCount,
      latestActivityAtMs: 120,
      pendingAuthoritativeRenderCount: 0,
      trackingOverflow: false,
      graphicsAsset: {
        eventCount: 0,
        open: 0,
        demanded: 0,
        requested: 0,
        firstByte: 0,
        fin: 0,
        published: 0,
        consumed: 0,
        retired: 0,
        failed: 0,
      },
      input: {
        queuedCount: 0,
        queuedSeq: 0,
        ackedSeq: 0,
        ackAtMs: 0,
        fencedSeq: 0,
        fenceAtMs: 0,
      },
    },
    stats: workerStats(),
  };
}

function drainStatusEvent(observationEpoch: number) {
  const snapshot = drainStatus(observationEpoch, observationEpoch);
  return { status: snapshot.activity, stats: snapshot.stats } as const;
}

function observationCapture(
  observationEpoch: number,
  observationStartedAtMs: number,
  preparationRequestId: number,
) {
  return {
    complete: true,
    preparationRequestId,
    observationEpoch,
    observationStartedAtMs,
    capacity: 20_000,
    totalRecordedCount: 0,
    retainedEventCount: 0,
    retainedOverwriteCount: 0,
    producerRecordLossCount: 0,
    droppedEventCount: 0,
  } as const;
}

function dumpEvent(requestId: number) {
  return {
    kind: 'dump',
    requestId,
    events: [],
    stats: {
      recordsDrained: 0,
      recordsLost: 0,
      rowsShipped: 0,
      bytesShipped: 0,
      sendFailures: 0,
      pendingRows: 0,
      pendingRowsDropped: 0,
      budgetExhausted: false,
    },
    capture: observationCapture(1, 0, 0),
  } as const;
}
