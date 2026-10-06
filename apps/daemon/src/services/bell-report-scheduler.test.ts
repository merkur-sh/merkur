import { describe, expect, test } from 'bun:test';
import { Deferred, Effect, Exit, Fiber, Option, Queue, Ref, Scope } from 'effect';
import { TestClock } from 'effect/testing';

import { createBellReportSchedulerScoped } from './bell-report-scheduler';

describe('createBellReportSchedulerScoped', () => {
  test('uses TestClock for the remaining rate-limit delay', async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const sent = yield* Queue.unbounded<number>();
          const scheduler = yield* createBellReportSchedulerScoped(
            (occurredAt) => Queue.offer(sent, occurredAt).pipe(Effect.asVoid),
            1_000,
          );

          scheduler.reportBell();
          const first = yield* Queue.take(sent);
          yield* Effect.yieldNow;

          yield* TestClock.adjust('900 millis');
          scheduler.reportBell();
          yield* TestClock.adjust('99 millis');
          const beforeWindow = yield* Queue.poll(sent);
          yield* TestClock.adjust('1 millis');
          const second = yield* Queue.take(sent);

          return { first, beforeWindow, second };
        }),
      ),
    );

    expect(result.first).toBe(0);
    expect(Option.isNone(result.beforeWindow)).toBe(true);
    expect(result.second).toBe(900);
  });

  test('coalesces a burst to the newest pending occurrence', async () => {
    const sent = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const deliveries = yield* Queue.unbounded<number>();
          const scheduler = yield* createBellReportSchedulerScoped(
            (occurredAt) => Queue.offer(deliveries, occurredAt).pipe(Effect.asVoid),
            1_000,
          );

          scheduler.reportBell();
          const first = yield* Queue.take(deliveries);
          yield* Effect.yieldNow;

          yield* TestClock.adjust('100 millis');
          scheduler.reportBell();
          yield* TestClock.adjust('150 millis');
          scheduler.reportBell();
          yield* TestClock.adjust('450 millis');
          scheduler.reportBell();
          yield* TestClock.adjust('300 millis');
          const trailing = yield* Queue.take(deliveries);

          return [first, trailing];
        }),
      ),
    );

    expect(sent).toEqual([0, 700]);
  });

  test('releases a pending report after the bounded send timeout', async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const sent = yield* Ref.make<number[]>([]);
          const firstStarted = yield* Deferred.make<void>();
          const firstInterrupted = yield* Deferred.make<void>();
          const secondStarted = yield* Deferred.make<void>();
          let deliveryCount = 0;
          const scheduler = yield* createBellReportSchedulerScoped(
            (occurredAt) =>
              Effect.gen(function* () {
                yield* Ref.update(sent, (current) => [...current, occurredAt]);
                deliveryCount += 1;
                if (deliveryCount === 1) {
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Effect.never.pipe(
                    Effect.onInterrupt(() => Deferred.succeed(firstInterrupted, undefined)),
                  );
                } else {
                  yield* Deferred.succeed(secondStarted, undefined);
                }
              }),
            1_000,
            { sendDeadlineMs: 5_000 },
          );

          scheduler.reportBell();
          yield* Deferred.await(firstStarted);
          yield* TestClock.adjust('100 millis');
          scheduler.reportBell();
          yield* TestClock.adjust('4900 millis');
          yield* Deferred.await(firstInterrupted);
          yield* Deferred.await(secondStarted);

          return yield* Ref.get(sent);
        }),
      ),
    );

    expect(result).toEqual([0, 100]);
  });

  test('interrupts an active send and ignores future bells when its scope closes', async () => {
    const result = await runWithTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const calls = yield* Ref.make(0);
        const scheduler = yield* createBellReportSchedulerScoped(
          () =>
            Ref.update(calls, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
          1_000,
        ).pipe(Effect.provideService(Scope.Scope, scope));

        scheduler.reportBell();
        yield* Deferred.await(started);
        scheduler.reportBell();
        yield* Scope.close(scope, Exit.void);
        yield* Deferred.await(interrupted);

        scheduler.reportBell();
        yield* TestClock.adjust('10 seconds');
        return yield* Ref.get(calls);
      }),
    );

    expect(result).toBe(1);
  });

  test('scope shutdown runs an abortable async adapter canceler', async () => {
    const aborted = await runWithTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const signalPublished = yield* Deferred.make<AbortSignal>();
        const scheduler = yield* createBellReportSchedulerScoped(
          () =>
            Effect.acquireUseRelease(
              Effect.sync(() => new AbortController()),
              (controller) =>
                Effect.sync(() => {
                  Deferred.doneUnsafe(signalPublished, Effect.succeed(controller.signal));
                }).pipe(Effect.andThen(Effect.never)),
              (controller) => Effect.sync(() => controller.abort()),
            ),
          1_000,
        ).pipe(Effect.provideService(Scope.Scope, scope));

        scheduler.reportBell();
        const signal = yield* Deferred.await(signalPublished);
        yield* Scope.close(scope, Exit.void);
        return signal.aborted;
      }),
    );

    expect(aborted).toBe(true);
  });

  test('does not leave its scoped worker running after interruption', async () => {
    const completed = await runWithTestClock(
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        const fiber = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* createBellReportSchedulerScoped(() => Effect.void, 1_000);
            yield* Deferred.succeed(done, undefined);
            return yield* Effect.never;
          }),
        ).pipe(Effect.forkChild);

        yield* Deferred.await(done);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        return Exit.hasInterrupts(exit);
      }),
    );

    expect(completed).toBe(true);
  });

  test('fails closed and publishes a typed fatal signal after a sender defect', async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const calls = yield* Ref.make(0);
          const defect = new Error('sender invariant violated');
          const scheduler = yield* createBellReportSchedulerScoped(
            () => Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(Effect.die(defect))),
            1_000,
          );

          scheduler.reportBell();
          const failure = yield* Effect.flip(scheduler.awaitCriticalFailure());
          scheduler.reportBell();
          yield* TestClock.adjust('10 seconds');

          return {
            failure,
            calls: yield* Ref.get(calls),
          };
        }),
      ),
    );

    expect(result.failure._tag).toBe('BellReportWorkerFatalError');
    expect(result.failure.reason).toBe('sender_defect');
    expect(result.failure.cause).toBeDefined();
    expect(result.calls).toBe(1);
  });
});

function runWithTestClock<A>(effect: Effect.Effect<A>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())));
}
