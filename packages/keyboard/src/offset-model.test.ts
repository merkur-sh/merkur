import { describe, expect, test } from 'bun:test';
import { CUPERTINO_PORTRAIT_PROFILE, solveKeyboardGeometry } from './geometry';
import { TERMINAL_US_LAYOUT } from './layouts/terminal-us';
import { createKeyboardOffsetModel, isKeyboardOffsetSnapshot } from './offset-model';
import { classifyKeyboardTouch, createKeyboardSpatialPrior } from './touch-model';
import type { KeyboardTouchTrace, ResolvedKeyboardGeometry } from './types';

const geometry = solveKeyboardGeometry(
  TERMINAL_US_LAYOUT,
  'alpha',
  402,
  3,
  CUPERTINO_PORTRAIT_PROFILE,
);

function keyFor(id: string, on: ResolvedKeyboardGeometry = geometry) {
  const key = on.keys.find((candidate) => candidate.definition.id === id);
  if (key === undefined) throw new Error(`missing key ${id}`);
  return key;
}

/** Deterministic normal deviates, so a failure is a real regression. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const u = Math.max(1e-12, state / 0x1_0000_0000);
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos((2 * Math.PI * state) / 0x1_0000_0000);
  };
}

function trace(
  keyId: string,
  downX: number,
  downY: number,
  on: ResolvedKeyboardGeometry = geometry,
): KeyboardTouchTrace {
  const key = keyFor(keyId, on);
  return {
    predictedKey: key.definition,
    layerId: on.layerId,
    pointerId: 1,
    downX,
    downY,
    trajectoryX: downX,
    trajectoryY: downY,
    releaseX: downX,
    releaseY: downY,
    durationMs: 80,
    sampleCount: 4,
    contactAtMs: 0,
    modelCenterX: key.rect.x + key.rect.width / 2,
    modelCenterY: key.rect.y + key.rect.height / 2,
    spatialKey: key.definition,
  };
}

/** The applied x shift of one key against the plain spatial prior, in px. */
function appliedShiftX(
  model: ReturnType<typeof createKeyboardOffsetModel>,
  keyId: string,
  on: ResolvedKeyboardGeometry = geometry,
): number {
  const base = createKeyboardSpatialPrior(on);
  const applied = model.apply(on, base);
  const key = keyFor(keyId, on);
  return (applied.centerX[key.index] ?? 0) - (base.centerX[key.index] ?? 0);
}

describe('keyboard offset model', () => {
  test('converges on a systematic bias despite learning only from the anchor', () => {
    const model = createKeyboardOffsetModel();
    const key = keyFor('key-e');
    const random = createRandom(0x4d45);
    // A leftward bias of 15% of the key width, the shape of the reported
    // "I aim at e and get w" symptom, with realistic scatter around it.
    const trueOffset = -0.15;
    const sigma = 0.2;

    for (let index = 0; index < 4_000; index += 1) {
      const x = key.rect.x + key.rect.width * (0.5 + trueOffset + random() * sigma);
      const y = key.rect.y + key.rect.height * (0.5 + random() * sigma);
      model.record(trace('key-e', x, y), geometry);
    }

    const learned = appliedShiftX(model, 'key-e') / key.rect.width;
    // Truncated learning attenuates each step, but the fixed point is the true
    // mean, so it should land close after enough taps.
    expect(learned).toBeLessThan(-0.1);
    expect(learned).toBeGreaterThan(-0.2);
  });

  test('leaves every key alone when taps are centred', () => {
    const model = createKeyboardOffsetModel();
    const key = keyFor('key-a');
    const random = createRandom(0x99);
    for (let index = 0; index < 2_000; index += 1) {
      const x = key.rect.x + key.rect.width * (0.5 + random() * 0.2);
      const y = key.rect.y + key.rect.height * (0.5 + random() * 0.2);
      model.record(trace('key-a', x, y), geometry);
    }
    // Neither the tapped key nor any untouched key may drift: centred data
    // must not let the field invent a bias for the rest of the board.
    for (const keyId of ['key-a', 'key-s', 'key-l']) {
      const learned = appliedShiftX(model, keyId) / keyFor(keyId).rect.width;
      expect(Math.abs(learned)).toBeLessThan(0.03);
    }
  });

  test('rejects taps outside the learning anchor, so a wrong commit cannot teach', () => {
    const model = createKeyboardOffsetModel();
    const key = keyFor('key-e');
    // Far off-centre: this is what a mis-committed tap looks like, and it must
    // not move the estimate — or feed the field — at all.
    const x = key.rect.x + key.rect.width * 0.95;
    const y = key.rect.y + key.rect.height / 2;
    for (let index = 0; index < 500; index += 1) {
      expect(model.record(trace('key-e', x, y), geometry)).toBe(false);
    }
    expect(model.learnedKeyCount()).toBe(0);
    expect(model.fieldSampleCount()).toBe(0);
  });

  test('never moves a key centre past half a pitch, whatever the data says', () => {
    const model = createKeyboardOffsetModel();
    const key = keyFor('key-e');
    const random = createRandom(0x1234);
    // A bias far larger than the clamp allows.
    for (let index = 0; index < 20_000; index += 1) {
      const x = key.rect.x + key.rect.width * (0.5 + 0.3 + random() * 0.05);
      const y = key.rect.y + key.rect.height * (0.5 + random() * 0.05);
      model.record(trace('key-e', x, y), geometry);
    }
    const learned = appliedShiftX(model, 'key-e');
    // Half a key pitch, field and residual combined. Beyond it the model
    // centre would sit closer to a neighbour's visible position than its own.
    expect(learned).toBeLessThanOrEqual((geometry.width / 10) * 0.5 + 1e-6);
  });

  test('a tap on a key centre still types that key at maximum offset', () => {
    // This is what allows the bound above to be geometric rather than timid: the
    // decoder anchors on the VISIBLE key unconditionally, so however far a
    // learned model drifts, what the user sees is what they get.
    const model = createKeyboardOffsetModel();
    const key = keyFor('key-e');
    const random = createRandom(0x2024);
    for (let index = 0; index < 20_000; index += 1) {
      const x = key.rect.x + key.rect.width * (0.5 + 0.45 + random() * 0.02);
      const y = key.rect.y + key.rect.height * (0.5 + random() * 0.02);
      model.record(trace('key-e', x, y), geometry);
    }
    const personalised = model.apply(geometry, createKeyboardSpatialPrior(geometry));
    const centre = {
      x: key.rect.x + key.rect.width / 2,
      y: key.rect.y + key.rect.height / 2,
    };
    const decided = classifyKeyboardTouch(
      geometry,
      personalised,
      centre.x,
      centre.y,
      centre.x,
      centre.y,
      centre.x,
      centre.y,
      0,
      null,
      0,
    );
    expect(geometry.keys[decided ?? -1]?.definition.id).toBe('key-e');
  });

  test('approaches a bias with a bounded, decaying transient', () => {
    // Zero-noise taps at a constant offset. The field and the residual fit
    // decoupled targets, so the residual briefly fits what the still-moving
    // field later absorbs: a transient overshoot is expected, but it must stay
    // small — measured at +12.6% of the bias at its peak — and decay toward
    // the truth rather than oscillate or grow.
    const model = createKeyboardOffsetModel();
    const key = keyFor('key-e');
    const target = 0.2 * key.rect.width;
    const x = key.rect.x + key.rect.width * 0.7;
    const y = key.rect.y + key.rect.height / 2;
    for (let index = 0; index < 400; index += 1) {
      model.record(trace('key-e', x, y), geometry);
      const shift = appliedShiftX(model, 'key-e');
      expect(shift).toBeGreaterThanOrEqual(-1e-9);
      expect(shift).toBeLessThanOrEqual(target * 1.2);
    }
    const settled = appliedShiftX(model, 'key-e');
    expect(settled).toBeGreaterThan(target * 0.95);
    expect(settled).toBeLessThan(target * 1.1);
  });

  test('corrects a key the learner has never seen, through the field', () => {
    const model = createKeyboardOffsetModel();
    const random = createRandom(0xf1e1d);
    // A shared rightward bias of 0.15 pitches, expressed on left and middle
    // keys only. The cold-start claim is that `key-p` — untouched — inherits
    // the correction from the pooled field.
    const biasPx = 0.15 * (geometry.width / 10);
    const trained = ['key-q', 'key-w', 'key-e', 'key-a', 'key-s', 'key-d', 'key-z', 'key-x'];
    for (let index = 0; index < 1_600; index += 1) {
      const keyId = trained[index % trained.length] ?? 'key-e';
      const key = keyFor(keyId);
      const x = key.rect.x + key.rect.width / 2 + biasPx + random() * 0.15 * key.rect.width;
      const y = key.rect.y + key.rect.height * (0.5 + random() * 0.15);
      model.record(trace(keyId, x, y), geometry);
    }
    const untouched = appliedShiftX(model, 'key-p');
    expect(untouched).toBeGreaterThan(biasPx * 0.5);
    expect(untouched).toBeLessThanOrEqual(biasPx * 1.5);
  });

  test('learns no x field from a wide key', () => {
    const model = createKeyboardOffsetModel();
    const space = keyFor('space');
    const random = createRandom(0x5ace);
    // Scatter across the space bar's width is key geometry, not grip; it must
    // not bend the shared field sideways.
    for (let index = 0; index < 2_000; index += 1) {
      const x = space.rect.x + space.rect.width * (0.5 + 0.25 + random() * 0.05);
      const y = space.rect.y + space.rect.height / 2;
      model.record(trace('space', x, y), geometry);
    }
    expect([...model.snapshot().field.thetaX]).toEqual([0, 0, 0]);
    expect(appliedShiftX(model, 'key-e')).toBeCloseTo(0, 9);
  });

  test('round-trips through a snapshot, field included', () => {
    const model = createKeyboardOffsetModel();
    const key = keyFor('key-s');
    const random = createRandom(0x77);
    for (let index = 0; index < 1_000; index += 1) {
      const x = key.rect.x + key.rect.width * (0.5 - 0.1 + random() * 0.15);
      const y = key.rect.y + key.rect.height * (0.5 + random() * 0.15);
      model.record(trace('key-s', x, y), geometry);
    }
    const restored = createKeyboardOffsetModel();
    restored.restore(model.snapshot());
    // The trained key carries field plus residual; the untrained one is pure
    // field. Both must survive persistence exactly.
    for (const keyId of ['key-s', 'key-p']) {
      expect(appliedShiftX(restored, keyId)).toBeCloseTo(appliedShiftX(model, keyId), 9);
    }
    expect(restored.fieldSampleCount()).toBe(model.fieldSampleCount());
  });

  test('rescales with the geometry it is applied to', () => {
    const model = createKeyboardOffsetModel();
    const random = createRandom(0xd1);
    const biasPx = 0.15 * (geometry.width / 10);
    for (let index = 0; index < 1_600; index += 1) {
      const keyId = ['key-q', 'key-e', 'key-s', 'key-c'][index % 4] ?? 'key-e';
      const key = keyFor(keyId);
      const x = key.rect.x + key.rect.width / 2 + biasPx + random() * 0.1 * key.rect.width;
      const y = key.rect.y + key.rect.height / 2;
      model.record(trace(keyId, x, y), geometry);
    }
    const wider = solveKeyboardGeometry(TERMINAL_US_LAYOUT, 'alpha', 500, 3, {
      ...CUPERTINO_PORTRAIT_PROFILE,
    });
    const narrow = appliedShiftX(model, 'key-p');
    const wide = appliedShiftX(model, 'key-p', wider);
    // Pitch units, not pixels: the same learned grip stretches with the board.
    expect(wide / narrow).toBeCloseTo(500 / 402, 1);
  });

  test('a fresh model applies as the identity', () => {
    const model = createKeyboardOffsetModel();
    const base = createKeyboardSpatialPrior(geometry);
    expect(model.apply(geometry, base)).toBe(base);
  });

  test('shares the grip field across layers, never the per-key residuals', () => {
    const model = createKeyboardOffsetModel();
    const key = keyFor('key-e');
    const random = createRandom(0x1a7e5);
    for (let index = 0; index < 1_000; index += 1) {
      const x = key.rect.x + key.rect.width * (0.4 + random() * 0.1);
      const y = key.rect.y + key.rect.height * (0.5 + random() * 0.1);
      model.record(trace('key-e', x, y), geometry);
    }

    const numbers = solveKeyboardGeometry(
      TERMINAL_US_LAYOUT,
      'numbers',
      402,
      3,
      CUPERTINO_PORTRAIT_PROFILE,
    );
    const sibling = numbers.keys.find(
      (candidate) =>
        Math.abs(candidate.rect.x - key.rect.x) < 1 && Math.abs(candidate.rect.y - key.rect.y) < 1,
    );
    if (sibling === undefined) throw new Error('no numbers-layer key shares key-e position');

    // Grip is a property of hand and board: the field learned on alpha must
    // reach the numbers layer...
    const siblingShift = appliedShiftX(model, sibling.definition.id, numbers);
    expect(siblingShift).toBeLessThan(-0.5);

    // ...but the per-key residual must not. The sibling's shift is exactly the
    // field's prediction: the alpha shift minus alpha's own residual.
    const entry = model
      .snapshot()
      .keys.find((candidate) => candidate.layerId === 'alpha' && candidate.keyId === 'key-e');
    if (entry === undefined) throw new Error('no learned entry for key-e');
    const residualPx = entry.x * key.rect.width;
    expect(siblingShift).toBeCloseTo(appliedShiftX(model, 'key-e') - residualPx, 6);
  });

  test('a corrected tap trains the meant key from outside every window', () => {
    const model = createKeyboardOffsetModel();
    const e = keyFor('key-e');
    // Between 'w' and 'e', outside both keys' learning windows: as the
    // decoder's own guess, a 'w', it teaches nothing.
    const x = e.rect.x + e.rect.width * (0.5 - 0.55);
    const y = e.rect.y + e.rect.height / 2;
    expect(model.record(trace('key-w', x, y), geometry)).toBe(false);
    expect(model.learnedKeyCount()).toBe(0);
    // The user retyped 'e' in its place, which names the key.
    expect(model.recordCorrection(trace('key-w', x, y), geometry, 'key-e')).toBe(true);
    expect(appliedShiftX(model, 'key-e')).toBeLessThan(0);
    // Still bounded by the same clamps as any other evidence.
    for (let index = 0; index < 200; index += 1) {
      model.recordCorrection(trace('key-w', x, y), geometry, 'key-e');
    }
    expect(Math.abs(appliedShiftX(model, 'key-e'))).toBeLessThanOrEqual(geometry.width / 10 / 2);
  });

  test('accepts only the current snapshot shape', () => {
    const model = createKeyboardOffsetModel();
    model.record(
      trace(
        'key-e',
        keyFor('key-e').rect.x + keyFor('key-e').rect.width * 0.55,
        keyFor('key-e').rect.y + keyFor('key-e').rect.height / 2,
      ),
      geometry,
    );
    const snapshot = model.snapshot();
    expect(isKeyboardOffsetSnapshot(snapshot)).toBe(true);
    // The pre-field shape has no field block; it is discarded, not migrated.
    expect(isKeyboardOffsetSnapshot({ keys: snapshot.keys })).toBe(false);
    expect(
      isKeyboardOffsetSnapshot({
        field: { ...snapshot.field, px: snapshot.field.px.slice(0, 8) },
        keys: snapshot.keys,
      }),
    ).toBe(false);
    expect(
      isKeyboardOffsetSnapshot({
        field: { ...snapshot.field, thetaX: [Number.NaN, 0, 0] },
        keys: snapshot.keys,
      }),
    ).toBe(false);
  });
});
