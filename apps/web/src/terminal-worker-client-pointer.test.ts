import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as protocol from '@merkur/protocol';
import { createMouseGestureOwner } from './terminal/pointer-input';
import { createTouchScroll } from './terminal/touch-scroll';

interface PointerTestEvent {
  readonly touches?: ReturnType<typeof touches>;
  readonly changedTouches?: ReturnType<typeof touches>;
  readonly pointerType?: string;
  readonly pointerId?: number;
  readonly button?: number;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly deltaY?: number;
  readonly deltaX?: number;
}
type TestGeometry = Record<string, never>;

const source = readFileSync(new URL('./terminal-worker-client.ts', import.meta.url), 'utf8');
function production(name: string): string {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf('\n  }\n', start);
  if (start < 0 || end < start) throw new Error(`missing ${name}`);
  return source.slice(start, end + 4);
}
function pointerHost() {
  const handlers = new Map<string, (event: PointerTestEvent) => void>();
  const records: protocol.DecodedInputRecord[] = [];
  const start = source.indexOf('  // ── Pointer events');
  const end = source.indexOf('  // ── CSS dimension management', start);
  const functions = [
    'selectionOwnsMouse',
    'sendMouseButtonEvent',
    'heldButton',
    'recordButton',
    'pointerMods',
    'sendScrollInput',
    'sendScrollNotches',
  ].map(production);
  const context = {
    ...protocol,
    container: {
      addEventListener: (name: string, handler: (event: PointerTestEvent) => void) =>
        handlers.set(name, handler),
      setPointerCapture() {},
      hasPointerCapture: () => false,
    },
    callbacks: {
      onMouseInput(bytes: Uint8Array) {
        const record = protocol.decodeInputRecord(bytes);
        if (record === null) throw new Error('invalid input record');
        records.push(record);
      },
    },
    selectionEnabled: false,
    selectionLayer: { isVisible: () => false },
    mouseGesture: createMouseGestureOwner(),
    mouseMotionDeduper: { reset() {} },
    mouseMode: 9,
    MM_CLICKS: 1,
    MM_DRAG: 2,
    MM_HOVER: 4,
    MM_WHEEL: 8,
    linkPress: null,
    linkTouch: null,
    linkModifierLatched: false,
    selectionDragCaret: null,
    touchScrolling: false,
    touchGlideFrame: 0,
    touchScroll: createTouchScroll(),
    lastCharHeight: 16,
    stopTouchGlide() {},
    refreshContainerBounds() {},
    pixelToCell: () => ({ col: 3, row: 4 }),
    pixelToCaret: () => ({ col: 3, row: 4 }),
    linkModifierHeld: () => false,
    wheelCell: { col: 0, row: 0 },
    syncPointerGeometry: () => ({}),
    terminalCellAtPointInto(
      _x: number,
      _y: number,
      _geometry: TestGeometry,
      cell: { col: number; row: number },
    ) {
      cell.col = 3;
      cell.row = 4;
    },
  };
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    functions.join('\n') + source.slice(start, end),
  );
  runInNewContext(code, context);
  return {
    context,
    records,
    dispatch(name: string, event: PointerTestEvent) {
      const handler = handlers.get(name);
      if (handler === undefined) throw new Error(`missing ${name}`);
      handler({
        preventDefault() {},
        timeStamp: 0,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        ...event,
      });
    },
  };
}
function touches(...identifiers: number[]) {
  const list = identifiers.map((identifier) => ({ identifier, clientX: 24, clientY: 64 }));
  return Object.assign(list, { item: (index: number) => list[index] ?? null });
}
for (const ending of ['touchend', 'touchcancel']) {
  test(`a reported touch press has exactly one release on ${ending}`, () => {
    const host = pointerHost();
    host.dispatch('touchstart', { touches: touches(7) });
    host.dispatch(ending, { touches: touches(), changedTouches: touches(7) });
    host.dispatch(ending, { touches: touches(), changedTouches: touches(7) });
    expect(host.records.map((record) => (record.kind === 'mouse' ? record.action : -1))).toEqual([
      protocol.MOUSE_ACTION_PRESS,
      protocol.MOUSE_ACTION_RELEASE,
    ]);
    expect(
      host.records.every(
        (record) => record.kind === 'mouse' && record.button === protocol.MOUSE_BUTTON_LEFT,
      ),
    ).toBe(true);
  });
}

test('a physical right click reports one press and one release', () => {
  const host = pointerHost();
  const event = { pointerType: 'mouse', pointerId: 1, button: 2, clientX: 24, clientY: 64 };
  host.dispatch('pointerdown', event);
  host.dispatch('contextmenu', event);
  host.dispatch('pointerup', event);
  expect(host.records.map((record) => (record.kind === 'mouse' ? record.action : -1))).toEqual([
    protocol.MOUSE_ACTION_PRESS,
    protocol.MOUSE_ACTION_RELEASE,
  ]);
  expect(
    host.records.every(
      (record) => record.kind === 'mouse' && record.button === protocol.MOUSE_BUTTON_RIGHT,
    ),
  ).toBe(true);
});

for (const [modifier, mods] of [
  ['ctrlKey', protocol.KEY_MOD_CTRL],
  ['altKey', protocol.KEY_MOD_ALT],
] as const) {
  test(`wheel reports preserve ${modifier}`, () => {
    const host = pointerHost();
    host.dispatch('wheel', { deltaY: 30, deltaX: 0, clientX: 24, clientY: 64, [modifier]: true });
    const record = host.records[0];
    if (record?.kind !== 'wheel') throw new Error('expected a wheel record');
    expect(record.mods).toBe(mods);
  });
}

for (const [deltaX, direction] of [
  [-20, protocol.WHEEL_LEFT],
  [20, protocol.WHEEL_RIGHT],
] as const) {
  test(`horizontal wheel ${deltaX} emits only its horizontal direction`, () => {
    const host = pointerHost();
    host.dispatch('wheel', { deltaX, deltaY: 0, clientX: 24, clientY: 64 });
    const record = host.records[0];
    if (record?.kind !== 'wheel') throw new Error('expected a wheel record');
    expect(record.direction).toBe(direction);
    expect(host.records).toHaveLength(1);
  });
}

test('a stationary wheel event emits no notch', () => {
  const host = pointerHost();
  host.dispatch('wheel', { deltaX: 0, deltaY: 0 });
  expect(host.records).toEqual([]);
});
