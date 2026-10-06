import { KEYBOARD_CANDIDATE_COUNT, keyboardHitAtlasOffset } from './geometry';
import type { KeyboardTouchModel, ResolvedKeyboardGeometry } from './types';

const NO_KEY = 255;
const STUDENT_T_DEGREES_OF_FREEDOM = 4;
const STUDENT_T_EXPONENT = -3;
const MINIMUM_SIGMA_PX = 4;

/** Fixed spatial prior derived directly from the visible key dimensions. */
export function createKeyboardSpatialPrior(geometry: ResolvedKeyboardGeometry): KeyboardTouchModel {
  const keyCount = geometry.keys.length;
  const centerX = new Float64Array(keyCount);
  const centerY = new Float64Array(keyCount);
  const precisionXX = new Float32Array(keyCount);
  const precisionXY = new Float32Array(keyCount);
  const precisionYY = new Float32Array(keyCount);

  for (const key of geometry.keys) {
    centerX[key.index] = key.rect.x + key.rect.width * 0.5;
    centerY[key.index] = key.rect.y + key.rect.height * 0.5;
    const sigmaX = Math.max(MINIMUM_SIGMA_PX, key.rect.width * 0.48);
    const sigmaY = Math.max(MINIMUM_SIGMA_PX, key.rect.height * 0.48);
    precisionXX[key.index] = 1 / (sigmaX * sigmaX);
    precisionYY[key.index] = 1 / (sigmaY * sigmaY);
  }

  return { keyCount, centerX, centerY, precisionXX, precisionXY, precisionYY };
}

export function validateKeyboardTouchModel(
  geometry: ResolvedKeyboardGeometry,
  model: KeyboardTouchModel,
): void {
  const expected = geometry.keys.length;
  if (
    model.keyCount !== expected ||
    model.centerX.length !== expected ||
    model.centerY.length !== expected ||
    model.precisionXX.length !== expected ||
    model.precisionXY.length !== expected ||
    model.precisionYY.length !== expected
  ) {
    throw new Error('Keyboard touch model does not match resolved geometry');
  }
  for (let index = 0; index < expected; index += 1) {
    const centerX = model.centerX[index] ?? Number.NaN;
    const centerY = model.centerY[index] ?? Number.NaN;
    const xx = model.precisionXX[index] ?? 0;
    const xy = model.precisionXY[index] ?? 0;
    const yy = model.precisionYY[index] ?? 0;
    if (
      !Number.isFinite(centerX) ||
      !Number.isFinite(centerY) ||
      !Number.isFinite(xx) ||
      !Number.isFinite(xy) ||
      !Number.isFinite(yy) ||
      xx <= 0 ||
      yy <= 0 ||
      xx * yy - xy * xy <= 0
    ) {
      throw new Error(`Keyboard touch model has invalid parameters at key ${index}`);
    }
  }
}

/**
 * Half-extent of a key's anchor, as a fraction of its own width and height.
 *
 * The anchor is the region where the context prior is not consulted at all, so a
 * tap that lands there commits that key however unlikely the surrounding text
 * makes it. This is not a tuning nicety. Gunawardana, Paek and Meek (IUI 2010,
 * Proposition 1) prove that a key's centre is guaranteed to type that key only
 * if the touch model has zero density on other keys' anchors; a Student-t has
 * infinite support and cannot provide that, so the guarantee is enforced here as
 * an explicit short circuit instead.
 *
 * A quarter of the key's extent in each direction is half its width and half its
 * height, a quarter of its area. Measured against the replay corpus, that still
 * lets the prior recover most of the region between two keys' centres while
 * leaving a region around each centre where geometry is final. In a terminal
 * that last property is what matters: a prior that could rewrite a deliberate
 * keystroke is worse than a typo, because the byte reaches the PTY.
 */
const PRIOR_ANCHOR_FRACTION = 0.25;

/**
 * Half-extent of the region where a character key is final at TOUCH-DOWN, as a
 * fraction of its own width and height.
 *
 * Deliberately a separate constant from `PRIOR_ANCHOR_FRACTION` even though both
 * currently hold the same measured value, because they answer different
 * questions and trade against different things. Widening the prior anchor makes
 * the language model safer and weaker. Widening the commit anchor takes the
 * contact duration (p50 84ms) out of more keystrokes' latency and removes
 * slide-to-correct from more of each key. Tuning either for its own reason must
 * not silently move the other.
 */
const COMMIT_ANCHOR_FRACTION = 0.25;

/**
 * Whether a point lies inside a key's anchor: the region where geometry is
 * final. Pure geometry against the key's visual rect, with no reference to the
 * prior, to the touch model's learned centres, or to the release sample — which
 * is what lets the engine also use it as a commit gate at touch-down, where the
 * prior is beside the point and the release sample does not exist yet.
 *
 * `classifyKeyboardTouch` calls this too, so there is exactly one definition of
 * "anchor" and the engine's gate cannot drift from the classifier's guarantee.
 * The engine cannot instead reuse the classifier's own short circuit: that one
 * is nested inside `usePrior` and so does not fire at all when `priorWeight` is
 * zero, when there is no context yet, or when any candidate is a key the
 * language model has no statistics for.
 */
export function keyboardAnchorContains(
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  x: number,
  y: number,
): boolean {
  return anchorContains(rect, x, y, COMMIT_ANCHOR_FRACTION);
}

function anchorContains(
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  x: number,
  y: number,
  fraction: number,
): boolean {
  return (
    Math.abs(x - (rect.x + rect.width * 0.5)) <= rect.width * fraction &&
    Math.abs(y - (rect.y + rect.height * 0.5)) <= rect.height * fraction
  );
}

/**
 * How much the release sample decides a contact, as a function of how far the
 * finger travelled while it was down.
 *
 * Below `tapDrift` the movement is roll-off — the finger pivoting as it leaves
 * the glass — and the contact point still marks the aim, so the profile's own
 * `releaseWeight` applies. Above `slideDrift` the movement is a deliberate slide
 * to another key and only the release point can say which one. Between them the
 * weight ramps smoothly.
 *
 * The ramp is the whole point. The previous form was a boolean: one side of
 * `tapDrift` scored contact plus path, the other threw both away and scored the
 * single release sample. Crossing it cost 4 to 31 percentage points of accuracy
 * depending on how far the finger had travelled, because the estimator changed
 * rather than degraded. A continuous weight has no such edge, and at weight 1 it
 * reproduces the old release-only behaviour exactly, which is why the boolean
 * could simply be deleted instead of widened.
 *
 * Takes the SQUARED drift so the common case — a tap, below the threshold —
 * never pays for a square root.
 */
export function keyboardReleaseWeight(
  driftSquared: number,
  tapDrift: number,
  slideDrift: number,
  baseWeight: number,
): number {
  const tapDriftSquared = tapDrift * tapDrift;
  if (driftSquared <= tapDriftSquared) return baseWeight;
  const slideDriftSquared = slideDrift * slideDrift;
  if (driftSquared >= slideDriftSquared) return 1;
  const span = slideDrift - tapDrift;
  if (span <= 0) return 1;
  const t = (Math.sqrt(driftSquared) - tapDrift) / span;
  // Smoothstep rather than linear: it is flat at both ends, so a contact that
  // sits just past `tapDrift` is barely pulled toward its release point and the
  // transition has no corner at either threshold.
  return baseWeight + (1 - baseWeight) * t * t * (3 - 2 * t);
}

/**
 * Scores exactly four precomputed candidates in continuous CSS coordinates.
 * The three samples summarize contact acquisition, trajectory, and release;
 * no object is created on the pointer hot path.
 *
 * `releaseWeight` is the effective weight for this contact, from
 * `keyboardReleaseWeight` — not the profile's base value. At 0 the contact and
 * its path decide; at 1 the release point alone does.
 *
 * `logPrior` is the causal probability of each key given the text committed so
 * far, or null when no context is available. It is added to the spatial score in
 * log space, which is the standard noisy-channel decomposition
 * `argmax_k p(key | history) * p(touch | key)`.
 *
 * `spatialWinner`, when given, receives in its first slot the key the touch
 * alone scores highest, before the prior is added, or -1 with no candidate. It
 * rides the same pass: one extra comparison per candidate.
 */
export function classifyKeyboardTouch(
  geometry: ResolvedKeyboardGeometry,
  prior: KeyboardTouchModel,
  downX: number,
  downY: number,
  trajectoryX: number,
  trajectoryY: number,
  releaseX: number,
  releaseY: number,
  releaseWeight: number,
  logPrior: Float64Array | null,
  priorWeight: number,
  spatialWinner?: Int16Array,
): number | null {
  const lookupX = releaseX * releaseWeight + trajectoryX * (1 - releaseWeight);
  const lookupY = releaseY * releaseWeight + trajectoryY * (1 - releaseWeight);
  const atlasOffset = keyboardHitAtlasOffset(geometry, lookupX, lookupY);
  if (atlasOffset < 0) return settle(NO_KEY, NO_KEY, spatialWinner);

  const candidateOffset = atlasOffset * KEYBOARD_CANDIDATE_COUNT;
  // Contact and path share one weight; that equality is what lets their two
  // logarithms be folded into one below.
  const acquisitionWeight = (1 - releaseWeight) * 0.5;
  const finalWeight = releaseWeight;
  // A key with no language statistics — Backspace, Shift, Enter, a layer
  // switch — carries NaN. There is no honest probability to give it: inventing a
  // high one lets the prior turn a letter into a Backspace, and inventing a low
  // one lets it turn a Backspace into a letter, and the first of those is
  // destructive in a shell. So the prior arbitrates only when every candidate is
  // a key it has data for, and otherwise steps aside for this tap. At most four
  // reads, no allocation.
  let usePrior = logPrior !== null && priorWeight > 0;
  // Deliberately unconditional. It used to apply only when a context prior was
  // active, which left the guarantee absent exactly when the spatial model had
  // been personalised but the prior had no statistics — and it is the learned
  // offsets, not the prior, that can move a key's model centre away from the
  // key the user is looking at. Making it hold always is what allows those
  // offsets to be bounded by the geometry rather than by a fear of them.
  // Check visual anchors before doing any scoring or reading their prior.
  // The same four-candidate pass also establishes whether the prior is safe.
  for (let position = 0; position < KEYBOARD_CANDIDATE_COUNT; position += 1) {
    const keyIndex = geometry.candidateAtlas[candidateOffset + position] ?? NO_KEY;
    if (keyIndex === NO_KEY) continue;
    const key = geometry.keys[keyIndex];
    if (key !== undefined && anchorContains(key.rect, lookupX, lookupY, PRIOR_ANCHOR_FRACTION)) {
      return settle(keyIndex, keyIndex, spatialWinner);
    }
    if (usePrior && logPrior !== null && Number.isNaN(logPrior[keyIndex] ?? Number.NaN)) {
      usePrior = false;
    }
  }
  let winner = NO_KEY;
  let winnerScore = Number.NEGATIVE_INFINITY;
  let spatial = NO_KEY;
  let spatialScore = Number.NEGATIVE_INFINITY;

  for (let position = 0; position < KEYBOARD_CANDIDATE_COUNT; position += 1) {
    const keyIndex = geometry.candidateAtlas[candidateOffset + position] ?? NO_KEY;
    if (keyIndex === NO_KEY) continue;
    const key = geometry.keys[keyIndex];
    if (key === undefined) continue;
    // All three sample terms use the same key parameters. Load them once.
    const centerX = prior.centerX[keyIndex] ?? 0;
    const centerY = prior.centerY[keyIndex] ?? 0;
    const xx = prior.precisionXX[keyIndex] ?? 0;
    const xy = prior.precisionXY[keyIndex] ?? 0;
    const yy = prior.precisionYY[keyIndex] ?? 0;
    // The contact and path terms always carry the same weight, so their two logs
    // are one:
    //
    //   a*log1p(m_d/df) + a*log1p(m_t/df) == a*log((1 + m_d/df) * (1 + m_t/df))
    //
    // Exact algebra, not an approximation, and it removes a transcendental per
    // candidate — from three to two while the release ramp is mid-range, and
    // from two to one for an ordinary tap, which is the common case.
    let score = 0;
    if (acquisitionWeight > 0) {
      const contact =
        1 +
        mahalanobis(downX - centerX, downY - centerY, xx, xy, yy) / STUDENT_T_DEGREES_OF_FREEDOM;
      const path =
        1 +
        mahalanobis(trajectoryX - centerX, trajectoryY - centerY, xx, xy, yy) /
          STUDENT_T_DEGREES_OF_FREEDOM;
      score += STUDENT_T_EXPONENT * acquisitionWeight * Math.log(contact * path);
    }
    if (finalWeight > 0) {
      score +=
        STUDENT_T_EXPONENT *
        finalWeight *
        Math.log1p(
          mahalanobis(releaseX - centerX, releaseY - centerY, xx, xy, yy) /
            STUDENT_T_DEGREES_OF_FREEDOM,
        );
    }
    if (score > spatialScore) {
      spatial = keyIndex;
      spatialScore = score;
    }
    if (usePrior && logPrior !== null) score += priorWeight * (logPrior[keyIndex] ?? 0);
    if (score > winnerScore || (score === winnerScore && keyIndex < winner)) {
      winner = keyIndex;
      winnerScore = score;
    }
  }
  return settle(winner, spatial, spatialWinner);
}

/**
 * Hands the touch-only winner to the caller's out-slot, when it asked for one,
 * and returns the decision.
 */
function settle(
  winner: number,
  spatial: number,
  spatialWinner: Int16Array | undefined,
): number | null {
  if (spatialWinner !== undefined) spatialWinner[0] = spatial === NO_KEY ? -1 : spatial;
  return winner === NO_KEY ? null : winner;
}

/**
 * Squared Mahalanobis distance from a key's modelled centre. The Student-t score
 * is `STUDENT_T_EXPONENT * log1p(this / df)`; returning the distance rather than
 * the score is what lets the caller fold two equally-weighted terms into a
 * single logarithm.
 */
function mahalanobis(dx: number, dy: number, xx: number, xy: number, yy: number): number {
  return Math.max(0, dx * dx * xx + 2 * dx * dy * xy + dy * dy * yy);
}
