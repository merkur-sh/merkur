/**
 * Extracts a residual corpus from the HOW-WE-TYPE-MOBILE typing logs so real
 * human taps can be replayed through Merkur's decoders.
 *
 *   bun run scripts/extract-touch-residuals.ts --dataset <path-to-typing-log-dir> --out <file.json>
 *
 * The dataset is not vendored: it is CC-style non-commercial research data from
 * Aalto University and must be downloaded separately from
 * https://userinterfaces.aalto.fi/how-we-type-mobile/ and cited as
 *
 *   Jiang, Li, Jokinen, Hirvola, Oulasvirta, Ren. "How We Type: Eye and Finger
 *   Movement Strategies in Mobile Typing." CHI 2020.
 *
 * What comes out is a residual: where a tap landed relative to the intended
 * key's own mean landing point, expressed in key pitches and row pitches. That
 * form is what transfers to a different keyboard: it carries the shape of human
 * aim error without carrying the study device's absolute geometry.
 *
 * Intent labelling is the part that matters. Whenever the text so far is a valid
 * prefix of the target sentence of length p, the next keystroke is intended to
 * be target[p] whatever key it actually hit. That labels mis-aimed taps as well
 * as successful ones. Keeping only the successful taps — the obvious approach —
 * throws away exactly the population the decoder is being judged on, and halves
 * the apparent spread: measured here, sigma_x is 0.201 key pitches over correct
 * taps and 0.462 over all taps.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createInputStreamAnalyzer,
  INPUT_STREAM_SUBSTITUTION,
  type InputStreamClass,
} from '../packages/keyboard/src/input-stream';

export interface TouchResidual {
  /** Character the participant intended, from the target sentence. */
  readonly intended: string;
  /** Character actually registered by the study device's keyboard. */
  readonly actual: string;
  /** Offset from the intended key's mean landing point, in key pitches. */
  readonly dx: number;
  /** Offset from the intended key's mean landing point, in row pitches. */
  readonly dy: number;
  /** 1 = one finger, 2 = two thumbs. */
  readonly block: number;
  readonly participant: number;
  /** Milliseconds since the previous keystroke, or null at a sentence start. */
  readonly interTapMs: number | null;
  /** Target sentence id, so a prior can be trained and scored on disjoint text. */
  readonly sentence: number;
  /**
   * What the participant retyped in this tap's place, when input-stream
   * analysis of their own sentence (final text as the presented string, as a
   * keyboard in the field must run it) calls the tap a corrected substitution.
   * Null for a tap that survived, was erased for another reason, or belongs to
   * a sentence whose events do not reproduce its logged text.
   */
  readonly correctedTo: string | null;
}

/**
 * One participant's mean landing offset on one key, measured from the study
 * keyboard's published key centre after frame alignment (see the grand-mean
 * subtraction below) rather than from the population mean landing point. That
 * distinction is what makes it usable as a realistic aim bias: it is exactly
 * the quantity Merkur's offset learner faces on a phone, where the only
 * reference is the visual centre.
 */
export interface ParticipantKeyBias {
  readonly participant: number;
  /** 1 = one finger, 2 = two thumbs. */
  readonly block: number;
  /** Character on the key, same naming as `TouchResidual.intended`. */
  readonly key: string;
  /** Mean landing minus published centre, in key pitches. */
  readonly dx: number;
  /** Mean landing minus published centre, in row pitches. */
  readonly dy: number;
  readonly count: number;
}

export interface ResidualCorpus {
  readonly source: string;
  readonly citation: string;
  readonly keyPitch: number;
  readonly rowPitch: number;
  readonly residuals: readonly TouchResidual[];
  readonly biases: readonly ParticipantKeyBias[];
}

const CITATION =
  'Jiang, Li, Jokinen, Hirvola, Oulasvirta, Ren. How We Type: Eye and Finger Movement Strategies in Mobile Typing. CHI 2020.';

export function extractResiduals(datasetDirectory: string): ResidualCorpus {
  const geometryLines = readFileSync(join(datasetDirectory, 'Keyboard_coordinates.csv'), 'utf8')
    .trim()
    .split('\n');
  const keyNames = (geometryLines[0] ?? '').split(',').slice(1);
  const keyXs = (geometryLines[1] ?? '').split(',').slice(1).map(Number);
  const keyYs = (geometryLines[2] ?? '').split(',').slice(1).map(Number);
  const centre = new Map<string, { x: number; y: number }>();
  for (let index = 0; index < keyNames.length; index += 1) {
    const raw = keyNames[index] ?? '';
    const name = raw === '' ? ' ' : raw;
    const x = keyXs[index];
    const y = keyYs[index];
    if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
      centre.set(name, { x, y });
    }
  }
  // Pitches come from the published key centres rather than being assumed.
  const uniqueX = [...new Set([...centre.values()].map((k) => k.x))].sort((a, b) => a - b);
  const uniqueY = [...new Set([...centre.values()].map((k) => k.y))].sort((a, b) => a - b);
  const keyPitch = medianGap(uniqueX);
  const rowPitch = medianGap(uniqueY);

  const sentences = new Map<number, string>();
  for (const line of readFileSync(join(datasetDirectory, 'Sentences.csv'), 'utf8')
    .trim()
    .split('\n')
    .slice(1)) {
    const comma = line.indexOf(',');
    sentences.set(Number(line.slice(0, comma)), line.slice(comma + 1));
  }

  interface Labelled {
    intended: string;
    actual: string;
    touchX: number;
    touchY: number;
    block: number;
    participant: number;
    interTapMs: number | null;
    sentence: number;
    correctedTo: string | null;
  }
  const labelled: Labelled[] = [];
  const corrections = createCorrectionTracker(centre, labelled);

  for (const file of readdirSync(join(datasetDirectory, 'Typing_log'))) {
    if (!file.endsWith('.csv')) continue;
    const lines = readFileSync(join(datasetDirectory, 'Typing_log', file), 'utf8').split('\n');
    let previousMessage = '';
    let previousTrialTime: number | null = null;
    let previousSentence: number | null = null;

    for (const line of lines.slice(1)) {
      if (line.trim() === '') continue;
      // `message` may contain commas, so the fixed head and tail fields are
      // taken by position and everything between them is the message.
      const fields = line.split(',');
      if (fields.length < 10) continue;
      const participant = Number(fields[1]);
      const block = Number(fields[2]);
      const sentenceNumber = Number(fields[3]);
      const trialTime = Number(fields[4]);
      const event = fields[5] ?? '';
      const touchY = Number(fields[fields.length - 1]);
      const touchX = Number(fields[fields.length - 2]);
      const message = fields.slice(7, fields.length - 2).join(',');
      const target = sentences.get(sentenceNumber);

      if (sentenceNumber !== previousSentence) {
        corrections.close(previousMessage);
        previousMessage = '';
        previousTrialTime = null;
        previousSentence = sentenceNumber;
      }

      let labelledTap = -1;
      if (
        target !== undefined &&
        Number.isFinite(touchX) &&
        Number.isFinite(touchY) &&
        event.length === 1 &&
        centre.has(event) &&
        target.startsWith(previousMessage) &&
        previousMessage.length < target.length &&
        message.length === previousMessage.length + 1 &&
        message.startsWith(previousMessage)
      ) {
        const intended = target[previousMessage.length] ?? '';
        if (centre.has(intended)) {
          labelledTap = labelled.length;
          labelled.push({
            intended,
            actual: event,
            touchX,
            touchY,
            block,
            participant,
            interTapMs: previousTrialTime === null ? null : trialTime - previousTrialTime,
            sentence: sentenceNumber,
            correctedTo: null,
          });
        }
      }
      corrections.push(event, labelledTap);

      previousMessage = message;
      previousTrialTime = trialTime;
    }
    corrections.close(previousMessage);
  }

  // The mean landing point per key absorbs the study device's coordinate frame
  // and any per-key aim bias, leaving pure scatter that transfers to Merkur.
  const sums = new Map<string, { x: number; y: number; n: number }>();
  for (const tap of labelled) {
    const entry = sums.get(tap.intended) ?? { x: 0, y: 0, n: 0 };
    entry.x += tap.touchX;
    entry.y += tap.touchY;
    entry.n += 1;
    sums.set(tap.intended, entry);
  }

  const residuals: TouchResidual[] = [];
  for (const tap of labelled) {
    const entry = sums.get(tap.intended);
    if (entry === undefined || entry.n < 20) continue;
    residuals.push({
      intended: tap.intended,
      actual: tap.actual,
      dx: (tap.touchX - entry.x / entry.n) / keyPitch,
      dy: (tap.touchY - entry.y / entry.n) / rowPitch,
      block: tap.block,
      participant: tap.participant,
      interTapMs: tap.interTapMs,
      sentence: tap.sentence,
      correctedTo: tap.correctedTo,
    });
  }

  // Per-participant aim biases against the published centres, in pitch units.
  // Grouped by block as well: one-finger and two-thumb grips are different
  // postures with different biases, exactly like Merkur's orientation split.
  // Nested maps rather than a composite string key, because a key's name can be
  // any character — including the comma a composite would split on.
  //
  // The touch log and the published centres disagree by a constant translation
  // (about -490, -190 px: a tap on `v` at (731, 2220) against a centre of
  // (1221, 2415)), which is digitizer frame, not aim. The grand mean over every
  // labelled tap absorbs it — at the cost of also absorbing the population's
  // average aim offset, which a calibrated digitizer keeps near zero anyway.
  let grandX = 0;
  let grandY = 0;
  let grandN = 0;
  for (const tap of labelled) {
    const keyCentre = centre.get(tap.intended);
    if (keyCentre === undefined) continue;
    grandX += tap.touchX - keyCentre.x;
    grandY += tap.touchY - keyCentre.y;
    grandN += 1;
  }
  const frameX = grandN === 0 ? 0 : grandX / grandN;
  const frameY = grandN === 0 ? 0 : grandY / grandN;

  const biasSums = new Map<number, Map<number, Map<string, { x: number; y: number; n: number }>>>();
  for (const tap of labelled) {
    const keyCentre = centre.get(tap.intended);
    if (keyCentre === undefined) continue;
    let byBlock = biasSums.get(tap.participant);
    if (byBlock === undefined) {
      byBlock = new Map();
      biasSums.set(tap.participant, byBlock);
    }
    let byKey = byBlock.get(tap.block);
    if (byKey === undefined) {
      byKey = new Map();
      byBlock.set(tap.block, byKey);
    }
    let entry = byKey.get(tap.intended);
    if (entry === undefined) {
      entry = { x: 0, y: 0, n: 0 };
      byKey.set(tap.intended, entry);
    }
    entry.x += tap.touchX - keyCentre.x - frameX;
    entry.y += tap.touchY - keyCentre.y - frameY;
    entry.n += 1;
  }
  const biases: ParticipantKeyBias[] = [];
  for (const [participant, byBlock] of biasSums) {
    for (const [blockNumber, byKey] of byBlock) {
      for (const [key, entry] of byKey) {
        biases.push({
          participant,
          block: blockNumber,
          key,
          dx: entry.x / entry.n / keyPitch,
          dy: entry.y / entry.n / rowPitch,
          count: entry.n,
        });
      }
    }
  }

  return {
    source: 'HOW-WE-TYPE-MOBILE typing log',
    citation: CITATION,
    keyPitch,
    rowPitch,
    residuals,
    biases,
  };
}

/**
 * One sentence's input stream at a time, Backspace (`B`) as null, analysed when
 * the sentence ends: a tap the analysis calls a corrected substitution gets
 * `correctedTo`. `tap` is the labelled tap an event produced, or -1 for one
 * typed off a wrong prefix.
 */
function createCorrectionTracker(
  keys: ReadonlyMap<string, unknown>,
  labelled: readonly { correctedTo: string | null }[],
): { push(event: string, tap: number): void; close(finalMessage: string): void } {
  const analyzer = createInputStreamAnalyzer();
  const stream: (string | null)[] = [];
  const taps: number[] = [];
  const label = (index: number, kind: InputStreamClass, intended: string | null): void => {
    const tap = labelled[taps[index] ?? -1];
    if (tap !== undefined && kind === INPUT_STREAM_SUBSTITUTION) tap.correctedTo = intended;
  };
  return {
    push(event, tap) {
      if (event === 'B') {
        stream.push(null);
        taps.push(-1);
      } else if (event.length === 1 && keys.has(event)) {
        stream.push(event);
        taps.push(tap);
      }
    },
    // Some sentences' events do not reproduce their logged text (the log drops
    // events); their streams cannot be analysed and label nothing.
    close(finalMessage) {
      let text = '';
      for (const symbol of stream) text = symbol === null ? text.slice(0, -1) : text + symbol;
      if (text === finalMessage) analyzer.analyze(stream, stream.length, label);
      stream.length = 0;
      taps.length = 0;
    },
  };
}

function medianGap(sorted: readonly number[]): number {
  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = (sorted[index] ?? 0) - (sorted[index - 1] ?? 0);
    if (gap > 1) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? 1;
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  const datasetIndex = arguments_.indexOf('--dataset');
  const outIndex = arguments_.indexOf('--out');
  const dataset = datasetIndex >= 0 ? arguments_[datasetIndex + 1] : undefined;
  const out = outIndex >= 0 ? arguments_[outIndex + 1] : undefined;
  if (dataset === undefined || out === undefined) {
    throw new Error(
      'Usage: bun run scripts/extract-touch-residuals.ts --dataset <typing-log-dir> --out <file.json>',
    );
  }
  const corpus = extractResiduals(dataset);
  writeFileSync(out, `${JSON.stringify(corpus)}\n`);
  const wrong = corpus.residuals.filter((r) => r.intended !== r.actual).length;
  const corrected = corpus.residuals.filter((r) => r.correctedTo !== null).length;
  process.stdout.write(
    `Wrote ${corpus.residuals.length.toLocaleString('en-US')} residuals to ${out}\n` +
      `  key pitch ${corpus.keyPitch}, row pitch ${corpus.rowPitch}\n` +
      `  ${wrong.toLocaleString('en-US')} taps (${((wrong / corpus.residuals.length) * 100).toFixed(2)}%) were mis-registered by the study device's own keyboard\n` +
      `  ${corrected.toLocaleString('en-US')} taps were later corrected by the participant (input-stream analysis)\n` +
      `  ${corpus.biases.length.toLocaleString('en-US')} participant/key aim biases\n`,
  );
}
