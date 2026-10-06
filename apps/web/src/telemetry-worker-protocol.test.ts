import { describe, expect, test } from 'bun:test';
import {
  isTelemetryObservationTraceCapture,
  type TelemetryObservationTraceCapture,
} from './telemetry-worker-protocol';

const capture = {
  complete: true,
  preparationRequestId: 0,
  observationEpoch: 3,
  observationStartedAtMs: 100,
  capacity: 64,
  totalRecordedCount: 12,
  retainedEventCount: 10,
  retainedOverwriteCount: 1,
  producerRecordLossCount: 1,
  droppedEventCount: 2,
} satisfies TelemetryObservationTraceCapture;

describe('telemetry observation capture read back by the fixtures', () => {
  test('a capture whose accounting adds up is accepted', () => {
    expect(isTelemetryObservationTraceCapture(capture)).toBe(true);
  });

  test('every field is required', () => {
    for (const field of Object.keys(capture)) {
      const { [field]: _removed, ...rest } = capture as Record<string, unknown>;
      expect(isTelemetryObservationTraceCapture(rest), field).toBe(false);
    }
  });

  test('the accounting must add up', () => {
    for (const patch of [
      { droppedEventCount: 3 },
      { totalRecordedCount: 13 },
      { retainedEventCount: 65, totalRecordedCount: 67 },
      { observationEpoch: 0 },
      { capacity: 0 },
    ]) {
      expect(
        isTelemetryObservationTraceCapture({ ...capture, ...patch }),
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  test('anything that is not a record is refused', () => {
    for (const value of [null, undefined, 7, 'capture', [capture]]) {
      expect(isTelemetryObservationTraceCapture(value)).toBe(false);
    }
  });
});
