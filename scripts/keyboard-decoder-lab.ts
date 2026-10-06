/**
 * Decoder lab: compares swappable touch-to-key decoders on identical input.
 *
 * This is a different axis from `keyboard-accuracy-simulator.ts`. That simulator
 * asks "does the engine beat a hard atlas lookup on synthetic gesture families";
 * it holds the decoder fixed and varies the gesture. This lab holds the touch
 * distribution fixed and varies the decoder, so two candidate recognition
 * strategies can be compared on exactly the same taps.
 *
 * Two evaluators, deliberately:
 *
 *   - `integrateAccuracy` is exact. A decoder is a deterministic labelling of the
 *     plane, so P(correct) is the integral of the touch density over the region
 *     the decoder labels with the intended key. Evaluating on a grid has no
 *     sampling noise at all, which matters because the differences between good
 *     decoders are a couple of percentage points and Monte Carlo at any feasible
 *     sample count cannot resolve them.
 *   - `evaluateSequence` replays a character sequence. It is the only evaluator
 *     that can score a context-dependent prior, because a prior needs the
 *     preceding characters, and it is the only one that produces a character
 *     error rate over realistic text rather than per-key identity.
 *
 * On circularity: the generative model in `TOUCH_MODELS` is deliberately NOT the
 * decoder's own prior. The decoder scores a Student-t centred on each key's
 * visual centre with sigma tied to key size; the generator draws from a Gaussian
 * with a systematic offset, anisotropic sigma taken from published measurements,
 * and a co-articulation term that depends on the NEXT key. A decoder cannot win
 * here by agreeing with itself.
 */
import { createKeyboardEngine } from '../packages/keyboard/src/engine';
import {
  CUPERTINO_LANDSCAPE_PROFILE,
  CUPERTINO_PORTRAIT_PROFILE,
  KEYBOARD_CANDIDATE_COUNT,
  solveKeyboardGeometry,
} from '../packages/keyboard/src/geometry';
import { TERMINAL_US_LAYOUT } from '../packages/keyboard/src/layouts/terminal-us';
import {
  classifyKeyboardTouch,
  createKeyboardSpatialPrior,
  keyboardAnchorContains,
  keyboardReleaseWeight,
} from '../packages/keyboard/src/touch-model';
import type {
  KeyboardGeometryProfile,
  KeyboardTouchModel,
  KeyboardTouchTrace,
  ResolvedKeyboardGeometry,
  ResolvedKeyboardKey,
} from '../packages/keyboard/src/types';

/**
 * A 402pt-wide portrait layout spans the SCREEN, not the phone. An iPhone 16 Pro
 * is 1206 physical pixels wide at 460 ppi, so the screen is 66.59mm across and
 * one CSS pixel is 0.166mm. The device's 71.5mm body width is the wrong number
 * and was used here initially, which understated every millimetre-denominated
 * quantity by 7.5% — including the `tapDrift` threshold, which is 1.99mm rather
 * than the 2.14mm first reported.
 */
const SCREEN_WIDTH_MM = (1206 / 460) * 25.4;
export const PX_PER_MM = 402 / SCREEN_WIDTH_MM;

/** Larger than any layer's key count, so a packed pair never collides. */
const CONFUSION_STRIDE = 1024;

export function mm(millimetres: number): number {
  return millimetres * PX_PER_MM;
}

// ---------------------------------------------------------------------------
// Touch generation
// ---------------------------------------------------------------------------

/**
 * The generative model of a tap. Parameters are in millimetres so they can be
 * set directly from published measurements; `source` records where each set came
 * from so a reader can audit whether a result rests on data or on a guess.
 */
export interface TouchModelParameters {
  readonly id: string;
  readonly source: string;
  /** Systematic aim error, positive y = the contact lands below the intended point. */
  readonly offsetXmm: number;
  readonly offsetYmm: number;
  readonly sigmaXmm: number;
  readonly sigmaYmm: number;
  /** Correlation between the x and y error, from the thumb's arc of travel. */
  readonly correlation: number;
  /**
   * How far the contact point is dragged toward the next key because the finger
   * is already travelling when it lands, as a fraction of the distance to that
   * key. Zero for isolated taps.
   */
  readonly coarticulation: number;
  /** In-contact travel from touch-down to release, toward the next key, in mm. */
  readonly inContactDriftMm: number;
}

/**
 * Parameter sets used by the synthetic generator. Every value below is measured
 * on the HOW-WE-TYPE-MOBILE corpus (two-thumb block, intent-labelled so that
 * mis-aimed taps are included) unless its `source` says otherwise. Sigmas are
 * given in millimetres here because the published literature is, and converted
 * on use; the corpus figures were measured in key pitches and converted with
 * Merkur's own geometry.
 *
 * Prefer `replayThroughEngine` over this generator when the question is about
 * the decoder. These models exist for the exact-integration evaluator, which
 * needs a closed-form density rather than a sample.
 */
export const TOUCH_MODELS: readonly TouchModelParameters[] = [
  {
    id: 'isolated-precise',
    source: 'definitional lower bound: a careful, isolated, well-aimed tap',
    offsetXmm: 0,
    offsetYmm: 0,
    sigmaXmm: 0.8,
    sigmaYmm: 0.8,
    correlation: 0,
    coarticulation: 0,
    inContactDriftMm: 0,
  },
  {
    id: 'two-thumb-correct-taps',
    source:
      'HOW-WE-TYPE-MOBILE, two thumbs, correct taps only: sigma 0.201 key pitches x 0.150 row pitches',
    offsetXmm: 0,
    offsetYmm: 0,
    // 0.201 * 6.66mm pitch, 0.150 * 8.94mm row pitch.
    sigmaXmm: 1.34,
    sigmaYmm: 1.34,
    // Measured at +0.018 to +0.033 key pitches, an order of magnitude below the
    // scatter and not monotone in typing speed.
    correlation: 0,
    coarticulation: 0.02,
    inContactDriftMm: 0,
  },
  {
    id: 'two-thumb-all-taps',
    source:
      'HOW-WE-TYPE-MOBILE two thumbs incl. mis-aimed taps (sigma 0.462 x 0.178 pitches) — a GAUSSIAN FIT to a heavy tail, so pessimistic; see note',
    offsetXmm: 0,
    offsetYmm: 0,
    // The honest population, but read the accuracy it produces with care. The
    // real distribution is a tight core plus a heavy tail; a single Gaussian
    // cannot be both, so fitting one inflates the core and this model scores far
    // below what the same taps score when replayed empirically (72.8% here
    // against 95.1% measured). It is retained because the exact-integration
    // evaluator needs a closed-form density, and because the gap between the two
    // is itself the argument for preferring the empirical replay.
    sigmaXmm: 3.08,
    sigmaYmm: 1.59,
    correlation: -0.02,
    coarticulation: 0.02,
    inContactDriftMm: 0,
  },
] as const;

export interface RandomSource {
  next(): number;
  gaussian(): number;
}

export function createRandomSource(seed: number): RandomSource {
  let state = seed >>> 0 || 0x4d45_5243;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
  return {
    next,
    gaussian(): number {
      const u = Math.max(1e-12, next());
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
  };
}

/** One synthetic contact, in the same three-point form the engine consumes. */
export interface SyntheticTouch {
  readonly downX: number;
  readonly downY: number;
  readonly trajectoryX: number;
  readonly trajectoryY: number;
  readonly releaseX: number;
  readonly releaseY: number;
}

export function generateTouch(
  parameters: TouchModelParameters,
  intended: ResolvedKeyboardKey,
  next: ResolvedKeyboardKey | undefined,
  random: RandomSource,
): SyntheticTouch {
  const centreX = intended.rect.x + intended.rect.width / 2;
  const centreY = intended.rect.y + intended.rect.height / 2;

  // Correlated bivariate normal via the Cholesky factor of a 2x2 covariance.
  const z1 = random.gaussian();
  const z2 = random.gaussian();
  const rho = Math.max(-0.95, Math.min(0.95, parameters.correlation));
  const noiseX = mm(parameters.sigmaXmm) * z1;
  const noiseY = mm(parameters.sigmaYmm) * (rho * z1 + Math.sqrt(1 - rho * rho) * z2);

  let downX = centreX + mm(parameters.offsetXmm) + noiseX;
  let downY = centreY + mm(parameters.offsetYmm) + noiseY;

  // Co-articulation: the contact is pulled toward wherever the finger is going.
  let toNextX = 0;
  let toNextY = 0;
  if (next !== undefined) {
    const nextX = next.rect.x + next.rect.width / 2;
    const nextY = next.rect.y + next.rect.height / 2;
    const dx = nextX - centreX;
    const dy = nextY - centreY;
    const distance = Math.hypot(dx, dy);
    if (distance > 1e-6) {
      downX += dx * parameters.coarticulation;
      downY += dy * parameters.coarticulation;
      toNextX = dx / distance;
      toNextY = dy / distance;
    }
  }

  // In-contact drift: the finger departs toward the next key before it lifts.
  const drift = mm(parameters.inContactDriftMm);
  const releaseX = downX + toNextX * drift;
  const releaseY = downY + toNextY * drift;

  // The engine's trajectory centroid is dominated by the late samples, so a
  // linear contact path puts it near the three-quarter point. Modelling it
  // there rather than at the midpoint keeps the synthetic trace faithful to
  // what `computeTrajectoryCentroid` actually produces.
  return {
    downX,
    downY,
    trajectoryX: downX + (releaseX - downX) * 0.75,
    trajectoryY: downY + (releaseY - downY) * 0.75,
    releaseX,
    releaseY,
  };
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

export interface DecoderContext {
  readonly geometry: ResolvedKeyboardGeometry;
  readonly profile: KeyboardGeometryProfile;
  readonly prior: KeyboardTouchModel;
  /** Per-key log-prior for the current context, or undefined for a flat prior. */
  readonly logPrior?: Float64Array;
}

export interface Decoder {
  readonly id: string;
  readonly description: string;
  decide(context: DecoderContext, touch: SyntheticTouch): number | null;
}

/** Exactly what `engine.endPointerAt` does: the continuous release ramp. */
export const SHIPPED_DECODER: Decoder = {
  id: 'shipped',
  description: 'release weight ramps from the profile value to 1 between tapDrift and slideDrift',
  decide(context, touch) {
    const dx = touch.releaseX - touch.downX;
    const dy = touch.releaseY - touch.downY;
    return classifyKeyboardTouch(
      context.geometry,
      context.prior,
      touch.downX,
      touch.downY,
      touch.trajectoryX,
      touch.trajectoryY,
      touch.releaseX,
      touch.releaseY,
      keyboardReleaseWeight(
        dx * dx + dy * dy,
        context.profile.tapDrift,
        context.profile.slideDrift,
        context.profile.releaseWeight,
      ),
      null,
      0,
    );
  },
};

/** The same estimator with the discontinuity removed. */
export const NO_CLIFF_DECODER: Decoder = {
  id: 'no-cliff',
  description: 'blended contact+path always; tapDrift no longer switches estimators',
  decide(context, touch) {
    return classifyKeyboardTouch(
      context.geometry,
      context.prior,
      touch.downX,
      touch.downY,
      touch.trajectoryX,
      touch.trajectoryY,
      touch.releaseX,
      touch.releaseY,
      context.profile.releaseWeight,
      null,
      0,
    );
  },
};

/** The contact point alone: the sample least corrupted by departure motion. */
export const CONTACT_ONLY_DECODER: Decoder = {
  id: 'contact-only',
  description: 'decide from the touch-down point alone',
  decide(context, touch) {
    return classifyKeyboardTouch(
      context.geometry,
      context.prior,
      touch.downX,
      touch.downY,
      touch.downX,
      touch.downY,
      touch.downX,
      touch.downY,
      0,
      null,
      0,
    );
  },
};

/** The release point alone: what the shipped decoder falls back to above tapDrift. */
export const RELEASE_ONLY_DECODER: Decoder = {
  id: 'release-only',
  description: 'decide from the release point alone (the shipped above-cliff behaviour)',
  decide(context, touch) {
    return classifyKeyboardTouch(
      context.geometry,
      context.prior,
      touch.releaseX,
      touch.releaseY,
      touch.releaseX,
      touch.releaseY,
      touch.releaseX,
      touch.releaseY,
      1,
      null,
      0,
    );
  },
};

const STUDENT_T_DEGREES_OF_FREEDOM = 4;
const STUDENT_T_EXPONENT = -3;

/** The same Student-t score the engine uses, exposed so priors can be added to it. */
function scorePoint(prior: KeyboardTouchModel, keyIndex: number, x: number, y: number): number {
  const dx = x - (prior.centerX[keyIndex] ?? 0);
  const dy = y - (prior.centerY[keyIndex] ?? 0);
  const xx = prior.precisionXX[keyIndex] ?? 0;
  const xy = prior.precisionXY[keyIndex] ?? 0;
  const yy = prior.precisionYY[keyIndex] ?? 0;
  const squared = Math.max(0, dx * dx * xx + 2 * dx * dy * xy + dy * dy * yy);
  return STUDENT_T_EXPONENT * Math.log1p(squared / STUDENT_T_DEGREES_OF_FREEDOM);
}

/**
 * Contact-point geometry plus the causal key prior, evaluated through the SAME
 * `classifyKeyboardTouch` the engine calls. Measuring a reimplementation would
 * only tell us about the reimplementation; the anchoring guarantee and the
 * step-aside rule for keys with no statistics both live in that function, and
 * both change the answer.
 */
export function createPriorDecoder(priorWeight: number): Decoder {
  return {
    id: `prior-w${priorWeight}`,
    description: `contact point + causal key log-prior (weight ${priorWeight}), anchored`,
    decide(context, touch) {
      return classifyKeyboardTouch(
        context.geometry,
        context.prior,
        touch.downX,
        touch.downY,
        touch.downX,
        touch.downY,
        touch.downX,
        touch.downY,
        0,
        context.logPrior ?? null,
        priorWeight,
      );
    },
  };
}

/**
 * What the engine now does: classify from the contact point, and if that key's
 * anchor contains the contact, the key is final and the release sample is never
 * consulted. Otherwise the shipped release-time decision runs unchanged.
 *
 * Both halves call production code — `keyboardAnchorContains` and
 * `classifyKeyboardTouch` — so this measures the engine rather than restating
 * it. That matters here more than usual: the anchoring guarantee and the
 * step-aside rule for keys with no language statistics both live inside
 * `classifyKeyboardTouch`, and both change the answer.
 *
 * What it cannot show is the point of the change. The whole value is that an
 * anchored tap commits at touch-down instead of ~84ms later, and this lab has no
 * notion of time at all. It is here to prove the accuracy cost, which should be
 * nil at zero drift and favourable above it.
 */
export function createAnchorCommitDecoder(priorWeight: number): Decoder {
  return {
    id: `anchor-commit-w${priorWeight}`,
    description: `commit at contact inside the anchor, else the shipped release decision (prior weight ${priorWeight})`,
    decide(context, touch) {
      const contactKey = classifyKeyboardTouch(
        context.geometry,
        context.prior,
        touch.downX,
        touch.downY,
        touch.downX,
        touch.downY,
        touch.downX,
        touch.downY,
        0,
        context.logPrior ?? null,
        priorWeight,
      );
      if (contactKey !== null) {
        // The WINNER's anchor, not a search for any anchor containing the point.
        // With learned per-key offsets a point can sit inside key K's visual
        // anchor while scoring highest for neighbour J; testing J correctly
        // falls through to the release-decided path instead of committing J.
        const key = context.geometry.keys[contactKey];
        if (key !== undefined && keyboardAnchorContains(key.rect, touch.downX, touch.downY)) {
          return contactKey;
        }
      }
      return SHIPPED_DECODER.decide(context, touch);
    },
  };
}

/**
 * Share of real taps the anchor-commit path actually claims — the coverage
 * number for the whole change, since only these taps stop paying the contact
 * duration. Independent of drift by construction: it reads the contact point,
 * which is the one thing the corpus actually measured.
 */
export function anchorCommitShare(
  context: DecoderContext,
  residuals: readonly ReplayResidual[],
  keyForCharacter: (character: string) => ResolvedKeyboardKey | undefined,
): { readonly share: number; readonly anchored: number; readonly taps: number } {
  const { geometry } = context;
  const keyPitch = geometry.width / 10;
  const rowPitch = keyboardRowPitch(geometry);
  let anchored = 0;
  let taps = 0;
  for (const residual of residuals) {
    const intended = keyForCharacter(residual.intended);
    if (intended === undefined) continue;
    taps += 1;
    const downX = intended.rect.x + intended.rect.width / 2 + residual.dx * keyPitch;
    const downY = intended.rect.y + intended.rect.height / 2 + residual.dy * rowPitch;
    const contactKey = CONTACT_ONLY_DECODER.decide(context, {
      downX,
      downY,
      trajectoryX: downX,
      trajectoryY: downY,
      releaseX: downX,
      releaseY: downY,
    });
    if (contactKey === null) continue;
    const key = geometry.keys[contactKey];
    if (key !== undefined && keyboardAnchorContains(key.rect, downX, downY)) anchored += 1;
  }
  return { share: taps === 0 ? 0 : anchored / taps, anchored, taps };
}

/**
 * Upper bound: is the intended key among the top `k` geometric candidates? No
 * real prior can beat this, because a prior only re-ranks the candidates that
 * geometry already offered. Scored directly by the runner rather than dressed up
 * as a `Decoder`, because it needs the answer as an input and so is not a
 * decoder at all.
 */
export function oracleContains(
  geometry: ResolvedKeyboardGeometry,
  k: number,
  x: number,
  y: number,
  intended: number,
): boolean {
  const atlasX = Math.floor(x);
  const atlasY = Math.floor(y);
  if (x < 0 || y < 0 || atlasX >= geometry.atlasWidth || atlasY >= geometry.atlasHeight) {
    return false;
  }
  const base = (atlasY * geometry.atlasWidth + atlasX) * KEYBOARD_CANDIDATE_COUNT;
  for (let position = 0; position < Math.min(k, KEYBOARD_CANDIDATE_COUNT); position += 1) {
    if (geometry.candidateAtlas[base + position] === intended) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Exact evaluator
// ---------------------------------------------------------------------------

export interface IntegrationResult {
  readonly accuracy: number;
  readonly byKey: ReadonlyMap<string, number>;
}

/**
 * Exact per-key accuracy by integrating the touch density over the decoder's
 * decision regions on a grid. Only valid for decoders that depend on the contact
 * point alone, which is what makes them a deterministic labelling of the plane;
 * anything using the release point separately must go through `evaluateSequence`.
 *
 * `weights` is how often each key is actually typed. It matters more than it
 * looks: an unweighted average asks "how accurate is the average key", which no
 * user ever types, and it systematically flatters a decoder that sacrifices
 * common keys for rare ones. Pass corpus frequencies to get the accuracy a
 * typist would experience.
 */
export function integrateAccuracy(
  context: DecoderContext,
  decoder: Decoder,
  parameters: TouchModelParameters,
  keys: readonly ResolvedKeyboardKey[],
  step = 0.5,
  weights?: ReadonlyMap<string, number>,
): IntegrationResult {
  const { geometry } = context;
  const cols = Math.ceil(geometry.width / step);
  const rows = Math.ceil(geometry.hitHeight / step);
  const label = new Int16Array(cols * rows);
  for (let iy = 0; iy < rows; iy += 1) {
    const y = (iy + 0.5) * step;
    for (let ix = 0; ix < cols; ix += 1) {
      const x = (ix + 0.5) * step;
      label[iy * cols + ix] =
        decoder.decide(context, {
          downX: x,
          downY: y,
          trajectoryX: x,
          trajectoryY: y,
          releaseX: x,
          releaseY: y,
        }) ?? -1;
    }
  }

  const sigmaX = mm(parameters.sigmaXmm);
  const sigmaY = mm(parameters.sigmaYmm);
  const byKey = new Map<string, number>();
  let weightedTotal = 0;
  let weightSum = 0;
  for (const key of keys) {
    const muX = key.rect.x + key.rect.width / 2 + mm(parameters.offsetXmm);
    const muY = key.rect.y + key.rect.height / 2 + mm(parameters.offsetYmm);
    const x0 = Math.max(0, Math.floor((muX - 4 * sigmaX) / step));
    const x1 = Math.min(cols - 1, Math.ceil((muX + 4 * sigmaX) / step));
    const y0 = Math.max(0, Math.floor((muY - 4 * sigmaY) / step));
    const y1 = Math.min(rows - 1, Math.ceil((muY + 4 * sigmaY) / step));
    let hit = 0;
    let mass = 0;
    for (let iy = y0; iy <= y1; iy += 1) {
      const y = (iy + 0.5) * step;
      const zy = (y - muY) / sigmaY;
      const py = Math.exp(-0.5 * zy * zy);
      for (let ix = x0; ix <= x1; ix += 1) {
        const x = (ix + 0.5) * step;
        const zx = (x - muX) / sigmaX;
        const weight = py * Math.exp(-0.5 * zx * zx);
        mass += weight;
        if (label[iy * cols + ix] === key.index) hit += weight;
      }
    }
    const accuracy = mass === 0 ? 0 : hit / mass;
    byKey.set(key.definition.id, accuracy);
    const weight = weights?.get(key.definition.id) ?? 1;
    weightedTotal += accuracy * weight;
    weightSum += weight;
  }
  return { accuracy: weightSum === 0 ? 0 : weightedTotal / weightSum, byKey };
}

// ---------------------------------------------------------------------------
// Sequence evaluator
// ---------------------------------------------------------------------------

export interface SequenceResult {
  readonly decoderId: string;
  readonly taps: number;
  readonly correct: number;
  readonly accuracy: number;
  /** Expected wrong characters in a 40-character command line. */
  readonly errorsPer40: number;
  readonly confusions: ReadonlyArray<{ intended: string; predicted: string; count: number }>;
}

export interface SequenceOptions {
  readonly context: DecoderContext;
  readonly parameters: TouchModelParameters;
  readonly text: string;
  readonly seed: number;
  /** Supplies the causal log-prior given the characters committed so far. */
  readonly priorFor?: (history: string) => Float64Array | undefined;
}

/**
 * Replays one character sequence through every decoder on IDENTICAL taps. The
 * random stream is re-seeded per decoder so decoder N sees exactly the taps
 * decoder 0 saw; comparisons are therefore paired, and a difference of a few
 * tenths of a percentage point is real rather than sampling noise.
 *
 * The prior is fed the INTENDED history rather than each decoder's own output.
 * That isolates the value of the prior from the compounding of its own errors;
 * a second pass feeding the realised history measures the compounding
 * separately.
 */
export function evaluateSequence(
  decoders: readonly Decoder[],
  options: SequenceOptions,
  keyForCharacter: (character: string) => ResolvedKeyboardKey | undefined,
): SequenceResult[] {
  const results: SequenceResult[] = [];
  for (const decoder of decoders) {
    const random = createRandomSource(options.seed);
    const confusions = new Map<number, number>();
    let taps = 0;
    let correct = 0;
    let history = '';

    for (let index = 0; index < options.text.length; index += 1) {
      const character = options.text[index] ?? '';
      const intended = keyForCharacter(character);
      if (intended === undefined) {
        history += character;
        continue;
      }
      const nextCharacter = options.text[index + 1];
      const next = nextCharacter === undefined ? undefined : keyForCharacter(nextCharacter);
      const touch = generateTouch(options.parameters, intended, next, random);

      const logPrior = options.priorFor?.(history);
      const context: DecoderContext = { ...options.context, ...(logPrior ? { logPrior } : {}) };
      const decided = decoder.decide(context, touch);

      taps += 1;
      if (decided === intended.index) correct += 1;
      else countConfusion(confusions, intended.index, decided);
      history += character;
    }

    const accuracy = taps === 0 ? 0 : correct / taps;
    results.push({
      decoderId: decoder.id,
      taps,
      correct,
      accuracy,
      errorsPer40: (1 - accuracy) * 40,
      confusions: describeConfusions(confusions, options.context.geometry),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

export function createLabContext(
  orientation: 'portrait' | 'landscape' = 'portrait',
  width = 402,
  devicePixelRatio = 3,
  layerId = 'alpha',
): DecoderContext {
  const profile =
    orientation === 'portrait' ? CUPERTINO_PORTRAIT_PROFILE : CUPERTINO_LANDSCAPE_PROFILE;
  const geometry = solveKeyboardGeometry(
    TERMINAL_US_LAYOUT,
    layerId,
    width,
    devicePixelRatio,
    profile,
  );
  return { geometry, profile, prior: createKeyboardSpatialPrior(geometry) };
}

export function createCharacterResolver(
  geometry: ResolvedKeyboardGeometry,
): (character: string) => ResolvedKeyboardKey | undefined {
  const byValue = new Map<string, ResolvedKeyboardKey>();
  for (const key of geometry.keys) {
    const value = key.definition.value;
    if (value !== undefined && value.length === 1 && !byValue.has(value)) byValue.set(value, key);
    if (key.definition.id === 'space') byValue.set(' ', key);
  }
  return (character) => byValue.get(character);
}

/**
 * A prior whose spread is decoupled from each key's own rectangle.
 *
 * The shipped prior sets sigma = 0.48 * that key's width and height
 * (touch-model.ts), which has two consequences the measured data contradicts.
 * It makes sigma_y > sigma_x, because keys are taller than they are wide,
 * whereas real thumb typing scatters considerably WIDER than it is tall
 * (measured on the replay corpus including mis-aimed taps: sigma_x 0.462 key
 * pitches against sigma_y 0.178 row pitches). And it gives physically larger
 * keys a smaller Mahalanobis distance at equal displacement, so Space and
 * Backspace annex territory from their narrow neighbours.
 *
 * Here sigma is a fixed fraction of the layout's key pitch and row pitch, so
 * every key shares one shape and the anisotropy can be set from measurement.
 */
export function createTunedPrior(
  geometry: ResolvedKeyboardGeometry,
  sigmaX: number,
  sigmaY: number,
  scaleBy: 'rect' | 'pitch',
): KeyboardTouchModel {
  const keyCount = geometry.keys.length;
  const centerX = new Float64Array(keyCount);
  const centerY = new Float64Array(keyCount);
  const precisionXX = new Float32Array(keyCount);
  const precisionXY = new Float32Array(keyCount);
  const precisionYY = new Float32Array(keyCount);
  const pitchX = geometry.width / 10;
  const pitchY = keyboardRowPitch(geometry);
  for (const key of geometry.keys) {
    centerX[key.index] = key.rect.x + key.rect.width * 0.5;
    centerY[key.index] = key.rect.y + key.rect.height * 0.5;
    // Scaling by the key's own rect is not a mistake to be corrected away: a key
    // five columns wide genuinely absorbs taps across its whole width, and
    // giving Space a letter-sized sigma makes it lose its own middle to its
    // neighbours. Only the multipliers are open to tuning.
    const width = scaleBy === 'rect' ? key.rect.width : pitchX;
    const height = scaleBy === 'rect' ? key.rect.height : pitchY;
    const sx = Math.max(1, sigmaX * width);
    const sy = Math.max(1, sigmaY * height);
    precisionXX[key.index] = 1 / (sx * sx);
    precisionYY[key.index] = 1 / (sy * sy);
  }
  return { keyCount, centerX, centerY, precisionXX, precisionXY, precisionYY };
}

/**
 * Contact-point decoder using a tuned isotropy-corrected prior, optionally with
 * a causal log-prior and the anchoring guarantee. Anchoring matters more here
 * than it looks: Gunawardana, Paek and Meek (IUI 2010, Proposition 1) prove that
 * a key's own centre is guaranteed to type that key only if the touch model has
 * ZERO density on other keys' anchors. A Student-t has infinite support and so
 * cannot anchor on its own, which is why the anchor is enforced as an explicit
 * early return rather than left to the score.
 */
export function createTunedDecoder(options: {
  readonly id: string;
  readonly sigmaX: number;
  readonly sigmaY: number;
  readonly scaleBy: 'rect' | 'pitch';
  readonly priorWeight: number;
}): Decoder {
  let cached: { geometry: ResolvedKeyboardGeometry; model: KeyboardTouchModel } | null = null;
  return {
    id: options.id,
    description: `contact point, sigma=(${options.sigmaX}, ${options.sigmaY}) x key ${options.scaleBy}, prior weight ${options.priorWeight}`,
    decide(context, touch) {
      const { geometry, logPrior } = context;
      if (cached === null || cached.geometry !== geometry) {
        cached = {
          geometry,
          model: createTunedPrior(geometry, options.sigmaX, options.sigmaY, options.scaleBy),
        };
      }
      const model = cached.model;
      const atlasX = Math.floor(touch.downX);
      const atlasY = Math.floor(touch.downY);
      if (
        touch.downX < 0 ||
        touch.downY < 0 ||
        atlasX >= geometry.atlasWidth ||
        atlasY >= geometry.atlasHeight
      ) {
        return null;
      }
      const base = (atlasY * geometry.atlasWidth + atlasX) * KEYBOARD_CANDIDATE_COUNT;
      let winner = -1;
      let winnerScore = Number.NEGATIVE_INFINITY;
      for (let position = 0; position < KEYBOARD_CANDIDATE_COUNT; position += 1) {
        const keyIndex = geometry.candidateAtlas[base + position] ?? 255;
        if (keyIndex === 255) continue;
        const key = geometry.keys[keyIndex];
        if (key === undefined) continue;
        if (options.priorWeight > 0) {
          const cx = key.rect.x + key.rect.width / 2;
          const cy = key.rect.y + key.rect.height / 2;
          if (
            Math.abs(touch.downX - cx) <= key.rect.width * 0.25 &&
            Math.abs(touch.downY - cy) <= key.rect.height * 0.25
          ) {
            return keyIndex;
          }
        }
        const score =
          scorePoint(model, keyIndex, touch.downX, touch.downY) +
          options.priorWeight * (logPrior?.[keyIndex] ?? 0);
        if (score > winnerScore || (score === winnerScore && keyIndex < winner)) {
          winner = keyIndex;
          winnerScore = score;
        }
      }
      return winner === -1 ? null : winner;
    },
  };
}

export function keyboardRowPitch(geometry: ResolvedKeyboardGeometry): number {
  const first = geometry.rows[0]?.[0];
  const second = geometry.rows[1]?.[0];
  const top = first === undefined ? undefined : geometry.keys[first];
  const below = second === undefined ? undefined : geometry.keys[second];
  if (top === undefined || below === undefined) return CUPERTINO_PORTRAIT_PROFILE.keyHeight;
  return below.rect.y - top.rect.y;
}

// ---------------------------------------------------------------------------
// Replay of real human taps
// ---------------------------------------------------------------------------

export interface ReplayResidual {
  readonly intended: string;
  readonly dx: number;
  readonly dy: number;
  readonly interTapMs: number | null;
  readonly sentence: number;
}

export interface ReplayOptions {
  readonly context: DecoderContext;
  readonly residuals: readonly ReplayResidual[];
  /**
   * In-contact travel toward the next key, in millimetres. The residual corpus
   * records one point per keystroke and so cannot supply this; it is the one
   * parameter that still has to be measured on a real device. Sweeping it is how
   * the tapDrift cliff gets exercised.
   */
  readonly inContactDriftMm: number;
  readonly priorFor?: (history: string) => Float64Array | undefined;
}

export interface ReplayResult {
  readonly decoderId: string;
  readonly taps: number;
  readonly accuracy: number;
  readonly errorsPer40: number;
  readonly confusions: ReadonlyArray<{ intended: string; predicted: string; count: number }>;
}

/**
 * Replays measured human aim errors on Merkur's geometry. Every decoder sees
 * byte-identical taps, so a difference between two rows is the decoder and
 * nothing else. Because the scatter is empirical rather than drawn from a
 * distribution, no decoder can score well here by assuming the same distribution
 * the generator used — which is the failure mode of every synthetic keyboard
 * benchmark, including this repository's own gesture-family simulator.
 */
export function replayResiduals(
  decoders: readonly Decoder[],
  options: ReplayOptions,
  keyForCharacter: (character: string) => ResolvedKeyboardKey | undefined,
): ReplayResult[] {
  const { geometry } = options.context;
  const keyPitch = geometry.width / 10;
  const rowPitch = keyboardRowPitch(geometry);
  const results: ReplayResult[] = [];

  for (const decoder of decoders) {
    const confusions = new Map<number, number>();
    let taps = 0;
    let correct = 0;
    let history = '';

    for (let index = 0; index < options.residuals.length; index += 1) {
      const residual = options.residuals[index];
      if (residual === undefined) continue;
      if (residual.interTapMs === null) history = '';
      const intended = keyForCharacter(residual.intended);
      if (intended === undefined) {
        history += residual.intended;
        continue;
      }

      const downX = intended.rect.x + intended.rect.width / 2 + residual.dx * keyPitch;
      const downY = intended.rect.y + intended.rect.height / 2 + residual.dy * rowPitch;

      // Drift heads toward the next key, which is where the finger is going.
      let releaseX = downX;
      let releaseY = downY;
      if (options.inContactDriftMm > 0) {
        const following = options.residuals[index + 1];
        const next =
          following === undefined || following.interTapMs === null
            ? undefined
            : keyForCharacter(following.intended);
        if (next !== undefined) {
          const vx = next.rect.x + next.rect.width / 2 - downX;
          const vy = next.rect.y + next.rect.height / 2 - downY;
          const length = Math.hypot(vx, vy);
          if (length > 1e-6) {
            const drift = mm(options.inContactDriftMm);
            releaseX = downX + (vx / length) * drift;
            releaseY = downY + (vy / length) * drift;
          }
        }
      }

      const logPrior = options.priorFor?.(history);
      const decoderContext: DecoderContext = {
        ...options.context,
        ...(logPrior ? { logPrior } : {}),
      };
      const decided = decoder.decide(decoderContext, {
        downX,
        downY,
        trajectoryX: downX + (releaseX - downX) * 0.75,
        trajectoryY: downY + (releaseY - downY) * 0.75,
        releaseX,
        releaseY,
      });

      taps += 1;
      if (decided === intended.index) correct += 1;
      else countConfusion(confusions, intended.index, decided);
      history += residual.intended;
    }

    const accuracy = taps === 0 ? 0 : correct / taps;
    results.push({
      decoderId: decoder.id,
      taps,
      accuracy,
      errorsPer40: (1 - accuracy) * 40,
      confusions: describeConfusions(confusions, geometry),
    });
  }
  return results;
}

/**
 * Confusion counts keyed by a packed pair of key indices.
 *
 * The previous form joined two key ids with a separator, which is fragile the
 * moment an id could contain one — and the separator that was chosen, a literal
 * NUL, made the whole source file read as binary to grep and every other line
 * tool. Numbers have no delimiter problem.
 */
const NO_PREDICTION = -1;

function countConfusion(
  counts: Map<number, number>,
  intendedIndex: number,
  predictedIndex: number | null,
): void {
  const packed = intendedIndex * CONFUSION_STRIDE + (predictedIndex ?? NO_PREDICTION) + 1;
  counts.set(packed, (counts.get(packed) ?? 0) + 1);
}

function describeConfusions(
  counts: ReadonlyMap<number, number>,
  geometry: ResolvedKeyboardGeometry,
): Array<{ intended: string; predicted: string; count: number }> {
  const named = (index: number): string =>
    index === NO_PREDICTION ? '<none>' : (geometry.keys[index]?.definition.id ?? '?');
  return [...counts.entries()]
    .map(([packed, count]) => ({
      intended: named(Math.floor(packed / CONFUSION_STRIDE)),
      predicted: named((packed % CONFUSION_STRIDE) - 1),
      count,
    }))
    .sort((left, right) => right.count - left.count);
}

// ---------------------------------------------------------------------------
// Replay through the real engine
// ---------------------------------------------------------------------------

/**
 * An online personalization learner driven exactly the way production drives
 * one: it sees every trace the engine emits, and when `onTrace` returns true
 * the harness re-applies `modelFor` via `engine.updateTouchModel` — the same
 * synchronous inside-`endPointerAt` swap `VirtualTerminalKeyboard` performs.
 * The apply cadence therefore belongs to the learner, not the harness.
 */
export interface KeyboardReplayLearner {
  onTrace(trace: KeyboardTouchTrace, geometry: ResolvedKeyboardGeometry): boolean;
  modelFor(geometry: ResolvedKeyboardGeometry): KeyboardTouchModel;
  /**
   * Every replayed tap once its key is decided, with the trace it produced
   * (null when it produced none), in replay order. A correction learner holds
   * a sentence's taps here until the sentence ends, as production holds a line.
   */
  onTap?(
    ordinal: number,
    trace: KeyboardTouchTrace | null,
    decidedIndex: number | null,
    geometry: ResolvedKeyboardGeometry,
  ): void;
  /** A sentence ended. True asks the harness to re-apply `modelFor`. */
  onLineEnd?(geometry: ResolvedKeyboardGeometry): boolean;
}

export interface EngineReplayOptions {
  readonly context: DecoderContext;
  readonly residuals: readonly ReplayResidual[];
  /** In-contact travel toward the next key, in millimetres. */
  readonly inContactDriftMm: number;
  /** Pointer sample rate, which decides how many moves a contact produces. */
  readonly sampleHz: number;
  /** Contact duration in milliseconds; the measured two-thumb median is 84. */
  readonly contactMs: number;
  readonly touchModel?: KeyboardTouchModel;
  /** Mutually exclusive with `touchModel`: the learner owns the model. */
  readonly learner?: KeyboardReplayLearner;
  readonly priorFor?: (history: string) => Float64Array | undefined;
  /**
   * Per-tap outcome, in replay order over the taps whose character resolved to
   * a key. Lets a caller split one replay into train/score windows and slice
   * accuracy by key without a second pass.
   */
  readonly onDecision?: (
    ordinal: number,
    intendedIndex: number,
    decidedIndex: number | null,
  ) => void;
}

/**
 * Replays the corpus through `createKeyboardEngine` rather than calling the
 * classifier directly.
 *
 * This exists because `replayResiduals` cannot see most of the engine. It hands
 * `classifyKeyboardTouch` a synthesised trajectory point, so the sample ring,
 * the recency-weighted centroid, the release ramp's dependence on the real
 * contact path, anchor-commit and the press-order machinery are all bypassed —
 * which is precisely why the corpus could not arbitrate a proposed change to the
 * centroid. Here every one of those is live, and the only remaining synthetic
 * quantity is the shape of the contact path itself.
 */
export function replayThroughEngine(
  options: EngineReplayOptions,
  keyForCharacter: (character: string) => ResolvedKeyboardKey | undefined,
): ReplayResult {
  const { geometry, profile } = options.context;
  const keyPitch = geometry.width / 10;
  const rowPitch = keyboardRowPitch(geometry);
  const confusions = new Map<number, number>();
  const committed: Array<number | null> = [];
  const intendedIndices: number[] = [];

  const learner = options.learner;
  if (learner !== undefined && options.touchModel !== undefined) {
    throw new Error('EngineReplayOptions.learner and .touchModel are mutually exclusive');
  }
  const initialModel = learner === undefined ? options.touchModel : learner.modelFor(geometry);
  // The trace the current tap produced, handed to `onTap` once it is decided.
  let tapTrace: KeyboardTouchTrace | null = null;
  const engine = createKeyboardEngine({
    geometry,
    profile,
    ...(initialModel === undefined ? {} : { touchModel: initialModel }),
    ...(learner === undefined
      ? {}
      : {
          onTouchTrace: (trace: KeyboardTouchTrace) => {
            tapTrace = trace;
            if (learner.onTrace(trace, geometry)) {
              engine.updateTouchModel(learner.modelFor(geometry));
            }
          },
        }),
    // A stub host: the engine must never arm a real timer inside a replay, and
    // nothing here holds a contact long enough to repeat.
    timers: { set: () => 0, clear: () => undefined, now: () => 0 },
    onRawCommit: (key) => {
      committed.push(key.index);
    },
  });

  let clock = 0;
  let history = '';
  const step = 1000 / options.sampleHz;
  let sentence: number | null = null;
  const endLine = (): void => {
    if (learner?.onLineEnd?.(geometry) === true) {
      engine.updateTouchModel(learner.modelFor(geometry));
    }
  };

  for (let index = 0; index < options.residuals.length; index += 1) {
    const residual = options.residuals[index];
    if (residual === undefined) continue;
    if (sentence !== null && residual.sentence !== sentence) endLine();
    sentence = residual.sentence;
    if (residual.interTapMs === null) history = '';
    const intended = keyForCharacter(residual.intended);
    if (intended === undefined) {
      history += residual.intended;
      continue;
    }

    const downX = intended.rect.x + intended.rect.width / 2 + residual.dx * keyPitch;
    const downY = intended.rect.y + intended.rect.height / 2 + residual.dy * rowPitch;

    let toNextX = 0;
    let toNextY = 0;
    const following = options.residuals[index + 1];
    const next =
      following === undefined || following.interTapMs === null
        ? undefined
        : keyForCharacter(following.intended);
    if (next !== undefined) {
      const vx = next.rect.x + next.rect.width / 2 - downX;
      const vy = next.rect.y + next.rect.height / 2 - downY;
      const length = Math.hypot(vx, vy);
      if (length > 1e-6) {
        toNextX = vx / length;
        toNextY = vy / length;
      }
    }
    const drift = mm(options.inContactDriftMm);

    const logPrior = options.priorFor?.(history);
    engine.setKeyPrior(logPrior ?? null);

    const before = committed.length;
    tapTrace = null;
    engine.beginPointerAt(1, downX, downY, clock);
    for (let elapsed = step; elapsed < options.contactMs; elapsed += step) {
      const fraction = elapsed / options.contactMs;
      engine.movePointerAt(
        1,
        downX + toNextX * drift * fraction,
        downY + toNextY * drift * fraction,
        clock + elapsed,
      );
    }
    engine.endPointerAt(
      1,
      downX + toNextX * drift,
      downY + toNextY * drift,
      clock + options.contactMs,
    );
    // The inter-tap interval the corpus recorded, so contacts are spaced the way
    // the participant actually typed rather than back to back.
    clock += Math.max(options.contactMs, residual.interTapMs ?? options.contactMs);

    intendedIndices.push(intended.index);
    if (committed.length === before) committed.push(null);
    learner?.onTap?.(
      intendedIndices.length - 1,
      tapTrace,
      committed[committed.length - 1] ?? null,
      geometry,
    );
    history += residual.intended;
  }
  endLine();
  engine.destroy();

  let correct = 0;
  for (let index = 0; index < intendedIndices.length; index += 1) {
    const intendedIndex = intendedIndices[index] ?? -1;
    const decided = committed[index] ?? null;
    options.onDecision?.(index, intendedIndex, decided);
    if (decided === intendedIndex) correct += 1;
    else countConfusion(confusions, intendedIndex, decided);
  }
  const taps = intendedIndices.length;
  const accuracy = taps === 0 ? 0 : correct / taps;
  return {
    decoderId: `engine@${options.sampleHz}Hz/${options.contactMs}ms`,
    taps,
    accuracy,
    errorsPer40: (1 - accuracy) * 40,
    confusions: describeConfusions(confusions, geometry),
  };
}
