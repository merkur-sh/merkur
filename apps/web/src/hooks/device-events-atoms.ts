import {
  DEVICE_EVENTS_STALL_TIMEOUT_MS,
  type Device,
  type DeviceDeltaFrame,
  type DeviceEventsCursor,
  reduceDeviceDelta,
} from '@merkur/shared';
import { Data, type Duration, Effect } from 'effect';
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult';
import * as Atom from 'effect/unstable/reactivity/Atom';
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry';
import { refreshAccessToken } from '../api';
import { reconcileDeviceSnapshot } from '../app/device-snapshot-reconciliation';
import { openAuthenticatedEventStream } from '../event-stream-worker-client';
import {
  clearCachedDeviceList,
  loadCachedDeviceList,
  saveCachedDeviceList,
} from '../lib/device-list-cache';
import { createNetworkMonitor } from '../session/network-monitor';
import type { OpenEventStream } from './device-events-source';

// On a cold PWA launch the initial-snapshot fetch can stall (see the iOS notes
// in api.ts/authenticated-transport.ts). The recovery loop keeps running in the
// background, so bound only the wait callers block on: release the barrier
// after the deadline so boot can leave the splash and reach the device list,
// which then populates as snapshots arrive.
const DEVICE_EVENTS_FIRST_SNAPSHOT_TIMEOUT: Duration.Input = '8 seconds';

export type DeviceListStatus = 'initial-loading' | 'live' | 'refreshing' | 'offline';

/** The owner tore the device-events lifetime down before a snapshot arrived. */
export class DeviceEventsStopped extends Data.TaggedError('DeviceEventsStopped')<
  Record<string, never>
> {}

/**
 * Every boundary the recovery loop touches, in one record.
 *
 * It is an atom rather than a constructor argument because the loop itself is
 * an atom: swapping this value is how a test installs fakes, and it restarts
 * the loop for the same structural reason a new token does.
 */
export interface DeviceEventsIo {
  readonly openEventStream: OpenEventStream;
  readonly refreshAuthentication: () => Promise<{ readonly accessToken: string | null } | null>;
  readonly createNetworkMonitor: typeof createNetworkMonitor;
  readonly isNetworkOffline: () => boolean;
  /** Injectable entropy for deterministic fallback-schedule tests. */
  readonly reconnectRandom: () => number;
  readonly firstSnapshotTimeout: Duration.Input;
  /** Silence — of any byte, not just a frame — that condemns a stream. */
  readonly stallTimeout: Duration.Input;
}

const browserDeviceEventsIo: DeviceEventsIo = {
  openEventStream: openAuthenticatedEventStream,
  refreshAuthentication: refreshAccessToken,
  createNetworkMonitor,
  isNetworkOffline: () => typeof navigator !== 'undefined' && navigator.onLine === false,
  reconnectRandom: Math.random,
  firstSnapshotTimeout: DEVICE_EVENTS_FIRST_SNAPSHOT_TIMEOUT,
  stallTimeout: DEVICE_EVENTS_STALL_TIMEOUT_MS,
};

// Hydrate from the persisted last-known list so a mobile launch paints devices
// immediately; the first live frame replaces it in place — or, when its
// sequence is still current, confirms it with a zero-byte resume.
const cached = loadCachedDeviceList();

// `keepAlive` because these hold the device-list lifetime, not a derived view.
// A registry with an idle TTL would otherwise drop an unobserved atom back to
// its initial value and silently reset the list, the status, or the barrier.
export const devicesAtom: Atom.Writable<Device[]> = Atom.keepAlive(
  Atom.make<Device[]>(cached === null ? [] : [...cached.devices]),
);

export const deviceEventsErrorAtom: Atom.Writable<string> = Atom.keepAlive(Atom.make(''));

/** Ephemeral and account-scoped. A disconnected stream can confirm no browser. */
export const browserPresenceAtom: Atom.Writable<readonly string[] | null> = Atom.keepAlive(
  Atom.make<readonly string[] | null>(null),
);

/** True once any snapshot — cached or live — has been applied. */
export const hasDeviceSnapshotAtom: Atom.Writable<boolean> = Atom.keepAlive(
  Atom.make(cached !== null),
);

/**
 * The last device-events cursor applied to {@link devicesAtom}. Sent as
 * `since` on every stream open; the server answers with nothing but a `resume`
 * frame when it still matches. Meaningful only while {@link hasDeviceSnapshotAtom}.
 *
 * The epoch travels with the sequence and is never inspected here: it is the
 * server's word for "this is still the same counter", and holding half of it
 * would let a restarted counter answer for the one this list was built from.
 */
export const deviceCursorAtom: Atom.Writable<DeviceEventsCursor | null> = Atom.keepAlive(
  Atom.make<DeviceEventsCursor | null>(
    cached === null ? null : { epoch: cached.epoch, seq: cached.seq },
  ),
);

/**
 * Whose list this is. Sequences are per account, so a list hydrated for one
 * account must never be resumed — or even shown — for another.
 */
export const deviceUserIdAtom: Atom.Writable<string | null> = Atom.keepAlive(
  Atom.make<string | null>(cached === null ? null : cached.userId),
);

/**
 * The boot barrier. `Initial` is the only state callers block on, so a start
 * that has already seen a snapshot resolves its waiters immediately and a
 * second starter for the same token shares the barrier instead of opening a
 * second stream.
 */
export const deviceEventsBootAtom: Atom.Writable<
  AsyncResult.AsyncResult<void, DeviceEventsStopped>
> = Atom.keepAlive(
  Atom.make<AsyncResult.AsyncResult<void, DeviceEventsStopped>>(AsyncResult.initial(true)),
);

/** The credential the recovery loop runs with. `null` stops it. */
export const deviceEventsTokenAtom: Atom.Writable<string | null> = Atom.keepAlive(
  Atom.make<string | null>(null),
);

/**
 * Whether the attempt currently running has delivered its opening frame.
 *
 * The server writes exactly one of `snapshot` or `resume` as the first thing on
 * every stream, so this is the moment — and the only moment — at which the rows
 * on screen are confirmed by something live. Cleared when an attempt ends and
 * when a lifetime begins, so it describes the attempt in hand rather than the
 * last one that worked.
 */
export const deviceEventsDeliveredAtom: Atom.Writable<boolean> = Atom.keepAlive(Atom.make(false));

/**
 * What the list can currently say about itself.
 *
 * Derived, never written. It was previously assigned on every edge that could
 * change it — start, stop, frame, fault, reconnect — and the badge was then only
 * as correct as the ordering of those writes: an attempt that opened and never
 * delivered left "Updating…" standing with nothing on the way, a cleared error
 * left "Updates paused" standing over a healthy stream, and a second `start`
 * that joined a running lifetime wrote nothing at all and so could not repair
 * either. A quiet stream sends nothing for minutes, so a wrong badge stayed
 * wrong until the next frame, which for a list nobody is changing is never.
 *
 * Computing it instead makes those states unreachable: the status is a function
 * of the facts the loop already owns, so it cannot outlive, undershoot, or
 * contradict them.
 */
export const deviceListStatusAtom: Atom.Atom<DeviceListStatus> = Atom.keepAlive(
  Atom.make<DeviceListStatus>((get) => {
    // A published error is the loudest thing the list knows, and it is cleared
    // the moment a stream proves the endpoint accepts the credential.
    if (get(deviceEventsErrorAtom).length > 0) return 'offline';
    // No credential, no lifetime — but "none yet" and "torn down" are different
    // facts, and only the second is a fault. A reload restores its credential
    // over the network before it can start a lifetime, and the barrier is
    // `Initial` for that whole stretch, so nothing has failed: the list is
    // loading, or refreshing over the rows the cache hydrated it with. Reading
    // the hydrated account id as evidence of a fault instead made every reload
    // report a pause from the first frame of the module, before a single
    // attempt had been made.
    if (get(deviceEventsTokenAtom) === null) {
      if (AsyncResult.isInitial(get(deviceEventsBootAtom))) {
        return get(hasDeviceSnapshotAtom) ? 'refreshing' : 'initial-loading';
      }
      // Past that, the barrier carries the stop that ended the last lifetime.
      // A sign-out drops the account with it and leaves nothing to report on.
      return get(deviceUserIdAtom) === null ? 'initial-loading' : 'offline';
    }
    if (get(deviceEventsDeliveredAtom)) return 'live';
    return get(hasDeviceSnapshotAtom) ? 'refreshing' : 'initial-loading';
  }),
);

/**
 * A credential the loop rotated into after a definitive 401. Published rather
 * than written back into {@link deviceEventsTokenAtom}: restarting the loop
 * would reset the one-use refresh latch the rotation just spent.
 */
export const deviceEventsRotatedTokenAtom: Atom.Writable<string | null> = Atom.keepAlive(
  Atom.make<string | null>(null),
);

/** The credential lifetime the server definitively rejected after refresh. */
export const deviceEventsRejectedTokenAtom: Atom.Writable<string | null> = Atom.keepAlive(
  Atom.make<string | null>(null),
);

/**
 * Bumped once per `browser-sessions-changed` frame: another browser of this
 * account signed in or was revoked. A count rather than a flag, so two frames
 * inside one flush still read as two.
 */
export const browserSessionsChangedAtom: Atom.Writable<number> = Atom.keepAlive(Atom.make(0));

/**
 * How many stream attempts this page's recovery loop has begun.
 *
 * Published for the app-state contract, and it exists because the two ways a
 * list can sit unconfirmed are indistinguishable from outside the browser and
 * from each other in the status alone: a loop that is attempting and getting
 * nowhere reads exactly like a loop that never started. The server cannot tell
 * them apart either — one of them makes no request for it to see. This is the
 * number that does: zero means nothing has been tried.
 */
export const deviceEventsAttemptsAtom: Atom.Writable<number> = Atom.keepAlive(Atom.make(0));

/**
 * An attempt that ended owing the screen a frame, published for whoever reports
 * browser diagnostics.
 *
 * Published rather than reported from the loop for the same reason a rotated
 * credential is: reporting needs an access token and the account's telemetry
 * consent, and neither belongs to a stream. The loop states the fact; the app
 * controller decides what to do with it.
 *
 * A fresh object per publication, because two identical failures in a row are
 * two failures — the subscriber counts them.
 */
export interface DeviceEventsStreamFailure {
  /**
   * `no_response`: the request was never answered — no response headers, no
   * bytes, and no failure either, which is the state nothing else in the app
   * can observe. `no_frame`: the stream opened and the server never wrote the
   * opening `snapshot` or `resume` its own contract owes every stream.
   *
   * Together they separate "the request never got there" from "it got there and
   * said nothing", which is the one distinction the server's own spans cannot
   * make: a request that never arrives leaves no trace of having been sent.
   */
  readonly kind: 'no_response' | 'no_frame';
}

export const deviceEventsStreamFailureAtom: Atom.Writable<DeviceEventsStreamFailure | null> =
  Atom.keepAlive(Atom.make<DeviceEventsStreamFailure | null>(null));

export const deviceEventsIoAtom: Atom.Writable<DeviceEventsIo> = Atom.keepAlive(
  Atom.make(browserDeviceEventsIo),
);

/**
 * Apply a full list from the live stream. Reconciliation keeps unchanged rows
 * identical so Solid's `<For>` does not rebuild them, and the persisted cache
 * tracks whatever is rendered, stamped with the sequence it is current to.
 */
export function applyDeviceSnapshot(
  registry: AtomRegistry.AtomRegistry,
  cursor: DeviceEventsCursor,
  next: readonly Device[],
): void {
  registry.set(devicesAtom, reconcileDeviceSnapshot(registry.get(devicesAtom), next));
  registry.set(deviceCursorAtom, cursor);
  registry.set(hasDeviceSnapshotAtom, true);
  registry.set(deviceEventsDeliveredAtom, true);
  persistDeviceList(registry);
}

/**
 * Accept a `resume`: the held list is current as of this cursor.
 *
 * The epoch is rewritten rather than assumed, because a resume is the server
 * agreeing with the exact cursor that was offered — writing it back keeps this
 * the one place the browser's cursor comes from.
 */
export function applyDeviceResume(
  registry: AtomRegistry.AtomRegistry,
  cursor: DeviceEventsCursor,
): void {
  registry.set(deviceCursorAtom, cursor);
  registry.set(deviceEventsDeliveredAtom, true);
  persistDeviceList(registry);
}

/**
 * Apply one absolute delta from the live stream. The reducer returns the same
 * array when nothing changed and keeps untouched rows identical, so this is
 * cheaper than a snapshot in exactly the way the wire is.
 *
 * The epoch is the caller's, not this frame's: a delta carries only a sequence,
 * because it cannot outlive the frame that pinned an epoch — the stream that
 * delivers it opened with a snapshot or a resume, and a stream that ends takes
 * its deltas with it. Passing it in is what makes "there is no cursor yet"
 * impossible to express here rather than something to check for.
 */
export function applyDeviceDelta(
  registry: AtomRegistry.AtomRegistry,
  epoch: string,
  frame: DeviceDeltaFrame,
): void {
  registry.set(devicesAtom, [...reduceDeviceDelta(registry.get(devicesAtom), frame)]);
  registry.set(deviceCursorAtom, { epoch, seq: frame.seq });
  registry.set(deviceEventsDeliveredAtom, true);
  persistDeviceList(registry);
}

/**
 * Apply a change this browser made itself — a rename or removal the server
 * already acknowledged. It has no sequence of its own: the matching delta
 * arrives on the stream and re-applies as a no-op.
 */
export function applyLocalDeviceChange(
  registry: AtomRegistry.AtomRegistry,
  next: readonly Device[],
): void {
  registry.set(devicesAtom, reconcileDeviceSnapshot(registry.get(devicesAtom), next));
  persistDeviceList(registry);
}

function persistDeviceList(registry: AtomRegistry.AtomRegistry): void {
  const userId = registry.get(deviceUserIdAtom);
  const cursor = registry.get(deviceCursorAtom);
  // Nothing is worth persisting without the cursor it is current to: a list
  // restored with no epoch could only ever ask for a full snapshot, and one
  // restored with a borrowed epoch would be worse than not restoring it.
  if (userId === null || cursor === null) return;
  saveCachedDeviceList({
    userId,
    epoch: cursor.epoch,
    seq: cursor.seq,
    devices: registry.get(devicesAtom),
  });
}

/**
 * Retire the attempt that was confirming this list.
 *
 * Called wherever one stops carrying frames — a clean end of body, a fault, a
 * stall, a recovery edge that preempted it — and where a lifetime begins or
 * ends, which is the same fact stated at its two boundaries. Nothing is
 * vouching for these rows until the next attempt delivers, and the status says
 * so without anyone having to remember to say it.
 */
export function retireDeviceEventsAttempt(registry: AtomRegistry.AtomRegistry): void {
  registry.set(browserPresenceAtom, null);
  registry.set(deviceEventsDeliveredAtom, false);
}

/**
 * Drop the cursor while keeping the list.
 *
 * The rows stay on screen — they are still the last thing anyone said about
 * these machines — but nothing may resume from them again, so the next open
 * asks for a snapshot. Used where the cursor itself became untrustworthy.
 */
export function forgetDeviceEventsCursor(registry: AtomRegistry.AtomRegistry): void {
  registry.set(deviceCursorAtom, null);
  registry.set(hasDeviceSnapshotAtom, false);
  clearCachedDeviceList();
}

/**
 * Publish a device-events error, or clear it with an empty string.
 *
 * A non-empty message takes the list offline, and clearing it hands the badge
 * straight back to whatever the stream is actually doing — the status is
 * computed from this, not assigned alongside it.
 */
export function publishDeviceEventsError(
  registry: AtomRegistry.AtomRegistry,
  message: string,
): void {
  registry.set(deviceEventsErrorAtom, message);
}

/**
 * Release the boot barrier. Guarded by `Initial` so a late first snapshot
 * cannot resurrect a barrier the owner already failed by stopping.
 */
export function releaseDeviceEventsBoot(registry: AtomRegistry.AtomRegistry): void {
  if (AsyncResult.isInitial(registry.get(deviceEventsBootAtom))) {
    registry.set(deviceEventsBootAtom, AsyncResult.success<void, DeviceEventsStopped>(undefined));
  }
}

/**
 * Begin — or join — a device-events lifetime, and wait for its first frame.
 *
 * Resolves on a snapshot, or on a resume that confirms the held list, or on
 * the loop's own first-frame deadline; rejects only when the owner stops the
 * lifetime.
 *
 * Writing the same token again is deliberately a no-op: the running loop and
 * its barrier are the lifetime, so a second starter waits on the stream that
 * already exists instead of replacing it. A different token resets the barrier
 * first, so the returned wait can never be satisfied by the outgoing lifetime.
 *
 * A different account drops everything first — list, sequence, cache — because
 * a sequence is only meaningful against the account it was issued for, and a
 * held list must never be shown to, or resumed for, anyone else.
 */
export function startDeviceEvents(
  registry: AtomRegistry.AtomRegistry,
  token: string,
  userId: string,
): Promise<void> {
  if (registry.get(deviceUserIdAtom) !== userId) {
    registry.set(browserPresenceAtom, null);
    registry.set(devicesAtom, []);
    registry.set(deviceCursorAtom, null);
    registry.set(hasDeviceSnapshotAtom, false);
    registry.set(deviceUserIdAtom, userId);
    // An error belongs to the account that raised it. Carried across, it would
    // take the next account's list offline over a stream it never ran.
    publishDeviceEventsError(registry, '');
    clearCachedDeviceList();
  }
  if (registry.get(deviceEventsTokenAtom) !== token) {
    registry.set(deviceEventsBootAtom, AsyncResult.initial(true));
    registry.set(deviceEventsRotatedTokenAtom, null);
    registry.set(deviceEventsRejectedTokenAtom, null);
    // A lifetime begins owing the screen a frame, and its first attempt has not
    // delivered one. A joiner retires nothing: the running attempt may already
    // have delivered, and the status is computed from that rather than from who
    // called this.
    retireDeviceEventsAttempt(registry);
    registry.set(deviceEventsTokenAtom, token);
  }
  return Effect.runPromise(
    AtomRegistry.getResult(registry, deviceEventsBootAtom, { suspendOnWaiting: true }),
  );
}

/** Tear the lifetime down and fail every wait that belonged to it. */
export function stopDeviceEvents(registry: AtomRegistry.AtomRegistry): void {
  registry.set(deviceEventsTokenAtom, null);
  registry.set(deviceEventsBootAtom, AsyncResult.fail(new DeviceEventsStopped({})));
  // No lifetime, no attempt. The status follows from the absent credential, so
  // there is nothing here to keep in step with it.
  retireDeviceEventsAttempt(registry);
}
