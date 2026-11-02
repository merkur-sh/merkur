import { type Json, localValue } from '@merkur/browser-storage';
import {
  BYTES_PER_KIB,
  BYTES_PER_MIB,
  clamp01,
  clampInt,
  isRecord,
  TRANSPORT_POLICY,
  TRANSPORT_PROFILE,
} from '@merkur/shared';

const STORAGE_PREFIX = 'merkur.transport.autotuner';
const TUNER_POLICY = {
  rewardLatencySpanMs: 240,
  directPathRewardBonus: 0.08,
} as const;

export interface TransportHint {
  readonly profile: number;
  readonly chunkBytes: number;
  readonly snapshotBytes: number;
}

interface TunerState {
  readonly counts: number[];
  readonly values: number[];
  activeArm: number;
}

interface TunerArm {
  readonly id: number;
  readonly hint: TransportHint;
}

const ARMS: readonly TunerArm[] = [
  {
    id: TRANSPORT_PROFILE.balanced,
    hint: {
      profile: TRANSPORT_PROFILE.balanced,
      chunkBytes: 12 * BYTES_PER_KIB,
      snapshotBytes: TRANSPORT_POLICY.displaySnapshotTargetDefaultBytes,
    },
  },
  {
    id: TRANSPORT_PROFILE.conservative,
    hint: {
      profile: TRANSPORT_PROFILE.conservative,
      chunkBytes: 24 * BYTES_PER_KIB,
      snapshotBytes: 6 * BYTES_PER_MIB,
    },
  },
  {
    id: TRANSPORT_PROFILE.aggressive,
    hint: {
      profile: TRANSPORT_PROFILE.aggressive,
      chunkBytes: 8 * BYTES_PER_KIB,
      snapshotBytes: 10 * BYTES_PER_MIB,
    },
  },
];

export interface TransportAutotuner {
  observeAndMaybeSample(rttMs: number, pathType: 'direct' | 'relay' | 'unknown'): TransportHint;
}

export function createTransportAutotuner(contextId: string): TransportAutotuner {
  const stored = localValue(`${STORAGE_PREFIX}:${contextId}`, parseState);
  const state = stored.read() ?? initialState();

  return {
    observeAndMaybeSample(rttMs: number, pathType: 'direct' | 'relay' | 'unknown'): TransportHint {
      const reward = scoreReward(rttMs, pathType);
      updateArm(state, state.activeArm, reward);
      state.activeArm = chooseArm(state);
      stored.write(state);
      return getActiveHint(state);
    },
  };
}

function getActiveHint(state: TunerState): TransportHint {
  const arm = ARMS[state.activeArm];
  if (arm === undefined) {
    throw new Error(`Invalid transport tuner arm: ${state.activeArm}`);
  }
  return arm.hint;
}

function scoreReward(rttMs: number, pathType: 'direct' | 'relay' | 'unknown'): number {
  const latencyScore =
    1 - clamp01((rttMs - TRANSPORT_POLICY.rttBaselineMs) / TUNER_POLICY.rewardLatencySpanMs);
  const pathBonus = pathType === 'direct' ? TUNER_POLICY.directPathRewardBonus : 0;
  return clamp01(latencyScore + pathBonus);
}

function initialState(): TunerState {
  return {
    counts: ARMS.map(() => 0),
    values: ARMS.map(() => 0),
    activeArm: 0,
  };
}

function parseState(value: Json): TunerState | null {
  if (!isRecord(value)) return null;
  const { counts, values, activeArm } = value;
  if (
    !Array.isArray(counts) ||
    !Array.isArray(values) ||
    typeof activeArm !== 'number' ||
    counts.length !== ARMS.length ||
    values.length !== ARMS.length
  ) {
    return null;
  }
  return {
    counts: counts.map((count) => Math.max(0, Math.round(Number(count) || 0))),
    values: values.map((reward) => clamp01(Number(reward) || 0)),
    activeArm: clampInt(activeArm, 0, ARMS.length - 1),
  };
}

function updateArm(state: TunerState, arm: number, reward: number): void {
  const { counts, values } = state;
  const previousCount = counts[arm] ?? 0;
  const nextCount = previousCount + 1;
  counts[arm] = nextCount;
  const previousValue = values[arm] ?? 0;
  values[arm] = previousValue + (reward - previousValue) / nextCount;
}

function chooseArm(state: TunerState): number {
  for (let arm = 0; arm < ARMS.length; arm += 1) {
    if ((state.counts[arm] ?? 0) === 0) return arm;
  }

  let bestArm = 0;
  let bestValue = -1;
  for (let arm = 0; arm < ARMS.length; arm += 1) {
    const value = state.values[arm] ?? 0;
    if (value > bestValue) {
      bestValue = value;
      bestArm = arm;
    }
  }
  return bestArm;
}
