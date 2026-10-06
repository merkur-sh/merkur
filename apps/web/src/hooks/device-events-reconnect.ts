import {
  DEVICE_EVENTS_RECONNECT_BASE_MS,
  DEVICE_EVENTS_RECONNECT_CEIL_MS,
  fullJitterDelayMs,
} from '@merkur/config/retry-schedules';
import { Duration, Effect, Schedule } from 'effect';

export const RESUME_RECONNECT_DEDUPE_MS = 1_000;

export function shouldForceResumeReconnect(
  nowMs: number,
  lastReconnectAtMs: number | null,
): boolean {
  if (lastReconnectAtMs === null) return true;
  const elapsedMs = nowMs - lastReconnectAtMs;
  return elapsedMs >= RESUME_RECONNECT_DEDUPE_MS;
}

export function deviceEventsReconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  // Attempt 1 uses the configured base as its maximum. Incrementing the
  // exponent before applying it silently doubled the first fallback ceiling. Full
  // jitter prevents every browser disconnected by one outage from waking on
  // the same millisecond.
  const exponent = Math.max(0, Math.min(Math.trunc(attempt) - 1, 5));
  const ceilingMs = Math.min(
    DEVICE_EVENTS_RECONNECT_CEIL_MS,
    DEVICE_EVENTS_RECONNECT_BASE_MS * 2 ** exponent,
  );
  return fullJitterDelayMs(ceilingMs, random());
}

/**
 * The whole reconnect policy as one schedule.
 *
 * The first recurrence has no delay: a stream that ended or failed is itself a
 * concrete recovery event, so the current credential is worth one immediate
 * retry. Only from the second recurrence does the bounded full-jitter fallback
 * apply, and that is the schedule of a persistently unavailable peer.
 *
 * The consumer drives this with `Schedule.toStepWithSleep` and races the sleep
 * against its recovery latch, so an online, visibility, or bfcache edge
 * preempts a pending deadline instead of waiting it out. Re-deriving the step
 * function is how the schedule is reset, which is why the delay for a given
 * recurrence must depend only on `attempt`.
 */
export function createDeviceEventsReconnectSchedule(
  random: () => number = Math.random,
): Schedule.Schedule<number> {
  return Schedule.forever.pipe(
    Schedule.modifyDelay(({ attempt }) =>
      Effect.succeed(
        Duration.millis(attempt <= 1 ? 0 : deviceEventsReconnectDelayMs(attempt - 1, random)),
      ),
    ),
  );
}
