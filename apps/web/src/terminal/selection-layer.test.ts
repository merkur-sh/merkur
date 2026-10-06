import { afterAll, describe, expect, test } from 'bun:test';
import { assembleSelectionText, caretPositionIn, rowCharIndexAt } from './selection-layer';

// `assembleSelectionText` is the whole of Merkur's copy semantics. The browser
// hands us a DOM range over the selection layer; everything that makes the
// resulting text a *terminal* selection rather than a DOM serialization happens
// here, so this is where the two rules that differ get pinned.

describe('selection copy assembly', () => {
  const noWrap = (rows: number): Uint8Array => new Uint8Array(Math.ceil(rows / 8));
  const wrapAt = (rows: number, ...wrapped: number[]): Uint8Array => {
    const bits = noWrap(rows);
    for (const row of wrapped) bits[row >> 3] = (bits[row >> 3] ?? 0) | (1 << (row & 7));
    return bits;
  };

  test('a selection reaching the row end drops the grid padding', () => {
    const row = 'echo hi     ';
    expect(assembleSelectionText([row], noWrap(1), 0, 0, 0, row.length)).toBe('echo hi');
  });

  test('a mid-row selection keeps the spaces the user dragged across', () => {
    // The old WASM reader trimmed the *sliced* range, so dragging from inside a
    // column of output silently lost the alignment the user selected.
    expect(assembleSelectionText(['a   b'], noWrap(1), 0, 1, 0, 4)).toBe('   ');
  });

  test('a soft-wrapped row joins its successor with no newline', () => {
    // A command that wrapped on screen is one line. Splitting it is what made a
    // copied command unrunnable when pasted back.
    expect(assembleSelectionText(['aaaa', 'bbbb'], wrapAt(2, 0), 0, 0, 1, 4)).toBe('aaaabbbb');
  });

  test('a wrapped row keeps its tail, because a full row has no padding to drop', () => {
    // Trailing blanks are padding only on a row that ended. A row that wraps
    // continues into the next one, so trimming its tail would corrupt the join
    // rather than tidy it.
    expect(assembleSelectionText(['ab  ', 'cd'], wrapAt(2, 0), 0, 0, 1, 2)).toBe('ab  cd');
    expect(assembleSelectionText(['ab  ', 'cd'], noWrap(2), 0, 0, 1, 2)).toBe('ab\ncd');
  });

  test('an unwrapped row break survives as a newline', () => {
    expect(assembleSelectionText(['aaaa', 'bbbb'], noWrap(2), 0, 0, 1, 4)).toBe('aaaa\nbbbb');
  });

  test('wrapping is decided per row, not per selection', () => {
    expect(assembleSelectionText(['aa', 'bb', 'cc'], wrapAt(3, 1), 0, 0, 2, 2)).toBe('aa\nbbcc');
  });

  test('wrap bits are read LSB-first past the first byte', () => {
    const rows = Array.from({ length: 10 }, (_, index) => `r${index}`);
    expect(assembleSelectionText(rows, wrapAt(10, 8), 8, 0, 9, 2)).toBe('r8r9');
    expect(assembleSelectionText(rows, noWrap(10), 8, 0, 9, 2)).toBe('r8\nr9');
  });

  test('the middle rows of a multi-row selection are taken whole', () => {
    const rows = ['one  ', 'two  ', 'three'];
    expect(assembleSelectionText(rows, noWrap(3), 0, 1, 2, 3)).toBe('ne\ntwo\nthr');
  });

  test('a selection past the last row yields no text rather than throwing', () => {
    expect(assembleSelectionText(['only'], noWrap(1), 3, 0, 5, 0)).toBe('\n\n');
    expect(assembleSelectionText([], noWrap(1), 0, 0, 0, 0)).toBe('');
  });
});

// Where a Shift-drag starts. The browser reads Shift+mousedown as "extend the
// current selection", so the layer hands it an anchor instead of trusting the
// base it was holding; these two functions are that anchor.
describe('selection anchoring', () => {
  const originalNode = globalThis.Node;
  const TEXT_NODE = 3;
  const ELEMENT_NODE = 1;

  afterAll(() => {
    globalThis.Node = originalNode;
  });

  // `caretPositionIn` reads `Node.TEXT_NODE`, which no test environment
  // provides; the DOM it walks is otherwise plain enough to build by hand.
  globalThis.Node = { TEXT_NODE, ELEMENT_NODE } as unknown as typeof Node;

  const narrow = (): number => 1;
  const wideCjk = (codepoint: number): number => (codepoint >= 0x1100 ? 2 : 1);

  const textNode = (text: string): ChildNode =>
    ({ nodeType: TEXT_NODE, textContent: text }) as unknown as ChildNode;
  const wideSpan = (text: string): ChildNode =>
    ({ nodeType: ELEMENT_NODE, textContent: text }) as unknown as ChildNode;
  const row = (...children: ChildNode[]): HTMLElement =>
    ({ childNodes: children }) as unknown as HTMLElement;

  test('a column maps to the character occupying it', () => {
    expect(rowCharIndexAt('echo hi', 0, narrow)).toBe(0);
    expect(rowCharIndexAt('echo hi', 4, narrow)).toBe(4);
    // Past the last cell is the row's end, not an offset off the end of it:
    // dragging into the padding must select to the end of the line.
    expect(rowCharIndexAt('echo hi', 200, narrow)).toBe(7);
  });

  test('a wide character is one position covering two columns', () => {
    // '你' and '好' each take two cells, so cell 2 is the start of '好' and
    // cell 1 — the right half of '你' — belongs after it, never inside.
    const text = '你好ab';
    expect(rowCharIndexAt(text, 0, wideCjk)).toBe(0);
    expect(rowCharIndexAt(text, 1, wideCjk)).toBe(1);
    expect(rowCharIndexAt(text, 2, wideCjk)).toBe(1);
    expect(rowCharIndexAt(text, 4, wideCjk)).toBe(2);
    expect(rowCharIndexAt(text, 5, wideCjk)).toBe(3);
  });

  test('a surrogate pair advances by both of its code units', () => {
    // '😀ab': one codepoint, two UTF-16 units, and the DOM offsets that follow
    // it are counted in units.
    expect(rowCharIndexAt('😀ab', 2, wideCjk)).toBe(2);
    expect(rowCharIndexAt('😀ab', 3, wideCjk)).toBe(3);
  });

  test('a plain row anchors inside its single text node', () => {
    const only = textNode('echo hi');
    expect(caretPositionIn(row(only), 4)).toEqual({ node: only, offset: 4 });
    expect(caretPositionIn(row(only), 7)).toEqual({ node: only, offset: 7 });
  });

  test('a wide-character span is anchored beside, never inside', () => {
    // The row a wide character forces: text, a fixed-width span, text.
    const head = textNode('ab');
    const span = wideSpan('你');
    const tail = textNode('cd');
    const rowElement = row(head, span, tail);

    expect(caretPositionIn(rowElement, 1)).toEqual({ node: head, offset: 1 });
    // The boundary before the span is the end of the text node preceding it.
    expect(caretPositionIn(rowElement, 2)).toEqual({ node: head, offset: 2 });
    // After the span: a child index on the row, because the span holds no
    // position of its own.
    expect(caretPositionIn(rowElement, 3)).toEqual({ node: rowElement, offset: 2 });
    expect(caretPositionIn(rowElement, 4)).toEqual({ node: tail, offset: 1 });
    expect(caretPositionIn(rowElement, 5)).toEqual({ node: tail, offset: 2 });
  });

  test('an offset past the row lands at its end rather than nowhere', () => {
    const rowElement = row(textNode('ab'), wideSpan('你'));
    expect(caretPositionIn(rowElement, 99)).toEqual({ node: rowElement, offset: 2 });
    expect(caretPositionIn(row(), 0)).toEqual({ node: row(), offset: 0 });
  });
});
