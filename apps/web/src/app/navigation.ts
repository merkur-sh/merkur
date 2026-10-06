import { type Accessor, createSignal } from 'solid-js';

/**
 * Navigation state for the whole app.
 *
 * This exists because the single `UiState` enum it replaces conflated two
 * independent facts: which screen is shown, and what the terminal transport is
 * doing. `CONNECTING` was both "still on the device list" and "a connect
 * attempt is in flight", so every screen predicate was a memo untangling the
 * two and nothing could ask a straight question like "can I go back?".
 *
 * Three orthogonal pieces of state, each with one owner:
 *
 * - `phase` — which of the three mutually exclusive app phases is mounted.
 * - `stack` — the route history within the shell. `route()` is its top.
 * - `connection` — what the terminal transport is doing, independent of route.
 *
 * Deliberately no DOM access: this module is pure state so it stays testable
 * without a document. Screens and body attributes are rendered from it, never
 * written by it.
 */

export type AppPhase = 'bootstrapping' | 'auth' | 'shell';

/**
 * Settings is one screen with four tabs rather than four screens.
 *
 * Terminal and Keyboard used to be one long page and Sessions a second, so
 * moving between two settings meant leaving one screen and entering another.
 * The tab is part of the route because it is where the reader is, and because
 * switching tabs must replace the route rather than push one — Escape belongs
 * to Settings as a whole, not to the tab that happens to be showing.
 */
export type SettingsTab = 'terminal' | 'keyboard' | 'sessions' | 'account';

export const SETTINGS_TABS: readonly SettingsTab[] = [
  'terminal',
  'keyboard',
  'sessions',
  'account',
];

export type Route =
  | { readonly k: 'devices' }
  | { readonly k: 'terminal'; readonly deviceId: string }
  | { readonly k: 'settings'; readonly tab: SettingsTab };

export type ConnectionStatus = 'idle' | 'connecting' | 'signaling' | 'connected' | 'disconnected';

/**
 * Modal surfaces, stacked over whatever route is showing.
 *
 * Deliberately a separate stack from the routes: Escape must close a dialog
 * before it leaves a screen, and route history must never replay a dialog.
 * Entries are compared by identity, so the host can tell an unchanged overlay
 * from a re-pushed one.
 */
export type Overlay =
  | { readonly k: 'device-action'; readonly action: 'rename' | 'remove'; readonly deviceId: string }
  | { readonly k: 'create-box' }
  /** `code` is set when the dialog was opened from a `/link#<code>` address. */
  | { readonly k: 'link-approval'; readonly code: string | null }
  | { readonly k: 'command-palette' }
  | { readonly k: 'keyboard-help' }
  | { readonly k: 'session-ended' };

/**
 * The route the shell always falls back to. `pop()` never empties the stack,
 * so there is no "no route" state to render around.
 */
const DEVICES: Route = { k: 'devices' };

export interface Navigation {
  readonly phase: Accessor<AppPhase>;
  readonly route: Accessor<Route>;
  readonly connection: Accessor<ConnectionStatus>;
  readonly overlays: Accessor<readonly Overlay[]>;
  /**
   * Leave the shell for the login screen. Resets the stack so a later login
   * does not resume the previous account's route.
   *
   * Resolves once the phase that was showing has left the screen — the moment
   * `PhaseHost` reports through `departed` — or at once when nothing had to
   * leave. Signing out waits on it before it drops the account: the shell must
   * stay whole until it is gone, or the last frame the user sees of it, and
   * the old snapshot the sign-out transition carries, is a list already
   * emptied by the teardown.
   */
  enterAuth(): Promise<void>;
  /**
   * A phase layer has left the screen. Called by whatever mounts the phases;
   * settles every `enterAuth` that was waiting for it.
   */
  departed(): void;
  /**
   * Enter the shell at the device list. Idempotent, so the several paths that
   * finish by loading devices can all call it without checking where they were.
   */
  enterShell(): void;
  push(route: Route): void;
  /**
   * Swaps the route on top of the stack. Moving between settings tabs is a move
   * within one screen, so it must not deepen the history the way `push` does.
   */
  replace(route: Route): void;
  /** Pops to the parent route; bottoms out at the device list. */
  pop(): void;
  setConnection(next: ConnectionStatus): void;
  pushOverlay(overlay: Overlay): void;
  /** Closes the topmost overlay. Safe to call when none is open. */
  popOverlay(): void;
}

export function createNavigation(): Navigation {
  const [phase, setPhase] = createSignal<AppPhase>('bootstrapping');
  const [stack, setStack] = createSignal<readonly Route[]>([DEVICES]);
  const [connection, writeConnection] = createSignal<ConnectionStatus>('idle');
  const [overlays, setOverlays] = createSignal<readonly Overlay[]>([]);

  // A derived read, not a memo: `.at(-1)` is cheaper than the memo bookkeeping
  // that would cache it, and staying memo-free keeps this module meaningful
  // under Solid's server build, which evaluates a memo once and never again.
  const route: Accessor<Route> = () => stack().at(-1) ?? DEVICES;
  /**
   * Callers of `enterAuth` waiting for the previous phase to leave. A plain
   * mirror of the phase decides whether there is anything to wait for: the
   * signal itself shows a write only after the queue drains, so two calls in
   * one tick would both read the phase they started from.
   */
  let departures: Array<() => void> = [];
  let showing: AppPhase = 'bootstrapping';

  return {
    phase,
    route,
    connection,
    overlays,
    enterAuth() {
      const leaving = showing !== 'auth';
      showing = 'auth';
      setPhase('auth');
      setStack([DEVICES]);
      writeConnection('idle');
      // A dialog must never survive logout onto the login screen.
      setOverlays([]);
      if (!leaving) return Promise.resolve();
      return new Promise<void>((resolve) => {
        departures.push(resolve);
      });
    },
    departed() {
      const waiting = departures;
      departures = [];
      for (const resolve of waiting) resolve();
    },
    enterShell() {
      showing = 'shell';
      setPhase('shell');
      setStack([DEVICES]);
      writeConnection('idle');
      // Overlays are deliberately untouched: the paths that land here include
      // "a dialog just finished its work and is reloading the list", and that
      // dialog closes itself when its own submit resolves.
    },
    push(next) {
      setStack((current) => [...current, next]);
    },
    replace(next) {
      setStack((current) => [...current.slice(0, -1), next]);
    },
    pop() {
      setStack((current) => (current.length <= 1 ? current : current.slice(0, -1)));
    },
    setConnection(next) {
      writeConnection(next);
    },
    pushOverlay(overlay) {
      setOverlays((current) => [...current, overlay]);
    },
    popOverlay() {
      setOverlays((current) => current.slice(0, -1));
    },
  };
}
