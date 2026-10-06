import { Clock, Context, Effect } from 'effect';

/**
 * A deadline on the runtime's clock that runs a plain callback, with no fiber
 * of its own. Live, it is the platform timer the live clock's `sleep` is built
 * on; a test clock supplies deadlines it advances itself.
 */
interface LifecycleTimer {
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

/** One clock follows every fiber and timer started at a browser lifecycle boundary. */
export function createLifecycleRuntime(clock: Clock.Clock, timer: LifecycleTimer) {
  const services = Context.make(Clock.Clock, clock);
  return {
    runFork: Effect.runForkWith(services),
    runPromise: Effect.runPromiseWith(services),
    now: () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  };
}

export type LifecycleRuntime = ReturnType<typeof createLifecycleRuntime>;

export const liveLifecycleRuntime = createLifecycleRuntime(
  Effect.runSync(Clock.clockWith(Effect.succeed)),
  {
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
);
