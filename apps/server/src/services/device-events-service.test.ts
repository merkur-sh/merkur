import { describe, expect, test } from 'bun:test';
import type { DeviceDeltaFrame, DeviceEventDelta, DeviceEventsCursor } from '@merkur/shared';
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
  published: Array<{ readonly userId: string; readonly delta: DeviceEventDelta }>;
  deliver(userId: string, frame: DeviceDeltaFrame): void;
} {
  const published: Array<{ readonly userId: string; readonly delta: DeviceEventDelta }> = [];
  const listenersByUserId = new Map<string, Set<DeviceEventListener>>();

  const coordination = {
    instanceId: 'test-instance',
    publishDeviceDelta: (userId: string, delta: DeviceEventDelta) =>
      Effect.sync(() => {
        published.push({ userId, delta });
      }),
    readDeviceEventsCursor: () => Effect.succeed({ epoch: 'feedfacefeedface', seq: 7 }),
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
    published,
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
  test('publishDelta and readCursor delegate to the coordination layer', async () => {
    const fake = createFakeCoordination();
    const cursor = await runWithEvents(fake.coordination, (events) =>
      Effect.gen(function* () {
        yield* events.publishDelta('user-1', {
          kind: 'remove',
          deviceId: 'daemon-1',
        }) as Effect.Effect<void, never>;
        return yield* events.readCursor('user-1') as Effect.Effect<DeviceEventsCursor, never>;
      }),
    );
    expect(fake.published).toEqual([
      { userId: 'user-1', delta: { kind: 'remove', deviceId: 'daemon-1' } },
    ]);
    expect(cursor).toEqual({ epoch: 'feedfacefeedface', seq: 7 });
  });

  test('subscribe routes sequenced frames to the listener', async () => {
    const fake = createFakeCoordination();
    const received: DeviceDeltaFrame[] = [];

    await runWithEvents(fake.coordination, (events) =>
      Effect.gen(function* () {
        yield* events.subscribe('user-1', (signal) => {
          if (signal._tag === 'delta') received.push(signal.frame);
        }) as unknown as Effect.Effect<unknown, never>;
        fake.deliver('user-1', FRAME);
        fake.deliver('user-1', { ...FRAME, seq: 2 });
      }),
    );

    expect(received.map((frame) => frame.seq)).toEqual([1, 2]);
  });

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
