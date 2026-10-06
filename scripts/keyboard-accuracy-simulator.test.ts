import { describe, expect, test } from 'bun:test';
import {
  KEYBOARD_GESTURE_FAMILIES,
  runKeyboardAccuracySimulation,
} from './keyboard-accuracy-simulator';

describe('keyboard accuracy simulator', () => {
  test('is deterministic for a fixed seed', () => {
    const options = {
      seed: 12_345,
      samplesPerKey: 2,
      orientations: ['portrait'] as const,
      layerIds: ['alpha'],
    };
    expect(runKeyboardAccuracySimulation(options)).toEqual(runKeyboardAccuracySimulation(options));
  });

  test('drives every configured gesture through both classifiers', () => {
    const report = runKeyboardAccuracySimulation({
      seed: 99,
      samplesPerKey: 3,
      orientations: ['portrait'],
      layerIds: ['alpha'],
    });
    expect(report.samples).toBe(report.releaseKeyCount * KEYBOARD_GESTURE_FAMILIES.length * 3);
    expect(report.byFamily).toHaveLength(KEYBOARD_GESTURE_FAMILIES.length);
    expect(report.byScenario).toHaveLength(1);
    expect(report.engineCorrect).toBeGreaterThan(0);
    expect(report.hardAtlasCorrect).toBeGreaterThan(0);
    expect(report.engineAccuracy).toBeGreaterThanOrEqual(0);
    expect(report.engineAccuracy).toBeLessThanOrEqual(1);
    expect(report.hardAtlasAccuracy).toBeGreaterThanOrEqual(0);
    expect(report.hardAtlasAccuracy).toBeLessThanOrEqual(1);
    expect(report.byFamily.find((result) => result.name === 'low-bottom-row')?.rejected).toBe(0);
    expect(report.checksum).not.toBe(0);
  });

  test('rejects invalid configuration', () => {
    expect(() => runKeyboardAccuracySimulation({ seed: 0 })).toThrow(
      'seed must be a positive safe integer',
    );
    expect(() => runKeyboardAccuracySimulation({ samplesPerKey: 0 })).toThrow(
      'samplesPerKey must be a positive safe integer',
    );
    expect(() => runKeyboardAccuracySimulation({ layerIds: [] })).toThrow(
      'layerIds must contain at least one value',
    );
    expect(() => runKeyboardAccuracySimulation({ layerIds: ['missing'] })).toThrow(
      'Unknown keyboard simulation layer: missing',
    );
    expect(() => runKeyboardAccuracySimulation({ releaseWeight: 1.1 })).toThrow(
      'releaseWeight must be between zero and one',
    );
  });
});
