import { afterEach, describe, expect, test } from 'bun:test';

import { encodePerfEvent } from './perf/perf-event-codec';
import { createPerfRingBuffer, createPerfRingWriter, type PerfRingWriter } from './perf/perf-ring';
import {
  createPerfStringInterner,
  createPerfStringTableBuffer,
  type PerfStringInterner,
} from './perf/perf-string-table';
import { TELEMETRY_RETAINED_EVENT_CAPACITY } from './perf/telemetry-drain-status';
import type { TelemetryWorkerCommand, TelemetryWorkerEvent } from './telemetry-worker-protocol';

const activeWorkers: Worker[] = [];

afterEach(() => {
  for (const worker of activeWorkers.splice(0)) worker.terminate();
});

describe('telemetry worker observation capture', () => {
  test('baselines old producer loss after PREPARE drain and charges only post-PREPARED loss', async () => {
    const harness = createHarness(1);
    writeCadence(harness.writer, harness.interner, 10, 1);
    writeCadence(harness.writer, harness.interner, 11, 2);
    harness.init();

    await harness.request(
      { kind: 'prepare_observation', requestId: 1 },
      (event) => event.kind === 'observation_prepared' && event.requestId === 1,
    );
    writeCadence(harness.writer, harness.interner, 101, 3);
    writeCadence(harness.writer, harness.interner, 102, 4);

    const completed = await harness.request(
      {
        kind: 'observation',
        preparationRequestId: 1,
        observationEpoch: 2,
        observationStartedAtMs: 100,
      },
      (event) => event.kind === 'observation_complete',
    );
    expect(completed).toMatchObject({
      kind: 'observation_complete',
      capture: {
        complete: true,
        preparationRequestId: 1,
        observationEpoch: 2,
        observationStartedAtMs: 100,
        totalRecordedCount: 2,
        retainedEventCount: 1,
        retainedOverwriteCount: 0,
        producerRecordLossCount: 1,
        droppedEventCount: 1,
      },
    });
    if (completed.kind !== 'observation_complete') {
      throw new Error('missing telemetry observation completion');
    }

    const dumped = await harness.request(
      { kind: 'dump', requestId: 9 },
      (event) => event.kind === 'dump' && event.requestId === 9,
    );
    if (dumped.kind !== 'dump') throw new Error('missing telemetry dump');
    expect(dumped.events).toHaveLength(1);
    expect(dumped.events[0]).toMatchObject({ kind: 'main_frame_cadence', atMs: 102 });
    expect(dumped.capture).toEqual(completed.capture);
  });

  test('counts an observation-local retained overwrite even when the suffix still looks whole', async () => {
    // Exactly one event beyond the production retained capacity, read from the
    // constant rather than restated, so raising the ring cannot quietly stop
    // exercising its eviction edge.
    const overflowing = TELEMETRY_RETAINED_EVENT_CAPACITY + 1;
    const harness = createHarness(overflowing);
    harness.init();
    await harness.request(
      { kind: 'prepare_observation', requestId: 2 },
      (event) => event.kind === 'observation_prepared' && event.requestId === 2,
    );
    for (let index = 0; index < overflowing; index += 1) {
      writeCadence(harness.writer, harness.interner, 101 + index / 100_000, index + 1);
    }

    const completed = await harness.request(
      {
        kind: 'observation',
        preparationRequestId: 2,
        observationEpoch: 3,
        observationStartedAtMs: 100,
      },
      (event) => event.kind === 'observation_complete',
    );
    expect(completed).toMatchObject({
      kind: 'observation_complete',
      capture: {
        complete: true,
        capacity: TELEMETRY_RETAINED_EVENT_CAPACITY,
        totalRecordedCount: overflowing,
        retainedEventCount: TELEMETRY_RETAINED_EVENT_CAPACITY,
        retainedOverwriteCount: 1,
        producerRecordLossCount: 0,
        droppedEventCount: 1,
      },
    });
  });

  test('compacts periodic prepare-to-complete drains to the exact timestamp suffix', async () => {
    const harness = createHarness(4);
    harness.init();
    await harness.request(
      { kind: 'prepare_observation', requestId: 3 },
      (event) => event.kind === 'observation_prepared' && event.requestId === 3,
    );
    writeCadence(harness.writer, harness.interner, 99, 1);
    writeCadence(harness.writer, harness.interner, 101, 2);
    await harness.request(
      { kind: 'drain_status', requestId: 8 },
      (event) => event.kind === 'drain_status' && event.requestId === 8,
    );
    writeCadence(harness.writer, harness.interner, 102, 3);

    const completed = await harness.request(
      {
        kind: 'observation',
        preparationRequestId: 3,
        observationEpoch: 4,
        observationStartedAtMs: 100,
      },
      (event) => event.kind === 'observation_complete',
    );
    expect(completed).toMatchObject({
      kind: 'observation_complete',
      capture: {
        complete: true,
        totalRecordedCount: 2,
        retainedEventCount: 2,
        retainedOverwriteCount: 0,
        producerRecordLossCount: 0,
        droppedEventCount: 0,
      },
    });
    const dumped = await harness.request(
      { kind: 'dump', requestId: 10 },
      (event) => event.kind === 'dump' && event.requestId === 10,
    );
    if (dumped.kind !== 'dump') throw new Error('missing telemetry dump');
    expect(dumped.events.map((event) => event.atMs)).toEqual([101, 102]);
  });

  test('retires a main-observer record flushed immediately before PREPARE', async () => {
    const harness = createHarness(4);
    harness.init();
    await harness.request(
      { kind: 'drain_status', requestId: 11 },
      (event) => event.kind === 'drain_status' && event.requestId === 11,
    );
    // This models PerformanceObserver.takeRecords() synchronously publishing
    // an already-completed old long task immediately before the client posts
    // PREPARE on its next statement.
    writeCadence(harness.writer, harness.interner, 50, 1);
    await harness.request(
      { kind: 'prepare_observation', requestId: 4 },
      (event) => event.kind === 'observation_prepared' && event.requestId === 4,
    );
    const completed = await harness.request(
      {
        kind: 'observation',
        preparationRequestId: 4,
        observationEpoch: 5,
        observationStartedAtMs: 100,
      },
      (event) => event.kind === 'observation_complete',
    );
    expect(completed).toMatchObject({
      kind: 'observation_complete',
      capture: {
        complete: true,
        totalRecordedCount: 0,
        retainedEventCount: 0,
        retainedOverwriteCount: 0,
        producerRecordLossCount: 0,
        droppedEventCount: 0,
      },
    });
  });
});

interface HarnessEgress {
  readonly origin: string;
  readonly accessToken: string;
  readonly byteBudget: number;
}

/** No endpoint and no token: nothing ships, so the observation tests see only the queue. */
const NO_EGRESS: HarnessEgress = {
  origin: 'https://telemetry.invalid',
  accessToken: '',
  byteBudget: 0,
};

function createHarness(recordCapacity: number, egress: HarnessEgress = NO_EGRESS) {
  const worker = new Worker(new URL('./telemetry-worker.ts', import.meta.url).href, {
    type: 'module',
  });
  activeWorkers.push(worker);
  const terminalPerfRing = createPerfRingBuffer(recordCapacity);
  const perfStrings = createPerfStringTableBuffer();
  const writer = createPerfRingWriter(terminalPerfRing);
  const interner = createPerfStringInterner(perfStrings);
  return {
    writer,
    interner,
    init(): void {
      worker.postMessage({
        kind: 'init',
        terminalPerfRing,
        transportPerfRing: createPerfRingBuffer(1),
        mainPerfRing: createPerfRingBuffer(1),
        perfStrings,
        origin: egress.origin,
        accessToken: egress.accessToken,
        byteBudget: egress.byteBudget,
        preparationRequestId: 0,
        observationEpoch: 1,
        observationStartedAtMs: 0,
      } satisfies TelemetryWorkerCommand);
    },
    request(
      command: TelemetryWorkerCommand,
      matches: (event: TelemetryWorkerEvent) => boolean,
    ): Promise<TelemetryWorkerEvent> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          worker.removeEventListener('message', onMessage);
          reject(new Error(`telemetry worker timed out handling ${command.kind}`));
        }, 5_000);
        const onMessage = (message: MessageEvent<TelemetryWorkerEvent>): void => {
          if (!matches(message.data)) return;
          clearTimeout(timeout);
          worker.removeEventListener('message', onMessage);
          resolve(message.data);
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage(command);
      });
    },
  };
}

describe('telemetry worker egress', () => {
  test('a full request of rows ships on the backlog, and only the tail waits for the clock', async () => {
    const requestRowCounts: number[] = [];
    let wireBytes = 0;
    let decodedBytes = 0;
    const encodings: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        if (new URL(request.url).pathname === '/api/telemetry/perf') {
          encodings.push(request.headers.get('content-encoding'));
          const compressed = await request.arrayBuffer();
          const decoded = await new Response(
            new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')),
          ).text();
          wireBytes += compressed.byteLength;
          decodedBytes += new TextEncoder().encode(decoded).byteLength;
          requestRowCounts.push(decoded.split('\n').length);
        }
        return new Response(null, { status: 204 });
      },
    });
    try {
      const harness = createHarness(4_096, {
        origin: `http://127.0.0.1:${server.port}`,
        accessToken: 'test-token',
        // Fits the compressed trace, but not its raw JSON. The byte budget must
        // charge what crosses the uplink rather than the expanded rows.
        byteBudget: 64 * 1024,
      });
      harness.init();
      for (let ordinal = 0; ordinal < 2_500; ordinal += 1) {
        writeCadence(harness.writer, harness.interner, 100 + ordinal, ordinal);
      }

      // A compact status poll drains the rings. It used to leave everything for
      // the 2 s timer; a burst larger than the pending bound overflowed inside
      // that wait. Two full requests must go out from this drain alone.
      const afterBacklog = await harness.request(
        { kind: 'drain_status', requestId: 7 },
        (event) => event.kind === 'stats' && event.stats.rowsShipped >= 2_000,
      );
      expect(afterBacklog.stats).toMatchObject({
        rowsShipped: 2_000,
        pendingRows: 500,
        pendingRowsDropped: 0,
        sendFailures: 0,
        budgetExhausted: false,
      });
      expect(requestRowCounts).toEqual([1_000, 1_000]);

      // The partial tail is the clock's; `flush` stands in for the tick.
      const afterTail = await harness.request(
        { kind: 'flush' },
        (event) => event.kind === 'stats' && event.stats.rowsShipped === 2_500,
      );
      expect(afterTail.stats.pendingRows).toBe(0);
      expect(requestRowCounts).toEqual([1_000, 1_000, 500]);
      expect(encodings).toEqual(['gzip', 'gzip', 'gzip']);
      expect(afterTail.stats.bytesShipped).toBe(wireBytes);
      expect(afterTail.stats.budgetExhausted).toBe(false);
      expect(decodedBytes).toBeGreaterThan(64 * 1024);
      expect(wireBytes).toBeLessThan(decodedBytes / 10);
    } finally {
      server.stop(true);
    }
  });
});

function writeCadence(
  writer: PerfRingWriter,
  interner: PerfStringInterner,
  atMs: number,
  ordinal: number,
): void {
  if (
    !encodePerfEvent(writer, interner, {
      kind: 'main_frame_cadence',
      atMs,
      gapMs: ordinal,
      longTaskObserverSupported: true,
    })
  ) {
    throw new Error('failed to encode cadence fixture');
  }
}
