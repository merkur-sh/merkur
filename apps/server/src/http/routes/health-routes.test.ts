import { afterEach, describe, expect, test } from 'bun:test';
import { Effect, ManagedRuntime } from 'effect';
import { Elysia } from 'elysia';

import {
  HealthServiceLive,
  HealthServiceTag,
  SERVER_HEALTH_COMPONENTS,
} from '../../services/health-service';
import { healthRoutesPlugin } from './health-routes';

const runtime = ManagedRuntime.make(HealthServiceLive);
const app = new Elysia().use(
  healthRoutesPlugin({
    runServerProgram: (program, options) =>
      runtime.runPromise(
        program as Effect.Effect<unknown, unknown, HealthServiceTag>,
        options,
      ) as Promise<never>,
  }),
);

afterEach(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const health = yield* HealthServiceTag;
      yield* Effect.all(
        SERVER_HEALTH_COMPONENTS.map((component) => health.markUnhealthy(component, 'test_reset')),
        { discard: true },
      );
    }),
  );
});

describe('health routes', () => {
  test('liveness is independent of dependency readiness', async () => {
    const response = await app.handle(new Request('http://localhost/health/live'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'live',
      version: expect.any(String),
    });
  });

  test('readiness returns 503 while degraded and 200 after every component recovers', async () => {
    const degraded = await app.handle(new Request('http://localhost/health/ready'));
    expect(degraded.status).toBe(503);
    expect(await degraded.json()).toMatchObject({
      status: 'not_ready',
      ready: false,
    });

    await runtime.runPromise(
      Effect.gen(function* () {
        const health = yield* HealthServiceTag;
        yield* health.updateComponents(
          SERVER_HEALTH_COMPONENTS.map((component) => ({
            component,
            status: 'healthy' as const,
          })),
        );
      }),
    );

    const ready = await app.handle(new Request('http://localhost/health/ready'));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: 'ready',
      ready: true,
    });
  });
});
