/**
 * Aggregate statistics about how this device's taps actually land.
 *
 * The keyboard's recognition quality depends on three numbers nobody has ever
 * measured on a real Merkur device: where taps land relative to each key's
 * centre, how far a contact travels between touch-down and release, and how many
 * pointer samples a tap actually produces. All three are already present in
 * `KeyboardTouchTrace`; this is what folds them into something a settings screen
 * can show.
 *
 * PRIVACY. This runs during ordinary typing, so it deliberately keeps no
 * sequence. Every tap is folded immediately into per-key running sums and global
 * histograms and then discarded. There is no buffer of keystrokes, no ordering,
 * and no timestamps, so the retained state cannot reconstruct typed text — it
 * answers "where does the 'e' key get hit on average" and cannot answer "what
 * did they type". That is the whole reason it is safe to leave on, and it is why
 * this stores sums rather than the traces themselves.
 *
 * Corrections are the one place that needs order, and it is kept to the
 * current line: the keys typed and erased since the line last broke — Enter,
 * any other key that is not a character or Backspace, a chord, input from
 * outside the keyboard, or the keyboard going away. That line lives in memory
 * only. When it closes, input-stream analysis (`@merkur/keyboard`'s
 * `createInputStreamAnalyzer`, after Wobbrock and Myers) says which erased taps
 * were mistakes and what was meant in their place, however many letters later
 * the mistake was noticed; the line is then wiped. What survives is per-key
 * counts, each on one key, so no pair of keystrokes survives either.
 */
import {
  createInputStreamAnalyzer,
  INPUT_STREAM_ERASED_CORRECT,
  INPUT_STREAM_INSERTION,
  INPUT_STREAM_KEPT,
  INPUT_STREAM_OMISSION,
  type InputStreamClass,
  KEYBOARD_CANDIDATE_COUNT,
  type KeyboardKeyDefinition,
  type KeyboardTouchTrace,
  keyboardHitAtlasOffset,
  type ResolvedKeyboardGeometry,
} from '@merkur/keyboard';

/**
 * Six sums per key are enough for a mean and a full covariance of the landing
 * point; two more give the mean residual against the learned centre. The
 * counts after them come from finished lines.
 */
interface KeyAccumulator {
  count: number;
  sumX: number;
  sumY: number;
  sumXX: number;
  sumYY: number;
  sumXY: number;
  residualCount: number;
  sumResidualX: number;
  sumResidualY: number;
  /** Taps meant for this key: kept, erased although right, or missed. */
  aimed: number;
  /**
   * Meant for this key, committed as a neighbour of the contact, and corrected.
   * A neighbour is one of the four keys nearest the contact point.
   */
  missed: number;
  /** Committed as this key where a neighbour was meant: taps it took. */
  took: number;
  /** Right taps of this key erased on the way back to a mistake. */
  erasedCorrect: number;
  /**
   * Erased and replaced by a key that was not near the contact: a change of
   * mind or a spelling slip, not a misread.
   */
  replaced: number;
  /** Erased with nothing in its place: an extra tap. */
  extra: number;
  /** Skipped and put back: the next key was typed in its place. */
  skipped: number;
}

export interface KeyboardKeyOffset {
  readonly layerId: string;
  readonly keyId: string;
  readonly count: number;
  /** Mean landing point minus the key's centre, in CSS pixels. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Spread about that mean, in CSS pixels. */
  readonly sigmaX: number;
  readonly sigmaY: number;
  /**
   * Mean landing point minus the centre the engine scored this key against,
   * learned offsets included. Near zero once the learner has absorbed the bias.
   */
  readonly residualX: number;
  readonly residualY: number;
  readonly aimed: number;
  readonly missed: number;
  readonly took: number;
  readonly erasedCorrect: number;
  readonly replaced: number;
  readonly extra: number;
  readonly skipped: number;
}

export interface KeyboardDiagnosticsSummary {
  readonly taps: number;
  readonly uncommitted: number;
  /** Fraction of taps whose contact-to-release travel exceeded `tapDrift`. */
  readonly overDriftThreshold: number;
  readonly driftThresholdPx: number;
  readonly driftPx: KeyboardDistribution;
  readonly durationMs: KeyboardDistribution;
  readonly sampleCount: KeyboardDistribution;
  /**
   * Taps whose trajectory holds only the touch-down and release samples, with no
   * `pointermove` in between. This is the count to watch: the engine records a
   * sample at down and at release unconditionally, so a movement-free tap has
   * `sampleCount === 2`, never 0. If this is near 100% the browser is delivering
   * no intermediate moves, and the trajectory centroid degenerates to a
   * two-point average dominated by the release sample.
   */
  readonly movementFreeFraction: number;
  /**
   * True once any tap has reported the maximum the engine can represent.
   * `sampleCount` is clamped to the trajectory ring's capacity, so a saturated
   * distribution cannot distinguish a 120 Hz stream from a 240 Hz one and the
   * percentiles below are a floor rather than a measurement.
   */
  readonly sampleCountSaturated: boolean;
  /**
   * Gap between one tap's touch-down and the next, which is what "typing fast"
   * actually means. Only the difference between consecutive contacts is kept —
   * one remembered number, folded into a histogram — so no keystroke sequence
   * exists here either.
   */
  readonly interTapMs: KeyboardDistribution;
  /**
   * Contact-to-release travel for the fastest quarter of taps against the
   * slowest, in pixels. If drift really does grow when typing speeds up, it
   * shows here and nowhere else.
   */
  readonly driftWhenFast: number;
  readonly driftWhenSlow: number;
  /** Lines the correction analysis has finished. */
  readonly lines: number;
  /** Typed taps in finished lines: the denominator for every correction rate. */
  readonly typedTaps: number;
  /**
   * Corrected misreads: an erased tap whose replacement was one of the four
   * keys nearest its contact point, found however late it was noticed.
   */
  readonly misses: number;
  /**
   * Misses where the touch alone had scored the meant key highest and the
   * next-letter prior overruled it. The rest the finger made.
   */
  readonly missesByPrior: number;
  /** Taps where the next-letter prior changed the key the touch alone chose. */
  readonly priorOverrides: number;
  /** Of those, the ones the user kept. */
  readonly priorOverridesKept: number;
  readonly erasedCorrect: number;
  readonly replaced: number;
  readonly extra: number;
  readonly skipped: number;
  /**
   * Misses by how many later letters were still on the line when erasing began:
   * index 0 is a miss caught at once, and the last bucket holds that many or more.
   */
  readonly noticedAfter: readonly number[];
  /** `misses / typedTaps` for taps at or under `tapDrift`, and over it. */
  readonly missRateUnderDrift: number;
  readonly missRateOverDrift: number;
  /**
   * Root-mean-square of the per-key mean offset, weighted by taps: once from
   * the drawn centre and once from the learned centre. The gap between the two
   * is how much systematic bias the learner removes.
   */
  readonly pooledBiasPx: number;
  readonly pooledResidualBiasPx: number;
  readonly keys: readonly KeyboardKeyOffset[];
}

export interface KeyboardDistribution {
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

export interface KeyboardDiagnosticsOptions {
  /**
   * A finished line's corrected miss: `intendedKeyId` was meant where `trace`
   * committed a neighbour. The offset learner's labelled evidence.
   */
  readonly onCorrection?: (
    trace: KeyboardTouchTrace,
    geometry: ResolvedKeyboardGeometry,
    intendedKeyId: string,
  ) => void;
}

export interface KeyboardDiagnostics {
  record(trace: KeyboardTouchTrace, geometry: ResolvedKeyboardGeometry | null): void;
  /**
   * Every commit from the keyboard, in order. A key that is neither a
   * character nor Backspace ends the line. True when that analysed a line.
   */
  recordCommit(key: KeyboardKeyDefinition, pointerId: number, repeat: boolean): boolean;
  /**
   * The line ended outside the keyboard's own commits. True when that
   * analysed a line.
   */
  recordBreak(): boolean;
  summary(driftThresholdPx: number): KeyboardDiagnosticsSummary;
  reset(): void;
  isEmpty(): boolean;
  snapshot(): KeyboardDiagnosticsSnapshot;
  restore(snapshot: KeyboardDiagnosticsSnapshot): void;
}

/** Serialisable accumulator state. Sums and counts only, never a sequence. */
export interface KeyboardDiagnosticsSnapshot {
  readonly taps: number;
  readonly uncommitted: number;
  readonly driftSum: number;
  readonly durationSum: number;
  readonly sampleSum: number;
  readonly drift: readonly number[];
  readonly duration: readonly number[];
  readonly samples: readonly number[];
  readonly interTap: readonly number[];
  readonly interTapSum: number;
  readonly interTapCount: number;
  readonly fastDriftSum: number;
  readonly fastDriftCount: number;
  readonly slowDriftSum: number;
  readonly slowDriftCount: number;
  readonly lines: number;
  readonly missesByPrior: number;
  readonly priorOverrides: number;
  readonly priorOverridesKept: number;
  readonly typedDrift: readonly number[];
  readonly missDrift: readonly number[];
  readonly noticed: readonly number[];
  readonly keys: readonly (Readonly<KeyAccumulator> & {
    readonly layerId: string;
    readonly keyId: string;
  })[];
}

const DRIFT_BUCKETS = 64;
const DURATION_BUCKET_MS = 10;
const DURATION_BUCKETS = 64;
const SAMPLE_BUCKETS = 33;
const INTER_TAP_BUCKET_MS = 20;
const INTER_TAP_BUCKETS = 64;
/** Roughly the fastest quartile of two-thumb typing, and the slowest. */
const FAST_INTER_TAP_MS = 150;
const SLOW_INTER_TAP_MS = 300;
/** Noticed after 0..14 later letters, and 15 or more. */
export const NOTICED_BUCKETS = 16;

export function createKeyboardDiagnostics(
  options?: KeyboardDiagnosticsOptions,
): KeyboardDiagnostics {
  // Nested maps rather than a composite string key: the hot path must not build
  // a string per keystroke just to index a table.
  const byLayer = new Map<string, Map<string, KeyAccumulator>>();
  const drift = new Uint32Array(DRIFT_BUCKETS);
  const duration = new Uint32Array(DURATION_BUCKETS);
  const samples = new Uint32Array(SAMPLE_BUCKETS);
  const interTap = new Uint32Array(INTER_TAP_BUCKETS);
  // Drift totals split by how quickly the tap followed its predecessor, which is
  // the correlation the whole speed question turns on.
  let fastDriftSum = 0;
  let fastDriftCount = 0;
  let slowDriftSum = 0;
  let slowDriftCount = 0;
  let previousContactAtMs = Number.NaN;
  let taps = 0;
  let uncommitted = 0;
  let driftSum = 0;
  let durationSum = 0;
  let sampleSum = 0;
  let interTapSum = 0;
  let interTapCount = 0;
  let overThreshold = 0;
  let lastThreshold = Number.NaN;
  let lines = 0;
  let missesByPrior = 0;
  let priorOverrides = 0;
  let priorOverridesKept = 0;
  // Drift of every analysed typed tap, and of the ones that were misses, so the
  // rate can be split at whatever `tapDrift` the profile has when read.
  const typedDrift = new Uint32Array(DRIFT_BUCKETS);
  const missDrift = new Uint32Array(DRIFT_BUCKETS);
  const noticed = new Uint32Array(NOTICED_BUCKETS);

  // The open line: one entry per typed key, or null for a Backspace, with the
  // trace and geometry each typed tap was decided on. Memory only, and every
  // slot a line used is wiped when it closes.
  const lineSymbols: (string | null)[] = [];
  const lineTraces: (KeyboardTouchTrace | null)[] = [];
  const lineGeometries: (ResolvedKeyboardGeometry | null)[] = [];
  let lineLength = 0;
  // An anchored tap commits at touch-down and traces at its lift, so its entry
  // waits here, by pointer, for the trace. A release-decided tap traces just
  // before its commit, so its trace waits in `pendingTrace` instead; commits of
  // older contacts that the lift resolves can come in between.
  const untraced = new Map<number, number>();
  let pendingTrace: KeyboardTouchTrace | null = null;
  let pendingGeometry: ResolvedKeyboardGeometry | null = null;
  const analyzer = createInputStreamAnalyzer();
  const onCorrection = options?.onCorrection;

  function accumulatorFor(layerId: string, keyId: string): KeyAccumulator {
    let layer = byLayer.get(layerId);
    if (layer === undefined) {
      layer = new Map();
      byLayer.set(layerId, layer);
    }
    let accumulator = layer.get(keyId);
    if (accumulator === undefined) {
      accumulator = emptyAccumulator();
      layer.set(keyId, accumulator);
    }
    return accumulator;
  }

  function record(trace: KeyboardTouchTrace, geometry: ResolvedKeyboardGeometry | null): void {
    const definition = trace.predictedKey;
    if (definition === null) {
      uncommitted += 1;
      return;
    }
    taps += 1;

    const travel = contactTravel(trace);
    driftSum += travel;
    bump(drift, Math.floor(travel));

    durationSum += trace.durationMs;
    bump(duration, Math.floor(trace.durationMs / DURATION_BUCKET_MS));

    sampleSum += trace.sampleCount;
    bump(samples, trace.sampleCount);

    const gap = trace.contactAtMs - previousContactAtMs;
    previousContactAtMs = trace.contactAtMs;
    if (Number.isFinite(gap) && gap > 0 && gap < INTER_TAP_BUCKETS * INTER_TAP_BUCKET_MS) {
      interTapSum += gap;
      interTapCount += 1;
      bump(interTap, Math.floor(gap / INTER_TAP_BUCKET_MS));
      if (gap < FAST_INTER_TAP_MS) {
        fastDriftSum += travel;
        fastDriftCount += 1;
      } else if (gap >= SLOW_INTER_TAP_MS) {
        slowDriftSum += travel;
        slowDriftCount += 1;
      }
    }

    if (geometry === null || geometry.layerId !== trace.layerId) return;
    const key = geometry.keys.find((candidate) => candidate.definition.id === definition.id);
    if (key === undefined) return;

    // The contact point is what the recognizer is anchored to, so it is the
    // point whose offset we care about; the release point is already summarised
    // by the drift histogram above.
    const offsetX = trace.downX - (key.rect.x + key.rect.width / 2);
    const offsetY = trace.downY - (key.rect.y + key.rect.height / 2);

    const accumulator = accumulatorFor(trace.layerId, definition.id);
    accumulator.count += 1;
    accumulator.sumX += offsetX;
    accumulator.sumY += offsetY;
    accumulator.sumXX += offsetX * offsetX;
    accumulator.sumYY += offsetY * offsetY;
    accumulator.sumXY += offsetX * offsetY;
    const residualX = trace.downX - trace.modelCenterX;
    const residualY = trace.downY - trace.modelCenterY;
    if (Number.isFinite(residualX) && Number.isFinite(residualY)) {
      accumulator.residualCount += 1;
      accumulator.sumResidualX += residualX;
      accumulator.sumResidualY += residualY;
    }

    if (!isTyped(definition)) return;
    const waiting = untraced.get(trace.pointerId);
    if (waiting !== undefined && lineSymbols[waiting] === definition.id) {
      untraced.delete(trace.pointerId);
      lineTraces[waiting] = trace;
      lineGeometries[waiting] = geometry;
      return;
    }
    pendingTrace = trace;
    pendingGeometry = geometry;
  }

  function recordCommit(key: KeyboardKeyDefinition, pointerId: number, repeat: boolean): boolean {
    if (key.value === 'Backspace') {
      append(null);
      return false;
    }
    if (!isTyped(key)) return closeLine();
    const index = append(key.id);
    // A held key's repeats are real characters on the line, but the contact
    // traces once, for the press that started it.
    if (repeat) return false;
    if (
      pendingTrace !== null &&
      pendingTrace.pointerId === pointerId &&
      pendingTrace.predictedKey?.id === key.id
    ) {
      lineTraces[index] = pendingTrace;
      lineGeometries[index] = pendingGeometry;
      pendingTrace = null;
      pendingGeometry = null;
      return false;
    }
    untraced.set(pointerId, index);
    return false;
  }

  function append(symbol: string | null): number {
    const index = lineLength;
    lineSymbols[index] = symbol;
    lineTraces[index] = null;
    lineGeometries[index] = null;
    lineLength += 1;
    return index;
  }

  function closeLine(): boolean {
    if (lineLength === 0) return false;
    analyzer.analyze(lineSymbols, lineLength, visit);
    wipeLine();
    lines += 1;
    return true;
  }

  /** Nothing of a line outlives it: every slot it used is cleared. */
  function wipeLine(): void {
    for (let index = 0; index < lineLength; index += 1) {
      lineSymbols[index] = null;
      lineTraces[index] = null;
      lineGeometries[index] = null;
    }
    lineLength = 0;
    untraced.clear();
  }

  /** Folds one typed entry of a finished line into the per-key counts. */
  function visit(
    index: number,
    kind: InputStreamClass,
    intended: string | null,
    noticedAfter: number,
  ): void {
    const trace = lineTraces[index] ?? null;
    const geometry = lineGeometries[index] ?? null;
    const committed = trace?.predictedKey ?? null;
    if (trace === null || geometry === null || committed === null) return;
    const accumulator = accumulatorFor(trace.layerId, committed.id);
    const driftBucket = clampBucket(DRIFT_BUCKETS, Math.floor(contactTravel(trace)));
    typedDrift[driftBucket] = (typedDrift[driftBucket] ?? 0) + 1;
    const overridden = trace.spatialKey !== null && trace.spatialKey.id !== committed.id;
    if (overridden) priorOverrides += 1;

    if (kind === INPUT_STREAM_KEPT) {
      accumulator.aimed += 1;
      if (overridden) priorOverridesKept += 1;
      return;
    }
    if (kind === INPUT_STREAM_ERASED_CORRECT) {
      accumulator.aimed += 1;
      accumulator.erasedCorrect += 1;
      return;
    }
    if (kind === INPUT_STREAM_OMISSION) {
      // The tap itself was right; the key before it was skipped.
      accumulator.aimed += 1;
      if (intended !== null && hasKey(geometry, intended)) {
        accumulatorFor(trace.layerId, intended).skipped += 1;
      }
      return;
    }
    if (kind === INPUT_STREAM_INSERTION) {
      accumulator.extra += 1;
      return;
    }
    // A substitution is a misread only when the replacement lies next to where
    // the finger landed; anywhere else it is a change of mind. The input stream
    // cannot tell those apart; the contact point can, and needs no text.
    const atlasOffset = keyboardHitAtlasOffset(geometry, trace.downX, trace.downY);
    if (intended === null || !candidatesInclude(geometry, atlasOffset, intended)) {
      accumulator.replaced += 1;
      return;
    }
    const meant = accumulatorFor(trace.layerId, intended);
    meant.aimed += 1;
    meant.missed += 1;
    accumulator.took += 1;
    missDrift[driftBucket] = (missDrift[driftBucket] ?? 0) + 1;
    bump(noticed, noticedAfter);
    if (trace.spatialKey?.id === intended) missesByPrior += 1;
    onCorrection?.(trace, geometry, intended);
  }

  function summary(driftThresholdPx: number): KeyboardDiagnosticsSummary {
    // The threshold can change with the profile, so recount rather than tracking
    // it incrementally against a value that may no longer apply.
    if (driftThresholdPx !== lastThreshold) {
      overThreshold = 0;
      for (let bucket = 0; bucket < DRIFT_BUCKETS; bucket += 1) {
        if (bucket >= driftThresholdPx) overThreshold += drift[bucket] ?? 0;
      }
      lastThreshold = driftThresholdPx;
    }

    const keys: KeyboardKeyOffset[] = [];
    let erasedCorrect = 0;
    let replaced = 0;
    let extra = 0;
    let skipped = 0;
    let biasWeight = 0;
    let biasSquares = 0;
    let residualWeight = 0;
    let residualSquares = 0;
    for (const [layerId, layer] of byLayer) {
      for (const [keyId, accumulator] of layer) {
        const n = accumulator.count;
        erasedCorrect += accumulator.erasedCorrect;
        replaced += accumulator.replaced;
        extra += accumulator.extra;
        skipped += accumulator.skipped;
        // A key can have correction counts and no landing samples of its own:
        // meant, missed, and never committed.
        const meanX = n === 0 ? 0 : accumulator.sumX / n;
        const meanY = n === 0 ? 0 : accumulator.sumY / n;
        const residualN = accumulator.residualCount;
        const residualX = residualN === 0 ? 0 : accumulator.sumResidualX / residualN;
        const residualY = residualN === 0 ? 0 : accumulator.sumResidualY / residualN;
        biasWeight += n;
        biasSquares += n * (meanX * meanX + meanY * meanY);
        residualWeight += residualN;
        residualSquares += residualN * (residualX * residualX + residualY * residualY);
        keys.push({
          layerId,
          keyId,
          count: n,
          offsetX: meanX,
          offsetY: meanY,
          sigmaX: n === 0 ? 0 : Math.sqrt(Math.max(0, accumulator.sumXX / n - meanX * meanX)),
          sigmaY: n === 0 ? 0 : Math.sqrt(Math.max(0, accumulator.sumYY / n - meanY * meanY)),
          residualX,
          residualY,
          aimed: accumulator.aimed,
          missed: accumulator.missed,
          took: accumulator.took,
          erasedCorrect: accumulator.erasedCorrect,
          replaced: accumulator.replaced,
          extra: accumulator.extra,
          skipped: accumulator.skipped,
        });
      }
    }
    keys.sort((left, right) => right.count - left.count);

    let typedTaps = 0;
    let typedOver = 0;
    let missesOver = 0;
    let misses = 0;
    for (let bucket = 0; bucket < DRIFT_BUCKETS; bucket += 1) {
      const typed = typedDrift[bucket] ?? 0;
      const missed = missDrift[bucket] ?? 0;
      typedTaps += typed;
      misses += missed;
      if (bucket >= driftThresholdPx) {
        typedOver += typed;
        missesOver += missed;
      }
    }
    const typedUnder = typedTaps - typedOver;

    return {
      taps,
      uncommitted,
      overDriftThreshold: taps === 0 ? 0 : overThreshold / taps,
      driftThresholdPx,
      driftPx: distribution(drift, taps, driftSum, 1, 0.5),
      durationMs: distribution(
        duration,
        taps,
        durationSum,
        DURATION_BUCKET_MS,
        DURATION_BUCKET_MS / 2,
      ),
      sampleCount: distribution(samples, taps, sampleSum, 1, 0),
      movementFreeFraction: taps === 0 ? 0 : (samples[2] ?? 0) / taps,
      sampleCountSaturated: (samples[SAMPLE_BUCKETS - 1] ?? 0) > 0,
      interTapMs: distribution(
        interTap,
        interTapCount,
        interTapSum,
        INTER_TAP_BUCKET_MS,
        INTER_TAP_BUCKET_MS / 2,
      ),
      driftWhenFast: fastDriftCount === 0 ? 0 : fastDriftSum / fastDriftCount,
      driftWhenSlow: slowDriftCount === 0 ? 0 : slowDriftSum / slowDriftCount,
      lines,
      typedTaps,
      misses,
      missesByPrior,
      priorOverrides,
      priorOverridesKept,
      erasedCorrect,
      replaced,
      extra,
      skipped,
      noticedAfter: Array.from(noticed),
      missRateUnderDrift: typedUnder === 0 ? 0 : (misses - missesOver) / typedUnder,
      missRateOverDrift: typedOver === 0 ? 0 : missesOver / typedOver,
      pooledBiasPx: biasWeight === 0 ? 0 : Math.sqrt(biasSquares / biasWeight),
      pooledResidualBiasPx: residualWeight === 0 ? 0 : Math.sqrt(residualSquares / residualWeight),
      keys,
    };
  }

  function reset(): void {
    byLayer.clear();
    drift.fill(0);
    duration.fill(0);
    samples.fill(0);
    interTap.fill(0);
    typedDrift.fill(0);
    missDrift.fill(0);
    noticed.fill(0);
    wipeLine();
    pendingTrace = null;
    pendingGeometry = null;
    fastDriftSum = 0;
    fastDriftCount = 0;
    slowDriftSum = 0;
    slowDriftCount = 0;
    interTapSum = 0;
    interTapCount = 0;
    previousContactAtMs = Number.NaN;
    taps = 0;
    uncommitted = 0;
    driftSum = 0;
    durationSum = 0;
    sampleSum = 0;
    overThreshold = 0;
    lastThreshold = Number.NaN;
    lines = 0;
    missesByPrior = 0;
    priorOverrides = 0;
    priorOverridesKept = 0;
  }

  function snapshot(): KeyboardDiagnosticsSnapshot {
    const keys: KeyboardDiagnosticsSnapshot['keys'][number][] = [];
    for (const [layerId, layer] of byLayer) {
      for (const [keyId, accumulator] of layer) {
        keys.push({ layerId, keyId, ...accumulator });
      }
    }
    return {
      taps,
      uncommitted,
      driftSum,
      durationSum,
      sampleSum,
      drift: Array.from(drift),
      duration: Array.from(duration),
      samples: Array.from(samples),
      interTap: Array.from(interTap),
      interTapSum,
      interTapCount,
      fastDriftSum,
      fastDriftCount,
      slowDriftSum,
      slowDriftCount,
      lines,
      missesByPrior,
      priorOverrides,
      priorOverridesKept,
      typedDrift: Array.from(typedDrift),
      missDrift: Array.from(missDrift),
      noticed: Array.from(noticed),
      keys,
    };
  }

  function restore(state: KeyboardDiagnosticsSnapshot): void {
    reset();
    taps = state.taps;
    uncommitted = state.uncommitted;
    driftSum = state.driftSum;
    durationSum = state.durationSum;
    sampleSum = state.sampleSum;
    copyInto(drift, state.drift);
    copyInto(duration, state.duration);
    copyInto(samples, state.samples);
    copyInto(interTap, state.interTap);
    interTapSum = state.interTapSum;
    interTapCount = state.interTapCount;
    fastDriftSum = state.fastDriftSum;
    fastDriftCount = state.fastDriftCount;
    slowDriftSum = state.slowDriftSum;
    slowDriftCount = state.slowDriftCount;
    lines = state.lines;
    missesByPrior = state.missesByPrior;
    priorOverrides = state.priorOverrides;
    priorOverridesKept = state.priorOverridesKept;
    copyInto(typedDrift, state.typedDrift);
    copyInto(missDrift, state.missDrift);
    copyInto(noticed, state.noticed);
    for (const entry of state.keys) {
      const accumulator = accumulatorFor(entry.layerId, entry.keyId);
      accumulator.count = entry.count;
      accumulator.sumX = entry.sumX;
      accumulator.sumY = entry.sumY;
      accumulator.sumXX = entry.sumXX;
      accumulator.sumYY = entry.sumYY;
      accumulator.sumXY = entry.sumXY;
      accumulator.residualCount = entry.residualCount;
      accumulator.sumResidualX = entry.sumResidualX;
      accumulator.sumResidualY = entry.sumResidualY;
      accumulator.aimed = entry.aimed;
      accumulator.missed = entry.missed;
      accumulator.took = entry.took;
      accumulator.erasedCorrect = entry.erasedCorrect;
      accumulator.replaced = entry.replaced;
      accumulator.extra = entry.extra;
      accumulator.skipped = entry.skipped;
    }
  }

  return {
    record,
    recordCommit,
    recordBreak: closeLine,
    summary,
    reset,
    isEmpty: () => taps === 0 && uncommitted === 0,
    snapshot,
    restore,
  };
}

function contactTravel(trace: KeyboardTouchTrace): number {
  const dx = trace.releaseX - trace.downX;
  const dy = trace.releaseY - trace.downY;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Clamps into the histogram's range; a NaN duration must not silently vanish. */
function bump(buckets: Uint32Array, rawIndex: number): void {
  const index = clampBucket(buckets.length, rawIndex);
  buckets[index] = (buckets[index] ?? 0) + 1;
}

function clampBucket(length: number, rawIndex: number): number {
  return Number.isFinite(rawIndex) ? Math.min(length - 1, Math.max(0, Math.floor(rawIndex))) : 0;
}

function emptyAccumulator(): KeyAccumulator {
  return {
    count: 0,
    sumX: 0,
    sumY: 0,
    sumXX: 0,
    sumYY: 0,
    sumXY: 0,
    residualCount: 0,
    sumResidualX: 0,
    sumResidualY: 0,
    aimed: 0,
    missed: 0,
    took: 0,
    erasedCorrect: 0,
    replaced: 0,
    extra: 0,
    skipped: 0,
  };
}

/**
 * A loop rather than `keys.some` with an arrow: a closure over `visit`'s
 * locals would make JavaScriptCore allocate a scope on every visit.
 */
function hasKey(geometry: ResolvedKeyboardGeometry, keyId: string): boolean {
  for (const key of geometry.keys) {
    if (key.definition.id === keyId) return true;
  }
  return false;
}

/** A key that puts one character on the line, which is what Backspace undoes. */
function isTyped(key: KeyboardKeyDefinition): boolean {
  return key.value !== undefined && key.value.length === 1;
}

/** Whether `keyId` is one of the candidates the atlas lists at `atlasOffset`. */
function candidatesInclude(
  geometry: ResolvedKeyboardGeometry,
  atlasOffset: number,
  keyId: string,
): boolean {
  if (atlasOffset < 0) return false;
  const base = atlasOffset * KEYBOARD_CANDIDATE_COUNT;
  for (let position = 0; position < KEYBOARD_CANDIDATE_COUNT; position += 1) {
    const index = geometry.candidateAtlas[base + position];
    if (index === undefined) continue;
    if (geometry.keys[index]?.definition.id === keyId) return true;
  }
  return false;
}

function copyInto(target: Uint32Array, source: readonly number[]): void {
  const length = Math.min(target.length, source.length);
  for (let index = 0; index < length; index += 1) {
    const value = source[index] ?? 0;
    target[index] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
}

/** Percentiles read off a histogram; `centre` places a value inside its bucket. */
function distribution(
  buckets: Uint32Array,
  total: number,
  sum: number,
  scale: number,
  centre: number,
): KeyboardDistribution {
  if (total === 0) return { p50: 0, p90: 0, p99: 0, max: 0, mean: 0 };
  const at = (quantile: number): number => {
    const target = quantile * total;
    let seen = 0;
    for (let bucket = 0; bucket < buckets.length; bucket += 1) {
      seen += buckets[bucket] ?? 0;
      if (seen >= target) return bucket * scale + centre;
    }
    return (buckets.length - 1) * scale + centre;
  };
  let max = 0;
  for (let bucket = buckets.length - 1; bucket >= 0; bucket -= 1) {
    if ((buckets[bucket] ?? 0) > 0) {
      max = bucket * scale + centre;
      break;
    }
  }
  return { p50: at(0.5), p90: at(0.9), p99: at(0.99), max, mean: sum / total };
}

/**
 * Renders a summary as plain text. Kept separate from the accumulator so the
 * recording path never touches string formatting.
 */
export function formatKeyboardDiagnostics(summary: KeyboardDiagnosticsSummary): string {
  if (summary.taps === 0) return 'No taps recorded yet.';
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);
  const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
  const noticed = summary.noticedAfter
    .map((count, after) =>
      count === 0
        ? null
        : `${after === summary.noticedAfter.length - 1 ? `${after}+` : after}: ${percent(ratio(count, summary.misses))}`,
    )
    .filter((cell) => cell !== null)
    .join('  ');
  const lines = [
    `taps ${summary.taps}  uncommitted ${summary.uncommitted}`,
    `contact-to-release travel: p50 ${summary.driftPx.p50.toFixed(1)}px  p90 ${summary.driftPx.p90.toFixed(1)}px  p99 ${summary.driftPx.p99.toFixed(1)}px  max ${summary.driftPx.max.toFixed(0)}px`,
    `  over the ${summary.driftThresholdPx}px tapDrift threshold: ${percent(summary.overDriftThreshold)} of taps`,
    `contact duration: p50 ${summary.durationMs.p50.toFixed(0)}ms  p90 ${summary.durationMs.p90.toFixed(0)}ms  p99 ${summary.durationMs.p99.toFixed(0)}ms`,
    `inter-tap interval: p50 ${summary.interTapMs.p50.toFixed(0)}ms  p90 ${summary.interTapMs.p90.toFixed(0)}ms  mean ${summary.interTapMs.mean.toFixed(0)}ms`,
    `  contact travel when typing fast (<150ms gap): ${summary.driftWhenFast.toFixed(2)}px`,
    `  contact travel when typing slow (>=300ms gap): ${summary.driftWhenSlow.toFixed(2)}px`,
    `pointer samples per tap: p50 ${summary.sampleCount.p50.toFixed(0)}  p90 ${summary.sampleCount.p90.toFixed(0)}  mean ${summary.sampleCount.mean.toFixed(1)}`,
    `  taps with only a down and a release sample, no movement: ${percent(summary.movementFreeFraction)}`,
    ...(summary.sampleCountSaturated
      ? ['  (sample counts are clamped by the trajectory ring, so the figures above are a floor)']
      : []),
    '',
    'corrections (every finished line, however late a mistake was noticed):',
    `  lines ${summary.lines}  typed ${summary.typedTaps}  ` +
      `misses ${summary.misses} (${percent(ratio(summary.misses, summary.typedTaps))}): ` +
      'retyped as one of the four keys nearest the tap',
    `  misses the finger made ${summary.misses - summary.missesByPrior}  ` +
      `the next-letter guess made ${summary.missesByPrior}`,
    ...(summary.misses === 0 ? [] : [`  letters typed after a miss before erasing: ${noticed}`]),
    `  miss rate: at or under the ${summary.driftThresholdPx}px tapDrift ${percent(summary.missRateUnderDrift)}  ` +
      `over it ${percent(summary.missRateOverDrift)}`,
    `  erased although right ${summary.erasedCorrect}  replaced by a key far from the tap ${summary.replaced}  ` +
      `extra taps ${summary.extra}  skipped keys ${summary.skipped}`,
    `  next-letter guess overruled the touch ${summary.priorOverrides} times: ` +
      `kept ${summary.priorOverridesKept}, corrected back ${summary.missesByPrior}`,
    `per-key bias, pooled: from the drawn centre ${summary.pooledBiasPx.toFixed(1)}px  ` +
      `from the learned centre ${summary.pooledResidualBiasPx.toFixed(1)}px`,
    '',
    'per-key landing offset from the drawn centre, residual from the learned centre (px), most-typed first:',
  ];
  for (const key of summary.keys.filter((entry) => entry.count > 0).slice(0, 20)) {
    lines.push(
      `  ${key.layerId}/${key.keyId.padEnd(14)} n=${String(key.count).padStart(4)}  ` +
        `offset=(${signed(key.offsetX)}, ${signed(key.offsetY)})  ` +
        `residual=(${signed(key.residualX)}, ${signed(key.residualY)})  ` +
        `sigma=(${key.sigmaX.toFixed(1)}, ${key.sigmaY.toFixed(1)})`,
    );
  }
  // Worst-missed first. Its own table, because sorting the offset table by rate
  // would push the most-typed keys out of its top twenty. Ties go to the key
  // aimed at more often, whose rate rests on more evidence.
  const missedKeys = summary.keys
    .filter((key) => key.missed > 0 || key.took > 0)
    .sort(
      (left, right) =>
        ratio(right.missed, right.aimed) - ratio(left.missed, left.aimed) ||
        right.aimed - left.aimed,
    );
  if (missedKeys.length > 0) {
    lines.push('', 'per-key misses as a share of the taps meant for that key, highest first:');
    for (const key of missedKeys.slice(0, 20)) {
      lines.push(
        `  ${key.layerId}/${key.keyId.padEnd(14)} aimed=${String(key.aimed).padStart(4)}  ` +
          `missed ${String(key.missed).padStart(3)} (${percent(ratio(key.missed, key.aimed)).padStart(6)})  ` +
          `took ${String(key.took).padStart(3)} from neighbours`,
      );
    }
  }
  return lines.join('\n');
}
