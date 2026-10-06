import {
  emitDisplayEvent,
  emitPresentationTransactionDiscarded,
  PERF_KIND_DISPLAY_RECEIVED,
  PERF_KIND_WORKER_DISPLAY_APPLIED,
  PERF_KIND_WORKER_DISPLAY_QUEUED,
  PRESENTATION_DISCARD_REASONS,
} from './perf-event-codec';
import type { PerfRingWriter } from './perf-ring';

/**
 * A transaction the ClientViewer dropped uncommitted (stage 5): its members
 * were applied offscreen and are never shown. It takes the number its commit
 * would have taken, so what replaces it cannot inherit that number. Returns
 * the transactions numbered so far.
 */
export function recordClientViewerDiscard(
  writer: PerfRingWriter,
  words: Uint32Array,
  atMs: number,
  transactionSeq: number,
): number {
  const reason = PRESENTATION_DISCARD_REASONS[words[7] ?? Number.NaN];
  if (words.length !== 14 || words[0] !== 5 || reason === undefined) return transactionSeq;
  const discarded = (transactionSeq + 1) >>> 0 || 1;

  return emitPresentationTransactionDiscarded(
    writer,
    atMs,
    discarded,
    words[1] ?? 0,
    words[2] ?? 0,
    words[3] ?? 0,
    words[4] ?? 0,
    words[5] ?? 0,
    words[6] ?? 0,
    reason,
  )
    ? discarded
    : transactionSeq;
}

/** Synchronous ClientViewer decode/queue/apply observations; no WASM reentry. */
export function recordClientViewerDisplay(
  writer: PerfRingWriter,
  words: Uint32Array,
  atMs: number,
  sinceMs: number,
  transactionSeq: number,
): void {
  const stage = words[0];
  if (words.length !== 14 || (stage !== 1 && stage !== 2 && stage !== 3)) return;
  if (!Number.isFinite(sinceMs)) return;
  const flags = words[11] ?? 0;
  const applied = stage === 3;
  const visual = (flags & 8) !== 0;
  emitDisplayEvent(
    writer,
    stage === 1
      ? PERF_KIND_DISPLAY_RECEIVED
      : applied
        ? PERF_KIND_WORKER_DISPLAY_APPLIED
        : PERF_KIND_WORKER_DISPLAY_QUEUED,
    atMs,
    words[1] ?? 0,
    words[2] ?? 0,
    words[3] ?? 0,
    words[4] ?? 0,
    words[5] ?? 0,
    words[6] ?? 0,
    words[7] ?? 0,
    words[8] ?? 0,
    words[9] ?? 0,
    words[10] ?? 0,
    applied && visual ? (transactionSeq + 1) >>> 0 || 1 : 0,
    (flags & 1) !== 0,
    (flags & 2) !== 0,
    (flags & 4) !== 0,
    applied ? visual : null,
    stage === 1 ? Math.max(0, atMs - sinceMs) : null,
    applied ? Math.max(0, atMs - sinceMs) : null,
    words[12] ?? 0,
    words[13] ?? 0,
    (flags & 16) !== 0 ? 'display_snapshot' : 'display_delta',
  );
}
