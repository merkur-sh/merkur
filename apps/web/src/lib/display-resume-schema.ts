import { MAX_TERMINAL_CELLS, MAX_TERMINAL_COLUMNS, MAX_TERMINAL_ROWS } from '@merkur/shared';

export interface PersistedResume {
  readonly key: string;
  readonly daemonId: string;
  readonly tabId: string;
  readonly generation: number;
  readonly seq: number;
  readonly cols: number;
  readonly rows: number;
  readonly chunks: readonly Uint8Array[];
  readonly mtime: number;
}

const RESUME_KEYS = [
  'key',
  'daemonId',
  'tabId',
  'generation',
  'seq',
  'cols',
  'rows',
  'chunks',
  'mtime',
] as const;
const MAX_U32 = 0xffff_ffff;
const MAX_ID_LENGTH = 256;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export function parsePersistedResume(
  value: unknown,
  expectedDaemonId: string,
  expectedTabId: string,
): PersistedResume | null {
  if (!isExactRecord(value, RESUME_KEYS)) return null;

  const expectedKey = `${expectedDaemonId}:${expectedTabId}`;
  if (
    !isValidId(expectedDaemonId) ||
    !isValidId(expectedTabId) ||
    value.key !== expectedKey ||
    value.daemonId !== expectedDaemonId ||
    value.tabId !== expectedTabId ||
    !isU32(value.generation) ||
    value.generation === 0 ||
    !isU32(value.seq) ||
    !isPositiveSafeInteger(value.cols) ||
    value.cols > MAX_TERMINAL_COLUMNS ||
    !isPositiveSafeInteger(value.rows) ||
    value.rows > MAX_TERMINAL_ROWS ||
    value.cols * value.rows > MAX_TERMINAL_CELLS ||
    !Array.isArray(value.chunks) ||
    value.chunks.length === 0 ||
    value.chunks.length > value.rows ||
    !isPositiveSafeInteger(value.mtime)
  ) {
    return null;
  }

  let snapshotBytes = 0;
  for (const chunk of value.chunks) {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) return null;
    snapshotBytes += chunk.byteLength;
    if (snapshotBytes > MAX_SNAPSHOT_BYTES) return null;
  }

  return {
    key: expectedKey,
    daemonId: expectedDaemonId,
    tabId: expectedTabId,
    generation: value.generation,
    seq: value.seq,
    cols: value.cols,
    rows: value.rows,
    chunks: value.chunks,
    mtime: value.mtime,
  };
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function isValidId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_LENGTH && value.trim() === value;
}

function isU32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_U32;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
