import { expect, test } from 'bun:test';

import { Cause, Deferred, Effect, Exit, Fiber, Metric, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import {
  DaemonHealthServiceLive,
  DaemonHealthServiceTag,
  type DaemonMetricSnapshot,
  recordControlPingOutcome,
  recordControlPingRttMs,
  recordSuspensionGapMs,
} from './daemon-metrics';
import {
  buildDaemonPerfReport,
  type DaemonPerfReport,
  daemonPerfCursor,
  EMPTY_DAEMON_PERF_CURSOR,
  runDaemonPerfReporterEffect,
  runEnabledDaemonPerfReporterEffect,
} from './daemon-perf-reporter';

const NO_RTT = { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };

function transport(
  overrides: Partial<DaemonMetricSnapshot['dataplaneTransport']> = {},
): Partial<DaemonMetricSnapshot> {
  return { dataplaneTransport: { ...metrics().dataplaneTransport, ...overrides } };
}

function metrics(overrides: Partial<DaemonMetricSnapshot> = {}): DaemonMetricSnapshot {
  return {
    controlReconnectOutcomes: {},
    controlRegistrationOutcomes: {},
    controlPingOutcomes: {},
    dataplaneRestartOutcomes: {},
    dataplaneAckTimeouts: 0,
    dataplaneReady: 1,
    latestDataplaneTransport: null,
    dataplaneTransport: {
      rowVersionsSent: 0,
      rowVersionsSupersededUnapplied: 0,
      rowResendsIdentical: 0,
      fecRepairsSent: 0,
      fecRepairsRefused: 0,
      resyncRowsRequested: 0,
      directDisplayDatagramsReceived: 0,
      directDisplayDatagramsRecoveredByFec: 0,
      directDisplayDatagramsDeclaredLost: 0,
      directDisplayDatagramsOutcomeUnknown: 0,
      edgeDisplayDatagramsReceived: 0,
      edgeDisplayDatagramsRecoveredByFec: 0,
      edgeDisplayDatagramsDeclaredLost: 0,
      edgeDisplayDatagramsOutcomeUnknown: 0,
      rowsDeclaredLost: 0,
      directWtIncomingExpected: 0,
      directWtIncomingUnexpected: 0,
      directWtAdmitted: 0,
      natKeepalivesSent: 0,
      natPunchBurstsSent: 0,
      natPunchRefusedNotGlobal: 0,
      natPunchRefusedRateLimited: 0,
      natSideChannelSendFailures: 0,
      datagramSendFailures: 0,
      quicPacketsSent: 0,
      quicPacketsLost: 0,
      unackedDatagramsMax: 0,
      webtransportRttUs: 0,
      edgeRttUs: 0,
      statsEventsDropped: 0,
      rebindRequests: 0,
      rebindAccepted: 0,
      rebindCommitted: 0,
      rebindRefused: 0,
      rebindEnvelopesRejected: 0,
      rebindEventsSuppressed: 0,
    },
    ...overrides,
  };
}

test('an empty cursor reports absolute counts', () => {
  const report = buildDaemonPerfReport(
    EMPTY_DAEMON_PERF_CURSOR,
    metrics({
      controlPingOutcomes: { pong: 12, timeout: 1 },
      dataplaneAckTimeouts: 3,
    }),
    60_000,
    NO_RTT,
    0,
  );

  expect(report.controlPingPonged).toBe(12);
  expect(report.controlPingTimeout).toBe(1);
  expect(report.dataplaneAckTimeouts).toBe(3);
  expect(report.windowMs).toBe(60_000);
});

test('subsequent windows report deltas, not cumulative totals', () => {
  const first = metrics({
    controlPingOutcomes: { pong: 12 },
    dataplaneAckTimeouts: 3,
  });
  const cursor = daemonPerfCursor(first);

  const report = buildDaemonPerfReport(
    cursor,
    metrics({
      controlPingOutcomes: { pong: 24 },
      dataplaneAckTimeouts: 5,
    }),
    60_000,
    NO_RTT,
    0,
  );

  expect(report.controlPingPonged).toBe(12);
  expect(report.dataplaneAckTimeouts).toBe(2);
});

test('a daemon restart reports the new absolute value rather than a negative delta', () => {
  // The daemon's Effect registry resets with its process, so the counter can
  // legitimately move backwards. Emitting a negative delta here would make the
  // server-side cumulative counter run backwards.
  const cursor = daemonPerfCursor(
    metrics({ controlPingOutcomes: { pong: 5_000 }, dataplaneAckTimeouts: 40 }),
  );

  const report = buildDaemonPerfReport(
    cursor,
    metrics({ controlPingOutcomes: { pong: 2 }, dataplaneAckTimeouts: 1 }),
    60_000,
    NO_RTT,
    0,
  );

  expect(report.controlPingPonged).toBe(2);
  expect(report.dataplaneAckTimeouts).toBe(1);
});

test('an outcome that disappears from the snapshot contributes zero, not a negative', () => {
  const cursor = daemonPerfCursor(metrics({ controlPingOutcomes: { timeout: 4 } }));

  const report = buildDaemonPerfReport(cursor, metrics({}), 60_000, NO_RTT, 0);

  expect(report.controlPingTimeout).toBe(0);
});

test('reconnect and registration deltas sum across every outcome label', () => {
  const cursor = daemonPerfCursor(
    metrics({ controlReconnectOutcomes: { stable_connection: 2, process_suspended: 1 } }),
  );

  const report = buildDaemonPerfReport(
    cursor,
    metrics({
      controlReconnectOutcomes: {
        stable_connection: 3,
        process_suspended: 1,
        unregistered_connection: 2,
      },
    }),
    60_000,
    NO_RTT,
    0,
  );

  expect(report.controlReconnects).toBe(3);
});

test('ping rtt percentiles ride along and dataplane readiness is coerced to 0 or 1', () => {
  const report = buildDaemonPerfReport(
    EMPTY_DAEMON_PERF_CURSOR,
    metrics({ dataplaneReady: 0 }),
    60_000,
    { count: 12, p50Ms: 71, p95Ms: 132, maxMs: 467 },
    38.6 * 3_600_000,
  );

  expect(report.dataplaneReady).toBe(0);
  expect(report.pingRttCount).toBe(12);
  expect(report.pingRttP50Ms).toBe(71);
  expect(report.pingRttP95Ms).toBe(132);
  expect(report.pingRttMaxMs).toBe(467);
  // The documented 38.6-hour laptop-sleep gap must survive as a whole number.
  expect(report.suspensionGapMsMax).toBe(138_960_000);
});

test('direct-path counters are reported as window deltas, not cumulative totals', () => {
  // The dataplane reports these cumulatively since process start, so a report
  // that forwarded them raw would make every window look like the whole
  // process's history and the fleet total would be quadratic in uptime.
  const first = buildDaemonPerfReport(
    daemonPerfCursor(metrics(transport({ directWtIncomingExpected: 40, directWtAdmitted: 9 }))),
    metrics(transport({ directWtIncomingExpected: 47, directWtAdmitted: 11 })),
    30_000,
    NO_RTT,
    0,
  );
  expect(first.directWtIncomingExpected).toBe(7);
  expect(first.directWtAdmitted).toBe(2);
});

test('rebind accounting survives diagnostic suppression and is windowed once', () => {
  const report = buildDaemonPerfReport(
    daemonPerfCursor(
      metrics(
        transport({
          rebindRequests: 40,
          rebindAccepted: 21,
          rebindRefused: 17,
          rebindCommitted: 19,
          rebindEnvelopesRejected: 3,
          rebindEventsSuppressed: 12,
        }),
      ),
    ),
    metrics(
      transport({
        rebindRequests: 47,
        rebindAccepted: 25,
        rebindRefused: 20,
        rebindCommitted: 22,
        rebindEnvelopesRejected: 5,
        rebindEventsSuppressed: 18,
      }),
    ),
    30_000,
    NO_RTT,
    0,
  );

  expect(report.rebindRequests).toBe(7);
  expect(report.rebindAccepted).toBe(4);
  expect(report.rebindRefused).toBe(3);
  expect(report.rebindCommitted).toBe(3);
  expect(report.rebindEnvelopesRejected).toBe(2);
  expect(report.rebindEventsSuppressed).toBe(6);
});

test('a window where nothing reached the listener reports zero, not nothing', () => {
  // This is the whole point of the counter: browsers reporting dials against a
  // daemon whose listener saw no *expected* arrival is a firewall verdict, and
  // it is only legible if "no arrivals" is an explicit zero rather than an
  // absent field. Scanner traffic lands in the unexpected bucket and cannot
  // mask it.
  const report = buildDaemonPerfReport(
    daemonPerfCursor(metrics(transport({ directWtIncomingExpected: 12, directWtAdmitted: 3 }))),
    metrics(transport({ directWtIncomingExpected: 12, directWtAdmitted: 3 })),
    30_000,
    NO_RTT,
    0,
  );
  expect(report.directWtIncomingExpected).toBe(0);
  expect(report.directWtAdmitted).toBe(0);
});

test('a dataplane restart cannot report a negative window', () => {
  // A restart resets the cumulative counters to zero while the cursor still
  // holds the pre-restart totals.
  const report = buildDaemonPerfReport(
    daemonPerfCursor(metrics(transport({ directWtIncomingExpected: 900, directWtAdmitted: 50 }))),
    metrics(transport({ directWtIncomingExpected: 4, directWtAdmitted: 1 })),
    30_000,
    NO_RTT,
    0,
  );
  expect(report.directWtIncomingExpected).toBeGreaterThanOrEqual(0);
  expect(report.directWtAdmitted).toBeGreaterThanOrEqual(0);
});

test('display waste reaches the window as a rate, denominator included', () => {
  // The counters existed in the dataplane all along and stopped at the daemon's
  // local registry. What makes them answer anything is arriving together:
  // `rowResendsIdentical` on its own is a count that scales with how much output
  // the session happened to produce, and only `rowVersionsSent` turns it into
  // the share of the link that rendered nothing.
  const report = buildDaemonPerfReport(
    daemonPerfCursor(
      metrics(
        transport({
          rowVersionsSent: 1_000,
          rowResendsIdentical: 400,
          rowVersionsSupersededUnapplied: 90,
          resyncRowsRequested: 12,
          fecRepairsSent: 30,
          fecRepairsRefused: 3,
        }),
      ),
    ),
    metrics(
      transport({
        rowVersionsSent: 3_000,
        rowResendsIdentical: 1_600,
        rowVersionsSupersededUnapplied: 190,
        resyncRowsRequested: 42,
        fecRepairsSent: 130,
        fecRepairsRefused: 11,
      }),
    ),
    60_000,
    NO_RTT,
    0,
  );

  expect(report.rowVersionsSent).toBe(2_000);
  expect(report.rowResendsIdentical).toBe(1_200);
  expect(report.rowVersionsSupersededUnapplied).toBe(100);
  expect(report.resyncRowsRequested).toBe(30);
  expect(report.fecRepairsSent).toBe(100);
  // Refusals are reported as their own delta: a group that went unprotected
  // is the case parity coverage has to be judged on.
  expect(report.fecRepairsRefused).toBe(8);
  expect(report.rowResendsIdentical / report.rowVersionsSent).toBe(0.6);
});

test('display loss outcomes retain their direct and edge denominators', () => {
  const report = buildDaemonPerfReport(
    daemonPerfCursor(
      metrics(
        transport({
          directDisplayDatagramsReceived: 80,
          directDisplayDatagramsRecoveredByFec: 7,
          directDisplayDatagramsDeclaredLost: 3,
          directDisplayDatagramsOutcomeUnknown: 2,
          edgeDisplayDatagramsReceived: 40,
          edgeDisplayDatagramsRecoveredByFec: 4,
          edgeDisplayDatagramsDeclaredLost: 6,
          edgeDisplayDatagramsOutcomeUnknown: 5,
        }),
      ),
    ),
    metrics(
      transport({
        directDisplayDatagramsReceived: 170,
        directDisplayDatagramsRecoveredByFec: 14,
        directDisplayDatagramsDeclaredLost: 6,
        directDisplayDatagramsOutcomeUnknown: 4,
        edgeDisplayDatagramsReceived: 130,
        edgeDisplayDatagramsRecoveredByFec: 9,
        edgeDisplayDatagramsDeclaredLost: 11,
        edgeDisplayDatagramsOutcomeUnknown: 9,
      }),
    ),
    60_000,
    NO_RTT,
    0,
  );

  const directClassified =
    report.directDisplayDatagramsReceived +
    report.directDisplayDatagramsRecoveredByFec +
    report.directDisplayDatagramsDeclaredLost;
  expect(directClassified).toBe(100);
  expect(report.directDisplayDatagramsDeclaredLost / directClassified).toBe(0.03);
  expect(
    (report.directDisplayDatagramsRecoveredByFec + report.directDisplayDatagramsDeclaredLost) /
      directClassified,
  ).toBe(0.1);
  expect(report.directDisplayDatagramsOutcomeUnknown).toBe(2);

  const edgeClassified =
    report.edgeDisplayDatagramsReceived +
    report.edgeDisplayDatagramsRecoveredByFec +
    report.edgeDisplayDatagramsDeclaredLost;
  expect(edgeClassified).toBe(100);
  expect(report.edgeDisplayDatagramsDeclaredLost / edgeClassified).toBe(0.05);
  expect(report.edgeDisplayDatagramsOutcomeUnknown).toBe(4);
});

test('the first reporter window excludes counts, ping samples, gaps, and time before start', async () => {
  const reports: DaemonPerfReport[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const health = yield* DaemonHealthServiceTag;
        yield* health.updateControl({ state: 'registered' });
        yield* recordControlPingOutcome('pong');
        yield* recordControlPingOutcome('pong');
        recordControlPingRttMs(900);
        recordSuspensionGapMs(9_000);
        yield* TestClock.adjust('10 seconds');
        const reporter = yield* runDaemonPerfReporterEffect(
          (report) =>
            Effect.sync(() => {
              reports.push(report);
            }),
          '1 second',
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* recordControlPingOutcome('pong');
        recordControlPingRttMs(7);
        recordSuspensionGapMs(20);
        yield* TestClock.adjust('1 second');
        yield* Fiber.interrupt(reporter);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
          windowMs: 1_000,
          controlPingPonged: 1,
          pingRttCount: 1,
          pingRttP50Ms: 7,
          pingRttP95Ms: 7,
          pingRttMaxMs: 7,
          suspensionGapMsMax: 20,
        });
      }),
    ).pipe(
      Effect.provide(DaemonHealthServiceLive),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
  );
});

test('consent changes stop an in-flight sender and restart with a fresh window', async () => {
  const reports: DaemonPerfReport[] = [];
  const controllers: AbortController[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const enabled = yield* SubscriptionRef.make(false);
        const health = yield* DaemonHealthServiceTag;
        yield* health.updateControl({ state: 'registered' });
        const started = yield* Deferred.make<void>();
        const restarted = yield* Deferred.make<void>();
        const supervisor = yield* runEnabledDaemonPerfReporterEffect(
          (report) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                const controller = new AbortController();
                controllers.push(controller);
                reports.push(report);
                return controller;
              }),
              () =>
                Deferred.succeed(controllers.length === 1 ? started : restarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                ),
              (controller) => Effect.sync(() => controller.abort()),
            ),
          enabled,
          '1 second',
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* recordControlPingOutcome('pong');
        recordControlPingRttMs(900);
        yield* TestClock.adjust('5 seconds');
        expect(reports).toHaveLength(0);
        yield* SubscriptionRef.set(enabled, true);
        yield* TestClock.adjust('1 second');
        yield* Deferred.await(started);
        yield* SubscriptionRef.set(enabled, false);
        yield* TestClock.adjust('0 millis');
        expect(controllers[0]?.signal.aborted).toBe(true);
        yield* recordControlPingOutcome('pong');
        recordControlPingRttMs(800);
        yield* TestClock.adjust('5 seconds');
        expect(reports).toHaveLength(1);
        yield* SubscriptionRef.set(enabled, true);
        yield* TestClock.adjust('1 second');
        yield* Deferred.await(restarted);
        expect(reports.map((report) => report.controlPingPonged)).toEqual([0, 0]);
        expect(reports.map((report) => report.pingRttCount)).toEqual([0, 0]);
        yield* Fiber.interrupt(supervisor);
        expect(controllers[1]?.signal.aborted).toBe(true);
      }),
    ).pipe(
      Effect.provide(DaemonHealthServiceLive),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
  );
});

test('the consent supervisor surfaces reporter defects', async () => {
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const enabled = yield* SubscriptionRef.make(true);
        const health = yield* DaemonHealthServiceTag;
        yield* health.updateControl({ state: 'registered' });
        const supervisor = yield* runEnabledDaemonPerfReporterEffect(
          () => Effect.die(new Error('reporter defect')),
          enabled,
          '1 second',
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* TestClock.adjust('1 second');
        yield* Fiber.join(supervisor);
      }),
    ).pipe(
      Effect.provide(DaemonHealthServiceLive),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('reporter defect');
});
