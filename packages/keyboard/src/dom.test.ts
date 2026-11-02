import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createDomKeyboard, type DomKeyboardController, type DomKeyboardOptions } from './dom';
import { CUPERTINO_PORTRAIT_PROFILE } from './geometry';
import { TERMINAL_US_LAYOUT } from './layouts/terminal-us';
import type { KeyboardGeometryProfile, ResolvedKeyboardGeometry } from './types';

/** What the adapter reads from a pointer event. */
interface FakePointerEvent {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly timeStamp: number;
  readonly button: number;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Just enough DOM to run the real adapter: elements that hold children,
 * attributes, text and listeners, and a root whose width the test sets. The
 * adapter is driven through its own pointer listeners, so every path below is
 * the one a browser takes.
 */
class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> & { setProperty(name: string, value: string): void };
  readonly classList = { add() {}, remove() {} };
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event: FakePointerEvent) => void)[]>();
  className = '';
  hidden = false;
  textContent = '';
  type = '';
  width = 0;

  constructor(readonly tagName: string) {
    const style: Record<string, string> = {};
    this.style = Object.assign(style, {
      setProperty(name: string, value: string) {
        style[name] = value;
      },
    });
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.attributes.has(name);
    if (on) this.attributes.set(name, '');
    else this.attributes.delete(name);
    return on;
  }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      if (node.tagName === '#fragment') this.children.push(...node.children.splice(0));
      else this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    this.append(...nodes);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.width };
  }
  addEventListener(type: string, listener: (event: FakePointerEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(): void {}
  setPointerCapture(): void {}
  hasPointerCapture(): boolean {
    return false;
  }
  releasePointerCapture(): void {}
}

// Every element the fake document made, so a test can reach the fake behind
// the typed element the adapter was given.
const created: FakeElement[] = [];
let saved = {};

beforeEach(() => {
  created.length = 0;
  saved = {
    document: globalThis.document,
    window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  const make = (tag: string) => {
    const element = new FakeElement(tag);
    created.push(element);
    return element;
  };
  Object.assign(globalThis, {
    document: { createElement: make, createDocumentFragment: () => make('#fragment') },
    window: {
      devicePixelRatio: 3,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {},
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: () => 0,
  });
});

afterEach(() => {
  Object.assign(globalThis, saved);
});

interface Harness {
  readonly root: FakeElement;
  readonly controller: DomKeyboardController;
  readonly commits: string[];
  readonly geometryChanges: ResolvedKeyboardGeometry[];
  down(pointerId: number, keyId: string, fraction: number, timeStamp: number): void;
  up(pointerId: number, keyId: string, fraction: number, timeStamp: number): void;
  surface(): FakeElement;
}

function mount(options: Partial<DomKeyboardOptions> = {}): Harness {
  const element = document.createElement('div');
  const root = created.at(-1);
  if (root === undefined) throw new Error('the fake document made no root');
  root.width = 390;
  const commits: string[] = [];
  const geometryChanges: ResolvedKeyboardGeometry[] = [];
  const controller = createDomKeyboard(element, {
    layout: TERMINAL_US_LAYOUT,
    profile: CUPERTINO_PORTRAIT_PROFILE,
    onKey: (key) => commits.push(key.id),
    onGeometryChange: (geometry) => geometryChanges.push(geometry),
    ...options,
  });
  // Where each pointer pressed, so its release can be sent to the same spot
  // after the layer under it has changed.
  const pressedAt = new Map<number, { x: number; y: number }>();
  const fire = (type: string, pointerId: number, at: { x: number; y: number }, t: number) => {
    for (const listener of root.listeners.get(type) ?? []) {
      listener({
        pointerId,
        clientX: at.x,
        clientY: at.y,
        timeStamp: t,
        button: 0,
        preventDefault() {},
        stopPropagation() {},
      });
    }
  };
  const pointOf = (keyId: string, fraction: number) => {
    const key = controller.getGeometry()?.keys.find((k) => k.definition.id === keyId);
    if (key === undefined) throw new Error(`Missing key ${keyId}`);
    return { x: key.rect.x + key.rect.width * fraction, y: key.rect.y + key.rect.height / 2 };
  };
  return {
    root,
    controller,
    commits,
    geometryChanges,
    down(pointerId, keyId, fraction, t) {
      const at = pointOf(keyId, fraction);
      pressedAt.set(pointerId, at);
      fire('pointerdown', pointerId, at, t);
    },
    up(pointerId, keyId, fraction, t) {
      fire('pointerup', pointerId, pressedAt.get(pointerId) ?? pointOf(keyId, fraction), t);
    },
    surface() {
      const surface = root.children[0];
      if (surface === undefined) throw new Error('no key surface');
      return surface;
    },
  };
}

function shownKey(harness: Harness, keyId: string): FakeElement | undefined {
  return harness.surface().children.find((child) => child.dataset.keyId === keyId);
}

test('a resting thumb commits once when the other thumb switches layers', () => {
  const harness = mount();
  // Off its anchor, so 'a' is still undecided; held past the rollover window,
  // so the layer key's press yields it rather than resolving it.
  harness.down(1, 'key-a', 0.85, 0);
  harness.down(2, 'layer-numbers', 0.5, 300);
  harness.up(1, 'key-a', 0.85, 310);
  harness.up(2, 'layer-numbers', 0.5, 320);

  expect(harness.controller.getLayer()).toBe('numbers');
  expect(harness.commits).toEqual(['key-a']);
  // The numbers layer is what is in the document now, with nothing left pressed.
  expect(shownKey(harness, 'key-a')).toBeUndefined();
  expect(harness.surface().children.some((child) => child.hasAttribute('data-pressed'))).toBe(
    false,
  );
});

test('a prior weight change reaches the engine without rebuilding the geometry', () => {
  let profile: KeyboardGeometryProfile = CUPERTINO_PORTRAIT_PROFILE;
  const harness = mount({ profile: () => profile });
  const geometry = harness.controller.getGeometry();
  const s = geometry?.keys.find((key) => key.definition.id === 'key-s');
  if (geometry === null || s === undefined) throw new Error('alpha layer missing');
  // Every key has statistics; 's' is one nat likelier, too little to outweigh
  // a tap on 'a' at the shipped weight and enough at four.
  const prior = new Float64Array(geometry.keys.length).fill(-1);
  prior[s.index] = 0;
  const tap = (t: number): string | undefined => {
    harness.commits.length = 0;
    harness.down(1, 'key-a', 0.85, t);
    harness.up(1, 'key-a', 0.85, t + 60);
    return harness.commits[0];
  };

  harness.controller.setKeyPrior(prior);
  expect(tap(0)).toBe('key-a');
  profile = { ...CUPERTINO_PORTRAIT_PROFILE, priorWeight: 4 };
  harness.controller.setProfile(() => profile);
  expect(harness.controller.getGeometry()).toBe(geometry);
  expect(tap(1_000)).toBe('key-s');
});

test('every geometry swap is announced, a resize as much as a layer switch', () => {
  const harness = mount();
  expect(harness.geometryChanges.map((geometry) => geometry.layerId)).toEqual(['alpha']);

  harness.controller.setLayer('numbers');
  harness.root.width = 402;
  harness.controller.refreshGeometry();

  expect(harness.geometryChanges.map((geometry) => [geometry.layerId, geometry.width])).toEqual([
    ['alpha', 390],
    ['numbers', 390],
    ['numbers', 402],
  ]);
});

test('a layer shown after a Shift change carries the legends and state for it', () => {
  const harness = mount();
  harness.controller.setLayer('numbers');
  harness.controller.setModifiers(['shift']);
  harness.controller.setLayer('alpha');

  expect(shownKey(harness, 'key-a')?.textContent).toBe('A');
  expect(shownKey(harness, 'shift')?.getAttribute('aria-pressed')).toBe('true');

  harness.controller.setModifiers([]);
  expect(shownKey(harness, 'key-a')?.textContent).toBe('a');
  expect(shownKey(harness, 'shift')?.getAttribute('aria-pressed')).toBe('false');
});
