import { describe, expect, test } from 'bun:test';

import {
  createMainThreadFrameMonitor,
  type MainThreadFrameMonitorHost,
  type MainThreadLongTaskEntry,
  type MainThreadLongTaskObserver,
} from './main-thread-frame-monitor';

function harness(longTasksSupported = true): {
  readonly host: MainThreadFrameMonitorHost;
  frame(timestampMs: number): void;
  visibility(visible: boolean): void;
  longTasks(entries: readonly MainThreadLongTaskEntry[]): void;
  queueLongTasks(entries: readonly MainThreadLongTaskEntry[]): void;
  readonly cancelled: number[];
  readonly gaps: Array<[number, number, boolean]>;
  readonly tasks: Array<[number, number]>;
  monitor(): ReturnType<typeof createMainThreadFrameMonitor>;
} {
  let frameCallback: ((timestampMs: number) => void) | null = null;
  let visibilityCallback: (() => void) | null = null;
  let taskCallback: ((entries: readonly MainThreadLongTaskEntry[]) => void) | null = null;
  let pendingTasks: readonly MainThreadLongTaskEntry[] = [];
  let visible = true;
  let nextFrameHandle = 1;
  const cancelled: number[] = [];
  const gaps: Array<[number, number, boolean]> = [];
  const tasks: Array<[number, number]> = [];
  const host: MainThreadFrameMonitorHost = {
    timeOriginMs: 1_000,
    requestFrame(callback): number {
      frameCallback = callback;
      const handle = nextFrameHandle;
      nextFrameHandle += 1;
      return handle;
    },
    cancelFrame(handle): void {
      cancelled.push(handle);
    },
    isVisible: () => visible,
    onVisibilityChange(callback): () => void {
      visibilityCallback = callback;
      return () => {
        visibilityCallback = null;
      };
    },
    observeLongTasks(callback): MainThreadLongTaskObserver | null {
      if (!longTasksSupported) return null;
      taskCallback = callback;
      return {
        flush(): void {
          if (pendingTasks.length > 0) callback(pendingTasks);
          pendingTasks = [];
        },
        disconnect(): void {
          taskCallback = null;
        },
      };
    },
  };
  return {
    host,
    frame(timestampMs): void {
      const callback = frameCallback;
      if (callback === null) throw new Error('frame callback is not armed');
      callback(timestampMs);
    },
    visibility(nextVisible): void {
      visible = nextVisible;
      visibilityCallback?.();
    },
    longTasks(entries): void {
      taskCallback?.(entries);
    },
    queueLongTasks(entries): void {
      pendingTasks = entries;
    },
    cancelled,
    gaps,
    tasks,
    monitor() {
      return createMainThreadFrameMonitor(host, {
        noteFrameGap: (atMs, gapMs, supported) => gaps.push([atMs, gapMs, supported]),
        noteLongTask: (atMs, durationMs) => tasks.push([atMs, durationMs]),
      });
    },
  };
}

describe('main-thread frame monitor', () => {
  test('records raw visible rAF gaps without classifying a refresh rate', () => {
    const testHost = harness();
    const monitor = testHost.monitor();
    monitor.start();
    testHost.frame(10);
    testHost.frame(14.167);
    testHost.frame(22.5);
    expect(testHost.gaps).toEqual([
      [1_014.167, 4.167, true],
      [1_022.5, 8.333, true],
    ]);
  });

  test('drops intervals crossing hidden and visible lifecycle edges', () => {
    const testHost = harness();
    const monitor = testHost.monitor();
    monitor.start();
    testHost.frame(10);
    testHost.visibility(false);
    testHost.frame(5_000);
    testHost.visibility(true);
    testHost.frame(5_010);
    testHost.frame(5_026.667);
    expect(testHost.gaps).toHaveLength(1);
    expect(testHost.gaps[0]?.[0]).toBe(6_026.667);
    expect(testHost.gaps[0]?.[1]).toBeCloseTo(16.667, 6);
    expect(testHost.gaps[0]?.[2]).toBe(true);
  });

  test('records only valid browser-attributed long tasks and exposes support', () => {
    const testHost = harness();
    const monitor = testHost.monitor();
    monitor.start();
    testHost.frame(0);
    testHost.frame(16.667);
    testHost.longTasks([
      { startTime: 5, duration: 52 },
      { startTime: Number.NaN, duration: 60 },
      { startTime: 9, duration: -1 },
    ]);
    expect(testHost.gaps[0]?.[2]).toBe(true);
    expect(testHost.tasks).toEqual([[1_005, 52]]);

    const unsupported = harness(false);
    const unsupportedMonitor = unsupported.monitor();
    unsupportedMonitor.start();
    unsupported.frame(0);
    unsupported.frame(16.667);
    expect(unsupported.gaps[0]?.[2]).toBe(false);
  });

  test('start and stop are idempotent and stale callbacks stay inert', () => {
    const testHost = harness();
    const monitor = testHost.monitor();
    monitor.start();
    monitor.start();
    testHost.frame(1);
    monitor.stop();
    monitor.stop();
    testHost.frame(2);
    testHost.longTasks([{ startTime: 2, duration: 60 }]);
    expect(testHost.cancelled).toEqual([2]);
    expect(testHost.gaps).toEqual([]);
    expect(testHost.tasks).toEqual([]);
  });

  test('stop flushes observer-owned long-task records before fencing callbacks', () => {
    const testHost = harness();
    const monitor = testHost.monitor();
    monitor.start();
    testHost.queueLongTasks([{ startTime: 7, duration: 61 }]);
    monitor.stop();
    testHost.longTasks([{ startTime: 9, duration: 70 }]);
    expect(testHost.tasks).toEqual([[1_007, 61]]);
  });

  test('snapshot flush drains pending records once without interrupting observation', () => {
    const testHost = harness();
    const monitor = testHost.monitor();
    monitor.start();
    testHost.frame(10);
    testHost.queueLongTasks([{ startTime: 7, duration: 61 }]);
    monitor.flush();
    monitor.flush();
    testHost.frame(26);
    testHost.longTasks([{ startTime: 80, duration: 55 }]);
    expect(testHost.tasks).toEqual([
      [1_007, 61],
      [1_080, 55],
    ]);
    expect(testHost.gaps).toEqual([[1_026, 16, true]]);
    expect(testHost.cancelled).toEqual([]);
    monitor.stop();
  });
});
