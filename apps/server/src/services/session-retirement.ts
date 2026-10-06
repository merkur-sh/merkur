import { Effect, Result } from 'effect';
import { type Logger, logWithLoggerEffect } from '../logger';
import type { DaemonControlService } from './daemon-control-service';
import type { RealtimeCoordinationService } from './realtime-coordination-service';
import type { SessionIssuanceCancellation } from './session-issuance-contract';

export const retireCancelledSession = Effect.fnUntraced(function* (
  cancellation: Extract<SessionIssuanceCancellation, { _tag: 'Cancelled' }>,
  userId: string,
  coordination: RealtimeCoordinationService,
  daemonControl: DaemonControlService,
) {
  const claimRemoval = yield* Effect.result(
    coordination.removeSessionForUser({
      sessionId: cancellation.sessionId,
      userId,
    }),
  );
  // Try both retirements even if claim removal fails. The durable tuple makes
  // retries idempotent; explicit cancellation waits for daemon acknowledgement.
  yield* daemonControl.cancelSession({
    daemonId: cancellation.daemonId,
    userId,
    sessionId: cancellation.sessionId,
    browserNodeId: cancellation.browserNodeId,
  });
  if (Result.isFailure(claimRemoval)) return yield* Effect.fail(claimRemoval.failure);
});

/**
 * Retire a predecessor without holding the successor's issuance behind it.
 *
 * The explicit `/cancel` route still awaits the daemon acknowledgement — there
 * the retirement IS the request. On the supersede path it is not: measured at
 * p50 66 ms and p90 122 ms, with a five-second command timeout behind it, all
 * of it in front of a reconnect the user is waiting on. The daemon's own
 * `session_start` already installs the replacement dial owner and supersedes
 * the predecessor, so nothing about the new session depends on the cancellation
 * having landed first.
 *
 * Failures are logged rather than propagated for the same reason they are
 * survivable: the cancelled tuple is durable and replayable by issuance id, and
 * daemon retirement is idempotent.
 */
export function retireSupersededSession(
  cancellation: Extract<SessionIssuanceCancellation, { _tag: 'Cancelled' }>,
  userId: string,
  coordination: RealtimeCoordinationService,
  daemonControl: DaemonControlService,
  logger: Logger,
): Effect.Effect<void> {
  return Effect.forkChild(
    retireCancelledSession(cancellation, userId, coordination, daemonControl).pipe(
      Effect.catch((error) =>
        logWithLoggerEffect(logger, 'warn', 'superseded_session_retirement_failed', {
          sessionId: cancellation.sessionId,
          error: String(error),
        }),
      ),
    ),
    { startImmediately: true },
  ).pipe(Effect.asVoid);
}
