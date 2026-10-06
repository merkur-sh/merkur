/**
 * Open-loop admission experiment. GPU service and completion callback delivery
 * are independent virtual clocks. These are scheduler-model results, not browser
 * performance, physical visibility, or evidence about the production GPU driver.
 */
import { createRenderMailbox } from '../../apps/web/src/terminal/render-mailbox';

export interface AdmissionModel {
  offer(atMs: number): boolean;
  opportunity(atMs: number): boolean;
  completed(atMs: number, id: number): boolean;
  submitted(atMs: number, id: number, bytes: number): void;
  deadline(): number | null;
  wakeDeadline(atMs: number): boolean;
}

export interface AdmissionScenario {
  name: string;
  offerPeriodMs: number;
  /** Optional open-loop burst schedule; same clock and full offer accounting. */
  offerTimesMs?: readonly number[];
  offerCount: number;
  refreshPeriodMs: number;
  gpuServiceMs: number;
  gpuServiceChanges?: readonly { atMs: number; serviceMs: number }[];
  /** Null deliberately withholds every completion callback. */
  callbackDelayMs: number | null;
  /** Repeating callback jitter, delivered in queue registration order. */
  callbackDelayPatternMs?: readonly number[];
  uploadBytes: number;
  /** Observation remains bounded even if callbacks never arrive. */
  observationEndMs: number;
  /** Test a suspended rAF task source without suspending timers/ingestion. */
  opportunityPause?: readonly [startMs: number, endMs: number];
}

interface Offer {
  ordinal: number;
  atMs: number;
  submittedAtMs: number | null;
  gpuFinishedAtMs: number | null;
}

interface Submission {
  id: number;
  ordinal: number;
  atMs: number;
  gpuFinishedAtMs: number;
  callbackAtMs: number | null;
}

interface Distribution {
  count: number;
  median: number | null;
  p95: number | null;
  p99: number | null;
  worst: number | null;
}

function distribution(values: number[]): Distribution {
  values.sort((a, b) => a - b);
  const percentile = (p: number): number | null =>
    values[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
  return {
    count: values.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    worst: percentile(1),
  };
}

/** Historical cap-two admission at 8b1b8833; isolated experiment, never runtime. */
export function historicalTwoCreditModel(): AdmissionModel {
  let pending = false;
  let outstanding = 0;
  function advance(): boolean {
    if (!pending || outstanding >= 2) return false;
    pending = false;
    return true;
  }
  return {
    offer() {
      pending = true;
      return advance();
    },
    opportunity: () => false,
    deadline: () => null,
    wakeDeadline: () => false,
    completed() {
      if (outstanding === 0) throw new Error('completion without ownership');
      outstanding -= 1;
      return advance();
    },
    submitted() {
      outstanding += 1;
      if (outstanding > 2) throw new Error('historical cap exceeded');
    },
  };
}

/**
 * Exercises production admission, not a copied candidate implementation.
 *
 * Production no longer owns a cadence deadline: progress comes from a real
 * animation frame or a genuine fence completion, so this model exposes none.
 */
export function productionAdmissionModel(): AdmissionModel {
  const mailbox = createRenderMailbox();
  return {
    offer: () => mailbox.noteDirty().kind === 'render-now',
    opportunity: (atMs) => mailbox.noteOpportunity(atMs).kind === 'render-now',
    completed: (_atMs, id) => mailbox.noteFrameComplete(id).kind === 'render-now',
    submitted: (atMs, id) => {
      const action = mailbox.noteSubmitted(atMs, id);
      if (action.kind === 'render-now') throw new Error('unexpected reentrant fixture admission');
    },
    deadline: () => null,
    wakeDeadline: () => false,
  };
}

/** Rejected admission-credit experiment only; never a selectable runtime path. */
export function creditCapExperimentModel(cap: number, periodMs: number): AdmissionModel {
  let pending = false;
  let outstanding = 0;
  let opportunity = true;
  let deadline: number | null = null;
  let lastSubmit = -Infinity;
  function advance(atMs: number): boolean {
    if (!pending || outstanding >= cap) return false;
    if (outstanding > 0 && !opportunity && (deadline === null || atMs < deadline)) return false;
    pending = false;
    return true;
  }
  function offer(atMs: number): boolean {
    pending = true;
    if (deadline === null) deadline = atMs + periodMs;
    return advance(atMs);
  }
  return {
    offer,
    opportunity(atMs) {
      if (atMs > lastSubmit) opportunity = true;
      return advance(atMs);
    },
    completed(atMs) {
      outstanding--;
      return advance(atMs);
    },
    submitted(atMs) {
      outstanding++;
      opportunity = false;
      lastSubmit = atMs;
      deadline = null;
    },
    deadline: () => (pending && outstanding < cap ? deadline : null),
    wakeDeadline: offer,
  };
}

/** A reproducible Pareto boundary, not a claim that queue depth predicts GPU time. */
export function creditCapTradeoffMatrix() {
  const results = [];
  for (const hz of [60, 120])
    for (const cap of [2, 4, 8, 16, 32])
      for (const slowdown of [false, true]) {
        const scenario: AdmissionScenario = {
          name: `${hz}Hz/cap${cap}/${slowdown ? 'hidden-slowdown' : 'fast-delayed-observation'}`,
          offerPeriodMs: 5,
          offerCount: 1000,
          refreshPeriodMs: 1000 / hz,
          gpuServiceMs: 1,
          callbackDelayMs: 150,
          uploadBytes: 84,
          observationEndMs: 10000,
          gpuServiceChanges: slowdown
            ? [
                { atMs: 500, serviceMs: 50 },
                { atMs: 1500, serviceMs: 1 },
              ]
            : [],
        };
        const {
          offers: _offers,
          submissions: _submissions,
          ...result
        } = simulateRenderAdmission(scenario, () => creditCapExperimentModel(cap, 1000 / hz));
        results.push({ cap, ...result });
      }
  return results;
}

export function simulateRenderAdmission(
  scenario: AdmissionScenario,
  createModel: () => AdmissionModel,
) {
  if (
    !Number.isSafeInteger(scenario.offerCount) ||
    scenario.offerCount <= 0 ||
    !Number.isSafeInteger(scenario.uploadBytes) ||
    scenario.uploadBytes < 0 ||
    ![scenario.offerPeriodMs, scenario.refreshPeriodMs, scenario.gpuServiceMs].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    (scenario.callbackDelayMs !== null &&
      (!Number.isFinite(scenario.callbackDelayMs) || scenario.callbackDelayMs < 0)) ||
    (scenario.callbackDelayPatternMs !== undefined &&
      (scenario.callbackDelayPatternMs.length === 0 ||
        !scenario.callbackDelayPatternMs.every((value) => Number.isFinite(value) && value >= 0))) ||
    !Number.isFinite(scenario.observationEndMs) ||
    (scenario.offerTimesMs !== undefined &&
      (scenario.offerTimesMs.length !== scenario.offerCount ||
        !scenario.offerTimesMs.every(
          (at, index, times) =>
            Number.isFinite(at) && at >= 0 && (index === 0 || at > (times[index - 1] ?? Infinity)),
        ))) ||
    scenario.observationEndMs <
      (scenario.offerTimesMs?.at(-1) ?? (scenario.offerCount - 1) * scenario.offerPeriodMs)
  )
    throw new Error('invalid bounded admission scenario');
  const model = createModel();
  const offers: Offer[] = [];
  const submissions: Submission[] = [];
  let nextOffer = 0;
  let nextOpportunity = 1;
  let gpuIndex = 0;
  let callbackIndex = 0;
  let lastSubmittedOrdinal = 0;
  let lastGpuOrdinal = 0;
  let gpuTailMs = 0;
  let maxActualGpuOutstanding = 0;
  let maxUnconfirmed = 0;
  let maxGpuBacklogMs = 0;
  let accountedOffers = 0;
  let gpuAccountedOffers = 0;
  let lastCallbackAt = 0;

  function submit(atMs: number): void {
    const ordinal = offers.length;
    if (ordinal <= lastSubmittedOrdinal) throw new Error('obsolete or duplicate submission');
    const id = submissions.length + 1;
    let serviceMs = scenario.gpuServiceMs;
    for (const change of scenario.gpuServiceChanges ?? []) {
      if (atMs >= change.atMs) serviceMs = change.serviceMs;
    }
    gpuTailMs = Math.max(atMs, gpuTailMs) + serviceMs;
    const pattern = scenario.callbackDelayPatternMs;
    const delay = pattern?.[(id - 1) % pattern.length] ?? scenario.callbackDelayMs;
    if (delay !== null) lastCallbackAt = Math.max(lastCallbackAt, gpuTailMs + delay);
    const frame: Submission = {
      id,
      ordinal,
      atMs,
      gpuFinishedAtMs: gpuTailMs,
      callbackAtMs: delay === null ? null : lastCallbackAt,
    };
    submissions.push(frame);
    model.submitted(atMs, id, scenario.uploadBytes);
    lastSubmittedOrdinal = ordinal;
    while (accountedOffers < ordinal) {
      const offer = offers[accountedOffers++];
      if (offer === undefined) throw new Error('missing offered revision');
      offer.submittedAtMs = atMs;
    }
    maxActualGpuOutstanding = Math.max(maxActualGpuOutstanding, submissions.length - gpuIndex);
    maxUnconfirmed = Math.max(maxUnconfirmed, submissions.length - callbackIndex);
    maxGpuBacklogMs = Math.max(maxGpuBacklogMs, gpuTailMs - atMs);
  }

  // Ties deliberately offer input before releasing GPU/completion capacity.
  // No closed-loop source waits for submission or confirmation to offer again.
  for (let steps = 0; ; steps += 1) {
    if (steps > 1_000_000) throw new Error('admission experiment failed to stay bounded');
    const offerAt =
      nextOffer < scenario.offerCount
        ? (scenario.offerTimesMs?.[nextOffer] ?? nextOffer * scenario.offerPeriodMs)
        : Infinity;
    const gpuAt = submissions[gpuIndex]?.gpuFinishedAtMs ?? Infinity;
    const callbackAt = submissions[callbackIndex]?.callbackAtMs ?? Infinity;
    let opportunityAt = nextOpportunity * scenario.refreshPeriodMs;
    const pause = scenario.opportunityPause;
    if (pause !== undefined && opportunityAt >= pause[0] && opportunityAt < pause[1]) {
      nextOpportunity = Math.ceil(pause[1] / scenario.refreshPeriodMs);
      opportunityAt = nextOpportunity * scenario.refreshPeriodMs;
    }
    const deadlineAt = model.deadline() ?? Infinity;
    const atMs = Math.min(offerAt, gpuAt, callbackAt, opportunityAt, deadlineAt);
    if (atMs > scenario.observationEndMs) break;
    if (atMs === offerAt) {
      nextOffer += 1;
      offers.push({ ordinal: nextOffer, atMs, submittedAtMs: null, gpuFinishedAtMs: null });
      if (model.offer(atMs)) submit(atMs);
    } else if (atMs === gpuAt) {
      const frame = submissions[gpuIndex++];
      if (frame === undefined) throw new Error('missing GPU owner');
      lastGpuOrdinal = frame.ordinal;
      while (gpuAccountedOffers < frame.ordinal) {
        const offer = offers[gpuAccountedOffers++];
        if (offer === undefined) throw new Error('missing GPU-covered offer');
        offer.gpuFinishedAtMs = atMs;
      }
    } else if (atMs === callbackAt) {
      const frame = submissions[callbackIndex++];
      if (frame === undefined) throw new Error('missing completion owner');
      if (model.completed(atMs, frame.id)) submit(atMs);
    } else if (atMs === opportunityAt) {
      nextOpportunity += 1;
      if (model.opportunity(atMs)) submit(atMs);
    } else {
      if (model.wakeDeadline(atMs)) submit(atMs);
      const nextDeadline = model.deadline();
      if (nextDeadline !== null && nextDeadline <= atMs)
        throw new Error('deadline callback retained an expired wake');
    }
  }
  return {
    scenario,
    offered: offers.length,
    submitted: submissions.length,
    callbacks: callbackIndex,
    coalescedOffers: accountedOffers - submissions.length,
    unsubmittedOffers: offers.length - accountedOffers,
    gpuUncoveredOffers: offers.length - gpuAccountedOffers,
    finalSubmittedOrdinal: lastSubmittedOrdinal,
    finalGpuOrdinal: lastGpuOrdinal,
    maxActualGpuOutstanding,
    maxUnconfirmed,
    maxUnconfirmedUploadBytes: maxUnconfirmed * scenario.uploadBytes,
    maxGpuBacklogMs,
    offerToSubmissionMs: distribution(
      offers.flatMap((offer) =>
        offer.submittedAtMs === null ? [] : [offer.submittedAtMs - offer.atMs],
      ),
    ),
    offerToSimulatedGpuFinishMs: distribution(
      offers.flatMap((offer) =>
        offer.gpuFinishedAtMs === null ? [] : [offer.gpuFinishedAtMs - offer.atMs],
      ),
    ),
    offers,
    submissions,
  };
}

export function renderAdmissionMatrix() {
  const results = [];
  for (const hz of [60, 120]) {
    for (const offerPeriodMs of [100, 20, 5]) {
      const profiles = [
        { name: 'fast', gpuServiceMs: 1, callbackDelayMs: 1 },
        { name: 'callback100', gpuServiceMs: 1, callbackDelayMs: 100 },
        { name: 'callback150', gpuServiceMs: 1, callbackDelayMs: 150 },
        {
          name: 'callback-jitter',
          gpuServiceMs: 1,
          callbackDelayMs: 20,
          callbackDelayPatternMs: [20, 20, 100, 20, 20, 150, 20, 20],
        },
        { name: 'gpu25', gpuServiceMs: 25, callbackDelayMs: 0 },
        { name: 'gpu50', gpuServiceMs: 50, callbackDelayMs: 0 },
        { name: 'callbacks-never', gpuServiceMs: 1, callbackDelayMs: null },
        {
          name: 'gpu-slowdown-recovery',
          gpuServiceMs: 1,
          callbackDelayMs: 0,
          gpuServiceChanges: [
            { atMs: 500, serviceMs: 50 },
            { atMs: 1500, serviceMs: 1 },
          ],
        },
      ];
      for (const profile of profiles) {
        const scenario: AdmissionScenario = {
          ...profile,
          name: `${hz}Hz/${offerPeriodMs}ms/${profile.name}`,
          offerPeriodMs,
          offerCount: 1000,
          refreshPeriodMs: 1000 / hz,
          uploadBytes: 84,
          observationEndMs: offerPeriodMs * 1000 + 5000,
        };
        for (const arm of ['historical-cap-two', 'production'] as const) {
          const result = simulateRenderAdmission(
            scenario,
            arm === 'historical-cap-two' ? historicalTwoCreditModel : productionAdmissionModel,
          );
          const { offers: _offers, submissions: _submissions, ...summary } = result;
          results.push({ arm, ...summary });
        }
      }
    }
  }
  return results;
}

export function renderAdmissionBurstMatrix() {
  const results = [];
  for (const hz of [60, 120])
    for (const callbackDelayMs of [0, 100]) {
      const scenario: AdmissionScenario = {
        name: `${hz}Hz/six-offer-bursts/callback${callbackDelayMs}`,
        offerPeriodMs: 1,
        offerTimesMs: Array.from(
          { length: 120 },
          (_, index) => Math.floor(index / 6) * 100 + (index % 6),
        ),
        offerCount: 120,
        refreshPeriodMs: 1000 / hz,
        gpuServiceMs: 1,
        callbackDelayMs,
        uploadBytes: 84,
        observationEndMs: 5000,
      };
      for (const arm of ['historical-cap-two', 'production'] as const) {
        const result = simulateRenderAdmission(
          scenario,
          arm === 'production' ? productionAdmissionModel : historicalTwoCreditModel,
        );
        const { offers, submissions: _submissions, ...summary } = result;
        results.push({
          arm,
          ...summary,
          burstLastOfferToSimulatedGpuFinishMs: distribution(
            offers
              .filter((offer) => offer.ordinal % 6 === 0)
              .flatMap((offer) =>
                offer.gpuFinishedAtMs === null ? [] : [offer.gpuFinishedAtMs - offer.atMs],
              ),
          ),
        });
      }
    }
  return results;
}

if (import.meta.main)
  process.stdout.write(
    `${JSON.stringify(
      {
        interpretation:
          'Virtual admission/service model; no browser, network, or physical paint timings.',
        baselineSource: '8b1b8833:apps/web/src/terminal/render-mailbox.ts',
        results: renderAdmissionMatrix(),
        rejectedCreditCaps: creditCapTradeoffMatrix(),
        burstResults: renderAdmissionBurstMatrix(),
      },
      null,
      2,
    )}\n`,
  );
