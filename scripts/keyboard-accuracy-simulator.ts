import { createKeyboardEngine, ROLLOVER_HOLD_MS } from '../packages/keyboard/src/engine';
import {
  CUPERTINO_LANDSCAPE_PROFILE,
  CUPERTINO_PORTRAIT_PROFILE,
  hitTestKeyboard,
  solveKeyboardGeometry,
} from '../packages/keyboard/src/geometry';
import { TERMINAL_US_LAYOUT } from '../packages/keyboard/src/layouts/terminal-us';
import type {
  KeyboardGeometryProfile,
  ResolvedKeyboardGeometry,
  ResolvedKeyboardKey,
} from '../packages/keyboard/src/types';

export const KEYBOARD_GESTURE_FAMILIES = [
  'fast-tap',
  'gaussian',
  'thumb-roll',
  'heavy-tail',
  'boundary',
  'release-slip',
  'correction',
  'low-bottom-row',
  'rollover-nested',
  'rollover-parked',
] as const;

/** Families that wrap the gesture in a second contact and score commit order. */
const ROLLOVER_FAMILIES: ReadonlySet<string> = new Set(['rollover-nested', 'rollover-parked']);

/**
 * How long the earlier contact had been down when the later one lifted, in
 * milliseconds, as p0..p100 deciles.
 *
 * Measured from OptiTrack finger motion capture of two-thumb typing (Jiang et
 * al., CHI 2020; 30 participants). Contact intervals were recovered from the
 * per-thumb z trace anchored at each logged tap, validated against a resulting
 * contact-duration median of 84ms. Of 5,682 consecutive cross-thumb tap pairs,
 * 53 (0.93%) were fully nested; those 53 produced this distribution.
 *
 * The shape is the point: nesting on a touchscreen is overwhelmingly a resting
 * thumb rather than a fast rollover, so most of these exceed the hold window and
 * exercise the yield path. Roughly a third fall inside it and are buffered.
 */
const MEASURED_ROLLOVER_HOLDS_MS: readonly number[] = [
  84, 183, 200, 233, 267, 333, 400, 467, 534, 883, 1551,
];
const BUFFERED_ROLLOVER_HOLDS_MS = MEASURED_ROLLOVER_HOLDS_MS.filter(
  (hold) => hold < ROLLOVER_HOLD_MS,
);
const YIELDED_ROLLOVER_HOLDS_MS = MEASURED_ROLLOVER_HOLDS_MS.filter(
  (hold) => hold >= ROLLOVER_HOLD_MS,
);
if (BUFFERED_ROLLOVER_HOLDS_MS.length === 0 || YIELDED_ROLLOVER_HOLDS_MS.length === 0) {
  throw new Error(
    'Keyboard rollover families need measured holds on both sides of ROLLOVER_HOLD_MS',
  );
}

export type KeyboardGestureFamily = (typeof KEYBOARD_GESTURE_FAMILIES)[number];
export type KeyboardSimulationOrientation = 'portrait' | 'landscape';

export interface KeyboardAccuracySimulationOptions {
  readonly seed?: number;
  readonly samplesPerKey?: number;
  readonly width?: number;
  readonly devicePixelRatio?: number;
  readonly orientations?: readonly KeyboardSimulationOrientation[];
  readonly layerIds?: readonly string[];
  readonly families?: readonly KeyboardGestureFamily[];
  readonly tapDrift?: number;
  readonly releaseWeight?: number;
}

export interface KeyboardAccuracyResult {
  readonly samples: number;
  readonly engineCorrect: number;
  readonly hardAtlasCorrect: number;
  readonly engineAccuracy: number;
  readonly hardAtlasAccuracy: number;
  readonly engineDelta: number;
  readonly rejected: number;
}

export interface KeyboardAccuracyBreakdown extends KeyboardAccuracyResult {
  readonly name: string;
}

export interface KeyboardConfusion {
  readonly intended: string;
  readonly predicted: string;
  readonly count: number;
}

export interface KeyboardAccuracySimulationReport extends KeyboardAccuracyResult {
  readonly seed: number;
  readonly samplesPerKey: number;
  readonly width: number;
  readonly devicePixelRatio: number;
  readonly tapDrift: number;
  readonly releaseWeight: number;
  readonly releaseKeyCount: number;
  readonly byFamily: readonly KeyboardAccuracyBreakdown[];
  readonly byScenario: readonly KeyboardAccuracyBreakdown[];
  readonly byKey: readonly KeyboardAccuracyBreakdown[];
  readonly confusions: readonly KeyboardConfusion[];
  readonly checksum: number;
}

interface MutableResult {
  samples: number;
  engineCorrect: number;
  hardAtlasCorrect: number;
  rejected: number;
}

interface GesturePoint {
  readonly x: number;
  readonly y: number;
  readonly time: number;
}

interface Gesture {
  readonly points: readonly GesturePoint[];
}

interface RandomSource {
  next(): number;
  normal(): number;
}

const DEFAULT_SEED = 0x4d45_5243;
const DEFAULT_SAMPLES_PER_KEY = 100;
const DEFAULT_WIDTH = 402;
const DEFAULT_DPR = 3;
const FNV_OFFSET_BASIS = 0x811c_9dc5;
const NULL_PREDICTION = '<none>';
const INSIDE_EDGE_EPSILON = 1e-6;

export function runKeyboardAccuracySimulation(
  options: KeyboardAccuracySimulationOptions = {},
): KeyboardAccuracySimulationReport {
  const seed = validatePositiveInteger('seed', options.seed ?? DEFAULT_SEED);
  const samplesPerKey = validatePositiveInteger(
    'samplesPerKey',
    options.samplesPerKey ?? DEFAULT_SAMPLES_PER_KEY,
  );
  const width = validatePositiveNumber('width', options.width ?? DEFAULT_WIDTH);
  const devicePixelRatio = validatePositiveNumber(
    'devicePixelRatio',
    options.devicePixelRatio ?? DEFAULT_DPR,
  );
  const tapDrift = validateNonNegativeNumber(
    'tapDrift',
    options.tapDrift ?? CUPERTINO_PORTRAIT_PROFILE.tapDrift,
  );
  const releaseWeight = validateUnitInterval(
    'releaseWeight',
    options.releaseWeight ?? CUPERTINO_PORTRAIT_PROFILE.releaseWeight,
  );
  const orientations = validateSelection(
    'orientations',
    options.orientations ?? (['portrait', 'landscape'] as const),
  );
  const layerIds = validateSelection(
    'layerIds',
    options.layerIds ?? Object.keys(TERMINAL_US_LAYOUT.layers),
  );
  const families = validateSelection('families', options.families ?? KEYBOARD_GESTURE_FAMILIES);
  const random = createRandomSource(seed);
  const total = createMutableResult();
  const familyResults = new Map<string, MutableResult>();
  const scenarioResults = new Map<string, MutableResult>();
  const keyResults = new Map<string, MutableResult>();
  const confusions = new Map<string, number>();
  let checksum = FNV_OFFSET_BASIS;
  let pointerId = 1;
  // Offset so even the longest measured blocker lead stays on a positive timeline.
  let clock = MEASURED_ROLLOVER_HOLDS_MS[MEASURED_ROLLOVER_HOLDS_MS.length - 1] ?? 0;
  let releaseKeyCount = 0;

  for (const orientation of orientations) {
    const profile = {
      ...profileForOrientation(orientation),
      tapDrift,
      releaseWeight,
    };
    for (const layerId of layerIds) {
      if (TERMINAL_US_LAYOUT.layers[layerId] === undefined) {
        throw new Error(`Unknown keyboard simulation layer: ${layerId}`);
      }
      const geometry = solveKeyboardGeometry(
        TERMINAL_US_LAYOUT,
        layerId,
        width,
        devicePixelRatio,
        profile,
      );
      const targetKeys = geometry.keys.filter(isReleaseTarget);
      releaseKeyCount += targetKeys.length;
      const neighborIndices = buildNeighborIndices(geometry, targetKeys);
      const blockerIndices = buildBlockerIndices(targetKeys);
      const scenarioName = `${orientation}/${layerId}`;
      const scenarioResult = resultFor(scenarioResults, scenarioName);
      let committedIndex = -1;
      let commitCount = 0;
      const commitOrder = new Int32Array(4);
      const engine = createKeyboardEngine({
        geometry,
        profile,
        onRawCommit(key) {
          committedIndex = key.index;
          if (commitCount < commitOrder.length) commitOrder[commitCount] = key.index;
          commitCount += 1;
        },
        timers: {
          set: () => 0,
          clear: () => {},
          now: () => clock,
        },
      });

      for (const target of targetKeys) {
        const keyName = `${scenarioName}/${target.definition.id}`;
        const keyResult = resultFor(keyResults, keyName);
        const neighborIndex = neighborIndices.get(target.index);
        const neighbor =
          neighborIndex === undefined ? target : (geometry.keys[neighborIndex] ?? target);

        for (const family of families) {
          const familyResult = resultFor(familyResults, family);
          for (let sampleIndex = 0; sampleIndex < samplesPerKey; sampleIndex += 1) {
            const gesture = generateGesture(family, geometry, target, neighbor, random);
            committedIndex = -1;
            commitCount = 0;
            const first = gesture.points[0];
            const last = gesture.points.at(-1);
            if (first === undefined || last === undefined) {
              throw new Error('Keyboard gesture generator returned an empty gesture');
            }
            const rollover = ROLLOVER_FAMILIES.has(family);
            const blockerIndex = rollover ? (blockerIndices.get(target.index) ?? -1) : -1;
            const blocker = blockerIndex < 0 ? undefined : geometry.keys[blockerIndex];
            const blockerPointerId = pointerId + 1;
            let blockerYields = false;
            if (blocker !== undefined) {
              // Draw a hold from the measured distribution, then work backwards to
              // the press time: hold is counted to the inner contact's release.
              const holds =
                family === 'rollover-parked'
                  ? YIELDED_ROLLOVER_HOLDS_MS
                  : BUFFERED_ROLLOVER_HOLDS_MS;
              const targetHold =
                holds[Math.min(holds.length - 1, Math.floor(random.next() * holds.length))] ?? 0;
              const lead = Math.max(1, targetHold - last.time);
              // Clamping the lead can push a short gesture past the window, so the
              // expected order follows the hold actually realized, not the family.
              blockerYields = last.time + lead >= ROLLOVER_HOLD_MS;
              engine.beginPointerAt(
                blockerPointerId,
                centerX(blocker),
                centerY(blocker),
                clock + first.time - lead,
              );
            }
            const began = engine.beginPointerAt(pointerId, first.x, first.y, clock + first.time);
            if (began) {
              for (let pointIndex = 1; pointIndex < gesture.points.length - 1; pointIndex += 1) {
                const point = gesture.points[pointIndex];
                if (point !== undefined) {
                  engine.movePointerAt(pointerId, point.x, point.y, clock + point.time);
                }
              }
              engine.endPointerAt(pointerId, last.x, last.y, clock + last.time);
            }
            if (blocker !== undefined) {
              engine.endPointerAt(
                blockerPointerId,
                centerX(blocker),
                centerY(blocker),
                clock + last.time + 2,
              );
            }
            const hardAtlasIndex = hitTestKeyboard(geometry, last.x, last.y) ?? -1;
            // A contact that has outlasted the hold window yields its place, so the
            // target leads; one still inside the window pressed first and must lead.
            const targetSlot = blockerYields ? 0 : 1;
            if (rollover) {
              committedIndex = blocker === undefined ? -1 : (commitOrder[targetSlot] ?? -1);
            }
            const engineCorrect = rollover
              ? blocker !== undefined &&
                commitCount === 2 &&
                commitOrder[targetSlot] === target.index &&
                commitOrder[1 - targetSlot] === blocker.index
              : committedIndex === target.index;
            const hardAtlasCorrect = hardAtlasIndex === target.index;
            const rejected = !began || committedIndex < 0;
            record(total, engineCorrect, hardAtlasCorrect, rejected);
            record(familyResult, engineCorrect, hardAtlasCorrect, rejected);
            record(scenarioResult, engineCorrect, hardAtlasCorrect, rejected);
            record(keyResult, engineCorrect, hardAtlasCorrect, rejected);
            if (!engineCorrect) {
              const predicted = geometry.keys[committedIndex]?.definition.id ?? NULL_PREDICTION;
              const confusionKey = `${target.definition.id}\u0000${predicted}`;
              confusions.set(confusionKey, (confusions.get(confusionKey) ?? 0) + 1);
            }
            checksum = hashU32(checksum, target.index);
            checksum = hashU32(checksum, committedIndex);
            checksum = hashU32(checksum, hardAtlasIndex);
            pointerId += 2;
            clock += last.time + 8;
          }
        }
      }
      engine.destroy();
    }
  }

  return {
    seed,
    samplesPerKey,
    width,
    devicePixelRatio,
    tapDrift,
    releaseWeight,
    releaseKeyCount,
    ...finish(total),
    byFamily: finishMap(familyResults),
    byScenario: finishMap(scenarioResults),
    byKey: finishMap(keyResults),
    confusions: [...confusions]
      .map(([pair, count]) => {
        const [intended = '', predicted = ''] = pair.split('\u0000');
        return { intended, predicted, count };
      })
      .sort(
        (left, right) => right.count - left.count || left.intended.localeCompare(right.intended),
      ),
    checksum,
  };
}

function isReleaseTarget(key: ResolvedKeyboardKey): boolean {
  return key.definition.kind === 'input' && key.definition.activation !== 'press';
}

function buildNeighborIndices(
  geometry: ResolvedKeyboardGeometry,
  targetKeys: readonly ResolvedKeyboardKey[],
): ReadonlyMap<number, number> {
  const releaseIndices = new Set(targetKeys.map((key) => key.index));
  const neighbors = new Map<number, number>();
  for (const target of targetKeys) {
    let bestIndex = -1;
    let bestPenalty = Number.POSITIVE_INFINITY;
    const targetX = centerX(target);
    const targetY = centerY(target);
    for (const candidate of geometry.keys) {
      if (candidate.index === target.index || !releaseIndices.has(candidate.index)) continue;
      if (!isAdjacent(geometry, target, candidate)) continue;
      const dx = centerX(candidate) - targetX;
      const dy = centerY(candidate) - targetY;
      const rowPenalty = candidate.row === target.row ? 0 : geometry.height * geometry.height;
      const penalty = dx * dx + dy * dy + rowPenalty;
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestIndex = candidate.index;
      }
    }
    if (bestIndex >= 0) neighbors.set(target.index, bestIndex);
  }
  return neighbors;
}

/**
 * Confusion gestures are only meaningful between keys that actually touch. Keys
 * excluded from the release-target set (press-activated arrows, modifiers) still
 * occupy the surface, so the nearest scoreable key can sit two keys away with an
 * unrelated key between them. Sampling the ray between the centers rejects those
 * pairs: an intervening key means the generated release point would land on a
 * third key while the ground truth still names the target.
 */
function isAdjacent(
  geometry: ResolvedKeyboardGeometry,
  target: ResolvedKeyboardKey,
  candidate: ResolvedKeyboardKey,
): boolean {
  const fromX = centerX(target);
  const fromY = centerY(target);
  const deltaX = centerX(candidate) - fromX;
  const deltaY = centerY(candidate) - fromY;
  const steps = Math.max(2, Math.ceil(Math.hypot(deltaX, deltaY)));
  for (let step = 1; step < steps; step += 1) {
    const progress = step / steps;
    const index = hitTestKeyboard(geometry, fromX + deltaX * progress, fromY + deltaY * progress);
    if (index !== null && index !== target.index && index !== candidate.index) return false;
  }
  return true;
}

/**
 * The rollover blocker is the farthest release target, so its own contact can
 * never enter the target's candidate set and perturb the classification being
 * measured. Only the commit order is under test.
 */
function buildBlockerIndices(
  targetKeys: readonly ResolvedKeyboardKey[],
): ReadonlyMap<number, number> {
  const blockers = new Map<number, number>();
  for (const target of targetKeys) {
    let bestIndex = -1;
    let bestDistance = -1;
    const targetX = centerX(target);
    const targetY = centerY(target);
    for (const candidate of targetKeys) {
      if (candidate.index === target.index) continue;
      const dx = centerX(candidate) - targetX;
      const dy = centerY(candidate) - targetY;
      const distance = dx * dx + dy * dy;
      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = candidate.index;
      }
    }
    if (bestIndex >= 0) blockers.set(target.index, bestIndex);
  }
  return blockers;
}

function generateGesture(
  family: KeyboardGestureFamily,
  geometry: ResolvedKeyboardGeometry,
  target: ResolvedKeyboardKey,
  neighbor: ResolvedKeyboardKey,
  random: RandomSource,
): Gesture {
  const targetX = centerX(target);
  const targetY = centerY(target);
  const width = target.rect.width;
  const height = target.rect.height;
  let downX = targetX;
  let downY = targetY;
  let releaseX = targetX;
  let releaseY = targetY;
  let curveX = 0;
  let curveY = 0;
  let duration = 42 + random.next() * 42;

  switch (family) {
    case 'fast-tap': {
      const errorX = random.normal() * width * 0.075;
      const errorY = random.normal() * height * 0.07;
      downX += errorX + random.normal() * width * 0.018;
      downY += errorY + random.normal() * height * 0.018;
      releaseX += errorX;
      releaseY += errorY;
      duration = 28 + random.next() * 30;
      break;
    }
    case 'gaussian': {
      const errorX = random.normal() * width * 0.18;
      const errorY = random.normal() * height * 0.14;
      downX += errorX + random.normal() * width * 0.04;
      downY += errorY + random.normal() * height * 0.035;
      releaseX += errorX + random.normal() * width * 0.035;
      releaseY += errorY + random.normal() * height * 0.03;
      curveX = random.normal() * width * 0.025;
      curveY = random.normal() * height * 0.025;
      break;
    }
    case 'thumb-roll': {
      const hand = targetX < geometry.width / 2 ? -1 : 1;
      const inward = -hand;
      const errorX = random.normal() * width * 0.13 + inward * width * 0.045;
      const errorY = random.normal() * height * 0.12 + height * 0.055;
      downX += errorX - inward * width * 0.09;
      downY += errorY - height * 0.09;
      releaseX += errorX + inward * width * 0.045;
      releaseY += errorY + height * 0.035;
      curveX = inward * width * (0.08 + random.next() * 0.08);
      curveY = -height * (0.035 + random.next() * 0.05);
      duration = 52 + random.next() * 58;
      break;
    }
    case 'heavy-tail': {
      const scale = inverseStudentScale(random, 3);
      const outlier = random.next() < 0.035 ? 2.4 : 1;
      const errorX = random.normal() * scale * width * 0.105 * outlier;
      const errorY = random.normal() * scale * height * 0.09 * outlier;
      downX += errorX + random.normal() * width * 0.035;
      downY += errorY + random.normal() * height * 0.03;
      releaseX += errorX + random.normal() * width * 0.045;
      releaseY += errorY + random.normal() * height * 0.04;
      curveX = random.normal() * width * 0.05;
      curveY = random.normal() * height * 0.05;
      break;
    }
    case 'boundary': {
      const neighborX = centerX(neighbor);
      const neighborY = centerY(neighbor);
      const vectorX = neighborX - targetX;
      const vectorY = neighborY - targetY;
      const length = Math.max(1, Math.hypot(vectorX, vectorY));
      const unitX = vectorX / length;
      const unitY = vectorY / length;
      const perpendicularX = -unitY;
      const perpendicularY = unitX;
      // The midpoint between two centers only lies on the shared edge when both
      // keys are the same size. Bisecting for the last point that still belongs
      // to the target keeps the release inside the intended key for the wide
      // keys (space, enter) that anchor the bottom row.
      const boundary = findTargetBoundary(geometry, target, neighbor);
      const targetMargin = Math.min(width, height) * (0.015 + random.next() * 0.075);
      const tangentJitter = random.normal() * Math.min(width, height) * 0.055;
      releaseX = boundary.x - unitX * targetMargin + perpendicularX * tangentJitter;
      releaseY = boundary.y - unitY * targetMargin + perpendicularY * tangentJitter;
      downX = targetX + (releaseX - targetX) * 0.42;
      downY = targetY + (releaseY - targetY) * 0.42;
      curveX = perpendicularX * tangentJitter * 0.5;
      curveY = perpendicularY * tangentJitter * 0.5;
      break;
    }
    case 'release-slip': {
      const neighborX = centerX(neighbor);
      const neighborY = centerY(neighbor);
      const vectorX = neighborX - targetX;
      const vectorY = neighborY - targetY;
      const length = Math.max(1, Math.hypot(vectorX, vectorY));
      const unitX = vectorX / length;
      const unitY = vectorY / length;
      const perpendicularX = -unitY;
      const perpendicularY = unitX;
      const boundary = findTargetBoundary(geometry, target, neighbor);
      const tangentJitter = random.normal() * Math.min(width, height) * 0.035;
      const acquisitionInset = 3 + random.next() * 3;
      const releaseOvershoot = 1 + random.next() * 5;
      downX = boundary.x - unitX * acquisitionInset + perpendicularX * tangentJitter;
      downY = boundary.y - unitY * acquisitionInset + perpendicularY * tangentJitter;
      releaseX = boundary.x + unitX * releaseOvershoot + perpendicularX * tangentJitter;
      releaseY = boundary.y + unitY * releaseOvershoot + perpendicularY * tangentJitter;
      curveX = -unitX * (2 + random.next() * 2);
      curveY = -unitY * (2 + random.next() * 2);
      duration = 38 + random.next() * 42;
      break;
    }
    case 'correction': {
      const neighborX = centerX(neighbor);
      const neighborY = centerY(neighbor);
      downX = targetX + (neighborX - targetX) * (0.52 + random.next() * 0.12);
      downY = targetY + (neighborY - targetY) * (0.52 + random.next() * 0.12);
      releaseX = targetX + random.normal() * width * 0.065;
      releaseY = targetY + random.normal() * height * 0.06;
      const vectorX = neighborX - targetX;
      const vectorY = neighborY - targetY;
      const length = Math.max(1, Math.hypot(vectorX, vectorY));
      curveX = (-vectorY / length) * height * (random.next() - 0.5) * 0.24;
      curveY = (vectorX / length) * height * (random.next() - 0.5) * 0.24;
      duration = 70 + random.next() * 70;
      break;
    }
    case 'low-bottom-row': {
      const lastRow = geometry.rows.length - 1;
      if (target.row === lastRow && geometry.hitHeight > geometry.height) {
        const errorX = random.normal() * width * 0.11;
        downX += errorX;
        releaseX += errorX + random.normal() * width * 0.025;
        downY = geometry.height + random.next() * (geometry.hitHeight - geometry.height) * 0.92;
        releaseY = downY + random.normal() * height * 0.035;
        curveX = random.normal() * width * 0.02;
        curveY = random.normal() * height * 0.02;
      } else {
        const errorX = random.normal() * width * 0.075;
        const errorY = random.normal() * height * 0.07;
        downX += errorX;
        downY += errorY;
        releaseX += errorX + random.normal() * width * 0.02;
        releaseY += errorY + random.normal() * height * 0.02;
      }
      break;
    }
  }

  downX = clamp(downX, 0, geometry.width - INSIDE_EDGE_EPSILON);
  downY = clamp(downY, 0, geometry.hitHeight - INSIDE_EDGE_EPSILON);
  releaseX = clamp(releaseX, 0, geometry.width - INSIDE_EDGE_EPSILON);
  releaseY = clamp(releaseY, 0, geometry.hitHeight - INSIDE_EDGE_EPSILON);
  const points: GesturePoint[] = [];
  const pointCount = family === 'fast-tap' ? 3 : 6;
  for (let index = 0; index < pointCount; index += 1) {
    const progress = index / (pointCount - 1);
    const inverse = 1 - progress;
    const arc = 4 * progress * inverse;
    points.push({
      x: clamp(
        downX * inverse + releaseX * progress + curveX * arc,
        0,
        geometry.width - INSIDE_EDGE_EPSILON,
      ),
      y: clamp(
        downY * inverse + releaseY * progress + curveY * arc,
        0,
        geometry.hitHeight - INSIDE_EDGE_EPSILON,
      ),
      time: duration * progress,
    });
  }
  return { points };
}

function createRandomSource(seed: number): RandomSource {
  let state = seed >>> 0;
  let spare: number | undefined;
  return {
    next(): number {
      state = (state + 0x6d2b_79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    },
    normal(): number {
      if (spare !== undefined) {
        const value = spare;
        spare = undefined;
        return value;
      }
      const u = Math.max(Number.EPSILON, this.next());
      const v = this.next();
      const magnitude = Math.sqrt(-2 * Math.log(u));
      spare = magnitude * Math.sin(2 * Math.PI * v);
      return magnitude * Math.cos(2 * Math.PI * v);
    },
  };
}

function findTargetBoundary(
  geometry: ResolvedKeyboardGeometry,
  target: ResolvedKeyboardKey,
  neighbor: ResolvedKeyboardKey,
): { readonly x: number; readonly y: number } {
  const targetX = centerX(target);
  const targetY = centerY(target);
  const neighborX = centerX(neighbor);
  const neighborY = centerY(neighbor);
  let targetSide = 0;
  let otherSide = 1;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const progress = (targetSide + otherSide) * 0.5;
    const x = targetX + (neighborX - targetX) * progress;
    const y = targetY + (neighborY - targetY) * progress;
    if (hitTestKeyboard(geometry, x, y) === target.index) targetSide = progress;
    else otherSide = progress;
  }
  const progress = (targetSide + otherSide) * 0.5;
  return {
    x: targetX + (neighborX - targetX) * progress,
    y: targetY + (neighborY - targetY) * progress,
  };
}

function inverseStudentScale(random: RandomSource, degreesOfFreedom: number): number {
  let chiSquare = 0;
  for (let index = 0; index < degreesOfFreedom; index += 1) {
    const sample = random.normal();
    chiSquare += sample * sample;
  }
  return Math.sqrt(degreesOfFreedom / Math.max(0.05, chiSquare));
}

function profileForOrientation(
  orientation: KeyboardSimulationOrientation,
): KeyboardGeometryProfile {
  return orientation === 'portrait' ? CUPERTINO_PORTRAIT_PROFILE : CUPERTINO_LANDSCAPE_PROFILE;
}

function centerX(key: ResolvedKeyboardKey): number {
  return key.rect.x + key.rect.width / 2;
}

function centerY(key: ResolvedKeyboardKey): number {
  return key.rect.y + key.rect.height / 2;
}

function createMutableResult(): MutableResult {
  return { samples: 0, engineCorrect: 0, hardAtlasCorrect: 0, rejected: 0 };
}

function resultFor(results: Map<string, MutableResult>, name: string): MutableResult {
  let result = results.get(name);
  if (result === undefined) {
    result = createMutableResult();
    results.set(name, result);
  }
  return result;
}

function record(
  result: MutableResult,
  engineCorrect: boolean,
  hardAtlasCorrect: boolean,
  rejected: boolean,
): void {
  result.samples += 1;
  if (engineCorrect) result.engineCorrect += 1;
  if (hardAtlasCorrect) result.hardAtlasCorrect += 1;
  if (rejected) result.rejected += 1;
}

function finish(result: MutableResult): KeyboardAccuracyResult {
  const engineAccuracy = result.samples === 0 ? 0 : result.engineCorrect / result.samples;
  const hardAtlasAccuracy = result.samples === 0 ? 0 : result.hardAtlasCorrect / result.samples;
  return {
    ...result,
    engineAccuracy,
    hardAtlasAccuracy,
    engineDelta: engineAccuracy - hardAtlasAccuracy,
  };
}

function finishMap(results: ReadonlyMap<string, MutableResult>): KeyboardAccuracyBreakdown[] {
  return [...results].map(([name, result]) => ({ name, ...finish(result) }));
}

function validateSelection<T>(name: string, values: readonly T[]): readonly T[] {
  if (values.length === 0) throw new Error(`${name} must contain at least one value`);
  return values;
}

function validatePositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function validatePositiveNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function validateNonNegativeNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a non-negative number`);
  return value;
}

function validateUnitInterval(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between zero and one`);
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function hashU32(hash: number, value: number): number {
  let next = hash;
  const unsigned = value >>> 0;
  for (let shift = 0; shift < 32; shift += 8) {
    next = Math.imul(next ^ ((unsigned >>> shift) & 0xff), 0x0100_0193) >>> 0;
  }
  return next;
}
