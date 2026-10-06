import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createAccessibilityMirror } from './accessibility-mirror';

class FakeElement {
  readonly style = { cssText: '' };
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  textContent = '';

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  appendChild(child: FakeElement): void {
    this.children.push(child);
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  remove(): void {}
}

interface Harness {
  readonly mirror: ReturnType<typeof createAccessibilityMirror>;
  readonly reads: () => number;
  readonly announcements: () => string[];
  setViewport(text: string): void;
  setSuppressed(value: boolean): void;
}

function createHarness(): Harness {
  let reads = 0;
  let viewport = 'baseline';
  let suppressed = false;
  const mirror = createAccessibilityMirror({
    getViewportText(callback) {
      reads += 1;
      callback(viewport);
      return true;
    },
    getCursorRow: () => null,
    isSuppressed: () => suppressed,
  });
  const element = mirror.element as unknown as FakeElement;
  return {
    mirror,
    reads: () => reads,
    announcements: () => element.children.map((child) => child.textContent),
    setViewport(text) {
      viewport = text;
    },
    setSuppressed(value) {
      suppressed = value;
    },
  };
}

describe('accessibility mirror', () => {
  const originalDocument = globalThis.document;

  beforeEach(() => {
    (globalThis as { document?: unknown }).document = {
      createElement: () => new FakeElement(),
    };
  });

  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDocument;
  });

  test('the first change takes the baseline silently; only a settle announces', () => {
    const h = createHarness();
    const element = h.mirror.element as unknown as FakeElement;
    expect(element.attributes.has('data-baseline')).toBe(false);
    h.mirror.noteOutputChanged();
    expect(h.reads()).toBe(1);
    expect(h.announcements()).toEqual([]);
    // Marked only once the baseline read has landed.
    expect(element.attributes.has('data-baseline')).toBe(true);

    // Further changes inside the burst read nothing: the worker decides when
    // the output has settled, and this side owns no timer.
    h.setViewport('replacement');
    h.mirror.noteOutputChanged();
    h.mirror.noteOutputChanged();
    expect(h.reads()).toBe(1);

    h.mirror.noteOutputSettled();
    expect(h.reads()).toBe(2);
    expect(h.announcements()).toEqual(['replacement']);

    // A settle with nothing new announces nothing.
    h.mirror.noteOutputSettled();
    expect(h.reads()).toBe(3);
    expect(h.announcements()).toEqual(['replacement']);
    h.mirror.destroy();
  });

  test('a settle before any change still establishes the baseline silently', () => {
    const h = createHarness();
    h.mirror.noteOutputSettled();
    expect(h.reads()).toBe(1);
    expect(h.announcements()).toEqual([]);
    h.setViewport('next');
    h.mirror.noteOutputSettled();
    expect(h.announcements()).toEqual(['next']);
    h.mirror.destroy();
  });

  test('a settle that lands while a read is in flight reads once more after it', () => {
    let reads = 0;
    let pending: ((text: string) => void) | null = null;
    const mirror = createAccessibilityMirror({
      getViewportText(callback) {
        reads += 1;
        pending = callback;
        return true;
      },
      getCursorRow: () => null,
      isSuppressed: () => false,
    });
    const element = mirror.element as unknown as FakeElement;

    mirror.noteOutputChanged();
    expect(reads).toBe(1);
    mirror.noteOutputSettled();
    expect(reads).toBe(1);

    const first = pending as ((text: string) => void) | null;
    if (first === null) throw new Error('no read in flight');
    first('baseline');
    expect(reads).toBe(2);
    const second = pending as ((text: string) => void) | null;
    if (second === null || second === first) throw new Error('no follow-up read');
    second('after');
    expect(element.children.map((child) => child.textContent)).toEqual(['after']);
    mirror.destroy();
  });

  test('output while suppressed marks the baseline stale; the next settle resyncs silently', () => {
    const h = createHarness();
    h.mirror.noteOutputChanged();
    expect(h.reads()).toBe(1);

    h.setSuppressed(true);
    h.setViewport('full-screen app');
    h.mirror.noteOutputChanged();
    h.mirror.noteOutputSettled();
    expect(h.reads()).toBe(1);

    h.setSuppressed(false);
    h.setViewport('restored shell');
    h.mirror.noteOutputSettled();
    expect(h.reads()).toBe(2);
    expect(h.announcements()).toEqual([]);

    h.setViewport('new output');
    h.mirror.noteOutputSettled();
    expect(h.announcements()).toEqual(['new output']);
    h.mirror.destroy();
  });

  test('a resize announces by membership: the shift is silent, new output is not', () => {
    const h = createHarness();
    h.setViewport('one\ntwo\nthree');
    h.mirror.noteOutputChanged();
    expect(h.reads()).toBe(1);
    expect(h.announcements()).toEqual([]);

    // The panel commits a taller grid. The daemon re-wraps and re-snapshots, so
    // every row lands at a different index — a row-keyed diff across that
    // boundary reports the whole screen as new output. Output that genuinely
    // arrived in the same settle must still be announced, which is what makes
    // swallowing the read wrong: a resize is routinely followed immediately by
    // a command whose output lands in that very settle.
    h.mirror.noteResized();
    h.setViewport('\none\ntwo\nthree\nfour');
    h.mirror.noteOutputSettled();
    expect(h.reads()).toBe(2);
    expect(h.announcements()).toEqual(['four']);

    // A resize that moves nothing the user has not already heard is silent.
    h.mirror.noteResized();
    h.setViewport('one\ntwo\nthree\nfour');
    h.mirror.noteOutputSettled();
    expect(h.announcements()).toEqual(['four']);

    // And the next settle is an ordinary positional diff again.
    h.setViewport('one\ntwo\nthree\nfour\nfive');
    h.mirror.noteOutputSettled();
    expect(h.announcements()).toEqual(['four', 'five']);
    h.mirror.destroy();
  });

  test('a read in flight when the grid resizes is discarded, not baselined', () => {
    let reads = 0;
    let pending: ((text: string) => void) | null = null;
    const mirror = createAccessibilityMirror({
      getViewportText(callback) {
        reads += 1;
        pending = callback;
        return true;
      },
      getCursorRow: () => null,
      isSuppressed: () => false,
    });
    const element = mirror.element as unknown as FakeElement;

    mirror.noteOutputChanged();
    expect(reads).toBe(1);
    const inFlight = pending as ((text: string) => void) | null;
    if (inFlight === null) throw new Error('no read in flight');

    // The resize commits while that read is still out. Its text describes a
    // grid that no longer exists, so it is neither a baseline nor a diff
    // source: baselining it would make the reflowed screen read as new output.
    mirror.noteResized();
    inFlight('narrow one\nnarrow two');
    expect(reads).toBe(1);

    mirror.noteOutputSettled();
    expect(reads).toBe(2);
    const reflowed = pending as ((text: string) => void) | null;
    if (reflowed === null || reflowed === inFlight) throw new Error('no follow-up read');
    reflowed('wide one two');
    expect(element.children.map((child) => child.textContent)).toEqual([]);
    mirror.destroy();
  });

  test('destroy stops every read', () => {
    const h = createHarness();
    h.mirror.destroy();
    h.mirror.noteOutputChanged();
    h.mirror.noteOutputSettled();
    expect(h.reads()).toBe(0);
  });
});
