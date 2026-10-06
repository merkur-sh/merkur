/**
 * Process-wide owner of the learned per-key offsets.
 *
 * Portrait and landscape are kept apart because they are different postures:
 * the same person holds the phone differently and aims differently, so pooling
 * them would average two real biases into one wrong one.
 */
import {
  createKeyboardOffsetModel,
  isKeyboardOffsetSnapshot,
  type KeyboardTouchModel,
  type KeyboardTouchTrace,
  keyboardOrientation,
  type ResolvedKeyboardGeometry,
} from '@merkur/keyboard';

export type KeyboardOrientation = 'portrait' | 'landscape';

const STORAGE_KEY = 'merkur.terminal.typingOffsets';
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
let loaded = false;
const listeners = new Set<() => void>();

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
  ensureLoaded();
  if (!models[orientationFor(geometry)].record(trace, geometry)) return false;
  schedulePersist();
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
  ensureLoaded();
  if (!models[orientationFor(geometry)].recordCorrection(trace, geometry, intendedKeyId)) return;
  schedulePersist();
  sinceApply += 1;
  if (sinceApply < APPLY_INTERVAL_TAPS) return;
  sinceApply = 0;
  for (const listener of listeners) listener();
}

/** Applies the learned offsets for the current orientation on top of `base`. */
export function applyKeyboardOffsets(
  geometry: ResolvedKeyboardGeometry,
  base: KeyboardTouchModel,
): KeyboardTouchModel {
  ensureLoaded();
  return models[orientationFor(geometry)].apply(geometry, base);
}

/**
 * Keys with learned evidence across both postures. Summed rather than reported
 * per orientation because the caller is a settings screen with no keyboard
 * geometry to derive one from, and guessing an orientation from the window is
 * exactly the disagreement `orientationFor` exists to prevent.
 */
export function learnedKeyboardOffsetCount(): number {
  ensureLoaded();
  return models.portrait.learnedKeyCount() + models.landscape.learnedKeyCount();
}

/**
 * Fires whenever a mounted keyboard must re-apply its touch model outside a
 * trace: when a line's corrections bring the apply cadence due, and after the
 * models are wiped. Without the second, a reset from the settings screen
 * reached the live engine only on the 25th accepted tap after it — the stale
 * personalised model kept deciding keystrokes the user had just asked to
 * forget.
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
  for (const listener of listeners) listener();
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return;
    // A pre-grip-field snapshot has no field block and fails the guard, which
    // is the intended hard cutover: it is discarded, not migrated.
    if (isKeyboardOffsetSnapshot(parsed.portrait)) models.portrait.restore(parsed.portrait);
    if (isKeyboardOffsetSnapshot(parsed.landscape)) models.landscape.restore(parsed.landscape);
  } catch {
    // A corrupt snapshot is disposable; relearning costs a few hundred taps.
  }
}

function schedulePersist(): void {
  if (persistHandle !== null) return;
  persistHandle = setTimeout(() => {
    persistHandle = null;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          portrait: models.portrait.snapshot(),
          landscape: models.landscape.snapshot(),
        }),
      );
    } catch {
      // Quota or private mode; the in-memory model is still valid.
    }
  }, PERSIST_DELAY_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
