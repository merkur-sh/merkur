import { afterEach, expect, test } from 'bun:test';
import { applyTelemetryPerfRecorder } from './telemetry-preference';
import { isTerminalPerfRecording, uninstallTerminalPerfRecorder } from './terminal-latency';

afterEach(uninstallTerminalPerfRecorder);

test('the perf recorder follows account consent', () => {
  applyTelemetryPerfRecorder(false);
  expect(isTerminalPerfRecording()).toBe(false);
  applyTelemetryPerfRecorder(true);
  expect(isTerminalPerfRecording()).toBe(true);
  applyTelemetryPerfRecorder(true);
  expect(isTerminalPerfRecording()).toBe(true);
  applyTelemetryPerfRecorder(false);
  expect(isTerminalPerfRecording()).toBe(false);
});
