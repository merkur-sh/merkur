import { describe, expect, test } from 'bun:test';
import { createWakeLockAcquisitionGate } from './wake-lock-acquisition';

describe('wake lock acquisition gate', () => {
  test('latches a denial instead of retrying on ordinary input-driven calls', () => {
    const gate = createWakeLockAcquisitionGate(true);

    expect(gate.beginAcquire()).toBe(true);
    expect(gate.denied()).toBe('latched');
    expect(gate.phase).toBe('denied');

    for (let keydown = 0; keydown < 100; keydown += 1) {
      expect(gate.beginAcquire()).toBe(false);
    }
    expect(gate.phase).toBe('denied');
  });

  test('only a hidden-to-visible edge clears a denial latch', () => {
    const gate = createWakeLockAcquisitionGate(true);
    gate.beginAcquire();
    gate.denied();

    expect(gate.visibilityChanged(true)).toBe(false);
    expect(gate.beginAcquire()).toBe(false);
    expect(gate.visibilityChanged(false)).toBe(false);
    expect(gate.beginAcquire()).toBe(false);

    expect(gate.visibilityChanged(true)).toBe(true);
    expect(gate.phase).toBe('idle');
    expect(gate.beginAcquire()).toBe(true);
  });

  test('initially hidden documents become eligible on their first visible edge', () => {
    const gate = createWakeLockAcquisitionGate(false);

    expect(gate.beginAcquire()).toBe(false);
    expect(gate.visibilityChanged(true)).toBe(true);
    expect(gate.beginAcquire()).toBe(true);
  });

  test('an explicit release reacquires only while visible', () => {
    const visibleGate = createWakeLockAcquisitionGate(true);
    visibleGate.beginAcquire();
    expect(visibleGate.acquired()).toBe(true);
    expect(visibleGate.released()).toBe(true);
    expect(visibleGate.beginAcquire()).toBe(true);

    const hiddenGate = createWakeLockAcquisitionGate(true);
    hiddenGate.beginAcquire();
    hiddenGate.acquired();
    hiddenGate.visibilityChanged(false);
    expect(hiddenGate.released()).toBe(false);
    expect(hiddenGate.beginAcquire()).toBe(false);
    expect(hiddenGate.visibilityChanged(true)).toBe(true);
    expect(hiddenGate.beginAcquire()).toBe(true);
  });

  test('does not lose a lifecycle reset while a request is pending', () => {
    const gate = createWakeLockAcquisitionGate(true);
    gate.beginAcquire();

    expect(gate.visibilityChanged(false)).toBe(false);
    expect(gate.visibilityChanged(true)).toBe(false);
    expect(gate.denied()).toBe('lifecycle-reset');
    expect(gate.phase).toBe('idle');
    expect(gate.beginAcquire()).toBe(true);
  });

  test('dispose rejects late settlement and every future lifecycle edge', () => {
    const gate = createWakeLockAcquisitionGate(true);
    gate.beginAcquire();
    gate.dispose();

    expect(gate.acquired()).toBe(false);
    expect(gate.denied()).toBe('ignored');
    expect(gate.released()).toBe(false);
    expect(gate.visibilityChanged(false)).toBe(false);
    expect(gate.visibilityChanged(true)).toBe(false);
    expect(gate.beginAcquire()).toBe(false);
    expect(gate.phase).toBe('disposed');
  });
});
