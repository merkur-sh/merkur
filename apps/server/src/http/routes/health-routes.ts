import { merkurVersion } from '@merkur/shared';
import { Effect } from 'effect';
import { Elysia, status, t } from 'elysia';
import { merkurMetricsSnapshot } from '../../observability/metrics';
import type { ServerRuntimeContext } from '../../runtime';
import { HealthServiceTag } from '../../services/health-service';

/**
 * Health routes are polled continuously by the platform, so a span per poll is
 * pure volume: 9,156 `server.health.refresh` spans were once recorded in a
 * single 12.7-hour window. `Debug` puts them below the default `TRACE_LEVEL`
 * threshold, so they cost nothing until someone lowers it to look.
 *
 * They also root their own trace rather than parenting off an inbound header:
 * a platform prober does not send one, and nothing else should be able to
 * attach a liveness poll to an unrelated trace.
 */
const HEALTH_SPAN_OPTIONS = { kind: 'server', level: 'Debug', root: true } as const;

const STATUS_OK = 200;
const STATUS_SERVICE_UNAVAILABLE = 503;

type RunServerProgram = <A, E, R extends ServerRuntimeContext>(
  program: Effect.Effect<A, E, R>,
  options?: { readonly signal?: AbortSignal },
) => Promise<A>;

interface HealthRoutesOptions {
  readonly runServerProgram: RunServerProgram;
}

export function healthRoutesPlugin({ runServerProgram }: HealthRoutesOptions) {
  return new Elysia({ name: 'health-routes' })
    .get(
      '/health/live',
      {
        response: {
          200: t.Object({ status: t.Literal('live'), version: t.String() }),
        },
      },
      () =>
        status(STATUS_OK, {
          status: 'live' as const,
          version: merkurVersion(),
        }),
    )
    .get('/health/ready', async ({ request }) => {
      const snapshot = await runServerProgram(
        Effect.gen(function* () {
          const health = yield* HealthServiceTag;
          return yield* health.snapshot;
        }).pipe(Effect.withSpan('health.ready', HEALTH_SPAN_OPTIONS)),
        { signal: request.signal },
      );
      return snapshot.ready
        ? status(STATUS_OK, snapshot)
        : status(STATUS_SERVICE_UNAVAILABLE, snapshot);
    })
    .get('/health/metrics', async ({ request }) => {
      const metrics = await runServerProgram(
        merkurMetricsSnapshot.pipe(Effect.withSpan('health.metrics', HEALTH_SPAN_OPTIONS)),
        { signal: request.signal },
      );
      return status(STATUS_OK, metrics);
    });
}
