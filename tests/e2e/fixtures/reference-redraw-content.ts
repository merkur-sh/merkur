import type { ReferenceRenderContent } from './reference-render-content';
import {
  type ReferenceDistribution,
  type ReferenceFrameCompleteEvent,
  type ReferenceRedrawSample,
  type ReferenceRenderEndEvent,
  type ReferenceRenderStartEvent,
  type ReferenceTerminalEvent,
  referenceDistribution,
} from './terminal-redraw-reference';

export interface ReferenceContentRedrawSample {
  readonly index: number;
  readonly inputSeq: number;
  readonly submittedGpuFrames: number;
  readonly contentChangingGpuFrames: number;
  readonly identicalGpuFrames: number;
  /** Worker-observed GPU-fence exposure, not compositor presentation or physical photons. */
  readonly contentChangingObservedGpuFenceExposureMs: number;
  /** Hash/word comparison prefix only: excludes JSON serialization and console delivery. */
  readonly signatureComputePrefixMs: readonly number[];
  readonly contentChanges: readonly {
    renderSeq: number;
    observationOrdinal: number;
    stateRevision: number;
    changedRows: number;
    cursorChanged: boolean;
    gpuFenceAtMs: number;
  }[];
}

/**
 * Content-aware evidence is a separate, observer-instrumented run. A late
 * identical retransmission is still received/applied/ACKed, but cannot lengthen
 * this semantic-content exposure. Do not transplant these timestamps into the
 * uninstrumented latency distributions.
 */
export function analyzeReferenceRedrawContent(
  samples: readonly ReferenceRedrawSample[],
  events: readonly ReferenceTerminalEvent[],
  observations: readonly ReferenceRenderContent[],
): ReferenceContentRedrawSample[] {
  for (let index = 0; index < observations.length; index += 1) {
    const item = observations[index];
    const previous = observations[index - 1];
    if (
      item === undefined ||
      item.ordinal !== index + 1 ||
      (previous !== undefined &&
        (item.atMs < previous.observedAtMs ||
          item.stateRevision < previous.stateRevision ||
          item.stateRevision > previous.stateRevision + 1))
    )
      throw new Error('content observer records are missing or out of order');
    const semanticChange =
      previous === undefined ||
      item.changedRows > 0 ||
      item.cursorChanged ||
      item.cols !== previous.cols ||
      item.rows !== previous.rows ||
      item.viewportWidth !== previous.viewportWidth ||
      item.viewportHeight !== previous.viewportHeight ||
      item.atlasGeneration !== previous.atlasGeneration ||
      item.atlasWidth !== previous.atlasWidth ||
      item.atlasHeight !== previous.atlasHeight;
    if (item.stateRevision !== (previous?.stateRevision ?? 0) + Number(semanticChange))
      throw new Error('content revision disagrees with semantic change metadata');
  }
  const starts = events
    .filter((event): event is ReferenceRenderStartEvent => event.kind === 'render_start')
    .sort((left, right) => left.atMs - right.atMs);
  const startsBySequence = new Map(starts.map((start) => [start.renderSeq, start]));
  if (startsBySequence.size !== starts.length) throw new Error('duplicate reference render start');
  if (starts.some((start, index) => index > 0 && starts[index - 1]?.atMs === start.atMs))
    throw new Error('ambiguous equal-time reference render starts');
  const ends = events.filter(
    (event): event is ReferenceRenderEndEvent => event.kind === 'render_end',
  );
  const endsBySequence = new Map(ends.map((end) => [end.renderSeq, end]));
  if (endsBySequence.size !== ends.length) throw new Error('duplicate reference render end');
  const frames = events.filter(
    (event): event is ReferenceFrameCompleteEvent => event.kind === 'frame_complete',
  );

  return samples.map((sample) => {
    const inWindow = (atMs: number): boolean =>
      atMs >= sample.windowOpenedAtMs && atMs <= sample.windowClosedAtMs;
    const content = observations.filter((item) => inWindow(item.atMs));
    const before = observations.findLast((item) => item.atMs < sample.windowOpenedAtMs);
    if (content.length === 0 || before === undefined)
      throw new Error('content reference has no submitted state or pre-trigger baseline');
    const completed = frames
      .filter((frame) => inWindow(frame.atMs))
      .sort((left, right) => left.atMs - right.atMs);
    if (completed.length !== content.length)
      throw new Error('content reference has an unfenced or unobserved submission');
    const changes: ReferenceContentRedrawSample['contentChanges'][number][] = [];
    const changedFrames: {
      start: ReferenceRenderStartEvent;
      end: ReferenceRenderEndEvent;
      frame: ReferenceFrameCompleteEvent;
    }[] = [];
    const signatureComputePrefixMs: number[] = [];
    let previousRevision = before.stateRevision;
    for (let index = 0; index < content.length; index += 1) {
      const item = content[index];
      const frame = completed[index];
      if (item === undefined || frame === undefined)
        throw new Error('content reference count mismatch');
      const start = startsBySequence.get(frame.renderSeq);
      const end = endsBySequence.get(frame.renderSeq);
      const nextStart = starts.find((entry) => entry.atMs > (start?.atMs ?? 0));
      if (
        start === undefined ||
        end === undefined ||
        end.completionMode !== 'gpu-queue' ||
        start.displayInputSeq !== sample.inputSeq ||
        frame.displayInputSeq !== sample.inputSeq ||
        frame.predictionInputSeq !== 0 ||
        frame.visiblePredictionInputSeqsTruncated ||
        frame.visiblePredictionInputSeqs.length !== 0 ||
        frame.previousPollAtMs > frame.atMs ||
        start.atMs < sample.windowOpenedAtMs ||
        start.atMs > item.atMs ||
        item.observedAtMs > end.atMs ||
        end.atMs > frame.atMs ||
        (nextStart !== undefined && nextStart.atMs <= item.atMs)
      )
        throw new Error(
          'content observation does not have an exact unpredicted render/fence owner',
        );
      if (
        end.atlasUploaded ||
        item.cols !== before.cols ||
        item.rows !== before.rows ||
        item.viewportWidth !== before.viewportWidth ||
        item.viewportHeight !== before.viewportHeight ||
        item.atlasGeneration !== before.atlasGeneration ||
        item.atlasWidth !== before.atlasWidth ||
        item.atlasHeight !== before.atlasHeight
      )
        throw new Error('geometry or glyph atlas changed inside the content reference window');
      signatureComputePrefixMs.push(item.observedAtMs - item.atMs);
      if (item.stateRevision !== previousRevision) {
        changes.push({
          renderSeq: frame.renderSeq,
          observationOrdinal: item.ordinal,
          stateRevision: item.stateRevision,
          changedRows: item.changedRows,
          cursorChanged: item.cursorChanged,
          gpuFenceAtMs: frame.atMs,
        });
        changedFrames.push({ start, end, frame });
      }
      previousRevision = item.stateRevision;
    }
    const first = changedFrames[0];
    const last = changedFrames[changedFrames.length - 1];
    if (first === undefined || last === undefined)
      throw new Error('redraw changed no terminal content');
    return {
      index: sample.index,
      inputSeq: sample.inputSeq,
      submittedGpuFrames: completed.length,
      contentChangingGpuFrames: changedFrames.length,
      identicalGpuFrames: completed.length - changedFrames.length,
      contentChangingObservedGpuFenceExposureMs: last.frame.atMs - first.frame.atMs,
      signatureComputePrefixMs,
      contentChanges: changes,
    };
  });
}

export function summarizeReferenceRedrawContent(
  samples: readonly ReferenceContentRedrawSample[],
): Record<string, ReferenceDistribution> {
  return {
    contentChangingObservedGpuFenceExposureMs: referenceDistribution(
      samples.map((sample) => sample.contentChangingObservedGpuFenceExposureMs),
    ),
    contentChangingGpuFrames: referenceDistribution(
      samples.map((sample) => sample.contentChangingGpuFrames),
    ),
    identicalGpuFrames: referenceDistribution(samples.map((sample) => sample.identicalGpuFrames)),
    signatureComputePrefixMs: referenceDistribution(
      samples.flatMap((sample) => sample.signatureComputePrefixMs),
    ),
  };
}
