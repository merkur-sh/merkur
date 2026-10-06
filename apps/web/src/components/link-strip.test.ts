import { describe, expect, test } from 'bun:test';
import { TRANSPORT_CHANNEL_ID } from '@merkur/shared';
import { createOwnedAnimationFrame, createOwnedTimeout } from '../lib/owned-scheduled-callback';
import {
  createLinkActivityPublisher,
  isTerminalTrafficChannel,
  LINK_ACTIVITY_COLUMNS,
  type LinkActivitySnapshot,
} from '../transport/link-activity';
import {
  createLinkStripScheduler,
  createLinkStripSeries,
  drawLinkStrip,
  healthColor,
  IDLE_COLOR,
  trafficHeight,
} from './link-strip';

function clockHarness(frameMs = 1000 / 120) {
  let now = 0;
  let id = 0;
  let callbacks = 0;
  const tasks = new Map<number, { at: number; run: () => void }>();
  function schedule(run: () => void, at: number): number {
    const handle = ++id;
    tasks.set(handle, { at, run });
    return handle;
  }
  return {
    now: () => now,
    pending: () => tasks.size,
    callbacks: () => callbacks,
    timer: createOwnedTimeout(
      (run, delay) => schedule(run, now + delay),
      (handle) => tasks.delete(handle),
    ),
    frame: createOwnedAnimationFrame(
      (run) => schedule(() => run(now), (Math.floor(now / frameMs) + 1) * frameMs),
      (handle) => tasks.delete(handle),
    ),
    advance(to: number): void {
      let turns = 0;
      while (true) {
        let earliestId: number | null = null;
        let earliestAt = Number.POSITIVE_INFINITY;
        for (const [handle, task] of tasks) {
          if (task.at < earliestAt) {
            earliestId = handle;
            earliestAt = task.at;
          }
        }
        if (earliestId === null || earliestAt > to) break;
        const task = tasks.get(earliestId);
        tasks.delete(earliestId);
        now = earliestAt;
        callbacks += 1;
        task?.run();
        if (++turns > 10_000) throw new Error('unbounded scheduling');
      }
      now = to;
    },
  };
}

function snapshot(tick: number, bins: readonly [number, number, number][]): LinkActivitySnapshot {
  const buckets = new Float64Array(LINK_ACTIVITY_COLUMNS * 2);
  for (const [at, tx, rx] of bins) {
    buckets[(at % LINK_ACTIVITY_COLUMNS) * 2] = tx;
    buckets[(at % LINK_ACTIVITY_COLUMNS) * 2 + 1] = rx;
  }
  return { subscriptionId: 1, sequence: 1, tick, buckets, txBytes: 1000, rxBytes: 2000 };
}

function publisherHarness() {
  const clock = clockHarness();
  const messages: LinkActivitySnapshot[] = [];
  const totals = { txBytes: 0, rxBytes: 0 };
  let clockReads = 0;
  const publisher = createLinkActivityPublisher({
    now: () => {
      clockReads += 1;
      return clock.now();
    },
    timer: clock.timer,
    totals: () => totals,
    publish: (value) => messages.push(structuredClone(value)),
  });
  return {
    clock,
    messages,
    publisher,
    clockReads: () => clockReads,
    record(tx: number, rx: number, ready = true) {
      totals.txBytes += tx;
      totals.rxBytes += rx;
      publisher.record(tx, rx, ready);
    },
    ack() {
      const latest = messages.at(-1);
      if (latest === undefined) throw new Error('no publication');
      publisher.acknowledge(latest.subscriptionId, latest.sequence);
    },
  };
}

describe('worker traffic publication', () => {
  test('hidden activity performs no clock reads, allocations for snapshots, timers or publications', () => {
    const h = publisherHarness();
    h.publisher.start();
    const before = h.clockReads();
    for (let i = 0; i < 1000; i += 1) h.record(10, 20);
    expect(h.clockReads()).toBe(before);
    expect(h.messages).toHaveLength(0);
    expect(h.clock.pending()).toBe(0);
    h.publisher.subscribe(1, true, 4);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]?.txBytes).toBe(10_000);
    expect(h.messages[0]?.buckets.every((n) => n === 0)).toBe(true);
    h.ack();
    h.publisher.subscribe(2, false, 0);
    h.clock.advance(60_000);
    expect(h.clock.pending()).toBe(0);
    expect(h.messages).toHaveLength(1);
  });

  test('only terminal channels feed the strip; link machinery reaches the totals alone', () => {
    expect(isTerminalTrafficChannel(TRANSPORT_CHANNEL_ID.pty)).toBe(true);
    expect(isTerminalTrafficChannel(TRANSPORT_CHANNEL_ID.displayDatagram)).toBe(true);
    expect(isTerminalTrafficChannel(TRANSPORT_CHANNEL_ID.displayCommit)).toBe(true);
    expect(isTerminalTrafficChannel(TRANSPORT_CHANNEL_ID.displayAck)).toBe(true);
    expect(isTerminalTrafficChannel(TRANSPORT_CHANNEL_ID.ctrl)).toBe(false);
    expect(isTerminalTrafficChannel(TRANSPORT_CHANNEL_ID.signaling)).toBe(false);
    expect(isTerminalTrafficChannel(TRANSPORT_CHANNEL_ID.dataHandshake)).toBe(false);
    expect(isTerminalTrafficChannel(null)).toBe(false);
  });

  test('terminal bytes publish exact bins, scroll off the visible columns, then park', () => {
    const h = publisherHarness();
    h.publisher.start();
    h.publisher.subscribe(1, true, 4);
    h.ack();
    for (let at = 1; at <= 59; at += 1) {
      h.clock.advance(at);
      h.record(2, 4);
      expect(h.clock.pending()).toBe(1);
    }
    h.clock.advance(60);
    expect(h.messages).toHaveLength(2);
    expect(h.messages[1]?.buckets[0]).toBe(118);
    expect(h.messages[1]?.buckets[1]).toBe(236);
    expect(h.messages[1]?.tick).toBe(1);
    // The burst sits at tick 0 and the strip is four columns wide: ticks 2 and
    // 3 carry it across, tick 4 shows the empty strip, and nothing follows.
    for (const tick of [2, 3, 4]) {
      h.ack();
      expect(h.clock.pending()).toBe(1);
      h.clock.advance(tick * 60);
      expect(h.messages.at(-1)?.tick).toBe(tick);
    }
    const series = createLinkStripSeries(4, 10);
    const last = h.messages.at(-1);
    if (last === undefined) throw new Error('missing publication');
    series.load(last, h.clock.now(), false);
    expect([...series.txHeight]).toEqual([0, 0, 0, 0]);
    expect([...series.rxHeight]).toEqual([0, 0, 0, 0]);
    h.ack();
    expect(h.clock.pending()).toBe(0);
    h.clock.advance(60_000);
    expect(h.messages).toHaveLength(5);
  });

  test('receive-only bursts scroll one column per quiet tick, park, and render again after silence', () => {
    const h = publisherHarness();
    const series = createLinkStripSeries(4, 10);
    h.publisher.start();
    h.publisher.subscribe(1, true, 4);
    h.ack();
    h.clock.advance(10);
    h.record(0, 512);
    const height = trafficHeight(512, 10);
    for (let tick = 1; tick <= 4; tick += 1) {
      h.clock.advance(tick * 60);
      const latest = h.messages.at(-1);
      if (latest === undefined) throw new Error('quiet tick missing');
      expect(latest.tick).toBe(tick);
      series.load(latest, h.clock.now(), false);
      expect([...series.txHeight]).toEqual([0, 0, 0, 0]);
      const expected = [0, 0, 0, 0];
      if (tick < 4) expected[3 - tick] = height;
      expect([...series.rxHeight]).toEqual(expected);
      h.ack();
    }
    // Parked: the burst has left the strip, and no timer waits out the silence.
    expect(h.clock.pending()).toBe(0);
    h.clock.advance(370);
    expect(h.messages).toHaveLength(5);
    // A byte after silence hands its snapshot to a task of its own rather than
    // publishing from inside the read loop that counted it.
    h.record(0, 1024);
    expect(h.messages).toHaveLength(5);
    expect(h.clock.pending()).toBe(1);
    h.clock.advance(420);
    const latest = h.messages.at(-1);
    if (latest === undefined) throw new Error('resumed receive tick missing');
    expect(series.load(latest, h.clock.now(), false)).toBe(true);
    expect(series.rxHeight[2]).toBe(trafficHeight(1024, 10));
    expect(latest.txBytes).toBe(0);
    expect(latest.rxBytes).toBe(1536);
    h.publisher.stop();
  });

  test('a blocked main thread owns one message and preserves intervening burst times', () => {
    const h = publisherHarness();
    h.publisher.start();
    h.publisher.subscribe(1, true, 4);
    h.clock.advance(10);
    h.record(512, 0);
    h.clock.advance(130);
    h.record(0, 1024);
    h.clock.advance(310);
    h.record(128, 256);
    expect(h.messages).toHaveLength(1);
    expect(h.clock.pending()).toBe(0);
    h.ack();
    const latest = h.messages[1];
    if (latest === undefined) throw new Error('no catch-up publication');
    expect(latest.tick).toBe(5);
    expect(latest.buckets[0]).toBe(512);
    expect(latest.buckets[5]).toBe(1024);
    expect(latest.buckets[10]).toBe(128);
    expect(latest.buckets[11]).toBe(256);
    expect(latest.buckets[2]).toBe(0);
    h.ack();
    expect(h.clock.pending()).toBe(1);
    h.publisher.stop();
    expect(h.clock.pending()).toBe(0);
  });

  test('visibility and start replacement reject stale credit and exclude hidden bytes', () => {
    const h = publisherHarness();
    h.publisher.start();
    h.publisher.subscribe(1, true, 4);
    h.ack();
    h.clock.advance(10);
    h.record(512, 128);
    h.publisher.subscribe(2, false, 0);
    expect(h.clock.pending()).toBe(0);
    h.clock.advance(100);
    h.record(100_000, 200_000);
    h.publisher.subscribe(3, true, 4);
    expect(h.messages.at(-1)?.txBytes).toBe(100_512);
    expect(h.messages.at(-1)?.buckets.every((n) => n === 0)).toBe(true);
    h.record(64, 128);
    h.publisher.acknowledge(1, 1);
    expect(h.clock.pending()).toBe(0);
    const old = h.messages.at(-1);
    h.publisher.stop();
    h.publisher.start();
    if (old === undefined) throw new Error('no prior publication');
    h.publisher.acknowledge(old.subscriptionId, old.sequence);
    h.record(256, 0);
    expect(h.clock.pending()).toBe(0);
    h.ack();
    h.clock.advance(160);
    expect(h.messages.at(-1)?.buckets[4]).toBe(0);
    h.publisher.stop();
    expect(h.clock.pending()).toBe(0);
  });

  test('retention is bounded across long stalls, and connecting bytes affect totals only', () => {
    const h = publisherHarness();
    h.publisher.start();
    h.publisher.subscribe(1, true, 4);
    h.record(512, 128);
    h.clock.advance(10_000);
    h.record(64, 128, false);
    h.ack();
    const latest = h.messages.at(-1);
    expect(latest?.buckets).toHaveLength(LINK_ACTIVITY_COLUMNS * 2);
    expect(latest?.buckets.every((n) => n === 0)).toBe(true);
    expect(latest?.txBytes).toBe(576);
    h.publisher.stop();
  });
});

describe('two-sided traffic pixels', () => {
  test('delayed delivery preserves gaps and uses an identical fixed scale in both directions', () => {
    const series = createLinkStripSeries(6, 10);
    series.load(
      snapshot(5, [
        [0, 512, 512],
        [3, 65_536, 0],
        [5, 512, 512],
      ]),
      310,
      false,
    );
    const quiet = trafficHeight(512, 10);
    expect([...series.txHeight]).toEqual([quiet, 0, 0, 10, 0, quiet]);
    expect([...series.rxHeight]).toEqual([quiet, 0, 0, 0, 0, quiet]);
    expect(trafficHeight(0, 10)).toBe(0);
    expect(trafficHeight(1e9, 10)).toBe(10);
    expect(trafficHeight(1, 10)).toBeGreaterThan(0);
  });

  test('identical drawable pixels skip drawing even when raw counters increase', () => {
    const series = createLinkStripSeries(2, 10);
    expect(
      series.load(
        snapshot(1, [
          [0, 65_536, 0],
          [1, 65_536, 0],
        ]),
        60,
        false,
      ),
    ).toBe(true);
    expect(
      series.load(
        snapshot(2, [
          [1, 131_072, 0],
          [2, 131_072, 0],
        ]),
        120,
        false,
      ),
    ).toBe(false);
  });

  test('a stale snapshot cannot shift ancient bytes into the current column', () => {
    const series = createLinkStripSeries(4, 10);
    expect(series.load(snapshot(0, [[0, 512, 128]]), 300, false)).toBe(false);
  });

  test('reduced motion holds a stationary newest pair and expires without scrolling', () => {
    const series = createLinkStripSeries(4, 10);
    series.load(
      snapshot(5, [
        [3, 1024, 128],
        [5, 512, 256],
      ]),
      310,
      true,
    );
    expect([...series.txHeight]).toEqual([0, 0, 0, trafficHeight(512, 10)]);
    expect([...series.rxHeight]).toEqual([0, 0, 0, trafficHeight(256, 10)]);
    const latest = snapshot(5, [[5, 512, 256]]);
    const before = [...series.txHeight];
    expect(series.load(latest, 400, true)).toBe(false);
    expect([...series.txHeight]).toEqual(before);
    expect(series.load(latest, 540, true)).toBe(true);
    expect([...series.txHeight]).toEqual([0, 0, 0, 0]);
  });

  test('renderer bounds, direction, and health remain unchanged', () => {
    const series = createLinkStripSeries(34, 10);
    series.load(snapshot(0, [[0, 65_536, 65_536]]), 1, false);
    const rectangles: number[][] = [];
    const ctx = {
      globalAlpha: 1,
      fillStyle: '',
      clearRect() {
        rectangles.length = 0;
      },
      fillRect(x: number, y: number, w: number, h: number) {
        rectangles.push([x, y, w, h]);
      },
    };
    drawLinkStrip(ctx, 104, 22, 3, series, healthColor(37, false));
    expect(rectangles).toEqual([
      [0, 11, 104, 1],
      [99, 1, 2, 10],
      [99, 12, 2, 10],
    ]);
    expect(healthColor(null, false)).toBe(IDLE_COLOR);
    expect(healthColor(37, true)).toBe(healthColor(100, false));
    expect(healthColor(300, true)).toBe(healthColor(300, false));
  });
});

describe('frame and text scheduling', () => {
  test('worker publications use one rAF with no second cadence timer', () => {
    const clock = clockHarness();
    let paints = 0;
    const scheduler = createLinkStripScheduler({
      ...clock,
      paint() {
        paints += 1;
        return null;
      },
    });
    scheduler.resume();
    clock.advance(10);
    const before = clock.callbacks();
    clock.advance(60);
    for (let i = 0; i < 100; i += 1) scheduler.invalidate();
    expect(clock.pending()).toBe(1);
    clock.advance(70);
    expect(paints).toBe(2);
    expect(clock.callbacks() - before).toBe(1);
    expect(clock.pending()).toBe(0);
    clock.advance(60_000);
    expect(paints).toBe(2);
  });

  test('a text deadline paints from its timer, never through an animation frame', () => {
    const clock = clockHarness();
    let frames = 0;
    const frame: typeof clock.frame = {
      arm(callback) {
        frames += 1;
        clock.frame.arm(callback);
      },
      cancel: () => clock.frame.cancel(),
      isArmed: () => clock.frame.isArmed(),
    };
    let paints = 0;
    const scheduler = createLinkStripScheduler({
      now: clock.now,
      timer: clock.timer,
      frame,
      paint() {
        paints += 1;
        return null;
      },
    });
    // Worker snapshots coalesce into a frame.
    scheduler.resume();
    clock.advance(10);
    expect(paints).toBe(1);
    expect(frames).toBe(1);
    // A settled total is a timer and a paint, with no frame in between.
    scheduler.at(300);
    expect(clock.pending()).toBe(1);
    clock.advance(400);
    expect(paints).toBe(2);
    expect(frames).toBe(1);
    // A deadline already due paints now.
    scheduler.at(100);
    expect(paints).toBe(3);
    expect(frames).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  test('text settlement leaves waveform pixels untouched', () => {
    const clock = clockHarness();
    const series = createLinkStripSeries(34, 10);
    series.load(snapshot(0, [[0, 512, 128]]), 1, false);
    let drawings = 0;
    let readouts = 0;
    let dirty = true;
    const scheduler = createLinkStripScheduler({
      ...clock,
      paint(at) {
        if (dirty) {
          drawings += 1;
          dirty = false;
        }
        if (at >= 300 && readouts === 0) readouts += 1;
        return readouts === 0 ? 300 : null;
      },
    });
    scheduler.resume();
    clock.advance(400);
    expect(readouts).toBe(1);
    expect(drawings).toBe(1);
    expect(series.txHeight[33]).toBeGreaterThan(0);
    clock.advance(10_000);
    expect(drawings).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  test('state changes preempt a text deadline; pause cancels both timer and frame', () => {
    const clock = clockHarness();
    let paints = 0;
    const scheduler = createLinkStripScheduler({
      ...clock,
      paint() {
        paints += 1;
        return 1000;
      },
    });
    scheduler.resume();
    clock.advance(10);
    expect(clock.pending()).toBe(1);
    scheduler.invalidate();
    clock.advance(20);
    expect(paints).toBe(2);
    scheduler.pause();
    clock.advance(5000);
    expect(clock.pending()).toBe(0);
    expect(paints).toBe(2);
    scheduler.resume();
    scheduler.pause();
    expect(clock.pending()).toBe(0);
  });
});
