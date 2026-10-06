import { describe, expect, test } from 'bun:test';
import { createKeyboardEngine } from './engine';
import { CUPERTINO_PORTRAIT_PROFILE, solveKeyboardGeometry } from './geometry';
import { TERMINAL_US_LAYOUT } from './layouts/terminal-us';
import {
  classifyKeyboardTouch,
  createKeyboardSpatialPrior,
  keyboardAnchorContains,
  keyboardReleaseWeight,
} from './touch-model';
import type { ResolvedKeyboardKey } from './types';

const geometry = solveKeyboardGeometry(
  TERMINAL_US_LAYOUT,
  'alpha',
  402,
  3,
  CUPERTINO_PORTRAIT_PROFILE,
);
const spatial = createKeyboardSpatialPrior(geometry);

function key(id: string): ResolvedKeyboardKey {
  const found = geometry.keys.find((candidate) => candidate.definition.id === id);
  if (found === undefined) throw new Error(`missing key ${id}`);
  return found;
}

function centre(id: string): { x: number; y: number } {
  const k = key(id);
  return { x: k.rect.x + k.rect.width / 2, y: k.rect.y + k.rect.height / 2 };
}

/**
 * Inside the key but outside its anchor, so the key stays undecided until
 * release. A centred contact now commits at touch-down.
 */
function offAnchor(id: string): { x: number; y: number } {
  const k = key(id);
  return { x: k.rect.x + k.rect.width * 0.85, y: k.rect.y + k.rect.height / 2 };
}

/** A prior that overwhelmingly favours `favoured` among the character keys. */
function priorFavouring(favoured: string, options: { readonly nanKeys?: readonly string[] } = {}) {
  const prior = new Float64Array(geometry.keys.length).fill(-20);
  prior[key(favoured).index] = 0;
  for (const id of options.nanKeys ?? []) prior[key(id).index] = Number.NaN;
  return prior;
}

function decide(
  x: number,
  y: number,
  prior: Float64Array | null,
  weight: number,
): string | undefined {
  const index = classifyKeyboardTouch(
    geometry,
    spatial,
    x,
    y,
    x,
    y,
    x,
    y,
    CUPERTINO_PORTRAIT_PROFILE.releaseWeight,
    prior,
    weight,
  );
  return index === null ? undefined : geometry.keys[index]?.definition.id;
}

describe('anchoring', () => {
  test('a tap on a key centre commits that key however unlikely the prior makes it', () => {
    // The prior is as hostile as it can be: every other key is 20 nats likelier.
    const hostile = priorFavouring('key-w');
    for (const id of ['key-e', 'key-r', 'key-t', 'key-d', 'key-f', 'key-a']) {
      const point = centre(id);
      expect(decide(point.x, point.y, hostile, 100)).toBe(id);
    }
  });

  test('holds across the whole anchor rectangle, not only the exact centre', () => {
    const hostile = priorFavouring('key-w');
    const target = key('key-e');
    const point = centre('key-e');
    // The anchor is a quarter of the key's extent in each direction.
    for (const dx of [-0.24, 0, 0.24]) {
      for (const dy of [-0.24, 0, 0.24]) {
        const x = point.x + target.rect.width * dx;
        const y = point.y + target.rect.height * dy;
        expect(decide(x, y, hostile, 100)).toBe('key-e');
      }
    }
  });

  test('outside the anchor a prior can and does change the decision', () => {
    const target = key('key-e');
    const point = centre('key-e');
    // Just inside e's own half of the boundary, where geometry alone says 'e'.
    const x = point.x - target.rect.width * 0.45;
    expect(decide(x, point.y, null, 0)).toBe('key-e');
    expect(decide(x, point.y, priorFavouring('key-w'), 1)).toBe('key-w');
  });
});

describe('key prior', () => {
  test('is ignored entirely when a candidate has no language statistics', () => {
    // Backspace sits beside 'm'. With NaN on backspace the prior must step aside
    // rather than let a letter be turned into a destructive key, or the reverse.
    const boundary = key('backspace');
    const x = boundary.rect.x - 1;
    const y = boundary.rect.y + boundary.rect.height / 2;
    const withoutPrior = decide(x, y, null, 0);
    const hostile = priorFavouring('backspace', { nanKeys: ['backspace'] });
    expect(decide(x, y, hostile, 100)).toBe(withoutPrior);
  });

  test('a zero weight is identical to no prior at all', () => {
    const point = centre('key-e');
    const x = point.x - key('key-e').rect.width * 0.45;
    expect(decide(x, point.y, priorFavouring('key-w'), 0)).toBe(decide(x, point.y, null, 0));
  });

  test('scales with weight, so a small weight moves the boundary less', () => {
    const target = key('key-e');
    const point = centre('key-e');
    // A realistic advantage. A saturating prior is not a useful probe here:
    // past a few nats every weight simply wins everywhere the anchor allows, so
    // the anchor becomes the only thing setting the boundary.
    const modest = new Float64Array(geometry.keys.length).fill(-2.5);
    modest[key('key-w').index] = 0;
    const flipAt = (weight: number): number => {
      for (let dx = 0.5; dx >= 0; dx -= 0.005) {
        if (decide(point.x - target.rect.width * dx, point.y, modest, weight) === 'key-e') {
          return dx;
        }
      }
      return 0;
    };
    expect(flipAt(1)).toBeLessThan(flipAt(0.25));
  });

  test('the anchor bounds even an arbitrarily strong prior', () => {
    const target = key('key-e');
    const point = centre('key-e');
    const hostile = priorFavouring('key-w');
    // However hard the prior pushes, it never wins inside e's anchor.
    for (const weight of [1, 10, 100, 1000]) {
      const x = point.x - target.rect.width * 0.249;
      expect(decide(x, point.y, hostile, weight)).toBe('key-e');
    }
  });

  test('reports the key the touch alone chose when the prior changes it', () => {
    const point = centre('key-e');
    const x = point.x - key('key-e').rect.width * 0.45;
    const winner = new Int16Array(1);
    const classify = (prior: Float64Array | null, weight: number): number | null =>
      classifyKeyboardTouch(
        geometry,
        spatial,
        x,
        point.y,
        x,
        point.y,
        x,
        point.y,
        CUPERTINO_PORTRAIT_PROFILE.releaseWeight,
        prior,
        weight,
        winner,
      );
    expect(classify(priorFavouring('key-w'), 1)).toBe(key('key-w').index);
    expect(winner[0]).toBe(key('key-e').index);
    // With nothing arbitrating, the touch's choice is the decision.
    expect(classify(null, 0)).toBe(key('key-e').index);
    expect(winner[0]).toBe(key('key-e').index);
  });

  test('traces the touch-only key beside the committed one', () => {
    const traces: { predicted: string | undefined; spatial: string | undefined }[] = [];
    const engine = createKeyboardEngine({
      geometry,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      timers: { set: () => 0, clear: () => {} },
      onRawCommit: () => {},
      onTouchTrace: (trace) => {
        traces.push({ predicted: trace.predictedKey?.id, spatial: trace.spatialKey?.id });
      },
    });
    engine.setKeyPrior(priorFavouring('key-w'));
    const point = centre('key-e');
    const x = point.x - key('key-e').rect.width * 0.45;
    engine.beginPointerAt(1, x, point.y, 0);
    engine.endPointerAt(1, x, point.y, 80);
    // An anchored tap: the prior never had a say.
    engine.beginPointerAt(2, point.x, point.y, 200);
    engine.endPointerAt(2, point.x, point.y, 280);
    engine.destroy();
    expect(traces).toEqual([
      { predicted: 'key-w', spatial: 'key-e' },
      { predicted: 'key-e', spatial: 'key-e' },
    ]);
  });
});

describe('anchor predicate', () => {
  test('agrees with the classifier own short circuit across the key', () => {
    const hostile = priorFavouring('key-w');
    const target = key('key-e');
    const point = centre('key-e');
    for (let dx = -0.5; dx <= 0.5; dx += 0.02) {
      for (let dy = -0.5; dy <= 0.5; dy += 0.05) {
        const x = point.x + target.rect.width * dx;
        const y = point.y + target.rect.height * dy;
        if (!keyboardAnchorContains(target.rect, x, y)) continue;
        // Wherever the predicate says the point is anchored, the classifier's
        // guarantee must hold there too: one definition of "anchor", not two.
        expect(decide(x, y, hostile, 1000)).toBe('key-e');
      }
    }
  });

  test('adjacent anchors never overlap', () => {
    // Each anchor is half the key's width and height about its own centre, so
    // no point can be anchored to two keys. That is what makes "the winner's
    // anchor contains the point" an unambiguous commit gate.
    for (const probe of geometry.keys) {
      const point = centre(probe.definition.id);
      const owners = geometry.keys.filter((candidate) =>
        keyboardAnchorContains(candidate.rect, point.x, point.y),
      );
      expect(owners.map((owner) => owner.definition.id)).toEqual([probe.definition.id]);
    }
  });

  test('ignores the prior entirely, unlike the classifier short circuit', () => {
    // The engine's commit gate cannot reuse the classifier's own anchor check,
    // which is nested inside `usePrior` and so does not fire with no context,
    // with a zero weight, or beside a key the language model cannot score.
    const e = key('key-e');
    const point = centre('key-e');
    expect(keyboardAnchorContains(e.rect, point.x, point.y)).toBe(true);
    expect(decide(point.x, point.y, null, 0)).toBe('key-e');
    expect(decide(point.x, point.y, priorFavouring('key-w'), 0)).toBe('key-e');
    expect(decide(point.x, point.y, priorFavouring('key-w', { nanKeys: ['key-w'] }), 100)).toBe(
      'key-e',
    );
  });

  test('rejects a point outside the anchor even at the key edge', () => {
    const e = key('key-e');
    const point = centre('key-e');
    expect(keyboardAnchorContains(e.rect, point.x + e.rect.width * 0.26, point.y)).toBe(false);
    expect(keyboardAnchorContains(e.rect, point.x, point.y + e.rect.height * 0.26)).toBe(false);
    // The boundary itself is inclusive.
    expect(keyboardAnchorContains(e.rect, point.x + e.rect.width * 0.25, point.y)).toBe(true);
  });
});

describe('layer switch', () => {
  test('commits a letter that is still down instead of dropping it', () => {
    const commits: string[] = [];
    const engine = createKeyboardEngine({
      geometry,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      timers: { set: () => 0, clear: () => {} },
      onRawCommit: (committed) => {
        commits.push(committed.definition.id);
      },
    });
    // Off-anchor, so the letter is still undecided when the layer switches --
    // which is the whole situation this test is about.
    const f = offAnchor('key-f');
    const layer = centre('layer-numbers');

    // Ordinary two-thumb typing: one thumb is still on a letter while the other
    // taps the layer key. Before this was fixed the letter vanished entirely.
    engine.beginPointerAt(1, f.x, f.y, 0);
    engine.beginPointerAt(2, layer.x, layer.y, 10);

    // The letter is pressed first, so it reaches the PTY first. It is resolved
    // by the layer key overtaking it, which means it commits BEFORE the layer
    // changes rather than being rescued afterwards by `commitLiveContacts` --
    // so it cannot be committed against the wrong layer at all.
    expect(commits).toEqual(['key-f', 'layer-numbers']);

    engine.updateGeometry(
      solveKeyboardGeometry(TERMINAL_US_LAYOUT, 'numbers', 402, 3, CUPERTINO_PORTRAIT_PROFILE),
    );
    engine.destroy();

    expect(commits).toEqual(['key-f', 'layer-numbers']);
  });

  test('destroy still discards a live contact rather than committing it', () => {
    const commits: string[] = [];
    const engine = createKeyboardEngine({
      geometry,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      timers: { set: () => 0, clear: () => {} },
      onRawCommit: (committed) => {
        commits.push(committed.definition.id);
      },
    });
    const f = offAnchor('key-f');
    engine.beginPointerAt(1, f.x, f.y, 0);
    engine.destroy();
    expect(commits).toHaveLength(0);
  });

  test('a cancelled pointer is still discarded', () => {
    const commits: string[] = [];
    const engine = createKeyboardEngine({
      geometry,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      timers: { set: () => 0, clear: () => {} },
      onRawCommit: (committed) => {
        commits.push(committed.definition.id);
      },
    });
    const f = offAnchor('key-f');
    engine.beginPointerAt(1, f.x, f.y, 0);
    engine.cancelPointer(1);
    engine.destroy();
    expect(commits).toHaveLength(0);
  });
});

describe('release weight ramp', () => {
  const { tapDrift, slideDrift, releaseWeight } = CUPERTINO_PORTRAIT_PROFILE;
  const at = (drift: number) =>
    keyboardReleaseWeight(drift * drift, tapDrift, slideDrift, releaseWeight);

  test('is the profile weight for anything that never left the tap threshold', () => {
    for (const drift of [0, 1, 6, tapDrift]) expect(at(drift)).toBe(releaseWeight);
  });

  test('reaches release-only once the gesture is unambiguously a slide', () => {
    for (const drift of [slideDrift, slideDrift + 50, 1000]) expect(at(drift)).toBe(1);
  });

  test('is continuous at both thresholds, which is the whole point', () => {
    // The form this replaced jumped from a blended estimate to the single
    // release sample the instant drift crossed `tapDrift`, which cost up to 30
    // percentage points of accuracy for one pixel of extra travel.
    expect(at(tapDrift + 0.001) - at(tapDrift)).toBeLessThan(0.001);
    expect(at(slideDrift) - at(slideDrift - 0.001)).toBeLessThan(0.001);
  });

  test('never decreases as the finger travels further', () => {
    let previous = -1;
    for (let drift = 0; drift <= slideDrift + 10; drift += 0.5) {
      const weight = at(drift);
      expect(weight).toBeGreaterThanOrEqual(previous);
      previous = weight;
    }
  });

  test('degenerates safely when the two thresholds coincide', () => {
    // At exactly `tapDrift` the base weight still applies; past it, with no span
    // to ramp across, the release sample takes over immediately.
    expect(keyboardReleaseWeight(10 * 10, 10, 10, 0)).toBe(0);
    expect(keyboardReleaseWeight(20 * 20, 10, 10, 0)).toBe(1);
  });
});

describe('early commit', () => {
  function firstCommitAtDown(keyId: string): string | null {
    let out: string | null = null;
    const engine = createKeyboardEngine({
      geometry,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      timers: { set: () => 0, clear: () => {} },
      onRawCommit: (committed) => {
        out ??= committed.definition.id;
      },
    });
    const point = centre(keyId);
    engine.beginPointerAt(1, point.x, point.y, 0);
    const atDown = out;
    engine.destroy();
    return atDown;
  }

  test('a character key in its anchor commits at touch-down', () => {
    for (const id of ['key-e', 'key-a', 'space']) expect(firstCommitAtDown(id)).toBe(id);
  });

  test('Enter does not, because running the wrong command has no undo', () => {
    // Anchor-commit trades slide-to-correct for latency. One Backspace pays for
    // a wrong letter; nothing pays for a command that already ran.
    expect(firstCommitAtDown('enter')).toBeNull();
  });

  test('nor do the navigation keys on the pc layer', () => {
    const pc = solveKeyboardGeometry(TERMINAL_US_LAYOUT, 'pc', 402, 3, CUPERTINO_PORTRAIT_PROFILE);
    // Arrows are `activation: 'press'` because they repeat, so they commit at
    // touch-down by design and are not part of this rule.
    for (const id of ['tab', 'escape', 'home']) {
      const target = pc.keys.find((candidate) => candidate.definition.id === id);
      expect(target).toBeDefined();
      if (target === undefined) continue;
      let out: string | null = null;
      const engine = createKeyboardEngine({
        geometry: pc,
        profile: CUPERTINO_PORTRAIT_PROFILE,
        timers: { set: () => 0, clear: () => {} },
        onRawCommit: (committed) => {
          out ??= committed.definition.id;
        },
      });
      engine.beginPointerAt(
        1,
        target.rect.x + target.rect.width / 2,
        target.rect.y + target.rect.height / 2,
        0,
      );
      engine.destroy();
      expect(out).toBeNull();
    }
  });
});

describe('lost pointerup', () => {
  test('a reused pointer id still emits the byte the old contact owed', () => {
    const commits: string[] = [];
    const engine = createKeyboardEngine({
      geometry,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      timers: { set: () => 0, clear: () => {} },
      onRawCommit: (committed) => {
        commits.push(committed.definition.id);
      },
    });
    const a = centre('key-a');
    const l = centre('key-l');
    // Land off-centre so the contact stays undecided rather than anchor-committing.
    engine.beginPointerAt(1, a.x + key('key-a').rect.width * 0.4, a.y, 0);
    // The platform never delivered the up; the same id arrives again elsewhere.
    engine.beginPointerAt(1, l.x, l.y, 40);
    engine.endPointerAt(1, l.x, l.y, 90);
    engine.destroy();
    expect(commits).toEqual(['key-a', 'key-l']);
  });
});
