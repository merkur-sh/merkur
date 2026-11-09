import { describe, expect, test } from 'bun:test';
import type { DeviceDeltaFrame } from '@merkur/shared';
import { Effect, Layer } from 'effect';

import {
  type DeviceEventListener,
  type DeviceEventsService,
  DeviceEventsServiceLive,
  DeviceEventsServiceTag,
} from './device-events-service';
import {
  type RealtimeCoordinationService,
  RealtimeCoordinationServiceTag,
} from './realtime-coordination-service';

const FRAME: DeviceDeltaFrame = { seq: 1, kind: 'remove', deviceId: 'daemon-1' };

function createFakeCoordination(): {
  coordination: RealtimeCoordinationService;
  deliver(userId: string, frame: DeviceDeltaFrame): void;
} {
  const listenersByUserId = new Map<string, Set<DeviceEventListener>>();

  const coordination = {
    subscribeDeviceEvents: (userId: string, listener: DeviceEventListener) =>
      Effect.sync(() => {
        const set = listenersByUserId.get(userId) ?? new Set();
        set.add(listener);
        listenersByUserId.set(userId, set);
        return Effect.sync(() => {
          set.delete(listener);
        });
      }),
  } as unknown as RealtimeCoordinationService;

  return {
    coordination,
    deliver(userId, frame): void {
      for (const listener of listenersByUserId.get(userId) ?? []) {
        listener({ _tag: 'delta', frame });
      }
    },
  };
}

function runWithEvents<A>(
  coordination: RealtimeCoordinationService,
  fn: (events: DeviceEventsService) => Effect.Effect<A, never>,
): Promise<A> {
  const coordinationLayer = Layer.succeed(RealtimeCoordinationServiceTag, coordination);
  const eventsLayer = DeviceEventsServiceLive.pipe(Layer.provide(coordinationLayer));
  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* DeviceEventsServiceTag;
      return yield* fn(events);
    }).pipe(Effect.provide(eventsLayer)),
  );
}

describe('DeviceEventsService', () => {
  test('listener failures do not break fanout', async () => {
    const fake = createFakeCoordination();
    let calledAfterThrow = false;

    await runWithEvents(fake.coordination, (events) =>
      Effect.gen(function* () {
        yield* events.subscribe('user-1', () => {
          throw new Error('listener crashed');
        }) as unknown as Effect.Effect<unknown, never>;
        yield* events.subscribe('user-1', () => {
          calledAfterThrow = true;
        }) as unknown as Effect.Effect<unknown, never>;

        fake.deliver('user-1', FRAME);
      }),
    );

    expect(calledAfterThrow).toBe(true);
  });
});
