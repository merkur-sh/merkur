import { expect, test } from 'bun:test';
import { BROWSER_EVENT_ACCOUNT_TELEMETRY } from '@merkur/shared';
import { Effect, Stream } from 'effect';
import { DeviceStreamEvent, deviceEventStream } from './device-events-source';

test('account telemetry accepts exactly true, false and null', async () => {
  const received: DeviceStreamEvent[] = [];
  const payloads = [
    'true',
    'false',
    'null',
    '',
    'undefined',
    'NULL',
    'TRUE',
    '0',
    '1',
    '"true"',
    '"false"',
    '"null"',
    '{}',
    '[]',
    '{"enabled":true}',
    'garbage',
    'null garbage',
    'true false',
    ' true',
    'false\n',
  ];
  await Effect.runPromise(
    deviceEventStream('token', null, async (_token, _path, options) => {
      for (const data of payloads) {
        options.onEvent({ event: BROWSER_EVENT_ACCOUNT_TELEMETRY, data });
      }
      options.onEvent({ event: 'unknown', data: 'true' });
    }).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          received.push(event);
        }),
      ),
    ),
  );
  expect(received).toEqual([
    DeviceStreamEvent['account-telemetry']({ enabled: true }),
    DeviceStreamEvent['account-telemetry']({ enabled: false }),
    DeviceStreamEvent['account-telemetry']({ enabled: null }),
  ]);
});
