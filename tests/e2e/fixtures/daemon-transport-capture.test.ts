import { describe, expect, test } from 'bun:test';

import { findFinalDaemonTransportCapture } from './daemon-transport-capture';

function captureLine(options: {
  readonly requestedAtMs: number;
  readonly observedAtMs: number;
  readonly completedAtMs: number;
}): string {
  return JSON.stringify({
    message: 'daemon_transport_capture_complete',
    context: {
      captureRequestedAtMs: options.requestedAtMs,
      captureCompletedAtMs: options.completedAtMs,
      metrics: { latestDataplaneTransport: { observedAtMs: options.observedAtMs } },
    },
  });
}

describe('final daemon transport capture', () => {
  test('selects only a fresh ordered owner-loop capture after the fixture request', () => {
    const stale = captureLine({ requestedAtMs: 80, observedAtMs: 81, completedAtMs: 82 });
    const fresh = captureLine({ requestedAtMs: 101, observedAtMs: 102, completedAtMs: 103 });

    expect(findFinalDaemonTransportCapture(`noise\n${stale}\n${fresh}\n`, 100)).toEqual({
      captureRequestedAtMs: 101,
      captureCompletedAtMs: 103,
      observedAtMs: 102,
    });
  });

  test('rejects malformed JSON and captures whose sample predates the request', () => {
    const misordered = captureLine({ requestedAtMs: 101, observedAtMs: 100, completedAtMs: 103 });
    expect(
      findFinalDaemonTransportCapture(
        `{"message":"daemon_transport_capture_complete"\n${misordered}\n`,
        100,
      ),
    ).toBeNull();
  });
});
