/**
 * Replays measured human taps through Merkur's decoders.
 *
 *   bun run scripts/extract-touch-residuals.ts --dataset <dir> --out residuals.json
 *   bun run scripts/run-keyboard-replay.ts --residuals residuals.json
 *
 * This is the least circular evaluation available without a device capture: the
 * aim errors are real human taps with known intent, and the only synthetic
 * quantity is in-contact drift, which the corpus cannot supply because it logs
 * one point per keystroke. Drift is therefore swept rather than assumed, which
 * also makes the sweep the direct test of the `tapDrift` threshold.
 *
 * The causal prior is trained on one half of the target sentences and scored on
 * the other half, so it is never evaluated on text it memorised.
 */
import { readFileSync } from 'node:fs';
import {
  KEYBOARD_CANDIDATE_COUNT,
  keyboardHitAtlasOffset,
} from '../packages/keyboard/src/geometry';
import { createKeyboardOffsetModel } from '../packages/keyboard/src/offset-model';
import { createKeyboardSpatialPrior } from '../packages/keyboard/src/touch-model';
import type {
  KeyboardTouchModel,
  KeyboardTouchTrace,
  ResolvedKeyboardGeometry,
} from '../packages/keyboard/src/types';
import {
  anchorCommitShare,
  CONTACT_ONLY_DECODER,
  createAnchorCommitDecoder,
  createCharacterResolver,
  createLabContext,
  createPriorDecoder,
  createTunedDecoder,
  type Decoder,
  type KeyboardReplayLearner,
  NO_CLIFF_DECODER,
  PX_PER_MM,
  RELEASE_ONLY_DECODER,
  type ReplayResidual,
  replayResiduals,
  replayThroughEngine,
  SHIPPED_DECODER,
} from './keyboard-decoder-lab';

interface Corpus {
  readonly source: string;
  readonly citation: string;
  readonly residuals: readonly (ReplayResidual & {
    readonly actual: string;
    readonly block: number;
    readonly participant: number;
    /** What the participant retyped in this tap's place, per input-stream analysis. */
    readonly correctedTo: string | null;
  })[];
  /** Per-participant aim biases from `extract-touch-residuals.ts`. */
  readonly biases: readonly {
    readonly participant: number;
    readonly block: number;
    readonly key: string;
    readonly dx: number;
    readonly dy: number;
    readonly count: number;
  }[];
}

type CorpusResidual = Corpus['residuals'][number];

const arguments_ = process.argv.slice(2);
const residualsIndex = arguments_.indexOf('--residuals');
const residualsPath = residualsIndex >= 0 ? arguments_[residualsIndex + 1] : undefined;
const blockIndex = arguments_.indexOf('--block');
const block = blockIndex >= 0 ? Number(arguments_[blockIndex + 1]) : 2;
if (residualsPath === undefined) {
  throw new Error(
    'Usage: bun run scripts/run-keyboard-replay.ts --residuals <file.json> [--block 1|2]\n' +
      '  [--smoothness]                     leave-one-key-out grip-field analysis\n' +
      '  [--learner [--bias participant|perkey] [--budgets 50,200,1000,all]]',
  );
}

const corpus: Corpus = JSON.parse(readFileSync(residualsPath, 'utf8'));
const context = createLabContext();
const resolve = createCharacterResolver(context.geometry);

const selected = corpus.residuals.filter((residual) => residual.block === block);

/** A participant/key bias below this many taps is noise, not a measurement. */
const MIN_BIAS_TAPS = 5;
/** Keys wider than this many pitches contribute no x-axis evidence: scatter
 * along the space bar is key geometry, not aim. */
const WIDE_KEY_PITCHES = 1.25;
/** Fewer qualifying keys than this and leave-one-out has nothing to say. */
const MIN_PARTICIPANT_KEYS = 10;

const FIELD_MODELS = [
  { id: 'none', dims: 0 },
  { id: 'constant', dims: 1 },
  { id: 'linear', dims: 3 },
  { id: 'quadratic', dims: 6 },
] as const;

// Two additional modes share the corpus and geometry setup and then leave: the
// smoothness analysis behind the grip-field gate, and the online-learner A/B.
if (arguments_.includes('--smoothness')) {
  analyzeGripSmoothness();
  process.exit(0);
}
if (arguments_.includes('--learner')) {
  runLearnerComparison();
  process.exit(0);
}

// Odd sentence ids train the prior, even ones are scored. Splitting on sentence
// rather than on taps keeps a sentence's characters from appearing on both sides.
const trainingResiduals = selected.filter((residual) => residual.sentence % 2 === 1);
const evaluationResiduals = selected.filter((residual) => residual.sentence % 2 === 0);

const { priorFor, alphabet } = buildPrior(trainingResiduals.map((r) => r.intended).join(''));

// The shipped prior sets sigma = 0.48 x each key's own rect in BOTH axes, which
// makes sigma_y / sigma_x = 1.28 for a letter key. Measured on this corpus the
// real ratio is 0.53: thumb typing scatters far wider than it is tall. These
// variants change only the multipliers, keeping the per-key-rect scaling that
// wide keys such as Space depend on.
const decoders: Decoder[] = [
  SHIPPED_DECODER,
  NO_CLIFF_DECODER,
  CONTACT_ONLY_DECODER,
  RELEASE_ONLY_DECODER,
  createPriorDecoder(0.25),
  createPriorDecoder(0.5),
  // What the engine does now. At zero drift this is provably identical to
  // `shipped`: the corpus logs one point per keystroke and `releaseWeight` is 0,
  // so down, trajectory and release are the same point and both decoders make
  // the same call. Above zero it should track `contact-only`'s advantage in
  // proportion to the anchored share, and never fall below `shipped`.
  createAnchorCommitDecoder(0.25),
  createTunedDecoder({
    id: 'rect .48/.48',
    sigmaX: 0.48,
    sigmaY: 0.48,
    scaleBy: 'rect',
    priorWeight: 0,
  }),
  createTunedDecoder({
    id: 'rect .48/.30',
    sigmaX: 0.48,
    sigmaY: 0.3,
    scaleBy: 'rect',
    priorWeight: 0,
  }),
  createTunedDecoder({
    id: 'rect .48/.22',
    sigmaX: 0.48,
    sigmaY: 0.22,
    scaleBy: 'rect',
    priorWeight: 0,
  }),
  createTunedDecoder({
    id: 'rect .55/.22',
    sigmaX: 0.55,
    sigmaY: 0.22,
    scaleBy: 'rect',
    priorWeight: 0,
  }),
  createTunedDecoder({
    id: 'rect+prior.25',
    sigmaX: 0.48,
    sigmaY: 0.22,
    scaleBy: 'rect',
    priorWeight: 0.25,
  }),
  createTunedDecoder({
    id: 'rect+prior.5',
    sigmaX: 0.48,
    sigmaY: 0.22,
    scaleBy: 'rect',
    priorWeight: 0.5,
  }),
  createTunedDecoder({
    id: 'uniform sigma',
    sigmaX: 0.462,
    sigmaY: 0.178,
    scaleBy: 'pitch',
    priorWeight: 0,
  }),
];

const deviceErrors = evaluationResiduals.filter((r) => r.intended !== r.actual).length;
process.stdout.write(
  `Merkur keyboard replay on measured human taps\n` +
    `source: ${corpus.source}\n` +
    `cite:   ${corpus.citation}\n` +
    `block ${block} (${block === 2 ? 'two thumbs' : 'one finger'}), ` +
    `${trainingResiduals.length.toLocaleString('en-US')} taps train the prior, ` +
    `${evaluationResiduals.length.toLocaleString('en-US')} are scored, alphabet ${alphabet}\n` +
    `The study device's own production keyboard got ` +
    `${(((evaluationResiduals.length - deviceErrors) / evaluationResiduals.length) * 100).toFixed(2)}% ` +
    `on these same taps.\n\n`,
);

const DRIFTS = [0, 1, 1.5, 2, 2.5, 3, 4];
process.stdout.write(
  'Per-tap accuracy against in-contact drift (mm of travel before the finger lifts)\n',
);
process.stdout.write(
  `tapDrift threshold is ${context.profile.tapDrift}px = ${(context.profile.tapDrift / PX_PER_MM).toFixed(2)}mm\n\n`,
);

const coverage = anchorCommitShare(context, evaluationResiduals, resolve);
process.stdout.write(
  `anchor-commit coverage: ${(coverage.share * 100).toFixed(2)}% of taps ` +
    `(${coverage.anchored}/${coverage.taps}) land inside the committed key's anchor\n` +
    'and therefore commit at touch-down instead of at release.\n\n',
);

const header = ['decoder'.padEnd(20), ...DRIFTS.map((d) => `${d}mm`.padStart(8))].join('');
process.stdout.write(`${header}\n`);

const rows = new Map<string, string[]>();
for (const drift of DRIFTS) {
  const results = replayResiduals(
    decoders,
    { context, residuals: evaluationResiduals, inContactDriftMm: drift, priorFor },
    resolve,
  );
  for (const result of results) {
    const row = rows.get(result.decoderId) ?? [];
    row.push(`${(result.accuracy * 100).toFixed(2)}%`.padStart(8));
    rows.set(result.decoderId, row);
  }
}
for (const [decoderId, cells] of rows) {
  process.stdout.write(`${decoderId.padEnd(20)}${cells.join('')}\n`);
}

// The decoder table above calls `classifyKeyboardTouch` directly, which skips
// the sample ring, the centroid and anchor-commit. This drives the real engine,
// so a disagreement between the two is a warning that the table is measuring a
// model of the keyboard rather than the keyboard.
process.stdout.write('\nThrough the real engine, at the measured two-thumb contact duration\n');
process.stdout.write(
  `${'sample rate'.padEnd(14)}${DRIFTS.map((d) => `${d}mm`.padStart(8)).join('')}\n`,
);
for (const sampleHz of [60, 120]) {
  const cells = DRIFTS.map((driftMm) => {
    const result = replayThroughEngine(
      {
        context,
        residuals: evaluationResiduals,
        inContactDriftMm: driftMm,
        sampleHz,
        contactMs: 84,
        priorFor,
      },
      resolve,
    );
    return `${(result.accuracy * 100).toFixed(2)}%`.padStart(8);
  });
  process.stdout.write(`${`${sampleHz}Hz`.padEnd(14)}${cells.join('')}\n`);
}

process.stdout.write('\nTop confusions at 0mm drift (pure aim error, no departure motion)\n');
for (const result of replayResiduals(
  decoders,
  { context, residuals: evaluationResiduals, inContactDriftMm: 0, priorFor },
  resolve,
)) {
  const top = result.confusions
    .slice(0, 4)
    .map((c) => `${c.intended.replace('key-', '')}->${c.predicted.replace('key-', '')}x${c.count}`)
    .join(' ');
  process.stdout.write(
    `  ${result.decoderId.padEnd(20)} ${(result.accuracy * 100).toFixed(2)}%  ` +
      `${result.errorsPer40.toFixed(2)} err/40  ${top}\n`,
  );
}

/** Character bigram log-prior over key indices, add-k smoothed. */
function buildPrior(text: string): {
  priorFor: (history: string) => Float64Array | undefined;
  alphabet: number;
} {
  const keyCount = context.geometry.keys.length;
  const indexFor = new Map<string, number>();
  for (const key of context.geometry.keys) {
    const value = key.definition.id === 'space' ? ' ' : key.definition.value;
    if (value !== undefined && value.length === 1 && !indexFor.has(value)) {
      indexFor.set(value, key.index);
    }
  }

  const unigram = new Float64Array(keyCount);
  const bigram = new Map<string, Float64Array>();
  let previous = ' ';
  for (const character of text.toLowerCase()) {
    const index = indexFor.get(character);
    if (index !== undefined) {
      unigram[index] = (unigram[index] ?? 0) + 1;
      let row = bigram.get(previous);
      if (row === undefined) {
        row = new Float64Array(keyCount);
        bigram.set(previous, row);
      }
      row[index] = (row[index] ?? 0) + 1;
    }
    previous = character;
  }

  const SMOOTHING = 0.5;
  const toLog = (counts: Float64Array): Float64Array => {
    let total = 0;
    for (let index = 0; index < keyCount; index += 1) total += (counts[index] ?? 0) + SMOOTHING;
    const out = new Float64Array(keyCount);
    for (let index = 0; index < keyCount; index += 1) {
      out[index] = Math.log(((counts[index] ?? 0) + SMOOTHING) / total);
    }
    return out;
  };

  // Keys with no character value carry NaN, exactly as `keyboard-prior.ts` does
  // in production: that is the signal the scorer uses to step aside rather than
  // invent a probability for Backspace or Shift. Filling them with a smoothed
  // floor here instead would measure a decoder the app does not ship.
  const characterKeys = new Set(indexFor.values());
  const markNonCharacters = (values: Float64Array): Float64Array => {
    for (let index = 0; index < keyCount; index += 1) {
      if (!characterKeys.has(index)) values[index] = Number.NaN;
    }
    return values;
  };

  const unigramLog = markNonCharacters(toLog(unigram));
  const cache = new Map<string, Float64Array>();
  for (const [character, counts] of bigram) {
    cache.set(character, markNonCharacters(toLog(counts)));
  }

  return {
    alphabet: indexFor.size,
    priorFor(history: string): Float64Array {
      const last = history.length === 0 ? ' ' : (history[history.length - 1] ?? ' ').toLowerCase();
      return cache.get(last) ?? unigramLog;
    },
  };
}

// ---------------------------------------------------------------------------
// Grip-field smoothness analysis (`--smoothness`)
// ---------------------------------------------------------------------------

interface BiasPoint {
  readonly su: number;
  readonly sv: number;
  readonly dxPitch: number;
  readonly dyPitch: number;
  readonly wide: boolean;
}

/**
 * Re-runs the PERF.md leave-one-key-out experiment — "can a smooth spatial
 * field predict a key's aim bias from the other keys' biases?" — across every
 * corpus participant instead of 193 taps from one device. This is the gate on
 * building the pooled grip field at all, and on what order it gets.
 */
function analyzeGripSmoothness(): void {
  const { geometry } = context;
  const keyPitch = geometry.width / 10;
  const rowPitch = geometry.hitHeight / geometry.rows.length;

  const byParticipant = new Map<number, BiasPoint[]>();
  let skippedThinBiases = 0;
  for (const bias of corpus.biases) {
    if (bias.block !== block) continue;
    if (bias.count < MIN_BIAS_TAPS) {
      skippedThinBiases += 1;
      continue;
    }
    const key = resolve(bias.key);
    if (key === undefined) continue;
    const su = 2 * ((key.rect.x + key.rect.width / 2) / geometry.width - 0.5);
    const sv = 2 * ((key.rect.y + key.rect.height / 2) / geometry.hitHeight - 0.5);
    const list = byParticipant.get(bias.participant) ?? [];
    list.push({
      su,
      sv,
      dxPitch: bias.dx,
      dyPitch: bias.dy,
      wide: key.rect.width > WIDE_KEY_PITCHES * keyPitch,
    });
    byParticipant.set(bias.participant, list);
  }

  const totals = new Map<string, { sq: number; n: number }>(
    FIELD_MODELS.map((model) => [model.id, { sq: 0, n: 0 }]),
  );
  const wins = new Map<string, number>(FIELD_MODELS.map((model) => [model.id, 0]));
  let participants = 0;
  let skippedThinParticipants = 0;

  for (const points of byParticipant.values()) {
    if (points.length < MIN_PARTICIPANT_KEYS) {
      skippedThinParticipants += 1;
      continue;
    }
    participants += 1;
    const perModel = new Map<string, { sq: number; n: number }>(
      FIELD_MODELS.map((model) => [model.id, { sq: 0, n: 0 }]),
    );

    for (let hold = 0; hold < points.length; hold += 1) {
      const target = points[hold];
      if (target === undefined) continue;
      const train = points.filter((_, index) => index !== hold);

      // An axis-holdout is scored only when EVERY model can predict it, so the
      // rows below stay comparable instead of easier models scoring more taps.
      const axes: Array<{ errorsPx: Map<string, number> }> = [];
      for (const axis of ['x', 'y'] as const) {
        if (axis === 'x' && target.wide) continue;
        const samples = (axis === 'x' ? train.filter((point) => !point.wide) : train).map(
          (point) => ({
            su: point.su,
            sv: point.sv,
            t: axis === 'x' ? point.dxPitch : point.dyPitch,
          }),
        );
        const observed = axis === 'x' ? target.dxPitch : target.dyPitch;
        const pitchPx = axis === 'x' ? keyPitch : rowPitch;
        const errorsPx = new Map<string, number>();
        let allPredicted = true;
        for (const model of FIELD_MODELS) {
          const predicted = predictField(model.dims, samples, target);
          if (predicted === null) {
            allPredicted = false;
            break;
          }
          errorsPx.set(model.id, (predicted - observed) * pitchPx);
        }
        if (allPredicted) axes.push({ errorsPx });
      }

      for (const { errorsPx } of axes) {
        for (const [modelId, errorPx] of errorsPx) {
          const cell = perModel.get(modelId);
          if (cell === undefined) continue;
          cell.sq += errorPx * errorPx;
          cell.n += 1;
        }
      }
    }

    const nonePerAxis = perModel.get('none');
    for (const model of FIELD_MODELS) {
      const cell = perModel.get(model.id);
      if (cell === undefined || nonePerAxis === undefined || cell.n === 0) continue;
      const total = totals.get(model.id);
      if (total !== undefined) {
        total.sq += cell.sq;
        total.n += cell.n;
      }
      if (model.id !== 'none' && cell.sq < nonePerAxis.sq) {
        wins.set(model.id, (wins.get(model.id) ?? 0) + 1);
      }
    }
  }

  process.stdout.write(
    `Grip-field smoothness, leave-one-key-out per participant\n` +
      `block ${block}, ${participants} participants scored ` +
      `(${skippedThinParticipants} below ${MIN_PARTICIPANT_KEYS} keys), ` +
      `biases under ${MIN_BIAS_TAPS} taps dropped (${skippedThinBiases}), ` +
      `wide-key x-axis excluded\n\n`,
  );
  process.stdout.write(
    `${'model'.padEnd(12)}${'rms px'.padStart(10)}${'beats none'.padStart(14)}\n`,
  );
  for (const model of FIELD_MODELS) {
    const total = totals.get(model.id);
    if (total === undefined || total.n === 0) continue;
    const rms = Math.sqrt(total.sq / total.n);
    const beat = model.id === 'none' ? '-' : `${wins.get(model.id) ?? 0}/${participants}`;
    process.stdout.write(
      `${model.id.padEnd(12)}${rms.toFixed(2).padStart(10)}${beat.padStart(14)}\n`,
    );
  }
}

/**
 * Ordinary least squares on the scaled-position basis, evaluated at one point.
 * Returns null when the training set cannot support the model, so the caller
 * can keep every model on identical holdouts. The tiny ridge is numerical
 * conditioning for a near-singular normal matrix, not regularization.
 */
function predictField(
  dims: number,
  samples: readonly { readonly su: number; readonly sv: number; readonly t: number }[],
  at: { readonly su: number; readonly sv: number },
): number | null {
  if (dims === 0) return 0;
  if (samples.length < dims + 2) return null;
  const a = new Float64Array(dims * dims);
  const b = new Float64Array(dims);
  const phi = new Float64Array(dims);
  for (const sample of samples) {
    fillFieldBasis(phi, dims, sample.su, sample.sv);
    for (let row = 0; row < dims; row += 1) {
      const phiRow = phi[row] ?? 0;
      b[row] = (b[row] ?? 0) + phiRow * sample.t;
      for (let column = 0; column < dims; column += 1) {
        a[row * dims + column] = (a[row * dims + column] ?? 0) + phiRow * (phi[column] ?? 0);
      }
    }
  }
  for (let diagonal = 0; diagonal < dims; diagonal += 1) {
    a[diagonal * dims + diagonal] = (a[diagonal * dims + diagonal] ?? 0) + 1e-9;
  }
  const theta = solveLinearSystem(a, b, dims);
  if (theta === null) return null;
  fillFieldBasis(phi, dims, at.su, at.sv);
  let predicted = 0;
  for (let index = 0; index < dims; index += 1) {
    predicted += (phi[index] ?? 0) * (theta[index] ?? 0);
  }
  return predicted;
}

function fillFieldBasis(phi: Float64Array, dims: number, su: number, sv: number): void {
  phi[0] = 1;
  if (dims > 1) {
    phi[1] = su;
    phi[2] = sv;
  }
  if (dims > 3) {
    phi[3] = su * su;
    phi[4] = su * sv;
    phi[5] = sv * sv;
  }
}

/** Gaussian elimination with partial pivoting; null on a singular system. */
function solveLinearSystem(a: Float64Array, b: Float64Array, dims: number): Float64Array | null {
  for (let pivot = 0; pivot < dims; pivot += 1) {
    let best = pivot;
    let bestMagnitude = Math.abs(a[pivot * dims + pivot] ?? 0);
    for (let row = pivot + 1; row < dims; row += 1) {
      const magnitude = Math.abs(a[row * dims + pivot] ?? 0);
      if (magnitude > bestMagnitude) {
        best = row;
        bestMagnitude = magnitude;
      }
    }
    if (bestMagnitude < 1e-12) return null;
    if (best !== pivot) {
      for (let column = 0; column < dims; column += 1) {
        const held = a[pivot * dims + column] ?? 0;
        a[pivot * dims + column] = a[best * dims + column] ?? 0;
        a[best * dims + column] = held;
      }
      const heldB = b[pivot] ?? 0;
      b[pivot] = b[best] ?? 0;
      b[best] = heldB;
    }
    const pivotValue = a[pivot * dims + pivot] ?? 1;
    for (let row = pivot + 1; row < dims; row += 1) {
      const factor = (a[row * dims + pivot] ?? 0) / pivotValue;
      if (factor === 0) continue;
      for (let column = pivot; column < dims; column += 1) {
        a[row * dims + column] =
          (a[row * dims + column] ?? 0) - factor * (a[pivot * dims + column] ?? 0);
      }
      b[row] = (b[row] ?? 0) - factor * (b[pivot] ?? 0);
    }
  }
  const theta = new Float64Array(dims);
  for (let row = dims - 1; row >= 0; row -= 1) {
    let sum = b[row] ?? 0;
    for (let column = row + 1; column < dims; column += 1) {
      sum -= (a[row * dims + column] ?? 0) * (theta[column] ?? 0);
    }
    theta[row] = sum / (a[row * dims + row] ?? 1);
  }
  return theta;
}

// ---------------------------------------------------------------------------
// Online-learner A/B (`--learner`)
// ---------------------------------------------------------------------------

interface LearnerRunConfig {
  readonly id: string;
  /**
   * undefined = replay with no learner at all. `tapAt` reads the corpus entry
   * behind a replay ordinal, for learners fed the user's corrections.
   */
  readonly create: (
    tapAt: (ordinal: number) => CorpusResidual | undefined,
  ) => KeyboardReplayLearner | undefined;
}

/**
 * Where a correction learner's labels come from. `participant`: taps this
 * replay decoded wrongly that the participant also corrected in their own
 * stream, labelled with what they retyped, which is what production sees when
 * both keyboards miss the same tap. `every-miss`: every tap this replay decoded
 * wrongly, labelled with the intended key, the user who corrects everything
 * they see. Either way the label must be among the tap's four nearest keys, as
 * the diagnostics require, and it arrives when the sentence ends.
 */
type CorrectionLabels = 'participant' | 'every-miss';

interface LearnerTotals {
  scored: number;
  correct: number;
  transferScored: number;
  transferCorrect: number;
}

/**
 * Scores personalization learners online through the real engine, the
 * methodology behind PERF.md's "+8.86 pp" entry — committed this time, so the
 * next change to the learner has an instrument instead of an anecdote.
 *
 * Runs without the causal prior on purpose: the learner is the variable being
 * measured, and the prior would smear its effect with a second correction.
 * Finite budgets freeze learning after that many taps and score the remainder;
 * `all` learns online throughout, matching the original PERF.md run. The
 * transfer column scores only keys the learner never saw inside the budget —
 * the cold-start claim, measured directly.
 */
function runLearnerComparison(): void {
  const biasModeIndex = arguments_.indexOf('--bias');
  const biasMode = biasModeIndex >= 0 ? (arguments_[biasModeIndex + 1] ?? '') : 'participant';
  if (biasMode !== 'participant' && biasMode !== 'perkey' && biasMode !== 'device') {
    throw new Error(`--bias must be participant, perkey or device, got ${biasMode}`);
  }
  const budgetsIndex = arguments_.indexOf('--budgets');
  const budgets = (budgetsIndex >= 0 ? (arguments_[budgetsIndex + 1] ?? '') : '50,200,1000,all')
    .split(',')
    .map((token) => (token === 'all' ? Number.POSITIVE_INFINITY : Number(token)));
  if (budgets.some((budget) => !(budget > 0))) {
    throw new Error('--budgets must be positive tap counts or "all"');
  }

  const streams: CorpusResidual[][] = [];
  if (biasMode === 'participant') {
    const byParticipant = new Map<number, CorpusResidual[]>();
    for (const residual of selected) {
      const list = byParticipant.get(residual.participant) ?? [];
      list.push(residual);
      byParticipant.set(residual.participant, list);
    }
    streams.push(...byParticipant.values());
  } else {
    streams.push([...selected]);
  }

  const biasFor =
    biasMode === 'participant'
      ? populationBias()
      : biasMode === 'device'
        ? deviceReportedBias()
        : seededPerKeyBias();
  const configs: LearnerRunConfig[] = [
    { id: 'none', create: () => undefined },
    { id: 'per-key', create: () => createReplayLearner({ gripField: false }) },
    { id: 'pooled', create: () => createReplayLearner() },
    {
      id: '+fixes',
      create: (tapAt) => createReplayLearner(undefined, { tapAt, labels: 'participant' }),
    },
    {
      id: '+all-fixes',
      create: (tapAt) => createReplayLearner(undefined, { tapAt, labels: 'every-miss' }),
    },
  ];

  process.stdout.write(
    `Online learner A/B through the real engine\n` +
      `block ${block}, bias=${biasMode}, ${streams.length} stream(s), ` +
      `${selected.length.toLocaleString('en-US')} taps, 0mm drift, 120Hz, no causal prior\n` +
      `finite budgets freeze learning at the budget and score the rest; ` +
      `"transfer" is accuracy on keys unseen within the budget\n\n`,
  );

  for (const budget of budgets) {
    const label = Number.isFinite(budget) ? String(budget) : 'all';
    const cells: string[] = [];
    const transferCells: string[] = [];
    let transferTaps = 0;
    for (const config of configs) {
      const totals: LearnerTotals = {
        scored: 0,
        correct: 0,
        transferScored: 0,
        transferCorrect: 0,
      };
      for (const stream of streams) {
        accumulateLearnerRun(totals, stream, biasFor, budget, config.create);
      }
      const accuracy =
        totals.scored === 0 ? 'n/a' : `${((totals.correct / totals.scored) * 100).toFixed(2)}%`;
      cells.push(`${config.id} ${accuracy}`.padEnd(20));
      const transfer =
        totals.transferScored === 0
          ? 'n/a'
          : `${((totals.transferCorrect / totals.transferScored) * 100).toFixed(2)}%`;
      transferCells.push(`${config.id} ${transfer}`.padEnd(20));
      transferTaps = totals.transferScored;
    }
    process.stdout.write(`budget ${label.padEnd(6)}${cells.join('')}\n`);
    if (Number.isFinite(budget)) {
      process.stdout.write(
        `  transfer (${transferTaps.toLocaleString('en-US')} taps): ${transferCells.join('')}\n`,
      );
    }
  }
}

function accumulateLearnerRun(
  totals: LearnerTotals,
  stream: readonly CorpusResidual[],
  biasFor: ReadonlyMap<string, { readonly dx: number; readonly dy: number }>,
  budget: number,
  create: LearnerRunConfig['create'],
): void {
  // Prefilter to resolvable characters so replay ordinals align 1:1 with this
  // array, which is what lets the decision callback split train from score.
  const filtered = stream.filter((residual) => resolve(residual.intended) !== undefined);
  if (filtered.length === 0) return;
  const learner = create((ordinal) => filtered[ordinal]);
  const injected = filtered.map((residual) => {
    const bias = biasFor.get(residual.intended);
    return bias === undefined
      ? residual
      : { ...residual, dx: residual.dx + bias.dx, dy: residual.dy + bias.dy };
  });

  const scoredFrom = Number.isFinite(budget) ? Math.min(budget, filtered.length) : 0;
  const seenInBudget = new Set<string>();
  for (let index = 0; index < scoredFrom; index += 1) {
    const residual = filtered[index];
    if (residual !== undefined) seenInBudget.add(residual.intended);
  }

  replayThroughEngine(
    {
      context,
      residuals: injected,
      inContactDriftMm: 0,
      sampleHz: 120,
      contactMs: 84,
      ...(learner === undefined ? {} : { learner: budgetedLearner(learner, budget) }),
      onDecision: (ordinal, intendedIndex, decidedIndex) => {
        if (ordinal < scoredFrom) return;
        const residual = filtered[ordinal];
        if (residual === undefined) return;
        totals.scored += 1;
        const correct = decidedIndex === intendedIndex;
        if (correct) totals.correct += 1;
        if (scoredFrom > 0 && !seenInBudget.has(residual.intended)) {
          totals.transferScored += 1;
          if (correct) totals.transferCorrect += 1;
        }
      },
    },
    resolve,
  );
}

/**
 * Stops feeding the learner after `budget` traces; the model then freezes. A
 * correction counts against the budget through the tap it labels, so none
 * reaches the model from a tap past it.
 */
function budgetedLearner(inner: KeyboardReplayLearner, budget: number): KeyboardReplayLearner {
  let seenTraces = 0;
  return {
    onTrace: (trace, geometry) => {
      if (seenTraces >= budget) return false;
      seenTraces += 1;
      return inner.onTrace(trace, geometry);
    },
    modelFor: (geometry) => inner.modelFor(geometry),
    onTap: (ordinal, trace, decidedIndex, geometry) => {
      if (ordinal < budget) inner.onTap?.(ordinal, trace, decidedIndex, geometry);
    },
    onLineEnd: (geometry) => inner.onLineEnd?.(geometry) === true,
  };
}

/**
 * The offset learner behind the production 25-tap apply cadence, optionally
 * fed the user's corrections at each sentence end.
 */
function createReplayLearner(
  options?: Parameters<typeof createKeyboardOffsetModel>[0],
  corrections?: {
    readonly tapAt: (ordinal: number) => CorpusResidual | undefined;
    readonly labels: CorrectionLabels;
  },
): KeyboardReplayLearner {
  const model = createKeyboardOffsetModel(options);
  const bases = new WeakMap<ResolvedKeyboardGeometry, KeyboardTouchModel>();
  const line: { trace: KeyboardTouchTrace; keyId: string }[] = [];
  let sinceApply = 0;
  const applyDue = (): boolean => {
    if (sinceApply < 25) return false;
    sinceApply = 0;
    return true;
  };
  return {
    onTrace: (trace, geometry) => {
      if (!model.record(trace, geometry)) return false;
      sinceApply += 1;
      return applyDue();
    },
    onTap: (ordinal, trace, decidedIndex, geometry) => {
      if (corrections === undefined || trace === null) return;
      const residual = corrections.tapAt(ordinal);
      const intendedKey = residual === undefined ? undefined : resolve(residual.intended);
      // Nothing to correct: the replay typed what was meant.
      if (residual === undefined || intendedKey === undefined) return;
      if (decidedIndex === intendedKey.index) return;
      const label = corrections.labels === 'participant' ? residual.correctedTo : residual.intended;
      const labelKey = label === null ? undefined : resolve(label);
      if (labelKey === undefined) return;
      const atlasOffset = keyboardHitAtlasOffset(geometry, trace.downX, trace.downY);
      if (!atlasIncludes(geometry, atlasOffset, labelKey.index)) return;
      line.push({ trace, keyId: labelKey.definition.id });
    },
    onLineEnd: (geometry) => {
      for (const { trace, keyId } of line) {
        if (model.recordCorrection(trace, geometry, keyId)) sinceApply += 1;
      }
      line.length = 0;
      return applyDue();
    },
    modelFor: (geometry) => {
      let base = bases.get(geometry);
      if (base === undefined) {
        base = createKeyboardSpatialPrior(geometry);
        bases.set(geometry, base);
      }
      return model.apply(geometry, base);
    },
  };
}

/**
 * The population's mean landing offset per key against the published centres,
 * pooled over ALL blocks and participants — the residual extractor subtracted
 * the per-key mean over that same pooling, so adding this back reconstructs
 * each tap's true offset from the key centre, and each participant's personal
 * deviation is already inside their residual stream.
 */
function populationBias(): Map<string, { dx: number; dy: number }> {
  const sums = new Map<string, { x: number; y: number; n: number }>();
  for (const bias of corpus.biases) {
    const entry = sums.get(bias.key) ?? { x: 0, y: 0, n: 0 };
    entry.x += bias.dx * bias.count;
    entry.y += bias.dy * bias.count;
    entry.n += bias.count;
    sums.set(bias.key, entry);
  }
  const biases = new Map<string, { dx: number; dy: number }>();
  for (const [key, entry] of sums) {
    if (entry.n === 0) continue;
    biases.set(key, { dx: entry.x / entry.n, dy: entry.y / entry.n });
  }
  return biases;
}

/**
 * Deterministic per-key Gaussian bias, the PERF.md regression anchor: it
 * reproduces the original "+8.86 pp" methodology of injecting a per-key aim
 * bias at device-reported magnitude, with the seed fixed so every run and every
 * configuration sees byte-identical taps.
 *
 * The original bias map was never archived, so the default magnitudes are
 * calibrated instead: at 0.21/0.345 pitches the no-learner baseline lands at
 * 73.34% against the recorded 73.70%, and the per-key learner recovers
 * +6.90 pp against the recorded +8.86 — same order, different draw.
 */
function seededPerKeyBias(): Map<string, { dx: number; dy: number }> {
  const sdX = flagNumber('--bias-sd-x', 0.21);
  const sdY = flagNumber('--bias-sd-y', 0.345);
  const biases = new Map<string, { dx: number; dy: number }>();
  for (const key of context.geometry.keys) {
    const character = key.definition.id === 'space' ? ' ' : key.definition.value;
    if (character === undefined || character.length !== 1) continue;
    const random = createSeededNormal(0x9e3779b9 ^ (character.codePointAt(0) ?? 1));
    biases.set(character, { dx: random() * sdX, dy: random() * sdY });
  }
  return biases;
}

/**
 * The one real per-key bias map on record: the vertical offsets the PERF.md
 * diagnostics readout quoted for its well-sampled keys, in CSS px on a 402 pt
 * portrait board (row pitch 68.3 px), converted to row pitches. Horizontal
 * offsets were not reported and stay zero. Unlike the seeded draw, this is
 * what a measured pathological device actually looks like — a thumb arc with
 * outliers, not spatial white noise.
 */
function deviceReportedBias(): Map<string, { dx: number; dy: number }> {
  const rowPitchPx = context.geometry.hitHeight / context.geometry.rows.length;
  const verticalPx: ReadonlyArray<readonly [string, number]> = [
    [' ', 32.2],
    ['t', 10.5],
    ['i', 8.8],
    ['n', -15.7],
    ['l', 31.3],
    ['a', -6.3],
    ['f', 10.6],
    ['g', 19.3],
    ['j', 19.7],
  ];
  const biases = new Map<string, { dx: number; dy: number }>();
  for (const [character, px] of verticalPx) {
    biases.set(character, { dx: 0, dy: px / rowPitchPx });
  }
  return biases;
}

/** Whether `keyIndex` is among the four candidates the atlas lists at `atlasOffset`. */
function atlasIncludes(
  geometry: ResolvedKeyboardGeometry,
  atlasOffset: number,
  keyIndex: number,
): boolean {
  if (atlasOffset < 0) return false;
  const base = atlasOffset * KEYBOARD_CANDIDATE_COUNT;
  for (let position = 0; position < KEYBOARD_CANDIDATE_COUNT; position += 1) {
    if (geometry.candidateAtlas[base + position] === keyIndex) return true;
  }
  return false;
}

function flagNumber(name: string, fallback: number): number {
  const index = arguments_.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(arguments_[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} needs a number`);
  return value;
}

/** Deterministic normal deviates via xorshift + Box-Muller. */
function createSeededNormal(seed: number): () => number {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
  return () => {
    const u = Math.max(1e-12, next());
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}
