import { installTerminalPerfRecorder, uninstallTerminalPerfRecorder } from './terminal-latency';

/**
 * Account consent gates every browser telemetry surface. Unknown and unchosen
 * consent leave reporting off. Workers latch the recorder's enabled state at
 * initialization, so deep profiling follows consent from the next session.
 */
export function applyTelemetryPerfRecorder(enabled: boolean): void {
  if (enabled) installTerminalPerfRecorder();
  else uninstallTerminalPerfRecorder();
}

/**
 * Hard ceiling on profiling bytes shipped per session.
 *
 * The Axiom free tier allows 500 GB of ingest a month. A busy profiled session
 * produces on the order of 15 GB a day, so leaving profiling on unattended is
 * the only realistic way to exhaust the allowance. This is the backstop that
 * makes that impossible by accident: on reaching it the telemetry worker stops
 * shipping and reports that it has, which is visible in preferences.
 *
 * A stop, never a downshift to a thinner tier — a gap that looks like healthy
 * data is worse than a visible stop.
 */
export const TELEMETRY_SESSION_BYTE_BUDGET = 2 * 1024 * 1024 * 1024;
