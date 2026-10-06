import { describe, expect, test } from 'bun:test';
import {
  type AdmissionScenario,
  creditCapExperimentModel,
  creditCapTradeoffMatrix,
  historicalTwoCreditModel,
  productionAdmissionModel,
  renderAdmissionBurstMatrix,
  renderAdmissionMatrix,
  simulateRenderAdmission,
} from './render-admission-bench';

const scenario: AdmissionScenario = {
  name: 'delayed callbacks, fast GPU',
  offerPeriodMs: 10,
  offerCount: 20,
  refreshPeriodMs: 1000 / 60,
  gpuServiceMs: 1,
  callbackDelayMs: 100,
  uploadBytes: 84,
  observationEndMs: 1000,
};

describe('render admission experiment accounting', () => {
  test('credit sweep matches actual cap-two admission and preserves hidden-slowdown cost', () => {
    for (const callbackDelayMs of [0, 100, 150]) {
      const fixture = { ...scenario, callbackDelayMs };
      const reference = simulateRenderAdmission(fixture, productionAdmissionModel);
      const experiment = simulateRenderAdmission(fixture, () =>
        creditCapExperimentModel(2, fixture.refreshPeriodMs),
      );
      expect(experiment.offers).toEqual(reference.offers);
      expect(experiment.submissions).toEqual(reference.submissions);
    }
    const results = creditCapTradeoffMatrix();
    const slow2 = results.find((r) => r.scenario.name === '120Hz/cap2/hidden-slowdown');
    const slow32 = results.find((r) => r.scenario.name === '120Hz/cap32/hidden-slowdown');
    expect(results).toHaveLength(20);
    expect(slow2?.maxActualGpuOutstanding).toBeLessThanOrEqual(2);
    expect(slow32?.maxGpuBacklogMs ?? 0).toBeGreaterThan(500);
    expect(slow32?.offerToSimulatedGpuFinishMs.worst ?? 0).toBeGreaterThan(
      2 * (slow2?.offerToSimulatedGpuFinishMs.worst ?? Infinity),
    );
  });
  test('callback delay blocks historical admission without pretending the GPU is slow', () => {
    const result = simulateRenderAdmission(scenario, historicalTwoCreditModel);
    expect(result.maxUnconfirmed).toBe(2);
    expect(result.maxActualGpuOutstanding).toBe(1);
    expect(result.maxGpuBacklogMs).toBe(1);
    expect(result.offerToSubmissionMs.worst).toBeGreaterThan(70);
    expect(result.offered).toBe(20);
    expect(result.offerToSubmissionMs.count).toBe(20);
    expect(result.offerToSimulatedGpuFinishMs.count).toBe(20);
    expect(result.finalGpuOrdinal).toBe(20);
    expect(result.coalescedOffers).toBeGreaterThan(0);
    expect(result.callbacks).toBe(result.submitted);
  });

  test('genuine serial GPU service creates physical backlog separately from callbacks', () => {
    const result = simulateRenderAdmission(
      { ...scenario, gpuServiceMs: 50, callbackDelayMs: 0 },
      historicalTwoCreditModel,
    );
    expect(result.maxActualGpuOutstanding).toBe(2);
    expect(result.maxGpuBacklogMs).toBe(100);
    expect(result.finalGpuOrdinal).toBe(20);
    expect(result.offerToSubmissionMs.count).toBe(20);
  });

  test('never-delivered callbacks retain censored offers instead of improving percentiles', () => {
    const result = simulateRenderAdmission(
      { ...scenario, callbackDelayMs: null },
      historicalTwoCreditModel,
    );
    expect(result.submitted).toBe(2);
    expect(result.callbacks).toBe(0);
    expect(result.maxUnconfirmedUploadBytes).toBe(168);
    expect(result.unsubmittedOffers).toBe(18);
    expect(result.gpuUncoveredOffers).toBe(18);
    expect(result.offerToSubmissionMs.count).toBe(2);
    expect(result.offers.filter((offer) => offer.submittedAtMs === null)).toHaveLength(18);
  });

  test('idle input submits immediately', () => {
    const result = simulateRenderAdmission(
      { ...scenario, offerPeriodMs: 100, offerCount: 8, callbackDelayMs: 1 },
      historicalTwoCreditModel,
    );
    expect(result.offerToSubmissionMs.worst).toBe(0);
    expect(result.offerToSimulatedGpuFinishMs.worst).toBe(1);
    expect(result.unsubmittedOffers).toBe(0);
  });

  test('fast typing has no cadence tax after genuine completion', () => {
    for (const hz of [60, 120])
      for (const offerPeriodMs of [5, 10, 20]) {
        const fixture = {
          ...scenario,
          offerCount: 1000,
          offerPeriodMs,
          refreshPeriodMs: 1000 / hz,
          callbackDelayMs: 1,
          observationEndMs: 30000,
        };
        const result = simulateRenderAdmission(fixture, productionAdmissionModel);
        expect(result.submitted).toBe(1000);
        expect(result.offerToSubmissionMs.worst).toBe(0);
        expect(result.maxActualGpuOutstanding).toBe(1);
      }
  });

  test('burst tail uses the second owner without expanding GPU debt', () => {
    for (const result of renderAdmissionBurstMatrix()) {
      expect(result.finalGpuOrdinal).toBe(120);
      expect(result.offerToSimulatedGpuFinishMs.count).toBe(120);
      expect(result.burstLastOfferToSimulatedGpuFinishMs.count).toBe(20);
      expect(result.maxUnconfirmed).toBeLessThanOrEqual(2);
      if (result.scenario.callbackDelayMs === 0) {
        expect(result.submitted).toBe(120);
        expect(result.offerToSimulatedGpuFinishMs.worst).toBe(1);
      } else if (result.arm === 'production') {
        expect(result.submitted).toBe(37);
        expect(result.offerToSimulatedGpuFinishMs.p95 ?? Infinity).toBeLessThanOrEqual(
          result.scenario.refreshPeriodMs + 0.000001,
        );
      } else {
        expect(result.submitted).toBe(37);
        expect(result.offerToSimulatedGpuFinishMs.p95).toBe(99);
      }
    }
  });

  test('rejects invalid or nonterminating fixtures', () => {
    expect(() =>
      simulateRenderAdmission({ ...scenario, offerPeriodMs: 0 }, historicalTwoCreditModel),
    ).toThrow('invalid bounded');
    expect(() =>
      simulateRenderAdmission({ ...scenario, observationEndMs: 10 }, historicalTwoCreditModel),
    ).toThrow('invalid bounded');
    expect(() =>
      simulateRenderAdmission({ ...scenario, offerTimesMs: [0, -1] }, historicalTwoCreditModel),
    ).toThrow('invalid bounded');
  });

  test('production handles callback jitter without manufacturing slow GPU service', () => {
    for (const hz of [60, 120]) {
      const fixture = {
        ...scenario,
        offerCount: 1000,
        offerPeriodMs: 5,
        refreshPeriodMs: 1000 / hz,
        callbackDelayPatternMs: [20, 20, 100, 20, 20, 150, 20, 20],
        observationEndMs: 10000,
      };
      const before = simulateRenderAdmission(fixture, historicalTwoCreditModel);
      const after = simulateRenderAdmission(fixture, productionAdmissionModel);
      expect(after.maxActualGpuOutstanding).toBe(1);
      expect(after.maxUnconfirmed).toBe(2);
      expect(after.offerToSubmissionMs.count).toBe(1000);
      // Callback-only ownership cannot promise a refresh-bound tail under
      // delayed observers; expose the remaining stall instead of dropping it.
      expect(after.offerToSubmissionMs.p95 ?? 0).toBeGreaterThan(1000 / hz);
      expect(after.offerToSubmissionMs.worst ?? Infinity).toBeLessThanOrEqual(
        (before.offerToSubmissionMs.worst ?? 0) + 1000 / hz,
      );
    }
  });

  test('production does not hide slow-GPU overload behind enlarged unconfirmed capacity', () => {
    for (const hz of [60, 120]) {
      for (const gpuServiceMs of [25, 50]) {
        const fixture = {
          ...scenario,
          offerCount: 1000,
          offerPeriodMs: 5,
          gpuServiceMs,
          callbackDelayMs: 0,
          refreshPeriodMs: 1000 / hz,
          observationEndMs: 10000,
        };
        const before = simulateRenderAdmission(fixture, historicalTwoCreditModel);
        const after = simulateRenderAdmission(fixture, productionAdmissionModel);
        expect(after.maxActualGpuOutstanding).toBeLessThanOrEqual(2);
        expect(after.maxGpuBacklogMs).toBeLessThanOrEqual(before.maxGpuBacklogMs);
        expect(after.offerToSimulatedGpuFinishMs.p95 ?? Infinity).toBeLessThanOrEqual(
          (before.offerToSimulatedGpuFinishMs.p95 ?? 0) + 0.000001,
        );
        expect(after.offerToSimulatedGpuFinishMs.worst ?? Infinity).toBeLessThanOrEqual(
          before.offerToSimulatedGpuFinishMs.worst ?? 0,
        );
        expect(after.finalGpuOrdinal).toBe(1000);
      }
    }
  });

  test('deadline progresses pending work when the rAF task source pauses', () => {
    const fixture: AdmissionScenario = {
      ...scenario,
      callbackDelayMs: 1,
      opportunityPause: [0, 500],
    };
    const result = simulateRenderAdmission(fixture, productionAdmissionModel);
    expect(result.unsubmittedOffers).toBe(0);
    expect(result.offerToSubmissionMs.worst ?? Infinity).toBeLessThanOrEqual(1000 / 60 + 0.000001);
  });

  test('mild sustained overload cannot ratchet the confirmation horizon toward32frames', () => {
    for (const refreshPeriodMs of [16, 1000 / 60, 1000 / 120]) {
      for (const gpuServiceMs of [
        refreshPeriodMs,
        refreshPeriodMs + 0.1,
        refreshPeriodMs + 1,
        refreshPeriodMs + 2,
        20,
      ]) {
        const fixture = {
          ...scenario,
          offerPeriodMs: refreshPeriodMs,
          offerCount: 1000,
          refreshPeriodMs,
          gpuServiceMs,
          callbackDelayMs: 0,
          observationEndMs: 40000,
        };
        const result = simulateRenderAdmission(fixture, productionAdmissionModel);
        expect(result.maxActualGpuOutstanding).toBeLessThanOrEqual(2);
        expect(result.maxGpuBacklogMs).toBeLessThanOrEqual(2 * gpuServiceMs + 0.000001);
        expect(result.finalGpuOrdinal).toBe(1000);
      }
    }
  });

  test('matrix includes all offers and explicitly separates censored outage cases', () => {
    const results = renderAdmissionMatrix();
    expect(results).toHaveLength(96);
    for (const result of results) {
      expect(result.offered).toBe(1000);
      expect(result.maxUnconfirmed).toBeLessThanOrEqual(2);
      if (result.scenario.callbackDelayMs === null) {
        expect(result.callbacks).toBe(0);
        expect(result.unsubmittedOffers).toBeGreaterThan(0);
      } else {
        expect(result.unsubmittedOffers).toBe(0);
        expect(result.gpuUncoveredOffers).toBe(0);
        expect(result.callbacks).toBe(result.submitted);
      }
    }
  });

  test('delayed observation bounds slowdown debt and exposes its recovery-rate limit', () => {
    for (const hz of [60, 120]) {
      for (const callbackDelayMs of [0, 100, 150]) {
        const fixture: AdmissionScenario = {
          ...scenario,
          offerPeriodMs: 5,
          offerCount: 1000,
          refreshPeriodMs: 1000 / hz,
          callbackDelayMs,
          gpuServiceChanges: [
            { atMs: 500, serviceMs: 50 },
            { atMs: 1500, serviceMs: 1 },
          ],
          observationEndMs: 10000,
        };
        const before = simulateRenderAdmission(fixture, historicalTwoCreditModel);
        const after = simulateRenderAdmission(fixture, productionAdmissionModel);
        expect(after.finalGpuOrdinal).toBe(1000);
        // Include every offered revision, not only the final latest state.
        expect(after.offerToSimulatedGpuFinishMs.count).toBe(1000);
        expect(after.offerToSimulatedGpuFinishMs.worst ?? Infinity).toBeLessThanOrEqual(
          (before.offerToSimulatedGpuFinishMs.worst ?? 0) + 1000 / hz,
        );
        const physicallyAvailableRate = Math.min(hz, 2000 / (callbackDelayMs + 1));
        expect(
          after.submissions.filter((frame) => frame.atMs >= 3000 && frame.atMs < 4000).length,
        ).toBeGreaterThanOrEqual(physicallyAvailableRate * 0.85);
        expect(after.maxActualGpuOutstanding).toBeLessThanOrEqual(2);
      }
    }
  });
});
