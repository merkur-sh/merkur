import type { PerfRingWriter } from '../perf/perf-ring';
import { MAX_IN_FLIGHT_RENDER_FRAMES } from './render-mailbox';

export interface SubmissionPredictionPerf {
  readonly predictionInputSeq: number;
  readonly visiblePredictionInputSeqs: readonly number[];
  readonly visiblePredictionInputSeqsTruncated: boolean;
}

/** Reserved scalars become immutable until the exact GPU completion retires them. */
export interface SubmittedRenderFrame {
  submissionId: number;
  sessionEpoch: number;
  generation: number;
  viewportEpoch: number;
  stateRevision: number;
  predictionRevision: number;
  semanticValid: boolean;
  renderSeq: number;
  queueDepth: number;
  perfWriter: PerfRingWriter | null;
  perf: (SubmissionPredictionPerf & { readonly displayInputSeq: number }) | null;
  trackerToken: number | null;
  firstDisplayOwner: boolean;
}

function createSlot(): SubmittedRenderFrame {
  return {
    submissionId: 0,
    sessionEpoch: 0,
    generation: 0,
    viewportEpoch: 0,
    stateRevision: 0,
    predictionRevision: 0,
    semanticValid: false,
    renderSeq: 0,
    queueDepth: 0,
    perfWriter: null,
    perf: null,
    trackerToken: null,
    firstDisplayOwner: false,
  };
}

/**
 * Fixed reusable owners, never a historical-frame queue. Completion is a resource
 * observation only: no cursor, prediction or presentation state is published here.
 * Semantic invalidation cannot release GPU capacity. Callback order is irrelevant.
 */
export function createRenderSubmissionState() {
  const slots = Array.from({ length: MAX_IN_FLIGHT_RENDER_FRAMES }, createSlot);
  // Retired slots remain borrowed until release; they cannot be reserved or
  // completed again while their immutable telemetry is being consumed.
  const retired = new Uint8Array(MAX_IN_FLIGHT_RENDER_FRAMES);
  let count = 0;
  let reserved: SubmittedRenderFrame | null = null;
  let latestSubmissionId = 0;

  function findSubmission(submissionId: number): number {
    for (let index = 0; index < slots.length; index += 1) {
      if (slots[index]?.submissionId === submissionId) return index;
    }
    return -1;
  }

  function invalidate(slot: SubmittedRenderFrame, discardToken: (token: number) => void): void {
    if (slot.trackerToken !== null) discardToken(slot.trackerToken);
    slot.trackerToken = null;
    slot.semanticValid = false;
    slot.firstDisplayOwner = false;
  }

  return {
    count(): number {
      return count;
    },
    isLatest(frame: SubmittedRenderFrame): boolean {
      return frame.submissionId !== 0 && frame.submissionId === latestSubmissionId;
    },
    reserve(): SubmittedRenderFrame {
      if (reserved !== null || count >= slots.length)
        throw new Error('render submission has no unreserved physical credit');
      const slot = slots[findSubmission(0)];
      if (slot === undefined) throw new Error('render submission has no released slot');
      slot.sessionEpoch = 0;
      slot.generation = 0;
      slot.viewportEpoch = 0;
      slot.stateRevision = 0;
      slot.predictionRevision = 0;
      slot.semanticValid = true;
      slot.renderSeq = 0;
      slot.queueDepth = 0;
      slot.perf = null;
      slot.perfWriter = null;
      slot.trackerToken = null;
      slot.firstDisplayOwner = false;
      reserved = slot;
      return slot;
    },
    commit(frame: SubmittedRenderFrame, submissionId: number): void {
      if (
        reserved !== frame ||
        !Number.isSafeInteger(submissionId) ||
        submissionId <= 0 ||
        submissionId > 0xffff_ffff ||
        findSubmission(submissionId) !== -1
      )
        throw new Error('invalid renderer submission ownership');
      frame.submissionId = submissionId;
      latestSubmissionId = submissionId;
      count += 1;
      reserved = null;
    },
    abortReserved(frame: SubmittedRenderFrame): void {
      if (reserved === null) return;
      if (reserved !== frame) throw new Error('wrong renderer reservation');
      reserved = null;
      frame.semanticValid = false;
    },
    retire(submissionId: number): SubmittedRenderFrame {
      const index = findSubmission(submissionId);
      const frame = slots[index];
      if (submissionId === 0 || frame === undefined || retired[index] !== 0)
        throw new Error('renderer completed an unknown submission');
      retired[index] = 1;
      count -= 1;
      // Borrowed until release; finish telemetry before admitting more work.
      return frame;
    },
    release(frame: SubmittedRenderFrame): void {
      const index = slots.indexOf(frame);
      if (index < 0 || retired[index] !== 1) throw new Error('renderer released an unretired slot');
      retired[index] = 0;
      frame.submissionId = 0;
      frame.perf = null;
      frame.perfWriter = null;
      frame.trackerToken = null;
    },
    invalidateSemantics(discardToken: (token: number) => void): void {
      for (const slot of slots) invalidate(slot, discardToken);
    },
    contextDestroyed(discardToken: (token: number) => void): void {
      for (const slot of slots) {
        invalidate(slot, discardToken);
        slot.submissionId = 0;
        slot.perfWriter = null;
        slot.perf = null;
      }
      retired.fill(0);
      count = 0;
      reserved = null;
      latestSubmissionId = 0;
    },
  };
}
