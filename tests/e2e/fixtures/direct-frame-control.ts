export const DIRECT_FRAME_CONTROL_MIN_INTERVALS = 200;
export const DIRECT_FRAME_PHASE_MIN_P95_INTERVALS = 20;
export const DIRECT_FRAME_PHASE_MIN_P99_INTERVALS = 200;
export const DIRECT_FRAME_EQUIVALENCE_MARGIN_MS = 1;

export type DirectFrameControlKind = 'idle' | 'keyboard-injection';
export type DirectFrameControlPosition = 'before' | 'after';

export interface DirectFrameDistribution {
  readonly count: number;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

export interface DirectFramePopulation {
  readonly name: string;
  readonly intervalCount: number;
  readonly frameBudgetOverrunMs: DirectFrameDistribution;
  readonly estimatedMissedFrameCount: number;
  /** Number of rAF intervals with one or more nearest-period estimated misses. */
  readonly estimatedMissedIntervalCount: number;
  readonly frameBudgetExceededIntervalCount: number;
}

export interface DirectFrameControlPopulation extends DirectFramePopulation {
  readonly kind: DirectFrameControlKind;
  readonly position: DirectFrameControlPosition;
}

export interface DirectFramePhasePopulation extends DirectFramePopulation {
  readonly matchedControl: DirectFrameControlKind;
}

export interface DirectRefreshPeriodCalibration {
  readonly sourceAtMs: number;
  readonly periodMs: number;
  readonly confidence01: number;
}

export interface DirectRefreshPeriodPopulation {
  readonly name: string;
  readonly observations: readonly {
    /** Null only for a derived exact measurement-window population. */
    readonly atMs: number | null;
    readonly periodMs: number;
  }[];
}

export interface DirectRefreshPeriodAgreement {
  readonly complete: boolean;
  readonly toleranceMs: number;
  readonly maximumAbsoluteDeltaMs: number | null;
  readonly errors: readonly string[];
}

export interface BinomialRateEvidence {
  readonly count: number;
  readonly population: number;
  readonly rate: number;
  readonly wilson95: { readonly low: number; readonly high: number };
}

export interface DirectFramePhaseComparison {
  readonly name: string;
  readonly matchedControl: DirectFrameControlKind;
  readonly controlP95Ms: number;
  readonly controlP99Ms: number;
  readonly p95: {
    readonly available: true;
    readonly productMs: number;
    readonly controlDeltaMs: number;
    readonly allowedMs: number;
    readonly equivalent: boolean;
  };
  readonly p99:
    | {
        readonly available: true;
        readonly productMs: number;
        readonly controlDeltaMs: number;
        readonly allowedMs: number;
        readonly equivalent: boolean;
      }
    | {
        readonly available: false;
        readonly reason: 'fewer-than-200-active-intervals';
      };
  readonly rawTarget: {
    readonly toleranceMs: number;
    readonly met: boolean;
    readonly environmentLimited: boolean;
    readonly productExceededIntervalRate: BinomialRateEvidence;
    readonly productEstimatedMissRate: BinomialRateEvidence;
    readonly controlsExceededAbsoluteTarget: readonly DirectFrameControlPosition[];
  };
}

export interface DirectFrameControlComparison {
  readonly status: 'pass' | 'fail' | 'inconclusive';
  readonly relativeComplete: boolean;
  readonly absoluteTargetComplete: boolean;
  readonly equivalenceMarginMs: number;
  readonly errors: readonly string[];
  readonly inconclusiveReasons: readonly string[];
  readonly phases: readonly DirectFramePhaseComparison[];
  readonly controls: readonly (DirectFrameControlPopulation & {
    readonly exceededIntervalRate: BinomialRateEvidence;
    readonly estimatedMissRate: BinomialRateEvidence;
    readonly rawTargetMet: boolean;
  })[];
}

/**
 * Pin every phase-local refresh estimate to the confident, same-session
 * calibration captured before the workloads. A workload-induced harmonic
 * demotion must invalidate the phase rather than redefine a skipped physical
 * refresh as one larger frame period.
 */
export function compareDirectRefreshPeriods(
  calibration: DirectRefreshPeriodCalibration | null,
  populations: readonly DirectRefreshPeriodPopulation[],
  toleranceMs: number,
  phaseSessionStartAtMs: readonly number[] = [],
): DirectRefreshPeriodAgreement {
  const errors: string[] = [];
  let maximumAbsoluteDeltaMs: number | null = null;
  if (
    calibration === null ||
    !Number.isFinite(calibration.sourceAtMs) ||
    calibration.sourceAtMs < 0 ||
    !Number.isFinite(calibration.periodMs) ||
    calibration.periodMs <= 0 ||
    !Number.isFinite(calibration.confidence01) ||
    calibration.confidence01 < 0.5 ||
    calibration.confidence01 > 1
  ) {
    errors.push('direct phase has no confident pre-workload refresh calibration');
  }
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
    errors.push('direct refresh-period agreement tolerance is invalid');
  }
  for (const [index, atMs] of phaseSessionStartAtMs.entries()) {
    if (!Number.isFinite(atMs) || atMs < 0) {
      errors.push(`phase session-start[${index}] has an invalid timestamp`);
    } else {
      errors.push(`phase contains a session start at ${atMs}ms after fixed calibration`);
    }
  }
  for (const population of populations) {
    if (population.observations.length === 0) {
      errors.push(`${population.name} has no refresh-period observations`);
      continue;
    }
    for (const [index, observation] of population.observations.entries()) {
      if (!Number.isFinite(observation.periodMs) || observation.periodMs <= 0) {
        errors.push(`${population.name}[${index}] has an invalid refresh period`);
        continue;
      }
      if (
        observation.atMs !== null &&
        (!Number.isFinite(observation.atMs) ||
          (calibration !== null && observation.atMs <= calibration.sourceAtMs))
      ) {
        errors.push(`${population.name}[${index}] does not follow the calibration boundary`);
      }
      if (calibration === null || !Number.isFinite(toleranceMs) || toleranceMs < 0) continue;
      const deltaMs = Math.abs(observation.periodMs - calibration.periodMs);
      maximumAbsoluteDeltaMs = Math.max(maximumAbsoluteDeltaMs ?? 0, deltaMs);
      if (deltaMs > toleranceMs) {
        errors.push(
          `${population.name}[${index}] refresh period ${observation.periodMs}ms differs from calibrated ${calibration.periodMs}ms by ${deltaMs}ms`,
        );
      }
    }
  }
  return {
    complete: errors.length === 0,
    toleranceMs,
    maximumAbsoluteDeltaMs,
    errors,
  };
}

/**
 * Compare terminal phases with controls bracketing the same live browser,
 * display and session. The 1ms margin is a predeclared rAF scheduling margin,
 * not a redefinition of the physical refresh budget.
 *
 * Absolute overruns and miss rates remain first-class evidence. A noisy host
 * control can explain why that absolute target was unavailable, but can never
 * turn it into a product pass. Product/control equivalence is independently
 * gated at p95 and, only with at least 200 active intervals, p99. Maxima and
 * rare-event rates are reported with sample size / Wilson intervals rather
 * than compared across unequal populations.
 */
export function compareDirectFrameControls(
  controls: readonly DirectFrameControlPopulation[],
  phases: readonly DirectFramePhasePopulation[],
  absoluteToleranceMs: number,
): DirectFrameControlComparison {
  const errors: string[] = [];
  const inconclusiveReasons: string[] = [];
  let absoluteGateFailureCount = 0;
  if (!Number.isFinite(absoluteToleranceMs) || absoluteToleranceMs < 0) {
    errors.push('absolute frame target tolerance is invalid');
  }

  const controlsWithEvidence = controls.map((control) => {
    validatePopulation(control, DIRECT_FRAME_CONTROL_MIN_INTERVALS, errors);
    return {
      ...control,
      exceededIntervalRate: binomialRate(
        control.frameBudgetExceededIntervalCount,
        control.intervalCount,
      ),
      estimatedMissRate: binomialRate(control.estimatedMissedIntervalCount, control.intervalCount),
      rawTargetMet: rawTargetMet(control, absoluteToleranceMs),
    };
  });

  const byKind = new Map<DirectFrameControlKind, Map<DirectFrameControlPosition, number>>();
  for (let index = 0; index < controlsWithEvidence.length; index += 1) {
    const control = controlsWithEvidence[index];
    if (control === undefined) continue;
    let positions = byKind.get(control.kind);
    if (positions === undefined) {
      positions = new Map();
      byKind.set(control.kind, positions);
    }
    if (positions.has(control.position)) {
      errors.push(`${control.kind} has duplicate ${control.position} controls`);
    } else {
      positions.set(control.position, index);
    }
  }

  const phaseComparisons: DirectFramePhaseComparison[] = [];
  for (const phase of phases) {
    validatePopulation(phase, DIRECT_FRAME_PHASE_MIN_P95_INTERVALS, errors);
    const positions = byKind.get(phase.matchedControl);
    const before = positions?.get('before');
    const after = positions?.get('after');
    if (before === undefined || after === undefined) {
      errors.push(`${phase.name} lacks bracketing ${phase.matchedControl} controls`);
      continue;
    }
    const matched = [controlsWithEvidence[before], controlsWithEvidence[after]];
    if (matched.some((control) => control === undefined)) {
      errors.push(`${phase.name} has an invalid matched-control index`);
      continue;
    }
    const matchedControls = matched.filter(
      (control): control is (typeof controlsWithEvidence)[number] => control !== undefined,
    );
    const controlP95Ms = Math.max(...matchedControls.map((control) => finiteP95(control)));
    const controlP99Ms = Math.max(...matchedControls.map((control) => finiteP99(control)));
    const productP95 = finiteP95(phase);
    const allowedP95 = controlP95Ms + DIRECT_FRAME_EQUIVALENCE_MARGIN_MS;
    const p95Equivalent = productP95 <= allowedP95;
    if (!p95Equivalent) {
      errors.push(
        `${phase.name} p95 rAF overrun ${productP95}ms exceeds bracketed ${phase.matchedControl} control ${controlP95Ms}ms + ${DIRECT_FRAME_EQUIVALENCE_MARGIN_MS}ms`,
      );
    }

    let p99: DirectFramePhaseComparison['p99'];
    if (phase.intervalCount < DIRECT_FRAME_PHASE_MIN_P99_INTERVALS) {
      p99 = { available: false, reason: 'fewer-than-200-active-intervals' };
    } else {
      const productP99 = finiteP99(phase);
      const allowedP99 = controlP99Ms + DIRECT_FRAME_EQUIVALENCE_MARGIN_MS;
      const p99Equivalent = productP99 <= allowedP99;
      if (!p99Equivalent) {
        errors.push(
          `${phase.name} p99 rAF overrun ${productP99}ms exceeds bracketed ${phase.matchedControl} control ${controlP99Ms}ms + ${DIRECT_FRAME_EQUIVALENCE_MARGIN_MS}ms`,
        );
      }
      p99 = {
        available: true,
        productMs: productP99,
        controlDeltaMs: productP99 - controlP99Ms,
        allowedMs: allowedP99,
        equivalent: p99Equivalent,
      };
    }

    phaseComparisons.push({
      name: phase.name,
      matchedControl: phase.matchedControl,
      controlP95Ms,
      controlP99Ms,
      p95: {
        available: true,
        productMs: productP95,
        controlDeltaMs: productP95 - controlP95Ms,
        allowedMs: allowedP95,
        equivalent: p95Equivalent,
      },
      p99,
      rawTarget: {
        toleranceMs: absoluteToleranceMs,
        met: rawTargetMet(phase, absoluteToleranceMs),
        environmentLimited: matchedControls.some((control) => !control.rawTargetMet),
        productExceededIntervalRate: binomialRate(
          phase.frameBudgetExceededIntervalCount,
          phase.intervalCount,
        ),
        productEstimatedMissRate: binomialRate(
          phase.estimatedMissedIntervalCount,
          phase.intervalCount,
        ),
        controlsExceededAbsoluteTarget: matchedControls
          .filter((control) => !control.rawTargetMet)
          .map((control) => control.position),
      },
    });
    if (!rawTargetMet(phase, absoluteToleranceMs)) {
      if (matchedControls.some((control) => !control.rawTargetMet)) {
        inconclusiveReasons.push(
          `${phase.name} missed the absolute frame target while its matched ${phase.matchedControl} control also missed it`,
        );
      } else {
        absoluteGateFailureCount += 1;
        errors.push(
          `${phase.name} missed the absolute frame target despite clean matched ${phase.matchedControl} controls`,
        );
      }
    }
  }

  for (const kind of ['idle', 'keyboard-injection'] as const) {
    const positions = byKind.get(kind);
    if (positions?.has('before') !== true) errors.push(`${kind} before control is missing`);
    if (positions?.has('after') !== true) errors.push(`${kind} after control is missing`);
  }

  const relativeComplete =
    errors.length === absoluteGateFailureCount && phaseComparisons.length === phases.length;
  const absoluteTargetComplete =
    phaseComparisons.length === phases.length &&
    phaseComparisons.every((phase) => phase.rawTarget.met);
  return {
    status: errors.length > 0 ? 'fail' : inconclusiveReasons.length > 0 ? 'inconclusive' : 'pass',
    relativeComplete,
    absoluteTargetComplete,
    equivalenceMarginMs: DIRECT_FRAME_EQUIVALENCE_MARGIN_MS,
    errors,
    inconclusiveReasons,
    phases: phaseComparisons,
    controls: controlsWithEvidence,
  };
}

function validatePopulation(
  population: DirectFramePopulation,
  minimumIntervals: number,
  errors: string[],
): void {
  if (
    !Number.isSafeInteger(population.intervalCount) ||
    population.intervalCount < minimumIntervals
  ) {
    errors.push(
      `${population.name} has ${population.intervalCount} rAF intervals; at least ${minimumIntervals} are required`,
    );
  }
  if (population.frameBudgetOverrunMs.count !== population.intervalCount) {
    errors.push(`${population.name} rAF overrun count does not match its interval population`);
  }
  if (
    !Number.isSafeInteger(population.frameBudgetExceededIntervalCount) ||
    population.frameBudgetExceededIntervalCount < 0 ||
    population.frameBudgetExceededIntervalCount > population.intervalCount
  ) {
    errors.push(`${population.name} frame-budget-exceeded count is invalid`);
  }
  if (
    !Number.isSafeInteger(population.estimatedMissedFrameCount) ||
    population.estimatedMissedFrameCount < 0
  ) {
    errors.push(`${population.name} estimated-missed-frame count is invalid`);
  }
  if (
    !Number.isSafeInteger(population.estimatedMissedIntervalCount) ||
    population.estimatedMissedIntervalCount < 0 ||
    population.estimatedMissedIntervalCount > population.intervalCount
  ) {
    errors.push(`${population.name} estimated-missed-frame interval count is invalid`);
  }
  finiteP95(population, errors);
  finiteP99(population, errors);
  const maximum = population.frameBudgetOverrunMs.max;
  if (maximum === null || !Number.isFinite(maximum) || maximum < 0) {
    errors.push(`${population.name} rAF overrun maximum is unavailable`);
  }
}

function finiteP95(population: DirectFramePopulation, errors?: string[]): number {
  const value = population.frameBudgetOverrunMs.p95;
  if (value !== null && Number.isFinite(value) && value >= 0) return value;
  errors?.push(`${population.name} rAF overrun p95 is unavailable`);
  return Number.POSITIVE_INFINITY;
}

function finiteP99(population: DirectFramePopulation, errors?: string[]): number {
  const value = population.frameBudgetOverrunMs.p99;
  if (value !== null && Number.isFinite(value) && value >= 0) return value;
  errors?.push(`${population.name} rAF overrun p99 is unavailable`);
  return Number.POSITIVE_INFINITY;
}

function rawTargetMet(population: DirectFramePopulation, toleranceMs: number): boolean {
  const maximum = population.frameBudgetOverrunMs.max;
  return (
    maximum !== null &&
    Number.isFinite(maximum) &&
    maximum <= toleranceMs &&
    population.frameBudgetExceededIntervalCount === 0 &&
    population.estimatedMissedFrameCount === 0
  );
}

export function binomialRate(count: number, population: number): BinomialRateEvidence {
  if (
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(population) ||
    population <= 0 ||
    count < 0 ||
    count > population
  ) {
    return {
      count,
      population,
      rate: Number.NaN,
      wilson95: { low: Number.NaN, high: Number.NaN },
    };
  }
  const z = 1.959963984540054;
  const rate = count / population;
  const z2 = z * z;
  const denominator = 1 + z2 / population;
  const centre = (rate + z2 / (2 * population)) / denominator;
  const radius =
    (z / denominator) *
    Math.sqrt((rate * (1 - rate)) / population + z2 / (4 * population * population));
  return {
    count,
    population,
    rate,
    wilson95: { low: Math.max(0, centre - radius), high: Math.min(1, centre + radius) },
  };
}
