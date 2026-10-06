export const TERMINAL_REDRAW_REFERENCE_SCHEMA_VERSION = 4;
export const TERMINAL_REDRAW_REFERENCE_RAW_SCHEMA_VERSION = 3;

export interface ReferenceInputQueuedEvent {
  readonly kind: 'input_queued';
  readonly atMs: number;
  readonly inputSeq: number;
  readonly byteLength: number;
}

export interface ReferenceDisplayEvent {
  readonly kind: 'display_received' | 'worker_display_applied';
  readonly atMs: number;
  readonly displaySeq: number;
  readonly generation: number;
  readonly inputSeq: number;
  readonly frameId: number;
  readonly byteLength: number;
  readonly rowCount: number;
  readonly displayKind: 'display_snapshot' | 'display_delta';
}

export interface ReferenceFrameCompleteEvent {
  readonly kind: 'frame_complete';
  readonly atMs: number;
  readonly renderSeq: number;
  readonly displayInputSeq: number;
  readonly predictionInputSeq: number;
  readonly visiblePredictionInputSeqs: readonly number[];
  readonly visiblePredictionInputSeqsTruncated: boolean;
  readonly queuedDisplayFrames: number;
  readonly pollCount: number;
  readonly previousPollAtMs: number;
}

export interface ReferenceRenderStartEvent {
  readonly kind: 'render_start';
  readonly atMs: number;
  readonly renderSeq: number;
  readonly displayInputSeq: number;
}

export interface ReferenceRenderEndEvent {
  readonly kind: 'render_end';
  readonly atMs: number;
  readonly renderSeq: number;
  readonly atlasUploaded: boolean;
  readonly completionMode: 'gpu-queue' | 'none';
}

export type ReferenceTerminalEvent =
  | ReferenceInputQueuedEvent
  | ReferenceDisplayEvent
  | ReferenceRenderStartEvent
  | ReferenceRenderEndEvent
  | ReferenceFrameCompleteEvent;

export interface ReferenceRedrawWindow {
  readonly index: number;
  readonly readyMarker: string;
  readonly finalMarker: string;
  /** Browser epoch timestamp sampled immediately before dispatching the trigger Enter. */
  readonly openedAtMs: number;
  /** Browser epoch timestamp sampled immediately after Playwright completed the trigger dispatch. */
  readonly triggerDispatchCompletedAtMs: number;
  /** Browser epoch timestamp after the final marker and the bounded tail-observation interval. */
  readonly closedAtMs: number;
}

export interface ReferenceRedrawSample {
  readonly index: number;
  readonly inputSeq: number;
  readonly inputQueuedAtMs: number;
  readonly windowOpenedAtMs: number;
  readonly triggerDispatchCompletedAtMs: number;
  readonly windowClosedAtMs: number;
  readonly receivedDatagrams: number;
  readonly appliedDatagrams: number;
  readonly appliedBytes: number;
  readonly appliedRows: number;
  readonly completedAuthoritativeGpuFrames: number;
  /** Exact worker-observed GPU-fence timestamp minus the browser input-queue timestamp. */
  readonly inputToFirstAuthoritativeGpuFenceMs: number;
  /** Exact last worker-observed GPU-fence timestamp minus the browser input-queue timestamp. */
  readonly inputToCompletedAuthoritativeGpuFenceMs: number;
  /**
   * Conservative row-bearing GPU-submission exposure, NOT a visible-pixel metric:
   * a newer-sequence identical retransmission can repaint identical content.
   * Content-aware captures additionally use analyzeReferenceRedrawContent.
   */
  readonly partialPresentationExposureMs: number;
  readonly firstDisplayReceiptToCompletedAuthoritativeGpuFenceMs: number;
  readonly firstGpuFenceObservedAtMs: number;
  readonly lastGpuFenceObservedAtMs: number;
}

export interface ReferenceDistribution {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

const REFERENCE_EVENT_KINDS = new Set<string>([
  'input_queued',
  'display_received',
  'worker_display_applied',
  'frame_complete',
  'render_start',
  'render_end',
]);

/**
 * Hard-cut a worker dump to the event fields shared by commit 565acd4a and the
 * current checkout. Unknown event kinds are deliberately ignored; a malformed
 * event of a required kind poisons the reference trace instead of being guessed.
 */
export function normalizeReferenceTerminalEvents(
  rawEvents: readonly unknown[],
): ReferenceTerminalEvent[] {
  const events: ReferenceTerminalEvent[] = [];
  for (const rawEvent of rawEvents) {
    if (!isRecord(rawEvent) || typeof rawEvent.kind !== 'string') continue;
    if (!REFERENCE_EVENT_KINDS.has(rawEvent.kind)) continue;
    if (rawEvent.kind === 'render_end') {
      const completionMode = rawEvent.completionMode;
      if (completionMode !== 'gpu-queue' && completionMode !== 'none')
        throw new Error('render_end.completionMode is invalid');
      events.push({
        kind: rawEvent.kind,
        atMs: finiteNumber(rawEvent.atMs, 'render_end.atMs'),
        renderSeq: positiveInteger(rawEvent.renderSeq, 'render_end.renderSeq'),
        atlasUploaded: booleanValue(rawEvent.atlasUploaded, 'render_end.atlasUploaded'),
        completionMode,
      });
      continue;
    }
    if (rawEvent.kind === 'render_start') {
      events.push({
        kind: rawEvent.kind,
        atMs: finiteNumber(rawEvent.atMs, 'render_start.atMs'),
        renderSeq: positiveInteger(rawEvent.renderSeq, 'render_start.renderSeq'),
        displayInputSeq: nonNegativeInteger(
          rawEvent.displayInputSeq,
          'render_start.displayInputSeq',
        ),
      });
      continue;
    }
    if (rawEvent.kind === 'input_queued') {
      events.push({
        kind: rawEvent.kind,
        atMs: finiteNumber(rawEvent.atMs, 'input_queued.atMs'),
        inputSeq: positiveInteger(rawEvent.inputSeq, 'input_queued.inputSeq'),
        byteLength: nonNegativeInteger(rawEvent.byteLength, 'input_queued.byteLength'),
      });
      continue;
    }
    if (rawEvent.kind === 'frame_complete') {
      if (!Array.isArray(rawEvent.visiblePredictionInputSeqs))
        throw new Error('frame_complete.visiblePredictionInputSeqs is invalid');
      const atMs = finiteNumber(rawEvent.atMs, 'frame_complete.atMs');
      const previousPollAtMs = finiteNonNegativeNumber(
        rawEvent.previousPollAtMs,
        'frame_complete.previousPollAtMs',
      );
      if (rawEvent.pollCount !== 0 || previousPollAtMs !== 0)
        throw new Error('frame_complete WebGPU callback must have zero polling metadata');
      events.push({
        kind: rawEvent.kind,
        atMs,
        renderSeq: positiveInteger(rawEvent.renderSeq, 'frame_complete.renderSeq'),
        displayInputSeq: nonNegativeInteger(
          rawEvent.displayInputSeq,
          'frame_complete.displayInputSeq',
        ),
        predictionInputSeq: nonNegativeInteger(
          rawEvent.predictionInputSeq,
          'frame_complete.predictionInputSeq',
        ),
        visiblePredictionInputSeqs: rawEvent.visiblePredictionInputSeqs.map((value) =>
          positiveInteger(value, 'frame_complete.visiblePredictionInputSeqs'),
        ),
        visiblePredictionInputSeqsTruncated: booleanValue(
          rawEvent.visiblePredictionInputSeqsTruncated,
          'frame_complete.visiblePredictionInputSeqsTruncated',
        ),
        queuedDisplayFrames: nonNegativeInteger(
          rawEvent.queuedDisplayFrames,
          'frame_complete.queuedDisplayFrames',
        ),
        pollCount: 0,
        previousPollAtMs,
      });
      continue;
    }
    if (rawEvent.kind !== 'display_received' && rawEvent.kind !== 'worker_display_applied') {
      throw new Error(`unsupported required reference event kind: ${rawEvent.kind}`);
    }
    const displayKind = rawEvent.displayKind;
    if (displayKind !== 'display_snapshot' && displayKind !== 'display_delta') {
      throw new Error(`${rawEvent.kind}.displayKind is invalid`);
    }
    events.push({
      kind: rawEvent.kind,
      atMs: finiteNumber(rawEvent.atMs, `${rawEvent.kind}.atMs`),
      displaySeq: nonNegativeInteger(rawEvent.displaySeq, `${rawEvent.kind}.displaySeq`),
      generation: nonNegativeInteger(rawEvent.generation, `${rawEvent.kind}.generation`),
      inputSeq: nonNegativeInteger(rawEvent.inputSeq, `${rawEvent.kind}.inputSeq`),
      frameId: nonNegativeInteger(rawEvent.frameId, `${rawEvent.kind}.frameId`),
      byteLength: nonNegativeInteger(rawEvent.byteLength, `${rawEvent.kind}.byteLength`),
      rowCount: nonNegativeInteger(rawEvent.rowCount, `${rawEvent.kind}.rowCount`),
      displayKind,
    });
  }
  return events.sort(compareEvents);
}

export function analyzeReferenceRedrawTrace(
  windows: readonly ReferenceRedrawWindow[],
  events: readonly ReferenceTerminalEvent[],
): ReferenceRedrawSample[] {
  validateWindows(windows);
  const orderedEvents = [...events].sort(compareEvents);
  const inputs = orderedEvents.filter(
    (event): event is ReferenceInputQueuedEvent => event.kind === 'input_queued',
  );
  const received = orderedEvents.filter(
    (event): event is ReferenceDisplayEvent => event.kind === 'display_received',
  );
  const applied = orderedEvents.filter(
    (event): event is ReferenceDisplayEvent => event.kind === 'worker_display_applied',
  );
  const frames = orderedEvents.filter(
    (event): event is ReferenceFrameCompleteEvent => event.kind === 'frame_complete',
  );
  const renderStarts = new Map<number, ReferenceRenderStartEvent>();
  for (const event of orderedEvents) {
    if (event.kind !== 'render_start') continue;
    if (renderStarts.has(event.renderSeq))
      throw new Error('duplicate reference render_start identity');
    renderStarts.set(event.renderSeq, event);
  }

  const samples = windows.map((window) => {
    const triggerInputs = inputs.filter(
      (event) => event.atMs >= window.openedAtMs && event.atMs <= window.closedAtMs,
    );
    if (triggerInputs.length !== 1) {
      throw new Error(
        `redraw window ${window.index} contains ${triggerInputs.length} input_queued events; expected exactly one trigger`,
      );
    }
    const trigger = must(triggerInputs[0]);
    if (trigger.byteLength !== 1) {
      throw new Error(`redraw window ${window.index} trigger must be exactly one byte`);
    }
    const causalReceived = received.filter(
      (event) => event.inputSeq === trigger.inputSeq && event.atMs >= trigger.atMs,
    );
    const causalApplied = applied.filter(
      (event) => event.inputSeq === trigger.inputSeq && event.atMs >= trigger.atMs,
    );
    const visualApplied = causalApplied.filter((event) => event.rowCount > 0);
    if (causalReceived.length === 0) {
      throw new Error(`redraw window ${window.index} has no exact-input display receipt`);
    }
    if (visualApplied.length === 0) {
      throw new Error(`redraw window ${window.index} has no row-bearing display apply`);
    }

    const causalFrames = frames.filter(
      (event) => event.displayInputSeq === trigger.inputSeq && event.atMs >= trigger.atMs,
    );
    const authoritativeFrames = framesCoveringNewApplies(visualApplied, causalFrames, renderStarts);
    if (authoritativeFrames.length === 0) {
      throw new Error(
        `redraw window ${window.index} has no GPU frame-complete observation covering a row-bearing apply`,
      );
    }
    const lastApplyAtMs = must(visualApplied.at(-1)).atMs;
    const firstFrame = must(authoritativeFrames[0]);
    const lastFrame = must(authoritativeFrames.at(-1));
    if (lastFrame.atMs < lastApplyAtMs) {
      throw new Error(
        `redraw window ${window.index} ended without a GPU fence after its final row-bearing apply`,
      );
    }

    const lateApply = visualApplied.find((event) => event.atMs > window.closedAtMs);
    const lateFrame = authoritativeFrames.find((event) => event.atMs > window.closedAtMs);
    if (lateApply !== undefined || lateFrame !== undefined) {
      const lateAtMs = Math.min(
        lateApply?.atMs ?? Number.POSITIVE_INFINITY,
        lateFrame?.atMs ?? Number.POSITIVE_INFINITY,
      );
      throw new Error(
        `redraw window ${window.index} has an authoritative same-input tail ${lateAtMs - window.closedAtMs} ms after close`,
      );
    }
    if (causalReceived.some((event) => event.atMs > window.closedAtMs)) {
      throw new Error(`redraw window ${window.index} has a same-input display receipt after close`);
    }

    const firstReceipt = must(causalReceived[0]);
    return {
      index: window.index,
      inputSeq: trigger.inputSeq,
      inputQueuedAtMs: trigger.atMs,
      windowOpenedAtMs: window.openedAtMs,
      triggerDispatchCompletedAtMs: window.triggerDispatchCompletedAtMs,
      windowClosedAtMs: window.closedAtMs,
      receivedDatagrams: causalReceived.length,
      appliedDatagrams: causalApplied.length,
      appliedBytes: causalApplied.reduce((sum, event) => sum + event.byteLength, 0),
      appliedRows: visualApplied.reduce((sum, event) => sum + event.rowCount, 0),
      completedAuthoritativeGpuFrames: authoritativeFrames.length,
      inputToFirstAuthoritativeGpuFenceMs: firstFrame.atMs - trigger.atMs,
      inputToCompletedAuthoritativeGpuFenceMs: lastFrame.atMs - trigger.atMs,
      partialPresentationExposureMs: lastFrame.atMs - firstFrame.atMs,
      firstDisplayReceiptToCompletedAuthoritativeGpuFenceMs: lastFrame.atMs - firstReceipt.atMs,
      firstGpuFenceObservedAtMs: firstFrame.atMs,
      lastGpuFenceObservedAtMs: lastFrame.atMs,
    };
  });
  for (let index = 1; index < samples.length; index += 1) {
    const previous = must(samples[index - 1]);
    const current = must(samples[index]);
    const expected = previous.inputSeq === 0xffff_ffff ? 1 : previous.inputSeq + 1;
    if (current.inputSeq !== expected) {
      throw new Error('redraw trigger identities are not contiguous nonzero u32 values');
    }
  }
  return samples;
}

export function referenceDistribution(values: readonly number[]): ReferenceDistribution {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) {
    return { count: 0, p50: null, p95: null, p99: null, max: null };
  }
  const percentile = (ratio: number): number =>
    must(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)]);
  return {
    count: ordered.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: must(ordered.at(-1)),
  };
}

export function summarizeReferenceRedrawSamples(
  samples: readonly ReferenceRedrawSample[],
): Record<string, ReferenceDistribution> {
  const keys = [
    'partialPresentationExposureMs',
    'inputToFirstAuthoritativeGpuFenceMs',
    'inputToCompletedAuthoritativeGpuFenceMs',
    'firstDisplayReceiptToCompletedAuthoritativeGpuFenceMs',
    'receivedDatagrams',
    'appliedDatagrams',
    'appliedBytes',
    'appliedRows',
    'completedAuthoritativeGpuFrames',
  ] as const;
  return Object.fromEntries(
    keys.map((key) => [key, referenceDistribution(samples.map((sample) => sample[key]))]),
  );
}

function framesCoveringNewApplies(
  applied: readonly ReferenceDisplayEvent[],
  frames: readonly ReferenceFrameCompleteEvent[],
  renderStarts: ReadonlyMap<number, ReferenceRenderStartEvent>,
): ReferenceFrameCompleteEvent[] {
  const selected: ReferenceFrameCompleteEvent[] = [];
  let appliedIndex = 0;
  for (const frame of frames) {
    const start = renderStarts.get(frame.renderSeq);
    if (
      start === undefined ||
      start.displayInputSeq !== frame.displayInputSeq ||
      start.atMs > frame.atMs
    ) {
      throw new Error('GPU fence has no valid exact render_start join');
    }
    let coversNewApply = false;
    // A fence may signal after a newer apply while still completing OLD GPU
    // commands. Only the exact frame's synchronous build-start boundary can
    // prove that its geometry included those authoritative transformations.
    while (appliedIndex < applied.length && must(applied[appliedIndex]).atMs <= start.atMs) {
      coversNewApply = true;
      appliedIndex += 1;
    }
    if (coversNewApply) selected.push(frame);
  }
  if (selected.length > 0 && appliedIndex !== applied.length)
    throw new Error('final row-bearing apply has no subsequent rendered GPU fence');
  return selected;
}

function validateWindows(windows: readonly ReferenceRedrawWindow[]): void {
  let previousClose = Number.NEGATIVE_INFINITY;
  for (const [ordinal, window] of windows.entries()) {
    if (window.index !== ordinal) {
      throw new Error(`redraw window index ${window.index} does not match ordinal ${ordinal}`);
    }
    if (
      !Number.isFinite(window.openedAtMs) ||
      !Number.isFinite(window.triggerDispatchCompletedAtMs) ||
      !Number.isFinite(window.closedAtMs) ||
      window.openedAtMs > window.triggerDispatchCompletedAtMs ||
      window.triggerDispatchCompletedAtMs > window.closedAtMs
    ) {
      throw new Error(`redraw window ${window.index} has invalid timestamp ordering`);
    }
    if (window.openedAtMs <= previousClose) {
      throw new Error(`redraw window ${window.index} overlaps its predecessor`);
    }
    previousClose = window.closedAtMs;
  }
}

function compareEvents(left: ReferenceTerminalEvent, right: ReferenceTerminalEvent): number {
  return left.atMs - right.atMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function finiteNonNegativeNumber(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (number < 0) throw new Error(`${label} must be non-negative`);
  return number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const number = nonNegativeInteger(value, label);
  if (number === 0) throw new Error(`${label} must be positive`);
  return number;
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('reference trace invariant failed');
  return value;
}
