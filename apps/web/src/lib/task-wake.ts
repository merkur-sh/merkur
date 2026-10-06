const DEFAULT_TASK_WAKE_WATCHDOG_MS = 30_000;

interface ParkedTask {
  readonly resolve: () => void;
  readonly deadlineAtMs: number;
}

/**
 * A level-triggered, single-consumer wake used to turn a worker message into an
 * awaitable task edge. A wake that arrives before `wait` is latched, duplicate
 * wakes coalesce, and the watchdog prevents a permanently parked worker if the
 * producer realm disappears before posting its edge.
 *
 * One watchdog timer serves the wake's whole lifetime. A park arms it only when
 * it is not already running (or is running past the new deadline); a wake never
 * clears it. When it fires it settles a consumer parked past its deadline,
 * re-arms for the remainder if one parked later, and otherwise lies dormant
 * until the next park. The per-park cost is therefore the promise and its
 * executor — not a `setTimeout` and a `clearTimeout` per park, which on the
 * ACK path was one timer task minted and cancelled for every burst.
 */
export interface TaskWake {
  wait(watchdogMs?: number): Promise<void>;
  wake(): void;
  dispose(): void;
}

export function createTaskWake(): TaskWake {
  let pending = false;
  let disposed = false;
  let parked: ParkedTask | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let watchdogAtMs = 0;

  function settle(task: ParkedTask): void {
    if (parked !== task) return;
    parked = null;
    task.resolve();
  }

  function onWatchdog(): void {
    watchdog = null;
    const task = parked;
    if (task === null) return;
    const remainingMs = task.deadlineAtMs - performance.now();
    if (remainingMs > 0) {
      arm(task.deadlineAtMs, remainingMs);
      return;
    }
    settle(task);
  }

  function arm(deadlineAtMs: number, delayMs: number): void {
    watchdogAtMs = deadlineAtMs;
    watchdog = setTimeout(onWatchdog, Math.max(1, Math.ceil(delayMs)));
  }

  return {
    wait(watchdogMs = DEFAULT_TASK_WAKE_WATCHDOG_MS): Promise<void> {
      if (disposed) return Promise.resolve();
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      if (parked !== null) {
        throw new Error('Task wake already has a parked consumer');
      }

      const delayMs =
        Number.isFinite(watchdogMs) && watchdogMs > 0
          ? Math.max(1, Math.trunc(watchdogMs))
          : DEFAULT_TASK_WAKE_WATCHDOG_MS;
      const deadlineAtMs = performance.now() + delayMs;
      let resolve!: () => void;
      const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
      });
      parked = { resolve, deadlineAtMs };
      if (watchdog === null) {
        arm(deadlineAtMs, delayMs);
      } else if (watchdogAtMs > deadlineAtMs) {
        // A shorter watchdog than the one still running: the only park that
        // pays a cancellation, and one production never makes.
        clearTimeout(watchdog);
        arm(deadlineAtMs, delayMs);
      }
      return promise;
    },

    wake(): void {
      if (disposed) return;
      const task = parked;
      if (task === null) {
        pending = true;
        return;
      }
      settle(task);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      pending = false;
      if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      const task = parked;
      if (task !== null) settle(task);
    },
  };
}
