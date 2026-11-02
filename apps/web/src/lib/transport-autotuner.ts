import { type Cloned, defineDatabase, keyedStore, withDatabase } from '@merkur/browser-storage';
import {
  BYTES_PER_KIB,
  BYTES_PER_MIB,
  clamp01,
  clampInt,
  isRecord,
  TRANSPORT_POLICY,
  TRANSPORT_PROFILE,
} from '@merkur/shared';

import { STORAGE_NAMES } from './storage-names';

/**
 * One tuner record per context. Every tab connecting in one context learns into
 * the same record: a save is one IndexedDB read-write transaction, which runs
 * one at a time across tabs, and replays the rewards this tab observed since its
 * last save onto what the other tabs stored.
 */
const transportTuning = defineDatabase(STORAGE_NAMES.transport_autotuner, 1, {
  tuners: keyedStore<string, TunerState>(parseState),
});
/** A reward per heartbeat is too often to open a database for; a few seconds' worth is not. */
const PERSIST_DELAY_MS = 5_000;
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
  let state = initialState();
  /** Rewards observed since the last save, by the arm each was for, for replay. */
  let pendingArms: number[] = [];
  let pendingRewards: number[] = [];
  /** Whether this tuner has read or written its record: an absent one then means a reset. */
  let shared = false;
  let saving = false;
  let saveAgain = false;
  let persistHandle: ReturnType<typeof setTimeout> | null = null;

  function replay(onto: TunerState, arms: readonly number[], rewards: readonly number[]): void {
    for (let index = 0; index < arms.length; index += 1) {
      const arm = arms[index];
      const reward = rewards[index];
      if (arm !== undefined && reward !== undefined) updateArm(onto, arm, reward);
    }
    onto.activeArm = chooseArm(onto);
  }

  /**
   * One save at a time; one asked for meanwhile runs once the current one ends.
   * A storage failure is counted by the package and costs only the copy: the
   * rewards it took go back to wait for the next save.
   */
  async function save(): Promise<void> {
    if (saving) {
      saveAgain = true;
      return;
    }
    saving = true;
    let takenArms: number[] = [];
    let takenRewards: number[] = [];
    try {
      await withDatabase(transportTuning, (database) =>
        database.write(['tuners'], async (transaction) => {
          const store = transaction.store('tuners');
          const stored = await store.get(contextId);
          // Nothing awaits from here on, so no reward lands between the
          // rewards taken and the record written.
          takenArms = pendingArms;
          takenRewards = pendingRewards;
          pendingArms = [];
          pendingRewards = [];
          if (stored !== null || shared) {
            const merged = stored ?? initialState();
            replay(merged, takenArms, takenRewards);
            state = merged;
          }
          shared = true;
          store.put(contextId, state);
        }),
      );
    } catch (cause) {
      if (!(cause instanceof DOMException)) throw cause;
      pendingArms = takenArms.concat(pendingArms);
      pendingRewards = takenRewards.concat(pendingRewards);
    } finally {
      saving = false;
      if (saveAgain) {
        saveAgain = false;
        void save();
      }
    }
  }

  // The first save loads what this context learned before, merging both ways.
  void save();

  return {
    observeAndMaybeSample(rttMs: number, pathType: 'direct' | 'relay' | 'unknown'): TransportHint {
      const reward = scoreReward(rttMs, pathType);
      pendingArms.push(state.activeArm);
      pendingRewards.push(reward);
      updateArm(state, state.activeArm, reward);
      state.activeArm = chooseArm(state);
      if (persistHandle === null) {
        persistHandle = setTimeout(() => {
          persistHandle = null;
          void save();
        }, PERSIST_DELAY_MS);
      }
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

function parseState(value: Cloned): TunerState | null {
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
