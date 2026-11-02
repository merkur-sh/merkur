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

// Each digest covers every decision, spatial winner, learning acceptance,
// intermediate covariance/coefficient/residual snapshot and applied centre, in
// the order the engine emits them: a release-decided contact's trace follows
// its commit.
const expected: Record<string, string> = {
  '320.5/alpha/false': 'e83a0ea31ddffff461a9fb07d2b277a7189b168c240351ed4be7e93ea715d446',
  '320.5/alpha/true': 'd13cbbf23008598b5ac5c4d35c633e9dc95b5334c8b21158914b34e5ccb639df',
  '320.5/numbers/false': '518ce5ae58f5f060b560b78d7f3ddf64d36407b47767731e73740d22f7afe653',
  '320.5/numbers/true': 'c4cbb969fa8740cfa6a00ae1a356cac208c575a5e63ff859895cb477a3da795f',
  '320.5/symbols/false': '2e79d43fd316ec20a19019a149eba3d40ebdca4993b00f8a294de9e6162e9dd6',
  '320.5/symbols/true': '936a40448b0ca4a90b94070d7623ed9011f7f41248b0b85b1a0fd2d229e9f9c3',
  '320.5/pc/false': '326d465e7809e014745384e994c2ef85f84e76f1a519eefc44cbb5700552b2ed',
  '320.5/pc/true': '17fdbb645f3826199ee2c42a44440e262a23502416f61cf3e40c1f60c30bbbd6',
  '402/alpha/false': 'b65f23eb18383130ab613a7d3e4747fb6fc918d699ff3af5bd067bf7a4113a35',
  '402/alpha/true': 'af002c4f3d03077e01b362e7564cfd75ce27f939700abb6b8c998d77c6fb7dd0',
  '402/numbers/false': 'b52866acebde8790dd8626ab5e59ce3d8c22f33cd1ee5751a22136cdf68cff88',
  '402/numbers/true': 'dde95194d458a64cdd72ef942f1b093c3e49fe14d28413e3747db4f49379d77e',
  '402/symbols/false': '5f780d0a6449c9bd11989da89e334b58c758c9d02e555b30470517d99a06109f',
  '402/symbols/true': '22d62bbfe881c4e5e4ecb6d3eb424d4bc6ac0cffd886e56d7039cde0e9fb0356',
  '402/pc/false': 'fcbc2b44b66568ee3c2dc1d7157a3efa86c33e99d509a9427b110c916adf8b90',
  '402/pc/true': 'a9f40ba556ab2088f516d230f384d32838fa75906ef721372faf620ab6f50b8a',
  '844/alpha/false': '622738679793a2d6ccc500c9519c5d6c10d9bfa1f4063cb26fd10d8fa040ec59',
  '844/alpha/true': 'f76932adc3403d3a39aa7d83a44e68b379cc6d997871dbd56fcca5d8848228a2',
  '844/numbers/false': 'd022ece2b36b4a3f8b827222ab0918c89eb45728e31e3758fd4c4bea94c99e43',
  '844/numbers/true': '26216a03bcd144bceb28fd883222157f6045d3a7fffa0f773ce72f1d73b7f495',
  '844/symbols/false': '8f599cbc5bcb1fc4b5f9f4061ba7efb11f81c8a82e0ffd641fc9254e918d047f',
  '844/symbols/true': '480e7e63c1fdfe22b31adadc1b928e044cac5deda616ee352782302231b2f7dc',
  '844/pc/false': 'ea92d84aac227398ddf0b1a5c26d74aacb4d98e912dc89819a4996515afc5ae4',
  '844/pc/true': '94a5f8094acaa52621334288190fe08a78c2a7d7b33b9b0154c94ee7bf5d63de',
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
