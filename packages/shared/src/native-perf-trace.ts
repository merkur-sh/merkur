import { hasExactKeys } from './parsing';

export const NATIVE_PERF_TRACE_MAX_RECORDS = 16_384;
export const NATIVE_PERF_TRACE_CHUNK_RECORDS = 128;
export const NATIVE_PERF_TRACE_KINDS = [
  'pty_enqueue',
  'pty_write',
  'pty_read',
  'pty_read_handled',
  'pty_boundary_discard',
  'display_member',
  'display_attempt',
  'carrier_state',
  'quic_datagram',
] as const;

export interface NativePerfTraceRecord {
  readonly ordinal: number;
  readonly owner: number;
  /** Process-monotonic microseconds, never browser epoch milliseconds. */
  readonly at_us: number;
  readonly kind: (typeof NATIVE_PERF_TRACE_KINDS)[number];
  readonly fields: readonly number[];
}

export interface NativePerfTraceChunk {
  readonly command_id: string;
  readonly owner: number;
  readonly peer_id: string;
  readonly session_id: string;
  readonly observation_epoch: number;
  readonly attempted: number;
  readonly dropped: number;
  readonly stale: number;
  readonly record_count: number;
  readonly first_ordinal: number;
  readonly last_ordinal: number;
  readonly chunk_index: number;
  readonly chunk_count: number;
  readonly records: readonly NativePerfTraceRecord[];
}

const CHUNK_KEYS = [
  'command_id',
  'owner',
  'peer_id',
  'session_id',
  'observation_epoch',
  'attempted',
  'dropped',
  'stale',
  'record_count',
  'first_ordinal',
  'last_ordinal',
  'chunk_index',
  'chunk_count',
  'records',
] as const;
const RECORD_KEYS = ['ordinal', 'owner', 'at_us', 'kind', 'fields'] as const;
const META_KEYS = CHUNK_KEYS.filter((key) => key !== 'records' && key !== 'chunk_index');

function unsigned(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/** Closed IPC contract. Unsafe u64 values are rejected, never silently rounded. */
export function isNativePerfTraceChunk(value: unknown): value is NativePerfTraceChunk {
  if (
    !hasExactKeys(value, CHUNK_KEYS) ||
    !identity(value.command_id) ||
    !identity(value.peer_id) ||
    !identity(value.session_id) ||
    !unsigned(value.owner) ||
    value.owner === 0 ||
    !unsigned(value.observation_epoch, 0xffff_ffff) ||
    value.observation_epoch === 0 ||
    !unsigned(value.attempted) ||
    !unsigned(value.dropped) ||
    !unsigned(value.stale) ||
    !unsigned(value.record_count, NATIVE_PERF_TRACE_MAX_RECORDS) ||
    value.attempted - value.dropped !== value.record_count ||
    !unsigned(value.first_ordinal) ||
    !unsigned(value.last_ordinal) ||
    !unsigned(value.chunk_count, NATIVE_PERF_TRACE_MAX_RECORDS / NATIVE_PERF_TRACE_CHUNK_RECORDS) ||
    value.chunk_count !==
      Math.max(1, Math.ceil(value.record_count / NATIVE_PERF_TRACE_CHUNK_RECORDS)) ||
    !unsigned(value.chunk_index) ||
    value.chunk_index >= value.chunk_count ||
    !Array.isArray(value.records) ||
    value.records.length !==
      Math.min(
        NATIVE_PERF_TRACE_CHUNK_RECORDS,
        value.record_count - value.chunk_index * NATIVE_PERF_TRACE_CHUNK_RECORDS,
      )
  )
    return false;
  if (value.record_count === 0) {
    return value.first_ordinal === 0 && value.last_ordinal === 0;
  }
  if (value.first_ordinal === 0 || value.last_ordinal < value.first_ordinal) return false;
  let previous = 0;
  for (const record of value.records) {
    if (
      !hasExactKeys(record, RECORD_KEYS) ||
      !unsigned(record.ordinal) ||
      record.ordinal < value.first_ordinal ||
      record.ordinal > value.last_ordinal ||
      record.ordinal <= previous ||
      record.owner !== value.owner ||
      !unsigned(record.at_us) ||
      !NATIVE_PERF_TRACE_KINDS.some((kind) => kind === record.kind) ||
      !Array.isArray(record.fields) ||
      record.fields.length !== 16 ||
      !record.fields.every((field) => unsigned(field))
    )
      return false;
    previous = record.ordinal;
  }
  return (
    (value.chunk_index !== 0 || value.records[0]?.ordinal === value.first_ordinal) &&
    (value.chunk_index !== value.chunk_count - 1 || previous === value.last_ordinal)
  );
}

/**
 * Constant-retention validation of one FIFO capture. No record arrays are kept.
 * Complete means all exported records arrived, not that native collection lost
 * nothing: callers must require zero current-owner drops and exact endpoint joins
 * for timing claims. Previous-owner stale discards are informational.
 * Cross-thread clock reads can precede ordinal reservation, so at_us need not sort.
 */
export function createNativePerfTraceValidator(commandId: string) {
  let metadata: Omit<NativePerfTraceChunk, 'records' | 'chunk_index'> | null = null;
  let chunks = 0;
  let records = 0;
  let lastOrdinal = 0;
  let invalid = false;
  return {
    accept(chunk: NativePerfTraceChunk): boolean {
      if (invalid) return false;
      if (
        !isNativePerfTraceChunk(chunk) ||
        chunk.command_id !== commandId ||
        chunk.chunk_index !== chunks ||
        (metadata !== null && META_KEYS.some((key) => chunk[key] !== metadata?.[key])) ||
        (chunk.records.length > 0 && (chunk.records[0]?.ordinal ?? 0) <= lastOrdinal)
      ) {
        invalid = true;
        return false;
      }
      if (metadata === null) {
        const { records: _records, chunk_index: _index, ...header } = chunk;
        metadata = header;
      }
      chunks += 1;
      records += chunk.records.length;
      lastOrdinal = chunk.records.at(-1)?.ordinal ?? lastOrdinal;
      return true;
    },
    get complete(): boolean {
      return (
        !invalid &&
        metadata !== null &&
        chunks === metadata.chunk_count &&
        records === metadata.record_count &&
        lastOrdinal === metadata.last_ordinal
      );
    },
    get chunkCount(): number {
      return chunks;
    },
    get recordCount(): number {
      return records;
    },
  };
}
