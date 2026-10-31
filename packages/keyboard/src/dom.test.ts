import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createKeyboardEngine } from './engine';
import { CUPERTINO_PORTRAIT_PROFILE, solveKeyboardGeometry } from './geometry';
import { createKeyboardLayout } from './layout';
import { TERMINAL_US_LAYOUT } from './layouts/terminal-us';

const source = readFileSync(new URL('./dom.ts', import.meta.url), 'utf8');
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  ['refreshGeometry', 'setLayer']
    .map((name) => {
      const start = source.indexOf(`  function ${name}(`);
      const end = source.indexOf('\n  }\n', start);
      if (start < 0 || end < start) throw new Error(`missing ${name}`);
      return source.slice(start, end + 4);
    })
    .join('\n'),
);

test('held character commits once when the DOM adapter switches layers', () => {
  const profile = CUPERTINO_PORTRAIT_PROFILE;
  const layout = createKeyboardLayout(TERMINAL_US_LAYOUT);
  const alpha = solveKeyboardGeometry(layout, 'alpha', 390, 3, profile);
  const numbers = solveKeyboardGeometry(layout, 'numbers', 390, 3, profile);
  const letter = alpha.keys.find((key) => key.definition.value === 'a');
  const layer = alpha.keys.find((key) => key.definition.targetLayer === 'numbers');
  if (letter === undefined || layer === undefined) throw new Error('bundled keys missing');
  const committed: string[] = [];
  let switchLayer: (id: string) => void = () => {};
  const engine = createKeyboardEngine({
    geometry: alpha,
    profile,
    onRawCommit(key) {
      if (key.definition.targetLayer !== undefined) switchLayer(key.definition.targetLayer);
      else committed.push(key.definition.value ?? key.definition.id);
    },
  });
  const context = {
    engine,
    enginePointerCapacity: profile.maximumPointers,
    geometry: alpha,
    layout,
    layerId: 'alpha',
    destroyed: false,
    cachedLayout: layout,
    cachedWidth: 390,
    cachedDpr: 3,
    cachedProfile: profile,
    profileSource: profile,
    touchModelSource: undefined,
    geometryCache: new Map([
      ['alpha', alpha],
      ['numbers', numbers],
    ]),
    window: { devicePixelRatio: 3 },
    root: {
      hidden: false,
      getBoundingClientRect: () => ({ width: 390 }),
      setAttribute() {},
      style: { setProperty() {} },
    },
    surface: { style: {} },
    options: {},
    keyboardOrientation: () => 'portrait',
    resolveProfile: () => profile,
    sameGeometryProfile: () => true,
    resolveTouchModel: () => undefined,
    renderKeys() {},
    setStylePx() {},
    scheduleGeometryPrewarm() {},
  };
  runInNewContext(program, context);
  switchLayer = (id) => runInNewContext(`setLayer(${JSON.stringify(id)})`, context);
  const x = letter.rect.x + letter.rect.width * 0.85;
  const y = letter.rect.y + letter.rect.height / 2;
  engine.beginPointerAt(1, x, y, 0);
  expect(committed).toEqual([]);
  engine.beginPointerAt(
    2,
    layer.rect.x + layer.rect.width / 2,
    layer.rect.y + layer.rect.height / 2,
    300,
  );
  engine.endPointerAt(1, x, y, 310);
  engine.endPointerAt(2, layer.rect.x, layer.rect.y, 320);
  expect(context.layerId).toBe('numbers');
  expect(committed).toEqual(['a']);
  engine.destroy();
});
