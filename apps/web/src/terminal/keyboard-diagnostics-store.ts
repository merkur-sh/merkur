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
 * A finished line's corrected misses also go to the offset learner: the user
 * retyping a neighbour in a tap's place is the one label for that tap that is
 * not the decoder's own guess.
 */
import { guarded, localValue } from '@merkur/browser-storage';
import type {
  KeyboardKeyDefinition,
  KeyboardTouchTrace,
  ResolvedKeyboardGeometry,
} from '@merkur/keyboard';
import {
  createKeyboardDiagnostics,
  type KeyboardDiagnosticsSnapshot,
  type KeyboardDiagnosticsSummary,
} from './keyboard-diagnostics';
import { recordKeyboardOffsetCorrection } from './keyboard-offset-store';

/** A corrupt or unreadable snapshot is disposable: the statistics start from empty. */
const storedDiagnostics = localValue('merkur.terminal.typingDiagnostics', guarded(isSnapshot));
/** Writing on every keystroke would put JSON serialisation on the typing path. */
const PERSIST_DELAY_MS = 4_000;

const diagnostics = createKeyboardDiagnostics({ onCorrection: recordKeyboardOffsetCorrection });
let persistHandle: ReturnType<typeof setTimeout> | null = null;
let loaded = false;

export function recordKeyboardTouch(
  trace: KeyboardTouchTrace,
  geometry: ResolvedKeyboardGeometry | null,
): void {
  ensureLoaded();
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
  ensureLoaded();
  if (diagnostics.recordCommit(key, pointerId, repeat)) schedulePersist();
}

/**
 * The line ended outside the keyboard's own commits: a chord, a toolbar key,
 * input from elsewhere, or the keyboard going away. Cheap when no line is open,
 * which is every hardware keystroke on a desktop.
 */
export function recordKeyboardBreak(): void {
  ensureLoaded();
  if (diagnostics.recordBreak()) schedulePersist();
}

export function keyboardDiagnosticsSummary(driftThresholdPx: number): KeyboardDiagnosticsSummary {
  ensureLoaded();
  return diagnostics.summary(driftThresholdPx);
}

export function resetKeyboardDiagnostics(): void {
  diagnostics.reset();
  loaded = true;
  if (persistHandle !== null) {
    clearTimeout(persistHandle);
    persistHandle = null;
  }
  storedDiagnostics.remove();
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const stored = storedDiagnostics.read();
  if (stored !== null) diagnostics.restore(stored);
}

function schedulePersist(): void {
  if (persistHandle !== null) return;
  persistHandle = setTimeout(() => {
    persistHandle = null;
    // Quota or private mode loses only the copy; the in-memory statistics are still valid.
    storedDiagnostics.write(diagnostics.snapshot());
  }, PERSIST_DELAY_MS);
}

const SNAPSHOT_COUNTS = [
  'taps',
  'uncommitted',
  'interTapCount',
  'fastDriftCount',
  'slowDriftCount',
  'lines',
  'missesByPrior',
  'priorOverrides',
  'priorOverridesKept',
  'priorOverridesErased',
  'priorOverridesMisread',
  'priorOverridesDeleted',
  'priorOverridesReplaced',
  'extraUntraced',
] as const;
const SNAPSHOT_SUMS = [
  'driftSum',
  'durationSum',
  'sampleSum',
  'interTapSum',
  'fastDriftSum',
  'slowDriftSum',
  'extraRepeatGapSum',
  'keptDoubleGapSum',
] as const;
const SNAPSHOT_HISTOGRAMS = [
  'drift',
  'duration',
  'samples',
  'interTap',
  'extraRepeatGap',
  'keptDoubleGap',
  'typedDrift',
  'missDrift',
  'noticed',
] as const;
const KEY_COUNTS = [
  'count',
  'residualCount',
  'aimed',
  'missed',
  'took',
  'erasedCorrect',
  'replaced',
  'extra',
  'skipped',
] as const;
const KEY_SUMS = [
  'sumX',
  'sumY',
  'sumXX',
  'sumYY',
  'sumXY',
  'sumResidualX',
  'sumResidualY',
] as const;

function isSnapshot(value: unknown): value is KeyboardDiagnosticsSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    SNAPSHOT_COUNTS.every((field) => isCount(candidate[field])) &&
    SNAPSHOT_SUMS.every((field) => isFiniteNumber(candidate[field])) &&
    SNAPSHOT_HISTOGRAMS.every((field) => isNumberArray(candidate[field])) &&
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
    KEY_COUNTS.every((field) => isCount(entry[field])) &&
    KEY_SUMS.every((field) => isFiniteNumber(entry[field]))
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
