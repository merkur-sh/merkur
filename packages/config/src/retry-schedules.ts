import { Duration, Effect, Random, Schedule } from 'effect';
export const SIGNALING_RECONNECT_BASE = '500 millis';
export const SIGNALING_RECONNECT_CEIL = '5 seconds';
export const SIGNALING_REGISTER_TIMEOUT_MS = 5_000;
export const SIGNALING_RECONNECT_BASE_MS = 500;
export const SIGNALING_RECONNECT_CEIL_MS = 5_000;

export const DEVICE_EVENTS_RECONNECT_BASE_MS = 250;
export const DEVICE_EVENTS_RECONNECT_CEIL_MS = 5_000;

/** Full jitter in [0, ceiling], with hostile/non-finite samples made harmless. */
export function fullJitterDelayMs(ceilingMs: number, sample: number): number {
  const boundedCeiling = Number.isFinite(ceilingMs) ? Math.max(0, ceilingMs) : 0;
  const boundedSample = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
  return Math.floor(boundedCeiling * boundedSample);
}

/** Retry delay is bounded; failure history lasts until authenticated readiness. */
export function createSignalingReconnectSchedule(
  baseMs = SIGNALING_RECONNECT_BASE_MS,
  ceilingMs = SIGNALING_RECONNECT_CEIL_MS,
) {
  const safeBaseMs = Number.isFinite(baseMs) ? Math.max(1, Math.trunc(baseMs)) : 1;
  const safeCeilingMs = Number.isFinite(ceilingMs)
    ? Math.max(safeBaseMs, Math.trunc(ceilingMs))
    : safeBaseMs;
  return Schedule.exponential(`${safeBaseMs} millis`).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Random.next.pipe(
        Effect.map((sample) =>
          Duration.millis(
            fullJitterDelayMs(Math.min(Duration.toMillis(duration), safeCeilingMs), sample),
          ),
        ),
      ),
    ),
  );
}

export const SignalingReconnectSchedule = createSignalingReconnectSchedule();
