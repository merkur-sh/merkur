import { describe, expect, test } from 'bun:test';

import { createSoftDeleteDedup, type SoftDeleteKeyInput } from './editing-surface';

function key(name: string, overrides: Partial<SoftDeleteKeyInput> = {}): SoftDeleteKeyInput {
  return {
    key: name,
    keyCode: name === 'Backspace' ? 8 : name === 'Delete' ? 46 : 0,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides,
  };
}

describe('createSoftDeleteDedup', () => {
  test('keydown then keyup delivers exactly once', () => {
    const dedup = createSoftDeleteDedup();
    expect(dedup.keydown(key('Backspace'))).toBe('backward');
    expect(dedup.keyup('Backspace')).toBe('backward');
    // A second keyup must not deliver again.
    expect(dedup.keyup('Backspace')).toBeNull();
  });

  test('forward delete routes as forward', () => {
    const dedup = createSoftDeleteDedup();
    expect(dedup.keydown(key('Delete'))).toBe('forward');
    expect(dedup.keyup('Delete')).toBe('forward');
  });

  test('beforeinput delete wins over a queued keydown intent', () => {
    const dedup = createSoftDeleteDedup();
    expect(dedup.keydown(key('Backspace'))).toBe('backward');
    dedup.beforeinputDelete();
    // The immediate path already deleted; keyup must not double-delete.
    expect(dedup.keyup('Backspace')).toBeNull();
  });

  test('beforeinput delete alone leaves nothing pending', () => {
    const dedup = createSoftDeleteDedup();
    dedup.beforeinputDelete();
    expect(dedup.keyup('Backspace')).toBeNull();
  });

  test('composition-owned keydowns are ignored', () => {
    const dedup = createSoftDeleteDedup();
    expect(dedup.keydown(key('Backspace', { isComposing: true }))).toBeNull();
    expect(dedup.keydown(key('Backspace', { keyCode: 229 }))).toBeNull();
    expect(dedup.keydown(key('Process'))).toBeNull();
    expect(dedup.keydown(key('Dead'))).toBeNull();
    expect(dedup.keyup('Backspace')).toBeNull();
  });

  test('control-modified keydowns are ignored, shift is allowed', () => {
    const dedup = createSoftDeleteDedup();
    expect(dedup.keydown(key('Backspace', { ctrlKey: true }))).toBeNull();
    expect(dedup.keydown(key('Backspace', { altKey: true }))).toBeNull();
    expect(dedup.keydown(key('Backspace', { metaKey: true }))).toBeNull();
    // Shift-Backspace behaves like Backspace on soft keyboards.
    expect(dedup.keydown(key('Backspace'))).toBe('backward');
  });

  test('non-delete keys never queue or deliver', () => {
    const dedup = createSoftDeleteDedup();
    expect(dedup.keydown(key('a'))).toBeNull();
    expect(dedup.keyup('a')).toBeNull();
  });

  test('clear drops a pending intent', () => {
    const dedup = createSoftDeleteDedup();
    dedup.keydown(key('Backspace'));
    dedup.clear();
    expect(dedup.keyup('Backspace')).toBeNull();
  });
});
