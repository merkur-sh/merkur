import { traceparentHeader } from '@merkur/shared';

import { createBootstrapSpanDeriver } from './perf/bootstrap-spans';

import { decodePerfEvent } from './perf/perf-event-codec';
import {
  createPerfRingReader,
  PERF_RING_DEFAULT_RECORDS,
  type PerfRingReader,
} from './perf/perf-ring';
import { createPerfSessionStamper } from './perf/perf-session-stamp';
import { createPerfStringResolver, type PerfStringResolver } from './perf/perf-string-table';
import {
  appendBoundedTelemetryPending,
  createTelemetryDrainActivityTracker,
  createTelemetryRetainedEventRing,
  TELEMETRY_RETAINED_EVENT_CAPACITY,
} from './perf/telemetry-drain-status';
import type { TerminalPerfEvent } from './perf/terminal-latency';
import type {
  TelemetryObservationTraceCapture,
  TelemetryWorkerCommand,
  TelemetryWorkerEvent,
  TelemetryWorkerStats,
} from './telemetry-worker-protocol';

/**
 * Drains the profiling rings, decodes them, and ships them.
 *
 * This worker exists so that none of that happens on the main thread. The main
 * thread owns keystroke handling and the speculative glyph overlay; with
 * profiling on it now does no profiling work at all beyond the shared-memory
 * stores at each emission site. Decoding allocates freely here, because here it
 * is free.
 *
 * There is no `Atomics.wait` anywhere in this file. Parking on a ring would
 * require the producers to `notify`, which is the per-record wake this whole
 * design exists to remove. Polling a cold thread on a slow timer is the point.
 *
 * Shipping is driven by the backlog, not by that timer. A full request's worth
 * of rows is posted the moment it exists — every drain, including the compact
 * status polls a settling harness issues — and the timer only carries the
 * partial tail. Waiting for the clock let a redraw storm outrun the bounded
 * pending queue: ~11,000 rows/s for two seconds is more than `MAX_PENDING_ROWS`,
 * and the drop was reported as egress saturation when the endpoint had never
 * been asked. Now the queue saturates only when the endpoint is actually slower
 * than the producers, which is the condition the bound exists to report.
 */

/**
 * Drain cadence for the partial tail. Slow on purpose: latency to Axiom is
 * irrelevant, cost is not. Full batches never wait for it; see `ship`.
 */
const DRAIN_INTERVAL_MS = 2_000;

/**
 * Rows per request. Axiom's documented ceiling is 10,000 events per batch; this
 * sits an order of magnitude below it so a burst still fits in one request.
 */
const MAX_ROWS_PER_REQUEST = 1_000;

/** Sized next to the ring it fills; see `TELEMETRY_RETAINED_EVENT_CAPACITY`. */
const MAX_RETAINED_EVENTS = TELEMETRY_RETAINED_EVENT_CAPACITY;
/**
 * Independent egress backlog, sized so one complete drain of all three rings
 * always fits: a burst that filled every ring between two drains — nobody
 * polling, the timer alone — is still queued in full, and the queue refuses
 * rows only when the previous drain has not left it, which is the endpoint
 * being slower than the producers. A dead endpoint never grows it at all: a
 * failed batch is dropped, not retried.
 */
const MAX_PENDING_ROWS = 3 * PERF_RING_DEFAULT_RECORDS;

interface Producer {
  readonly reader: PerfRingReader;
  readonly label: string;
}

let producers: readonly Producer[] = [];
let strings: PerfStringResolver | null = null;
let origin = '';
let accessToken = '';
let byteBudget = 0;
let timer: ReturnType<typeof setInterval> | null = null;
/** The one send loop in flight; `stop` waits for it rather than closing over it. */
let inFlight: Promise<void> | null = null;
/** Latched by the timer, `flush` and `stop`: the loop also carries a partial batch. */
let shipTail = false;

const retained = createTelemetryRetainedEventRing<TerminalPerfEvent>(MAX_RETAINED_EVENTS);
const pending: TerminalPerfEvent[] = [];
const drainedBatch: TerminalPerfEvent[] = [];
const drainActivity = createTelemetryDrainActivityTracker(1, 0);
let pendingNeedsSort = false;

let recordsDrained = 0;
let recordsLost = 0;
let rowsShipped = 0;
let bytesShipped = 0;
let sendFailures = 0;
let pendingRowsDropped = 0;
let budgetExhausted = false;
let retainedOverwriteCount = 0;
let preparedObservation: {
  readonly requestId: number;
  readonly recordsLost: number;
  readonly retainedOverwriteCount: number;
} | null = null;
let observationCapture = {
  complete: true,
  preparationRequestId: 0,
  observationEpoch: 1,
  observationStartedAtMs: 0,
  totalRecordedCount: 0,
  retainedOverwriteCount: 0,
  producerRecordLossCount: 0,
};

function stats(): TelemetryWorkerStats {
  return {
    recordsDrained,
    recordsLost,
    rowsShipped,
    bytesShipped,
    sendFailures,
    pendingRows: pending.length,
    pendingRowsDropped,
    budgetExhausted,
  };
}

function post(event: TelemetryWorkerEvent): void {
  self.postMessage(event);
}

function observationTraceCapture(): TelemetryObservationTraceCapture {
  const droppedEventCount =
    observationCapture.retainedOverwriteCount + observationCapture.producerRecordLossCount;
  return {
    ...observationCapture,
    capacity: MAX_RETAINED_EVENTS,
    retainedEventCount: retained.size,
    droppedEventCount,
  };
}

/**
 * Pull every producer's ring into `pending`.
 *
 * Records are drained per ring and then sorted by timestamp, because the
 * analyzer joins across producers — a keystroke's `input_queued` comes from the
 * main thread while its `frame_complete` comes from the terminal worker — and
 * its scan assumes causal order.
 */
function drain(): void {
  const resolver = strings;
  if (resolver === null) return;

  const recordsLostBefore = recordsLost;
  drainedBatch.length = 0;
  for (const producer of producers) {
    const result = producer.reader.drain((record) => {
      const event = decodePerfEvent(record, resolver);
      // A record that cannot be decoded faithfully is counted as lost rather
      // than guessed at: the analyzer's partition identities only hold over
      // events it can trust.
      if (event === null) {
        recordsLost += 1;
        return;
      }
      drainedBatch.push(event);
    });
    recordsDrained += result.drained;
    recordsLost += result.lost;
  }

  const newlyLost = recordsLost - recordsLostBefore;
  if (newlyLost > 0) {
    observationCapture.producerRecordLossCount += newlyLost;
    observationCapture.totalRecordedCount += newlyLost;
  }

  if (drainedBatch.length > 0) {
    // Sort only records newly read by this poll. Sorting the whole unsent
    // queue here made a compact status request scale with shipping backlog.
    drainedBatch.sort((a, b) => a.atMs - b.atMs);
    for (const event of drainedBatch) {
      if (event.atMs >= observationCapture.observationStartedAtMs) {
        observationCapture.totalRecordedCount += 1;
        if (retained.push(event)) {
          retainedOverwriteCount += 1;
          observationCapture.retainedOverwriteCount += 1;
        }
      }
      drainActivity.observe(event);
      if (budgetExhausted) continue;
      if (appendBoundedTelemetryPending(pending, event, MAX_PENDING_ROWS)) {
        pendingNeedsSort = true;
      } else {
        pendingRowsDropped = Math.min(Number.MAX_SAFE_INTEGER, pendingRowsDropped + 1);
      }
    }
    // A full request exists: post it now. The timer is for the tail only.
    if (pending.length >= MAX_ROWS_PER_REQUEST) void ship(false);
  }
}

function prepareDrainObservation(requestId: number): void {
  // The exact main-thread boundary is established only after this ACK. Drain
  // and release all old-observation references first, then anchor cumulative
  // loss/overwrite. Only activity discovered after PREPARED can belong to (or
  // race with) the new observation.
  drain();
  retained.clear();
  const baseline = {
    requestId,
    recordsLost,
    retainedOverwriteCount,
  };
  observationCapture.complete = false;
  preparedObservation = baseline;
}

function resetDrainObservation(
  preparationRequestId: number,
  observationEpoch: number,
  observationStartedAtMs: number,
  initial = false,
): void {
  const preparation = preparedObservation;
  const matchingPreparation =
    preparation !== null &&
    preparation.requestId === preparationRequestId &&
    preparationRequestId > 0;
  const recordsLostBaseline = matchingPreparation ? preparation.recordsLost : recordsLost;
  const retainedOverwriteBaseline = matchingPreparation
    ? preparation.retainedOverwriteCount
    : retainedOverwriteCount;

  // Close the command-delivery race, then retain every event timestamped in
  // the new observation. This cold compaction is the only place old diagnostic
  // references are released; shipping state remains lifetime-cumulative.
  drain();
  retained.retain((event) => event.atMs >= observationStartedAtMs);
  const producerRecordLossCount = recordsLost - recordsLostBaseline;
  const observationRetainedOverwriteCount = retainedOverwriteCount - retainedOverwriteBaseline;
  observationCapture = {
    complete: initial || matchingPreparation,
    preparationRequestId,
    observationEpoch,
    observationStartedAtMs,
    totalRecordedCount: retained.size + producerRecordLossCount + observationRetainedOverwriteCount,
    retainedOverwriteCount: observationRetainedOverwriteCount,
    producerRecordLossCount,
  };
  // Every observation consumes the one-use preparation, including a mismatch;
  // a stale or forged completion can never rehabilitate/reuse it later.
  preparedObservation = null;
  drainActivity.reset(observationEpoch, observationStartedAtMs);
  retained.forEach((event) => {
    drainActivity.observe(event);
  });
}

/**
 * Resolves each row's Merkur session id. Stateful across batches by design —
 * see `perf-session-stamp.ts`.
 */
const sessionStamper = createPerfSessionStamper();

/**
 * Bootstrap spans are derived from the same batch the rows come from, on this cold thread.
 *
 * Stateful across batches for the same reason the stamper is: a 1,000-row splice boundary
 * can fall in the middle of a 600 ms connect.
 */
const bootstrapSpans = createBootstrapSpanDeriver();

/**
 * Posts derived bootstrap spans, and reports the bytes so they are charged to the same
 * session budget the rows are.
 *
 * A second destination outside that accounting would be an unmetered egress path — the
 * budget exists to bound what a profiled session can send, not what one endpoint can.
 */
async function shipBootstrapSpans(events: readonly TerminalPerfEvent[]): Promise<number> {
  const derived = bootstrapSpans.derive(events);
  if (derived === null) return 0;

  const body = JSON.stringify(derived);
  const response = await fetch(`${origin}/api/telemetry/traces`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      ...traceparentHeader(),
    },
    body,
  });
  if (!response.ok) {
    // Dropped, never retried, exactly as the rows are.
    sendFailures += 1;
    return 0;
  }
  return body.length;
}

/** Rows the send loop needs before it posts: a full request, or anything once the tail is due. */
function shipThreshold(): number {
  return shipTail ? 1 : MAX_ROWS_PER_REQUEST;
}

/**
 * Post pending rows, one request per `MAX_ROWS_PER_REQUEST`.
 *
 * `tail` latches `shipTail`, so a timer tick that finds a backlog-driven loop
 * already running does not lose its partial batch: the running loop re-reads
 * the threshold at every iteration and carries the tail before it exits.
 * Returns the in-flight loop so `stop` can wait for the last send to settle.
 */
function ship(tail: boolean): Promise<void> {
  if (tail) shipTail = true;
  if (inFlight !== null) return inFlight;
  if (budgetExhausted || accessToken === '' || pending.length < shipThreshold()) {
    shipTail = false;
    return Promise.resolve();
  }
  inFlight = shipPending().finally(() => {
    inFlight = null;
    post({ kind: 'stats', stats: stats() });
  });
  return inFlight;
}

async function shipPending(): Promise<void> {
  try {
    while (!budgetExhausted && pending.length >= shipThreshold()) {
      if (pendingNeedsSort) {
        pending.sort((a, b) => a.atMs - b.atMs);
        pendingNeedsSort = false;
      }
      const batch = pending.splice(0, MAX_ROWS_PER_REQUEST);
      // NDJSON: one row per line is what the ingest path forwards verbatim, and
      // it streams without the server having to hold a parsed array.
      const body = sessionStamper
        .stamp(batch)
        .map((row) => JSON.stringify(row))
        .join('\n');
      // Profiling shares the phone's uplink with terminal input. Repeated field
      // names and session IDs make raw NDJSON much larger than the data itself;
      // compress on this cold worker before handing any bytes to the network.
      const compressed = await new Response(
        new Blob([body]).stream().pipeThrough(new CompressionStream('gzip')),
      ).arrayBuffer();
      const size = compressed.byteLength;

      if (bytesShipped + size > byteBudget) {
        // A hard stop, reported. Never a silent downshift to a thinner tier:
        // a gap that looks like healthy data is worse than a visible stop.
        budgetExhausted = true;
        pending.length = 0;
        pendingNeedsSort = false;
        break;
      }

      const response = await fetch(`${origin}/api/telemetry/perf`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/x-ndjson',
          'content-encoding': 'gzip',
          authorization: `Bearer ${accessToken}`,
          // Minted in the worker rather than threaded through the command
          // protocol: a batch is posted long after `init`, so an id sent at
          // startup would name one trace for every batch of the session.
          ...traceparentHeader(),
        },
        body: compressed,
      });
      if (!response.ok) {
        // Dropped, never retried. A retried batch double-counts, and
        // observability must not consume the budget of what it observes.
        sendFailures += 1;
        continue;
      }
      rowsShipped += batch.length;
      bytesShipped += size;
      // After the rows: the spans describe the same batch, and shipping them second means a
      // budget stop never leaves rows referring to spans that were never sent.
      bytesShipped += await shipBootstrapSpans(batch);
    }
  } catch {
    sendFailures += 1;
  }
  shipTail = false;
}

function tick(): void {
  drain();
  void ship(true);
}

self.onmessage = (event: MessageEvent<TelemetryWorkerCommand>): void => {
  const command = event.data;
  switch (command.kind) {
    case 'init': {
      strings = createPerfStringResolver(command.perfStrings);
      producers = [
        { reader: createPerfRingReader(command.terminalPerfRing), label: 'terminal' },
        { reader: createPerfRingReader(command.transportPerfRing), label: 'transport' },
        { reader: createPerfRingReader(command.mainPerfRing), label: 'main' },
      ];
      origin = command.origin;
      accessToken = command.accessToken;
      byteBudget = command.byteBudget;
      resetDrainObservation(
        command.preparationRequestId,
        command.observationEpoch,
        command.observationStartedAtMs,
        true,
      );
      timer = setInterval(tick, DRAIN_INTERVAL_MS);
      return;
    }
    case 'token':
      accessToken = command.accessToken;
      return;
    case 'prepare_observation':
      prepareDrainObservation(command.requestId);
      post({ kind: 'observation_prepared', requestId: command.requestId, stats: stats() });
      return;
    case 'observation':
      resetDrainObservation(
        command.preparationRequestId,
        command.observationEpoch,
        command.observationStartedAtMs,
      );
      post({
        kind: 'observation_complete',
        preparationRequestId: command.preparationRequestId,
        observationEpoch: command.observationEpoch,
        observationStartedAtMs: command.observationStartedAtMs,
        capture: observationTraceCapture(),
        stats: stats(),
      });
      return;
    case 'flush':
      tick();
      return;
    case 'drain_status': {
      drain();
      const workerStats = stats();
      post({
        kind: 'drain_status',
        requestId: command.requestId,
        status: drainActivity.snapshot(),
        stats: workerStats,
      });
      return;
    }
    case 'dump':
      drain();
      // The full retained trace crosses the worker boundary only here. A dump
      // is an explicit final diagnostic operation, never a settle poll.
      post({
        kind: 'dump',
        requestId: command.requestId,
        events: retained.snapshot().sort((a, b) => a.atMs - b.atMs),
        stats: stats(),
        capture: observationTraceCapture(),
      });
      return;
    case 'stop':
      if (timer !== null) clearInterval(timer);
      timer = null;
      // Drain and ship the tail before closing, so the last seconds of a
      // profiled session are not lost to the gap between the final tick and
      // teardown. `self.close()` must wait for the send to settle — the caller
      // therefore does not terminate this worker, it lets it close itself.
      drain();
      void ship(true).finally(() => {
        self.close();
      });
      return;
  }
};
