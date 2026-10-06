import type { DeviceEventsCursor } from '@merkur/shared';
import { Data, Duration, Effect, Latch, Queue, Ref, Schedule, type Scope, Stream } from 'effect';
import type * as AsyncResult from 'effect/unstable/reactivity/AsyncResult';
import * as Atom from 'effect/unstable/reactivity/Atom';
import { AtomRegistry } from 'effect/unstable/reactivity/AtomRegistry';
import { isApiError } from '../lib/api-error';
import type { NetworkChangeEvent } from '../session/network-monitor';
import {
  applyDeviceDelta,
  applyDeviceResume,
  applyDeviceSnapshot,
  browserPresenceAtom,
  browserSessionsChangedAtom,
  type DeviceEventsIo,
  deviceCursorAtom,
  deviceEventsAttemptsAtom,
  deviceEventsDeliveredAtom,
  deviceEventsIoAtom,
  deviceEventsRejectedTokenAtom,
  deviceEventsRotatedTokenAtom,
  deviceEventsStreamFailureAtom,
  deviceEventsTokenAtom,
  forgetDeviceEventsCursor,
  hasDeviceSnapshotAtom,
  publishDeviceEventsError,
  releaseDeviceEventsBoot,
  retireDeviceEventsAttempt,
} from './device-events-atoms';
import {
  createDeviceEventsReconnectSchedule,
  shouldForceResumeReconnect,
} from './device-events-reconnect';
import { type DeviceStreamEvent, deviceEventStream } from './device-events-source';

// iOS freezes a backgrounded PWA's fetch stream instead of erroring it, so a
// resumed app can sit on a silently dead SSE stream that never reaches the
// failure path. After this much hidden time, assume the stream is dead on
// resume and rebuild it immediately with the current credential.
const RESUME_STALE_HIDDEN_MS = 5_000;

const OFFLINE_MESSAGE = 'Offline. Waiting for the network...';
const DISCONNECTED_MESSAGE = 'Live machine updates disconnected. Reconnecting...';
const REFRESH_FAILED_MESSAGE = 'Session refresh failed. Waiting for authentication to recover...';

class DeviceEventsRefreshRejected extends Data.TaggedError('DeviceEventsRefreshRejected')<{
  readonly cause: unknown;
}> {}

class DeviceEventsSessionEnded extends Data.TaggedError('DeviceEventsSessionEnded')<
  Record<string, never>
> {}

/** A delta arrived whose predecessor never did. */
class DeviceStreamGap extends Data.TaggedError('DeviceStreamGap')<{
  readonly expected: number;
  readonly received: number;
}> {}

/**
 * A `resume` arrived for a cursor this browser never offered.
 *
 * `resume` is the strongest claim in this protocol — "everything you are
 * holding is current" — and the only thing that makes it checkable is that it
 * must name the exact cursor the request carried. Adopting one that does not is
 * how a list would come to vouch for itself: the held rows keep rendering, and
 * the cursor they are now stamped with is one nothing ever confirmed.
 */
class DeviceStreamUnsolicitedResume extends Data.TaggedError('DeviceStreamUnsolicitedResume')<{
  readonly offered: DeviceEventsCursor | null;
  readonly received: DeviceEventsCursor;
}> {}

/**
 * A browser signal that may mean the current stream is dead. Raw, timestamped,
 * and undeduplicated: classification needs the recovery state, and that state
 * lives in `Ref`s owned by the loop, not in the DOM callback.
 */
type BrowserEdge =
  | { readonly _tag: 'network'; readonly kind: NetworkChangeEvent['kind'] }
  | { readonly _tag: 'visibility'; readonly hidden: boolean; readonly atMs: number }
  | { readonly _tag: 'pageshow'; readonly persisted: boolean };

/**
 * What the loop should do after one stream lifetime ends.
 *
 * `wake` is not produced by an attempt: it is the recovery latch winning the
 * race against one, which interrupts the attempt and its `AbortController`
 * along with it.
 */
type AttemptOutcome = 'reconnect' | 'backoff' | 'park' | 'wake' | 'unauthorized';

/**
 * The device-events recovery loop for one credential lifetime.
 *
 * Everything the old callback design guarded with generation counters is
 * structural here: one fiber owns the sequence, so an interrupted attempt
 * cannot resume into a replacement's state, and every piece of recovery state
 * is a `Ref` scoped to this run rather than a closure variable that a stale
 * callback could still reach.
 *
 * The loop never fails. Transport errors and an offline network are recovery
 * inputs. A definitive authentication rejection after refresh ends this
 * lifetime and asks the app to clear the account and return to login.
 */
export const runDeviceEventsRecovery = Effect.fnUntraced(function* (
  token: string,
  io: DeviceEventsIo,
) {
  const registry = yield* AtomRegistry;

  const activeToken = yield* Ref.make(token);
  // A refresh is a one-use mutation of a rotating credential. It is spent on
  // the first 401 of a stream lifetime and only re-armed by proof the endpoint
  // accepts the credential (an `open`), or by a deduplicated recovery edge for
  // the exact token the failed refresh was spent on.
  const refreshUsed = yield* Ref.make(false);
  const refreshRecoveryToken = yield* Ref.make<string | null>(null);
  const offline = yield* Ref.make(io.isNetworkOffline());
  const lastResumeAtMs = yield* Ref.make<number | null>(null);
  const hiddenAtMs = yield* Ref.make<number | null>(null);
  // Monotonic instant of the last byte this attempt saw, armed before the fetch
  // so a request that never answers is bounded by the same deadline as one that
  // opened and went quiet.
  const lastActivityAtMs = yield* Ref.make(performance.now());
  // The cursor this attempt asked to resume from, so the answer can be checked
  // against the question.
  const offeredCursor = yield* Ref.make<DeviceEventsCursor | null>(null);
  // Whether this attempt ever got response headers. It is what separates a
  // request the endpoint never answered from one it answered and then said
  // nothing on, and only the browser can tell the two apart.
  const attemptOpened = yield* Ref.make(false);
  // Whether the stall deadline is what ended this attempt, as opposed to a
  // browser recovery edge. Both preempt the attempt through the same latch, and
  // only one of them is a fault worth reporting.
  const attemptStalled = yield* Ref.make(false);
  // Whether this attempt was ended by something other than the endpoint: a 401
  // is an answer, and an abort is this browser's own doing. Neither is an
  // attempt nobody answered.
  const attemptRefused = yield* Ref.make(false);
  /**
   * Failures since this lifetime last delivered a frame.
   *
   * "Disconnected" is a claim about something that was connected, and the
   * fallback schedule's own policy is that a stream which just failed is worth
   * one immediate retry — so announcing the first failure announces a fault the
   * loop already expects to resolve before anyone can read it. A page opening
   * its first stream onto a connection the page it replaced was still closing
   * fails exactly once, which is how a reload came to flash a disconnection
   * notice for a stream that had never connected.
   */
  const failuresSinceDelivery = yield* Ref.make(0);
  const stallTimeoutMs = Duration.toMillis(io.stallTimeout);

  const makeReconnectStep = Schedule.toStepWithSleep(
    createDeviceEventsReconnectSchedule(io.reconnectRandom),
  );
  const reconnectStep = yield* Ref.make(yield* makeReconnectStep);
  // Resetting the fallback schedule is re-deriving its step. A new lifetime, a
  // delivered snapshot, a rotated credential, and a recovery edge all start
  // from the immediate first recurrence rather than the current ceiling.
  const resetReconnectSchedule = Effect.flatMap(makeReconnectStep, (step) =>
    Ref.set(reconnectStep, step),
  );

  // A manual-reset latch, not a signal queue: it is closed at exactly one
  // point per iteration, immediately before the state it guards is read, so an
  // edge raised while the loop is between waits still preempts the next one.
  const wake = yield* Latch.make(false);
  const edges = yield* Queue.unbounded<BrowserEdge>();

  const forceResume = Effect.fnUntraced(function* () {
    if (yield* Ref.get(offline)) return;
    const current = yield* Ref.get(activeToken);
    // A failed refresh can have been caused by the stream opened from the
    // previous recovery edge. Let its token-scoped latch consume exactly one
    // edge even inside the general resume dedupe window; clearing the latch
    // below makes the rest of the browser event burst obey normal dedupe.
    const refreshRecoveryArmed = (yield* Ref.get(refreshRecoveryToken)) === current;
    const nowMs = performance.now();
    if (
      !refreshRecoveryArmed &&
      !shouldForceResumeReconnect(nowMs, yield* Ref.get(lastResumeAtMs))
    ) {
      return;
    }
    yield* Ref.set(lastResumeAtMs, nowMs);
    if (refreshRecoveryArmed) {
      yield* Ref.set(refreshUsed, false);
      yield* Ref.set(refreshRecoveryToken, null);
    }
    yield* resetReconnectSchedule;
    yield* wake.open;
  });

  const handleEdge = Effect.fnUntraced(function* (edge: BrowserEdge) {
    if (edge._tag === 'visibility') {
      if (edge.hidden) {
        yield* Ref.set(hiddenAtMs, edge.atMs);
        return;
      }
      const hiddenAt = yield* Ref.getAndSet(hiddenAtMs, null);
      if (hiddenAt === null || edge.atMs - hiddenAt < RESUME_STALE_HIDDEN_MS) return;
      yield* forceResume();
      return;
    }
    if (edge._tag === 'pageshow') {
      // bfcache restore: the stream from the frozen page is dead for sure.
      if (edge.persisted) yield* forceResume();
      return;
    }
    if (edge.kind === 'offline') {
      yield* Ref.set(offline, true);
      yield* wake.open;
      return;
    }
    const wasOffline = yield* Ref.getAndSet(offline, false);
    // Recovery from a real outage is not part of the ordinary event burst
    // `RESUME_RECONNECT_DEDUPE_MS` exists to swallow.
    if (wasOffline) yield* Ref.set(lastResumeAtMs, null);
    yield* forceResume();
  });

  const onStreamEvent = Effect.fnUntraced(function* (event: DeviceStreamEvent) {
    // Bytes prove the socket. They do not prove the stream, and until the
    // opening frame arrives those are different claims: the server writes 2 KiB
    // of anti-buffering padding before it knows anything, and its keep-alive
    // comments run from the moment it believes it has written that frame. An
    // attempt that opened and never delivered was therefore held alive forever
    // by exactly the bytes that say nothing about whether it ever will — no
    // stall, no reconnect, no error, and a list left refreshing against a
    // socket in perfect health. So before the frame, only the frame extends
    // this attempt; after it, every byte does, which is what a quiet healthy
    // stream needs.
    if (
      registry.get(deviceEventsDeliveredAtom) ||
      event._tag === 'snapshot' ||
      event._tag === 'resume' ||
      event._tag === 'delta'
    ) {
      yield* Ref.set(lastActivityAtMs, performance.now());
    }
    if (event._tag === 'session-ended') {
      yield* Ref.set(attemptRefused, true);
      return yield* new DeviceEventsSessionEnded({});
    }
    if (event._tag === 'activity') return;
    if (event._tag === 'browser-presence') {
      registry.set(browserPresenceAtom, event.frame.activeDelegationIds);
      return;
    }
    if (event._tag === 'sessions-changed') {
      registry.set(browserSessionsChangedAtom, registry.get(browserSessionsChangedAtom) + 1);
      return;
    }
    if (event._tag === 'open') {
      yield* Ref.set(attemptOpened, true);
      // HTTP 200 proves this credential is accepted. A future 401 may
      // therefore spend one new refresh mutation.
      yield* Ref.set(refreshUsed, false);
      yield* Ref.set(refreshRecoveryToken, null);
      publishDeviceEventsError(registry, '');
      return;
    }
    if (event._tag === 'delta') {
      const cursor = registry.get(deviceCursorAtom);
      // A delta before the frame that opens a stream has no cursor to advance,
      // which is the same hole as a missing predecessor and is answered the
      // same way rather than dropped: a dropped delta would leave the list
      // stale behind a badge that says it is live.
      if (cursor === null) {
        return yield* new DeviceStreamGap({ expected: 0, received: event.frame.seq });
      }
      // Absolute deltas make a repeat harmless; a hole is not. Something
      // between the held sequence and this frame never arrived, so this
      // lifetime ends and the reopen's `since` lets the server decide between
      // a snapshot and a resume.
      if (event.frame.seq <= cursor.seq) return;
      if (event.frame.seq !== cursor.seq + 1) {
        return yield* new DeviceStreamGap({
          expected: cursor.seq + 1,
          received: event.frame.seq,
        });
      }
      applyDeviceDelta(registry, cursor.epoch, event.frame);
      publishDeviceEventsError(registry, '');
      return;
    }
    // A snapshot or a resume is equal proof of a healthy, current stream.
    yield* resetReconnectSchedule;
    if (event._tag === 'snapshot') {
      const { epoch, seq, devices } = event.frame;
      applyDeviceSnapshot(registry, { epoch, seq }, devices);
    } else {
      const offered = yield* Ref.get(offeredCursor);
      if (
        offered === null ||
        offered.epoch !== event.cursor.epoch ||
        offered.seq !== event.cursor.seq
      ) {
        return yield* new DeviceStreamUnsolicitedResume({ offered, received: event.cursor });
      }
      applyDeviceResume(registry, event.cursor);
    }
    publishDeviceEventsError(registry, '');
    yield* Ref.set(failuresSinceDelivery, 0);
    // Either frame satisfies the boot wait — the active token can legitimately
    // differ from the boot token after a reconnect rotated it. A resume must
    // release it too, or a zero-byte reopen would hold boot until its deadline.
    releaseDeviceEventsBoot(registry);
  });

  const refreshAfterUnauthorized = Effect.fnUntraced(function* (current: string) {
    yield* Ref.set(attemptRefused, true);
    if (yield* Ref.get(refreshUsed)) {
      return 'unauthorized' as const;
    }
    yield* Ref.set(refreshUsed, true);
    yield* Ref.set(refreshRecoveryToken, current);
    let unauthorized = false;
    const refreshed = yield* Effect.tryPromise({
      try: () => io.refreshAuthentication(),
      catch: (cause) => new DeviceEventsRefreshRejected({ cause }),
    }).pipe(
      Effect.catch((error) => {
        unauthorized = isApiError(error.cause) && error.cause.status === 401;
        return Effect.succeed(null);
      }),
    );
    if (unauthorized) return 'unauthorized' as const;
    const next = refreshed?.accessToken;
    if (typeof next !== 'string' || next.length === 0 || next === current) {
      publishDeviceEventsError(registry, REFRESH_FAILED_MESSAGE);
      return 'park' as const;
    }
    yield* Ref.set(refreshRecoveryToken, null);
    yield* Ref.set(activeToken, next);
    registry.set(deviceEventsRotatedTokenAtom, next);
    yield* resetReconnectSchedule;
    return 'reconnect' as const;
  });

  /**
   * Ends an attempt that has stopped receiving bytes.
   *
   * The server writes a keep-alive comment every `DEVICE_EVENTS_KEEPALIVE_MS`,
   * so silence past the stall deadline means the socket is dead however
   * healthy it looks: `fetch` reports nothing for a half-open connection, and
   * without this the loop waits on a reader that will never yield again while
   * the list keeps rendering the presence it last heard about.
   *
   * It ends the attempt the same way a browser recovery edge does — reset the
   * fallback schedule, open the latch the loop is racing — so a dead stream
   * costs one immediate reconnect, answered with a zero-byte `resume` when
   * nothing changed while it was out.
   */
  const watchForStall = Effect.fnUntraced(function* () {
    while (true) {
      const idleMs = performance.now() - (yield* Ref.get(lastActivityAtMs));
      if (idleMs < stallTimeoutMs) {
        yield* Effect.sleep(`${stallTimeoutMs - idleMs} millis`);
        continue;
      }
      publishDeviceEventsError(registry, DISCONNECTED_MESSAGE);
      yield* Ref.set(attemptStalled, true);
      yield* resetReconnectSchedule;
      yield* wake.open;
      return;
    }
  });

  const runAttempt = (current: string): Effect.Effect<AttemptOutcome> =>
    Effect.suspend(() =>
      Effect.scoped(
        Effect.gen(function* () {
          // The deadline covers the request as well as the body: a fetch that
          // never answers is as dead as one that opened and went quiet, and
          // nothing else bounds it.
          yield* Ref.set(lastActivityAtMs, performance.now());
          yield* Effect.forkScoped(watchForStall());
          // Read per attempt, never hoisted: the cursor advances with every
          // frame, and a reopen that offered a stale one would fetch a snapshot
          // the list did not need.
          const since = registry.get(hasDeviceSnapshotAtom) ? registry.get(deviceCursorAtom) : null;
          yield* Ref.set(offeredCursor, since);
          yield* Stream.runForEach(
            deviceEventStream(current, since, io.openEventStream),
            onStreamEvent,
          );
        }),
      ),
    ).pipe(
      Effect.matchEffect({
        onFailure: (error): Effect.Effect<AttemptOutcome> => {
          if (error._tag === 'DeviceEventsSessionEnded') return Effect.succeed('unauthorized');
          if (error._tag === 'DeviceStreamUnauthorized') return refreshAfterUnauthorized(current);
          if (error._tag === 'DeviceStreamAborted') {
            // Nobody is left to see an error message: the only aborts that
            // reach here come from a page being unloaded, since a scope
            // closing interrupts this branch along with everything else.
            return Effect.as(Ref.set(attemptRefused, true), 'backoff');
          }
          if (error._tag === 'DeviceStreamGap') {
            // The stream is healthy, its content is not: reopen at once.
            return Effect.as(resetReconnectSchedule, 'reconnect');
          }
          if (error._tag === 'DeviceStreamUnsolicitedResume') {
            // Forget the cursor rather than the list: the rows stay on screen,
            // unconfirmed, and the reopen carries no `since`, so the only frame
            // that can satisfy it is a snapshot. That also makes this
            // self-limiting — the same answer cannot arrive twice.
            forgetDeviceEventsCursor(registry);
            return Effect.as(resetReconnectSchedule, 'reconnect');
          }
          // Leave the boot barrier pending: it has its own deadline and this
          // loop keeps trying. Failing it here bounced boot to the login
          // screen on a single transient SSE hiccup.
          return Effect.map(
            Ref.updateAndGet(failuresSinceDelivery, (count) => count + 1),
            (count) => {
              // The immediate retry is part of connecting, not evidence against
              // it. A second failure is the one that says the retry did not help.
              if (count > 1) publishDeviceEventsError(registry, DISCONNECTED_MESSAGE);
              return 'backoff';
            },
          );
        },
        // A clean end of body is a recovery edge, not a fault: reconnect on
        // the fallback schedule without publishing an error.
        onSuccess: (): Effect.Effect<AttemptOutcome> => Effect.succeed('backoff'),
      }),
    );

  /**
   * Whether this page is being torn down.
   *
   * A plain flag rather than a `Ref` or an edge, and set straight from the DOM
   * callback: it is read at the moment an attempt ends, and a queued edge would
   * not have been processed by then. There is no interleaving to guard — the
   * loop and the callback are the same thread.
   *
   * A fetch cancelled by a navigation does not reject with `AbortError`; it
   * rejects the way a dead network does, so nothing in the failure itself says
   * "the page went away". Without this, every reload reports one attempt that
   * was owed a frame and produced none — which is precisely the traffic anyone
   * investigating a stuck list generates while investigating it.
   */
  let pageUnloading = false;

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const onPageHide = (): void => {
        pageUnloading = true;
      };
      const onVisibilityChange = (): void => {
        Queue.offerUnsafe(edges, {
          _tag: 'visibility',
          hidden: document.visibilityState === 'hidden',
          atMs: Date.now(),
        });
      };
      const onPageShow = (event: PageTransitionEvent): void => {
        // A frozen page that came back is not a page that went away.
        pageUnloading = false;
        Queue.offerUnsafe(edges, { _tag: 'pageshow', persisted: event.persisted });
      };
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('pageshow', onPageShow);
        window.addEventListener('pagehide', onPageHide);
      }
      const monitor = io.createNetworkMonitor((event) => {
        Queue.offerUnsafe(edges, { _tag: 'network', kind: event.kind });
      });
      return { onVisibilityChange, onPageShow, onPageHide, monitor };
    }),
    (handles) =>
      Effect.sync(() => {
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', handles.onVisibilityChange);
          window.removeEventListener('pageshow', handles.onPageShow);
          window.removeEventListener('pagehide', handles.onPageHide);
        }
        handles.monitor.destroy();
      }),
  );

  yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(edges), handleEdge)));

  // On a cold PWA launch the initial-snapshot fetch can stall. The loop keeps
  // running in the background, so bound only the wait callers block on: let
  // boot leave the splash and reach the device list, which then populates as
  // snapshots arrive.
  yield* Effect.forkScoped(
    Effect.flatMap(
      Effect.sleep(io.firstSnapshotTimeout),
      (): Effect.Effect<void> => Effect.sync(() => releaseDeviceEventsBoot(registry)),
    ),
  );

  while (true) {
    yield* wake.close;

    if (yield* Ref.get(offline)) {
      publishDeviceEventsError(registry, OFFLINE_MESSAGE);
      yield* wake.await;
      continue;
    }

    const current = yield* Ref.get(activeToken);
    registry.set(deviceEventsAttemptsAtom, registry.get(deviceEventsAttemptsAtom) + 1);
    yield* Ref.set(attemptOpened, false);
    yield* Ref.set(attemptStalled, false);
    yield* Ref.set(attemptRefused, false);
    const outcome = yield* Effect.race(
      runAttempt(current),
      wake.await.pipe(Effect.as<AttemptOutcome>('wake')),
    );

    // Reached only by a loop that outlived its attempt, which is what makes it
    // the right place to retire one: an owner tearing the lifetime down
    // interrupts this line too, and the status then follows from the credential
    // it just dropped rather than from anything recorded here.
    const delivered = registry.get(deviceEventsDeliveredAtom);
    retireDeviceEventsAttempt(registry);

    // An attempt this loop cut short on purpose is not a failure, and neither
    // is one the endpoint refused: a 401 is an answer, and the rotation that
    // follows it is this loop working. What is worth reporting is an attempt
    // that was owed a frame, was left to run, and produced none — the browser
    // is the only place that fact exists, because a request that never arrives
    // leaves no trace on the server that it was ever sent.
    const preemptedByRecoveryEdge = outcome === 'wake' && !(yield* Ref.get(attemptStalled));
    if (
      !delivered &&
      !pageUnloading &&
      !preemptedByRecoveryEdge &&
      !(yield* Ref.get(attemptRefused))
    ) {
      registry.set(deviceEventsStreamFailureAtom, {
        kind: (yield* Ref.get(attemptOpened)) ? 'no_frame' : 'no_response',
      });
    }

    if (outcome === 'unauthorized') {
      registry.set(deviceEventsRejectedTokenAtom, token);
      return;
    }
    if (outcome === 'wake' || outcome === 'reconnect') continue;
    if (outcome === 'park') {
      yield* wake.await;
      continue;
    }

    const step = yield* Ref.get(reconnectStep);
    yield* Effect.race(Effect.orDie(step(undefined)), wake.await);
  }
});

/**
 * The recovery loop as an atom.
 *
 * Its dependencies are the credential and the IO record, so writing either one
 * is the whole of starting, replacing, and stopping a lifetime: the registry
 * closes the previous run's scope before the next one is read, which aborts
 * the in-flight fetch, detaches the browser listeners, and interrupts every
 * fiber the run owned.
 */
export const deviceEventsAtom: Atom.Atom<AsyncResult.AsyncResult<void, never>> = Atom.keepAlive(
  Atom.make((get): Effect.Effect<void, never, Scope.Scope | AtomRegistry> => {
    const token = get(deviceEventsTokenAtom);
    const io = get(deviceEventsIoAtom);
    return token === null ? Effect.void : runDeviceEventsRecovery(token, io);
  }),
);
