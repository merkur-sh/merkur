import { describe, expect, test } from 'bun:test';
import {
  CUPERTINO_PORTRAIT_PROFILE,
  type KeyboardTouchTrace,
  type ResolvedKeyboardGeometry,
  solveKeyboardGeometry,
} from '@merkur/keyboard';
import { TERMINAL_US_LAYOUT } from '@merkur/keyboard/layouts/terminal-us';
import { createKeyboardDiagnostics, formatKeyboardDiagnostics } from './keyboard-diagnostics';

const geometry = solveKeyboardGeometry(
  TERMINAL_US_LAYOUT,
  'alpha',
  402,
  3,
  CUPERTINO_PORTRAIT_PROFILE,
);

function keyFor(id: string) {
  const key = geometry.keys.find((candidate) => candidate.definition.id === id);
  if (key === undefined) throw new Error(`missing key ${id}`);
  return key;
}

function trace(
  keyId: string,
  offsetX: number,
  offsetY: number,
  driftX = 0,
  overrides: Partial<KeyboardTouchTrace> = {},
): KeyboardTouchTrace {
  const key = keyFor(keyId);
  const downX = key.rect.x + key.rect.width / 2 + offsetX;
  const downY = key.rect.y + key.rect.height / 2 + offsetY;
  return {
    predictedKey: key.definition,
    layerId: 'alpha',
    pointerId: 1,
    downX,
    downY,
    trajectoryX: downX,
    trajectoryY: downY,
    releaseX: downX + driftX,
    releaseY: downY,
    durationMs: 80,
    sampleCount: 4,
    contactAtMs: 0,
    modelCenterX: key.rect.x + key.rect.width / 2,
    modelCenterY: key.rect.y + key.rect.height / 2,
    spatialKey: key.definition,
    ...overrides,
  };
}

describe('keyboard diagnostics', () => {
  test('recovers the mean landing offset it was given', () => {
    const diagnostics = createKeyboardDiagnostics();
    // Offsets averaging exactly -6px horizontally, the shape of a leftward bias.
    for (const offset of [-8, -4, -7, -5]) {
      diagnostics.record(trace('key-e', offset, 2), geometry);
    }
    const summary = diagnostics.summary(CUPERTINO_PORTRAIT_PROFILE.tapDrift);
    const entry = summary.keys.find((candidate) => candidate.keyId === 'key-e');
    expect(entry).toBeDefined();
    expect(entry?.count).toBe(4);
    expect(entry?.offsetX).toBeCloseTo(-6, 6);
    expect(entry?.offsetY).toBeCloseTo(2, 6);
    // Spread about that mean, not about the key centre.
    expect(entry?.sigmaX).toBeCloseTo(Math.sqrt(2.5), 6);
  });

  test('counts taps that travel past the drift threshold', () => {
    const diagnostics = createKeyboardDiagnostics();
    diagnostics.record(trace('key-a', 0, 0, 2), geometry);
    diagnostics.record(trace('key-a', 0, 0, 5), geometry);
    diagnostics.record(trace('key-a', 0, 0, 20), geometry);
    diagnostics.record(trace('key-a', 0, 0, 30), geometry);
    const summary = diagnostics.summary(12);
    expect(summary.taps).toBe(4);
    expect(summary.overDriftThreshold).toBeCloseTo(0.5, 6);
    // Re-asking with a different threshold must recount, not reuse the first.
    expect(diagnostics.summary(25).overDriftThreshold).toBeCloseTo(0.25, 6);
  });

  test('separates uncommitted contacts from taps', () => {
    const diagnostics = createKeyboardDiagnostics();
    diagnostics.record({ ...trace('key-a', 0, 0), predictedKey: null }, geometry);
    diagnostics.record(trace('key-a', 0, 0), geometry);
    const summary = diagnostics.summary(12);
    expect(summary.taps).toBe(1);
    expect(summary.uncommitted).toBe(1);
  });

  test('reports taps that produced no movement samples', () => {
    const diagnostics = createKeyboardDiagnostics();
    // The engine records a sample at touch-down and at release unconditionally,
    // so a tap with no `pointermove` in between reports 2, never 0. Counting
    // zeroes would report 0% forever.
    diagnostics.record(trace('key-a', 0, 0, 0, { sampleCount: 2 }), geometry);
    diagnostics.record(trace('key-a', 0, 0, 0, { sampleCount: 6 }), geometry);
    expect(diagnostics.summary(12).movementFreeFraction).toBeCloseTo(0.5, 6);
  });

  test('flags a saturated sample count as a floor rather than a measurement', () => {
    const diagnostics = createKeyboardDiagnostics();
    diagnostics.record(trace('key-a', 0, 0, 0, { sampleCount: 6 }), geometry);
    expect(diagnostics.summary(12).sampleCountSaturated).toBe(false);
    // The engine clamps `sampleCount` to its trajectory ring, so the top bucket
    // means "at least this many", and the percentiles stop being a measurement.
    diagnostics.record(trace('key-a', 0, 0, 0, { sampleCount: 64 }), geometry);
    expect(diagnostics.summary(12).sampleCountSaturated).toBe(true);
  });

  test('keeps no keystroke sequence in its serialised state', () => {
    const diagnostics = createKeyboardDiagnostics();
    for (const keyId of ['key-t', 'key-h', 'key-e', 'key-t', 'key-h']) {
      diagnostics.record(trace(keyId, 1, 1), geometry);
    }
    const snapshot = diagnostics.snapshot();
    // Counts survive; order does not exist anywhere in the retained state.
    const counts = new Map(snapshot.keys.map((entry) => [entry.keyId, entry.count]));
    expect(counts.get('key-t')).toBe(2);
    expect(counts.get('key-h')).toBe(2);
    expect(counts.get('key-e')).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('the');
  });

  test('round-trips through a snapshot', () => {
    const diagnostics = createKeyboardDiagnostics();
    diagnostics.record(trace('key-e', -6, 2, 14), geometry);
    diagnostics.record(trace('key-e', -4, 1, 3), geometry);
    const before = diagnostics.summary(12);

    const restored = createKeyboardDiagnostics();
    restored.restore(diagnostics.snapshot());
    const after = restored.summary(12);

    expect(after.taps).toBe(before.taps);
    expect(after.overDriftThreshold).toBeCloseTo(before.overDriftThreshold, 6);
    expect(after.keys[0]?.offsetX).toBeCloseTo(before.keys[0]?.offsetX ?? Number.NaN, 6);
  });

  test('ignores traces from a layer the geometry no longer describes', () => {
    const diagnostics = createKeyboardDiagnostics();
    diagnostics.record({ ...trace('key-e', -6, 0), layerId: 'numbers' }, geometry);
    const summary = diagnostics.summary(12);
    // The tap still counts toward the drift and duration histograms; only the
    // per-key offset is dropped, because the key rect cannot be resolved.
    expect(summary.taps).toBe(1);
    expect(summary.keys).toHaveLength(0);
  });
});

describe('typing speed', () => {
  test('measures the gap between consecutive taps', () => {
    const diagnostics = createKeyboardDiagnostics();
    for (const contactAtMs of [0, 200, 400, 600]) {
      diagnostics.record(trace('key-a', 0, 0, 0, { contactAtMs }), geometry);
    }
    // Three gaps of 200ms; the first tap has no predecessor to measure against.
    expect(diagnostics.summary(12).interTapMs.mean).toBeCloseTo(200, 0);
  });

  test('separates contact travel when typing fast from when typing slow', () => {
    const diagnostics = createKeyboardDiagnostics();
    let now = 0;
    // Fast run: 100ms apart, drifting 10px.
    for (let index = 0; index < 10; index += 1) {
      now += 100;
      diagnostics.record(trace('key-a', 0, 0, 10, { contactAtMs: now }), geometry);
    }
    // Slow run: 500ms apart, drifting 2px.
    for (let index = 0; index < 10; index += 1) {
      now += 500;
      diagnostics.record(trace('key-a', 0, 0, 2, { contactAtMs: now }), geometry);
    }
    const summary = diagnostics.summary(12);
    // This is the correlation the whole "worse when I type fast" question turns
    // on, and it was unmeasurable before the trace carried a timestamp.
    expect(summary.driftWhenFast).toBeCloseTo(10, 1);
    expect(summary.driftWhenSlow).toBeCloseTo(2, 1);
  });

  test('does not count a gap across a reset as an interval', () => {
    const diagnostics = createKeyboardDiagnostics();
    diagnostics.record(trace('key-a', 0, 0, 0, { contactAtMs: 1_000 }), geometry);
    diagnostics.reset();
    diagnostics.record(trace('key-a', 0, 0, 0, { contactAtMs: 9_000 }), geometry);
    expect(diagnostics.summary(12).interTapMs.mean).toBe(0);
  });

  test('reports an uncensored sample count', () => {
    const diagnostics = createKeyboardDiagnostics();
    // The engine's trajectory ring holds eight, but the trace now reports every
    // sample the contact produced, which is what distinguishes 120Hz from 240Hz.
    diagnostics.record(trace('key-a', 0, 0, 0, { sampleCount: 30 }), geometry);
    expect(diagnostics.summary(12).sampleCount.max).toBeGreaterThanOrEqual(30);
  });
});

describe('learned-centre residual', () => {
  test('measures the landing point from the centre the engine scored against', () => {
    const diagnostics = createKeyboardDiagnostics();
    const key = keyFor('key-o');
    const learnedX = key.rect.x + key.rect.width / 2 - 3;
    const learnedY = key.rect.y + key.rect.height / 2 + 8;
    for (const offsetY of [7, 9, 11]) {
      diagnostics.record(
        trace('key-o', -4, offsetY, 0, { modelCenterX: learnedX, modelCenterY: learnedY }),
        geometry,
      );
    }
    const summary = diagnostics.summary(12);
    const entry = summary.keys.find((candidate) => candidate.keyId === 'key-o');
    // The drawn-centre offset keeps the user's bias; the residual is what the
    // learned centre failed to absorb.
    expect(entry?.offsetX).toBeCloseTo(-4, 6);
    expect(entry?.offsetY).toBeCloseTo(9, 6);
    expect(entry?.residualX).toBeCloseTo(-1, 6);
    expect(entry?.residualY).toBeCloseTo(1, 6);
    expect(summary.pooledBiasPx).toBeCloseTo(Math.hypot(4, 9), 6);
    expect(summary.pooledResidualBiasPx).toBeCloseTo(Math.SQRT2, 6);
  });
});

describe('corrections', () => {
  const backspace = keyFor('backspace').definition;
  const enter = geometry.keys.find((key) => key.definition.value === 'Enter')?.definition;
  if (enter === undefined) throw new Error('missing Enter key');
  let pointer = 10;
  type Diagnostics = ReturnType<typeof createKeyboardDiagnostics>;

  /** A release-decided tap: the trace arrives, then its commit. */
  function type(
    diagnostics: Diagnostics,
    keyId: string,
    offsetX = 0,
    driftX = 0,
    overrides: Partial<KeyboardTouchTrace> = {},
  ): void {
    pointer += 1;
    diagnostics.record(
      trace(keyId, offsetX, 0, driftX, { pointerId: pointer, ...overrides }),
      geometry,
    );
    diagnostics.recordCommit(keyFor(keyId).definition, pointer, false);
  }

  function erase(diagnostics: Diagnostics, repeat = false): void {
    pointer += 1;
    diagnostics.recordCommit(backspace, pointer, repeat);
  }

  function entryFor(diagnostics: Diagnostics, keyId: string) {
    return diagnostics.summary(12).keys.find((candidate) => candidate.keyId === keyId);
  }

  test('counts nothing until the line finishes', () => {
    const diagnostics = createKeyboardDiagnostics();
    // Landed toward 'w', read as 'e', erased, retyped as 'w'.
    type(diagnostics, 'key-e', -14);
    erase(diagnostics);
    type(diagnostics, 'key-w');
    expect(diagnostics.summary(12).misses).toBe(0);
    expect(diagnostics.recordCommit(enter, -1, false)).toBe(true);
    const summary = diagnostics.summary(12);
    expect(summary.lines).toBe(1);
    expect(summary.typedTaps).toBe(2);
    expect(summary.misses).toBe(1);
    // The miss is the meant key's; the key that committed took it.
    expect(entryFor(diagnostics, 'key-w')?.missed).toBe(1);
    expect(entryFor(diagnostics, 'key-w')?.aimed).toBe(2);
    expect(entryFor(diagnostics, 'key-e')?.took).toBe(1);
  });

  test('finds a mistake noticed letters later, and the right letters erased with it', () => {
    const diagnostics = createKeyboardDiagnostics();
    // "wat" meant, "eat" typed; the slip is seen only after "at".
    type(diagnostics, 'key-e', -14);
    type(diagnostics, 'key-a');
    type(diagnostics, 'key-t');
    erase(diagnostics);
    erase(diagnostics);
    erase(diagnostics);
    type(diagnostics, 'key-w');
    type(diagnostics, 'key-a');
    type(diagnostics, 'key-t');
    diagnostics.recordBreak();
    const summary = diagnostics.summary(12);
    expect(summary.misses).toBe(1);
    expect(summary.erasedCorrect).toBe(2);
    expect(entryFor(diagnostics, 'key-a')?.erasedCorrect).toBe(1);
    expect(summary.noticedAfter[2]).toBe(1);
  });

  test('counts a replacement far from the tap as a change of mind', () => {
    const diagnostics = createKeyboardDiagnostics();
    type(diagnostics, 'key-e');
    erase(diagnostics);
    type(diagnostics, 'key-p');
    diagnostics.recordBreak();
    expect(diagnostics.summary(12).misses).toBe(0);
    expect(entryFor(diagnostics, 'key-e')?.replaced).toBe(1);
  });

  test('counts a retype of the same key as a right letter erased', () => {
    const diagnostics = createKeyboardDiagnostics();
    type(diagnostics, 'key-e');
    erase(diagnostics);
    type(diagnostics, 'key-e');
    diagnostics.recordBreak();
    expect(diagnostics.summary(12).misses).toBe(0);
    expect(entryFor(diagnostics, 'key-e')?.erasedCorrect).toBe(1);
  });

  test('a held Backspace deletes one character per repeat', () => {
    const diagnostics = createKeyboardDiagnostics();
    type(diagnostics, 'key-e', -14);
    type(diagnostics, 'key-a');
    erase(diagnostics);
    erase(diagnostics, true);
    type(diagnostics, 'key-w');
    type(diagnostics, 'key-a');
    diagnostics.recordBreak();
    expect(diagnostics.summary(12).misses).toBe(1);
  });

  test('a break ends the line, so a later Backspace erases text it never saw', () => {
    const diagnostics = createKeyboardDiagnostics();
    type(diagnostics, 'key-e', -14);
    expect(diagnostics.recordBreak()).toBe(true);
    erase(diagnostics);
    type(diagnostics, 'key-w');
    diagnostics.recordBreak();
    const summary = diagnostics.summary(12);
    expect(summary.lines).toBe(2);
    expect(summary.misses).toBe(0);
    // Nothing is open after a line closes, so a second break has nothing to do.
    expect(diagnostics.recordBreak()).toBe(false);
  });

  test('pairs an anchored tap whose trace arrives after its commit', () => {
    const diagnostics = createKeyboardDiagnostics();
    pointer += 1;
    diagnostics.recordCommit(keyFor('key-e').definition, pointer, false);
    diagnostics.record(trace('key-e', -14, 0, 0, { pointerId: pointer }), geometry);
    erase(diagnostics);
    type(diagnostics, 'key-w');
    diagnostics.recordBreak();
    expect(diagnostics.summary(12).misses).toBe(1);
  });

  test('pairs a release trace across an older contact committing first', () => {
    const diagnostics = createKeyboardDiagnostics();
    // Contact 20 is still down on 'a' when contact 21 lifts: 21 traces, the
    // lift resolves 20 (its commit comes first), then 21 commits, and 20's
    // trace arrives at its own lift.
    diagnostics.record(trace('key-e', -14, 0, 0, { pointerId: 21 }), geometry);
    diagnostics.recordCommit(keyFor('key-a').definition, 20, false);
    diagnostics.recordCommit(keyFor('key-e').definition, 21, false);
    diagnostics.record(trace('key-a', 0, 0, 0, { pointerId: 20 }), geometry);
    erase(diagnostics);
    type(diagnostics, 'key-w');
    diagnostics.recordBreak();
    const summary = diagnostics.summary(12);
    expect(summary.typedTaps).toBe(3);
    expect(summary.misses).toBe(1);
  });

  test('blames the prior when the touch alone had chosen the meant key', () => {
    const diagnostics = createKeyboardDiagnostics();
    const w = keyFor('key-w').definition;
    const s = keyFor('key-s').definition;
    // The touch scored 'w', the next-letter prior committed 'e', the user
    // corrected it back.
    type(diagnostics, 'key-e', -14, 0, { spatialKey: w });
    erase(diagnostics);
    type(diagnostics, 'key-w');
    // An override the user kept.
    type(diagnostics, 'key-a', 14, 0, { spatialKey: s });
    diagnostics.recordBreak();
    const summary = diagnostics.summary(12);
    expect(summary.misses).toBe(1);
    expect(summary.missesByPrior).toBe(1);
    expect(summary.priorOverrides).toBe(2);
    expect(summary.priorOverridesKept).toBe(1);
  });

  test('hands each miss to the learner with the key that was meant', () => {
    const corrections: { keyId: string; downX: number; layerId: string }[] = [];
    const diagnostics = createKeyboardDiagnostics({
      onCorrection: (tap, on: ResolvedKeyboardGeometry, keyId) => {
        corrections.push({ keyId, downX: tap.downX, layerId: on.layerId });
      },
    });
    type(diagnostics, 'key-e', -14);
    type(diagnostics, 'key-a');
    erase(diagnostics);
    erase(diagnostics);
    type(diagnostics, 'key-w');
    type(diagnostics, 'key-a');
    diagnostics.recordBreak();
    const e = keyFor('key-e');
    expect(corrections).toEqual([
      { keyId: 'key-w', downX: e.rect.x + e.rect.width / 2 - 14, layerId: 'alpha' },
    ]);
  });

  test('splits the miss rate at the drift threshold', () => {
    const diagnostics = createKeyboardDiagnostics();
    // Four taps under 12px of travel, one missed; two over it, one missed.
    type(diagnostics, 'key-e', -14, 2);
    erase(diagnostics);
    type(diagnostics, 'key-w');
    type(diagnostics, 'key-a');
    type(diagnostics, 'key-s');
    type(diagnostics, 'key-e', -14, 20);
    erase(diagnostics);
    type(diagnostics, 'key-w', 0, 20);
    diagnostics.recordBreak();
    const summary = diagnostics.summary(12);
    expect(summary.typedTaps).toBe(6);
    expect(summary.missRateUnderDrift).toBeCloseTo(1 / 4, 6);
    expect(summary.missRateOverDrift).toBeCloseTo(1 / 2, 6);
    // The split is recounted against whatever threshold is asked for.
    expect(diagnostics.summary(30).missRateOverDrift).toBe(0);
  });

  test('round-trips correction counts through a snapshot', () => {
    const diagnostics = createKeyboardDiagnostics();
    type(diagnostics, 'key-e', -14, 20);
    erase(diagnostics);
    type(diagnostics, 'key-w');
    diagnostics.recordBreak();
    const restored = createKeyboardDiagnostics();
    restored.restore(diagnostics.snapshot());
    const summary = restored.summary(12);
    expect(summary.misses).toBe(1);
    expect(summary.missRateOverDrift).toBeCloseTo(1, 6);
    expect(summary.noticedAfter[0]).toBe(1);
    expect(formatKeyboardDiagnostics(summary)).toContain(
      'alpha/key-w          aimed=   2  missed   1 ( 50.0%)  took   0 from neighbours',
    );
  });

  test('lists missed keys by rate, not by how often they were typed', () => {
    const diagnostics = createKeyboardDiagnostics();
    // 'w': five aimed (the miss, its retype, three more), one missed (20%).
    // 'i': three aimed, one missed (33.3%).
    type(diagnostics, 'key-e', -14);
    erase(diagnostics);
    type(diagnostics, 'key-w');
    for (let index = 0; index < 3; index += 1) type(diagnostics, 'key-w');
    type(diagnostics, 'key-o', -14);
    erase(diagnostics);
    type(diagnostics, 'key-i');
    type(diagnostics, 'key-i');
    diagnostics.recordBreak();
    const text = formatKeyboardDiagnostics(diagnostics.summary(12));
    const table = text.slice(text.indexOf('per-key misses'));
    expect(table).toContain('missed   1 ( 20.0%)');
    expect(table.indexOf('key-i')).toBeLessThan(table.indexOf('key-w'));
    // A key that neither missed nor took a tap has no row.
    expect(table).not.toContain('key-a');
  });
});
