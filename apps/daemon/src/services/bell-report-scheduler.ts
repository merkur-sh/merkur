import {
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Queue,
  Ref,
  type Scope,
} from 'effect';

const DEFAULT_SEND_DEADLINE_MS = 5_000;

interface BellEvent {
  readonly occurredAt: number;
}

type DeliveryCompletion =
  | { readonly _tag: 'Delivery'; readonly exit: Exit.Exit<void, unknown> }
  | { readonly _tag: 'Deadline' };

type PublicationState =
  | { readonly _tag: 'Idle' }
  | {
      readonly _tag: 'Reserved';
      readonly first: BellEvent;
      readonly pending: BellEvent | null;
    }
  | {
      readonly _tag: 'Waiting';
      readonly pending: BellEvent;
    }
  | {
      readonly _tag: 'Sending';
      readonly pending: BellEvent | null;
    }
  | { readonly _tag: 'Closed' };

export interface BellReportScheduler {
  /**
   * Publishes a bell from the imperative dataplane callback. The bridge is
   * deliberately synchronous and bounded: the first immediately-sendable bell
   * is retained, while any trailing burst is coalesced to its newest timestamp.
   */
  reportBell(): void;
  /**
   * Fails exactly once when the worker encounters an unrecoverable defect.
   * Normal scope interruption leaves this pending so an enclosing supervisor
   * can race it with the daemon's other critical components.
   */
  awaitCriticalFailure(): Effect.Effect<never, BellReportWorkerFatalError>;
}

export interface BellReportSchedulerOptions {
  readonly sendDeadlineMs?: number;
}

export type BellReportSender = (occurredAt: number) => Effect.Effect<void, unknown>;

export class BellReportWorkerFatalError extends Data.TaggedError('BellReportWorkerFatalError')<{
  readonly reason: 'sender_defect' | 'worker_defect';
  readonly cause: unknown;
}> {}

/**
 * Effect-native bell-report lifecycle.
 *
 * One scoped worker owns rate limiting and delivery. Effect's Clock drives both
 * sleeps and monotonic elapsed-time decisions, so production interruption and
 * TestClock use exactly the same path. A timed-out or failed report is not
 * retried; only a later, coalesced bell can produce another report.
 */
export function createBellReportSchedulerScoped(
  send: BellReportSender,
  minIntervalMs: number,
  options: BellReportSchedulerOptions = {},
): Effect.Effect<BellReportScheduler, never, Scope.Scope> {
  return Effect.gen(function* () {
    validateDuration('minIntervalMs', minIntervalMs, true);
    const sendDeadlineMs = options.sendDeadlineMs ?? DEFAULT_SEND_DEADLINE_MS;
    validateDuration('sendDeadlineMs', sendDeadlineMs, false);

    const clock = yield* Clock.Clock;
    const wake = yield* Queue.dropping<void>(1);
    const lastStartedAt = yield* Ref.make<bigint | null>(null);
    const criticalFailure = yield* Deferred.make<never, BellReportWorkerFatalError>();
    const minIntervalNanos = Duration.toNanosUnsafe(Duration.millis(minIntervalMs));
    const sendDeadline = Duration.millis(sendDeadlineMs);

    // This is the small synchronous publication adapter required by the
    // sidecar callback. All non-hot lifecycle work remains in the worker fiber.
    let publication: PublicationState = { _tag: 'Idle' };

    const reportBell = (): void => {
      const event: BellEvent = {
        occurredAt: clock.currentTimeMillisUnsafe(),
      };

      switch (publication._tag) {
        case 'Closed':
          return;
        case 'Idle': {
          const now = clock.currentTimeNanosUnsafe();
          const previousStart = Ref.getUnsafe(lastStartedAt);
          const canStartImmediately =
            previousStart === null || elapsedNanos(previousStart, now) >= minIntervalNanos;
          publication = canStartImmediately
            ? { _tag: 'Reserved', first: event, pending: null }
            : { _tag: 'Waiting', pending: event };
          Queue.offerUnsafe(wake, undefined);
          return;
        }
        case 'Reserved':
          publication = { ...publication, pending: event };
          return;
        case 'Waiting':
          publication = { _tag: 'Waiting', pending: event };
          return;
        case 'Sending':
          publication = { ...publication, pending: event };
          return;
      }
    };

    const waitForRateLimit = Effect.gen(function* () {
      const previousStart = yield* Ref.get(lastStartedAt);
      if (previousStart === null) return;
      const now = yield* Clock.currentTimeNanos;
      const remaining = minIntervalNanos - elapsedNanos(previousStart, now);
      if (remaining > 0n) {
        yield* Effect.sleep(Duration.nanos(remaining));
      }
    });

    const takeNext = Effect.gen(function* () {
      switch (publication._tag) {
        case 'Reserved': {
          const event = publication.first;
          publication = { _tag: 'Sending', pending: publication.pending };
          return event;
        }
        case 'Waiting': {
          yield* waitForRateLimit;
          if (publication._tag !== 'Waiting') return null;
          const event = publication.pending;
          publication = { _tag: 'Sending', pending: null };
          return event;
        }
        case 'Closed':
        case 'Idle':
        case 'Sending':
          return null;
      }
    });

    const deliver = (event: BellEvent) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeNanos;
        yield* Ref.set(lastStartedAt, startedAt);

        const completed = yield* Deferred.make<DeliveryCompletion>();
        const deliveryFiber = yield* Effect.suspend(() => send(event.occurredAt)).pipe(
          Effect.exit,
          Effect.tap((exit) => Deferred.succeed(completed, { _tag: 'Delivery', exit })),
          Effect.forkChild,
        );
        const deadlineFiber = yield* Effect.sleep(sendDeadline).pipe(
          Effect.andThen(Deferred.succeed(completed, { _tag: 'Deadline' })),
          Effect.forkChild,
        );
        const completion = yield* Deferred.await(completed);
        // Interrupt the actual delivery fiber, not only a race wrapper. This
        // guarantees its scoped AbortController release path runs on timeout.
        yield* Effect.all([Fiber.interrupt(deliveryFiber), Fiber.interrupt(deadlineFiber)], {
          discard: true,
        });

        const deliveryDefect =
          completion._tag === 'Delivery'
            ? Exit.hasDies(completion.exit)
              ? completion.exit.cause
              : undefined
            : yield* Fiber.await(deliveryFiber).pipe(
                Effect.map((outerExit) => {
                  if (Exit.hasDies(outerExit)) return outerExit.cause;
                  if (Exit.isSuccess(outerExit) && Exit.hasDies(outerExit.value)) {
                    return outerExit.value.cause;
                  }
                  return undefined;
                }),
              );
        if (deliveryDefect !== undefined) {
          return yield* new BellReportWorkerFatalError({
            reason: 'sender_defect',
            cause: deliveryDefect,
          });
        }
      });

    const finishDelivery = Effect.sync(() => {
      if (publication._tag !== 'Sending') return false;
      if (publication.pending === null) {
        publication = { _tag: 'Idle' };
        return false;
      }
      publication = { _tag: 'Waiting', pending: publication.pending };
      return true;
    });

    const processLane: Effect.Effect<void, BellReportWorkerFatalError> = Effect.gen(function* () {
      while (publication._tag !== 'Closed') {
        const event = yield* takeNext;
        if (event === null) return;
        yield* deliver(event);
        if (!(yield* finishDelivery)) return;
      }
    });

    const worker = Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(wake);
        yield* processLane;
      }),
    );

    const failClosed = (failure: BellReportWorkerFatalError) =>
      Effect.sync(() => {
        publication = { _tag: 'Closed' };
      }).pipe(
        Effect.andThen(Queue.shutdown(wake)),
        Effect.andThen(Deferred.fail(criticalFailure, failure)),
        Effect.asVoid,
      );

    const supervisedWorker = worker.pipe(
      Effect.catchTag('BellReportWorkerFatalError', failClosed),
      Effect.catchDefect((cause) =>
        failClosed(
          new BellReportWorkerFatalError({
            reason: 'worker_defect',
            cause,
          }),
        ),
      ),
    );

    const workerFiber = yield* Effect.forkChild(supervisedWorker);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        publication = { _tag: 'Closed' };
      }).pipe(Effect.andThen(Queue.shutdown(wake)), Effect.andThen(Fiber.interrupt(workerFiber))),
    );

    return {
      reportBell,
      awaitCriticalFailure: () => Deferred.await(criticalFailure),
    };
  });
}

function validateDuration(name: string, value: number, allowZero: boolean): void {
  const valid = Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
  if (!valid) {
    throw new RangeError(
      `${name} must be a finite ${allowZero ? 'non-negative' : 'positive'} number`,
    );
  }
}

function elapsedNanos(startedAt: bigint, now: bigint): bigint {
  return now > startedAt ? now - startedAt : 0n;
}
