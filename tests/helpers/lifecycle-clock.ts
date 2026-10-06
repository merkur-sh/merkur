import { Clock, Context, Duration, Effect, Exit, Fiber, Scheduler, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { createLifecycleRuntime } from '../../apps/web/src/lib/lifecycle-runtime';

/** Advances actual registered deadlines, including retries created by their callbacks. */
export async function createLifecycleClock() {
  const scope = Effect.runSync(Scope.make());
  const clock = await Effect.runPromise(
    TestClock.make().pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const baseScheduler = new Scheduler.MixedScheduler();
  const dispatcher = baseScheduler.makeDispatcher();
  const scheduler: Scheduler.Scheduler = {
    executionMode: baseScheduler.executionMode,
    shouldYield: (fiber) => baseScheduler.shouldYield(fiber),
    makeDispatcher: () => dispatcher,
  };
  const deadlines = new Map<object, number>();
  const tracked: Clock.Clock = {
    ...clock,
    sleep: (duration) =>
      Effect.suspend(() => {
        const owner = {};
        deadlines.set(owner, clock.currentTimeMillisUnsafe() + Duration.toMillis(duration));
        return clock
          .sleep(duration)
          .pipe(Effect.ensuring(Effect.sync(() => deadlines.delete(owner))));
      }),
  };
  // Plain timers sleep on the same tracked clock, so `advance` fires them and
  // `until` sees their deadlines exactly as it sees a fiber's.
  const services = Context.make(Clock.Clock, tracked).pipe(
    Context.add(Scheduler.Scheduler, scheduler),
  );
  const fork = Effect.runForkWith(services);
  const runPromise = Effect.runPromiseWith(services);
  const timers: Parameters<typeof createLifecycleRuntime>[1] = {
    setTimer: (callback, delayMs) =>
      fork(tracked.sleep(Duration.millis(delayMs)).pipe(Effect.andThen(Effect.sync(callback)))),
    clearTimer: (handle) => {
      fork(Fiber.interrupt(handle as Fiber.Fiber<void>));
    },
  };
  const runtime = { ...createLifecycleRuntime(tracked, timers), runFork: fork, runPromise };
  const flush = async () => {
    // A shared dispatcher owns every lifecycle fiber and child. Its flush drains
    // registered tasks until none remain; an unrelated event-loop turn cannot
    // establish that a yielding fiber has reached its next sleep or suspension.
    dispatcher.flush();
    await runPromise(clock.adjust(0));
    dispatcher.flush();
  };
  const advance = async (milliseconds: number) => {
    await flush();
    await runPromise(clock.adjust(milliseconds));
    await flush();
  };
  return {
    runtime,
    advance,
    flush,
    async until(predicate: () => boolean, label = 'expected lifecycle event') {
      await flush();
      while (!predicate()) {
        const next = Math.min(...deadlines.values());
        if (!Number.isFinite(next)) throw new Error(`${label}: no scheduled work remains`);
        // To the deadline itself, never by the distance to it. A jittered deadline is a
        // fraction of a millisecond and a duration is whole nanoseconds, so now plus the
        // rounded distance can land one float step short of the sleeper; it then stays
        // asleep, and every later distance rounds to zero.
        await runPromise(clock.setTime(Math.max(next, clock.currentTimeMillisUnsafe())));
        await flush();
      }
    },
    async close() {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}
