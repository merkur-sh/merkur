/**
 * Which side of the keyboard the held ⌘ and Option are on.
 *
 * `KeyboardEvent.location` describes the key that *fired* the event, so a `k`
 * keydown carries `metaKey: true` and location 0 no matter which ⌘ is down —
 * and `getModifierState('Meta')` does not distinguish sides either. The only
 * way to know is to watch the modifier's own keydown and keyup and remember.
 * Option is the same: on Apple keyboards the right one composes text (é, @ on
 * German layouts) while the left one is the terminal's Alt, and the
 * character's keydown cannot say which of the two is held.
 *
 * Held in module-level booleans rather than signals: the readers are the
 * keyboard dispatcher and the terminal's per-keystroke fast path, and neither
 * wants a subscription or an allocation to ask the question.
 */

let metaHeld = false;
let altHeld = false;
let observers = 0;

const RIGHT = 2; // KeyboardEvent.DOM_KEY_LOCATION_RIGHT

function onKeyDown(event: KeyboardEvent): void {
  // A left key pressed after a right one takes over, so a two-handed roll ends
  // up meaning what the last press said rather than staying latched right.
  if (event.key === 'Meta') metaHeld = event.location === RIGHT;
  else if (event.key === 'Alt') altHeld = event.location === RIGHT;
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.location !== RIGHT) return;
  if (event.key === 'Meta') metaHeld = false;
  else if (event.key === 'Alt') altHeld = false;
}

/**
 * A keyup delivered to another window never arrives here, which would leave
 * the flag latched across a tab switch taken mid-chord.
 */
function onBlur(): void {
  metaHeld = false;
  altHeld = false;
}

/**
 * Starts tracking, and stops when the last observer disposes. Reference
 * counted because both the keyboard dispatcher and the terminal input
 * controller need the answer and neither owns the other's lifetime.
 *
 * Capture phase, so the flag is already current by the time either reader's
 * own keydown handler runs.
 */
export function observeRightMeta(): () => void {
  observers += 1;
  if (observers === 1) {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    observers -= 1;
    if (observers > 0) return;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    metaHeld = false;
    altHeld = false;
  };
}

export function isRightMetaHeld(): boolean {
  return metaHeld;
}

export function isRightAltHeld(): boolean {
  return altHeld;
}
