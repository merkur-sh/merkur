import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';

import { HealthServiceLive, HealthServiceTag, SERVER_HEALTH_COMPONENTS } from './health-service';

describe('HealthService', () => {
  test('stays unready until every required component is healthy', async () => {
    const snapshots = await Effect.runPromise(
      Effect.gen(function* () {
        const health = yield* HealthServiceTag;
        const initial = yield* health.snapshot;
        yield* TestClock.adjust('1 second');
        yield* Effect.all(
          SERVER_HEALTH_COMPONENTS.map((component) => health.markHealthy(component)),
          { discard: true },
        );
        const ready = yield* health.snapshot;
        yield* health.markUnhealthy('redis_subscriber', 'connection_lost');
        const degraded = yield* health.snapshot;
        return { initial, ready, degraded };
      }).pipe(Effect.provide(HealthServiceLive), Effect.provide(TestClock.layer())),
    );

    expect(snapshots.initial.ready).toBe(false);
    expect(snapshots.initial.status).toBe('not_ready');
    expect(snapshots.ready.ready).toBe(true);
    expect(snapshots.ready.status).toBe('ready');
    expect(snapshots.ready.checkedAt).toBe(1_000);
    expect(snapshots.degraded.ready).toBe(false);
    expect(snapshots.degraded.components.redis_subscriber).toMatchObject({
      status: 'unhealthy',
      detail: 'connection_lost',
    });
  });
});
