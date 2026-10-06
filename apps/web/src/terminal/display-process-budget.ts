import { FASTEST_SUPPORTED_REFRESH_PERIOD_MS } from './refresh-rate-estimator';

const RENDER_HEADROOM_FRACTION = 0.3;

/**
 * CPU time one display-queue task may consume before yielding.
 *
 * `presentationPeriodMs` is deliberately the coordinator's conservative
 * cadence estimate: cold/reset state reports 480 Hz until real continuous-rAF
 * evidence proves a slower panel. One display frame remains indivisible, but a
 * burst checks this bound after every frame and yields before it can consume a
 * complete active refresh period.
 */
export function displayProcessSliceBudgetMs(
  configuredBudgetMs: number,
  presentationPeriodMs: number,
): number {
  const configured =
    Number.isFinite(configuredBudgetMs) && configuredBudgetMs > 0 ? configuredBudgetMs : 0;
  const period =
    Number.isFinite(presentationPeriodMs) && presentationPeriodMs > 0
      ? presentationPeriodMs
      : FASTEST_SUPPORTED_REFRESH_PERIOD_MS;
  const renderHeadroom = period * RENDER_HEADROOM_FRACTION;
  return Math.min(configured, Math.max(0, period - renderHeadroom));
}
