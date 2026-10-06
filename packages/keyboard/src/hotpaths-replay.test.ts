import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createKeyboardEngine, type KeyboardEngine } from './engine';
import {
  CUPERTINO_LANDSCAPE_PROFILE,
  CUPERTINO_PORTRAIT_PROFILE,
  hitTestKeyboard,
  keyboardHitAtlasOffset,
  solveKeyboardGeometry,
} from './geometry';
import { TERMINAL_US_LAYOUT } from './layouts/terminal-us';
import { createKeyboardOffsetModel } from './offset-model';
import { classifyKeyboardTouch, createKeyboardSpatialPrior } from './touch-model';
import type { KeyboardTouchTrace, ResolvedKeyboardKey } from './types';

// Captured before optimization at 9c111c036c7621ecac8da6e7bcac93217d34d502.
// Each digest covers every decision, spatial winner, learning acceptance,
// intermediate covariance/coefficient/residual snapshot and applied centre.
const expected: Record<string, string> = {
  '320.5/alpha/false': '4a54a043d60d7097ac0ed76b2b6d8c6b776792990f3f9c21161517695730aeba',
  '320.5/alpha/true': '3342ec477ca82a6e1a1e257487b2ceee463511b39531554f874b35afddcf64de',
  '320.5/numbers/false': '7c4f0d209f0f9691583bbb39f607a69dd870359ce24f1e7d82168e8c633e545e',
  '320.5/numbers/true': 'c2bc00c21f1de5ab24c5893ff5acd270bb65aa0afd7f902d4ccbb8408413106d',
  '320.5/symbols/false': '2984c671f6f639134c3ed4defecffbbe49ef0e0cf9c97be779701ee3888e3922',
  '320.5/symbols/true': 'af4f3000029060cc299ecdb4e19d5297db5a421331732f9d206facd6896e7170',
  '320.5/pc/false': 'c0b415176aadadd67c47993b2aee08be624e8e8ac3bdf1b6ae9044d9fb30fc9d',
  '320.5/pc/true': '0609840123379f0f71aabe7a965fe7dfacb2d455626fcc4a1933cd36d59b6753',
  '402/alpha/false': '538e40cfea815520431911bf1d6faca06f445c56848bad38b3ad81eb71d627eb',
  '402/alpha/true': '9ac171de39805d76d7bb22e5880ce363c653baa05cb9501b1d1f5ab624232ff7',
  '402/numbers/false': 'c9f42f62229dd2bf0027343e63729f2b56bd67b128c66020578cc083b9cd52f8',
  '402/numbers/true': '5d063b46108c6f890f481ef646cb29efe1f31c89228e7c26c5acc73c5963dea4',
  '402/symbols/false': 'e078b658a2956b8e6b07d5067f8eafb348350c12656004dfee91403654d05079',
  '402/symbols/true': '7f831895b0d600c67c60b6876df6f9b3851f12e1bad17d7129874a6e850806ef',
  '402/pc/false': '3a73246899c397a851e084d1715fc70e183396054525e10bc4e35abc20cd99a6',
  '402/pc/true': '494cf45a5c0e4929b2080c33bcb506e1ca87d85283e51589b6b63a8c4659d79f',
  '844/alpha/false': '6c0d21e1dbfc8f95a89160b6d63f442587a7f1336c47aa84023d0fb7dd33e605',
  '844/alpha/true': '4ea372e0936fed30d79f4c4f12f4229d723e2427658c3430babc28a20deeb898',
  '844/numbers/false': '4f1140979b4ab5fe26077abb4b16d6f8842419f8e2f75e9e1d20c5609409a57b',
  '844/numbers/true': 'c75dc734d5ac438cfe53e29e41335a62acf7492dca46b4d9b4385c0788f0b935',
  '844/symbols/false': '02a06838130f6586611b7a7c86ed68a1cc0f378579d80e3ef5227a28e26d1734',
  '844/symbols/true': 'c340b1ed3b802fc7836722ab5e2089d1ec132734bd29d5621f23efb67d03500e',
  '844/pc/false': '146c8c6a218e43a57f9c2965c7bb04883b48b1f5ef2586246703675dd1157a72',
  '844/pc/true': '15b9cdf2f78fbf2df8348cf4d85752388507bbcb0d3ec6bbc78525edb272662a',
};

for (const width of [320.5, 402, 844]) {
  for (const layer of Object.keys(TERMINAL_US_LAYOUT.layers)) {
    for (const gripField of [false, true]) {
      const label = `${width}/${layer}/${gripField}`;
      test(`differential touch/learner replay ${label}`, () => {
        const profile = width > 500 ? CUPERTINO_LANDSCAPE_PROFILE : CUPERTINO_PORTRAIT_PROFILE;
        const geometry = solveKeyboardGeometry(TERMINAL_US_LAYOUT, layer, width, 2.75, profile);
        const base = createKeyboardSpatialPrior(geometry);
        // Exercise covariance cross terms as well as the diagonal spatial prior.
        for (const key of geometry.keys) {
          const xx = base.precisionXX[key.index] ?? 0;
          const yy = base.precisionYY[key.index] ?? 0;
          base.precisionXY[key.index] = Math.sqrt(xx * yy) * (key.index % 2 === 0 ? 0.4 : -0.4);
        }
        const model = createKeyboardOffsetModel({ gripField });
        const hash = createHash('sha256');
        const output = (value: unknown): void => {
          hash.update(JSON.stringify(value));
        };
        let state = 0x41c6ce57;
        const random = (): number => {
          state = (Math.imul(state, 1664525) + 1013904223) | 0;
          return (state >>> 0) / 0x1_0000_0000;
        };
        const spatial = new Int16Array(1);
        let applied = base;
        const finitePrior = Float64Array.from(geometry.keys, () => -random() * 8);
        const guardedPrior = finitePrior.slice();
        for (const key of geometry.keys) {
          if (key.definition.value?.length !== 1) guardedPrior[key.index] = Number.NaN;
        }
        const engine = createKeyboardEngine({
          geometry,
          profile,
          touchModel: applied,
          onCommit: output,
          onRawProvisional: (key, layerId, pointer) => output([key?.index, layerId, pointer]),
          onTouchTrace: output,
          onKeyStateChange: (key, active) => output([key, active]),
          timers: { set: () => 0, clear: () => {} },
        });
        function scoreSamples(
          key: ResolvedKeyboardKey,
          x: number,
          y: number,
          tx: number,
          ty: number,
          rx: number,
          ry: number,
          prior: Float64Array | null,
        ): void {
          const cx = key.rect.x + key.rect.width / 2;
          const cy = key.rect.y + key.rect.height / 2;
          for (const weight of [0, 0.1, 0.4, 1]) {
            output([
              hitTestKeyboard(geometry, x, y),
              keyboardHitAtlasOffset(geometry, x, y),
              classifyKeyboardTouch(
                geometry,
                applied,
                x,
                y,
                tx,
                ty,
                rx,
                ry,
                weight,
                prior,
                0.25,
                spatial,
              ),
              spatial[0],
            ]);
          }
          // Pin visual anchors, including their exact edge, and out-of-board samples.
          for (const ax of [cx, cx + key.rect.width * 0.25, -1, width, Number.NaN]) {
            output([
              hitTestKeyboard(geometry, ax, cy),
              keyboardHitAtlasOffset(geometry, ax, cy),
              classifyKeyboardTouch(
                geometry,
                applied,
                ax,
                cy,
                ax,
                cy,
                ax,
                cy,
                0,
                prior,
                20,
                spatial,
              ),
              spatial[0],
            ]);
          }
        }
        for (let index = 0; index < 1200; index += 1) {
          const key = geometry.keys[index % geometry.keys.length];
          if (key === undefined) throw new Error('empty replay geometry');
          const cx = key.rect.x + key.rect.width / 2;
          const cy = key.rect.y + key.rect.height / 2;
          const x = cx + (random() - 0.5) * key.rect.width * 1.6;
          const y = cy + (random() - 0.5) * key.rect.height * 1.6;
          const tx = x + (random() - 0.5) * 25;
          const ty = y + (random() - 0.5) * 25;
          const rx = tx + (random() - 0.5) * 75;
          const ry = ty + (random() - 0.5) * 75;
          const prior = index % 3 === 0 ? null : index % 3 === 1 ? finitePrior : guardedPrior;
          scoreSamples(key, x, y, tx, ty, rx, ry, prior);
          const trace: KeyboardTouchTrace = {
            predictedKey: index % 31 === 0 ? null : key.definition,
            layerId: index % 29 === 0 ? 'missing' : layer,
            pointerId: 1,
            downX: index % 37 === 0 ? Number.NaN : x,
            downY: y,
            trajectoryX: tx,
            trajectoryY: ty,
            releaseX: rx,
            releaseY: ry,
            durationMs: 84,
            sampleCount: 4,
            contactAtMs: index * 100,
            modelCenterX: cx,
            modelCenterY: cy,
            spatialKey: key.definition,
          };
          output(
            index % 7 === 0
              ? model.recordCorrection(
                  trace,
                  geometry,
                  index % 49 === 0 ? 'missing' : key.definition.id,
                )
              : model.record(trace, geometry),
          );
          if (index % 25 === 0) {
            applied = model.apply(geometry, base);
            output(model.snapshot());
            hash.update(new Uint8Array(applied.centerX.buffer));
            hash.update(new Uint8Array(applied.centerY.buffer));
            engine.updateTouchModel(applied);
          }
          engine.setKeyPrior(prior);
          replayEngineContact(engine, output, index, x, y, tx, ty, rx, ry);
          if (index === 499) model.restore(model.snapshot());
          if (index === 899) model.reset();
        }
        engine.destroy();
        output([model.snapshot(), model.learnedKeyCount(), model.fieldSampleCount()]);
        expect(hash.digest('hex')).toBe(expected[label] ?? '');
      });
    }
  }
}

function replayEngineContact(
  engine: KeyboardEngine,
  output: (value: unknown) => void,
  index: number,
  x: number,
  y: number,
  tx: number,
  ty: number,
  rx: number,
  ry: number,
): void {
  const time = index * 100;
  output(engine.beginPointerAt(1, x, y, time));
  // Two-thumb rollover in both release orders; lost-up and cancellation.
  if (index % 5 === 0) output(engine.beginPointerAt(2, tx, ty, time + 5));
  output(engine.movePointerAt(1, tx, ty, time + 40));
  if (index % 10 === 0) output(engine.endPointerAt(2, tx, ty, time + 50));
  if (index % 17 === 0) output(engine.cancelPointer(1));
  else if (index % 19 !== 0) output(engine.endPointerAt(1, rx, ry, time + 84));
  if (index % 10 === 5) output(engine.endPointerAt(2, tx, ty, time + 90));
}
