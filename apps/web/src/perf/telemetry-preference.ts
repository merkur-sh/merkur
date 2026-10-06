import { installTerminalPerfRecorder, uninstallTerminalPerfRecorder } from './terminal-latency';

/**
 * The single opt-in gate for every browser telemetry surface.
 *
 * Off by default, and off for anyone who never turns it on. Two distinct costs
 * hang off this one boolean:
 *
 * - **The 60s link report.** One accumulator fold inside the transport
 *   worker's existing heartbeat callback, one interval, one `visibilitychange`
 *   listener, and one `POST /api/telemetry/link` per window. Disabled means the
 *   reporter is never constructed, so none of those exist.
 * - **Deep terminal profiling.** Installing the perf recorder is what both
 *   workers read through `isTerminalPerfRecording()` when they latch their own
 *   `perfEnabled`. Every instrumented write in `terminal-worker.ts` already
 *   sits inside that branch, so a disabled session pays one boolean test per
 *   mailbox dispatch and no clock read.
 *
 * The two respond on different timescales, which the preferences copy states:
 * the link report starts and stops immediately, while `perfEnabled` is latched
 * by each worker at init and therefore follows from the next terminal session.
 */
const STORAGE_KEY = 'merkur:telemetry-enabled';

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

export function loadTelemetryEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Persist the choice and bring the perf recorder into line with it.
 *
 * The recorder is installed here rather than at the next session start so that
 * a page which is already open — the one the user just changed the setting in —
 * profiles its next session without a reload.
 */
export function saveTelemetryEnabled(enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(STORAGE_KEY, 'true');
    installTerminalPerfRecorder();
    return;
  }

  localStorage.removeItem(STORAGE_KEY);
  uninstallTerminalPerfRecorder();
}

/**
 * Apply the stored choice at boot, before any terminal worker is constructed.
 *
 * Returns the loaded value so the caller can seed its signal from the same read.
 */
export function initializeTelemetryPreference(): boolean {
  const enabled = loadTelemetryEnabled();
  if (enabled) installTerminalPerfRecorder();
  return enabled;
}
