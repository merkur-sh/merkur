/**
 * Process-wide owner of the learned per-key offsets.
 *
 * Portrait and landscape are kept apart because they are different postures:
 * the same person holds the phone differently and aims differently, so pooling
 * them would average two real biases into one wrong one.
 *
 * Every tab of the origin learns into one stored pair. A save is one
 * IndexedDB read-write transaction, which runs one at a time across tabs: it
 * reads what the other tabs stored, replays onto it the evidence this tab took
 * in since its last save, and stores the result, so no tab's taps overwrite
 * another's. (`localStorage` cannot do this: Firefox lost an update between two
 * tabs taking turns under one Web Lock, see `@merkur/browser-storage`.)
 */
import { defineDatabase, keyedStore } from '@merkur/browser-storage';
import {
  createKeyboardOffsetModel,
  isKeyboardOffsetSnapshot,
  type KeyboardOffsetSnapshot,
  type KeyboardTouchModel,
  type KeyboardTouchTrace,
  keyboardOrientation,
  type ResolvedKeyboardGeometry,
} from '@merkur/keyboard';
import { isRecord } from '@merkur/shared';

import { STORAGE_NAMES } from '../lib/storage-names';

export type KeyboardOrientation = 'portrait' | 'landscape';

interface StoredOffsets {
  readonly portrait: KeyboardOffsetSnapshot;
  readonly landscape: KeyboardOffsetSnapshot;
}

/**
 * Both postures or neither: every save writes the pair. A pre-grip-field
 * snapshot has no field block and fails the guard, which is the intended hard
 * cutover: it is discarded, not migrated, and relearning costs a few hundred taps.
 */
const typingOffsets = defineDatabase(STORAGE_NAMES.typing_offsets, 1, {
  offsets: keyedStore<'current', StoredOffsets>((value) =>
    isRecord(value) &&
    isKeyboardOffsetSnapshot(value.portrait) &&
    isKeyboardOffsetSnapshot(value.landscape)
      ? { portrait: value.portrait, landscape: value.landscape }
      : null,
  ),
});

/**
 * Rebuilding the touch model allocates two Float64Arrays and re-enters the
 * engine, so it happens on a cadence rather than per keystroke. Twenty-five taps
 * is far below the number needed to move an estimate perceptibly, so nothing is
 * lost by waiting.
 */
const APPLY_INTERVAL_TAPS = 25;
const PERSIST_DELAY_MS = 8_000;

const models = {
  portrait: createKeyboardOffsetModel(),
  landscape: createKeyboardOffsetModel(),
};
let sinceApply = 0;
let persistHandle: ReturnType<typeof setTimeout> | null = null;
let started = false;
const listeners = new Set<() => void>();

/**
 * The evidence taken in since the last save, in order, for replay onto what
 * another tab stored. Three parallel arrays rather than an object per tap, so
 * recording a tap allocates nothing once they have grown; `null` intent is a
 * plain tap, a key id a correction.
 */
let pendingTraces: KeyboardTouchTrace[] = [];
let pendingGeometries: ResolvedKeyboardGeometry[] = [];
let pendingIntents: (string | null)[] = [];

/**
 * Whether this tab has read or written a stored pair since its last reset. An
 * absent pair then means another tab reset the offsets, and this tab follows;
 * before that, it means nothing was ever stored.
 */
let shared = false;
/** Set by a reset; the next save deletes the stored pair instead of writing one. */
let clearRequested = false;
let saving = false;
let saveAgain = false;

/**
 * Derived from the keyboard's own width rather than the window's, so it agrees
 * with the profile. `window.innerWidth` disagrees in split view and any shrunk
 * viewport, which would compose a landscape geometry with portrait-learned
 * offsets.
 */
function orientationFor(geometry: ResolvedKeyboardGeometry): KeyboardOrientation {
  return keyboardOrientation(geometry.width);
}

/**
 * Folds one committed tap into the current orientation's model. Returns true
 * when the caller should re-apply the touch model to the live engine.
 */
export function recordKeyboardOffsetTouch(
  trace: KeyboardTouchTrace,
  geometry: ResolvedKeyboardGeometry | null,
): boolean {
  if (geometry === null) return false;
  ensureStarted();
  if (!models[orientationFor(geometry)].record(trace, geometry)) return false;
  remember(trace, geometry, null);
  sinceApply += 1;
  if (sinceApply < APPLY_INTERVAL_TAPS) return false;
  sinceApply = 0;
  return true;
}

/**
 * Folds in a tap the user corrected, labelled with the key they retyped in its
 * place, into the model for the posture the tap was made in. Corrections arrive
 * when a line finishes, outside any trace, so when they bring the apply cadence
 * due the mounted keyboard re-applies through the same listeners a reset uses.
 */
export function recordKeyboardOffsetCorrection(
  trace: KeyboardTouchTrace,
  geometry: ResolvedKeyboardGeometry,
  intendedKeyId: string,
): void {
  ensureStarted();
  if (!models[orientationFor(geometry)].recordCorrection(trace, geometry, intendedKeyId)) return;
  remember(trace, geometry, intendedKeyId);
  sinceApply += 1;
  if (sinceApply < APPLY_INTERVAL_TAPS) return;
  sinceApply = 0;
  notify();
}

/** Applies the learned offsets for the current orientation on top of `base`. */
export function applyKeyboardOffsets(
  geometry: ResolvedKeyboardGeometry,
  base: KeyboardTouchModel,
): KeyboardTouchModel {
  ensureStarted();
  return models[orientationFor(geometry)].apply(geometry, base);
}

/**
 * Keys with learned evidence across both postures. Summed rather than reported
 * per orientation because the caller is a settings screen with no keyboard
 * geometry to derive one from, and guessing an orientation from the window is
 * exactly the disagreement `orientationFor` exists to prevent.
 */
export function learnedKeyboardOffsetCount(): number {
  ensureStarted();
  return models.portrait.learnedKeyCount() + models.landscape.learnedKeyCount();
}

/**
 * Fires whenever a mounted keyboard must re-apply its touch model outside a
 * trace: when a line's corrections bring the apply cadence due, when a save
 * merged in another tab's learning, and after the models are wiped. Without
 * the last, a reset from the settings screen reached the live engine only on
 * the 25th accepted tap after it — the stale personalised model kept deciding
 * keystrokes the user had just asked to forget.
 */
export function subscribeKeyboardOffsets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetKeyboardOffsets(): void {
  models.portrait.reset();
  models.landscape.reset();
  sinceApply = 0;
  started = true;
  takePending();
  shared = false;
  clearRequested = true;
  if (persistHandle !== null) {
    clearTimeout(persistHandle);
    persistHandle = null;
  }
  void save();
  notify();
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** The first use loads what the other tabs stored, by saving: the save merges both ways. */
function ensureStarted(): void {
  if (started) return;
  started = true;
  void save();
}

function remember(
  trace: KeyboardTouchTrace,
  geometry: ResolvedKeyboardGeometry,
  intendedKeyId: string | null,
): void {
  pendingTraces.push(trace);
  pendingGeometries.push(geometry);
  pendingIntents.push(intendedKeyId);
  if (persistHandle !== null) return;
  persistHandle = setTimeout(() => {
    persistHandle = null;
    void save();
  }, PERSIST_DELAY_MS);
}

interface Evidence {
  readonly traces: KeyboardTouchTrace[];
  readonly geometries: ResolvedKeyboardGeometry[];
  readonly intents: (string | null)[];
}

function takePending(): Evidence {
  const evidence = {
    traces: pendingTraces,
    geometries: pendingGeometries,
    intents: pendingIntents,
  };
  pendingTraces = [];
  pendingGeometries = [];
  pendingIntents = [];
  return evidence;
}

/** Puts evidence a failed save took back in front of what arrived since. */
function restorePending(evidence: Evidence): void {
  pendingTraces = evidence.traces.concat(pendingTraces);
  pendingGeometries = evidence.geometries.concat(pendingGeometries);
  pendingIntents = evidence.intents.concat(pendingIntents);
}

function replay(evidence: Evidence): void {
  for (let index = 0; index < evidence.traces.length; index += 1) {
    const trace = evidence.traces[index];
    const geometry = evidence.geometries[index];
    const intent = evidence.intents[index];
    if (trace === undefined || geometry === undefined || intent === undefined) continue;
    const model = models[orientationFor(geometry)];
    if (intent === null) model.record(trace, geometry);
    else model.recordCorrection(trace, geometry, intent);
  }
}

/**
 * Saves the pair, merged with what the other tabs stored, in one read-write
 * transaction. One save runs at a time; a save asked for meanwhile runs once
 * the current one ends. A storage failure is counted by the package and costs
 * only the copy, so the evidence goes back to wait for the next save.
 */
async function save(): Promise<void> {
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  let taken: Evidence | null = null;
  try {
    const merged = await typingOffsets.write(['offsets'], async (transaction) => {
      const store = transaction.store('offsets');
      const stored = await store.get('current');
      // From here to the end of the body nothing awaits, so no tap can land
      // between the evidence taken and the pair written.
      if (clearRequested) {
        clearRequested = false;
        store.delete('current');
        return false;
      }
      taken = takePending();
      let mergedOther = false;
      if (stored !== null) {
        models.portrait.restore(stored.portrait);
        models.landscape.restore(stored.landscape);
        replay(taken);
        mergedOther = true;
      } else if (shared) {
        models.portrait.reset();
        models.landscape.reset();
        replay(taken);
        mergedOther = true;
      }
      shared = true;
      store.put('current', {
        portrait: models.portrait.snapshot(),
        landscape: models.landscape.snapshot(),
      });
      return mergedOther;
    });
    if (merged) notify();
  } catch (cause) {
    if (!(cause instanceof DOMException)) throw cause;
    if (taken !== null) restorePending(taken);
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      void save();
    }
  }
}
