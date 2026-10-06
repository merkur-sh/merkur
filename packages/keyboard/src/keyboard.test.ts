import { describe, expect, test } from 'bun:test';
import { createKeyboardEngine, type KeyboardEngine, type KeyboardTimerHost } from './engine';
import {
  CUPERTINO_PORTRAIT_PROFILE,
  hitTestKeyboard,
  KEYBOARD_CANDIDATE_COUNT,
  solveKeyboardGeometry,
} from './geometry';
import { createKeyboardLayout } from './layout';
import { TERMINAL_US_LAYOUT } from './layouts/terminal-us';
import { createKeyboardSpatialPrior } from './touch-model';
import type { KeyboardEngineCommit, KeyboardTouchTrace, ResolvedKeyboardGeometry } from './types';

const WIDTH = 390;

function geometry(layer = 'alpha'): ResolvedKeyboardGeometry {
  return solveKeyboardGeometry(TERMINAL_US_LAYOUT, layer, WIDTH, 3, CUPERTINO_PORTRAIT_PROFILE);
}

function centerOf(resolved: ResolvedKeyboardGeometry, keyId: string): { x: number; y: number } {
  const key = resolved.keys.find((candidate) => candidate.definition.id === keyId);
  if (key === undefined) throw new Error(`Missing key ${keyId}`);
  return {
    x: key.rect.x + key.rect.width / 2,
    y: key.rect.y + key.rect.height / 2,
  };
}

/**
 * A point inside the key but outside its anchor, so the key stays undecided
 * until release. A centred tap now commits at touch-down, so any test about
 * release-time behaviour has to aim here instead.
 */
function offAnchorOf(resolved: ResolvedKeyboardGeometry, keyId: string): { x: number; y: number } {
  const key = resolved.keys.find((candidate) => candidate.definition.id === keyId);
  if (key === undefined) throw new Error(`Missing key ${keyId}`);
  return { x: key.rect.x + key.rect.width * 0.85, y: key.rect.y + key.rect.height / 2 };
}

function atlasOffset(resolved: ResolvedKeyboardGeometry, point: { x: number; y: number }): number {
  return Math.floor(point.y) * resolved.atlasWidth + Math.floor(point.x);
}

function atlasWinner(resolved: ResolvedKeyboardGeometry, offset: number): number | undefined {
  return resolved.candidateAtlas[offset * KEYBOARD_CANDIDATE_COUNT];
}

function physicalBounds(
  resolved: ResolvedKeyboardGeometry,
  keyId: string,
  devicePixelRatio: number,
): readonly [number, number, number, number] {
  const key = resolved.keys.find((candidate) => candidate.definition.id === keyId);
  if (key === undefined) throw new Error(`Missing key ${keyId}`);
  return [
    Math.round(key.rect.x * devicePixelRatio),
    Math.round(key.rect.y * devicePixelRatio),
    Math.round((key.rect.x + key.rect.width) * devicePixelRatio),
    Math.round((key.rect.y + key.rect.height) * devicePixelRatio),
  ];
}

function boundaryBetween(
  resolved: ResolvedKeyboardGeometry,
  leftKeyId: string,
  rightKeyId: string,
): { x: number; y: number } {
  const left = resolved.keys.find((key) => key.definition.id === leftKeyId);
  const right = resolved.keys.find((key) => key.definition.id === rightKeyId);
  if (left === undefined || right === undefined) throw new Error('Missing boundary test keys');
  const y = Math.floor(left.rect.y + left.rect.height / 2);
  const rowOffset = y * resolved.atlasWidth;
  for (let x = 0; x + 1 < resolved.atlasWidth; x += 1) {
    if (
      atlasWinner(resolved, rowOffset + x) === left.index &&
      atlasWinner(resolved, rowOffset + x + 1) === right.index
    ) {
      return { x: x + 0.25, y: y + 0.25 };
    }
  }
  throw new Error(`Missing ${leftKeyId}/${rightKeyId} boundary`);
}

describe('custom layout contract', () => {
  test('accepts application-defined keys, dimensions, and layers', () => {
    const layout = createKeyboardLayout({
      id: 'custom',
      initialLayer: 'main',
      keys: {
        macro: {
          id: 'macro',
          label: 'deploy',
          kind: 'action',
          action: 'deploy',
          variant: 'accent',
        },
      },
      layers: {
        main: {
          id: 'main',
          columns: 4,
          rows: [{ keys: [{ key: 'macro', column: 0.5, span: 3 }] }],
        },
      },
    });

    const resolved = solveKeyboardGeometry(layout, 'main', 320, 2, {
      ...CUPERTINO_PORTRAIT_PROFILE,
      keyHeight: 50,
      keyGap: 8,
    });
    expect(resolved.keys).toHaveLength(1);
    expect(resolved.keys[0]?.definition.action).toBe('deploy');
    expect(resolved.keys[0]?.rect.height).toBe(50);
  });

  test('rejects overlapping placements before rendering', () => {
    expect(() =>
      createKeyboardLayout({
        id: 'overlap',
        initialLayer: 'main',
        keys: {
          a: { id: 'a', label: 'a', kind: 'input', value: 'a' },
          b: { id: 'b', label: 'b', kind: 'input', value: 'b' },
        },
        layers: {
          main: {
            id: 'main',
            columns: 2,
            rows: [
              {
                keys: [
                  { key: 'a', column: 0, span: 1.2 },
                  { key: 'b', column: 1, span: 1 },
                ],
              },
            ],
          },
        },
      }),
    ).toThrow('overlapping');
  });
});

describe('geometry and candidate atlas', () => {
  test('reproduces the measured 402 pt Apple URL-keyboard bounds at 3x', () => {
    const dpr = 3;
    const resolved = solveKeyboardGeometry(
      TERMINAL_US_LAYOUT,
      'alpha',
      402,
      dpr,
      CUPERTINO_PORTRAIT_PROFILE,
    );

    expect(physicalBounds(resolved, 'key-q', dpr)).toEqual([20, 73, 120, 202]);
    expect(physicalBounds(resolved, 'key-w', dpr)).toEqual([138, 73, 239, 202]);
    expect(physicalBounds(resolved, 'key-a', dpr)).toEqual([79, 235, 179, 364]);
    expect(physicalBounds(resolved, 'shift', dpr)).toEqual([20, 397, 156, 526]);
    expect(physicalBounds(resolved, 'key-z', dpr)).toEqual([197, 397, 298, 526]);
    expect(physicalBounds(resolved, 'backspace', dpr)).toEqual([1050, 397, 1187, 526]);
    expect(physicalBounds(resolved, 'layer-numbers', dpr)).toEqual([20, 559, 150, 688]);
    expect(physicalBounds(resolved, 'layer-pc', dpr)).toEqual([168, 559, 298, 688]);
    expect(physicalBounds(resolved, 'space', dpr)).toEqual([316, 559, 861, 688]);
    expect(physicalBounds(resolved, 'bottom-period', dpr)).toEqual([879, 559, 979, 688]);
    expect(physicalBounds(resolved, 'enter', dpr)).toEqual([997, 559, 1187, 688]);
    expect(Math.round(resolved.height * dpr)).toBe(688);
    expect(CUPERTINO_PORTRAIT_PROFILE.bottomUtilityHeight).toBe(44);
    expect(CUPERTINO_PORTRAIT_PROFILE.bottomUtilityHeight + 34).toBe(78);
    expect(resolved.atlasHeight).toBe(Math.ceil(resolved.height + 44));
    const space = centerOf(resolved, 'space');
    const spaceKey = resolved.keys.find((key) => key.definition.id === 'space');
    if (spaceKey === undefined) throw new Error('Missing Space key');
    expect(hitTestKeyboard(resolved, space.x, resolved.height + 43)).toBe(spaceKey.index);
    expect(hitTestKeyboard(resolved, space.x, resolved.height + 44)).toBeNull();
  });

  test('keeps the alphabet pitch constant and indents the home row by half a column', () => {
    const resolved = geometry();
    const q = centerOf(resolved, 'key-q');
    const w = centerOf(resolved, 'key-w');
    const a = centerOf(resolved, 'key-a');
    const s = centerOf(resolved, 'key-s');
    const pitch = w.x - q.x;

    // Physical-pixel snapping alternates widths by at most one device pixel.
    expect(Math.abs(s.x - a.x - pitch)).toBeLessThanOrEqual(1 / 3);
    expect(Math.abs(a.x - q.x - pitch / 2)).toBeLessThanOrEqual(1 / 3);
    expect(TERMINAL_US_LAYOUT.keys['key-a']?.shiftedValue).toBe('A');
  });

  test('maps key centers correctly and leaves no dead pixels inside the surface', () => {
    const resolved = geometry();
    for (const key of resolved.keys) {
      const x = key.rect.x + key.rect.width / 2;
      const y = key.rect.y + key.rect.height / 2;
      expect(hitTestKeyboard(resolved, x, y)).toBe(key.index);
    }
    for (let offset = 0; offset < resolved.atlasWidth * resolved.atlasHeight; offset += 1) {
      expect(atlasWinner(resolved, offset)).not.toBe(255);
    }
  });

  test('precomputes four plausible candidates at centers and boundaries', () => {
    const resolved = geometry();
    const q = resolved.keys.find((key) => key.definition.id === 'key-q');
    const w = resolved.keys.find((key) => key.definition.id === 'key-w');
    if (q === undefined || w === undefined) throw new Error('Missing candidate test keys');
    const qCenter = centerOf(resolved, 'key-q');
    const centerOffset = atlasOffset(resolved, qCenter);
    const boundary = boundaryBetween(resolved, 'key-q', 'key-w');
    const boundaryOffset = atlasOffset(resolved, boundary);

    expect(atlasWinner(resolved, centerOffset)).toBe(q.index);
    const centerCandidates = Array.from(
      resolved.candidateAtlas.subarray(
        centerOffset * KEYBOARD_CANDIDATE_COUNT,
        (centerOffset + 1) * KEYBOARD_CANDIDATE_COUNT,
      ),
    );
    expect(centerCandidates[0]).toBe(q.index);
    expect(centerCandidates).toContain(w.index);
    expect(atlasWinner(resolved, boundaryOffset)).toBe(q.index);
    const boundaryCandidates = Array.from(
      resolved.candidateAtlas.subarray(
        boundaryOffset * KEYBOARD_CANDIDATE_COUNT,
        (boundaryOffset + 1) * KEYBOARD_CANDIDATE_COUNT,
      ),
    );
    expect(boundaryCandidates.slice(0, 2)).toEqual([q.index, w.index]);
  });

  test('matches an exhaustive all-key candidate search exactly', () => {
    for (const layerId of Object.keys(TERMINAL_US_LAYOUT.layers)) {
      const resolved = solveKeyboardGeometry(
        TERMINAL_US_LAYOUT,
        layerId,
        117,
        3,
        CUPERTINO_PORTRAIT_PROFILE,
      );
      const surfaceHeight = Math.ceil(resolved.height);
      const expected = buildExhaustiveCandidateAtlas(resolved, resolved.atlasWidth, surfaceHeight);
      expect(
        resolved.candidateAtlas.subarray(
          0,
          resolved.atlasWidth * surfaceHeight * KEYBOARD_CANDIDATE_COUNT,
        ),
      ).toEqual(expected);
    }
  });
});

describe('pointer engine', () => {
  test('commits at touch-down when the contact lands inside the anchor', () => {
    const resolved = geometry();
    const events: string[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      onRawCommit: (key) => events.push(`commit:${key.definition.id}`),
      onRawProvisional: (key) =>
        events.push(key === null ? 'clear' : `provisional:${key.definition.id}`),
    });
    const q = centerOf(resolved, 'key-q');

    expect(engine.beginPointerAt(1, q.x, q.y, 10)).toBe(true);
    // The whole point: the character exists at touch-down, not ~84ms later when
    // the finger lifts. No provisional either -- the committed glyph is the
    // feedback, and staging one beside it would paint the character twice.
    expect(events).toEqual(['commit:key-q']);

    expect(engine.endPointerAt(1, q.x, q.y, 94)).toBe(true);
    expect(events).toEqual(['commit:key-q']);
  });

  test('commits at touch-down beside a key the language model cannot score', () => {
    const resolved = geometry();
    const commits: string[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      onRawCommit: (key) => commits.push(key.definition.id),
    });
    // Backspace carries NaN in any real prior, which switches the classifier's
    // own anchor short circuit off for every candidate near it. The commit gate
    // is pure geometry precisely so it does not inherit that hole.
    const prior = new Float64Array(resolved.keys.length).fill(-20);
    const backspace = resolved.keys.find((key) => key.definition.id === 'backspace');
    if (backspace === undefined) throw new Error('Missing backspace');
    prior[backspace.index] = Number.NaN;
    engine.setKeyPrior(prior);

    const l = centerOf(resolved, 'key-l');
    engine.beginPointerAt(1, l.x, l.y, 0);

    expect(commits).toEqual(['key-l']);
  });

  test('commits at touch-down with the prior disabled entirely', () => {
    const resolved = geometry();
    const commits: string[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: { ...CUPERTINO_PORTRAIT_PROFILE, priorWeight: 0 },
      onRawCommit: (key) => commits.push(key.definition.id),
    });
    const q = centerOf(resolved, 'key-q');
    engine.beginPointerAt(1, q.x, q.y, 0);

    expect(commits).toEqual(['key-q']);
  });

  test('gives up slide-to-correct inside the anchor', () => {
    const resolved = geometry();
    const commits: string[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      onRawCommit: (key) => commits.push(key.definition.id),
    });
    const q = centerOf(resolved, 'key-q');
    const w = centerOf(resolved, 'key-w');

    engine.beginPointerAt(1, q.x, q.y, 0);
    engine.movePointerAt(1, w.x, w.y, 20);
    engine.endPointerAt(1, w.x, w.y, 40);

    // The deliberate cost of the change: the anchor already promised the prior
    // could not override geometry here, and that promise now covers the release
    // sample too. Slide-to-correct survives everywhere outside the anchor.
    expect(commits).toEqual(['key-q']);
  });

  test('emits a full-fidelity trace at release for a tap committed at touch-down', () => {
    const resolved = geometry();
    const traces: KeyboardTouchTrace[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      onRawCommit: () => {},
      onTouchTrace: (trace) => traces.push(trace),
    });
    const q = centerOf(resolved, 'key-q');
    const w = centerOf(resolved, 'key-w');

    engine.beginPointerAt(1, q.x, q.y, 0);
    engine.movePointerAt(1, w.x, w.y, 30);
    engine.endPointerAt(1, w.x, w.y, 84);

    // The trace is deliberately not coupled to the commit: the offset learner
    // and the diagnostics histograms both read it, and they need the real lift
    // point and the real contact duration, neither of which existed when the
    // key was decided.
    expect(traces).toHaveLength(1);
    expect(traces[0]?.predictedKey?.id).toBe('key-q');
    expect(traces[0]?.downX).toBeCloseTo(q.x, 6);
    expect(traces[0]?.releaseX).toBeCloseTo(w.x, 6);
    expect(traces[0]?.durationMs).toBe(84);
    expect(traces[0]?.sampleCount).toBeGreaterThan(1);
  });

  test('does not schedule a repeat for a character key committed at touch-down', () => {
    const resolved = geometry();
    let armed = 0;
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      onRawCommit: () => {},
      timers: {
        set: () => {
          armed += 1;
          return armed;
        },
        clear: () => {},
      },
    });
    const q = centerOf(resolved, 'key-q');
    engine.beginPointerAt(1, q.x, q.y, 0);
    engine.endPointerAt(1, q.x, q.y, 500);

    // Repeat stays a press-activated behaviour; committing early must not turn a
    // held letter into a repeating one.
    expect(armed).toBe(0);
  });

  test('supports the scalar pointer and raw commit fast path', () => {
    const resolved = geometry();
    let committedKey = '';
    let committedPointer = -1;
    let provisionalKey = '';
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      onRawCommit(key, layerId, pointerId) {
        expect(layerId).toBe('alpha');
        committedKey = key.definition.id;
        committedPointer = pointerId;
      },
      onRawProvisional(key) {
        provisionalKey = key?.definition.id ?? '';
      },
    });
    // Off-anchor, so this stays the release-decided path this test is about.
    const q = offAnchorOf(resolved, 'key-q');

    expect(engine.beginPointerAt(42, q.x, q.y, 10)).toBe(true);
    expect(provisionalKey).toBe('key-q');
    expect(committedKey).toBe('');
    expect(engine.endPointerAt(42, q.x, q.y, 11)).toBe(true);

    expect(committedKey).toBe('key-q');
    expect(committedPointer).toBe(42);
  });

  test('commits every rapid tap exactly once', () => {
    const resolved = geometry();
    const commits: KeyboardEngineCommit[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      onCommit: (commit) => commits.push(commit),
    });
    const ids = ['key-q', 'key-w', 'key-e', 'key-r', 'key-t'];

    for (let index = 0; index < 10_000; index += 1) {
      const keyId = ids[index % ids.length];
      if (keyId === undefined) throw new Error('Missing test key');
      const point = centerOf(resolved, keyId);
      const pointerId = (index % 7) + 1;
      const timeStamp = index * 2;
      expect(engine.beginPointerAt(pointerId, point.x, point.y, timeStamp)).toBe(true);
      expect(engine.endPointerAt(pointerId, point.x, point.y, timeStamp + 1)).toBe(true);
    }

    expect(commits).toHaveLength(10_000);
    expect(commits.map((commit) => commit.key.id).slice(0, 5)).toEqual(ids);
  });

  test('supports roaming, overlapping fingers, and cancellation', () => {
    const resolved = geometry();
    const commits: KeyboardEngineCommit[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      onCommit: (commit) => commits.push(commit),
    });
    const boundary = boundaryBetween(resolved, 'key-q', 'key-w');
    const w = centerOf(resolved, 'key-w');
    // Off-anchor: a centred Enter would commit at touch-down, and this test is
    // about a contact that is cancelled before it ever decides.
    const enter = offAnchorOf(resolved, 'enter');

    engine.beginPointer({ pointerId: 11, ...boundary, timeStamp: 0 });
    engine.beginPointer({ pointerId: 12, ...enter, timeStamp: 1 });
    engine.movePointer({ pointerId: 11, ...w, timeStamp: 2 });
    engine.endPointer({ pointerId: 11, ...w, timeStamp: 3 });
    engine.cancelPointer(12);

    expect(commits.map((commit) => commit.key.id)).toEqual(['key-w']);
  });

  test('an anchored tap still presses its keycap even though it stages no provisional', () => {
    const resolved = geometry();
    const events: string[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      timers: { set: () => 0, clear: () => {} },
      onRawCommit: (key) => events.push(`commit:${key.definition.id}`),
      onRawProvisional: () => events.push('provisional'),
      onKeyStateChange: (keyIndex, active) =>
        events.push(`${active ? 'press' : 'release'}:${resolved.keys[keyIndex]?.definition.id}`),
    });
    const q = centerOf(resolved, 'key-q');

    engine.beginPointerAt(1, q.x, q.y, 0);
    // Two different channels that are easy to conflate. The keycap and its
    // preview bubble ride `onKeyStateChange`; the speculative terminal glyph
    // rides the provisional. Suppressing the glyph on the immediate path must
    // not take the keycap feedback with it.
    expect(events).toEqual(['press:key-q', 'commit:key-q']);

    engine.endPointerAt(1, q.x, q.y, 84);
    expect(events).toEqual(['press:key-q', 'commit:key-q', 'release:key-q']);
  });

  test('emits no touch trace for a press-activated key', () => {
    const resolved = geometry();
    const traces: KeyboardTouchTrace[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      timers: { set: () => 0, clear: () => {} },
      onRawCommit: () => {},
      onTouchTrace: (trace) => traces.push(trace),
    });
    const backspace = centerOf(resolved, 'backspace');

    engine.beginPointerAt(1, backspace.x, backspace.y, 0);
    engine.endPointerAt(1, backspace.x, backspace.y, 84);

    // The trace feeds the per-key offset learner and the diagnostics
    // histograms, which train on where a user aimed for a CHARACTER. A
    // Backspace has no intended character, so letting one through would pull
    // the learned centres of whatever keys surround it.
    expect(traces).toHaveLength(0);

    const q = offAnchorOf(resolved, 'key-q');
    engine.beginPointerAt(2, q.x, q.y, 100);
    engine.endPointerAt(2, q.x, q.y, 180);
    expect(traces).toHaveLength(1);
  });

  test('clears the provisional of a press-activated key when it lifts', () => {
    const resolved = geometry();
    const events: string[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      timers: { set: () => 0, clear: () => {} },
      onRawCommit: (key) => events.push(`commit:${key.definition.id}`),
      onRawProvisional: (key, _layerId, pointerId) =>
        events.push(key === null ? `clear:${pointerId}` : `provisional:${key.definition.id}`),
    });
    const backspace = centerOf(resolved, 'backspace');

    engine.beginPointerAt(9, backspace.x, backspace.y, 0);
    engine.endPointerAt(9, backspace.x, backspace.y, 84);

    // The clear is what stops a recycled pointer id from inheriting this
    // contact's preview. Backspace stages no glyph of its own -- it has no
    // printable intent -- but the clear still has to happen.
    expect(events).toEqual(['provisional:backspace', 'commit:backspace', 'clear:9']);
  });

  test('fires press keys immediately and repeats without an up duplicate', () => {
    const resolved = geometry();
    const commits: KeyboardEngineCommit[] = [];
    const scheduled: Array<() => void> = [];
    const timers: KeyboardTimerHost = {
      set(callback) {
        scheduled.push(callback);
        return callback;
      },
      clear() {},
    };
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      timers,
      onCommit: (commit) => commits.push(commit),
    });
    const backspace = centerOf(resolved, 'backspace');

    engine.beginPointer({ pointerId: 9, ...backspace, timeStamp: 0 });
    scheduled[0]?.();
    engine.endPointer({ pointerId: 9, ...backspace, timeStamp: 600 });

    expect(commits.map((commit) => [commit.key.id, commit.repeat])).toEqual([
      ['backspace', false],
      ['backspace', true],
    ]);
  });

  test('keeps character taps outside the anchor provisional until release', () => {
    const resolved = geometry();
    const commits: KeyboardEngineCommit[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      onCommit: (commit) => commits.push(commit),
    });
    const q = offAnchorOf(resolved, 'key-q');
    const boundary = boundaryBetween(resolved, 'key-q', 'key-w');

    engine.beginPointerAt(1, q.x, q.y, 0);
    expect(commits).toHaveLength(0);
    engine.endPointerAt(1, q.x, q.y, 10);
    expect(commits.map((commit) => commit.key.id)).toEqual(['key-q']);

    engine.beginPointerAt(2, boundary.x, boundary.y, 20);
    expect(commits).toHaveLength(1);
    engine.endPointerAt(2, boundary.x, boundary.y, 30);
    expect(commits.map((commit) => commit.key.id)).toEqual(['key-q', 'key-q']);
  });

  test('commits the contact key when the finger rolls past the boundary at release', () => {
    const resolved = geometry();
    const commits: KeyboardEngineCommit[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      onCommit: (commit) => commits.push(commit),
    });
    const boundary = boundaryBetween(resolved, 'key-q', 'key-w');
    const release = { x: boundary.x + 4, y: boundary.y };

    // Drift stays inside tapDrift, so this is a tap whose lift-off rolled off the
    // key rather than a slide. The release point alone resolves to the neighbour.
    const rolledOnto = hitTestKeyboard(resolved, release.x, release.y);
    expect(resolved.keys[rolledOnto ?? -1]?.definition.id).toBe('key-w');

    engine.beginPointerAt(1, boundary.x - 4, boundary.y, 0);
    engine.movePointerAt(1, boundary.x, boundary.y, 8);
    engine.endPointerAt(1, release.x, release.y, 16);

    expect(commits.map((commit) => commit.key.id)).toEqual(['key-q']);
  });

  test('preserves slide-to-correct release after provisional selection changes', () => {
    const resolved = geometry();
    const commits: KeyboardEngineCommit[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      onCommit: (commit) => commits.push(commit),
    });
    // Starts off-anchor, so the key is still undecided and the slide can move
    // it. The anchored counterpart is 'gives up slide-to-correct inside the
    // anchor' above, which is the deliberate loss.
    const q = offAnchorOf(resolved, 'key-q');
    const w = centerOf(resolved, 'key-w');

    engine.beginPointerAt(1, q.x, q.y, 0);
    engine.movePointerAt(1, w.x, w.y, 5);
    expect(commits).toHaveLength(0);
    engine.endPointerAt(1, w.x, w.y, 20);
    expect(commits.map((commit) => commit.key.id)).toEqual(['key-w']);
  });

  test('commits Space throughout the invisible bottom utility hit region', () => {
    const resolved = geometry();
    const commits: KeyboardEngineCommit[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      onCommit: (commit) => commits.push(commit),
    });
    const space = centerOf(resolved, 'space');
    const belowSpace = { x: space.x, y: resolved.height + 40 };

    expect(engine.beginPointerAt(1, belowSpace.x, belowSpace.y, 0)).toBe(true);
    expect(engine.endPointerAt(1, belowSpace.x, belowSpace.y, 30)).toBe(true);
    expect(commits.map((commit) => commit.key.id)).toEqual(['space']);
  });
});

describe('commit ordering', () => {
  interface CapturedTimer {
    readonly callback: () => void;
    readonly delayMs: number;
  }

  interface OrderingHarness {
    readonly engine: KeyboardEngine;
    readonly resolved: ResolvedKeyboardGeometry;
    readonly commits: string[];
    readonly layerIds: string[];
    readonly events: string[];
    readonly armed: CapturedTimer[];
    cleared: number;
  }

  function harness(): OrderingHarness {
    const resolved = geometry();
    const commits: string[] = [];
    const layerIds: string[] = [];
    const events: string[] = [];
    const armed: CapturedTimer[] = [];
    const state = { cleared: 0 };
    const timers: KeyboardTimerHost = {
      set(callback, delayMs) {
        armed.push({ callback, delayMs });
        return armed.length;
      },
      clear() {
        state.cleared += 1;
      },
      now: () => 0,
    };
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      timers,
      onRawCommit(key, layerId) {
        commits.push(key.definition.id);
        layerIds.push(layerId);
        events.push(`commit:${key.definition.id}`);
      },
      onRawProvisional(key, _layerId, pointerId) {
        events.push(key === null ? `clear:${pointerId}` : `provisional:${key.definition.id}`);
      },
    });
    return {
      engine,
      resolved,
      commits,
      layerIds,
      events,
      armed,
      get cleared() {
        return state.cleared;
      },
    };
  }

  /**
   * A tap that is release-decided: inside the key but outside its anchor, so it
   * still enters the press-ordinal queue. Every test in this block is about that
   * queue, and a centred tap now commits at touch-down and never reaches it.
   * `anchoredTapAt` is the counterpart for the down-commit tests.
   */
  function tapAt(resolved: ResolvedKeyboardGeometry, keyId: string): { x: number; y: number } {
    const key = resolved.keys.find((candidate) => candidate.definition.id === keyId);
    if (key === undefined) throw new Error(`Missing key ${keyId}`);
    // 0.35 of the width from centre: past the 0.25 anchor, still well inside the
    // rect, and still the atlas winner.
    return {
      x: key.rect.x + key.rect.width * 0.85,
      y: key.rect.y + key.rect.height / 2,
    };
  }

  function anchoredTapAt(
    resolved: ResolvedKeyboardGeometry,
    keyId: string,
  ): { x: number; y: number } {
    return centerOf(resolved, keyId);
  }

  test('commits sequential taps in press order', () => {
    const { engine, resolved, commits } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = tapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.endPointerAt(1, a.x, a.y, 40);
    engine.beginPointerAt(2, l.x, l.y, 60);
    engine.endPointerAt(2, l.x, l.y, 100);

    expect(commits).toEqual(['key-a', 'key-l']);
  });

  test('commits overlapping taps in press order', () => {
    const { engine, resolved, commits } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = tapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 30);
    engine.endPointerAt(1, a.x, a.y, 60);
    engine.endPointerAt(2, l.x, l.y, 90);

    expect(commits).toEqual(['key-a', 'key-l']);
  });

  test('commits a nested rollover in press order rather than release order', () => {
    const { engine, resolved, commits, armed } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = tapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 30);
    engine.endPointerAt(2, l.x, l.y, 60);

    // Both bytes leave HERE, at the inner contact's release, in press order.
    // The lingering thumb is resolved from where it currently sits rather than
    // waited on, so neither character is held back for the rest of its hold.
    expect(commits).toEqual(['key-a', 'key-l']);
    expect(armed).toHaveLength(0);

    engine.endPointerAt(1, a.x, a.y, 90);
    // Already committed at overtake; lifting must not commit it twice.
    expect(commits).toEqual(['key-a', 'key-l']);
  });

  test('orders a three-contact nested rollover by press ordinal', () => {
    const { engine, resolved, commits } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = tapAt(resolved, 'key-l');
    const q = tapAt(resolved, 'key-q');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 20);
    engine.beginPointerAt(3, q.x, q.y, 40);
    // The innermost contact lifts first and overtakes both older ones, so all
    // three bytes leave here, ordered by press.
    engine.endPointerAt(3, q.x, q.y, 60);
    expect(commits).toEqual(['key-a', 'key-l', 'key-q']);

    engine.endPointerAt(2, l.x, l.y, 80);
    engine.endPointerAt(1, a.x, a.y, 100);
    expect(commits).toEqual(['key-a', 'key-l', 'key-q']);
  });

  test('orders a partially nested rollover', () => {
    const { engine, resolved, commits } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = tapAt(resolved, 'key-l');
    const q = tapAt(resolved, 'key-q');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 20);
    engine.endPointerAt(2, l.x, l.y, 40);
    engine.beginPointerAt(3, q.x, q.y, 60);
    engine.endPointerAt(3, q.x, q.y, 80);
    engine.endPointerAt(1, a.x, a.y, 100);

    expect(commits).toEqual(['key-a', 'key-l', 'key-q']);
  });

  test('preserves slide-to-correct under a nested contact', () => {
    const { engine, resolved, commits } = harness();
    const a = tapAt(resolved, 'key-a');
    const q = tapAt(resolved, 'key-q');
    const w = tapAt(resolved, 'key-w');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, q.x, q.y, 20);
    engine.movePointerAt(2, w.x, w.y, 40);
    engine.endPointerAt(2, w.x, w.y, 60);
    engine.endPointerAt(1, a.x, a.y, 80);

    // The nested contact's own slide is untouched: it is the one being released,
    // so it is decided by its own release exactly as before.
    expect(commits).toEqual(['key-a', 'key-w']);
  });

  test('resolves an overtaken contact to where its finger has already slid', () => {
    const { engine, resolved, commits } = harness();
    const q = tapAt(resolved, 'key-q');
    const w = tapAt(resolved, 'key-w');
    const l = tapAt(resolved, 'key-l');

    // The blocker itself slides before being overtaken. Resolution reads the
    // trajectory, so a correction already in progress is honoured rather than
    // discarded -- this is why resolving early costs almost nothing.
    engine.beginPointerAt(1, q.x, q.y, 0);
    engine.movePointerAt(1, w.x, w.y, 20);
    engine.beginPointerAt(2, l.x, l.y, 30);
    engine.endPointerAt(2, l.x, l.y, 60);

    expect(commits).toEqual(['key-w', 'key-l']);
  });

  test('swaps each provisional glyph for its commit as the commit is emitted', () => {
    const { engine, resolved, events } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = tapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 30);
    expect(events).toEqual(['provisional:key-a', 'provisional:key-l']);

    engine.endPointerAt(2, l.x, l.y, 60);

    // Every clear is immediately followed by its own commit, and no provisional
    // ever coexists with the committed glyph that replaces it.
    expect(events).toEqual([
      'provisional:key-a',
      'provisional:key-l',
      'clear:1',
      'commit:key-a',
      'clear:2',
      'commit:key-l',
    ]);

    engine.endPointerAt(1, a.x, a.y, 90);
    expect(events).toHaveLength(6);
  });

  test('yields a parked contact with no delay and no timer', () => {
    const { engine, resolved, commits, armed } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = tapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 400);
    engine.endPointerAt(2, l.x, l.y, 410);

    expect(commits).toEqual(['key-l']);
    expect(armed).toHaveLength(0);

    engine.endPointerAt(1, a.x, a.y, 600);
    expect(commits).toEqual(['key-l', 'key-a']);
  });

  test('never arms a rollover deadline, because nothing is ever held back', () => {
    const { engine, resolved, commits, armed, cleared } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = tapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 10);
    engine.endPointerAt(2, l.x, l.y, 20);

    // The whole deadline mechanism is gone: a commit that would once have waited
    // out ROLLOVER_HOLD_MS now leaves on the event that produced it.
    expect(commits).toEqual(['key-a', 'key-l']);
    expect(armed).toHaveLength(0);
    expect(cleared).toBe(0);
  });

  test('resolves an older contact before a press-activated key', () => {
    const { engine, resolved, commits } = harness();
    const a = tapAt(resolved, 'key-a');
    const backspace = anchoredTapAt(resolved, 'backspace');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, backspace.x, backspace.y, 20);

    // A Backspace that overtook the letter it was meant to delete would delete
    // the wrong character, so the letter is resolved and emitted first.
    expect(commits).toEqual(['key-a', 'backspace']);
  });

  test('never lets a held press-activated key block a character', () => {
    const { engine, resolved, commits, armed } = harness();
    const backspace = tapAt(resolved, 'backspace');
    const q = tapAt(resolved, 'key-q');

    engine.beginPointerAt(1, backspace.x, backspace.y, 0);
    engine.beginPointerAt(2, q.x, q.y, 5);
    engine.endPointerAt(2, q.x, q.y, 10);

    expect(commits).toEqual(['backspace', 'key-q']);
    expect(armed).toHaveLength(1); // the repeat timer, not a rollover deadline
  });

  test('a cancelled contact has nothing left to release', () => {
    const { engine, resolved, commits } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = tapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 20);
    engine.endPointerAt(2, l.x, l.y, 40);
    // Both already left; the blocker was resolved rather than waited on.
    expect(commits).toEqual(['key-a', 'key-l']);

    engine.cancelPointer(1);
    // Cancelling a contact whose byte already went cannot unsend it, and there
    // is nothing queued behind it to release.
    expect(commits).toEqual(['key-a', 'key-l']);
  });

  test('flushes with the outgoing layer when geometry is replaced', () => {
    const { engine, resolved, commits, layerIds } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = tapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 5);
    engine.endPointerAt(2, l.x, l.y, 10);
    engine.updateGeometry(geometry('numbers'));

    // 'a' is still down when the layer changes. It pressed first, so it commits
    // first: replacing the geometry resolves live contacts against the layer
    // they were typed on rather than discarding them, which is what made a
    // letter vanish when the other thumb tapped a layer key.
    expect(commits).toEqual(['key-a', 'key-l']);
    expect(layerIds).toEqual(['alpha', 'alpha']);
  });

  test('destroy cannot drop input, because nothing is ever buffered', () => {
    const { engine, resolved, commits } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = tapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 20);
    engine.endPointerAt(2, l.x, l.y, 40);
    expect(commits).toEqual(['key-a', 'key-l']);

    // The old design had to flush on destroy or lose the queue. There is no
    // queue to lose: every byte left on the event that decided it.
    engine.destroy();
    expect(commits).toEqual(['key-a', 'key-l']);
  });

  test('emits many taps under a young blocker immediately, in press order', () => {
    const { engine, resolved, commits } = harness();
    const a = tapAt(resolved, 'key-a');
    const q = tapAt(resolved, 'key-q');

    engine.beginPointerAt(1, a.x, a.y, 0);
    for (let index = 0; index < 12; index += 1) {
      engine.beginPointerAt(index + 2, q.x, q.y, 1);
      engine.endPointerAt(index + 2, q.x, q.y, 1);
    }

    // The blocker is resolved by the first tap that overtakes it, and every tap
    // after that is unblocked outright. Same bytes, same order, no queue.
    expect(commits).toEqual(['key-a', ...Array.from({ length: 12 }, () => 'key-q')]);

    engine.endPointerAt(1, a.x, a.y, 2);
    expect(commits).toHaveLength(13);
  });

  test('commits anchored taps at touch-down in press order', () => {
    const { engine, resolved, commits, armed } = harness();
    const a = anchoredTapAt(resolved, 'key-a');
    const l = anchoredTapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    expect(commits).toEqual(['key-a']);
    engine.beginPointerAt(2, l.x, l.y, 10);
    expect(commits).toEqual(['key-a', 'key-l']);
    engine.endPointerAt(2, l.x, l.y, 50);
    engine.endPointerAt(1, a.x, a.y, 90);

    // Nothing was ever undecided, so nothing buffered and no deadline was armed.
    expect(commits).toEqual(['key-a', 'key-l']);
    expect(armed).toHaveLength(0);
  });

  test('a nested rollover of two anchored taps needs no buffer at all', () => {
    const { engine, resolved, commits, armed } = harness();
    const a = anchoredTapAt(resolved, 'key-a');
    const l = anchoredTapAt(resolved, 'key-l');

    // The lingering-thumb pattern: down A, down B, up B, up A. Release order is
    // B then A, but both are decided at their own down, so press order is what
    // reaches the PTY without the queue being involved.
    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 4);
    engine.endPointerAt(2, l.x, l.y, 40);
    engine.endPointerAt(1, a.x, a.y, 80);

    expect(commits).toEqual(['key-a', 'key-l']);
    expect(armed).toHaveLength(0);
  });

  test('an anchored tap resolves an older undecided contact instead of waiting', () => {
    const { engine, resolved, commits, armed } = harness();
    // The ordering hazard, and the design that removes it. A is undecided, so
    // emitting B first would transpose them. Rather than making B wait, A is
    // decided from where its finger already is and both leave in press order.
    const a = tapAt(resolved, 'key-a');
    const l = anchoredTapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 4);

    expect(commits).toEqual(['key-a', 'key-l']);
    expect(armed).toHaveLength(0);

    engine.endPointerAt(2, l.x, l.y, 40);
    engine.endPointerAt(1, a.x, a.y, 80);
    // Neither may commit a second time when its own finger finally lifts.
    expect(commits).toEqual(['key-a', 'key-l']);
  });

  test('an overtaken contact stops reclassifying and keeps its resolved key', () => {
    const { engine, resolved, commits } = harness();
    const q = tapAt(resolved, 'key-q');
    const w = tapAt(resolved, 'key-w');
    const l = anchoredTapAt(resolved, 'key-l');

    engine.beginPointerAt(1, q.x, q.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 4);
    expect(commits).toEqual(['key-q', 'key-l']);

    // Its byte is already on the wire, so a later slide cannot revise it. This
    // is the cost of resolving early, and it is confined to a slide that had
    // not begun when the next key was pressed.
    engine.movePointerAt(1, w.x, w.y, 20);
    engine.endPointerAt(1, w.x, w.y, 40);
    expect(commits).toEqual(['key-q', 'key-l']);
  });

  test('stages no provisional for a tap committed at touch-down', () => {
    const { engine, resolved, events } = harness();
    const a = anchoredTapAt(resolved, 'key-a');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.endPointerAt(1, a.x, a.y, 84);

    // A provisional beside the committed glyph would paint the character twice
    // for the whole contact: the overlay stages provisional and committed
    // glyphs additively.
    expect(events).toEqual(['commit:key-a']);
  });

  test('clears an overtaken contact provisional as its commit is emitted', () => {
    const { engine, resolved, events } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = anchoredTapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    expect(events).toEqual(['provisional:key-a']);

    engine.beginPointerAt(2, l.x, l.y, 4);

    // A's provisional is cleared as A commits, even though A's finger is still
    // down, so the provisional never sits beside the committed glyph. The
    // anchored tap stages no provisional of its own at all.
    expect(events).toEqual(['provisional:key-a', 'clear:1', 'commit:key-a', 'commit:key-l']);
  });

  test('an anchored tap yields a parked blocker and commits with no timer', () => {
    const { engine, resolved, commits, armed } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = anchoredTapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    // The blocker has been down past ROLLOVER_HOLD_MS, so it is a resting thumb
    // rather than a rollover partner and yields its place immediately.
    engine.beginPointerAt(2, l.x, l.y, 260);

    expect(commits).toEqual(['key-l']);
    expect(armed).toHaveLength(0);
  });

  test('arms no deadline when an anchored tap lands on a young blocker', () => {
    const { engine, resolved, commits, armed } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = anchoredTapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 10);

    expect(commits).toEqual(['key-a', 'key-l']);
    expect(armed).toHaveLength(0);
  });

  test('a held press-activated key does not push an anchored tap onto the queue', () => {
    const { engine, resolved, commits, armed } = harness();
    const backspace = anchoredTapAt(resolved, 'backspace');
    const l = anchoredTapAt(resolved, 'key-l');

    engine.beginPointerAt(1, backspace.x, backspace.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 10);

    // Backspace is decided too, so it is not an undecided contact and the letter
    // still takes the immediate path.
    expect(commits).toEqual(['backspace', 'key-l']);
    // The one timer is Backspace's repeat, not a rollover deadline.
    expect(armed).toHaveLength(1);
  });

  test('cancelling a resolved blocker leaves the anchored commit untouched', () => {
    const { engine, resolved, commits } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = anchoredTapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 4);
    expect(commits).toEqual(['key-a', 'key-l']);

    engine.cancelPointer(1);
    expect(commits).toEqual(['key-a', 'key-l']);
  });

  test('cancelling an anchored contact cannot unsend its character', () => {
    const { engine, resolved, commits } = harness();
    const a = anchoredTapAt(resolved, 'key-a');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.cancelPointer(1);

    // Documented behaviour, not an oversight: the byte reaches the PTY at
    // touch-down and nothing downstream can revise it. Backspace and the
    // modifiers have had this exposure since they became press-activated.
    expect(commits).toEqual(['key-a']);
  });

  test('flushes a buffered anchored commit with the outgoing layer', () => {
    const { engine, resolved, commits, layerIds } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = anchoredTapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 4);
    engine.updateGeometry(
      solveKeyboardGeometry(TERMINAL_US_LAYOUT, 'numbers', 402, 3, CUPERTINO_PORTRAIT_PROFILE),
    );

    expect(commits).toEqual(['key-a', 'key-l']);
    expect(layerIds).toEqual(['alpha', 'alpha']);
  });

  test('destroy cannot drop an anchored commit, because it already left', () => {
    const { engine, resolved, commits } = harness();
    const a = tapAt(resolved, 'key-a');
    const l = anchoredTapAt(resolved, 'key-l');

    engine.beginPointerAt(1, a.x, a.y, 0);
    engine.beginPointerAt(2, l.x, l.y, 4);
    engine.destroy();

    expect(commits).toEqual(['key-a', 'key-l']);
  });

  test('emits many anchored taps under a young blocker in press order', () => {
    const { engine, resolved, commits, armed } = harness();
    const a = tapAt(resolved, 'key-a');
    const q = anchoredTapAt(resolved, 'key-q');

    engine.beginPointerAt(1, a.x, a.y, 0);
    for (let index = 0; index < 12; index += 1) {
      engine.beginPointerAt(index + 2, q.x, q.y, 1);
      engine.endPointerAt(index + 2, q.x, q.y, 1);
    }

    expect(commits).toEqual(['key-a', ...Array.from({ length: 12 }, () => 'key-q')]);
    expect(armed).toHaveLength(0);
  });
});

function buildExhaustiveCandidateAtlas(
  resolved: ResolvedKeyboardGeometry,
  width: number,
  height: number,
): Uint8Array {
  const noKey = 255;
  const keyCount = resolved.keys.length;
  const atlas = new Uint8Array(width * height * KEYBOARD_CANDIDATE_COUNT);
  const xDistances = new Float32Array(width * keyCount);
  const yDistances = new Float32Array(height * keyCount);

  for (let x = 0; x < width; x += 1) {
    const sampleX = x + 0.5;
    for (const key of resolved.keys) {
      const right = key.rect.x + key.rect.width;
      const dx =
        sampleX < key.rect.x ? key.rect.x - sampleX : sampleX > right ? sampleX - right : 0;
      const centerDx = sampleX - key.rect.x - key.rect.width * 0.5;
      xDistances[x * keyCount + key.index] = dx * dx + centerDx * centerDx * 1e-9;
    }
  }
  for (let y = 0; y < height; y += 1) {
    const sampleY = y + 0.5;
    for (const key of resolved.keys) {
      const bottom = key.rect.y + key.rect.height;
      const dy =
        sampleY < key.rect.y ? key.rect.y - sampleY : sampleY > bottom ? sampleY - bottom : 0;
      const centerDy = sampleY - key.rect.y - key.rect.height * 0.5;
      yDistances[y * keyCount + key.index] = dy * dy + centerDy * centerDy * 1e-9;
    }
  }

  const distances = new Float64Array(KEYBOARD_CANDIDATE_COUNT);
  const indices = new Uint8Array(KEYBOARD_CANDIDATE_COUNT);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      distances.fill(Number.POSITIVE_INFINITY);
      indices.fill(noKey);
      for (let keyIndex = 0; keyIndex < keyCount; keyIndex += 1) {
        const distance =
          (xDistances[x * keyCount + keyIndex] ?? Number.POSITIVE_INFINITY) +
          (yDistances[y * keyCount + keyIndex] ?? Number.POSITIVE_INFINITY);
        for (let position = 0; position < KEYBOARD_CANDIDATE_COUNT; position += 1) {
          const currentDistance = distances[position] ?? Number.POSITIVE_INFINITY;
          const currentIndex = indices[position] ?? noKey;
          if (
            distance > currentDistance ||
            (distance === currentDistance && keyIndex >= currentIndex)
          ) {
            continue;
          }
          for (let shift = KEYBOARD_CANDIDATE_COUNT - 1; shift > position; shift -= 1) {
            distances[shift] = distances[shift - 1] ?? Number.POSITIVE_INFINITY;
            indices[shift] = indices[shift - 1] ?? noKey;
          }
          distances[position] = distance;
          indices[position] = keyIndex;
          break;
        }
      }
      atlas.set(indices, (y * width + x) * KEYBOARD_CANDIDATE_COUNT);
    }
  }
  return atlas;
}

describe('touch trace', () => {
  test('reports the centre the engine scored the committed key against', () => {
    const resolved = geometry();
    const key = resolved.keys.find((candidate) => candidate.definition.id === 'key-e');
    if (key === undefined) throw new Error('Missing key key-e');
    const model = createKeyboardSpatialPrior(resolved);
    const centerX = Float64Array.from(model.centerX);
    const centerY = Float64Array.from(model.centerY);
    centerX[key.index] = (centerX[key.index] ?? 0) + 3;
    centerY[key.index] = (centerY[key.index] ?? 0) - 2;
    const traces: KeyboardTouchTrace[] = [];
    const engine = createKeyboardEngine({
      geometry: resolved,
      profile: CUPERTINO_PORTRAIT_PROFILE,
      touchModel: { ...model, centerX, centerY },
      onRawCommit() {},
      onTouchTrace: (trace) => traces.push(trace),
    });
    const visual = centerOf(resolved, 'key-e');
    const offAnchor = offAnchorOf(resolved, 'key-e');

    // Anchored: committed at touch-down, traced at lift.
    engine.beginPointerAt(1, visual.x, visual.y, 0);
    engine.endPointerAt(1, visual.x, visual.y, 60);
    // Release-decided: the lift is what commits it.
    engine.beginPointerAt(2, offAnchor.x, offAnchor.y, 200);
    engine.endPointerAt(2, offAnchor.x, offAnchor.y, 260);

    expect(traces.map((trace) => trace.predictedKey?.id)).toEqual(['key-e', 'key-e']);
    for (const trace of traces) {
      expect(trace.modelCenterX).toBeCloseTo(visual.x + 3, 9);
      expect(trace.modelCenterY).toBeCloseTo(visual.y - 2, 9);
    }
  });
});
