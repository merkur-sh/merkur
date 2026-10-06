/**
 * Measures how far a finger actually travels while it is touching the glass.
 *
 *   bun run scripts/extract-contact-paths.ts --dataset <finger-motion-capture-dir>
 *
 * This is the number the keyboard's `tapDrift` threshold and `slideDrift` ramp
 * were both tuned against as an assumption. Every replay so far injected
 * straight-line drift at a chosen magnitude because nothing measured the real
 * thing; the touch log records one point per keystroke and cannot.
 *
 * The finger motion capture can. It carries x, y and z of both thumbs at 60 fps,
 * with z measured from the screen, so a contact is the interval around a local
 * minimum in z. The marker sits on the nail rather than the fingertip, so the
 * minimum is not zero and the absolute value is meaningless — only its shape
 * matters.
 *
 * Contact detection is self-calibrating rather than asserted. The rise above the
 * local minimum that still counts as contact is swept, and the setting is
 * pinned by requiring the resulting contact-duration median to land in the
 * 50-150 ms tap prior — the same procedure `PERF.md` used to derive
 * `ROLLOVER_HOLD_MS`, which arrived at p50 84 ms.
 *
 * Cite: Jiang, Li, Jokinen, Hirvola, Oulasvirta, Ren. "How We Type: Eye and
 * Finger Movement Strategies in Mobile Typing." CHI 2020.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One touch: where it landed, where it left, and how far it wandered. */
export interface ContactPath {
  readonly participant: number;
  readonly thumb: 1 | 2;
  readonly durationMs: number;
  /** Straight-line distance from touch-down to release, in device units. */
  readonly travel: number;
  /** Furthest the contact ever got from its landing point, in device units. */
  readonly excursion: number;
  readonly samples: number;
}

interface Frame {
  t: number;
  x: number;
  y: number;
  z: number;
}

/** Logged taps, keyed per participant so a contact can be matched to one. */
function loadTapTimes(typingLogDirectory: string): Map<number, number[]> {
  const byParticipant = new Map<number, number[]>();
  for (const file of readdirSync(join(typingLogDirectory, 'Typing_log'))) {
    if (!file.endsWith('_2.csv')) continue;
    const lines = readFileSync(join(typingLogDirectory, 'Typing_log', file), 'utf8').split('\n');
    for (let index = 1; index < lines.length; index += 1) {
      const fields = lines[index]?.split(',');
      if (fields === undefined || fields.length < 10) continue;
      const participant = Number(fields[1]);
      const trialTime = Number(fields[4]);
      if (!Number.isFinite(participant) || !Number.isFinite(trialTime)) continue;
      const list = byParticipant.get(participant) ?? [];
      list.push(trialTime);
      byParticipant.set(participant, list);
    }
  }
  for (const list of byParticipant.values()) list.sort((a, b) => a - b);
  return byParticipant;
}

/** Nearest logged tap to a contact's lowest point, or Infinity if none is near. */
function distanceToNearestTap(taps: readonly number[], time: number): number {
  let low = 0;
  let high = taps.length - 1;
  let best = Number.POSITIVE_INFINITY;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const value = taps[mid] ?? 0;
    best = Math.min(best, Math.abs(value - time));
    if (value < time) low = mid + 1;
    else high = mid - 1;
  }
  return best;
}

export function extractContactPaths(
  datasetDirectory: string,
  typingLogDirectory: string,
  rise: number,
): ContactPath[] {
  const tapTimes = loadTapTimes(typingLogDirectory);
  const directory = join(datasetDirectory, 'Finger_Motion_Capture');
  const paths: ContactPath[] = [];

  for (const file of readdirSync(directory)) {
    // Block 2 is the two-thumb condition, which is how a phone is actually held.
    if (!file.endsWith('_2.csv')) continue;
    const text = readFileSync(join(directory, file), 'utf8');
    const lines = text.split('\n');
    const participant = Number(file.split('_')[1] ?? 0);
    const left: Frame[] = [];
    const right: Frame[] = [];

    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.length === 0) continue;
      const f = line.split(',');
      if (f.length < 11) continue;
      const t = Number(f[4]);
      if (!Number.isFinite(t)) continue;
      const x1 = Number(f[5]);
      const y1 = Number(f[6]);
      const z1 = Number(f[7]);
      const x2 = Number(f[8]);
      const y2 = Number(f[9]);
      const z2 = Number(f[10]);
      if (Number.isFinite(z1)) left.push({ t, x: x1, y: y1, z: z1 });
      if (Number.isFinite(z2)) right.push({ t, x: x2, y: y2, z: z2 });
    }

    // Only contacts that coincide with a logged keystroke. Without this the
    // distribution is dominated by thumbs resting on the glass between words,
    // which are not taps and whose travel means nothing.
    const taps = tapTimes.get(participant) ?? [];
    paths.push(...contactsIn(left, participant, 1, rise, taps));
    paths.push(...contactsIn(right, participant, 2, rise, taps));
  }
  return paths;
}

/**
 * A contact is a run of frames whose height stays within `rise` of a local
 * minimum. Runs are found by walking the minima rather than thresholding
 * absolutely, because the marker offset differs per participant and per hand.
 */
const TAP_MATCH_TOLERANCE_MS = 60;
const TAP_DURATION_CAP_MS = 250;

function contactsIn(
  frames: Frame[],
  participant: number,
  thumb: 1 | 2,
  rise: number,
  taps: readonly number[],
): ContactPath[] {
  const out: ContactPath[] = [];
  if (frames.length < 3) return out;

  for (let index = 1; index < frames.length - 1; index += 1) {
    const previous = frames[index - 1];
    const current = frames[index];
    const next = frames[index + 1];
    if (previous === undefined || current === undefined || next === undefined) continue;
    if (!(current.z <= previous.z && current.z < next.z)) continue;

    // Walk outward while the finger stays down.
    let start = index;
    while (start > 0) {
      const candidate = frames[start - 1];
      if (candidate === undefined || candidate.z > current.z + rise) break;
      start -= 1;
    }
    let end = index;
    while (end < frames.length - 1) {
      const candidate = frames[end + 1];
      if (candidate === undefined || candidate.z > current.z + rise) break;
      end += 1;
    }
    const first = frames[start];
    const last = frames[end];
    if (first === undefined || last === undefined) continue;
    const durationMs = last.t - first.t;
    // A run of one frame is noise, and anything past a second is a rest, not a
    // tap; both would distort the distribution this exists to measure.
    // A tap, not a rest. `PERF.md` derived 250 ms as the point where a contact
    // has outlasted essentially every real tap — it is where `ROLLOVER_HOLD_MS`
    // sits — so it is the bound already established for this distinction, and it
    // is a duration bound being used to select which contacts to measure the
    // TRAVEL of, which are different quantities.
    if (durationMs <= 0 || durationMs > TAP_DURATION_CAP_MS) continue;
    if (distanceToNearestTap(taps, current.t) > TAP_MATCH_TOLERANCE_MS) continue;

    let excursion = 0;
    for (let f = start; f <= end; f += 1) {
      const frame = frames[f];
      if (frame === undefined) continue;
      const d = Math.hypot(frame.x - first.x, frame.y - first.y);
      if (d > excursion) excursion = d;
    }

    out.push({
      participant,
      thumb,
      durationMs,
      travel: Math.hypot(last.x - first.x, last.y - first.y),
      excursion,
      samples: end - start + 1,
    });
    index = end;
  }
  return out;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] ?? 0;
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  const index = arguments_.indexOf('--dataset');
  const dataset = index >= 0 ? arguments_[index + 1] : undefined;
  const logIndex = arguments_.indexOf('--typing-log');
  const typingLog = logIndex >= 0 ? arguments_[logIndex + 1] : undefined;
  if (dataset === undefined || typingLog === undefined) {
    throw new Error(
      'Usage: bun run scripts/extract-contact-paths.ts --dataset <mocap-dir> --typing-log <log-dir>',
    );
  }

  // The study keyboard's key pitch, from its published key centres.
  const KEY_PITCH = 131;
  // Merkur's portrait pitch, so the result transfers.
  const MERKUR_PITCH = 39.5;

  process.stdout.write(
    'Sweeping the contact threshold. The setting is chosen by the duration it\n' +
      'produces, not by the travel — so travel is measured, not fitted.\n\n' +
      'rise   contacts   duration p50/p90   travel p50/p90/p99 (key pitches)\n',
  );

  let chosen: { rise: number; paths: ContactPath[] } | undefined;
  for (const rise of [1, 2, 3, 4, 6, 8, 12]) {
    const paths = extractContactPaths(dataset, typingLog, rise);
    if (paths.length === 0) continue;
    const durations = paths.map((p) => p.durationMs).sort((a, b) => a - b);
    const travels = paths.map((p) => p.travel / KEY_PITCH).sort((a, b) => a - b);
    const p50 = quantile(durations, 0.5);
    const inPrior = p50 >= 50 && p50 <= 150;
    process.stdout.write(
      `${String(rise).padStart(4)}   ${String(paths.length).padStart(8)}   ` +
        `${p50.toFixed(0).padStart(4)}/${quantile(durations, 0.9).toFixed(0).padEnd(5)}ms   ` +
        `${quantile(travels, 0.5).toFixed(3)}/${quantile(travels, 0.9).toFixed(3)}/${quantile(travels, 0.99).toFixed(3)}` +
        `${inPrior ? '   <- inside the tap prior' : ''}\n`,
    );
    if (inPrior && chosen === undefined) chosen = { rise, paths };
  }

  if (chosen === undefined) {
    throw new Error('No contact threshold produced a plausible tap duration');
  }

  const travels = chosen.paths.map((p) => p.travel / KEY_PITCH).sort((a, b) => a - b);
  const excursions = chosen.paths.map((p) => p.excursion / KEY_PITCH).sort((a, b) => a - b);
  const samples = chosen.paths.map((p) => p.samples).sort((a, b) => a - b);
  const px = (pitches: number): string => `${(pitches * MERKUR_PITCH).toFixed(1)}px`;

  process.stdout.write(
    `\nAt rise=${chosen.rise}, ${chosen.paths.length.toLocaleString('en-US')} contacts:\n\n` +
      `contact travel, down to release\n` +
      `  p50 ${travels.length > 0 ? px(quantile(travels, 0.5)) : '-'}   ` +
      `p90 ${px(quantile(travels, 0.9))}   p99 ${px(quantile(travels, 0.99))}   ` +
      `max ${px(travels[travels.length - 1] ?? 0)}\n` +
      `furthest excursion from the landing point\n` +
      `  p50 ${px(quantile(excursions, 0.5))}   p90 ${px(quantile(excursions, 0.9))}   ` +
      `p99 ${px(quantile(excursions, 0.99))}\n` +
      `frames per contact at 60fps: p50 ${quantile(samples, 0.5)}  p90 ${quantile(samples, 0.9)}\n`,
  );

  // The question every threshold in the engine turns on.
  const TAP_DRIFT_PX = 12;
  const SLIDE_DRIFT_PX = 120;
  const overTapDrift = travels.filter((t) => t * MERKUR_PITCH > TAP_DRIFT_PX).length;
  const overSlideDrift = travels.filter((t) => t * MERKUR_PITCH > SLIDE_DRIFT_PX).length;
  process.stdout.write(
    `\nAgainst the shipped thresholds, on Merkur's geometry:\n` +
      `  past tapDrift (${TAP_DRIFT_PX}px, where the release ramp starts):   ` +
      `${((overTapDrift / travels.length) * 100).toFixed(2)}% of taps\n` +
      `  past slideDrift (${SLIDE_DRIFT_PX}px, where release decides alone): ` +
      `${((overSlideDrift / travels.length) * 100).toFixed(2)}% of taps\n`,
  );
}
