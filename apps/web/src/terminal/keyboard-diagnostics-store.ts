/**
 * Process-wide owner of the typing diagnostics accumulator.
 *
 * The keyboard component mounts and unmounts as the terminal comes and goes, and
 * the app is a PWA that gets backgrounded and reloaded freely, so the statistics
 * cannot live in component state. They live here and persist as an aggregate.
 *
 * What is persisted is sums and histogram counts, never a keystroke sequence —
 * see `keyboard-diagnostics.ts` for why that distinction is the thing that makes
 * this safe to run during ordinary typing.
 *
 * Every tab of the origin adds into one stored aggregate. Because every field is
 * a sum, a save merges by addition: in one IndexedDB read-write transaction,
 * which runs one at a time across tabs, it stores what the other tabs stored
 * plus what this tab counted since its last save.
 *
 * A finished line's corrected misses also go to the offset learner: the user
 * retyping a neighbour in a tap's place is the one label for that tap that is
 * not the decoder's own guess.
 */
import { defineDatabase, guarded, keyedStore } from '@merkur/browser-storage';
import type {
  KeyboardKeyDefinition,
  KeyboardTouchTrace,
  ResolvedKeyboardGeometry,
} from '@merkur/keyboard';

import { STORAGE_NAMES } from '../lib/storage-names';
import {
  createKeyboardDiagnostics,
  DIAGNOSTICS_COUNTS,
  DIAGNOSTICS_HISTOGRAMS,
  DIAGNOSTICS_KEY_COUNTS,
  DIAGNOSTICS_KEY_SUMS,
  DIAGNOSTICS_SUMS,
  type KeyboardDiagnosticsSnapshot,
  type KeyboardDiagnosticsSummary,
  mergeDiagnosticsSnapshots,
} from './keyboard-diagnostics';
import { recordKeyboardOffsetCorrection } from './keyboard-offset-store';

/** A corrupt or unreadable aggregate is disposable: the statistics start from empty. */
const typingDiagnostics = defineDatabase(STORAGE_NAMES.typing_diagnostics, 1, {
  diagnostics: keyedStore<'current', KeyboardDiagnosticsSnapshot>(guarded(isSnapshot)),
});
/** Writing on every keystroke would put serialisation on the typing path. */
const PERSIST_DELAY_MS = 4_000;

const diagnostics = createKeyboardDiagnostics({ onCorrection: recordKeyboardOffsetCorrection });
const EMPTY = createKeyboardDiagnostics().snapshot();
/** The aggregate as of this tab's last save: what this tab counted since is the rest. */
let base: KeyboardDiagnosticsSnapshot = EMPTY;
let persistHandle: ReturnType<typeof setTimeout> | null = null;
let started = false;
/** Set by a reset; the next save deletes the stored aggregate instead of writing one. */
let clearRequested = false;
let saving = false;
let saveAgain = false;

export function recordKeyboardTouch(
  trace: KeyboardTouchTrace,
  geometry: ResolvedKeyboardGeometry | null,
): void {
  ensureStarted();
  diagnostics.record(trace, geometry);
  schedulePersist();
}

/**
 * Every commit from the on-screen keyboard, in order, so a finished line can be
 * analysed for the taps its Backspaces undid. Counts change, and are persisted,
 * only when a line finishes.
 */
export function recordKeyboardCommit(
  key: KeyboardKeyDefinition,
  pointerId: number,
  repeat: boolean,
): void {
  ensureStarted();
  if (diagnostics.recordCommit(key, pointerId, repeat)) schedulePersist();
}

/**
 * The line ended outside the keyboard's own commits: a chord, a toolbar key,
 * input from elsewhere, or the keyboard going away. Cheap when no line is open,
 * which is every hardware keystroke on a desktop.
 */
export function recordKeyboardBreak(): void {
  ensureStarted();
  if (diagnostics.recordBreak()) schedulePersist();
}

export function keyboardDiagnosticsSummary(driftThresholdPx: number): KeyboardDiagnosticsSummary {
  ensureStarted();
  return diagnostics.summary(driftThresholdPx);
}

export function resetKeyboardDiagnostics(): void {
  diagnostics.reset();
  base = EMPTY;
  started = true;
  clearRequested = true;
  if (persistHandle !== null) {
    clearTimeout(persistHandle);
    persistHandle = null;
  }
  void save();
}

/** The first use loads what the other tabs stored, by saving: the save merges both ways. */
function ensureStarted(): void {
  if (started) return;
  started = true;
  void save();
}

function schedulePersist(): void {
  if (persistHandle !== null) return;
  persistHandle = setTimeout(() => {
    persistHandle = null;
    void save();
  }, PERSIST_DELAY_MS);
}

/**
 * Saves the aggregate, merged with what the other tabs stored, in one
 * read-write transaction. One save runs at a time; a save asked for meanwhile
 * runs once the current one ends. A storage failure is counted by the package
 * and costs only the copy: what this tab counted stays owed to the next save.
 */
async function save(): Promise<void> {
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  let owed: KeyboardDiagnosticsSnapshot | null = null;
  try {
    await typingDiagnostics.write(['diagnostics'], async (transaction) => {
      const store = transaction.store('diagnostics');
      const stored = await store.get('current');
      // From here to the end of the body nothing awaits, so no tap can land
      // between the aggregate read and the aggregate written.
      if (clearRequested) {
        clearRequested = false;
        store.delete('current');
        return;
      }
      // An absent aggregate is a first save, or another tab's reset: either way
      // this tab's own counts since its last save are all there is to add.
      const merged = mergeDiagnosticsSnapshots(stored ?? EMPTY, diagnostics.snapshot(), base);
      diagnostics.adopt(merged);
      owed = stored ?? EMPTY;
      base = merged;
      store.put('current', merged);
    });
  } catch (cause) {
    if (!(cause instanceof DOMException)) throw cause;
    // What this tab now holds is the stored aggregate plus its own counts, so
    // with the stored aggregate as the base the next save adds them again.
    if (owed !== null) base = owed;
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      void save();
    }
  }
}

function isSnapshot(value: unknown): value is KeyboardDiagnosticsSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    DIAGNOSTICS_COUNTS.every((field) => isCount(candidate[field])) &&
    DIAGNOSTICS_SUMS.every((field) => isFiniteNumber(candidate[field])) &&
    DIAGNOSTICS_HISTOGRAMS.every((field) => isNumberArray(candidate[field])) &&
    Array.isArray(candidate.keys) &&
    candidate.keys.every(isKeyEntry)
  );
}

function isKeyEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.layerId === 'string' &&
    typeof entry.keyId === 'string' &&
    (entry.wide === true || entry.wide === false) &&
    DIAGNOSTICS_KEY_COUNTS.every((field) => isCount(entry[field])) &&
    DIAGNOSTICS_KEY_SUMS.every((field) => isFiniteNumber(entry[field]))
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNumber);
}
