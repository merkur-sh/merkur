import { OpaqueWebBuildPin } from '@merkur/config';
import { MerkurLoggerLayer } from '@merkur/logger';
import { ConfigProvider, type Effect, Layer, ManagedRuntime } from 'effect';

import { ServerConfigLive, type ServerConfigService } from './config';
import { DatabaseLive, type DatabaseService } from './db/client';
import { TelemetryLive } from './observability/telemetry';
import { AuthServiceLive, type AuthServiceTag } from './services/auth-service';
import { BoxAccessServiceLive, type BoxAccessServiceTag } from './services/box-access-service';
import { BoxHostServiceLive, type BoxHostServiceTag } from './services/box-host-service';
import {
  BoxWaitlistServiceLive,
  type BoxWaitlistServiceTag,
} from './services/box-waitlist-service';
import {
  BrowserPresenceServiceLive,
  type BrowserPresenceServiceTag,
} from './services/browser-session-presence';
import {
  DaemonControlServiceLive,
  type DaemonControlServiceTag,
} from './services/daemon-control-service';
import {
  DaemonLinkClaimServiceLive,
  type DaemonLinkClaimServiceTag,
} from './services/daemon-link-claim-service';
import {
  DeviceEventsServiceLive,
  type DeviceEventsServiceTag,
} from './services/device-events-service';
import { DeviceServiceLive, type DeviceServiceTag } from './services/device-service';
import {
  EdgeRegistryServiceLive,
  type EdgeRegistryServiceTag,
} from './services/edge-registry-service';
import { HealthServiceLive, type HealthServiceTag } from './services/health-service';
import {
  KeyboardSettingsServiceLive,
  type KeyboardSettingsServiceTag,
} from './services/keyboard-settings-service';
import {
  NotificationOutboxServiceLive,
  type NotificationOutboxServiceTag,
} from './services/notification-outbox-service';
import {
  PushNotificationServiceLive,
  type PushNotificationServiceTag,
} from './services/push-notification-service';
import { RateLimitServiceLive, type RateLimitServiceTag } from './services/rate-limit-service';
import {
  RealtimeCoordinationServiceLive,
  type RealtimeCoordinationServiceTag,
} from './services/realtime-coordination-service';
import { RedisServiceLive, type RedisServiceTag } from './services/redis-service';
import { RybbitEventsLive, type RybbitEventsTag } from './services/rybbit-events';
import {
  SessionIssuanceServiceLive,
  type SessionIssuanceServiceTag,
} from './services/session-issuance-service';
import { SessionServiceLive, type SessionServiceTag } from './services/session-service';

const NotificationOutboxResolvedLive = NotificationOutboxServiceLive.pipe(
  Layer.provideMerge(RedisServiceLive),
);

const AuthServiceResolvedLive = AuthServiceLive.pipe(
  Layer.provideMerge(NotificationOutboxResolvedLive),
  Layer.provideMerge(RedisServiceLive),
);

const CoreServicesLive = Layer.mergeAll(
  AuthServiceResolvedLive,
  BrowserPresenceServiceLive.pipe(Layer.provideMerge(RedisServiceLive)),
  BoxHostServiceLive,
  DaemonLinkClaimServiceLive,
  DeviceServiceLive.pipe(Layer.provideMerge(NotificationOutboxResolvedLive)),
);

const RealtimeCoordinationResolvedLive = RealtimeCoordinationServiceLive.pipe(
  Layer.provideMerge(RedisServiceLive),
);

const EdgeRegistryResolvedLive = EdgeRegistryServiceLive.pipe(Layer.provideMerge(RedisServiceLive));

const RateLimitServiceResolvedLive = RateLimitServiceLive.pipe(
  Layer.provideMerge(RedisServiceLive),
);

const SessionIssuanceResolvedLive = SessionIssuanceServiceLive.pipe(
  Layer.provideMerge(RedisServiceLive),
);

const DeviceEventsServiceResolvedLive = DeviceEventsServiceLive.pipe(
  Layer.provideMerge(RealtimeCoordinationResolvedLive),
);

const DaemonControlServiceResolvedLive = DaemonControlServiceLive.pipe(
  Layer.provideMerge(RealtimeCoordinationResolvedLive),
  Layer.provideMerge(EdgeRegistryResolvedLive),
  Layer.provideMerge(CoreServicesLive),
);

const PushNotificationServiceResolvedLive = PushNotificationServiceLive.pipe(
  Layer.provideMerge(CoreServicesLive),
);

const ApplicationServicesLive = Layer.mergeAll(
  HealthServiceLive,
  KeyboardSettingsServiceLive,
  BoxAccessServiceLive,
  BoxWaitlistServiceLive,
  RybbitEventsLive,
  CoreServicesLive,
  RealtimeCoordinationResolvedLive,
  EdgeRegistryResolvedLive,
  DeviceEventsServiceResolvedLive,
  PushNotificationServiceResolvedLive,
  DaemonControlServiceResolvedLive,
  RateLimitServiceResolvedLive,
  SessionIssuanceResolvedLive,
);

const ServerLive = SessionServiceLive.pipe(
  Layer.provideMerge(ApplicationServicesLive),
  Layer.provideMerge(DatabaseLive),
  // Between the services and the config/logger it depends on. Layers finalize
  // in reverse, so the OTLP exporters flush after every service that can still
  // emit a span, and the stdout logger is already installed when the OTLP
  // logger merges itself on top of it.
  Layer.provideMerge(TelemetryLive),
  Layer.provideMerge(
    ServerConfigLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OpaqueWebBuildPin, process.env.MERKUR_OPAQUE_WEB_BUILD_PUBLIC_KEY),
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({ ...process.env }, { preserveEmptyStrings: true }),
          ),
        ),
      ),
    ),
  ),
  Layer.provideMerge(MerkurLoggerLayer),
);

export type ServerRuntimeContext =
  | ServerConfigService
  | DatabaseService
  | AuthServiceTag
  | BoxAccessServiceTag
  | BoxWaitlistServiceTag
  | BrowserPresenceServiceTag
  | BoxHostServiceTag
  | DaemonControlServiceTag
  | DaemonLinkClaimServiceTag
  | DeviceEventsServiceTag
  | DeviceServiceTag
  | EdgeRegistryServiceTag
  | HealthServiceTag
  | KeyboardSettingsServiceTag
  | NotificationOutboxServiceTag
  | PushNotificationServiceTag
  | RateLimitServiceTag
  | RealtimeCoordinationServiceTag
  | RedisServiceTag
  | RybbitEventsTag
  | SessionIssuanceServiceTag
  | SessionServiceTag;

export const serverRuntime = ManagedRuntime.make(ServerLive);

export function runServerProgram<A, E, R extends ServerRuntimeContext>(
  program: Effect.Effect<A, E, R>,
  options?: Effect.RunOptions,
): Promise<A> {
  return serverRuntime.runPromise(program, options);
}
