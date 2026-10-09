/**
 * Landing offsets learned from ordinary typing: a pooled linear grip field
 * under per-key residuals.
 *
 * Most people do not tap the middle of a key. They tap consistently a little to
 * one side, and which side depends on the hand, the grip and the row. Merkur
 * centres every key's spatial model on its visual centre, so that bias is spent
 * entirely out of the error budget. Correcting it is the cheapest accuracy win
 * available and, unlike a context prior, it can never produce a character the
 * user did not aim near.
 *
 * TWO LAYERS, BOTH MEASURED. The total correction for a key is a smooth linear
 * field over normalized board position plus that key's own residual. The field
 * exists because grip bias has a spatially-shared component that per-key
 * estimates relearn key by key: leave-one-key-out over the 30 HOW-WE-TYPE-MOBILE
 * participants predicts a held-out key's bias at 7.82 px rms with no model,
 * 6.07 px with a linear field (better for 29 of 30 people), and 6.35 px with a
 * quadratic — so the field is linear, and deliberately not quadratic, which
 * also re-confirms the single-device rejection recorded in PERF.md. The field
 * is fitted by recursive least squares with NO forgetting factor: typing
 * concentrates on the home row, the textbook non-persistently-exciting input
 * that makes forgetting blow the covariance up, and converge-and-freeze matches
 * the residuals' Robbins-Monro schedule anyway. One P matrix per axis, because
 * the wide-key exclusion below gives the two axes different regressor streams.
 *
 * WHY THIS DOES NOT RUN AWAY. Learning from your own output is normally
 * unsound: if the decoder commits `w` when the user meant `e`, recording that
 * tap as a `w` pulls `w`'s centre toward `e` and makes the next such tap worse.
 * The fix is to learn only from taps whose commit is not in doubt: inside the
 * anchor around the CURRENT combined prediction — field plus per-key offset,
 * clamps included — or inside the anchor around the visual centre, where the
 * decoder's own anchor-commit guarantee makes the tap unambiguous by
 * definition. The moving window is an EM iteration: it travels with the
 * estimate, and for a symmetric error distribution the fixed point is reached
 * exactly when the combined centre sits on the true mean, because that is when
 * the truncated residuals average to zero. The visual window is the recovery
 * path: when the shared field has moved a key's prediction the wrong way, its
 * anchor-committed taps still train — gating on the moving window alone let
 * exactly those taps be rejected forever, measured as the pooled model landing
 * 5 pp BELOW no learner under a non-smooth injected bias. Every accepted
 * residual stays bounded by an anchor plus the clamps, so the model cannot
 * diverge.
 *
 * The field is shared across layers within a model — grip is a property of
 * hand and board, not of which legend is painted on — while per-key residuals
 * stay per layer. Field output is in key-pitch and row-pitch units so a wide
 * key is not given a wide correction; per-key offsets stay fractions of each
 * key's own rect. Both therefore survive a rotation, a resize, or a different
 * device without being refitted.
 */
import type { KeyboardTouchModel, KeyboardTouchTrace, ResolvedKeyboardGeometry } from './types';

/**
 * Half-extent of the region where a commit is treated as certainly correct, as a
 * fraction of the key. Wider gathers data faster and admits more genuinely wrong
 * commits; this sits just outside the decoder's own 0.25 anchor so that every
 * tap the decoder considered unambiguous is also a training example.
 */
const LEARN_ANCHOR = 0.35;
/**
 * Pseudo-count damping the first observations: a tap moves the estimate by
 * `1/(count + this)` of its residual, a Robbins-Monro schedule that converges
 * almost surely while the step shrinks.
 *
 * Swept rather than reasoned. Replaying 12,693 real taps with an injected
 * per-key bias of the magnitude a device actually reported, and running this
 * learner online through the real engine, accuracy against the pseudo-count is
 * +5.97 pp at 1, +7.48 at 2, +8.09 at 4, **+8.86 at 8**, +7.78 at 20. Too small
 * and the estimate chases noise; too large and it never arrives.
 *
 * A shrinkage argument — `n / (n + sigma^2/tau^2)` over a measured within-key
 * sigma of about 10 px and a between-key offset spread of about 15 px — puts the
 * optimum near 0.4. That was directionally right about the previous value of 20
 * being far too cautious, and wrong about how far to go; the measurement wins.
 *
 * The downside of moving faster is bounded anyway: `classifyKeyboardTouch`
 * anchors on the visible key unconditionally, so even a badly-swung estimate
 * still types what the user is looking at.
 */
const PRIOR_SAMPLES = 8;
/**
 * How far a key's modelled centre may move in total — field plus residual — as
 * a fraction of the layout's key pitch and row pitch.
 *
 * Half a pitch is the geometric limit: beyond it the model centre would sit
 * closer to a neighbour's visible position than to its own key's, which is
 * incoherent whatever the data says.
 *
 * This used to be a quarter of the key's own extent, tied to the decoder's
 * anchor out of caution about a personalised model contradicting the visible
 * layout. That caution is now handled where it belongs — `classifyKeyboardTouch`
 * enforces the anchor unconditionally, so a tap on a key's visible centre types
 * that key however far its model has moved. Measured on a real device, the old
 * bound was throwing away half the correction: 10 of 20 keys with data had a
 * true bias larger than it allowed, several by two to three times.
 *
 * Swept on the same replay: +6.65 pp at the old bound, +8.79 at 0.35, and +8.86
 * at 0.5 and at every larger value tried. It stops binding before half a pitch,
 * so this sits above the knee with margin while keeping the geometric
 * justification that a larger value would forfeit.
 */
const MAXIMUM_OFFSET_PITCHES = 0.5;
/** Intercept, then the two scaled position terms. */
const FIELD_DIMS = 3;
/**
 * Ridge prior on each field coefficient, expressed as pseudo-taps: the field
 * starts as if this many centred taps had already voted for zero. Swept at 2
 * and 8 through the replay rig: on the real participant biases the two are
 * within 0.1 pp of each other, and 8 halves the cold-start damage under a
 * synthetic spatially-uncorrelated bias — the robustness-leaning choice at no
 * measured cost.
 */
const FIELD_RIDGE_PSEUDO_TAPS = 8;
/**
 * The field's own evaluation bound per axis, leaving the residuals headroom
 * inside the half-pitch total. Mirrors the learning anchor's scale.
 */
const FIELD_CLAMP_PITCHES = 0.35;
/**
 * Robustness truncation on the field's per-tap error, in pitch units. For
 * letter keys the learning anchor already binds tighter; this exists for the
 * wide keys, whose anchor admits pitch-sized errors.
 */
const FIELD_ERROR_CLIP_PITCHES = 0.35;
/**
 * Keys wider than this many pitches contribute no x-axis field evidence:
 * scatter along the space bar is key geometry, not grip, and space alone is
 * roughly a fifth of all taps. Their y evidence is real — the measured device
 * hit space 32 px low — and their residuals still learn both axes.
 */
const FIELD_WIDE_KEY_PITCHES = 1.25;

interface KeyMetrics {
  readonly key: ResolvedKeyboardGeometry['keys'][number];
  readonly keyPitch: number;
  readonly rowPitch: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly su: number;
  readonly sv: number;
  readonly boundX: number;
  readonly boundY: number;
}

// Resolved geometry is immutable; a replacement geometry gets its own metrics.
// Weak ownership lets old layer/size atlases and their measurements retire together.
const metricsByGeometry = new WeakMap<ResolvedKeyboardGeometry, Map<string, KeyMetrics>>();

function geometryMetrics(geometry: ResolvedKeyboardGeometry) {
  const cached = metricsByGeometry.get(geometry);
  if (cached !== undefined) return cached;
  const keyPitch = geometry.width / 10;
  const rows = geometry.rows.length;
  const byId = new Map<string, KeyMetrics>();
  for (const key of geometry.keys) {
    const rowPitch = rows > 1 ? geometry.hitHeight / rows : key.rect.height;
    const centerX = key.rect.x + key.rect.width / 2;
    const centerY = key.rect.y + key.rect.height / 2;
    const metrics = {
      key,
      keyPitch,
      rowPitch,
      centerX,
      centerY,
      su: 2 * (centerX / geometry.width - 0.5),
      sv: 2 * (centerY / geometry.hitHeight - 0.5),
      boundX: offsetBound(keyPitch, key.rect.width),
      boundY: offsetBound(rowPitch, key.rect.height),
    };
    if (!byId.has(key.definition.id)) byId.set(key.definition.id, metrics);
  }
  metricsByGeometry.set(geometry, byId);
  return byId;
}

interface KeyOffset {
  count: number;
  /** Fractions of the key's own width and height. */
  x: number;
  y: number;
}

export interface KeyboardOffsetSnapshot {
  readonly field: {
    readonly count: number;
    /** Coefficients over [1, su, sv], in key pitches. */
    readonly thetaX: readonly number[];
    /** Coefficients over [1, su, sv], in row pitches. */
    readonly thetaY: readonly number[];
    /** Row-major 3x3 RLS covariance, x axis. */
    readonly px: readonly number[];
    /** Row-major 3x3 RLS covariance, y axis. */
    readonly py: readonly number[];
  };
  readonly keys: readonly {
    readonly layerId: string;
    readonly keyId: string;
    readonly count: number;
    readonly x: number;
    readonly y: number;
  }[];
}

export interface KeyboardOffsetModelOptions {
  /**
   * Disables the grip field, leaving the flat per-key learner. Exists for the
   * replay harness's ablation arm; the shipped configuration is the default.
   */
  readonly gripField?: boolean;
}

export interface KeyboardOffsetModel {
  /** Folds one committed tap in. Returns true when the estimate moved. */
  record(trace: KeyboardTouchTrace, geometry: ResolvedKeyboardGeometry): boolean;
  /**
   * Folds in a tap the user corrected: input-stream analysis of the finished
   * line says `intendedKeyId` was meant where this tap committed another key.
   * Returns true when the estimate moved.
   */
  recordCorrection(
    trace: KeyboardTouchTrace,
    geometry: ResolvedKeyboardGeometry,
    intendedKeyId: string,
  ): boolean;
  /** Applies the learned field and offsets on top of a base spatial model. */
  apply(geometry: ResolvedKeyboardGeometry, base: KeyboardTouchModel): KeyboardTouchModel;
  /** Number of keys with any accumulated evidence, for reporting. */
  learnedKeyCount(): number;
  /** Accepted taps the grip field has consumed. */
  fieldSampleCount(): number;
  snapshot(): KeyboardOffsetSnapshot;
  restore(snapshot: KeyboardOffsetSnapshot): void;
  reset(): void;
}

export function createKeyboardOffsetModel(
  options?: KeyboardOffsetModelOptions,
): KeyboardOffsetModel {
  const gripField = options?.gripField !== false;
  // Nested maps so the typing path never builds a composite string key.
  const byLayer = new Map<string, Map<string, KeyOffset>>();
  const thetaX = new Float64Array(FIELD_DIMS);
  const thetaY = new Float64Array(FIELD_DIMS);
  const px = createRidgeCovariance();
  const py = createRidgeCovariance();
  let fieldCount = 0;
  // Per-tap scratch, allocated once: the record path must not allocate.
  const pPhi = new Float64Array(FIELD_DIMS);

  function offsetFor(layerId: string, keyId: string): KeyOffset {
    let layer = byLayer.get(layerId);
    if (layer === undefined) {
      layer = new Map();
      byLayer.set(layerId, layer);
    }
    let offset = layer.get(keyId);
    if (offset === undefined) {
      offset = { count: 0, x: 0, y: 0 };
      layer.set(keyId, offset);
    }
    return offset;
  }

  function fieldAt(theta: Float64Array, su: number, sv: number): number {
    if (!gripField) return 0;
    const value = (theta[0] ?? 0) + (theta[1] ?? 0) * su + (theta[2] ?? 0) * sv;
    return clamp(value, FIELD_CLAMP_PITCHES);
  }

  /**
   * One rank-1 RLS step on this axis. Returns the gain kappa in (0, 1): the
   * share of the error the field just absorbed, which the per-key residual
   * must therefore leave alone.
   */
  function fieldStep(
    p: Float64Array,
    theta: Float64Array,
    error: number,
    su: number,
    sv: number,
  ): number {
    // The field is always [1, su, sv]. Preserve the loop's addition order,
    // including its initial zero, while loading each projection just once.
    for (let row = 0; row < FIELD_DIMS; row += 1) {
      const start = row * FIELD_DIMS;
      pPhi[row] = 0 + (p[start] ?? 0) + (p[start + 1] ?? 0) * su + (p[start + 2] ?? 0) * sv;
    }
    const projected0 = pPhi[0] ?? 0;
    const projected1 = pPhi[1] ?? 0;
    const projected2 = pPhi[2] ?? 0;
    const s = 0 + projected0 + su * projected1 + sv * projected2;
    if (!Number.isFinite(s) || s <= 0) return 0;
    const denominator = 1 + s;
    for (let row = 0; row < FIELD_DIMS; row += 1) {
      const gain = (pPhi[row] ?? 0) / denominator;
      theta[row] = (theta[row] ?? 0) + gain * error;
      const start = row * FIELD_DIMS;
      p[start] = (p[start] ?? 0) - gain * projected0;
      p[start + 1] = (p[start + 1] ?? 0) - gain * projected1;
      p[start + 2] = (p[start + 2] ?? 0) - gain * projected2;
    }

    // The rank-1 downdate is only exact while P stays symmetric, and float
    // drift breaks that silently over enough taps; re-symmetrize each step.
    for (let row = 0; row < FIELD_DIMS; row += 1) {
      for (let column = row + 1; column < FIELD_DIMS; column += 1) {
        const mean =
          ((p[row * FIELD_DIMS + column] ?? 0) + (p[column * FIELD_DIMS + row] ?? 0)) / 2;
        p[row * FIELD_DIMS + column] = mean;
        p[column * FIELD_DIMS + row] = mean;
      }
    }
    return s / denominator;
  }

  function record(trace: KeyboardTouchTrace, geometry: ResolvedKeyboardGeometry): boolean {
    const definition = trace.predictedKey;
    if (definition === null) return false;
    return learn(trace, geometry, definition.id, false);
  }

  function recordCorrection(
    trace: KeyboardTouchTrace,
    geometry: ResolvedKeyboardGeometry,
    intendedKeyId: string,
  ): boolean {
    return learn(trace, geometry, intendedKeyId, true);
  }

  /**
   * `labelled` is true when the user named the key, by retyping it in this
   * tap's place. The windows below exist only because an unlabelled tap's key
   * is the decoder's own guess; a labelled one is exempt from them, and stays
   * bounded by the same clamps.
   */
  function learn(
    trace: KeyboardTouchTrace,
    geometry: ResolvedKeyboardGeometry,
    keyId: string,
    labelled: boolean,
  ): boolean {
    if (geometry.layerId !== trace.layerId) return false;
    const metrics = geometryMetrics(geometry).get(keyId);
    if (metrics === undefined) return false;
    const { key, keyPitch, rowPitch, centerX, centerY, su, sv, boundX, boundY } = metrics;
    const offset = offsetFor(trace.layerId, keyId);

    // The residual is measured from the combined prediction — field plus
    // per-key offset, clamps included — exactly as `apply` computes it. That
    // is what makes this an EM step rather than a one-shot truncated mean.
    const fieldX = fieldAt(thetaX, su, sv) * keyPitch;
    const fieldY = fieldAt(thetaY, su, sv) * rowPitch;
    const totalX = clamp(
      fieldX + clamp(offset.x, boundX) * key.rect.width,
      MAXIMUM_OFFSET_PITCHES * keyPitch,
    );
    const totalY = clamp(
      fieldY + clamp(offset.y, boundY) * key.rect.height,
      MAXIMUM_OFFSET_PITCHES * rowPitch,
    );
    const errorX = trace.downX - (centerX + totalX);
    const errorY = trace.downY - (centerY + totalY);
    const residualX = errorX / key.rect.width;
    const residualY = errorY / key.rect.height;
    if (!Number.isFinite(residualX) || !Number.isFinite(residualY)) return false;
    // Accept a tap inside EITHER window: the moving one around the combined
    // prediction (the EM window), or the fixed one around the visual centre.
    // The visual window restores the stated contract — a tap the decoder
    // anchor-commits is unambiguous by definition and must train — and it is
    // what lets a key recover when the shared field has moved its prediction
    // the wrong way: gating on the moving window alone let exactly that key's
    // taps be rejected forever, measured as pooled landing 5 pp BELOW no
    // learner under a non-smooth injected bias.
    const centredX = (trace.downX - centerX) / key.rect.width;
    const centredY = (trace.downY - centerY) / key.rect.height;
    const inMovingWindow =
      Math.abs(residualX) <= LEARN_ANCHOR && Math.abs(residualY) <= LEARN_ANCHOR;
    const inVisualWindow = Math.abs(centredX) <= LEARN_ANCHOR && Math.abs(centredY) <= LEARN_ANCHOR;
    if (!labelled && !inMovingWindow && !inVisualWindow) return false;

    if (gripField) {
      // The field fits its OWN marginal error — the tap against centre plus
      // field, residual excluded — while the residual fits the combined
      // leftover. Decoupled targets on purpose: when both layers consumed the
      // same combined error, every key's taps moved every other key's target
      // through the shared field, and the residuals' shrinking steps tracked
      // that moving target too slowly — measured as 2 pp under a non-smooth
      // injected bias. With its own stable target the field converges to the
      // marginal linear fit and each residual to its key's fixed leftover. The
      // cost is a small bounded transient: the residual briefly fits what the
      // still-moving field later absorbs, overshooting the bias by ~13% at its
      // worst before decaying, always inside the half-pitch total clamp.
      const fieldOwnX = trace.downX - (centerX + fieldX);
      const fieldOwnY = trace.downY - (centerY + fieldY);
      if (key.rect.width <= FIELD_WIDE_KEY_PITCHES * keyPitch) {
        fieldStep(px, thetaX, clamp(fieldOwnX / keyPitch, FIELD_ERROR_CLIP_PITCHES), su, sv);
      }
      fieldStep(py, thetaY, clamp(fieldOwnY / rowPitch, FIELD_ERROR_CLIP_PITCHES), su, sv);
      fieldCount += 1;
    }

    offset.count += 1;
    const step = 1 / (offset.count + PRIOR_SAMPLES);
    offset.x = clamp(offset.x + residualX * step, boundX);
    offset.y = clamp(offset.y + residualY * step, boundY);
    return true;
  }

  function apply(geometry: ResolvedKeyboardGeometry, base: KeyboardTouchModel): KeyboardTouchModel {
    const layer = byLayer.get(geometry.layerId);
    const layerEmpty = layer === undefined || layer.size === 0;
    if (fieldCount === 0 && layerEmpty) return base;
    const keyPitch = geometry.width / 10;
    const rows = geometry.rows.length;
    const centerX = new Float64Array(base.centerX);
    const centerY = new Float64Array(base.centerY);
    for (const key of geometry.keys) {
      const rowPitch = rows > 1 ? geometry.hitHeight / rows : key.rect.height;
      const su = 2 * ((key.rect.x + key.rect.width / 2) / geometry.width - 0.5);
      const sv = 2 * ((key.rect.y + key.rect.height / 2) / geometry.hitHeight - 0.5);
      const offset = layer?.get(key.definition.id);
      let residualX = 0;
      let residualY = 0;
      if (offset !== undefined) {
        const boundX = offsetBound(keyPitch, key.rect.width);
        const boundY = offsetBound(rowPitch, key.rect.height);
        residualX = clamp(offset.x, boundX) * key.rect.width;
        residualY = clamp(offset.y, boundY) * key.rect.height;
      }
      centerX[key.index] =
        (centerX[key.index] ?? 0) +
        clamp(fieldAt(thetaX, su, sv) * keyPitch + residualX, MAXIMUM_OFFSET_PITCHES * keyPitch);
      centerY[key.index] =
        (centerY[key.index] ?? 0) +
        clamp(fieldAt(thetaY, su, sv) * rowPitch + residualY, MAXIMUM_OFFSET_PITCHES * rowPitch);
    }
    return {
      keyCount: base.keyCount,
      centerX,
      centerY,
      precisionXX: base.precisionXX,
      precisionXY: base.precisionXY,
      precisionYY: base.precisionYY,
    };
  }

  function learnedKeyCount(): number {
    let total = 0;
    for (const layer of byLayer.values()) {
      for (const offset of layer.values()) if (offset.count > 0) total += 1;
    }
    return total;
  }

  function snapshot(): KeyboardOffsetSnapshot {
    const keys: KeyboardOffsetSnapshot['keys'][number][] = [];
    for (const [layerId, layer] of byLayer) {
      for (const [keyId, offset] of layer) {
        keys.push({ layerId, keyId, count: offset.count, x: offset.x, y: offset.y });
      }
    }
    return {
      field: {
        count: fieldCount,
        thetaX: [...thetaX],
        thetaY: [...thetaY],
        px: [...px],
        py: [...py],
      },
      keys,
    };
  }

  function restore(state: KeyboardOffsetSnapshot): void {
    reset();
    fieldCount = state.field.count;
    thetaX.set(state.field.thetaX.slice(0, FIELD_DIMS));
    thetaY.set(state.field.thetaY.slice(0, FIELD_DIMS));
    px.set(state.field.px.slice(0, FIELD_DIMS * FIELD_DIMS));
    py.set(state.field.py.slice(0, FIELD_DIMS * FIELD_DIMS));
    for (const entry of state.keys) {
      const offset = offsetFor(entry.layerId, entry.keyId);
      offset.count = entry.count;
      // Restored values are re-clamped on use rather than here, because the
      // bound depends on the geometry this model is being applied to.
      offset.x = entry.x;
      offset.y = entry.y;
    }
  }

  function reset(): void {
    byLayer.clear();
    thetaX.fill(0);
    thetaY.fill(0);
    px.fill(0);
    py.fill(0);
    for (let diagonal = 0; diagonal < FIELD_DIMS; diagonal += 1) {
      px[diagonal * FIELD_DIMS + diagonal] = 1 / FIELD_RIDGE_PSEUDO_TAPS;
      py[diagonal * FIELD_DIMS + diagonal] = 1 / FIELD_RIDGE_PSEUDO_TAPS;
    }
    fieldCount = 0;
  }

  return {
    record,
    recordCorrection,
    apply,
    learnedKeyCount,
    fieldSampleCount: () => fieldCount,
    snapshot,
    restore,
    reset,
  };
}

/**
 * Runtime guard for a persisted snapshot. Lives with the shape it validates;
 * the storage layer supplies the value, this decides whether it is one. A v1
 * snapshot has no field block and fails here, which is the intended hard
 * cutover: relearning costs a few hundred taps.
 */
export function isKeyboardOffsetSnapshot(value: unknown): value is KeyboardOffsetSnapshot {
  if (!isRecord(value) || !isRecord(value.field) || !Array.isArray(value.keys)) return false;
  const field = value.field;
  if (
    typeof field.count !== 'number' ||
    !Number.isSafeInteger(field.count) ||
    field.count < 0 ||
    !isFiniteNumberArray(field.thetaX, FIELD_DIMS) ||
    !isFiniteNumberArray(field.thetaY, FIELD_DIMS) ||
    !isFiniteNumberArray(field.px, FIELD_DIMS * FIELD_DIMS) ||
    !isFiniteNumberArray(field.py, FIELD_DIMS * FIELD_DIMS)
  ) {
    return false;
  }
  return value.keys.every((entry) => {
    if (!isRecord(entry)) return false;
    return (
      typeof entry.layerId === 'string' &&
      typeof entry.keyId === 'string' &&
      typeof entry.count === 'number' &&
      Number.isSafeInteger(entry.count) &&
      entry.count >= 0 &&
      typeof entry.x === 'number' &&
      Number.isFinite(entry.x) &&
      typeof entry.y === 'number' &&
      Number.isFinite(entry.y)
    );
  });
}

function createRidgeCovariance(): Float64Array {
  const p = new Float64Array(FIELD_DIMS * FIELD_DIMS);
  for (let diagonal = 0; diagonal < FIELD_DIMS; diagonal += 1) {
    p[diagonal * FIELD_DIMS + diagonal] = 1 / FIELD_RIDGE_PSEUDO_TAPS;
  }
  return p;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumberArray(value: unknown, length: number): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

/**
 * The bound in the units the offsets are stored in — fractions of the key's own
 * rect — derived from the layout's pitch so a wide key is not given a wide
 * licence to move.
 *
 * The geometric half-pitch limit is enforced on the TOTAL, field included, at
 * apply time; this per-key bound exists only to keep the stored value itself
 * from drifting without limit. It is therefore the half-pitch limit PLUS the
 * field clamp: a residual must always be able to cancel a maximally wrong
 * field, or a key whose bias opposes the field's trend sticks short of its
 * truth forever — measured as a 3.5 pp asymptotic gap under a non-smooth
 * injected bias before this headroom existed.
 */
function offsetBound(pitch: number, extent: number): number {
  return ((MAXIMUM_OFFSET_PITCHES + FIELD_CLAMP_PITCHES) * pitch) / Math.max(1, extent);
}

function clamp(value: number, bound: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(bound, Math.max(-bound, value));
}
