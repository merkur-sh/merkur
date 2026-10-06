import { runKeyboardHotpathBench } from './bench-keyboard-hotpaths';
import '../packages/shared/src/e2e-wasm-bun';
import { createTerminalInputController } from '../apps/web/src/terminal/input-controller';
import {
  createPredictionFastPathBuffer,
  createPredictionFastPathConsumer,
  createPredictionFastPathWriter,
  PREDICTION_COMMAND_PRINTABLE,
  PREDICTION_COMMAND_SLOTS,
} from '../apps/web/src/terminal/prediction-fast-path';
import {
  VIRTUAL_KEY_DEFINITIONS,
  type VirtualKeyDefinition,
} from '../apps/web/src/terminal/virtual-keyboard';
import type { TerminalWorkerClient } from '../apps/web/src/terminal-worker-client';
import type { TerminalSession } from '../apps/web/src/transport-worker-client';
import { createKeyboardEngine, type KeyboardTimerHost } from '../packages/keyboard/src/engine';
import {
  CUPERTINO_PORTRAIT_PROFILE,
  hitTestKeyboard,
  solveKeyboardGeometry,
} from '../packages/keyboard/src/geometry';
import { TERMINAL_US_LAYOUT } from '../packages/keyboard/src/layouts/terminal-us';
import { emitPerfMetric, perfEnvInteger } from './perf/harness';

const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 1_000);
const BATCH_SIZE = perfEnvInteger('BENCH_BATCH_SIZE', 2_048);
const WARMUPS = readNonNegativeInteger('BENCH_WARMUPS', 100);
const GEOMETRY_SAMPLES = perfEnvInteger('BENCH_GEOMETRY_SAMPLES', 100);
const GEOMETRIES_PER_SAMPLE = perfEnvInteger('BENCH_GEOMETRIES_PER_SAMPLE', 8);
const WIDTH = 390;
const DPR = 3;
const FNV_OFFSET_BASIS = 0x811c_9dc5;

const geometry = solveKeyboardGeometry(
  TERMINAL_US_LAYOUT,
  'alpha',
  WIDTH,
  DPR,
  CUPERTINO_PORTRAIT_PROFILE,
);
const points = ['key-q', 'key-w', 'key-e', 'key-r', 'key-t', 'key-a', 'key-s', 'key-d'].map(
  (keyId) => {
    const key = geometry.keys.find((candidate) => candidate.definition.id === keyId);
    if (key === undefined) throw new Error(`keyboard benchmark is missing ${keyId}`);
    return [key.rect.x + key.rect.width / 2, key.rect.y + key.rect.height / 2] as const;
  },
);
/**
 * The same keys, aimed outside their anchors so the contact stays undecided
 * until release and still enters the press-ordinal queue. A centred contact now
 * commits at touch-down and never reaches that queue, so the two workloads that
 * exist to measure it have to aim here or they would silently stop measuring
 * anything — `timersArmed` would fall to zero and the rollover checksum, which
 * folds it in, would change.
 */
const offAnchorPoints = [
  'key-q',
  'key-w',
  'key-e',
  'key-r',
  'key-t',
  'key-a',
  'key-s',
  'key-d',
].map((keyId) => {
  const key = geometry.keys.find((candidate) => candidate.definition.id === keyId);
  if (key === undefined) throw new Error(`keyboard benchmark is missing ${keyId}`);
  // 0.35 of the width past centre: outside the 0.25 anchor, still well inside
  // the rect. Asserted rather than assumed, because a point that fell to a
  // neighbour would change the checksum and invalidate the A/B.
  const point = [key.rect.x + key.rect.width * 0.85, key.rect.y + key.rect.height / 2] as const;
  if (hitTestKeyboard(geometry, point[0], point[1]) !== key.index) {
    throw new Error(`off-anchor benchmark point for ${keyId} resolves to another key`);
  }
  return point;
});
const roamingStart = boundaryBetween(geometry, 'key-q', 'key-w');

let syntheticTime = 0;
let commitChecksum = FNV_OFFSET_BASIS;
const engine = createKeyboardEngine({
  geometry,
  profile: CUPERTINO_PORTRAIT_PROFILE,
  onRawCommit(key, _layerId, pointerId) {
    commitChecksum = hashU32(commitChecksum, key.index ^ pointerId);
  },
});

benchmark('keyboard-hit-test', SAMPLES, WARMUPS, BATCH_SIZE * 8, () => {
  let checksum = FNV_OFFSET_BASIS;
  for (let index = 0; index < BATCH_SIZE * 8; index += 1) {
    const point = points[index & 7];
    if (point === undefined) throw new Error('keyboard benchmark point disappeared');
    const keyIndex = hitTestKeyboard(geometry, point[0], point[1]);
    if (keyIndex === null) throw new Error('keyboard hit atlas rejected a key center');
    checksum = hashU32(checksum, keyIndex);
  }
  return checksum;
});

benchmark('keyboard-tap-capture', SAMPLES, WARMUPS, BATCH_SIZE, () => {
  for (let index = 0; index < BATCH_SIZE; index += 1) {
    const point = points[index & 7];
    if (point === undefined) throw new Error('keyboard benchmark point disappeared');
    const pointerId = (index & 7) + 1;
    const downAt = syntheticTime;
    syntheticTime += 2;
    if (!engine.beginPointerAt(pointerId, point[0], point[1], downAt)) {
      throw new Error('keyboard engine rejected benchmark pointerdown');
    }
    if (!engine.endPointerAt(pointerId, point[0], point[1], downAt + 1)) {
      throw new Error('keyboard engine rejected benchmark pointerup');
    }
  }
  return commitChecksum;
});

const moveEngine = createKeyboardEngine({
  geometry,
  profile: CUPERTINO_PORTRAIT_PROFILE,
  onRawCommit() {},
});
if (!moveEngine.beginPointerAt(100, roamingStart[0], roamingStart[1], 0)) {
  throw new Error('keyboard engine rejected benchmark roaming pointer');
}
benchmark('keyboard-roaming-move', SAMPLES, WARMUPS, BATCH_SIZE * 4, () => {
  let checksum = FNV_OFFSET_BASIS;
  for (let index = 0; index < BATCH_SIZE * 4; index += 1) {
    const point = points[index & 1];
    if (point === undefined) throw new Error('keyboard benchmark point disappeared');
    syntheticTime += 1;
    if (!moveEngine.movePointerAt(100, point[0], point[1], syntheticTime)) {
      throw new Error('keyboard engine lost benchmark roaming pointer');
    }
    checksum = hashU32(checksum, index & 1);
  }
  return checksum;
});
moveEngine.cancelPointer(100);

// Nested releases buffer commits behind the rollover deadline. Without a stub
// host that would arm a real setTimeout per cycle and swamp a ~100ns measurement
// with work that is not the engine's.
let timersArmed = 0;
const stubTimers: KeyboardTimerHost = {
  set: () => {
    timersArmed += 1;
    return 0;
  },
  clear: () => {},
  now: () => syntheticTime,
};

let multitouchChecksum = FNV_OFFSET_BASIS;
const multitouchEngine = createKeyboardEngine({
  geometry,
  profile: CUPERTINO_PORTRAIT_PROFILE,
  timers: stubTimers,
  onRawCommit(key, _layerId, pointerId) {
    multitouchChecksum = hashU32(multitouchChecksum, key.index ^ pointerId);
  },
});
benchmark('keyboard-multitouch-event', SAMPLES, WARMUPS, BATCH_SIZE * 8, () => {
  for (let cycle = 0; cycle < BATCH_SIZE; cycle += 1) {
    const startedAt = syntheticTime;
    syntheticTime += 2;
    for (let pointer = 0; pointer < 4; pointer += 1) {
      const point = offAnchorPoints[pointer];
      if (
        point === undefined ||
        !multitouchEngine.beginPointerAt(200 + pointer, point[0], point[1], startedAt)
      ) {
        throw new Error('keyboard engine rejected benchmark multitouch pointerdown');
      }
    }
    for (let pointer = 3; pointer >= 0; pointer -= 1) {
      const point = offAnchorPoints[pointer];
      if (
        point === undefined ||
        !multitouchEngine.endPointerAt(200 + pointer, point[0], point[1], startedAt + 1)
      ) {
        throw new Error('keyboard engine rejected benchmark multitouch pointerup');
      }
    }
  }
  return multitouchChecksum;
});
multitouchEngine.destroy();

let rolloverChecksum = FNV_OFFSET_BASIS;
const rolloverEngine = createKeyboardEngine({
  geometry,
  profile: CUPERTINO_PORTRAIT_PROFILE,
  timers: stubTimers,
  onRawCommit(key, _layerId, pointerId) {
    rolloverChecksum = hashU32(rolloverChecksum, key.index ^ pointerId);
  },
});
// down A, down B, up B, up A with the blocker kept young, so this measures the
// buffered path: blocker scan, ordered insert, deadline arm, two-entry drain.
benchmark('keyboard-nested-rollover', SAMPLES, WARMUPS, BATCH_SIZE * 4, () => {
  for (let cycle = 0; cycle < BATCH_SIZE; cycle += 1) {
    const startedAt = syntheticTime;
    syntheticTime += 2;
    // The mixed case, which is the one that now matters: an undecided blocker
    // plus an anchored tap that is decided at its own down but must still wait
    // its turn in the queue rather than transposing the two.
    const outer = offAnchorPoints[cycle & 7];
    const inner = points[(cycle + 4) & 7];
    if (outer === undefined || inner === undefined) {
      throw new Error('keyboard benchmark point disappeared');
    }
    if (
      !rolloverEngine.beginPointerAt(300, outer[0], outer[1], startedAt) ||
      !rolloverEngine.beginPointerAt(301, inner[0], inner[1], startedAt) ||
      !rolloverEngine.endPointerAt(301, inner[0], inner[1], startedAt + 1) ||
      !rolloverEngine.endPointerAt(300, outer[0], outer[1], startedAt + 1)
    ) {
      throw new Error('keyboard engine rejected benchmark rollover pointer');
    }
  }
  return rolloverChecksum ^ timersArmed;
});
rolloverEngine.destroy();

const virtualDefinitions = [
  VIRTUAL_KEY_DEFINITIONS['key-q'],
  VIRTUAL_KEY_DEFINITIONS['key-w'],
  VIRTUAL_KEY_DEFINITIONS['key-e'],
  VIRTUAL_KEY_DEFINITIONS['key-r'],
  VIRTUAL_KEY_DEFINITIONS['key-t'],
] as const;
let nextInputSeq = 1;
let virtualChecksum = FNV_OFFSET_BASIS;
let predictionCount = 0;
let clearedModifiers = 0;
const fakeSession = {
  sendKeystroke(
    bytes: Uint8Array,
    _inputAtMs?: number,
    classifyShadowModelled?: (inputSeq: number) => boolean,
  ): number {
    const inputSeq = nextInputSeq;
    nextInputSeq += 1;
    for (const byte of bytes)
      virtualChecksum = Math.imul(virtualChecksum ^ byte, 0x0100_0193) >>> 0;
    if (classifyShadowModelled?.(inputSeq) === true) virtualChecksum ^= 0x8000_0000;
    return inputSeq;
  },
} as unknown as TerminalSession;
const fakeWorker = {
  isAltScreenActive: () => false,
  isMouseModeActive: () => false,
  isPredictionSafe: () => true,
  predictPrintable: () => {
    predictionCount += 1;
    return true;
  },
  predictBackspace: () => true,
  predictDelete: () => true,
  predictCursorShift: () => true,
  flushPredictions: () => {},
} as unknown as TerminalWorkerClient;
const noVirtualModifiers = { shift: false, ctrl: false, alt: false, meta: false } as const;
/** The terminal panel: every benchmark key is aimed at the terminal. */
const OWNING_PANEL = { contains: () => true } as unknown as HTMLElement;
const inputController = createTerminalInputController({
  touchKeyboardEligible: true,
  ownerEl: OWNING_PANEL,
  getSession: () => fakeSession,
  getWorkerClient: () => fakeWorker,
  getTouchSurfaceEl: () => null,
  getVirtualModifiers: () => noVirtualModifiers,
  clearVirtualModifiers: () => {
    clearedModifiers += 1;
  },
  focusTerminal: () => {},
  onToggleFocusMode: () => {},
});

benchmark('keyboard-virtual-dispatch', SAMPLES, WARMUPS, BATCH_SIZE, () => {
  for (let index = 0; index < BATCH_SIZE; index += 1) {
    const definition: VirtualKeyDefinition | undefined =
      virtualDefinitions[index % virtualDefinitions.length];
    if (definition === undefined) throw new Error('virtual keyboard benchmark key disappeared');
    inputController.sendVirtualKey(definition);
  }
  return virtualChecksum ^ predictionCount;
});
inputController.destroy();
if (clearedModifiers !== 0) {
  throw new Error(`ordinary virtual keys caused ${clearedModifiers} redundant modifier clears`);
}

const predictionFastPathBuffer = createPredictionFastPathBuffer();
const predictionFastPathWriter = createPredictionFastPathWriter(predictionFastPathBuffer);
const predictionFastPathConsumer = createPredictionFastPathConsumer(predictionFastPathBuffer);
predictionFastPathWriter.beginEpoch();
predictionFastPathConsumer.adoptRequiredEpoch();
let nextPredictionSeq = 1;
let predictionFastPathChecksum = FNV_OFFSET_BASIS;
benchmark('keyboard-prediction-sab-roundtrip', SAMPLES, WARMUPS, BATCH_SIZE, () => {
  let remaining = BATCH_SIZE;
  while (remaining > 0) {
    const batchSize = Math.min(remaining, PREDICTION_COMMAND_SLOTS - 1);
    for (let index = 0; index < batchSize; index += 1) {
      const inputSeq = nextPredictionSeq;
      nextPredictionSeq = inputSeq >= 0xffff_ffff ? 1 : inputSeq + 1;
      if (
        !predictionFastPathWriter.writePrintable(inputSeq, 0x61 + (index % 26), syntheticTime, true)
      ) {
        throw new Error('prediction SAB benchmark producer rejected a bounded batch');
      }
    }
    const drained = predictionFastPathConsumer.drain(
      batchSize,
      (kind, inputSeq, value, sentAtMs) => {
        if (kind !== PREDICTION_COMMAND_PRINTABLE || sentAtMs !== syntheticTime) {
          throw new Error('prediction SAB benchmark consumer observed a malformed command');
        }
        predictionFastPathChecksum = hashU32(predictionFastPathChecksum, inputSeq ^ value);
      },
    );
    if (drained !== batchSize) {
      throw new Error(`prediction SAB benchmark drained ${drained}/${batchSize} commands`);
    }
    remaining -= batchSize;
  }
  syntheticTime += 1;
  return predictionFastPathChecksum;
});

benchmark(
  'keyboard-geometry-solve',
  GEOMETRY_SAMPLES,
  Math.min(WARMUPS, 20),
  GEOMETRIES_PER_SAMPLE,
  () => {
    let checksum = FNV_OFFSET_BASIS;
    for (let index = 0; index < GEOMETRIES_PER_SAMPLE; index += 1) {
      const solved = solveKeyboardGeometry(
        TERMINAL_US_LAYOUT,
        index & 1 ? 'pc' : 'alpha',
        WIDTH + (index & 1),
        DPR,
        CUPERTINO_PORTRAIT_PROFILE,
      );
      checksum = hashU32(checksum, solved.candidateAtlas.byteLength ^ solved.keys.length);
    }
    return checksum;
  },
);

engine.destroy();

function benchmark(
  name: string,
  samples: number,
  warmups: number,
  operationsPerSample: number,
  run: () => number,
): void {
  let checksum = FNV_OFFSET_BASIS;
  for (let index = 0; index < warmups; index += 1) checksum = hashU32(checksum, run());

  const elapsedNsPerOperation: number[] = [];
  let totalElapsedMs = 0;
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    const result = run();
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs < 0) throw new Error(`${name} benchmark timer moved backwards`);
    totalElapsedMs += elapsedMs;
    elapsedNsPerOperation.push((elapsedMs * 1_000_000) / operationsPerSample);
    checksum = hashU32(checksum, result);
  }
  if (!(totalElapsedMs > 0)) throw new Error(`${name} benchmark timer did not advance`);

  elapsedNsPerOperation.sort((left, right) => left - right);
  const p50 = nearestRank(elapsedNsPerOperation, 0.5);
  const p95 = nearestRank(elapsedNsPerOperation, 0.95);
  const p99 = nearestRank(elapsedNsPerOperation, 0.99);
  const measuredOperations = samples * operationsPerSample;
  const throughput = Math.round((measuredOperations / totalElapsedMs) * 1_000);
  process.stdout.write(
    `${name}: p50=${p50.toFixed(2)}ns/op p95=${p95.toFixed(2)}ns/op ` +
      `p99=${p99.toFixed(2)}ns/op throughput=${throughput.toLocaleString('en-US')}ops/s ` +
      `checksum=${checksum.toString(16).padStart(8, '0')}\n`,
  );
  for (const [value, percentile] of [
    [p50, 0.5],
    [p95, 0.95],
    [p99, 0.99],
  ] as const) {
    emitPerfMetric({
      name,
      value,
      unit: 'ns/op',
      direction: 'lower',
      percentile,
      sampleSize: samples,
    });
  }
  emitPerfMetric({
    name: `${name}-throughput`,
    value: throughput,
    unit: 'ops/s',
    direction: 'higher',
    sampleSize: measuredOperations,
  });
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] ?? 0;
}

function hashU32(hash: number, value: number): number {
  let next = hash;
  for (let shift = 0; shift < 32; shift += 8) {
    next = Math.imul(next ^ ((value >>> shift) & 0xff), 0x0100_0193) >>> 0;
  }
  return next;
}

function boundaryBetween(
  resolved: typeof geometry,
  leftKeyId: string,
  rightKeyId: string,
): readonly [number, number] {
  const left = resolved.keys.find((key) => key.definition.id === leftKeyId);
  const right = resolved.keys.find((key) => key.definition.id === rightKeyId);
  if (left === undefined || right === undefined) {
    throw new Error(`keyboard benchmark is missing ${leftKeyId}/${rightKeyId}`);
  }
  const y = Math.floor(left.rect.y + left.rect.height / 2);
  const rowOffset = y * resolved.atlasWidth;
  for (let x = 0; x + 1 < resolved.atlasWidth; x += 1) {
    if (
      resolved.candidateAtlas[(rowOffset + x) * 4] === left.index &&
      resolved.candidateAtlas[(rowOffset + x + 1) * 4] === right.index
    ) {
      return [x + 0.25, y + 0.25];
    }
  }
  throw new Error(`keyboard benchmark has no ${leftKeyId}/${rightKeyId} boundary`);
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

runKeyboardHotpathBench();
