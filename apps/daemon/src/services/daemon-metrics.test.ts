import { describe, expect, test } from 'bun:test';
import { Deferred, Effect, Fiber, Logger, Metric, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import {
  DaemonHealthServiceLive,
  DaemonHealthServiceTag,
  daemonObservabilitySnapshot,
  drainSuspensionGapMsMax,
  recordDataplaneMetricEvent,
  recordSuspensionGapMs,
  runDaemonObservabilityReporterEffect,
} from './daemon-metrics';
import { buildDaemonPerfReport, daemonPerfCursor } from './daemon-perf-reporter';
import type { DataplanePathStats, DataplaneTransportStats } from './dataplane-client';

function pathStats(overrides: Partial<DataplanePathStats> = {}): DataplanePathStats {
  return {
    pathsAvailable: 1,
    pathsLive: 1,
    rttEwmaUsMax: 0,
    networkRttEwmaUsMax: 0,
    jitterEwmaUsMax: 0,
    sendFailuresMax: 0,
    lastAckAgeMsMax: 0,
    displayDatagramsReceived: 0,
    displayDatagramsRecoveredByFec: 0,
    displayDatagramsDeclaredLost: 0,
    displayDatagramsOutcomeUnknown: 0,
    quicSentPackets: 0,
    quicLostPackets: 0,
    quicLostBytes: 0,
    quicCongestionEvents: 0,
    quicBlackHoles: 0,
    quicDatagramsTx: 0,
    quicDatagramsRx: 0,
    quicUdpTxBytes: 0,
    quicUdpRxBytes: 0,
    quicMtuMin: 0,
    quicCwndBytesMin: 0,
    quicRttUsMax: 0,
    ...overrides,
  };
}

function transportStats(overrides: Partial<DataplaneTransportStats> = {}): DataplaneTransportStats {
  return {
    windowMs: 10_000,
    peers: 1,
    parkedPeers: 0,
    webtransport: pathStats(),
    edge: pathStats(),
    rowVersionsSent: 0,
    rowVersionsSupersededUnapplied: 0,
    rowVersionsSupersededApplied: 0,
    rowResendsIdentical: 0,
    stalePreparedFlushesSent: 0,
    burstsAbandoned: 0,
    burstsUnsafeToRewind: 0,
    datagramSendFailures: 0,
    fecRepairsSent: 0,
    fecRepairsRefused: 0,
    resyncRowsRequested: 0,
    rowsDeclaredLost: 0,
    unackedDatagramsMax: 0,
    edgeReliableQueuedBytesMax: 0,
    inboundDatagramDropsWt: 0,
    inboundDatagramDropsEdge: 0,
    overCapacitySessionRejections: 0,
    directWtIncomingExpected: 0,
    directWtIncomingUnexpected: 0,
    directWtAdmitted: 0,
    natKeepalivesSent: 0,
    natPunchBurstsSent: 0,
    natPunchRefusedNotGlobal: 0,
    natPunchRefusedRateLimited: 0,
    natSideChannelSendFailed: 0,
    natSideChannelWouldBlock: 0,
    statsEventsDropped: 0,
    rebindRequests: 0,
    rebindAccepted: 0,
    rebindCommitted: 0,
    rebindRefused: 0,
    rebindEnvelopesRejected: 0,
    rebindEventsSuppressed: 0,
    ...overrides,
  };
}

describe('daemon observability', () => {
  test('native absolute counters count activity once across repeated samples and native restarts', async () => {
    const reports = await Effect.runPromise(
      Effect.gen(function* () {
        yield* recordDataplaneMetricEvent({ type: 'state', state: 'down' });
        let previous = daemonPerfCursor((yield* daemonObservabilitySnapshot).metrics);
        const reports = [];
        const ping = { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
        for (const [value, restart] of [
          [2, false],
          [2, false],
          [3, false],
          [1, true],
          [0, false],
          [1, false],
        ] as const) {
          if (restart) yield* recordDataplaneMetricEvent({ type: 'state', state: 'down' });
          const stats = transportStats({
            directWtAdmitted: value,
            directWtIncomingExpected: value,
            directWtIncomingUnexpected: value,
            natKeepalivesSent: value,
            natPunchBurstsSent: value,
            natPunchRefusedNotGlobal: value,
            natPunchRefusedRateLimited: value,
            natSideChannelSendFailed: value,
            natSideChannelWouldBlock: value,
          });
          for (let sample = 0; sample < 30; sample++) {
            yield* recordDataplaneMetricEvent({ type: 'transport_stats', stats });
          }
          const metrics = (yield* daemonObservabilitySnapshot).metrics;
          reports.push(buildDaemonPerfReport(previous, metrics, 60_000, ping, 0));
          previous = daemonPerfCursor(metrics);
        }
        yield* recordDataplaneMetricEvent({ type: 'state', state: 'down' });
        return reports;
      }).pipe(
        Effect.provide(DaemonHealthServiceLive),
        Effect.provideService(Metric.MetricRegistry, new Map()),
      ),
    );
    for (const field of [
      'directWtAdmitted',
      'directWtIncomingExpected',
      'directWtIncomingUnexpected',
      'natKeepalivesSent',
      'natPunchBurstsSent',
      'natPunchRefusedNotGlobal',
      'natPunchRefusedRateLimited',
    ] as const) {
      expect(reports.map((report) => report[field])).toEqual([2, 0, 1, 1, 0, 1]);
    }
    expect(reports.map((report) => report.natSideChannelSendFailures)).toEqual([4, 0, 2, 2, 0, 2]);
  });

  test('derives readiness from real-time control and dataplane state', async () => {
    const snapshots = await Effect.runPromise(
      Effect.gen(function* () {
        const health = yield* DaemonHealthServiceTag;
        yield* health.updateDataplane('down');
        const initial = yield* health.snapshot;

        yield* TestClock.adjust('1 second');
        yield* health.updateControl({
          state: 'registered',
          connectionId: 'connection-1',
        });
        yield* health.updateDataplane('ready');
        const ready = yield* health.snapshot;

        yield* TestClock.adjust('1 second');
        yield* health.updateControl({
          state: 'backoff',
          reconnectDelayMs: 500,
          lastFailure: 'ping_timeout',
        });
        const degraded = yield* health.snapshot;
        return { initial, ready, degraded };
      }).pipe(Effect.provide(DaemonHealthServiceLive), Effect.provide(TestClock.layer())),
    );

    expect(snapshots.initial).toMatchObject({
      ready: false,
      status: 'not_ready',
      control: { state: 'starting' },
      dataplane: { state: 'down' },
    });
    expect(snapshots.ready).toMatchObject({
      ready: true,
      status: 'ready',
      checkedAt: 1_000,
      control: {
        state: 'registered',
        connectionId: 'connection-1',
      },
      dataplane: { state: 'ready' },
    });
    expect(snapshots.degraded).toMatchObject({
      ready: false,
      status: 'not_ready',
      checkedAt: 2_000,
      control: {
        state: 'backoff',
        reconnectDelayMs: 500,
        lastFailure: 'ping_timeout',
      },
    });
  });

  test('publishes distinct dataplane readiness transitions through changes immediately', async () => {
    const states = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const health = yield* DaemonHealthServiceTag;
          const subscribed = yield* Deferred.make<void>();
          const changes = yield* health.changes.pipe(
            Stream.tap(() => Deferred.succeed(subscribed, undefined)),
            Stream.take(5),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* Deferred.await(subscribed);
          yield* health.updateDataplane('down');
          yield* health.updateDataplane('down');
          yield* TestClock.adjust('1 second');
          yield* health.updateControl({
            state: 'registered',
            connectionId: 'connection-1',
          });
          yield* TestClock.adjust('1 second');
          yield* health.updateDataplane('ready');
          yield* TestClock.adjust('1 second');
          yield* health.updateDataplane('fatal');
          return Array.from(yield* Fiber.join(changes));
        }),
      ).pipe(Effect.provide(DaemonHealthServiceLive), Effect.provide(TestClock.layer())),
    );

    expect(
      states.map((state) => ({
        ready: state.ready,
        control: state.control.state,
        dataplane: state.dataplane.state,
        checkedAt: state.checkedAt,
      })),
    ).toEqual([
      { ready: false, control: 'starting', dataplane: 'starting', checkedAt: 0 },
      { ready: false, control: 'starting', dataplane: 'down', checkedAt: 0 },
      { ready: false, control: 'registered', dataplane: 'down', checkedAt: 1_000 },
      { ready: true, control: 'registered', dataplane: 'ready', checkedAt: 2_000 },
      { ready: false, control: 'registered', dataplane: 'fatal', checkedAt: 3_000 },
    ]);
  });

  test('periodically emits bounded structured health snapshots through the Effect logger', async () => {
    const messages = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstLog = yield* Deferred.make<void>();
          const secondLog = yield* Deferred.make<void>();
          const recorded: string[] = [];
          const captureLogger = Logger.make(({ message }) => {
            const normalizedMessage = typeof message === 'string' ? message : String(message);
            if (normalizedMessage !== 'daemon_health_snapshot') return;
            recorded.push(normalizedMessage);
            if (recorded.length === 1) {
              Deferred.doneUnsafe(firstLog, Effect.void);
            }
            if (recorded.length === 2) {
              Deferred.doneUnsafe(secondLog, Effect.void);
            }
          });

          const reporter = yield* runDaemonObservabilityReporterEffect('daemon-1', '5 millis').pipe(
            Effect.provide(Logger.layer([captureLogger])),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* Deferred.await(firstLog);
          yield* Deferred.await(secondLog);
          yield* Fiber.interrupt(reporter);
          return recorded;
        }),
      ).pipe(Effect.provide(DaemonHealthServiceLive)),
    );

    expect(messages).toEqual(['daemon_health_snapshot', 'daemon_health_snapshot']);
  });

  test('retains one redacted full transport sample and bounded process aggregate', async () => {
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        yield* recordDataplaneMetricEvent({
          type: 'transport_stats',
          stats: transportStats({
            edge: pathStats({
              displayDatagramsReceived: 2,
              quicLostPackets: 1,
              quicDatagramsTx: 3,
              quicUdpTxBytes: 100,
              quicMtuMin: 1_300,
              quicCwndBytesMin: 9_000,
            }),
            rowVersionsSent: 5,
            edgeReliableQueuedBytesMax: 200,
          }),
        });
        yield* TestClock.adjust('10 seconds');
        yield* recordDataplaneMetricEvent({
          type: 'transport_stats',
          stats: transportStats({
            edge: pathStats({
              displayDatagramsReceived: 1,
              quicLostPackets: 2,
              quicDatagramsTx: 4,
              quicUdpTxBytes: 200,
              quicMtuMin: 1_200,
              quicCwndBytesMin: 10_000,
            }),
            rowVersionsSent: 6,
            edgeReliableQueuedBytesMax: 100,
          }),
        });
        const current = yield* daemonObservabilitySnapshot;
        yield* recordDataplaneMetricEvent({ type: 'state', state: 'down' });
        return current.metrics.latestDataplaneTransport;
      }).pipe(
        Effect.provide(DaemonHealthServiceLive),
        Effect.provide(TestClock.layer()),
        Effect.provideService(Metric.MetricRegistry, new Map()),
      ),
    );

    expect(snapshot?.observedAtMs).toBe(10_000);
    expect(snapshot?.sampleCount).toBe(2);
    expect(snapshot?.latest.edge.quicDatagramsTx).toBe(4);
    expect(snapshot?.aggregate.windowMs).toBe(20_000);
    expect(snapshot?.aggregate.edge.displayDatagramsReceived).toBe(3);
    expect(snapshot?.aggregate.edge.quicLostPackets).toBe(3);
    expect(snapshot?.aggregate.edge.quicDatagramsTx).toBe(7);
    expect(snapshot?.aggregate.edge.quicUdpTxBytes).toBe(300);
    expect(snapshot?.aggregate.edge.quicMtuMin).toBe(1_200);
    expect(snapshot?.aggregate.edge.quicCwndBytesMin).toBe(9_000);
    expect(snapshot?.aggregate.rowVersionsSent).toBe(11);
    expect(snapshot?.aggregate.edgeReliableQueuedBytesMax).toBe(200);
  });

  test('aggregates rebind outcomes without creating a session-id metric dimension', async () => {
    const snapshots = await Effect.runPromise(
      Effect.gen(function* () {
        yield* recordDataplaneMetricEvent({
          type: 'session_rebind',
          sessionId: 'session-a',
          outcome: 'unknown_peer',
          generation: 0,
          attemptMs: 0,
        });
        yield* recordDataplaneMetricEvent({
          type: 'session_rebind',
          sessionId: 'session-b',
          outcome: 'unknown_peer',
          generation: 4,
          attemptMs: 12,
        });
        yield* recordDataplaneMetricEvent({
          type: 'session_rebind',
          sessionId: 'session-c',
          outcome: 'committed',
          generation: 5,
          attemptMs: 21,
        });
        return yield* Metric.snapshot;
      }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
    );

    const rebind = snapshots.filter((snapshot) => snapshot.id === 'merkur_daemon_rebind_outcomes');
    expect(rebind).toHaveLength(1);
    expect(rebind[0]?.attributes).toBeUndefined();
    expect(rebind[0]?.type).toBe('Frequency');
    if (rebind[0]?.type !== 'Frequency') throw new Error('expected frequency snapshot');
    expect(Object.fromEntries(rebind[0].state.occurrences)).toEqual({
      committed: 1,
      unknown_peer: 2,
    });
  });
});

describe('suspension gap window', () => {
  test('drains the largest recorded gap once, then reports zero', () => {
    expect(drainSuspensionGapMsMax()).toBe(0);
    recordSuspensionGapMs(7_500);
    recordSuspensionGapMs(Number.NaN);
    recordSuspensionGapMs(120_000);
    recordSuspensionGapMs(9_000);
    expect(drainSuspensionGapMsMax()).toBe(120_000);
    expect(drainSuspensionGapMsMax()).toBe(0);
  });
});
