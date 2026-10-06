import { createOwnedAnimationFrame, createOwnedTimeout } from '../lib/owned-scheduled-callback';
import type { RefreshRateEstimator } from './refresh-rate-estimator';

/**
 * Duty-cycled calibration driver for the refresh-rate estimator: short rAF
 * bursts feed vsync timestamps independently of render demand, so the
 * estimate converges within ~0.5s of init even on a session with no
 * terminal output, and re-converges after visibility/DPR/resize changes.
 *
 * Power profile: zero rAF callbacks outside bursts (the chain is dead, not
 * paused), zero timers while hidden, and a 12-frame revalidation burst once
 * a minute while visible (~0.3% duty at 60Hz) to catch same-size monitor
 * moves the permissionless signals can't see.
 */

const EVENT_BURST_FRAMES = 36;
const REVALIDATE_BURST_FRAMES = 12;
const CONVERGED_CONFIDENCE = 0.9;
const REVALIDATE_INTERVAL_MS = 60_000;
const BURST_DEDUPE_MS = 2_000;
// A burst started just before the page went hidden stalls silently (worker
// rAF stops firing); the watchdog reclaims it.
const BURST_WATCHDOG_MS = 3_000;

export type CalibrationBurstReason = 'init' | 'visible' | 'dpr' | 'resize' | 'revalidate';

export interface CalibratorIo {
  requestFrame(callback: (frameTimeMs: number) => void): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
  now(): number;
}

export interface RefreshRateCalibrator {
  /** Init burst + arms revalidation. Idempotent. */
  start(): void;
  requestBurst(reason: CalibrationBurstReason): void;
  setVisible(visible: boolean): void;
  stop(): void;
}

export function createRefreshRateCalibrator(
  estimator: RefreshRateEstimator,
  io: CalibratorIo,
  afterSample?: () => void,
): RefreshRateCalibrator {
  let started = false;
  let visible = true;
  let framesRemaining = 0;
  const frameHandle = createOwnedAnimationFrame(io.requestFrame, io.cancelFrame);
  const watchdogTimer = createOwnedTimeout(io.setTimer, io.clearTimer);
  const revalidateTimer = createOwnedTimeout(io.setTimer, io.clearTimer);
  let lastBurstStartedAtMs = Number.NEGATIVE_INFINITY;

  function clearWatchdog(): void {
    watchdogTimer.cancel();
  }

  function endBurst(): void {
    frameHandle.cancel();
    framesRemaining = 0;
    clearWatchdog();
  }

  function onFrame(frameTimeMs: number): void {
    // The burst is the estimator's only unbroken rAF chain, so this is the one
    // caller allowed to seed, re-seed, and demote it.
    estimator.sample(frameTimeMs, true);
    afterSample?.();
    framesRemaining -= 1;
    if (framesRemaining <= 0 || estimator.confidence01() >= CONVERGED_CONFIDENCE) {
      endBurst();
      return;
    }
    frameHandle.arm(onFrame);
  }

  function beginBurst(frames: number): void {
    // Single-chain guarantee: a concurrent request only raises the target.
    framesRemaining = Math.max(framesRemaining, frames);
    if (frameHandle.isArmed()) return;
    lastBurstStartedAtMs = io.now();
    frameHandle.arm(onFrame);
    clearWatchdog();
    watchdogTimer.arm(() => {
      endBurst();
    }, BURST_WATCHDOG_MS);
  }

  function armRevalidation(): void {
    if (revalidateTimer.isArmed()) return;
    revalidateTimer.arm(() => {
      beginBurst(REVALIDATE_BURST_FRAMES);
      armRevalidation();
    }, REVALIDATE_INTERVAL_MS);
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      if (!visible) return;
      beginBurst(EVENT_BURST_FRAMES);
      armRevalidation();
    },

    requestBurst(reason: CalibrationBurstReason): void {
      if (!started || !visible) return;
      const frames = reason === 'revalidate' ? REVALIDATE_BURST_FRAMES : EVENT_BURST_FRAMES;
      if (!frameHandle.isArmed() && io.now() - lastBurstStartedAtMs < BURST_DEDUPE_MS) return;
      beginBurst(frames);
    },

    setVisible(nextVisible: boolean): void {
      if (visible === nextVisible) return;
      visible = nextVisible;
      if (!visible) {
        endBurst();
        revalidateTimer.cancel();
        return;
      }
      if (!started) return;
      beginBurst(EVENT_BURST_FRAMES);
      armRevalidation();
    },

    stop(): void {
      started = false;
      endBurst();
      revalidateTimer.cancel();
    },
  };
}
