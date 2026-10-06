import { describe, expect, test } from 'bun:test';
import {
  createPredictionAdmissionBuffer,
  createPredictionAdmissionCoordinator,
  createPredictionAdmissionReader,
  createPredictionAdmissionResolver,
  PREDICTION_ADMISSION_ACCEPTED,
  PREDICTION_ADMISSION_REJECTED,
} from './prediction-admission';

describe('prediction admission ledger', () => {
  test('a published verdict is readable immediately, with no undecided state', () => {
    const sab = createPredictionAdmissionBuffer();
    const coordinator = createPredictionAdmissionCoordinator(sab);
    const reader = createPredictionAdmissionReader(sab);

    coordinator.beginLineage();
    expect(coordinator.publish(7, true)).toBe(true);
    expect(reader.status(7)).toBe(PREDICTION_ADMISSION_ACCEPTED);

    expect(coordinator.publish(8, false)).toBe(false);
    expect(reader.status(8)).toBe(PREDICTION_ADMISSION_REJECTED);
    expect(reader.status(9)).toBe(PREDICTION_ADMISSION_REJECTED);
  });

  test('refuses to grant provenance before a lineage exists', () => {
    const sab = createPredictionAdmissionBuffer();
    const coordinator = createPredictionAdmissionCoordinator(sab);
    const reader = createPredictionAdmissionReader(sab);

    expect(coordinator.publish(1, true)).toBe(false);
    expect(reader.status(1)).toBe(PREDICTION_ADMISSION_REJECTED);
  });

  test('a reconnect invalidates every grant from the previous lineage', () => {
    const sab = createPredictionAdmissionBuffer();
    const coordinator = createPredictionAdmissionCoordinator(sab);
    const reader = createPredictionAdmissionReader(sab);

    coordinator.beginLineage();
    coordinator.publish(1, true);
    expect(reader.status(1)).toBe(PREDICTION_ADMISSION_ACCEPTED);

    coordinator.beginLineage();
    expect(reader.status(1)).toBe(PREDICTION_ADMISSION_REJECTED);

    coordinator.publish(2, true);
    expect(reader.status(2)).toBe(PREDICTION_ADMISSION_ACCEPTED);
  });

  test('the model may downgrade an accepted grant, and only a downgrade reports true', () => {
    const sab = createPredictionAdmissionBuffer();
    const coordinator = createPredictionAdmissionCoordinator(sab);
    const resolver = createPredictionAdmissionResolver(sab);
    const reader = createPredictionAdmissionReader(sab);

    coordinator.beginLineage();
    coordinator.publish(10, true);
    // The one signal the worker reports as admission divergence.
    expect(resolver.reject(10)).toBe(true);
    expect(reader.status(10)).toBe(PREDICTION_ADMISSION_REJECTED);
    expect(resolver.reject(10)).toBe(false);

    coordinator.publish(11, false);
    expect(resolver.reject(11)).toBe(false);
    expect(reader.status(11)).toBe(PREDICTION_ADMISSION_REJECTED);
  });

  test('never upgrades: a rejected slot stays rejected for its whole lifetime', () => {
    const sab = createPredictionAdmissionBuffer();
    const coordinator = createPredictionAdmissionCoordinator(sab);
    const resolver = createPredictionAdmissionResolver(sab);
    const reader = createPredictionAdmissionReader(sab);

    coordinator.beginLineage();
    coordinator.publish(20, false);
    resolver.reject(20);
    expect(reader.status(20)).toBe(PREDICTION_ADMISSION_REJECTED);
  });

  test('a wrapped modulo slot never inherits the previous occupant verdict', () => {
    const sab = createPredictionAdmissionBuffer();
    const coordinator = createPredictionAdmissionCoordinator(sab);
    const reader = createPredictionAdmissionReader(sab);

    coordinator.beginLineage();
    coordinator.publish(1, true);
    // 4096 slots, so this lands on the same slot as sequence 1.
    coordinator.publish(4_097, false);
    expect(reader.status(4_097)).toBe(PREDICTION_ADMISSION_REJECTED);
    expect(reader.status(1)).toBe(PREDICTION_ADMISSION_REJECTED);
  });
});
