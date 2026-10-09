/**
 * Display refresh estimator: a period+phase model over rAF callback
 * timestamps. Every vsync-aligned delta is modeled as `d = k·T + e` for an
 * unknown period T, integer k ≥ 1 (skipped frames), and bounded timestamp
 * noise e. Folding (`k = round(d/T)`) recovers T through jank without a
 * candidate-rate list, so non-standard rates (100Hz, overclocks, slow
 * panels) lock exactly; a phase-locked anchor additionally predicts the
 * next vsync edge.
 *
 * Sampling has two provenances and they are not interchangeable. The
 * calibrator drives an unbroken rAF chain, so a delta between its callbacks is
 * a property of the display and every state transition below is valid on it.
 * The render loop asks for a frame only when it has something to paint, so its
 * deltas are a property of *demand*: a run of k≥2 there means the terminal was
 * quiet, not that the panel slowed down. Those samples refine and phase-correct
 * an existing lock and never seed, re-seed, or demote.
 *
 * Lifecycle: SEEDING collects raw deltas until ≥75% fold onto the smallest
 * credible candidate, then LOCKED refines T with a k-weighted EWMA and,
 * once enough vsync intervals accumulate, a long-baseline span estimate
 * whose error is endpoint-noise only. Sustained residual outliers re-seed
 * (rate increased — old period reads k=0); a window of all-k≥2 samples
 * demotes to the subharmonic (rate decreased — old period folds perfectly
 * as doubles). Gaps beyond K_MAX periods re-anchor without counting toward
 * re-seed, so hidden-tab throttling freezes the estimate rather than
 * destroying it.
 *
 * VRR: when accepted per-frame periods spread beyond hysteresis bounds the
 * estimator publishes a stable lower-bound period (P10) and stops claiming
 * phase. `periodMs()` falls back to 60Hz until confidence is established —
 * unconverged behavior is byte-for-byte the pre-estimator default.
 */

/** Fastest panel cadence every frame-budget consumer must handle while cold. */
export const FASTEST_SUPPORTED_REFRESH_PERIOD_MS = 1000 / 480;
const CLAMP_MIN_PERIOD_MS = FASTEST_SUPPORTED_REFRESH_PERIOD_MS;
const CLAMP_MAX_PERIOD_MS = 1000 / 30;
const DEFAULT_PERIOD_MS = 1000 / 60;
const SEED_WINDOW = 8;
const SEED_MIN_FOLD_COUNT = 6; // 75% of SEED_WINDOW
const SEED_FOLD_TOLERANCE_MS = 1.0;
const SEED_MIN_DELTA_MS = 2;
const SEED_MAX_DELTA_MS = 40;
const K_MAX = 8;
const OUTLIER_RESEED = 5;
const RESIDUAL_EWMA_ALPHA = 0.2;
const SPAN_MIN_KSUM = 16;
const PHASE_BETA = 0.3;
const PHASE_STALE_PERIODS = 32;
const DEMOTE_WINDOW = 12;
const CONF_MIN_ACCEPTED = 12;
const VRR_RING_SIZE = 32;
const VRR_ENTER_SPREAD = 0.04;
const VRR_EXIT_SPREAD = 0.015;

/** Residual tolerance: must stay < T/2 for unambiguous k up to 480Hz; the
 *  floor covers timestamp quantization, the cap rejects real jank at 60Hz. */
function toleranceMs(periodMs: number): number {
  return Math.min(1.2, Math.max(0.4, 0.25 * periodMs));
}

export interface RefreshRateEstimator {
  /**
   * Feed a rAF callback timestamp (DOMHighResTimeStamp).
   *
   * `continuous` says whether the caller drives an unbroken rAF chain. Only a
   * continuous stream may seed, re-seed, or demote, because only there does a
   * gap between callbacks describe the *display*. An opportunistic caller
   * requests a frame when it has something to paint, so its gaps describe its
   * own demand and its `k` is bounded below by nothing; it may refine an
   * existing lock and correct phase, and that is all.
   */
  sample(frameTimeMs: number, continuous: boolean): void;
  /**
   * Best estimate of the display refresh period in ms. Defaults to 1000/60
   * until converged; always within [1000/480, 1000/30].
   */
  periodMs(): number;
  /**
   * Panel cadence for consumers that must not inherit the 60 Hz low-confidence
   * fallback on a high-refresh display: the drain CPU budget, the hint
   * published to the daemon, and telemetry.
   *
   * Before the first continuous-rAF delta it uses the fastest supported
   * cadence, and while seeding it tracks the shortest valid continuous delta.
   * Once locked it simply follows the converged estimate, up OR down. It
   * deliberately gates no presentation release: the seed value used to become
   * a floor for the whole session, and 60 Hz panels published 15.2-18.7 ms
   * estimates that multiplied every hold built on them.
   */
  presentationPeriodMs(): number;
  /** 0 while seeding; approaches 1 with sample count and low residuals. */
  confidence01(): number;
  /**
   * Predicted timestamp of the next vsync edge after `nowMs`, or null when
   * unconverged, VRR-active, or the phase anchor is stale.
   */
  nextVsyncAfter(nowMs: number): number | null;
  /** True while accepted periods spread like a variable-refresh display. */
  vrr(): boolean;
  /** Hard re-seed (DPR change / monitor-move signal). */
  reset(): void;
}

export function createRefreshRateEstimator(): RefreshRateEstimator {
  let lastTs: number | null = null;
  let locked = false;
  let seedDeltas: number[] = [];
  let t = DEFAULT_PERIOD_MS;
  let kSum = 0;
  let spanStartTs = 0;
  let accepted = 0;
  let residualEwma = 0;
  let consecutiveOutliers = 0;
  let phaseAnchorTs = 0;
  let lastAcceptedTs = 0;
  let recentPeriods: number[] = [];
  // The P10 of the full `recentPeriods` ring: the period reported while VRR is
  // active. Only `updateVrr` enters VRR, and it derives this in the same call;
  // while VRR is active every ring change runs through it, and the ring resets
  // elsewhere all happen with VRR off. A period read never sorts the ring.
  let vrrLowerBoundMs = DEFAULT_PERIOD_MS;
  const sortedPeriods = new Float64Array(VRR_RING_SIZE);
  let recentKs: number[] = [];
  let vrrActive = false;
  // Cold bound only: the low-confidence 60 Hz fallback would span two to four
  // physical frames at 120-240 Hz, so start at the fastest supported cadence
  // and raise it from actual continuous-rAF evidence while seeding. Once
  // locked, `presentationPeriodMs` reports the converged estimate instead.
  let presentationPeriod = CLAMP_MIN_PERIOD_MS;
  let presentationPeriodObserved = false;
  // The last SEED_WINDOW continuous deltas seen while locked, accepted or not.
  // A *rejected* delta is the only evidence a lock is wrong, so this window
  // deliberately collects them: it is what a re-seed carries forward.
  let lockedDeltas: number[] = [];

  function observePresentationPeriod(deltaMs: number): void {
    const candidate = Math.min(CLAMP_MAX_PERIOD_MS, Math.max(CLAMP_MIN_PERIOD_MS, deltaMs));
    if (!presentationPeriodObserved) {
      presentationPeriod = candidate;
      presentationPeriodObserved = true;
      return;
    }
    presentationPeriod = Math.min(presentationPeriod, candidate);
  }

  function resetToSeeding(carryDeltaMs: number | null): void {
    locked = false;
    seedDeltas = [];
    kSum = 0;
    accepted = 0;
    residualEwma = 0;
    consecutiveOutliers = 0;
    recentPeriods = [];
    recentKs = [];
    lockedDeltas = [];
    vrrActive = false;
    presentationPeriod = CLAMP_MIN_PERIOD_MS;
    presentationPeriodObserved = false;
    if (
      carryDeltaMs !== null &&
      carryDeltaMs >= SEED_MIN_DELTA_MS &&
      carryDeltaMs <= SEED_MAX_DELTA_MS
    ) {
      seedDeltas.push(carryDeltaMs);
      observePresentationPeriod(carryDeltaMs);
    }
  }

  /**
   * The period a window of deltas folds onto, or null when it does not.
   * `lastFoldFrames` carries how many of them folded, without an allocation.
   */
  let lastFoldFrames = 0;
  const foldCandidates = new Float64Array(SEED_WINDOW);
  function foldPeriod(deltas: number[]): number | null {
    foldCandidates.set(deltas);
    foldCandidates.sort();
    for (const candidate of foldCandidates) {
      let foldCount = 0;
      let periodSum = 0;
      for (const delta of deltas) {
        const k = Math.round(delta / candidate);
        if (k >= 1 && Math.abs(delta - k * candidate) <= SEED_FOLD_TOLERANCE_MS) {
          foldCount += 1;
          periodSum += delta / k;
        }
      }
      if (foldCount >= SEED_MIN_FOLD_COUNT) {
        lastFoldFrames = foldCount;
        return periodSum / foldCount;
      }
    }
    return null;
  }

  function lockTo(periodMs: number, ts: number, acceptedCount: number): void {
    locked = true;
    t = periodMs;
    kSum = 0;
    spanStartTs = ts;
    accepted = acceptedCount;
    residualEwma = 0;
    consecutiveOutliers = 0;
    phaseAnchorTs = ts;
    lastAcceptedTs = ts;
    recentPeriods = [];
    recentKs = [];
    lockedDeltas = [];
    // A full window is stronger evidence than the provisional minimum (which
    // may include one timestamp anomaly), so converge the cold bound with the
    // estimator at the same commit point.
    presentationPeriod = Math.min(CLAMP_MAX_PERIOD_MS, Math.max(CLAMP_MIN_PERIOD_MS, t));
    presentationPeriodObserved = true;
    seedDeltas = [];
  }

  function trySeed(ts: number): void {
    const period = foldPeriod(seedDeltas);
    if (period !== null) {
      lockTo(period, ts, lastFoldFrames);
      return;
    }
    // No candidate folds the window: drop the oldest and keep collecting.
    seedDeltas.shift();
  }

  function noteContinuousDelta(delta: number): void {
    if (delta < SEED_MIN_DELTA_MS || delta > SEED_MAX_DELTA_MS) return;
    lockedDeltas.push(delta);
    if (lockedDeltas.length > SEED_WINDOW) lockedDeltas.shift();
  }

  /**
   * Abandon a lock the panel keeps contradicting, carrying the evidence.
   *
   * A seed window drawn from a jittery calibration burst can lock a period
   * longer than the panel's — production published 18.2-18.7 ms for whole
   * sessions on 60 Hz displays. Every real 16.67 ms delta is then *rejected*
   * as an outlier, so nothing in the accept path can correct it, and every
   * threshold derived from the period stays inflated. Re-seeding from the
   * continuous deltas that produced those outliers re-locks within the same
   * burst, instead of leaving the estimator unlocked — and publishing the cold
   * bound — until eight more continuous callbacks happen to arrive.
   */
  function reseedFromContinuous(ts: number): void {
    const carried = lockedDeltas.slice();
    resetToSeeding(null);
    for (const delta of carried) {
      seedDeltas.push(delta);
      observePresentationPeriod(delta);
    }
    if (seedDeltas.length >= SEED_WINDOW) trySeed(ts);
  }

  function updateVrr(): void {
    if (recentPeriods.length < VRR_RING_SIZE) return;
    // The ring holds exactly VRR_RING_SIZE finite positive periods here, and a
    // typed array sorts them in the same numeric order a comparator would.
    sortedPeriods.set(recentPeriods);
    const sorted = sortedPeriods.sort();
    const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? t;
    const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? t;
    const median = sorted[Math.floor(sorted.length / 2)] ?? t;
    vrrLowerBoundMs = p10;
    const spread = median > 0 ? (p90 - p10) / median : 0;
    if (!vrrActive && spread > VRR_ENTER_SPREAD) vrrActive = true;
    else if (vrrActive && spread < VRR_EXIT_SPREAD) vrrActive = false;
  }

  function acceptSample(
    ts: number,
    delta: number,
    k: number,
    residual: number,
    continuous: boolean,
  ): void {
    t += Math.min(0.3, 0.1 * k) * (delta / k - t);
    kSum += k;
    residualEwma += RESIDUAL_EWMA_ALPHA * (residual - residualEwma);
    consecutiveOutliers = 0;
    accepted += 1;
    lastAcceptedTs = ts;

    // The two rings are a record of *continuous* observation: one decides the
    // display is variable-refresh, the other that the lock is a harmonic, and
    // both read a run of k≥2 as evidence about the panel. An opportunistic
    // sample's k measures how long the terminal was quiet, so it refines the
    // period and the phase and contributes to neither ring.
    if (continuous) {
      recentPeriods.push(delta / k);
      if (recentPeriods.length > VRR_RING_SIZE) recentPeriods.shift();
      recentKs.push(k);
      if (recentKs.length > DEMOTE_WINDOW) recentKs.shift();
      updateVrr();

      // Subharmonic demotion: a window of only-k≥2 samples means the locked
      // period is a harmonic of the true (slower) one — a real fast display
      // always produces k=1 within the window during a calibration burst. That
      // premise is why this is continuous-only: on the render loop a window of
      // k≥2 is the ordinary shape of typing, and demoting on it walked the
      // estimate 8.33 → 16.67 → 33.33 ms, doubling every threshold derived
      // from the period.
      if (
        !vrrActive &&
        recentKs.length === DEMOTE_WINDOW &&
        recentKs.every((value) => value >= 2)
      ) {
        const factor = Math.min(...recentKs);
        t *= factor;
        kSum /= factor;
        // Twelve consecutive continuous k>=2 samples prove the display moved
        // to the slower harmonic. Let presentation coalescing recover too;
        // retaining the old faster minimum forever would needlessly split
        // future redraws.
        presentationPeriod = Math.min(CLAMP_MAX_PERIOD_MS, Math.max(CLAMP_MIN_PERIOD_MS, t));
        presentationPeriodObserved = true;
        recentPeriods = [];
        recentKs = [];
        // Deltas gathered against the old faster lock cannot argue about the
        // new one.
        lockedDeltas = [];
      }
    }

    // PLL phase correction toward the observed edge.
    const periodsSinceAnchor = Math.round((ts - phaseAnchorTs) / t);
    const predicted = phaseAnchorTs + periodsSinceAnchor * t;
    phaseAnchorTs = predicted + PHASE_BETA * (ts - predicted);
  }

  /**
   * The long-baseline estimate holds only while every millisecond between
   * `spanStartTs` and `lastAcceptedTs` is accounted for by one of `kSum`
   * periods. Any path that skips a delta must therefore re-anchor both.
   */
  function activePeriodMs(): number {
    if (vrrActive) return vrrLowerBoundMs;
    if (kSum >= SPAN_MIN_KSUM) return (lastAcceptedTs - spanStartTs) / kSum;
    return t;
  }

  function confidence(): number {
    if (!locked) return 0;
    const countFactor = Math.min(1, accepted / CONF_MIN_ACCEPTED);
    const quality = Math.max(0, 1 - residualEwma / toleranceMs(t));
    return countFactor * quality;
  }

  return {
    sample(frameTimeMs: number, continuous: boolean): void {
      if (!Number.isFinite(frameTimeMs)) return;
      const previous = lastTs;
      if (previous === null) {
        lastTs = frameTimeMs;
        return;
      }

      const delta = frameTimeMs - previous;
      // Duplicate timestamp: the render rAF and a calibration rAF can fire
      // in the same display frame. Do not move the delta origin for a duplicate
      // (or an out-of-order sample): its uncounted interval would otherwise
      // remain in the long-baseline numerator after the next accepted sample.
      if (delta < CLAMP_MIN_PERIOD_MS / 2) return;
      lastTs = frameTimeMs;

      // Only the calibrator supplies an unbroken rAF chain. Its shortest valid
      // delta is therefore the earliest trustworthy cadence evidence and must
      // be visible to the presentation bound before the full seed/confidence
      // window converges.
      if (!locked && continuous && delta >= SEED_MIN_DELTA_MS && delta <= SEED_MAX_DELTA_MS) {
        observePresentationPeriod(delta);
      }

      if (!locked) {
        // Seeding needs consecutive vsync deltas. An opportunistic caller
        // cannot supply them, and its widely spaced deltas would fold onto a
        // subharmonic candidate and lock the estimator to a rate no display
        // has.
        if (!continuous) return;
        if (delta >= SEED_MIN_DELTA_MS && delta <= SEED_MAX_DELTA_MS) {
          seedDeltas.push(delta);
          if (seedDeltas.length === SEED_WINDOW) trySeed(frameTimeMs);
        } else {
          // A seed window describes consecutive continuous callbacks. Samples
          // from before a suspended chain cannot help lock a new monitor rate.
          resetToSeeding(null);
        }
        return;
      }

      // Before accept/reject: a rejected delta is the only proof that a lock is
      // wrong, so the carry window must see it too.
      if (continuous) noteContinuousDelta(delta);

      const k = Math.round(delta / t);
      if (k > K_MAX) {
        // Idle gap or throttled tab. Freeze the estimate — `t`, `accepted`,
        // `residualEwma` and the lock all stand — but the span baseline has to
        // start over, because the gap's wall time is not covered by any period
        // it counted. Leaving it in place fed that time into the numerator of
        // `activePeriodMs`'s long-baseline estimate with nothing in the
        // denominator: one 60s idle before a revalidation burst read as a
        // 1,580ms period, clamped to 33.33ms and published at full confidence,
        // which doubled every threshold derived from the period.
        //
        // `lastAcceptedTs` is deliberately NOT advanced: it is also the
        // staleness clock for `nextVsyncAfter`, and a gap must not make a
        // stale phase look fresh.
        spanStartTs = frameTimeMs;
        kSum = 0;
        phaseAnchorTs = frameTimeMs;
        return;
      }
      if (k < 1) {
        spanStartTs = frameTimeMs;
        kSum = 0;
        // Faster than the locked period can explain (rate increased).
        if (!continuous) return;
        consecutiveOutliers += 1;
        if (consecutiveOutliers >= OUTLIER_RESEED) reseedFromContinuous(frameTimeMs);
        return;
      }
      const residual = Math.abs(delta - k * t);
      if (residual > toleranceMs(t)) {
        // This delta is excluded, whether it is demand jitter or a continuous
        // outlier. Its wall time must be excluded from the accepted span too.
        // Keep lastAcceptedTs unchanged: rejection cannot freshen the phase.
        spanStartTs = frameTimeMs;
        kSum = 0;
        // An opportunistic delta lands wherever demand did, so a residual it
        // cannot explain is not evidence about the panel.
        if (!continuous) return;
        consecutiveOutliers += 1;
        if (consecutiveOutliers >= OUTLIER_RESEED) reseedFromContinuous(frameTimeMs);
        return;
      }
      acceptSample(frameTimeMs, delta, k, residual, continuous);
    },

    periodMs(): number {
      if (confidence() < 0.5) return DEFAULT_PERIOD_MS;
      return Math.min(CLAMP_MAX_PERIOD_MS, Math.max(CLAMP_MIN_PERIOD_MS, activePeriodMs()));
    },

    presentationPeriodMs(): number {
      // No `Math.min` against the seed observation. That clamp made the cold
      // bound a permanent floor for the session, so a lock taken from a jittery
      // burst could never be walked back down.
      if (confidence() < 0.5) return presentationPeriod;
      return Math.min(CLAMP_MAX_PERIOD_MS, Math.max(CLAMP_MIN_PERIOD_MS, activePeriodMs()));
    },

    confidence01(): number {
      return confidence();
    },

    nextVsyncAfter(nowMs: number): number | null {
      if (!locked || vrrActive || confidence() < 0.5) return null;
      if (nowMs - lastAcceptedTs > PHASE_STALE_PERIODS * t) return null;
      const periodsAhead = Math.max(1, Math.ceil((nowMs - phaseAnchorTs) / t));
      return phaseAnchorTs + periodsAhead * t;
    },

    vrr(): boolean {
      return vrrActive;
    },

    reset(): void {
      lastTs = null;
      resetToSeeding(null);
    },
  };
}
