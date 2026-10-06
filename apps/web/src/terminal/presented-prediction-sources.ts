/**
 * Which speculative glyphs actually reached the display.
 *
 * Every submitted GPU frame records the exact input sequences whose predicted
 * glyphs it carried; when the renderer reports that frame complete, they become
 * the *presented* set. That is the one fact the prediction perf attribution
 * needs and cannot get anywhere else: a Backspace is visibly predictive only
 * when the glyph it removes was in a completed frame, so a create/remove pair
 * coalesced inside one frame must not manufacture coverage.
 *
 * Fixed storage, one slot per permitted in-flight frame: no per-frame objects,
 * no retained WASM views, and nothing that grows with session length. This
 * used to be one half of a local-latency tracker whose other half fed a
 * prediction-visibility threshold; that threshold is gone (visibility is trust
 * and causal safety, nothing measured), and with it every latency sample, the
 * hidden calibration renders and the idle/atlas exclusions.
 */

import { MAX_IN_FLIGHT_RENDER_FRAMES } from './render-mailbox';

const MAX_OPEN_FRAMES = MAX_IN_FLIGHT_RENDER_FRAMES;
const MAX_VISIBLE_SOURCES = 256;

export interface PresentedPredictionSources {
  /**
   * Record the exact visible sources of a submitted frame and return its
   * token. A truncated source set records nothing: an incomplete set could
   * only under-report, and under-reporting a presented glyph is how a later
   * clear stops counting.
   */
  noteFrameSubmitted(visibleInputSeqs: ArrayLike<number>, truncated: boolean): number;
  /** Observed GPU queue completion: the newest completed frame's sources are presented. */
  noteFrameCompleted(token: number): void;
  /** Abandon a submitted frame whose fence was replaced or lost. */
  discardFrame(token: number): void;
  /** Exact sources in the newest completion-observed submission. */
  sourceWasPresented(inputSeq: number): boolean;
  /** A replaced surface, renderer, viewport or session cannot inherit presented glyphs. */
  reset(): void;
}

export function createPresentedPredictionSources(): PresentedPredictionSources {
  const frameTokens = new Float64Array(MAX_OPEN_FRAMES);
  const frameSources = new Uint32Array(MAX_OPEN_FRAMES * MAX_VISIBLE_SOURCES);
  const frameSourceCounts = new Uint16Array(MAX_OPEN_FRAMES);
  const freeFrames = new Uint32Array(MAX_OPEN_FRAMES);
  for (let frame = 0; frame < MAX_OPEN_FRAMES; frame += 1) freeFrames[frame] = frame;
  let freeFrameCount = MAX_OPEN_FRAMES;
  const presentedSources = new Uint32Array(MAX_VISIBLE_SOURCES);
  let presentedSourceCount = 0;
  let completedSourceToken = 0;
  let nextTokenGeneration = 1;

  function releaseFrame(frame: number): void {
    frameTokens[frame] = 0;
    freeFrames[freeFrameCount++] = frame;
  }

  return {
    noteFrameSubmitted(visible, truncated): number {
      // Full ownership is an integration error, never permission to overwrite
      // a frame whose completion has not been observed.
      if (freeFrameCount === 0) throw new Error('presented prediction frame ownership overflow');
      const frame = freeFrames[freeFrameCount - 1] ?? 0;
      const token = nextTokenGeneration * MAX_OPEN_FRAMES + frame;
      if (!Number.isSafeInteger(token)) throw new Error('presented prediction token exhausted');
      nextTokenGeneration += 1;
      freeFrameCount -= 1;
      frameTokens[frame] = token;
      frameSourceCounts[frame] = 0;
      if (!truncated && visible.length <= MAX_VISIBLE_SOURCES) {
        for (let index = 0; index < visible.length; index += 1) {
          frameSources[frame * MAX_VISIBLE_SOURCES + index] = visible[index] ?? 0;
        }
        frameSourceCounts[frame] = visible.length;
      }
      return token;
    },

    noteFrameCompleted(token): void {
      if (!Number.isSafeInteger(token) || token <= 0) return;
      const frame = token % MAX_OPEN_FRAMES;
      if (frameTokens[frame] !== token) return;
      releaseFrame(frame);
      // Completions can be observed out of order only across a replaced
      // renderer; the newest submission's sources are the ones on screen.
      if (token > completedSourceToken) {
        completedSourceToken = token;
        presentedSourceCount = frameSourceCounts[frame] ?? 0;
        for (let index = 0; index < presentedSourceCount; index += 1) {
          presentedSources[index] = frameSources[frame * MAX_VISIBLE_SOURCES + index] ?? 0;
        }
      }
    },

    discardFrame(token): void {
      if (!Number.isSafeInteger(token) || token <= 0) return;
      const frame = token % MAX_OPEN_FRAMES;
      if (frameTokens[frame] !== token) return;
      releaseFrame(frame);
    },

    sourceWasPresented(inputSeq): boolean {
      for (let index = 0; index < presentedSourceCount; index += 1) {
        if (presentedSources[index] === inputSeq) return true;
      }
      return false;
    },

    reset(): void {
      frameTokens.fill(0);
      frameSourceCounts.fill(0);
      for (let frame = 0; frame < MAX_OPEN_FRAMES; frame += 1) freeFrames[frame] = frame;
      freeFrameCount = MAX_OPEN_FRAMES;
      presentedSourceCount = 0;
      completedSourceToken = 0;
    },
  };
}
