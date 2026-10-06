import type { DeviceEventDelta, DeviceEventsCursor } from '@merkur/shared';
import { Context, Effect, Layer } from 'effect';
import {
  type DeviceEventListener,
  type DeviceEventSignal,
  RealtimeCoordinationServiceTag,
} from './realtime-coordination-service';
import type { RedisError } from './redis-service';

export type { DeviceEventListener, DeviceEventSignal };

export interface DeviceEventsService {
  /** Publishes one absolute delta under the next per-user sequence number. */
  publishDelta(userId: string, delta: DeviceEventDelta): Effect.Effect<void, RedisError>;
  /**
   * The cursor a stream opens against: the epoch of this account's counter and
   * how far it has got, `0` before any delta was published.
   */
  readCursor(userId: string): Effect.Effect<DeviceEventsCursor, RedisError>;
  subscribe(
    userId: string,
    listener: DeviceEventListener,
  ): Effect.Effect<Effect.Effect<void>, RedisError>;
}

export class DeviceEventsServiceTag extends Context.Service<
  DeviceEventsServiceTag,
  DeviceEventsService
>()('DeviceEventsService') {}

export const DeviceEventsServiceLive = Layer.effect(
  DeviceEventsServiceTag,
  Effect.gen(function* () {
    const coordination = yield* RealtimeCoordinationServiceTag;
    return createDeviceEventsService(coordination);
  }),
);

function createDeviceEventsService(coordination: {
  publishDeviceDelta(userId: string, delta: DeviceEventDelta): Effect.Effect<void, RedisError>;
  readDeviceEventsCursor(userId: string): Effect.Effect<DeviceEventsCursor, RedisError>;
  subscribeDeviceEvents(
    userId: string,
    listener: DeviceEventListener,
  ): Effect.Effect<Effect.Effect<void>, RedisError>;
}): DeviceEventsService {
  return {
    publishDelta(userId, delta) {
      return coordination.publishDeviceDelta(userId, delta);
    },

    readCursor(userId) {
      return coordination.readDeviceEventsCursor(userId);
    },

    subscribe(userId, listener) {
      return coordination.subscribeDeviceEvents(userId, (signal) => {
        try {
          listener(signal);
        } catch {
          // Device event listeners are SSE writers; a failed listener must not break fanout.
        }
      });
    },
  };
}
