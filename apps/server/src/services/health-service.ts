import { Clock, Context, Effect, Layer, Metric, SubscriptionRef } from 'effect';

import { serverReadyGauge } from '../observability/metrics';

export const SERVER_HEALTH_COMPONENTS = [
  'database',
  'redis_commands',
  'redis_publisher',
  'redis_subscriber',
  'daemon_control_broker',
  'daemon_control_liveness',
  'presence_expiry',
] as const;

export type ServerHealthComponent = (typeof SERVER_HEALTH_COMPONENTS)[number];
export type ServerHealthComponentStatus = 'starting' | 'healthy' | 'unhealthy';

export interface ServerHealthComponentState {
  readonly status: ServerHealthComponentStatus;
  readonly updatedAt: number;
  readonly detail?: string;
}

type ServerHealthComponents = Readonly<Record<ServerHealthComponent, ServerHealthComponentState>>;

export interface ServerHealthSnapshot {
  readonly status: 'ready' | 'not_ready';
  readonly ready: boolean;
  readonly checkedAt: number;
  readonly components: ServerHealthComponents;
}

export interface ServerHealthComponentUpdate {
  readonly component: ServerHealthComponent;
  readonly status: ServerHealthComponentStatus;
  readonly detail?: string;
}

export interface HealthService {
  readonly markHealthy: (component: ServerHealthComponent) => Effect.Effect<void>;
  readonly markUnhealthy: (component: ServerHealthComponent, detail: string) => Effect.Effect<void>;
  readonly updateComponents: (
    updates: readonly ServerHealthComponentUpdate[],
  ) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<ServerHealthSnapshot>;
}

export class HealthServiceTag extends Context.Service<HealthServiceTag, HealthService>()(
  'HealthService',
) {}

export const HealthServiceLive = Layer.effect(
  HealthServiceTag,
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<ServerHealthComponents>(initialComponents());

    const updateComponents = (
      updates: readonly ServerHealthComponentUpdate[],
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const updatedAt = yield* Clock.currentTimeMillis;
        const components = yield* SubscriptionRef.updateAndGet(state, (current) => {
          const next = { ...current };
          for (const update of updates) {
            next[update.component] = {
              status: update.status,
              updatedAt,
              ...(update.detail === undefined ? {} : { detail: update.detail }),
            };
          }
          return next;
        });
        yield* Metric.update(serverReadyGauge, componentsReady(components) ? 1 : 0);
      });

    return {
      markHealthy: (component) => updateComponents([{ component, status: 'healthy' }]),
      markUnhealthy: (component, detail) =>
        updateComponents([{ component, status: 'unhealthy', detail }]),
      updateComponents,
      snapshot: Effect.gen(function* () {
        const components = yield* SubscriptionRef.get(state);
        const checkedAt = yield* Clock.currentTimeMillis;
        const ready = componentsReady(components);
        return {
          status: ready ? 'ready' : 'not_ready',
          ready,
          checkedAt,
          components,
        };
      }),
    };
  }),
);

function initialComponents(): ServerHealthComponents {
  const starting: ServerHealthComponentState = {
    status: 'starting',
    updatedAt: 0,
  };
  return {
    database: starting,
    redis_commands: starting,
    redis_publisher: starting,
    redis_subscriber: starting,
    daemon_control_broker: starting,
    daemon_control_liveness: starting,
    presence_expiry: starting,
  };
}

function componentsReady(components: ServerHealthComponents): boolean {
  return SERVER_HEALTH_COMPONENTS.every((component) => components[component].status === 'healthy');
}
