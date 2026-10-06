import { expect, test } from 'bun:test';
import { Effect, Fiber } from 'effect';
import { createLifecycleClock } from './lifecycle-clock';

test('registered lifecycle tasks reach suspension before deadline exhaustion is asserted', async () => {
  const clock = await createLifecycleClock();
  let saved = false;
  const fiber = clock.runtime.runFork(
    Effect.gen(function* () {
      for (let operation = 0; operation < 20; operation++) yield* Effect.yieldNow;
      yield* Effect.sleep('750 millis');
      saved = true;
    }),
  );
  try {
    await clock.until(() => saved, 'queued lifecycle operation');
    expect(saved).toBe(true);
    expect(clock.runtime.now()).toBe(750);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
    await clock.close();
  }
});
