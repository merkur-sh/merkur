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

const STORAGE_KEY = 'merkur.terminal.typingDiagnostics';
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
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private-mode storage failures must not break typing.
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    if (isSnapshot(parsed)) diagnostics.restore(parsed);
  } catch {
    // A corrupt or unreadable snapshot is disposable; start from empty.
  }
}

function schedulePersist(): void {
  if (persistHandle !== null) return;
  persistHandle = setTimeout(() => {
    persistHandle = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(diagnostics.snapshot()));
    } catch {
      // Quota or private mode; the in-memory statistics are still valid.
    }
  }, PERSIST_DELAY_MS);
}

function isSnapshot(value: unknown): value is KeyboardDiagnosticsSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isCount(candidate.taps) &&
    isCount(candidate.uncommitted) &&
    isFiniteNumber(candidate.driftSum) &&
    isFiniteNumber(candidate.durationSum) &&
    isFiniteNumber(candidate.sampleSum) &&
    isNumberArray(candidate.drift) &&
    isNumberArray(candidate.duration) &&
    isNumberArray(candidate.samples) &&
    isNumberArray(candidate.interTap) &&
    isFiniteNumber(candidate.interTapSum) &&
    isCount(candidate.interTapCount) &&
    isFiniteNumber(candidate.fastDriftSum) &&
    isCount(candidate.fastDriftCount) &&
    isFiniteNumber(candidate.slowDriftSum) &&
    isCount(candidate.slowDriftCount) &&
    isCount(candidate.lines) &&
    isCount(candidate.missesByPrior) &&
    isCount(candidate.priorOverrides) &&
    isCount(candidate.priorOverridesKept) &&
    isNumberArray(candidate.typedDrift) &&
    isNumberArray(candidate.missDrift) &&
    isNumberArray(candidate.noticed) &&
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
    isCount(entry.count) &&
    isFiniteNumber(entry.sumX) &&
    isFiniteNumber(entry.sumY) &&
    isFiniteNumber(entry.sumXX) &&
    isFiniteNumber(entry.sumYY) &&
    isFiniteNumber(entry.sumXY) &&
    isCount(entry.residualCount) &&
    isFiniteNumber(entry.sumResidualX) &&
    isFiniteNumber(entry.sumResidualY) &&
    isCount(entry.aimed) &&
    isCount(entry.missed) &&
    isCount(entry.took) &&
    isCount(entry.erasedCorrect) &&
    isCount(entry.replaced) &&
    isCount(entry.extra) &&
    isCount(entry.skipped)
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
