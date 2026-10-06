import { describe, expect, test } from 'bun:test';

import type { TelemetryInputFrontierStatus } from '../../../apps/web/src/perf/telemetry-drain-status';
import type { TerminalPerfEvent } from '../../../apps/web/src/perf/terminal-latency';
import type {
  ProxyRelayStatus,
  ProxySettleStatus,
  ProxyTraceLedger,
} from '../../../scripts/edge-network-stats';
import {
  type GraphicsTimedClose,
  graphicsDataLaneRecoveries,
  graphicsTimedCloseErrors,
  graphicsTypingStratum,
  proxyHarnessDropErrors,
  voidedBatchErrors,
  withoutMissedQuads,
} from './graphics-typing-batch';

describe('a missed overlap', () => {
  const pairs = Array.from({ length: 12 }, (_, offset) => ({ pair: 16 + offset }));

  test('takes its whole quad out of the sample and leaves the others', () => {
    const late = { pair: 21, remainingTransferMs: -2.1, controlEchoMs: 2.5 };
    const brief = { pair: 23, remainingTransferMs: 0.7, controlEchoMs: 1 };
    const { valid, missedQuads } = withoutMissedQuads(1, pairs, [late, brief]);

    expect(valid.map(({ pair }) => pair)).toEqual([16, 17, 18, 19, 24, 25, 26, 27]);
    expect(missedQuads).toEqual([{ batch: 1, pairs: [20, 21, 22, 23], missed: [late, brief] }]);
  });

  test('in two quads takes out both, and none leaves every pair', () => {
    const first = { pair: 16, remainingTransferMs: 0, controlEchoMs: 1 };
    const last = { pair: 27, remainingTransferMs: -10.7, controlEchoMs: 0.8 };
    const { valid, missedQuads } = withoutMissedQuads(1, pairs, [last, first]);

    expect(valid.map(({ pair }) => pair)).toEqual([20, 21, 22, 23]);
    expect(missedQuads.map((quad) => quad.pairs)).toEqual([
      [16, 17, 18, 19],
      [24, 25, 26, 27],
    ]);
    expect(withoutMissedQuads(1, pairs, [])).toEqual({ valid: pairs, missedQuads: [] });
  });
});

describe('graphics typing stratum', () => {
  test('a drop after the close leaves the pair unmatched', () => {
    // The loss came in the settle's tail, after the input completed.
    const control = timedClose({ closedDropped: 0, settledDropped: 1 });
    expect(graphicsTypingStratum(control)).toBe('U');
    expect(graphicsTimedCloseErrors('control', control, INPUT, SAMPLE)).toEqual([]);
  });

  test('a drop before the close makes the pair lossy', () => {
    expect(graphicsTypingStratum(timedClose({ closedDropped: 1, settledDropped: 1 }))).toBe('L');
  });

  test('a hold before the close takes the pair out of both criteria, and a drop outranks it', () => {
    expect(graphicsTypingStratum(timedClose({ closedReordered: 1 }))).toBe('R');
    expect(graphicsTypingStratum(timedClose({ closedDropped: 1, closedReordered: 2 }))).toBe('L');
    // The settled ledger holds a later hold; the close saw none.
    const control = timedClose({ settledReordered: 1 });
    expect(graphicsTypingStratum(control)).toBe('U');
    expect(graphicsTimedCloseErrors('control', control, INPUT, SAMPLE)).toEqual([]);
  });

  test('counts the drops of a relay that detached before the close', () => {
    // The one live relay dropped nothing; the relay that lost a packet is gone.
    const control = timedClose({ closedDropped: 2, settledDropped: 2, relays: [relay(3, 0)] });
    expect(graphicsTypingStratum(control)).toBe('L');
  });

  test('is unmatched only when no relay dropped anything by the close, and null without a proxy', () => {
    expect(graphicsTypingStratum(timedClose({ relays: [relay(3, 0)] }))).toBe('U');
    expect(
      graphicsTypingStratum({
        ...timedClose({}),
        timedMark: null,
        closedLedger: null,
        ledger: null,
      }),
    ).toBeNull();
  });
});

describe('a graphics typing close', () => {
  test('must be the report completing the same input at the same instants', () => {
    const close = timedClose({});
    expect(
      graphicsTimedCloseErrors(
        'pair 3 control',
        { ...close, closedInput: { ...close.closedInput, queuedSeq: 43 } },
        INPUT,
        SAMPLE,
      ),
    ).toEqual(["pair 3 control: the close completed input 43, the report's sample is input 42"]);
    expect(
      graphicsTimedCloseErrors('pair 3 control', close, INPUT, { ...SAMPLE, inputAckMs: 121 }),
    ).toEqual([
      'pair 3 control: the close saw the ACK 120.5 ms after the input, the report 121 ms',
    ]);
    // The report's completed fence is a later commit than the tracker's first.
    expect(
      graphicsTimedCloseErrors('pair 3 control', close, INPUT, {
        ...SAMPLE,
        inputToCompletedAuthoritativePresentationFenceMs: 148.25,
      }),
    ).toEqual([
      "pair 3 control: the close saw the fence 131.25 ms after the input, the report's completed fence 148.25 ms",
    ]);
  });

  test('must close the timed mark, and count no more than the settled ledger', () => {
    const close = timedClose({ closedDropped: 1, settledDropped: 1 });
    const later = status({ markKey: 9, sinceMarkDropped: 1 });
    expect(
      graphicsTimedCloseErrors('pair 3 control', { ...close, closedLedger: later }, INPUT, SAMPLE),
    ).toEqual([
      'pair 3 control: the close is under mark {"generation":3,"key":9} of epoch 1, not the timed mark {"generation":3,"key":8} of epoch 1',
    ]);
    expect(
      graphicsTimedCloseErrors(
        'pair 3 control',
        { ...close, ledger: status({ sinceMarkDropped: 0 }) },
        INPUT,
        SAMPLE,
      ),
    ).toEqual(['pair 3 control: the close counted downDropped 1, more than the settled 0']);
    expect(
      graphicsTimedCloseErrors('pair 3 control', { ...close, ledger: null }, INPUT, SAMPLE),
    ).toEqual([
      'pair 3 control: the proxy answered only some of the timed mark, the close and the settled ledger',
    ]);
  });
});

describe('a voided graphics typing batch', () => {
  // A promotion's own signaling reconnect, then the rebind that restores it.
  const carrierChange: readonly TerminalPerfEvent[] = [
    {
      kind: 'carrier_recovery',
      atMs: 10,
      phase: 'incumbent_failed',
      reason: 'pong-deadline-lapsed',
    },
    { kind: 'carrier_recovery', atMs: 11, phase: 'promoted', reason: 'standby-proved-path' },
    { kind: 'transport_state', atMs: 11, state: 'signaling_reconnecting' },
    { kind: 'carrier_recovery', atMs: 40, phase: 'rebind_sent', reason: 'recovery-attempt' },
    { kind: 'transport_state', atMs: 60, state: 'signaling_connected' },
    { kind: 'carrier_recovery', atMs: 61, phase: 'restored', reason: 'recovery-attempt' },
  ];

  test('is not failed by what the carrier change itself did', () => {
    // The change cancelled one tile job and left another interrupted.
    const jobs = [asset(5, 20, 'cancelled'), asset(6, 21, 'interrupted')];
    expect(
      voidedBatchErrors([...carrierChange, ...jobs], 'carrier', status({}), status({})),
    ).toEqual([]);
  });

  test('still fails the run on a lost session', () => {
    const lost: TerminalPerfEvent = {
      kind: 'transport_state',
      atMs: 90,
      state: 'disconnected',
      reason: 'auth-timeout',
    };
    expect(voidedBatchErrors([...carrierChange, lost], 'carrier', status({}), status({}))).toEqual([
      'the session was lost at 90: auth-timeout',
    ]);
  });

  test('still fails the run when the proxy dropped a packet outside the impairment', () => {
    expect(
      voidedBatchErrors(carrierChange, 'carrier', status({}), status({ leaseExhausted: 1 })),
    ).toEqual([
      'proxy harness drops changed during the batch: ' +
        '{"oversized":0,"admission":0,"leaseExhausted":0} -> ' +
        '{"oversized":0,"admission":0,"leaseExhausted":1}',
    ]);
  });
});

describe('a data-lane interruption', () => {
  // A retired data pairing interrupted job 588 while its request awaited a
  // reply; the cancel's UNAVAILABLE resumed it, and it then delivered its tile.
  const recovered: readonly TerminalPerfEvent[] = [
    asset(588, 17, 'demanded'),
    asset(588, 17.1, 'requested'),
    asset(588, 471, 'interrupted'),
    asset(588, 594, 'resumed'),
    asset(588, 594.1, 'requested'),
    asset(588, 714, 'first_byte'),
    asset(588, 716.6, 'retired'),
  ];

  test('is recovered only by the same job resuming after it', () => {
    expect(graphicsDataLaneRecoveries(recovered)).toEqual({
      recovered: [{ jobId: 588, interruptedAtMs: 471, resumedAtMs: 594 }],
      unexplained: [],
    });
    expect(
      graphicsDataLaneRecoveries([asset(588, 471, 'interrupted'), asset(589, 594, 'resumed')]),
    ).toEqual({
      recovered: [],
      unexplained: [
        'tile job 589 resumed at 594 without an interruption',
        'tile job 588 was interrupted at 471 and never resumed',
      ],
    });
    expect(
      graphicsDataLaneRecoveries([asset(588, 470, 'resumed'), asset(588, 471, 'interrupted')])
        .unexplained,
    ).toEqual([
      'tile job 588 resumed at 470 without an interruption',
      'tile job 588 was interrupted at 471 and never resumed',
    ]);
  });

  test('voids the batch without failing the run', () => {
    expect(voidedBatchErrors(recovered, 'data-lane', status({}), status({}))).toEqual([]);
  });

  test('leaves every unrecovered failure phase failing the run', () => {
    const failures = [
      asset(590, 800, 'refused'),
      asset(591, 801, 'unavailable'),
      asset(592, 802, 'cancelled'),
      asset(593, 804, 'interrupted'),
    ];
    expect(
      voidedBatchErrors([...recovered, ...failures], 'data-lane', status({}), status({})),
    ).toEqual([
      'tile job 590 refused at 800',
      'tile job 591 unavailable at 801',
      'tile job 592 cancelled at 802',
      'tile job 593 was interrupted at 804 and never resumed',
    ]);
  });
});

describe('proxy harness drops across a batch', () => {
  test('hold only when both ends read the same counters', () => {
    expect(proxyHarnessDropErrors(null, null)).toEqual([]);
    expect(proxyHarnessDropErrors(status({}), status({}))).toEqual([]);
    expect(proxyHarnessDropErrors(status({}), null)).toHaveLength(1);
    expect(proxyHarnessDropErrors(status({}), status({ admissionDrops: 1 }))).toHaveLength(1);
    expect(proxyHarnessDropErrors(status({}), status({ leaseExhausted: 1 }))).toHaveLength(1);
  });
});

/** The report's sample for input 42: ACK at 120.5 ms, completed fence at 131.25 ms. */
const INPUT = { inputSeq: 42, atMs: 1_790_000_000_000.25 } as const;
const SAMPLE = {
  inputAckMs: 120.5,
  inputToCompletedAuthoritativePresentationFenceMs: 131.25,
} as const;

function timedClose({
  closedDropped = 0,
  settledDropped = closedDropped,
  closedReordered = 0,
  settledReordered = Math.max(1, closedReordered),
  relays = [],
}: {
  readonly closedDropped?: number;
  readonly settledDropped?: number;
  readonly closedReordered?: number;
  readonly settledReordered?: number;
  readonly relays?: readonly ProxyRelayStatus[];
}): GraphicsTimedClose {
  const closedInput: TelemetryInputFrontierStatus = {
    queuedCount: 5,
    queuedSeq: INPUT.inputSeq,
    ackedSeq: INPUT.inputSeq,
    ackAtMs: INPUT.atMs + SAMPLE.inputAckMs,
    fencedSeq: INPUT.inputSeq,
    fenceAtMs: INPUT.atMs + SAMPLE.inputToCompletedAuthoritativePresentationFenceMs,
  };
  return {
    timedMark: status({ sinceMark: { upSeen: 0, downSeen: 0, downDropped: 0, downReordered: 0 } }),
    closedInput,
    closedLedger: status({
      sinceMark: {
        upSeen: 10,
        downSeen: 12,
        downDropped: closedDropped,
        downReordered: closedReordered,
      },
      relays,
    }),
    ledger: status({
      sinceMark: {
        upSeen: 16,
        downSeen: 30,
        downDropped: settledDropped,
        downReordered: settledReordered,
      },
      relays,
    }),
  };
}

function asset(
  jobId: number,
  atMs: number,
  phase: Extract<TerminalPerfEvent, { kind: 'graphics_asset' }>['phase'],
): TerminalPerfEvent {
  return { kind: 'graphics_asset', atMs, phase, jobId, bytes: 0, failed: false };
}

function relay(admissionSeq: number, downDropped: number): ProxyRelayStatus {
  return {
    admissionSeq,
    listener: { role: 'browser', competitor: false },
    upstreamPort: 50_000 + admissionSeq,
    pending: 0,
    upSeen: 4,
    downSeen: 9,
    downDropped,
    downReordered: 0,
    upMaxInFlight: 3,
    downMaxInFlight: 5,
    bottleneckDrops: 0,
  };
}

function status({
  sinceMarkDropped = 0,
  sinceMark = { upSeen: 10, downSeen: 12, downDropped: sinceMarkDropped, downReordered: 0 },
  markKey = 8,
  relays = [],
  admissionDrops = 0,
  leaseExhausted = 0,
}: {
  readonly sinceMarkDropped?: number;
  readonly sinceMark?: ProxyTraceLedger;
  readonly markKey?: number;
  readonly relays?: readonly ProxyRelayStatus[];
  readonly admissionDrops?: number;
  readonly leaseExhausted?: number;
}): ProxySettleStatus {
  const upstream = { seen: 20, forwarded: 20, dropped: 0, released: 20, reorderInversions: 0 };
  return {
    schemaVersion: 9,
    epoch: 1,
    mark: { generation: 3, key: markKey },
    sinceMark,
    upstream,
    downstream: {
      ...upstream,
      forwarded: 20 - sinceMark.downDropped,
      dropped: sinceMark.downDropped,
    },
    harnessDrops: { oversized: 0, admission: admissionDrops, leaseExhausted },
    splitDatagrams: 0,
    pendingScheduledPackets: 0,
    relays,
  };
}
