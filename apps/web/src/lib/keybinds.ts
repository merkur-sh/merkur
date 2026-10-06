/**
 * Key resolution for the app's vim-style bindings.
 *
 * Split the way `focus-trap.ts` is: the sequence machine and the token
 * normalizer are pure, so they are tested without a document, and the DOM
 * adapter (`hooks/createKeybinds.ts`) stays thin.
 *
 * Arrow keys are deliberately absent. `j`/`k` are the navigation keys on every
 * surface, and a second way to do the same thing is a second thing that has to
 * keep working.
 */

/** The parts of a `KeyboardEvent` this layer reads. */
export interface KeyLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * The canonical token for a key press, or `null` for a press this layer never
 * binds.
 *
 * Shift folds into the character (`G`, `?`) rather than becoming a prefix,
 * because that is how the bindings read and how the help sheet prints them.
 *
 * `rcmd` is the *right* ⌘ specifically — `rightMeta` comes from
 * `lib/right-meta.ts`, since the event itself cannot say which side is down.
 * Binding one side leaves the other alone, so left ⌘ combinations still reach
 * the browser, the OS, and the terminal's own Alt mapping.
 *
 * Left ⌘ and bare Ctrl+letter are deliberately not bindable here: Ctrl+K is
 * readline's kill-to-end-of-line, and `ctrl+` tokens exist only so the command
 * palette can move its cursor while its query field holds focus.
 */
export function keyToken(event: KeyLike, rightMeta: boolean): string | null {
  if (event.altKey) return null;
  if (event.metaKey) {
    return rightMeta && event.key.length === 1 ? `rcmd+${event.key.toLowerCase()}` : null;
  }
  if (event.ctrlKey) {
    return !event.shiftKey && event.key.length === 1 ? `ctrl+${event.key.toLowerCase()}` : null;
  }
  return event.key;
}

/**
 * The outcome of feeding one token to a binding table.
 *
 * `match` is the bound key string to run, and `pending` is the prefix to carry
 * into the next press. A result with neither is an unhandled key, which the
 * caller must leave to the browser.
 */
export interface SequenceResult {
  readonly match: string | null;
  readonly pending: string;
}

const UNHANDLED: SequenceResult = { match: null, pending: '' };

/**
 * Resolve one token against a binding table, carrying the pending prefix of a
 * chord such as `g d`.
 *
 * A prefix that no longer leads anywhere restarts with the new token rather
 * than swallowing it, so `g` then `j` moves down instead of eating the press.
 * That retry is what makes a mistyped chord cost one key instead of two.
 */
export function resolveSequence(
  boundKeys: readonly string[],
  pending: string,
  token: string,
): SequenceResult {
  const candidate = pending === '' ? token : `${pending} ${token}`;
  if (boundKeys.includes(candidate)) return { match: candidate, pending: '' };
  // Indexed, and `continuesChord` rather than `startsWith(`${candidate} `)`:
  // this runs on every key the terminal receives, and neither a callback nor a
  // string per binding is needed to ask it.
  for (let index = 0; index < boundKeys.length; index += 1) {
    const keys = boundKeys[index];
    if (keys !== undefined && continuesChord(keys, candidate)) {
      return { match: null, pending: candidate };
    }
  }
  if (pending !== '') return resolveSequence(boundKeys, '', token);
  return UNHANDLED;
}

/**
 * Whether `keys` is `candidate` followed by a space: a longer chord it begins.
 * `charCodeAt` past the end is NaN, so a binding no longer than the candidate
 * fails the first test.
 */
function continuesChord(keys: string, candidate: string): boolean {
  return keys.charCodeAt(candidate.length) === 0x20 && keys.startsWith(candidate);
}

/**
 * Whether a key press belongs to the thing the user is typing into.
 *
 * Every binding here is a bare letter, so this is the guard that keeps `j`
 * a `j` inside the rename field, the box id, and the password inputs.
 *
 * The terminal's editing surface is exempt. It is a focused `<textarea>` only
 * so IME composition has somewhere to attach — it is the terminal, not a field
 * of the app — and treating it as one left the terminal as the single route
 * `rcmd+k` could not be pressed from. Nothing bare is bindable there: the
 * terminal route activates only `rcmd+`-prefixed scopes ("Anywhere" and
 * "Terminal"), so a key the shell is waiting for still reaches it.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.dataset.terminalHiddenInput === 'true') return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Where a walk over focus targets lands, wrapping at both ends.
 *
 * A `currentIndex` of -1 means focus is not on the list at all, so the first
 * `j` after a screen opens enters at the top and the first `k` at the bottom.
 */
export function stepIndex(count: number, currentIndex: number, delta: 1 | -1): number | null {
  if (count === 0) return null;
  if (currentIndex < 0) return delta === 1 ? 0 : count - 1;
  return (currentIndex + delta + count) % count;
}

/**
 * A binding's keys as they should be shown to the reader.
 *
 * `rcmd` names the side explicitly, because "⌘K" would send the reader to the
 * wrong key half the time. Chords keep their space, so `g d` reads as the two
 * presses it is.
 */
export function formatKeys(keys: string): string {
  return keys
    .split(' ')
    .map((token) =>
      token.startsWith('rcmd+')
        ? `right ⌘ ${token.slice(5).toUpperCase()}`
        : token.startsWith('ctrl+')
          ? `Ctrl+${token.slice(5).toUpperCase()}`
          : token,
    )
    .join(' ');
}
