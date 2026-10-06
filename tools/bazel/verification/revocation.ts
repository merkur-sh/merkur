import { randomBytes } from 'node:crypto';
import type { EventReport, RequiredCheck } from './events';

export interface TestEpoch {
  readonly nonce: string;
  readonly state: 'pending' | 'ready';
}

export type RevocationLedger = Readonly<Record<string, TestEpoch>>;

export interface LedgerSnapshot {
  readonly revision: string;
  readonly ledger: RevocationLedger;
}

/** Compare-and-exchange is supplied by an authoritative Git ref, never the action cache. */
export interface RevocationStore {
  read(): LedgerSnapshot;
  compareExchange(previous: LedgerSnapshot, ledger: RevocationLedger): LedgerSnapshot | null;
}

export interface TestReservation {
  readonly snapshot: LedgerSnapshot;
  readonly labels: readonly string[];
  readonly fresh: readonly string[];
}

export interface TestAdmissionExpectation {
  readonly platform: 'darwin-arm64' | 'darwin-x86_64' | 'linux-arm64' | 'linux-x86_64';
  readonly invocation: string;
  readonly required: readonly RequiredCheck[];
  readonly configurations: ReadonlyMap<string, string>;
}

export interface CompletedTestAdmission {
  readonly events: EventReport;
  readonly processExitCode: number | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function testLabel(value: string): boolean {
  return /^\/\/[^:\s\\\0]*:[^:\s\\\0]+$/.test(value);
}

function inventory(labels: readonly string[]): readonly string[] {
  if (
    labels.length === 0 ||
    labels.some((label) => !testLabel(label)) ||
    new Set(labels).size !== labels.length
  )
    throw new Error('Revocation requires a nonempty unique canonical test inventory');
  return [...labels].sort();
}

function validateReservation(reservation: TestReservation): void {
  const labels = inventory(reservation.labels);
  const ledger = parseLedger(reservation.snapshot.ledger);
  if (
    JSON.stringify(labels) !== JSON.stringify(reservation.labels) ||
    new Set(reservation.fresh).size !== reservation.fresh.length ||
    reservation.fresh.some((label) => !labels.includes(label)) ||
    labels.some((label) => ledger[label] === undefined) ||
    JSON.stringify(labels.filter((label) => ledger[label]?.state === 'pending')) !==
      JSON.stringify(reservation.fresh)
  )
    throw new Error('The reservation must bind exactly its selected pending and ready epochs');
}

/** Canonical bytes are the ledger's Git blob; test nonces contain no credentials or verdicts. */
export function ledgerBytes(ledger: RevocationLedger): string {
  const checked = parseLedger(ledger);
  return JSON.stringify(checked) + '\n';
}

export function parseLedger(value: unknown): RevocationLedger {
  if (!object(value)) throw new Error('Revocation ledger must be a target map');
  const entries: Record<string, TestEpoch> = Object.create(null);
  const nonces = new Set<string>();
  for (const label of Object.keys(value).sort()) {
    const epoch = value[label];
    if (
      !testLabel(label) ||
      !object(epoch) ||
      Object.keys(epoch).sort().join(',') !== 'nonce,state' ||
      typeof epoch.nonce !== 'string' ||
      !/^[a-f0-9]{64}$/.test(epoch.nonce) ||
      (epoch.state !== 'pending' && epoch.state !== 'ready') ||
      nonces.has(epoch.nonce)
    )
      throw new Error('Revocation ledger contains an invalid or duplicate test epoch');
    nonces.add(epoch.nonce);
    entries[label] = Object.freeze({
      nonce: epoch.nonce,
      state: epoch.state,
    });
  }
  return Object.freeze(entries);
}

/** Populate complete query inventory before analysis, without rotating another active attempt. */
export function initializeTestInventory(
  store: RevocationStore,
  labels: readonly string[],
): LedgerSnapshot {
  const complete = inventory(labels);
  for (;;) {
    const previous = store.read();
    const ledger: Record<string, TestEpoch> = { ...parseLedger(previous.ledger) };
    const used = new Set(Object.values(ledger).map((epoch) => epoch.nonce));
    let changed = false;
    for (const label of complete) {
      if (ledger[label] !== undefined) continue;
      const nonce = randomBytes(32).toString('hex');
      if (used.has(nonce)) throw new Error('Random test nonce collided with an existing epoch');
      used.add(nonce);
      ledger[label] = { nonce, state: 'pending' };
      changed = true;
    }
    if (!changed) return previous;
    const initialized = store.compareExchange(previous, parseLedger(ledger));
    if (initialized !== null) return initialized;
  }
}

/**
 * Publish pending epochs before executing. Retrying pending work always gets a new nonce.
 *
 * `known` is a snapshot this run has already read. A reservation that writes is exchanged
 * against it, so the authority refuses it if the ledger has moved, and one that writes nothing
 * is checked against the authority at admission; neither needs the ledger read again first.
 */
export function reserveTests(
  store: RevocationStore,
  labels: readonly string[],
  force: boolean,
  requiredFresh: readonly string[] = [],
  known?: LedgerSnapshot,
): TestReservation {
  const selected = inventory(labels);
  const mustRun = new Set(requiredFresh);
  if (
    mustRun.size !== requiredFresh.length ||
    requiredFresh.some((label) => !selected.includes(label))
  )
    throw new Error('Fresh execution must belong to the selected test inventory');

  for (let previous = known ?? store.read(); ; previous = store.read()) {
    const ledger: Record<string, TestEpoch> = { ...parseLedger(previous.ledger) };
    const fresh: string[] = [];
    const used = new Set(Object.values(ledger).map((epoch) => epoch.nonce));
    for (const label of selected) {
      if (!force && !mustRun.has(label) && ledger[label]?.state === 'ready') continue;
      const nonce = randomBytes(32).toString('hex');
      if (used.has(nonce)) throw new Error('Random test nonce collided with an existing epoch');
      used.add(nonce);
      ledger[label] = { nonce, state: 'pending' };
      fresh.push(label);
    }
    if (fresh.length === 0) return { snapshot: previous, labels: selected, fresh };
    const snapshot = store.compareExchange(previous, parseLedger(ledger));
    if (snapshot !== null) return { snapshot, labels: selected, fresh };
  }
}

/** A ready epoch is the only epoch for which a subsequent invocation may reuse a pass. */
export function reusableNonces(
  snapshot: LedgerSnapshot,
  labels: readonly string[],
): Readonly<Record<string, string>> {
  const ledger = parseLedger(snapshot.ledger);
  const result: Record<string, string> = Object.create(null);
  for (const label of inventory(labels)) {
    const epoch = ledger[label];
    if (epoch?.state !== 'ready')
      throw new Error('Test epoch is revoked or has never been admitted');
    result[label] = epoch.nonce;
  }
  return Object.freeze(result);
}

/**
 * The tests every planned attempt reports as an exact pass: complete events, the planned
 * invocation and configuration, and a real execution wherever one was required.
 */
export function passedTests(
  reservation: TestReservation,
  expected: readonly TestAdmissionExpectation[],
  completed: readonly CompletedTestAdmission[],
): readonly string[] {
  if (expected.length === 0 || completed.length !== expected.length) return [];
  return reservation.labels.filter((label) =>
    expected.every((attempt) => {
      const report = completed.find((entry) => entry.events.invocation === attempt.invocation);
      const check = attempt.required.find((entry) => entry.label === label);
      const result = report?.events.checks.find((entry) => entry.label === label);
      return (
        report !== undefined &&
        report.events.complete &&
        report.events.problems.length === 0 &&
        report.events.buildToolVersion === '9.2.0' &&
        report.processExitCode === report.events.exitCode &&
        check?.kind === 'test' &&
        result?.status === 'passed' &&
        result.kind === 'test' &&
        result.configuration === attempt.configurations.get(label) &&
        (result.origin === 'executed' || !(reservation.fresh.includes(label) || check.fresh))
      );
    }),
  );
}

/**
 * Consume failed/cancelled authority; old callbacks can never admit a retired nonce. A test
 * named in `passed` keeps its epoch, ready: its pass stands whatever its siblings did. Every
 * other selected epoch is retired, a ready one included: an observed failure revokes the
 * earlier pass.
 */
export function rejectTestReservation(
  store: RevocationStore,
  reservation: TestReservation,
  passed: readonly string[] = [],
): void {
  validateReservation(reservation);
  for (;;) {
    const previous = store.read();
    const ledger: Record<string, TestEpoch> = { ...parseLedger(previous.ledger) };
    let changed = false;
    const used = new Set(Object.values(ledger).map((epoch) => epoch.nonce));
    for (const label of reservation.labels) {
      const epoch = ledger[label];
      if (epoch === undefined || epoch.nonce !== reservation.snapshot.ledger[label]?.nonce)
        continue;
      if (passed.includes(label)) {
        if (epoch.state !== 'ready') {
          ledger[label] = { nonce: epoch.nonce, state: 'ready' };
          changed = true;
        }
        continue;
      }
      const nonce = randomBytes(32).toString('hex');
      if (used.has(nonce)) throw new Error('Random test nonce collided with an existing epoch');
      used.add(nonce);
      ledger[label] = { nonce, state: 'pending' };
      changed = true;
    }
    if (!changed || store.compareExchange(previous, parseLedger(ledger)) !== null) return;
  }
}

/** One controller supplies its independently captured plan and all source/graph-admitted reports. */
export function admitTestReservation(
  store: RevocationStore,
  reservation: TestReservation,
  expected: readonly TestAdmissionExpectation[],
  completed: readonly CompletedTestAdmission[],
): LedgerSnapshot {
  validateReservation(reservation);
  try {
    return admitCompletedReservation(store, reservation, expected, completed);
  } catch (error) {
    rejectTestReservation(store, reservation);
    throw error;
  }
}

function admitCompletedReservation(
  store: RevocationStore,
  reservation: TestReservation,
  expected: readonly TestAdmissionExpectation[],
  completed: readonly CompletedTestAdmission[],
): LedgerSnapshot {
  const platforms = new Set(['darwin-arm64', 'darwin-x86_64', 'linux-arm64', 'linux-x86_64']);
  const labels = new Set(
    expected.flatMap((attempt) =>
      attempt.required.filter((check) => check.kind === 'test').map((check) => check.label),
    ),
  );
  if (
    expected.length === 0 ||
    new Set(expected.map((attempt) => attempt.platform)).size !== expected.length ||
    expected.some((attempt) => !platforms.has(attempt.platform)) ||
    new Set(expected.map((attempt) => attempt.invocation)).size !== expected.length ||
    expected.some((attempt) => attempt.invocation === '') ||
    completed.length !== expected.length ||
    new Set(completed.map((attempt) => attempt.events.invocation)).size !== completed.length ||
    JSON.stringify([...labels].sort()) !== JSON.stringify(reservation.labels)
  )
    throw new Error('Admission requires the complete independently planned platform inventory');
  for (const attempt of expected) {
    const report = completed.find((entry) => entry.events.invocation === attempt.invocation);
    if (report === undefined)
      throw new Error('Admission is missing an independently planned platform invocation');
    validateCompletedInvocation(reservation, attempt, report);
  }
  // No platform promotes independently: every planned receipt validates before the first write.
  for (;;) {
    const current = store.read();
    const ledger: Record<string, TestEpoch> = { ...parseLedger(current.ledger) };
    for (const label of reservation.labels) {
      const attempted = reservation.snapshot.ledger[label];
      const actual = ledger[label];
      if (
        attempted === undefined ||
        actual?.nonce !== attempted.nonce ||
        actual.state !== attempted.state
      )
        throw new Error('A newer revocation superseded this verification attempt');
    }
    if (reservation.fresh.length === 0) return current;
    for (const label of reservation.fresh) {
      const epoch = ledger[label];
      if (epoch === undefined) throw new Error('Reserved test epoch disappeared');
      ledger[label] = { nonce: epoch.nonce, state: 'ready' };
    }
    const admitted = store.compareExchange(current, parseLedger(ledger));
    if (admitted !== null) {
      const confirmed = store.read();
      for (const label of reservation.labels) {
        if (
          confirmed.ledger[label]?.nonce !== admitted.ledger[label]?.nonce ||
          confirmed.ledger[label]?.state !== 'ready'
        )
          throw new Error('A newer revocation superseded this verification admission');
      }
      return confirmed;
    }
  }
}

function validateCompletedInvocation(
  reservation: TestReservation,
  expected: TestAdmissionExpectation,
  completed: CompletedTestAdmission,
): void {
  const { events, processExitCode } = completed;
  const required = expected.required;
  if (
    required.length === 0 ||
    new Set(required.map((check) => check.label)).size !== required.length ||
    events.invocation !== expected.invocation ||
    events.buildToolVersion !== '9.2.0' ||
    !events.complete ||
    processExitCode !== 0 ||
    events.exitCode !== 0 ||
    events.problems.length !== 0 ||
    events.checks.length !== required.length ||
    new Set(events.checks.map((check) => check.label)).size !== required.length
  )
    throw new Error('Incomplete or failed verification cannot admit test epochs');
  for (const check of required) {
    const result = events.checks.find((entry) => entry.label === check.label);
    const configuration = expected.configurations.get(check.label);
    if (
      result?.status !== 'passed' ||
      result.kind !== check.kind ||
      configuration === undefined ||
      result.configuration !== configuration ||
      (check.kind === 'test' &&
        (reservation.fresh.includes(check.label) || check.fresh) &&
        result.origin !== 'executed')
    )
      throw new Error('Admission requires every exact check and fresh execution of pending epochs');
  }
}
