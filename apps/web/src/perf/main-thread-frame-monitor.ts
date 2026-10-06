/**
 * Perf-only main-thread cadence observer.
 *
 * Every continuous visible rAF interval is emitted as the raw interval the
 * browser supplied. Missed-frame classification is deliberately deferred to
 * the report, where the whole measurement window is available; guessing a
 * refresh rate in this callback would turn a monitor move or VRR interval into
 * fabricated jank. The hot callback owns no growing collection and allocates
 * no per-frame record -- its sink writes directly into the fixed perf ring.
 *
 * Long tasks are a separate browser-owned observation. Their duration is not
 * inferred from an rAF gap: an rAF gap can include scheduling, compositor, or
 * visibility effects, while PerformanceObserver's `longtask` entries are the
 * browser's direct attribution of main-thread occupation.
 */

export interface MainThreadFrameMonitorSink {
  noteFrameGap(atMs: number, gapMs: number, longTaskObserverSupported: boolean): void;
  noteLongTask(startAtMs: number, durationMs: number): void;
}

export interface MainThreadLongTaskEntry {
  readonly startTime: number;
  readonly duration: number;
}

export interface MainThreadLongTaskObserver {
  flush(): void;
  disconnect(): void;
}

export interface MainThreadFrameMonitorHost {
  readonly timeOriginMs: number;
  requestFrame(callback: (timestampMs: number) => void): number;
  cancelFrame(handle: number): void;
  isVisible(): boolean;
  onVisibilityChange(callback: () => void): () => void;
  observeLongTasks(
    callback: (entries: readonly MainThreadLongTaskEntry[]) => void,
  ): MainThreadLongTaskObserver | null;
}

export interface MainThreadFrameMonitor {
  start(): void;
  /** Publish browser-owned records before requesting a telemetry drain or snapshot. */
  flush(): void;
  stop(): void;
}

export function createMainThreadFrameMonitor(
  host: MainThreadFrameMonitorHost,
  sink: MainThreadFrameMonitorSink,
): MainThreadFrameMonitor {
  let running = false;
  let frameHandle = 0;
  let previousFrameAtMs: number | null = null;
  let removeVisibilityListener: (() => void) | null = null;
  let longTaskObserver: MainThreadLongTaskObserver | null = null;
  let longTaskObserverSupported = false;

  const onFrame = (timestampMs: number): void => {
    if (!running) return;
    if (host.isVisible() && Number.isFinite(timestampMs)) {
      const previous = previousFrameAtMs;
      if (previous !== null && timestampMs >= previous) {
        sink.noteFrameGap(
          host.timeOriginMs + timestampMs,
          timestampMs - previous,
          longTaskObserverSupported,
        );
      }
      previousFrameAtMs = timestampMs;
    } else {
      // A background-tab gap is browser throttling, not a missed active frame.
      previousFrameAtMs = null;
    }
    frameHandle = host.requestFrame(onFrame);
  };

  const onVisibilityChange = (): void => {
    // Drop the interval crossing either visibility edge. The next pair of
    // visible callbacks establishes an entirely active interval.
    previousFrameAtMs = null;
  };

  const onLongTasks = (entries: readonly MainThreadLongTaskEntry[]): void => {
    if (!running) return;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (
        entry === undefined ||
        !Number.isFinite(entry.startTime) ||
        !Number.isFinite(entry.duration) ||
        entry.startTime < 0 ||
        entry.duration < 0
      ) {
        continue;
      }
      sink.noteLongTask(host.timeOriginMs + entry.startTime, entry.duration);
    }
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      previousFrameAtMs = null;
      removeVisibilityListener = host.onVisibilityChange(onVisibilityChange);
      longTaskObserver = host.observeLongTasks(onLongTasks);
      longTaskObserverSupported = longTaskObserver !== null;
      frameHandle = host.requestFrame(onFrame);
    },

    flush(): void {
      longTaskObserver?.flush();
    },

    stop(): void {
      if (!running) return;
      host.cancelFrame(frameHandle);
      frameHandle = 0;
      previousFrameAtMs = null;
      // PerformanceObserver callbacks are asynchronous. Keep the sink live
      // while its owner flushes `takeRecords()`, otherwise a long task that
      // ended immediately before a final perf snapshot silently disappears.
      longTaskObserver?.flush();
      longTaskObserver?.disconnect();
      longTaskObserver = null;
      running = false;
      removeVisibilityListener?.();
      removeVisibilityListener = null;
      longTaskObserverSupported = false;
    },
  };
}

/** Production host. Kept here so the state machine above remains deterministic. */
export function browserMainThreadFrameMonitorHost(): MainThreadFrameMonitorHost {
  return {
    timeOriginMs: performance.timeOrigin,
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    isVisible: () => document.visibilityState === 'visible',
    onVisibilityChange(callback): () => void {
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },
    observeLongTasks(callback): MainThreadLongTaskObserver | null {
      if (
        typeof PerformanceObserver === 'undefined' ||
        !PerformanceObserver.supportedEntryTypes.includes('longtask')
      ) {
        return null;
      }
      const observer = new PerformanceObserver((list) => callback(list.getEntries()));
      observer.observe({ type: 'longtask', buffered: false });
      return {
        flush(): void {
          const pending = observer.takeRecords();
          if (pending.length > 0) callback(pending);
        },
        disconnect(): void {
          observer.disconnect();
        },
      };
    },
  };
}
