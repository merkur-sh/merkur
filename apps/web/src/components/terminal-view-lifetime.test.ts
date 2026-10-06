import { describe, expect, test } from 'bun:test';

import { reconcileTerminalView } from './terminal-view-lifetime';

/**
 * The rule that decides whether a terminal panel is replaced, frozen for its
 * exit, or dropped. Every branch here is a real sequence the app produces, and
 * two of them were the bugs: leaving the terminal dropped the panel in the same
 * flush as the route change, so the layer animated an empty box; and a session
 * ending on the terminal route must NOT freeze, or the status the user needs to
 * read is replaced by a picture of the terminal that just died.
 */
describe('reconcileTerminalView', () => {
  test('a new ring bundle always replaces, whatever the layer is doing', () => {
    for (const active of [true, false]) {
      for (const showing of [true, false]) {
        expect(reconcileTerminalView({ hasRings: true, active, showing })).toBe('replace');
      }
    }
  });

  test('leaving the terminal retires the panel so it can be animated out', () => {
    // `onBack`: the rings and the route drop in one flush, and the layer is
    // still on screen for the length of its exit.
    expect(reconcileTerminalView({ hasRings: false, active: false, showing: true })).toBe('retire');
  });

  test('a session ending on the terminal route clears rather than freezing', () => {
    // A fatal worker or a refused reconnect. There is no exit to wait for, and
    // the status overlay has something to say.
    expect(reconcileTerminalView({ hasRings: false, active: true, showing: true })).toBe('clear');
  });

  test('a session that never reached the screen clears', () => {
    // The rings are published a frame before the route is pushed, so a connect
    // that fails in between has a panel the user never saw. Retaining it would
    // strand it: the layer is already hidden and will never report leaving.
    expect(reconcileTerminalView({ hasRings: false, active: false, showing: false })).toBe('clear');
    expect(reconcileTerminalView({ hasRings: false, active: true, showing: false })).toBe('clear');
  });
});
