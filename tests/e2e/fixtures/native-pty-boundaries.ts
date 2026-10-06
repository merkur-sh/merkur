import type { NativePerfTraceRecord } from '../../../packages/shared/src/native-perf-trace';
import type { summarizeNativeDisplayBoundaries } from './native-display-boundaries';

type NativeRecord = NativePerfTraceRecord;
type NativeEvidence = Pick<
  ReturnType<typeof summarizeNativeDisplayBoundaries>,
  'nativeRecords' | 'exactJoinEligible' | 'errors'
>;
type WriteEndpoint = 'enqueue' | 'dequeue' | 'firstSyscall' | 'completion' | 'ownerHandled';
type ReadEndpoint = 'started' | 'returned' | 'ownerHandled' | 'gridApplied';
type IntervalStatus = 'complete' | 'missing' | 'duplicate' | 'negative';

interface Interval {
  readonly status: IntervalStatus;
  /** Signed evidence retained even when invalid; never clamp a negative interval. */
  readonly differenceUs: number | null;
  readonly valueUs: number | null;
  readonly fromOrdinals: readonly number[];
  readonly toOrdinals: readonly number[];
}

interface Operation<K extends string> {
  readonly owner: number;
  readonly operationOrdinal: number;
  readonly endpoints: Record<K, NativeRecord[]>;
}

const WRITE_ENDPOINTS = [
  'enqueue',
  'dequeue',
  'firstSyscall',
  'completion',
  'ownerHandled',
] as const;
function writeEndpoints(): Record<WriteEndpoint, NativeRecord[]> {
  return { enqueue: [], dequeue: [], firstSyscall: [], completion: [], ownerHandled: [] };
}
function readEndpoints(): Record<ReadEndpoint, NativeRecord[]> {
  return { started: [], returned: [], ownerHandled: [], gridApplied: [] };
}

/**
 * Cold, subset-only diagnostics over the display analyzer's validated merged
 * records. Independent exact PTY intervals remain useful if a display join is
 * incomplete. Neither these subsets nor zero missing endpoints prove complete
 * phase collection; preserve the parent capture/browser eligibility separately.
 */
export function summarizeNativePtyBoundaries(evidence: NativeEvidence) {
  const writes = new Map<string, Operation<WriteEndpoint>>();
  const reads = new Map<string, Operation<ReadEndpoint>>();
  const boundaryDiscards: NativeRecord[] = [];
  const unclassifiedRecords: NativeRecord[] = [];
  for (const record of evidence.nativeRecords) {
    const subkind = field(record, 0);
    if (record.kind === 'pty_boundary_discard') {
      boundaryDiscards.push(record);
      continue;
    }
    if (record.kind === 'pty_enqueue' && subkind === 0) {
      operation(writes, record, writeEndpoints).endpoints.enqueue.push(record);
    } else if (record.kind === 'pty_write' && subkind <= 3) {
      const endpoint = WRITE_ENDPOINTS[subkind + 1];
      if (endpoint !== undefined)
        operation(writes, record, writeEndpoints).endpoints[endpoint].push(record);
    } else if (record.kind === 'pty_read' && subkind <= 1) {
      operation(reads, record, readEndpoints).endpoints[
        subkind === 0 ? 'started' : 'returned'
      ].push(record);
    } else if (record.kind === 'pty_read_handled' && subkind <= 1) {
      operation(reads, record, readEndpoints).endpoints[
        subkind === 0 ? 'ownerHandled' : 'gridApplied'
      ].push(record);
    } else if (record.kind.startsWith('pty_')) {
      unclassifiedRecords.push(record);
    }
  }
  const writeOperations = [...writes.values()].map((write) => {
    const endpoints = write.endpoints;
    const enqueue = unique(endpoints.enqueue);
    const completion = unique(endpoints.completion);
    const source =
      enqueue === null
        ? 'unknown'
        : field(enqueue, 3) === 0
          ? 'userInput'
          : field(enqueue, 3) === 1
            ? 'terminalReply'
            : 'unknown';
    return {
      ...write,
      source,
      inputSeq: source === 'userInput' && enqueue !== null ? field(enqueue, 2) : null,
      queuedBytes: enqueue === null ? null : field(enqueue, 4),
      outstandingEntries: enqueue === null ? null : field(enqueue, 5),
      outstandingBytes: enqueue === null ? null : field(enqueue, 6),
      completion:
        completion === null
          ? null
          : {
              acceptedBytes: field(completion, 2),
              syscallCount: field(completion, 3),
              summedSyscallUs: field(completion, 4),
              success: field(completion, 5) === 1,
            },
      endpointIssues: endpointIssues(endpoints),
      intervals: {
        enqueueToDequeue: interval(endpoints.enqueue, endpoints.dequeue),
        dequeueToFirstSyscall: interval(endpoints.dequeue, endpoints.firstSyscall),
        firstSyscallToCompletion: interval(endpoints.firstSyscall, endpoints.completion),
        completionToOwner: interval(endpoints.completion, endpoints.ownerHandled),
        enqueueToCompletion: interval(endpoints.enqueue, endpoints.completion),
      },
    };
  });
  const readOperations = [...reads.values()].map((read) => ({
    ...read,
    endpointIssues: endpointIssues(read.endpoints),
    returnedBytes: unique(read.endpoints.returned)?.fields[2] ?? null,
    intervals: {
      readCall: interval(read.endpoints.started, read.endpoints.returned),
      readReturnToOwner: interval(read.endpoints.returned, read.endpoints.ownerHandled),
      ownerToGrid: interval(read.endpoints.ownerHandled, read.endpoints.gridApplied),
    },
  }));
  const summarizeWrites = (source: string) => {
    const population = writeOperations.filter((write) => write.source === source);
    return {
      operationCount: population.length,
      intervals: {
        enqueueToDequeue: intervalDistribution(
          population.map((write) => write.intervals.enqueueToDequeue),
        ),
        dequeueToFirstSyscall: intervalDistribution(
          population.map((write) => write.intervals.dequeueToFirstSyscall),
        ),
        firstSyscallToCompletion: intervalDistribution(
          population.map((write) => write.intervals.firstSyscallToCompletion),
        ),
        completionToOwner: intervalDistribution(
          population.map((write) => write.intervals.completionToOwner),
        ),
        enqueueToCompletion: intervalDistribution(
          population.map((write) => write.intervals.enqueueToCompletion),
        ),
      },
      summedSyscallUs: distribution(
        population.flatMap((write) =>
          write.completion === null ? [] : [write.completion.summedSyscallUs],
        ),
      ),
      syscallCompletionCount: population.filter((write) => write.completion !== null).length,
      unsuccessfulCompletionCount: population.filter((write) => write.completion?.success === false)
        .length,
    };
  };
  return {
    diagnosticOnly: true,
    population: 'observed exact PTY operation subsets; not full-phase eligibility',
    interpretation:
      'Owner plus physical operation ordinal owns every join. No input-to-read/echo attribution. Queue counts include completions awaiting owner handling. Read-call time includes waiting for output; writer envelopes include pacing and observer work, while summed syscall time uses actual call boundaries. Missing, duplicate and negative endpoints remain witnesses and never become zero-latency samples.',
    sourceDisplayJoin: { exactJoinEligible: evidence.exactJoinEligible, errors: evidence.errors },
    writeOperations,
    readOperations,
    boundaryDiscards,
    unclassifiedRecords,
    distributions: {
      userInput: summarizeWrites('userInput'),
      terminalReply: summarizeWrites('terminalReply'),
      unknownWriteSource: summarizeWrites('unknown'),
      reads: {
        operationCount: readOperations.length,
        readCall: intervalDistribution(readOperations.map((read) => read.intervals.readCall)),
        readReturnToOwner: intervalDistribution(
          readOperations.map((read) => read.intervals.readReturnToOwner),
        ),
        ownerToGrid: intervalDistribution(readOperations.map((read) => read.intervals.ownerToGrid)),
      },
    },
  };
}

function operation<K extends string>(
  operations: Map<string, Operation<K>>,
  record: NativeRecord,
  createEndpoints: () => Record<K, NativeRecord[]>,
): Operation<K> {
  const operationOrdinal = field(record, 1);
  const key = `${record.owner}:${operationOrdinal}`;
  let result = operations.get(key);
  if (result === undefined) {
    const endpoints = createEndpoints();
    result = { owner: record.owner, operationOrdinal, endpoints };
    operations.set(key, result);
  }
  return result;
}

function unique(records: readonly NativeRecord[]): NativeRecord | null {
  return records.length === 1 ? (records[0] ?? null) : null;
}

function endpointIssues(endpoints: Record<string, NativeRecord[]>) {
  return Object.entries(endpoints).flatMap(([endpoint, records]) =>
    records.length === 1
      ? []
      : [
          {
            endpoint,
            status: records.length === 0 ? 'missing' : 'duplicate',
            recordOrdinals: records.map((record) => record.ordinal),
          },
        ],
  );
}

function interval(from: readonly NativeRecord[], to: readonly NativeRecord[]): Interval {
  const start = unique(from);
  const end = unique(to);
  const differenceUs = start === null || end === null ? null : end.at_us - start.at_us;
  const status: IntervalStatus =
    from.length > 1 || to.length > 1
      ? 'duplicate'
      : differenceUs === null
        ? 'missing'
        : differenceUs < 0
          ? 'negative'
          : 'complete';
  return {
    status,
    differenceUs,
    valueUs: status === 'complete' ? differenceUs : null,
    fromOrdinals: from.map((record) => record.ordinal),
    toOrdinals: to.map((record) => record.ordinal),
  };
}

function intervalDistribution(intervals: readonly Interval[]) {
  return {
    observedOperationCount: intervals.length,
    excluded: {
      missing: intervals.filter((value) => value.status === 'missing').length,
      duplicate: intervals.filter((value) => value.status === 'duplicate').length,
      negative: intervals.filter((value) => value.status === 'negative').length,
    },
    ...distribution(intervals.flatMap((value) => (value.valueUs === null ? [] : [value.valueUs]))),
  };
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (quantile: number): number | null => {
    if (sorted.length === 0) return null;
    return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
  };
  return {
    sampleCount: sorted.length,
    unit: 'microseconds',
    percentileMethod: 'nearest-rank',
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
  };
}

function field(record: NativeRecord, index: number): number {
  const value = record.fields[index];
  if (value === undefined) throw new Error(`missing validated native field ${index}`);
  return value;
}
