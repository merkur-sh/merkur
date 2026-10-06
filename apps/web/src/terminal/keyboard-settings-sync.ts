/**
 * Process-wide owner of the account half of the keyboard preferences.
 *
 * The account is the authority. This adopts what the account holds and
 * overwrites the local cache, then pushes every local change back. There is no
 * merge and no client timestamp to arbitrate with — a later write wins, which
 * is the whole contract for a preference one person edits on one device at a
 * time. Nothing here decides *what* to sync: {@link accountKeyboardSettings}
 * draws that line, and everything it leaves behind stays on the device that
 * measured it.
 *
 * An account that has never saved is seeded from the device in front of the
 * user rather than reset to defaults: the first device to sign in is far more
 * likely to be carrying an arrangement the user built than an empty one.
 *
 * One loop services two kinds of work — revalidating against the account, and
 * pushing what is owed to it — because they are the same decision seen from two
 * sides and interleaving them in one place is what keeps a read from landing on
 * top of an edit. It owns a fiber, so a failing network is a retry rather than a
 * lost setting, and stopping it — sign-out, or a replacement credential —
 * interrupts an in-flight request instead of letting it land under the wrong
 * account.
 */
import type { AccountKeyboardSettings } from '@merkur/shared';
import { Duration, Effect, Fiber, Latch, Schedule } from 'effect';
import { fetchAccountKeyboardSettingsEffect, saveAccountKeyboardSettingsEffect } from '../api';
import { type LifecycleRuntime, liveLifecycleRuntime } from '../lib/lifecycle-runtime';
import {
  accountKeyboardSettings,
  loadVirtualKeyboardPreferences,
  observeVirtualKeyboardPreferences,
  sameAccountKeyboardSettings,
  saveVirtualKeyboardPreferences,
  withAccountKeyboardSettings,
} from './virtual-keyboard';

/**
 * Adding a toolbar key is one change and rearranging a layer is one per swap,
 * so a single edit session is a burst. Coalescing costs the user nothing — the
 * local write already applied — and turns a rearrangement into one request.
 */
const PUSH_COALESCE_DELAY = Duration.millis(750);

/**
 * Floor between reads the browser asks for.
 *
 * The edges below fire in bursts — a tab switch raises visibility, and waking a
 * laptop raises visibility, `pageshow` and `online` within the same instant —
 * and an arrangement cannot change often enough for any of that to be worth a
 * request each. A change made on another device is still picked up the first
 * time this one is looked at, which is the case this exists for.
 */
const REVALIDATE_MIN_SPACING_MS = 15_000;

/**
 * Delay-capped and recurrence-unbounded.
 *
 * The terminating bound is ownership, not an attempt budget: this fiber lives
 * exactly as long as the credential that started it, and a network out for a
 * minute is the ordinary case an attempt budget would turn into a silently lost
 * arrangement. Capping the delay is what keeps that from being a hot loop.
 */
const BACKOFF_SCHEDULE = Schedule.jittered(
  Schedule.min([Schedule.exponential('500 millis'), Schedule.spaced('30 seconds')]),
);

/**
 * What one read attempt learned. `settings: null` is the account answering that
 * it holds nothing; a failed attempt says nothing at all, and the difference is
 * what keeps this from seeding the account out of an outage.
 */
type ReadOutcome =
  | { readonly landed: true; readonly settings: AccountKeyboardSettings | null }
  | { readonly landed: false };

let activeFiber: Fiber.Fiber<void, never> | null = null;

/**
 * Starts syncing, if it is not already running.
 *
 * Idempotent on purpose, because the caller runs on every credential *event* —
 * a sign-in and every session resume — while this belongs to the credential's
 * *lifetime*, which a resume does not end. Restarting would throw away an edit
 * the loop had not managed to send yet; the replacement would then read the
 * account, find no local edit to defer to, and revert the user's change to the
 * older value it just read. The token is read per request rather than captured,
 * so a rotation needs no restart to be picked up, and `stopKeyboardSettingsSync`
 * on the way out of a session is what ends the lifetime.
 */
export function startKeyboardSettingsSync(
  getAccessToken: () => string | null,
  runtime: LifecycleRuntime = liveLifecycleRuntime,
): void {
  if (activeFiber !== null) return;
  activeFiber = runtime.runFork(runKeyboardSettingsSync(getAccessToken, runtime.now));
}

/**
 * Ends the lifetime. The handle is dropped synchronously so a sign-in that
 * follows immediately starts a new loop, while the interruption itself lands on
 * its own fiber; an interrupted request is aborted through the signal it was
 * issued with, so nothing from the old account is still in flight to land.
 */
export function stopKeyboardSettingsSync(): void {
  const fiber = activeFiber;
  if (fiber === null) return;
  activeFiber = null;
  Effect.runFork(Fiber.interrupt(fiber));
}

const runKeyboardSettingsSync = Effect.fnUntraced(function* (
  getAccessToken: () => string | null,
  now: () => number,
) {
  /**
   * What the account is believed to hold, and the guard against the loop
   * answering its own write: adopting the account's arrangement writes local
   * storage, which raises the same change event a user edit does, and without
   * this the loop would push straight back what it had just pulled.
   */
  let known: AccountKeyboardSettings | null = null;
  /**
   * The arrangement owed to the account, or `null` when it is up to date. Held
   * rather than queued: only the newest is ever worth sending, and a retry must
   * carry the newest rather than the one that failed.
   */
  let pending: AccountKeyboardSettings | null = null;
  /** Starts armed: the first pass through the loop is the sign-in read. */
  let revalidate = true;
  let lastReadAtMs = Number.NEGATIVE_INFINITY;
  // Manual-reset latch so a burst of edits or browser edges collapses into one
  // wake. It is opened from DOM callbacks, which is why the state beside it is
  // plain closure state rather than a `Ref`.
  const wake = Latch.makeUnsafe(true);

  function requestRevalidate(): void {
    if (now() - lastReadAtMs < REVALIDATE_MIN_SPACING_MS) return;
    revalidate = true;
    Latch.openUnsafe(wake);
  }

  const onVisibilityChange = (): void => {
    if (!document.hidden) requestRevalidate();
  };
  const onPageShow = (): void => requestRevalidate();
  const onOnline = (): void => requestRevalidate();

  const stopObserving = observeVirtualKeyboardPreferences((preferences) => {
    const settings = accountKeyboardSettings(preferences);
    if (known !== null && sameAccountKeyboardSettings(known, settings)) return;
    pending = settings;
    Latch.openUnsafe(wake);
  });

  /**
   * The edges that mean "this device may have missed something".
   *
   * A change made on another device has no way to reach this one on its own —
   * there is no push channel for a preference, and inventing one for a key
   * order would cost a stream, a fan-out and a replica story to save a request
   * the user's own attention already pays for. Coming back to a tab, restoring
   * it from the back/forward cache, and regaining the network are exactly the
   * moments the answer might have changed while nobody was looking.
   */
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('online', onOnline);

  const detach = (): void => {
    stopObserving();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('online', onOnline);
  };

  const readOnce: Effect.Effect<ReadOutcome> = Effect.suspend(() => {
    const token = getAccessToken();
    // Between credentials. Indistinguishable from a failure for this purpose:
    // both mean the account has not answered.
    if (token === null) return Effect.succeed<ReadOutcome>({ landed: false });
    return fetchAccountKeyboardSettingsEffect(token).pipe(
      Effect.map((settings): ReadOutcome => ({ landed: true, settings })),
      Effect.catchCause(() => Effect.succeed<ReadOutcome>({ landed: false })),
    );
  });

  const writeOnce = (settings: AccountKeyboardSettings): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      const token = getAccessToken();
      if (token === null) return Effect.succeed(false);
      return saveAccountKeyboardSettingsEffect(token, settings).pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      );
    });

  /**
   * Reconciles this device with an answer the account actually gave.
   *
   * Leaves the latch alone: the caller re-opens it whenever this leaves work
   * owed, which is the one place that decision belongs — the loop closes the
   * latch on entry, so anything raised before this ran has already been
   * swallowed and only the caller can tell whether the loop must go round again.
   */
  function adopt(settings: AccountKeyboardSettings | null): void {
    if (pending !== null) {
      // The user rearranged the keyboard and this answer only reports what was
      // true before they did. Their edit stands: record what the account holds
      // so the push below is judged against it, and adopt nothing.
      known = settings;
      return;
    }
    const current = accountKeyboardSettings(loadVirtualKeyboardPreferences());
    if (settings === null) {
      pending = current;
      return;
    }
    known = settings;
    if (sameAccountKeyboardSettings(current, settings)) return;
    // Writes local storage, which notifies the preferences screen, every
    // mounted keyboard, and every other tab. The observer above sees it too and
    // correctly does nothing, because it now matches what the account holds.
    saveVirtualKeyboardPreferences(
      withAccountKeyboardSettings(loadVirtualKeyboardPreferences(), settings),
    );
  }

  const makeBackoffStep = Schedule.toStepWithSleep(BACKOFF_SCHEDULE);

  const sync = Effect.gen(function* () {
    let readBackoff = yield* makeBackoffStep;
    let pushBackoff = yield* makeBackoffStep;

    while (true) {
      yield* wake.await;
      yield* wake.close;

      // Reading comes first. A push decided against a stale belief about the
      // account is the one ordering that can overwrite another device's work.
      if (revalidate) {
        revalidate = false;
        const outcome = yield* readOnce;
        if (!outcome.landed) {
          // Never write without first knowing what is there: seeding or pushing
          // out of a failed read would let this device's network problem
          // overwrite another's arrangement.
          revalidate = true;
          yield* Effect.orDie(readBackoff(undefined));
          Latch.openUnsafe(wake);
          continue;
        }
        lastReadAtMs = now();
        readBackoff = yield* makeBackoffStep;
        adopt(outcome.settings);
        // Whatever this left owed — an edit the read deferred to, or an empty
        // account to seed — is only reachable through another pass, and the
        // latch was closed on entry.
        if (pending !== null) Latch.openUnsafe(wake);
        continue;
      }

      // Sample only after the quiet window, so a rearrangement sends its result
      // rather than each intermediate swap.
      yield* Effect.sleep(PUSH_COALESCE_DELAY);
      // The window may have been long enough for an edge to arrive; take the
      // read first rather than pushing against a belief it might correct.
      if (revalidate) {
        Latch.openUnsafe(wake);
        continue;
      }
      const next = pending;
      if (next === null) continue;
      if (known !== null && sameAccountKeyboardSettings(known, next)) {
        pending = null;
        continue;
      }

      if (yield* writeOnce(next)) {
        known = next;
        // A newer edit may have arrived mid-flight; it is already latched, and
        // clearing it here would drop it.
        if (pending === next) pending = null;
        pushBackoff = yield* makeBackoffStep;
        continue;
      }

      // Leave `pending` alone and come back: the next attempt then carries
      // whatever the newest arrangement is by then, not the one that failed.
      yield* Effect.orDie(pushBackoff(undefined));
      Latch.openUnsafe(wake);
    }
  });

  // Interruption is the ordinary way this loop ends, so detaching anywhere but
  // here would leak four listeners on every sign-out.
  yield* Effect.ensuring(sync, Effect.sync(detach));
});
