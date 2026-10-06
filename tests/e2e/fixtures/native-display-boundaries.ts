import type { TerminalPerfEvent } from '../../../apps/web/src/perf/terminal-latency';
import {
  createNativePerfTraceValidator,
  type NativePerfTraceRecord,
} from '../../../packages/shared/src/native-perf-trace';
import type { DaemonPerfTraceCapture } from './daemon-perf-trace-capture';

type NativeRecord = NativePerfTraceRecord;
type Applied = Extract<TerminalPerfEvent, { kind: 'worker_display_applied' }>;
type Receipt = Extract<TerminalPerfEvent, { kind: 'display_received' }>;
type Commit = Extract<TerminalPerfEvent, { kind: 'presentation_commit' }>;

interface PhysicalCopy {
  readonly queue: NativeRecord;
  packetized: NativeRecord | null;
  attempt: NativeRecord | null;
  readonly outcomes: NativeRecord[];
}

/** Cold startup proof retained before per-workload recorder resets. */
export function resolveNativeBrowserSessionBinding(events: readonly TerminalPerfEvent[]) {
  const starts = events.flatMap((event, ordinal) =>
    event.kind === 'session_start' ? [{ event, ordinal }] : [],
  );
  const start = starts.reduce<(typeof starts)[number] | null>(
    (latest, next) => (latest === null || next.event.atMs > latest.event.atMs ? next : latest),
    null,
  );
  if (start === null) throw new Error('browser session binding lacks its startup namespace');
  const bindings = events.flatMap((event, ordinal) =>
    event.kind === 'session_bound' && event.atMs >= start.event.atMs ? [{ event, ordinal }] : [],
  );
  const binding = bindings[0];
  if (
    bindings.length !== 1 ||
    binding === undefined ||
    binding.event.merkurSessionId.length === 0
  ) {
    throw new Error('browser startup namespace lacks one exact session_bound identity');
  }
  return { sessionId: binding.event.merkurSessionId, start, binding };
}

/**
 * Cold diagnostic joins, not a replacement for the browser acceptance oracle.
 * All clocks remain in their own domains. Packetized is NOT a socket send.
 */
export function summarizeNativeDisplayBoundaries(
  nativeCaptures: readonly DaemonPerfTraceCapture[],
  events: readonly TerminalPerfEvent[],
  browserSessionId: string,
) {
  const errors: string[] = [];
  if (nativeCaptures.length === 0 || nativeCaptures.length > 4)
    throw new Error('native join requires one to four explicitly selected captures');
  const owner = nativeCaptures[0]?.chunks[0];
  if (owner === undefined) throw new Error('native capture has no owner metadata');
  const recordsByOrdinal = new Map<number, NativeRecord>();
  for (const native of nativeCaptures) {
    const validator = createNativePerfTraceValidator(native.commandId ?? '');
    if (!native.chunks.every((chunk) => validator.accept(chunk)) || !validator.complete) {
      errors.push('native chunks fail complete ordered export validation');
    }
    if (native.status !== 'complete') errors.push('native export is incomplete');
    if (native.chunks.length === 0) errors.push('native capture has no owner metadata');
    if (native.chunks.some((chunk) => chunk.dropped !== 0))
      errors.push('native collection contains dropped current-owner records');
    if (
      browserSessionId.length === 0 ||
      native.chunks.some((chunk) => chunk.session_id !== browserSessionId)
    ) {
      errors.push('browser/native session binding is absent or mismatched');
    }
    for (const chunk of native.chunks) {
      if (
        chunk.owner !== owner.owner ||
        chunk.session_id !== owner.session_id ||
        chunk.peer_id !== owner.peer_id ||
        chunk.observation_epoch !== owner.observation_epoch
      ) {
        errors.push('native captures cross owner/session/observation identity');
        continue;
      }
      for (const record of chunk.records) {
        const previous = recordsByOrdinal.get(record.ordinal);
        if (
          previous !== undefined &&
          (previous.kind !== record.kind ||
            previous.at_us !== record.at_us ||
            previous.owner !== record.owner ||
            previous.fields.some((value, index) => value !== record.fields[index]))
        ) {
          errors.push(`conflicting duplicate native ordinal ${record.ordinal}`);
        } else recordsByOrdinal.set(record.ordinal, record);
      }
    }
  }
  const records = [...recordsByOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
  const copies: PhysicalCopy[] = [];
  const queueByConnectionTag = new Map<string, PhysicalCopy[]>();
  const copiesByTag = new Map<string, PhysicalCopy[]>();
  const packetCopies = new Map<string, PhysicalCopy[]>();
  const unmatchedPacketizations: NativeRecord[] = [];
  const unrelatedPacketOutcomes: NativeRecord[] = [];
  const outcomeRecords: NativeRecord[] = [];
  for (const record of records) {
    if (record.kind !== 'quic_datagram') continue;
    const phase = field(record, 0);
    const connection = field(record, 1);
    const packet = field(record, 2);
    if (phase === 2 || phase === 3) {
      outcomeRecords.push(record);
      continue;
    }
    if (phase !== 0 && phase !== 1) {
      errors.push(`unknown QUIC phase at native ordinal ${record.ordinal}`);
      continue;
    }
    const tag = tagKey(record, 5);
    const key = `${connection}:${tag}`;
    if (phase === 0) {
      const copy: PhysicalCopy = { queue: record, packetized: null, attempt: null, outcomes: [] };
      copies.push(copy);
      append(queueByConnectionTag, key, copy);
      append(copiesByTag, tag, copy);
      continue;
    }
    const pending = queueByConnectionTag.get(key);
    const copy = pending?.shift();
    if (copy === undefined || packet === 0) {
      unmatchedPacketizations.push(record);
      continue;
    }
    copy.packetized = record;
    if (record.at_us < copy.queue.at_us)
      errors.push(`negative queue interval at ${record.ordinal}`);
    append(packetCopies, `${connection}:${packet}`, copy);
  }
  for (const outcome of outcomeRecords) {
    const owned = packetCopies.get(`${field(outcome, 1)}:${field(outcome, 2)}`);
    if (owned === undefined) unrelatedPacketOutcomes.push(outcome);
    else for (const copy of owned) copy.outcomes.push(outcome);
  }
  const attempts = records
    .filter((record) => record.kind === 'display_attempt')
    .map((record) => {
      const accepted = field(record, 5) === 1;
      const candidates = (copiesByTag.get(tagKey(record, 10)) ?? []).filter(
        (copy) =>
          // Sequential replica calls can share a microsecond boundary. A
          // prior unique assignment already owns its queue copy; reusing it
          // would invent ambiguity (or queue evidence for a refused call).
          copy.attempt === null &&
          copy.queue.at_us >= field(record, 4) &&
          copy.queue.at_us <= record.at_us &&
          copy.queue.ordinal < record.ordinal,
      );
      const copy = accepted && candidates.length === 1 ? candidates[0] : null;
      if (copy !== null && copy !== undefined) copy.attempt = record;
      const joinError =
        accepted && (copy === null || copy === undefined)
          ? `accepted attempt ${record.ordinal} has ${candidates.length} unambiguous queue candidates`
          : !accepted && candidates.length !== 0
            ? `refused attempt ${record.ordinal} unexpectedly owns queue evidence`
            : null;
      if (joinError !== null) errors.push(joinError);
      return {
        record,
        generation: field(record, 1),
        displaySeq: field(record, 0),
        role: field(record, 2),
        carrier: field(record, 3),
        accepted,
        copy: copy ?? null,
        candidateQueueOrdinals: candidates.map((candidate) => candidate.queue.ordinal),
        joinError,
        callDurationUs: record.at_us - field(record, 4),
        queueToPacketizedUs:
          copy?.packetized === null || copy?.packetized === undefined
            ? null
            : copy.packetized.at_us - copy.queue.at_us,
      };
    });
  const attemptsBySequence = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    if (attempt.role !== 2)
      append(attemptsBySequence, `${attempt.generation}:${attempt.displaySeq}`, attempt);
  }

  const memberRecords = new Map<string, NativeRecord[]>();
  const receipts = new Map<string, { event: Receipt; ordinal: number }[]>();
  const applications = new Map<string, { event: Applied; ordinal: number }[]>();
  const commits = new Map<string, { event: Commit; ordinal: number }[]>();
  for (const record of records) {
    if (record.kind === 'display_member') append(memberRecords, nativeFrameKey(record), record);
  }
  for (let ordinal = 0; ordinal < events.length; ordinal += 1) {
    const event = events[ordinal];
    if (event?.kind === 'display_received')
      append(receipts, browserFrameKey(event), { event, ordinal });
    if (event?.kind === 'worker_display_applied')
      append(applications, browserFrameKey(event), { event, ordinal });
    if (event?.kind === 'presentation_commit')
      append(commits, `${event.generation}:${event.transactionSeq}`, { event, ordinal });
  }
  const groups = new Map<
    string,
    {
      generation: number;
      presentationId: number;
      members: {
        prepared: NativeRecord[];
        attempts: typeof attempts;
        receipts: { event: Receipt; ordinal: number }[];
        applications: { event: Applied; ordinal: number }[];
        commits: { event: Commit; ordinal: number }[];
      }[];
    }
  >();
  const unmatchedBrowserMutations: { event: Applied; ordinal: number }[] = [];
  for (const [key, applied] of applications) {
    const mutating = applied.filter(({ event }) => event.authoritativeVisualMutation === true);
    if (mutating.length > 0 && !memberRecords.has(key)) unmatchedBrowserMutations.push(...mutating);
  }
  for (const [key, prepared] of memberRecords) {
    const first = prepared[0];
    if (first === undefined) continue;
    if (
      prepared.some((record) => record.fields.some((value, index) => value !== first.fields[index]))
    ) {
      errors.push(`conflicting prepared member identity ${key}`);
    }
    const memberApplications = applications.get(key) ?? [];
    const memberReceipts = receipts.get(key) ?? [];
    const memberAttempts = attemptsBySequence.get(`${field(first, 1)}:${field(first, 0)}`) ?? [];
    const memberCommits: { event: Commit; ordinal: number }[] = [];
    for (const { event } of memberApplications) {
      if (
        event.presentationId !== field(first, 3) ||
        event.presentationMemberIndex !== field(first, 4) ||
        event.presentationMemberCount !== field(first, 5)
      )
        errors.push(`browser/native member mismatch ${key}`);
      if (!event.authoritativeVisualMutation || event.presentationTransactionSeq === 0) continue;
      const exact = commits.get(`${event.generation}:${event.presentationTransactionSeq}`) ?? [];
      if (exact.length !== 1 || exact[0]?.event.authoritativeVisualChange !== true) {
        errors.push(`mutating member ${key} has no unique screen-changing commit`);
      } else if (!memberCommits.some((commit) => commit.ordinal === exact[0]?.ordinal)) {
        memberCommits.push(exact[0]);
      }
    }
    const groupKey = `${field(first, 1)}:${field(first, 3)}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = { generation: field(first, 1), presentationId: field(first, 3), members: [] };
      groups.set(groupKey, group);
    }
    group.members.push({
      prepared,
      attempts: memberAttempts,
      receipts: memberReceipts,
      applications: memberApplications,
      commits: memberCommits,
    });
  }
  const presentations = [...groups.values()].map((group) => {
    const memberCounts = new Set(
      group.members.flatMap((member) => member.prepared.map((record) => field(record, 5))),
    );
    const memberIndices = new Set(
      group.members.flatMap((member) => member.prepared.map((record) => field(record, 4))),
    );
    const expectedMemberCount = [...memberCounts][0] ?? 0;
    const nativeMembershipComplete =
      memberCounts.size === 1 &&
      expectedMemberCount > 0 &&
      group.members.length === expectedMemberCount &&
      memberIndices.size === expectedMemberCount &&
      [...memberIndices].every((index) => index < expectedMemberCount);
    const rowMembers = group.members.filter((member) =>
      member.applications.some(
        ({ event }) => event.authoritativeVisualMutation === true && event.rowCount > 0,
      ),
    );
    const rowAttempts = rowMembers.flatMap((member) =>
      member.attempts.filter((attempt) => attempt.accepted),
    );
    const visualCommits = [
      ...new Map(
        rowMembers.flatMap((member) => member.commits).map((commit) => [commit.ordinal, commit]),
      ).values(),
    ];
    const memberFirstAdmissions = rowMembers.map((member) =>
      minimum(
        member.attempts.flatMap((attempt) =>
          attempt.copy === null ? [] : [attempt.copy.queue.at_us],
        ),
      ),
    );
    const memberFirstPacketizations = rowMembers.map((member) =>
      minimum(
        member.attempts.flatMap((attempt) =>
          attempt.copy?.packetized === null || attempt.copy?.packetized === undefined
            ? []
            : [attempt.copy.packetized.at_us],
        ),
      ),
    );
    const allObservedMutationsJoined = rowMembers.every(
      (member) =>
        member.receipts.length === 1 &&
        member.commits.length > 0 &&
        member.attempts.some(
          (attempt) =>
            attempt.accepted &&
            attempt.copy?.packetized !== null &&
            attempt.copy?.packetized !== undefined,
        ),
    );
    const unreceivedAdmittedMembers = group.members.filter(
      (member) =>
        member.attempts.some((attempt) => attempt.accepted) && member.receipts.length === 0,
    );
    const browserMembershipComplete =
      nativeMembershipComplete &&
      group.members.every(
        (member) =>
          member.receipts.length === 1 && member.attempts.some((attempt) => attempt.accepted),
      );
    return {
      ...group,
      nativeMembershipComplete,
      allObservedMutationsJoined,
      browserMembershipComplete,
      coherentPresentationEvidenceComplete: browserMembershipComplete && allObservedMutationsJoined,
      unreceivedAdmittedMembers,
      observedMutatingRowMemberCount: rowMembers.length,
      preparedToLastAttemptCompletionUs:
        rowAttempts.length === 0
          ? null
          : Math.max(...rowAttempts.map((attempt) => attempt.record.at_us)) -
            Math.min(
              ...rowMembers.flatMap((member) => member.prepared.map((record) => record.at_us)),
            ),
      firstAdmissionSpanUs: span(memberFirstAdmissions),
      firstPacketizationSpanUs: span(memberFirstPacketizations),
      browserReceiptSpanMs: span(
        rowMembers.map((member) => minimum(member.receipts.map(({ event }) => event.atMs))),
      ),
      screenChangingSubmissionExposureMs: span(visualCommits.map(({ event }) => event.atMs)),
      visualCommits,
    };
  });
  if (unmatchedPacketizations.length > 0)
    errors.push('packetized datagrams lack observed queue predecessors');
  if (unmatchedBrowserMutations.length > 0)
    errors.push('browser mutations lack native member identity');
  if (
    presentations.some(
      (group) => group.observedMutatingRowMemberCount > 0 && !group.allObservedMutationsJoined,
    )
  ) {
    errors.push('observed mutating members have incomplete native/browser joins');
  }
  return {
    schemaVersion: 1,
    diagnosticOnly: true,
    exactJoinEligible: errors.length === 0,
    errors,
    interpretation:
      'Native call/admission/packet construction and browser receipt/submission spans are separate clocks. No physical send, one-way transit, compositor or photon claim. Earliest physical copies do not identify the browser winning replica.',
    nativeOwner: {
      owner: owner.owner,
      peerId: owner.peer_id,
      sessionId: owner.session_id,
      observationEpoch: owner.observation_epoch,
    },
    nativeCaptures: nativeCaptures.map((capture) => ({
      commandId: capture.commandId,
      firstOrdinal: capture.chunks[0]?.first_ordinal,
      lastOrdinal: capture.chunks[0]?.last_ordinal,
      dropped: capture.chunks[0]?.dropped,
      stalePreviousObservationRecords: capture.chunks[0]?.stale,
    })),
    browserSessionId,
    attempts,
    copies,
    presentations,
    unmatchedPacketizations,
    unmatchedBrowserMutations,
    unrelatedPacketOutcomes,
    nonDisplayCopies: copies.filter((copy) => copy.attempt === null),
    unattributedCarrierStates: records.filter((record) => record.kind === 'carrier_state'),
    nativeRecords: records,
  };
}

function field(record: NativeRecord, index: number): number {
  const value = record.fields[index];
  if (value === undefined) throw new Error(`missing native field ${index}`);
  return value;
}
function tagKey(record: NativeRecord, start: number): string {
  return [0, 1, 2, 3].map((offset) => field(record, start + offset)).join(':');
}
function nativeFrameKey(record: NativeRecord): string {
  return `${field(record, 1)}:${field(record, 0)}:${field(record, 2)}:0:1`;
}
function browserFrameKey(event: Receipt | Applied): string {
  return `${event.generation}:${event.displaySeq}:${event.frameId}:${event.chunkIndex}:${event.chunkCount}`;
}
function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key);
  if (values === undefined) map.set(key, [value]);
  else values.push(value);
}
function minimum(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}
function span(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  const present = values.filter((value): value is number => value !== null);
  return Math.max(...present) - Math.min(...present);
}
