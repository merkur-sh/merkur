import { describe, expect, test } from 'bun:test';
import { TERMINAL_LIFECYCLE_CONNECTING, TERMINAL_LIFECYCLE_READY } from '@merkur/shared';
import { createSessionStateStore, shouldEnterDormantOnReconnect } from './session-state';

describe('dormancy is not armed while another path carries the terminal', () => {
  /**
   * Signaling rides the edge carrier alone, so losing it always emits
   * `reconnecting` — but `onProviderDisconnected` removes only the edge provider
   * and the mux keeps routing input and display over a live direct path. Arming
   * dormancy there schedules a one-minute teardown of a session that is working
   * the whole time, and covers a live terminal while it waits.
   *
   * The daemon has always encoded the same asymmetry: `classify_counterpart_detach`
   * returns `Ignore` while a direct path is available.
   */
  test('a live direct path suppresses the dormant deadline', () => {
    expect(shouldEnterDormantOnReconnect(TERMINAL_LIFECYCLE_READY, true)).toBe(false);
  });

  test('losing the only path still arms it', () => {
    expect(shouldEnterDormantOnReconnect(TERMINAL_LIFECYCLE_READY, false)).toBe(true);
  });

  test('a session that never reached ready has no dormancy to arm', () => {
    expect(shouldEnterDormantOnReconnect(TERMINAL_LIFECYCLE_CONNECTING, false)).toBe(false);
  });
});

describe('session state local-duration clock', () => {
  test('the resync degradation window uses its injected monotonic clock from time zero', () => {
    let monotonicNowMs = 0;
    const store = createSessionStateStore({
      now: () => monotonicNowMs,
    });

    store.markResyncDegraded();
    expect(store.getQuality().degraded).toBe(true);
    monotonicNowMs = 4_999;
    expect(store.getQuality().degraded).toBe(true);
    monotonicNowMs = 5_000;
    expect(store.getQuality().degraded).toBe(false);
  });
});

describe('what the link strip draws a column from', () => {
  const storeAt = (clock: { ms: number }) => createSessionStateStore({ now: () => clock.ms });

  test('the sample and the floor are reported side by side, never folded together', () => {
    // The widget drew `networkRttMs ?? rttMs` — the eight-second minimum — and
    // called it the latency, so a link with a 30ms median and a 400ms tail read
    // "30ms", in green, permanently. The strip needs both: the floor is the
    // base of each bar, the sample is its height, and the difference is the
    // jitter, which is the part anyone actually feels.
    const clock = { ms: 0 };
    const store = storeAt(clock);

    store.recordRtt(30, 'direct');
    expect(store.getQuality()).toMatchObject({ rttMs: 30, rttFloorMs: 30 });

    clock.ms = 2_000;
    store.recordRtt(400, 'direct');
    expect(store.getQuality()).toMatchObject({ rttMs: 400, rttFloorMs: 30 });

    // The floor is a window, so a sustained slowdown reaches it once the fast
    // samples age out rather than being pinned by one lucky early measurement.
    clock.ms = 9_000;
    store.recordRtt(380, 'direct');
    expect(store.getQuality()).toMatchObject({ rttMs: 380, rttFloorMs: 380 });
  });

  test('a path change starts the floor window over', () => {
    // Reporting a relayed path's latency under a direct path's minimum is how a
    // hand-off used to read as though nothing had changed.
    const clock = { ms: 0 };
    const store = storeAt(clock);

    store.recordRtt(28, 'direct');
    clock.ms = 1_000;
    store.recordRtt(96, 'relay');
    expect(store.getQuality()).toMatchObject({ path: 'relay', rttFloorMs: 96 });
  });

  test('a null sample updates the path label without inventing a measurement', () => {
    const clock = { ms: 0 };
    const store = storeAt(clock);

    store.recordRtt(40, 'direct');
    const measured = store.getQuality();
    store.recordRtt(null, 'direct');
    const after = store.getQuality();
    expect(after.rttMs).toBe(40);
    // `seq` is the strip's evidence that a column measured something. A pong
    // that never came must not make a column claim it did.
    expect(after.seq).toBe(measured.seq);
  });

  test('an input-ack sample is a sample, not the retry controller EWMA', () => {
    // The EWMA the retry controller reads is never decayed, so it asserts its
    // last reading forever — through idle and across a reconnect. The strip
    // draws the sample and the counter beside it, so a column can tell a fresh
    // measurement from a value it is merely still holding.
    const clock = { ms: 0 };
    const store = storeAt(clock);

    expect(store.getQuality()).toMatchObject({ inputAckMs: null, inputAckSeq: 0 });
    store.recordInputAckSample(21);
    store.recordInputAckSample(64);
    expect(store.getQuality()).toMatchObject({ inputAckMs: 64, inputAckSeq: 2 });
  });

  test('resyncs are counted, not just flagged for five seconds', () => {
    // `degraded` is a window: it says "lately", which cannot place a mark on
    // the column a resync happened in, and cannot say there were three.
    const clock = { ms: 0 };
    const store = storeAt(clock);

    store.markResyncDegraded();
    clock.ms = 10_000;
    store.markResyncDegraded();
    expect(store.getQuality().resyncCount).toBe(2);
  });
});

test('dormancy is a projection until authenticated recovery or owner close', () => {
  const changed: boolean[] = [];
  const store = createSessionStateStore({ onDormantChange: (value) => changed.push(value) });
  store.enterDormant();
  store.enterDormant();
  expect(store.isDormant()).toBe(true);
  store.exitDormant();
  expect(changed).toEqual([true, false]);
  store.enterDormant();
  store.clearDormant();
  expect(store.isDormant()).toBe(false);
  expect(changed).toEqual([true, false, true]);
});

test('relay pause is connection status, with direct availability taking precedence', () => {
  let direct = false;
  const store = createSessionStateStore({ hasLiveDirectPath: () => direct });
  store.tryTransition(TERMINAL_LIFECYCLE_CONNECTING);
  store.setRelayDataState('paused');
  expect(store.currentLinkState()).toBe('relay-paused');
  expect(store.isDormant()).toBe(false);
  direct = true;
  expect(store.currentLinkState()).toBe('connecting');
  direct = false;
  expect(store.currentLinkState()).toBe('relay-paused');
  store.setRelayDataState('open');
  expect(store.currentLinkState()).toBe('connecting');
  store.setRelayDataState('stopped');
  expect(store.currentLinkState()).toBe('relay-stopped');
});
