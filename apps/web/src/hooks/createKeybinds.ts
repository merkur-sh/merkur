import { createSignal, onSettled } from 'solid-js';

import { isTextEntryTarget, type KeyLike, keyToken, resolveSequence } from '../lib/keybinds';
import { isRightMetaHeld, observeRightMeta } from '../lib/right-meta';

/**
 * The app's keyboard layer: one document listener, a registry of the scopes
 * that belong to the current route, and the help sheet and command palette
 * reading the same registry the dispatcher reads.
 *
 * The registry exists so that a binding is declared exactly once. `?` and the
 * palette render whatever is live right now rather than hand-maintained lists
 * that drift from the handlers the moment either side changes.
 *
 * Scopes are gated on the *route*, never on where focus happens to be. Every
 * screen stays mounted behind `ViewLayer` — including while the terminal is
 * open — so a focus heuristic would eventually let a bare `j` reach the device
 * list while the user meant to move down a line in vim.
 */

export interface Binding {
  /** Space-separated presses: `j`, `g d`, `rcmd+k`. */
  readonly keys: string;
  /** Shown in the help sheet, and used as the palette entry's title. */
  readonly label: string;
  run(): void;
  /**
   * Keeps the binding out of the command palette. For presses whose meaning is
   * "the thing focus is on" (`r`, `x`) or that only make sense as a key at all
   * (`j`, `k`) — the palette has no cursor to act on and closes before running.
   */
  readonly keyOnly?: boolean;
}

export interface KeybindScope {
  /** Section heading in the help sheet and the palette. */
  readonly title: string;
  /**
   * Whether this scope's route is the one on screen. Purely a route question:
   * whether keys are being *dispatched* at all is `suspendKeybinds` below, so
   * the help sheet can still show the current route's bindings while it is open.
   */
  active(): boolean;
  readonly bindings: readonly Binding[];
}

// A scope leaves the registry from its owner's cleanup, which runs while that
// owner is being disposed. Solid refuses writes from inside an owned scope
// unless the signal opts in: without this, the first screen to unmount — the
// shell on sign-out — throws mid-disposal, its layer is never removed, and the
// reactive system halts for the rest of the page.
const [scopes, setScopes] = createSignal<readonly KeybindScope[]>([], { ownedWrite: true });

/** Every registered scope, for the help sheet and the command palette. */
export const keybindScopes = scopes;

/**
 * How many surfaces own the keyboard right now. Dispatch stops while any does.
 *
 * A count, not a switch: the dialog stack and a sheet over a screen take the
 * keys independently, and one boolean written by both handed the keys back to
 * the screen when the first of them closed. A plain number, not a signal: only
 * the dispatcher reads it, once per press, and a release can run while its
 * owner is being disposed, where Solid refuses a signal write.
 */
let suspensions = 0;

/**
 * Stops dispatch until the returned release is called.
 *
 * One mechanism rather than a clause repeated in every scope's `active()`: a
 * modal surface taking the keys is a fact about the app, not about each
 * screen, and the screens must not have to agree about it.
 */
export function suspendKeybinds(): () => void {
  suspensions += 1;
  pending = '';
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    suspensions -= 1;
  };
}

/**
 * The pending chord prefix. Module state rather than per-scope, because a
 * chord is a property of the keyboard, not of whichever screen owns it — and
 * because the route can change between the `g` and the `d`.
 */
let pending = '';

/**
 * The live bindings and their keys, refilled on every press. The document
 * listener runs ahead of the terminal's own on every key typed into it, so it
 * reuses these two arrays rather than building a filtered, flattened and
 * mapped copy of the registry per keystroke. They are overwritten by index and
 * truncated only when the live set shrinks: `length = 0` would hand V8 a fresh
 * backing store on the next write, one allocation per array per press.
 */
const activeBindings: Binding[] = [];
const activeKeys: string[] = [];

function handleKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || suspensions > 0) return;
  if (isTextEntryTarget(event.target)) return;

  const token = keyToken(event as KeyLike, isRightMetaHeld());
  if (token === null) return;

  const registered = scopes();
  let live = 0;
  for (let scopeIndex = 0; scopeIndex < registered.length; scopeIndex += 1) {
    const scope = registered[scopeIndex];
    if (scope === undefined || !scope.active()) continue;
    for (let index = 0; index < scope.bindings.length; index += 1) {
      const binding = scope.bindings[index];
      if (binding === undefined) continue;
      activeBindings[live] = binding;
      activeKeys[live] = binding.keys;
      live += 1;
    }
  }
  if (activeKeys.length !== live) {
    activeBindings.length = live;
    activeKeys.length = live;
  }
  const result = resolveSequence(activeKeys, pending, token);
  pending = result.pending;

  // An incomplete chord is still ours: swallowing the `g` of `g d` stops it
  // from reaching anything else while the second press is outstanding.
  if (result.match === null) {
    if (pending !== '') event.preventDefault();
    return;
  }

  event.preventDefault();
  for (let index = 0; index < activeBindings.length; index += 1) {
    const binding = activeBindings[index];
    if (binding?.keys === result.match) {
      binding.run();
      return;
    }
  }
}

/**
 * Registers a scope for as long as the calling component is alive.
 *
 * The listener is attached by the first scope and released by the last, so a
 * signed-out app holds no keyboard state at all.
 */
export function createKeybinds(scope: KeybindScope): void {
  onSettled(() => {
    // Which ⌘ is down is part of reading a key press here, so the tracker's
    // lifetime is this listener's.
    const stopTrackingRightMeta = observeRightMeta();
    setScopes((current) => {
      if (current.length === 0) document.addEventListener('keydown', handleKeyDown);
      return [...current, scope];
    });

    return () => {
      stopTrackingRightMeta();
      // The last press's bindings may be this scope's: drop them with it, so an
      // unmounted screen is not kept reachable until the next key.
      activeBindings.length = 0;
      activeKeys.length = 0;
      setScopes((current) => {
        const next = current.filter((entry) => entry !== scope);
        if (next.length === 0) {
          document.removeEventListener('keydown', handleKeyDown);
          pending = '';
        }
        return next;
      });
    };
  });
}
