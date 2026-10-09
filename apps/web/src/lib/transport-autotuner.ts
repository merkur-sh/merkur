import {
  BYTES_PER_KIB,
  BYTES_PER_MIB,
  clamp01,
  clampInt,
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
  const storageKey = `${STORAGE_PREFIX}:${contextId}`;
  const state = loadState(storageKey);

  return {
    observeAndMaybeSample(rttMs: number, pathType: 'direct' | 'relay' | 'unknown'): TransportHint {
      const reward = scoreReward(rttMs, pathType);
      updateArm(state, state.activeArm, reward);
      state.activeArm = chooseArm(state);
      saveState(storageKey, state);
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

function loadState(storageKey: string): TunerState {
  const fallback: TunerState = {
    counts: ARMS.map(() => 0),
    values: ARMS.map(() => 0),
    activeArm: 0,
  };
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<TunerState>;
    if (
      !Array.isArray(parsed.counts) ||
      !Array.isArray(parsed.values) ||
      typeof parsed.activeArm !== 'number'
    ) {
      return fallback;
    }
    if (parsed.counts.length !== ARMS.length || parsed.values.length !== ARMS.length) {
      return fallback;
    }
    return {
      counts: parsed.counts.map((value) => Math.max(0, Math.round(Number(value) || 0))),
      values: parsed.values.map((value) => clamp01(Number(value) || 0)),
      activeArm: clampInt(parsed.activeArm, 0, ARMS.length - 1),
    };
  } catch {
    return fallback;
  }
}

function saveState(storageKey: string, state: TunerState): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // ignore storage failures
  }
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
