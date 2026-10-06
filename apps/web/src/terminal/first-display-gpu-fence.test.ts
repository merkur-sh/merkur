import { describe, expect, test } from 'bun:test';

import { createFirstDisplayGpuFenceTracker } from './first-display-gpu-fence';

describe('first authoritative display GPU fence', () => {
  test('CPU apply alone never publishes readiness and a real fence does so once', () => {
    const tracker = createFirstDisplayGpuFenceTracker<number>();

    expect(tracker.observeApplied(7)).toBe(true);
    expect(tracker.noteCompleted(true)).toBeNull();
    tracker.noteSubmitted(true);
    expect(tracker.noteCompleted(true)).toBe(7);
    expect(tracker.noteCompleted(true)).toBeNull();
    expect(tracker.observeApplied(8)).toBe(false);
  });

  test('a submission without a fence cannot satisfy readiness', () => {
    const tracker = createFirstDisplayGpuFenceTracker<number>();
    tracker.observeApplied(7);
    tracker.noteSubmitted(false);

    expect(tracker.hasInFlight()).toBe(false);
    expect(tracker.noteCompleted(false)).toBeNull();
  });

  test('an abandoned frame is reassigned to its replacement fence', () => {
    const tracker = createFirstDisplayGpuFenceTracker<number>();
    tracker.observeApplied(7);
    tracker.noteSubmitted(true);
    tracker.abandonSubmitted();

    expect(tracker.noteCompleted(true)).toBeNull();
    tracker.noteSubmitted(true);
    expect(tracker.noteCompleted(true)).toBe(7);
  });

  test('a resync discards an offscreen candidate so its snapshot owns readiness', () => {
    const tracker = createFirstDisplayGpuFenceTracker<number>();
    tracker.observeApplied(7);

    expect(tracker.discardPendingApplied()).toBe(true);
    expect(tracker.awaitingFirstApplied()).toBe(true);
    expect(tracker.observeApplied(8)).toBe(true);
    tracker.noteSubmitted(true);
    expect(tracker.noteCompleted(true)).toBe(8);
  });

  test('a submitted candidate cannot be relabelled as discarded', () => {
    const tracker = createFirstDisplayGpuFenceTracker<number>();
    tracker.observeApplied(7);
    tracker.noteSubmitted(true);

    expect(tracker.discardPendingApplied()).toBe(false);
    expect(tracker.awaitingFirstApplied()).toBe(false);
    expect(tracker.noteCompleted(true)).toBe(7);
  });

  test('the frame identity is built once per epoch, not once per applied frame', () => {
    const tracker = createFirstDisplayGpuFenceTracker<number>();
    let built = 0;
    const identity = (): number => {
      built += 1;
      return built;
    };
    // The worker's shape: the identity literal exists only behind the guard.
    const observe = (): void => {
      if (tracker.awaitingFirstApplied()) tracker.observeApplied(identity());
    };

    expect(tracker.awaitingFirstApplied()).toBe(true);
    observe();
    observe();
    observe();
    expect(built).toBe(1);
    expect(tracker.awaitingFirstApplied()).toBe(false);

    // An abandoned submission returns the candidate to pending; it is not
    // asked for again.
    tracker.noteSubmitted(true);
    tracker.abandonSubmitted();
    expect(tracker.awaitingFirstApplied()).toBe(false);
    tracker.noteSubmitted(true);
    expect(tracker.noteCompleted(true)).toBe(1);
    observe();
    expect(built).toBe(1);
    expect(tracker.awaitingFirstApplied()).toBe(false);

    tracker.resetEpoch();
    expect(tracker.awaitingFirstApplied()).toBe(true);
    observe();
    expect(built).toBe(2);
  });

  test('a new authenticated epoch discards every prior candidate and rearms', () => {
    const tracker = createFirstDisplayGpuFenceTracker<number>();
    tracker.observeApplied(7);
    tracker.noteSubmitted(true);
    tracker.resetEpoch();

    expect(tracker.noteCompleted(true)).toBeNull();
    expect(tracker.observeApplied(1)).toBe(true);
    tracker.noteSubmitted(true);
    expect(tracker.noteCompleted(true)).toBe(1);
  });
});
