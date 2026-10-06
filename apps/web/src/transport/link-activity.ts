import { TRANSPORT_CHANNEL_ID } from '@merkur/shared';
import type { OwnedTimeout } from '../lib/owned-scheduled-callback';

export const LINK_ACTIVITY_INTERVAL_MS = 60;
export const LINK_ACTIVITY_COLUMNS = 64;

/**
 * The strip's one clock, read in both realms: the transport worker buckets
 * traffic by it and main places those buckets against it. `performance.now()`
 * alone counts from each realm's own time origin, so a worker tick would sit
 * billions of columns behind main's and every bin would draw as empty.
 */
export function linkActivityNow(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * The channels whose bytes the waveform plots: terminal input and display, in
 * both directions. `ctrl` carries the link's own machinery (heartbeats, the
 * reliable acknowledgement backstop, hints, repair markers, dictionary
 * installs); signaling and the data handshake are connection setup; `null` is
 * framing that belongs to no channel. Every one of those still counts toward
 * the session byte totals, so the strip going flat means the terminal is quiet,
 * not that the link is.
 */
export function isTerminalTrafficChannel(channelId: number | null): boolean {
  return (
    channelId === TRANSPORT_CHANNEL_ID.pty ||
    channelId === TRANSPORT_CHANNEL_ID.displayDatagram ||
    channelId === TRANSPORT_CHANNEL_ID.displayCommit ||
    channelId === TRANSPORT_CHANNEL_ID.displayAck
  );
}

/**
 * Absolute worker-observed bins. Slot = (tick % columns) * 2, sent then received;
 * `tick` counts intervals of `linkActivityNow`.
 */
export interface LinkActivitySnapshot {
  readonly subscriptionId: number;
  readonly sequence: number;
  readonly tick: number;
  readonly buckets: Float64Array;
  readonly txBytes: number;
  readonly rxBytes: number;
}

/**
 * Only a visible subscriber pays for timestamping and bucketing. One unacknowledged
 * publication bounds the task queue; while main is busy, only the fixed ring changes.
 *
 * Publication is driven by the strip's content, never by a clock of its own. A
 * terminal byte marks the ring dirty and publishes; the 60 ms cadence then runs
 * only while the newest traffic is still inside the widest subscriber's visible
 * columns, so a burst scrolls off the strip normally, one more publication shows
 * the empty strip, and the worker parks with no timer armed until the next byte.
 * The publisher lends its reusable snapshot to a synchronous structured-clone sink.
 */
export function createLinkActivityPublisher(options: {
  readonly now: () => number;
  readonly timer: OwnedTimeout;
  readonly totals: () => { readonly txBytes: number; readonly rxBytes: number };
  readonly publish: (snapshot: LinkActivitySnapshot) => void;
}) {
  const snapshot = {
    subscriptionId: 0,
    sequence: 0,
    tick: 0,
    buckets: new Float64Array(LINK_ACTIVITY_COLUMNS * 2),
    txBytes: 0,
    rxBytes: 0,
  };
  let enabled = false;
  let running = false;
  let outstanding = 0;
  let lastPostAt = Number.NEGATIVE_INFINITY;
  /** Visible columns of the widest subscriber: how far a burst scrolls before it is gone. */
  let columns = 0;
  /** Tick of the newest bucketed traffic; the ring is empty at -Infinity. */
  let lastTrafficTick = Number.NEGATIVE_INFINITY;
  /** Traffic, or a fresh subscription, that no publication has carried yet. */
  let dirty = false;

  function advance(now: number): void {
    const tick = Math.floor(now / LINK_ACTIVITY_INTERVAL_MS);
    const steps = tick - snapshot.tick;
    if (steps >= LINK_ACTIVITY_COLUMNS) snapshot.buckets.fill(0);
    else {
      for (let at = snapshot.tick + 1; at <= tick; at += 1) {
        const slot = (at % LINK_ACTIVITY_COLUMNS) * 2;
        snapshot.buckets[slot] = 0;
        snapshot.buckets[slot + 1] = 0;
      }
    }
    snapshot.tick = tick;
  }

  /** The last published window still shows traffic, so the next tick moves it. */
  function scrolling(): boolean {
    return snapshot.tick - lastTrafficTick < columns;
  }

  function flush(): void {
    if (!running || !enabled || outstanding !== 0) return;
    const now = options.now();
    advance(now);
    const totals = options.totals();
    snapshot.txBytes = totals.txBytes;
    snapshot.rxBytes = totals.rxBytes;
    snapshot.sequence += 1;
    outstanding = snapshot.sequence;
    lastPostAt = now;
    dirty = false;
    options.publish(snapshot);
  }

  /**
   * `inline` publishes a due snapshot synchronously. The wire callbacks decline
   * it: they run inside a provider's read loop or write settlement, and the
   * structured clone belongs in its own task rather than in that one.
   */
  function schedule(inline: boolean): void {
    if (!running || !enabled || outstanding !== 0 || options.timer.isArmed()) return;
    if (!dirty && !scrolling()) return;
    const wait = lastPostAt + LINK_ACTIVITY_INTERVAL_MS - options.now();
    if (wait <= 0 && inline) flush();
    else options.timer.arm(flush, Math.max(0, wait));
  }

  function reset(): void {
    options.timer.cancel();
    outstanding = 0;
    snapshot.buckets.fill(0);
    snapshot.tick = Math.floor(options.now() / LINK_ACTIVITY_INTERVAL_MS);
    lastTrafficTick = Number.NEGATIVE_INFINITY;
    lastPostAt = Number.NEGATIVE_INFINITY;
    // The subscriber's baseline: fresh totals and an empty history, once.
    dirty = true;
    schedule(true);
  }

  return {
    subscribe(subscriptionId: number, observe: boolean, visibleColumns: number): void {
      if (subscriptionId <= snapshot.subscriptionId) return;
      snapshot.subscriptionId = subscriptionId;
      enabled = observe;
      columns = Math.min(LINK_ACTIVITY_COLUMNS, visibleColumns);
      reset();
    },
    start(): void {
      running = true;
      reset();
    },
    stop(): void {
      running = false;
      options.timer.cancel();
      outstanding = 0;
    },
    acknowledge(subscriptionId: number, sequence: number): void {
      if (subscriptionId !== snapshot.subscriptionId || sequence !== outstanding) return;
      outstanding = 0;
      schedule(true);
    },
    /** Terminal bytes on the wire. Bytes before the session is ready reach the totals only. */
    record(tx: number, rx: number, ready: boolean): void {
      if (!running || !enabled || !ready || (tx === 0 && rx === 0)) return;
      advance(options.now());
      const slot = (snapshot.tick % LINK_ACTIVITY_COLUMNS) * 2;
      snapshot.buckets[slot] = (snapshot.buckets[slot] ?? 0) + tx;
      snapshot.buckets[slot + 1] = (snapshot.buckets[slot + 1] ?? 0) + rx;
      lastTrafficTick = snapshot.tick;
      dirty = true;
      schedule(false);
    },
  };
}
