import { Effect, Result, Schedule } from 'effect';
import { sql } from 'kysely';

import { DatabaseService } from '../db/client';
import { DaemonControlServiceTag } from './daemon-control-service';
import {
  HealthServiceTag,
  type ServerHealthComponent,
  type ServerHealthComponentUpdate,
} from './health-service';
import { RealtimeCoordinationServiceTag } from './realtime-coordination-service';
import { RedisServiceTag } from './redis-service';

export const SERVER_HEALTH_POLL_INTERVAL = '5 seconds';
const DATABASE_HEALTH_DEADLINE = '2 seconds';

/**
 * Refreshes readiness from the live resources that own each component.
 *
 * Expected database failures degrade readiness and remain retryable. Snapshot
 * defects are deliberately not caught: the owner fiber joins the server
 * runtime, so an invariant violation cannot leave a falsely-ready process.
 */
export const refreshServerHealthEffect = Effect.gen(function* () {
  const database = yield* DatabaseService;
  const health = yield* HealthServiceTag;
  const redis = yield* RedisServiceTag;
  const control = yield* DaemonControlServiceTag;
  const coordination = yield* RealtimeCoordinationServiceTag;

  const [databaseResult, redisHealth, controlHealth, coordinationHealth] = yield* Effect.all(
    [
      Effect.tryPromise({
        try: () => sql<{ readonly healthy: number }>`SELECT 1 AS healthy`.execute(database),
        catch: (cause) => cause,
      }).pipe(Effect.timeout(DATABASE_HEALTH_DEADLINE), Effect.result),
      redis.healthSnapshot(),
      control.healthSnapshot(),
      coordination.healthSnapshot(),
    ],
    { concurrency: 'unbounded' },
  );

  const brokerHealthy =
    controlHealth.brokerWorkersHealthy && controlHealth.connectionWorkersHealthy;
  const brokerDetail = !controlHealth.brokerWorkersHealthy
    ? 'broker_worker_unhealthy'
    : 'connection_worker_unhealthy';
  yield* health.updateComponents([
    healthUpdate('database', Result.isSuccess(databaseResult), 'database_probe_failed'),
    healthUpdate('redis_commands', redisHealth.commandsReady, 'redis_commands_not_ready'),
    healthUpdate('redis_publisher', redisHealth.publisherReady, 'redis_publisher_not_ready'),
    healthUpdate('redis_subscriber', redisHealth.subscriberReady, 'redis_subscriber_not_ready'),
    healthUpdate('daemon_control_broker', brokerHealthy, brokerDetail),
    healthUpdate(
      'daemon_control_liveness',
      controlHealth.livenessTickerHealthy,
      'liveness_ticker_unhealthy',
    ),
    healthUpdate(
      'presence_expiry',
      coordinationHealth.presenceExpirySchedulerHealthy,
      'presence_expiry_scheduler_unhealthy',
    ),
  ]);
}).pipe(Effect.withSpan('server.health.refresh', { root: true }));

/**
 * Forever monitor. The caller must supervise its fiber; a normal return is an
 * invariant violation because the schedule is intentionally unbounded.
 *
 * Deliberately NOT wrapped in a span. A span around an effect that never
 * returns never ends, so it never exports, and — because the Effect tracer
 * publishes the current span into the global OpenTelemetry context — it stays
 * the ambient span for the life of the process. Every later span then parents
 * under it. Measured before this was removed: one trace id accumulated 66,005
 * records across 45 operations over 12.7 hours, with 9,156 `server.health.refresh`
 * spans hanging off a single parent at exactly the 5.00 s poll cadence.
 *
 * Each poll is its own unit of work, so `refreshServerHealthEffect` carries the
 * span and declares itself `root`. The `root` flag is what keeps that true if a
 * caller ever runs this inside another span.
 */
export const runServerHealthMonitorEffect = refreshServerHealthEffect.pipe(
  Effect.repeat(Schedule.spaced(SERVER_HEALTH_POLL_INTERVAL)),
  Effect.delay(SERVER_HEALTH_POLL_INTERVAL),
);

function healthUpdate(
  component: ServerHealthComponent,
  healthy: boolean,
  unhealthyDetail: string,
): ServerHealthComponentUpdate {
  return healthy
    ? { component, status: 'healthy' }
    : { component, status: 'unhealthy', detail: unhealthyDetail };
}
