import { expect, test } from 'bun:test';
import type { EventReport, RequiredCheck } from './events';
import {
  admitTestReservation,
  type CompletedTestAdmission,
  initializeTestInventory,
  type LedgerSnapshot,
  ledgerBytes,
  parseLedger,
  passedTests,
  type RevocationLedger,
  type RevocationStore,
  rejectTestReservation,
  reserveTests,
  reusableNonces,
  type TestAdmissionExpectation,
  type TestReservation,
} from './revocation';

const A = '//fixtures:a';
const B = '//fixtures:b';
const invocation = '438d90af-b3bd-4c90-8bce-0e2a10aa2db9';

class MemoryLedger implements RevocationStore {
  private sequence = 0;
  private snapshot: LedgerSnapshot = { revision: '0', ledger: parseLedger({}) };
  beforeExchange: (() => void) | undefined;

  read(): LedgerSnapshot {
    return this.snapshot;
  }

  compareExchange(previous: LedgerSnapshot, ledger: RevocationLedger): LedgerSnapshot | null {
    const callback = this.beforeExchange;
    this.beforeExchange = undefined;
    callback?.();
    if (previous.revision !== this.snapshot.revision) return null;
    this.snapshot = Object.freeze({
      revision: String(++this.sequence),
      ledger: parseLedger(ledger),
    });
    return this.snapshot;
  }
}

function evidence(reservation: TestReservation) {
  const required: RequiredCheck[] = reservation.labels.map((label) => ({
    label,
    kind: 'test',
    fresh: false,
  }));
  const configurations = new Map(required.map((check) => [check.label, 'a'.repeat(64)]));
  const events: EventReport = {
    invocation,
    buildToolVersion: '9.2.0',
    complete: true,
    exitCode: 0,
    problems: [],
    checks: required.map((check) => ({
      ...check,
      status: 'passed',
      origin: 'executed',
      attempts: 1,
      durationMs: 1,
      configuration: 'a'.repeat(64),
    })),
  };
  const expected: TestAdmissionExpectation[] = [
    { platform: 'darwin-arm64', invocation, required, configurations },
  ];
  return { expected, events };
}

function pass(store: RevocationStore, reservation: TestReservation): LedgerSnapshot {
  const proof = evidence(reservation);
  return admitTestReservation(store, reservation, proof.expected, [
    { events: proof.events, processExitCode: 0 },
  ]);
}

test('ledger parsing rejects ambiguous labels, states, nonces and additional fields', () => {
  for (const ledger of [
    null,
    [],
    { relative: { nonce: 'a'.repeat(64), state: 'ready' } },
    { [A]: { nonce: 'short', state: 'ready' } },
    { [A]: { nonce: 'a'.repeat(64), state: true } },
    { [A]: { nonce: 'a'.repeat(64), state: ['ready'] } },
    { [A]: { nonce: 'a'.repeat(64), state: 'ready', pass: true } },
    {
      [A]: { nonce: 'a'.repeat(64), state: 'ready' },
      [B]: { nonce: 'a'.repeat(64), state: 'pending' },
    },
  ])
    expect(() => parseLedger(ledger)).toThrow();
  const parsed = parseLedger({
    [B]: { state: 'pending', nonce: 'b'.repeat(64) },
    [A]: { state: 'ready', nonce: 'a'.repeat(64) },
  });
  expect(Object.keys(parsed)).toEqual([A, B]);
  expect(ledgerBytes(parsed)).toBe(ledgerBytes(JSON.parse(ledgerBytes(parsed))));
});

test('force persists a new pending nonce for exactly selected tests before any execution', () => {
  const store = new MemoryLedger();
  pass(store, reserveTests(store, [A, B], false));
  const before = store.read();
  const forced = reserveTests(store, [A], true);
  expect(store.read()).toEqual(forced.snapshot);
  expect(forced.fresh).toEqual([A]);
  expect(forced.snapshot.ledger[A]?.nonce).not.toBe(before.ledger[A]?.nonce);
  expect(forced.snapshot.ledger[A]?.state).toBe('pending');
  expect(forced.snapshot.ledger[B]).toEqual(before.ledger[B]);
  expect(() => reusableNonces(store.read(), [A])).toThrow();
  expect(reusableNonces(store.read(), [B])[B]).toBe(before.ledger[B]?.nonce);
});

test('complete inventory initialization preserves active attempts and admitted epochs', () => {
  const store = new MemoryLedger();
  const active = reserveTests(store, [A], true);
  initializeTestInventory(store, [A, B]);
  expect(store.read().ledger[A]).toEqual(active.snapshot.ledger[A]);
  expect(store.read().ledger[B]?.state).toBe('pending');
  pass(store, active);
  const admitted = store.read();
  expect(initializeTestInventory(store, [B, A])).toEqual(admitted);
});

test('an observed failed ordinary verification revokes its still-current prior pass', () => {
  const store = new MemoryLedger();
  pass(store, reserveTests(store, [A], false));
  const ordinary = reserveTests(store, [A], false);
  const proof = evidence(ordinary);
  const failed: EventReport = {
    ...proof.events,
    exitCode: 1,
    checks: proof.events.checks.map((check) => ({ ...check, status: 'failed' })),
  };
  expect(() =>
    admitTestReservation(store, ordinary, proof.expected, [{ events: failed, processExitCode: 1 }]),
  ).toThrow();
  expect(() => reusableNonces(store.read(), [A])).toThrow();
  expect(store.read().ledger[A]?.nonce).not.toBe(ordinary.snapshot.ledger[A]?.nonce);
  expect(reserveTests(store, [A], false).snapshot.ledger[A]?.nonce).not.toBe(
    ordinary.snapshot.ledger[A]?.nonce,
  );
});

test('a failed attempt keeps the epochs of tests that passed and retires every other one', () => {
  const store = new MemoryLedger();
  pass(store, reserveTests(store, [A], false));
  const attempt = reserveTests(store, [A, B], false);
  expect(attempt.fresh).toEqual([B]);
  const ready = attempt.snapshot.ledger[A]?.nonce;
  const reserved = attempt.snapshot.ledger[B]?.nonce;
  // B passed for the first time while a sibling failed: its pass stands.
  rejectTestReservation(store, attempt, [B]);
  expect(store.read().ledger[B]).toEqual({ nonce: reserved ?? '', state: 'ready' });
  // A was ready and did not pass this time: the observed failure revokes it.
  expect(store.read().ledger[A]?.nonce).not.toBe(ready);
  expect(store.read().ledger[A]?.state).toBe('pending');

  const again = reserveTests(store, [A, B], false);
  expect(again.fresh).toEqual([A]);
  rejectTestReservation(store, again);
  expect(store.read().ledger[A]?.nonce).not.toBe(again.snapshot.ledger[A]?.nonce);
  expect(store.read().ledger[B]?.nonce).not.toBe(reserved);
  expect(store.read().ledger[B]?.state).toBe('pending');
});

test('only an exact, complete, executed pass counts as a passed test', () => {
  const store = new MemoryLedger();
  const attempt = reserveTests(store, [A, B], false);
  const proof = evidence(attempt);
  const report = (events: EventReport) => [{ events, processExitCode: events.exitCode }];
  expect(passedTests(attempt, proof.expected, report(proof.events))).toEqual([A, B]);
  const failing: EventReport = {
    ...proof.events,
    exitCode: 3,
    checks: proof.events.checks.map((check) =>
      check.label === A ? { ...check, status: 'failed' } : check,
    ),
  };
  expect(passedTests(attempt, proof.expected, report(failing))).toEqual([B]);
  const cached: EventReport = {
    ...proof.events,
    checks: proof.events.checks.map((check) => ({ ...check, origin: 'remote-cache' })),
  };
  expect(passedTests(attempt, proof.expected, report(cached))).toEqual([]);
  expect(
    passedTests(attempt, proof.expected, report({ ...proof.events, complete: false })),
  ).toEqual([]);
  expect(
    passedTests(attempt, proof.expected, [{ events: proof.events, processExitCode: 1 }]),
  ).toEqual([]);
});

test('failed complete batch never admits its partial passes and retries change every pending key', () => {
  const store = new MemoryLedger();
  pass(store, reserveTests(store, [A, B], false));
  const forced = reserveTests(store, [A, B], true);
  const proof = evidence(forced);
  const failed: EventReport = {
    ...proof.events,
    exitCode: 1,
    checks: proof.events.checks.map((check) =>
      check.label === B ? { ...check, status: 'failed' } : check,
    ),
  };
  expect(() =>
    admitTestReservation(store, forced, proof.expected, [{ events: failed, processExitCode: 1 }]),
  ).toThrow();
  expect(() => reusableNonces(store.read(), [A, B])).toThrow();
  const retry = reserveTests(store, [A, B], false);
  for (const label of [A, B])
    expect(retry.snapshot.ledger[label]?.nonce).not.toBe(forced.snapshot.ledger[label]?.nonce);
});

test('cancelled client cannot admit a remote worker completion and its retry never uses that nonce', () => {
  const store = new MemoryLedger();
  const cancelled = reserveTests(store, [A], true);
  const proof = evidence(cancelled);
  expect(() =>
    admitTestReservation(store, cancelled, proof.expected, [
      { events: proof.events, processExitCode: null },
    ]),
  ).toThrow();
  expect(() => reusableNonces(store.read(), [A])).toThrow();
  const retry = reserveTests(store, [A], false);
  expect(retry.snapshot.ledger[A]?.nonce).not.toBe(cancelled.snapshot.ledger[A]?.nonce);
  expect(() => pass(store, cancelled)).toThrow('superseded');
  pass(store, retry);
  expect(reusableNonces(store.read(), [A])[A]).toBe(retry.snapshot.ledger[A]?.nonce);
});

test('an older in-flight successful run cannot republish across a newer forced revocation', () => {
  const store = new MemoryLedger();
  const older = reserveTests(store, [A], true);
  const newer = reserveTests(store, [A], true);
  expect(() => pass(store, older)).toThrow('superseded');
  expect(store.read()).toEqual(newer.snapshot);
  expect(() => reusableNonces(store.read(), [A])).toThrow();
});

test('independent test updates and admission merge without overwriting another pending nonce', () => {
  const store = new MemoryLedger();
  const first = reserveTests(store, [A], true);
  const second = reserveTests(store, [B], true);
  pass(store, first);
  expect(store.read().ledger[A]?.state).toBe('ready');
  expect(store.read().ledger[B]).toEqual(second.snapshot.ledger[B]);
  pass(store, second);
  expect(Object.keys(reusableNonces(store.read(), [A, B]))).toEqual([A, B]);
});

test('CAS collision retries preserve the concurrent target update', () => {
  const store = new MemoryLedger();
  store.beforeExchange = () => reserveTests(store, [B], true);
  const first = reserveTests(store, [A], true);
  expect(first.snapshot.ledger[B]?.state).toBe('pending');
  expect(first.snapshot.ledger[A]?.state).toBe('pending');
  expect(first.fresh).toEqual([A]);
});

test('cached or incomplete evidence cannot make pending epochs reusable', () => {
  for (const mutation of [
    (events: EventReport): EventReport => ({ ...events, complete: false }),
    (events: EventReport): EventReport => ({ ...events, invocation: 'other' }),
    (events: EventReport): EventReport => ({ ...events, buildToolVersion: 'other' }),
    (events: EventReport): EventReport => ({ ...events, checks: [] }),
    (events: EventReport): EventReport => ({ ...events, problems: ['missing evidence'] }),
    (events: EventReport): EventReport => ({
      ...events,
      checks: events.checks.map((check) => ({ ...check, origin: 'remote-cache' })),
    }),
    (events: EventReport): EventReport => ({
      ...events,
      checks: events.checks.map((check) => ({ ...check, configuration: 'b'.repeat(64) })),
    }),
  ]) {
    const store = new MemoryLedger();
    const reservation = reserveTests(store, [A], true);
    const proof = evidence(reservation);
    expect(() =>
      admitTestReservation(store, reservation, proof.expected, [
        { events: mutation(proof.events), processExitCode: 0 },
      ]),
    ).toThrow();
    expect(() => reusableNonces(store.read(), [A])).toThrow();
  }
});

test('revocation during final admission CAS prevents old success from being published', () => {
  const store = new MemoryLedger();
  const attempt = reserveTests(store, [A], true);
  store.beforeExchange = () => reserveTests(store, [A], true);
  expect(() => pass(store, attempt)).toThrow('superseded');
  expect(store.read().ledger[A]?.state).toBe('pending');
  expect(store.read().ledger[A]?.nonce).not.toBe(attempt.snapshot.ledger[A]?.nonce);
});

test('a previously admitted epoch allows cached ordinary results without rotating other targets', () => {
  const store = new MemoryLedger();
  pass(store, reserveTests(store, [A], false));
  const before = store.read();
  const ordinary = reserveTests(store, [A], false);
  expect(ordinary.fresh).toEqual([]);
  const proof = evidence(ordinary);
  const cached: EventReport = {
    ...proof.events,
    checks: proof.events.checks.map((check) => ({ ...check, origin: 'remote-cache' })),
  };
  expect(
    admitTestReservation(store, ordinary, proof.expected, [{ events: cached, processExitCode: 0 }]),
  ).toEqual(before);
});

function matrixEvidence(reservation: TestReservation) {
  const proof = evidence(reservation);
  const first = proof.expected[0];
  if (first === undefined) throw new Error('Missing independently planned fixture expectations');
  const platforms = ['linux-x86_64', 'linux-arm64', 'darwin-arm64', 'darwin-x86_64'] as const;
  const expected: TestAdmissionExpectation[] = platforms.map((platform, index) => ({
    platform,
    invocation: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
    required: first.required,
    configurations: new Map(
      reservation.labels.map((label) => [label, String(index + 1).repeat(64)]),
    ),
  }));
  const completed: CompletedTestAdmission[] = expected.map((attempt) => ({
    processExitCode: 0,
    events: {
      ...proof.events,
      invocation: attempt.invocation,
      checks: proof.events.checks.map((check) => {
        const configuration = attempt.configurations.get(check.label);
        if (configuration === undefined) throw new Error('Missing fixture configuration');
        return { ...check, configuration };
      }),
    },
  }));
  return { expected, completed };
}

test('one controller admits all four platforms atomically and never promotes a partial matrix', () => {
  const store = new MemoryLedger();
  const reservation = reserveTests(store, [A, B], true);
  const proof = matrixEvidence(reservation);
  expect(() =>
    admitTestReservation(store, reservation, proof.expected, proof.completed.slice(0, 1)),
  ).toThrow('platform inventory');
  for (const label of [A, B]) {
    expect(store.read().ledger[label]?.state).toBe('pending');
    expect(store.read().ledger[label]?.nonce).not.toBe(reservation.snapshot.ledger[label]?.nonce);
  }
  expect(() => reusableNonces(store.read(), [A, B])).toThrow();
  expect(() => admitTestReservation(store, reservation, proof.expected, proof.completed)).toThrow();
  const retry = reserveTests(store, [A, B], true);
  const retryProof = matrixEvidence(retry);
  const admitted = admitTestReservation(store, retry, retryProof.expected, retryProof.completed);
  for (const label of [A, B]) {
    expect(admitted.ledger[label]?.state).toBe('ready');
    expect(admitted.ledger[label]?.nonce).toBe(retry.snapshot.ledger[label]?.nonce);
  }
});

test('missing, duplicate, extra and mismatched platform receipts cannot promote any matrix epoch', () => {
  for (const fault of [
    'duplicate-platform',
    'duplicate-invocation',
    'duplicate-report',
    'extra-report',
    'wrong-config',
    'cancelled',
    'failed',
  ]) {
    const store = new MemoryLedger();
    const reservation = reserveTests(store, [A, B], true);
    const proof = matrixEvidence(reservation);
    const firstExpected = proof.expected[0];
    const firstReport = proof.completed[0];
    const secondExpected = proof.expected[1];
    if (firstExpected === undefined || firstReport === undefined || secondExpected === undefined)
      throw new Error('Missing explicit matrix control');
    if (fault === 'duplicate-platform')
      proof.expected[1] = { ...secondExpected, platform: firstExpected.platform };
    if (fault === 'duplicate-invocation')
      proof.expected[1] = { ...secondExpected, invocation: firstExpected.invocation };
    if (fault === 'duplicate-report') proof.completed[1] = firstReport;
    if (fault === 'extra-report') proof.completed.push(firstReport);
    if (fault === 'wrong-config')
      proof.completed[0] = {
        ...firstReport,
        events: {
          ...firstReport.events,
          checks: firstReport.events.checks.map((check) => ({
            ...check,
            configuration: 'f'.repeat(64),
          })),
        },
      };
    if (fault === 'cancelled') proof.completed[0] = { ...firstReport, processExitCode: 130 };
    if (fault === 'failed')
      proof.completed[0] = {
        ...firstReport,
        events: {
          ...firstReport.events,
          exitCode: 1,
          checks: firstReport.events.checks.map((check) => ({ ...check, status: 'failed' })),
        },
      };
    expect(() =>
      admitTestReservation(store, reservation, proof.expected, proof.completed),
    ).toThrow();
    for (const label of [A, B]) {
      expect(store.read().ledger[label]?.state).toBe('pending');
      expect(store.read().ledger[label]?.nonce).not.toBe(reservation.snapshot.ledger[label]?.nonce);
    }
    expect(() => reusableNonces(store.read(), [A, B])).toThrow();
  }
});

test('a terminal failed or cancelled reservation can never admit a later success callback', () => {
  for (const processExitCode of [1, 130, null]) {
    const store = new MemoryLedger();
    const reservation = reserveTests(store, [A], true);
    const proof = evidence(reservation);
    expect(() =>
      admitTestReservation(store, reservation, proof.expected, [
        { events: proof.events, processExitCode },
      ]),
    ).toThrow();
    const rejected = store.read();
    expect(rejected.ledger[A]?.state).toBe('pending');
    expect(rejected.ledger[A]?.nonce).not.toBe(reservation.snapshot.ledger[A]?.nonce);
    expect(() =>
      admitTestReservation(store, reservation, proof.expected, [
        { events: proof.events, processExitCode: 0 },
      ]),
    ).toThrow('superseded');
    expect(store.read()).toEqual(rejected);
  }
});

test('malformed reservation inventories cannot promote or revoke unrelated targets', () => {
  const store = new MemoryLedger();
  reserveTests(store, [B], true);
  const reservation = reserveTests(store, [A], true);
  const proof = evidence(reservation);
  const before = store.read();
  for (const fresh of [[A, B], [A, A], [], [B]]) {
    const malformed = { ...reservation, fresh };
    expect(() =>
      admitTestReservation(store, malformed, proof.expected, [
        { events: proof.events, processExitCode: 0 },
      ]),
    ).toThrow('reservation');
    expect(store.read()).toEqual(before);
  }
});

test('ordinary required fresh checks rotate only their selected epochs', () => {
  const store = new MemoryLedger();
  const previous = store.read();
  store.compareExchange(
    previous,
    parseLedger({
      [A]: { nonce: 'a'.repeat(64), state: 'ready' },
      [B]: { nonce: 'b'.repeat(64), state: 'ready' },
    }),
  );
  const result = reserveTests(store, [A, B], false, [A]);
  expect(result.fresh).toEqual([A]);
  expect(result.snapshot.ledger[A]?.nonce).not.toBe('a'.repeat(64));
  expect(result.snapshot.ledger[B]).toEqual({ nonce: 'b'.repeat(64), state: 'ready' });
  expect(() => reserveTests(store, [A], false, [B])).toThrow('selected test inventory');
});

test('a reservation from a snapshot the run already read is still held to the authority', () => {
  const store = new MemoryLedger();
  let reads = 0;

  const counted: RevocationStore = {
    read: () => {
      reads++;

      return store.read();
    },
    compareExchange: (previous, ledger) => store.compareExchange(previous, ledger),
  };

  pass(store, reserveTests(store, [A, B], false));

  // A current snapshot is exchanged without another read.
  const current = store.read();
  const forced = reserveTests(counted, [A], true, [], current);

  expect(reads).toBe(0);
  expect(forced.fresh).toEqual([A]);
  pass(store, forced);

  // A snapshot the ledger has moved past is refused by the exchange, and the reservation is
  // made again on what the authority holds now.
  const stale = store.read();
  const other = reserveTests(store, [B], true);
  const retried = reserveTests(counted, [A], true, [], stale);

  expect(reads).toBe(1);
  expect(retried.snapshot.ledger[B]).toEqual(other.snapshot.ledger[B]);
  pass(store, { ...retried, labels: [A] });

  // A reservation that writes nothing is not exchanged; admission refuses it when the
  // authority has rotated one of its epochs since the snapshot.
  pass(store, reserveTests(store, [B], true));

  const ready = store.read();

  reserveTests(store, [A], true);

  const unchanged = reserveTests(counted, [A, B], false, [], ready);

  expect(unchanged.fresh).toEqual([]);
  expect(() => pass(store, unchanged)).toThrow('superseded');
});
