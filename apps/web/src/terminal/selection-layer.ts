// Transparent, metric-matched DOM text laid over the WebGL grid so the browser
// owns terminal selection and copy.
//
// The canvas carries no text, so nothing native can act on it: no drag-select,
// no double-click word, no iOS long-press callout, and no way to reach the
// clipboard inside the gesture that asked for it. WebKit permits a clipboard
// write only while it is synchronously dispatching the gesture's own handler,
// and the grid lives in WASM inside a worker, so every read-then-write crosses
// a task boundary and loses the gesture. Handing the browser real text removes
// that problem instead of timing around it.
//
// The text is never seen (`color: transparent`), so the family does not have to
// match the WebGL atlas — only the ADVANCE does. Selection rectangles, the iOS
// drag handles and the magnifier all position themselves from this layer's
// client rects, so a drifting advance shows up as a highlight sliding off the
// glyphs. The terminal face is loaded as raw bytes into WASM and has no
// `@font-face`, so this uses generic `monospace` and calibrates every advance to
// `charWidth` with letter-spacing, measuring each codepoint it actually meets
// rather than trusting a width table the font may disagree with.

/** Grid geometry the layer must match, in CSS pixels. */
export interface SelectionLayerMetrics {
  readonly charWidth: number;
  readonly charHeight: number;
  readonly cols: number;
  readonly rows: number;
  readonly fontSize: number;
}

export interface SelectionLayer {
  readonly element: HTMLDivElement;
  /**
   * Mount the layer over the grid. `text` is one untrimmed line per row joined
   * by `\n`; `wrapBits` is LSB-first, set where a row continues onto the next.
   */
  show(text: string, wrapBits: Uint8Array): void;
  hide(): void;
  isVisible(): boolean;
  /**
   * Anchor a new selection at a grid position, replacing whatever base the
   * browser was holding. The caller does this at the start of every mouse
   * selection drag — see the implementation for why the browser's own base
   * cannot be trusted here.
   */
  anchorSelectionAt(row: number, cell: number): void;
  /** True while the document selection lies inside this layer. */
  holdsSelection(): boolean;
  setMetrics(metrics: SelectionLayerMetrics): void;
  destroy(): void;
}

const LAYER_STYLE =
  'position:absolute;left:0;top:0;margin:0;padding:0;border:0;' +
  'white-space:pre;color:transparent;background:transparent;' +
  'user-select:text;-webkit-user-select:text;overflow:hidden';

const ROW_STYLE = 'position:absolute;left:0;margin:0;padding:0;white-space:pre';

/** A codepoint measuring past this multiple of the narrow advance covers two cells. */
const WIDE_ADVANCE_RATIO = 1.5;
const TRAILING_SPACES = / +$/u;

/**
 * Assemble the clipboard text for a row range.
 *
 * Exported for tests: this is the whole of Merkur's copy semantics, and the
 * two rules it encodes are the ones a DOM serialization gets wrong. A
 * soft-wrapped row joins its successor with no newline, because a command that
 * wrapped on screen is one line and must run when pasted back. And blank tails
 * are grid padding rather than content, so they are trimmed — but only when the
 * slice actually reaches the row's end, since trimming a mid-row slice would
 * eat spaces the user deliberately dragged across.
 */
export function assembleSelectionText(
  rowTexts: readonly string[],
  wrapBits: Uint8Array,
  startRow: number,
  startOffset: number,
  endRow: number,
  endOffset: number,
): string {
  let out = '';
  for (let row = startRow; row <= endRow; row++) {
    const rowText = rowTexts[row] ?? '';
    const wrapped = ((wrapBits[row >> 3] ?? 0) & (1 << (row & 7))) !== 0;
    const from = row === startRow ? startOffset : 0;
    const to = row === endRow ? endOffset : rowText.length;
    let slice = rowText.slice(from, to);
    // Blank tails are grid padding on a row that ended, but a row that wraps is
    // full and its trailing spaces are content the next row continues from —
    // trimming those would corrupt the join rather than tidy it.
    if (to >= rowText.length && !wrapped && slice.charCodeAt(slice.length - 1) === 32) {
      slice = slice.replace(TRAILING_SPACES, '');
    }
    out += slice;
    if (row < endRow && !wrapped) out += '\n';
  }
  return out;
}

/**
 * Character offset in a row for a caret at grid column `cell`.
 *
 * Exported for tests, like `assembleSelectionText`: `cellsFor` is a live font
 * measurement, and this is the mapping that decides where a selection drag
 * starts. A wide character covers two cells but is one indivisible position, so
 * a caret aimed at its second cell lands after it rather than inside it.
 */
export function rowCharIndexAt(
  text: string,
  cell: number,
  cellsFor: (codepoint: number) => number,
): number {
  let index = 0;
  let cells = 0;
  while (index < text.length && cells < cell) {
    const codepoint = text.codePointAt(index) ?? 0x20;
    cells += cellsFor(codepoint);
    index += codepoint > 0xffff ? 2 : 1;
  }
  return index;
}

/**
 * DOM position of a character offset inside a painted row.
 *
 * A row is a single text node in the common case, and a mix of text nodes and
 * fixed-width spans once it holds a wide character. A span is one atomic glyph,
 * so a caret lands on either side of it and never inside.
 */
export function caretPositionIn(
  rowElement: HTMLElement,
  charIndex: number,
): { readonly node: Node; readonly offset: number } {
  const children = rowElement.childNodes;
  let consumed = 0;
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (child === undefined) continue;
    const length = child.textContent?.length ?? 0;
    if (charIndex <= consumed + length) {
      if (child.nodeType === Node.TEXT_NODE) {
        return { node: child, offset: charIndex - consumed };
      }
      return { node: rowElement, offset: charIndex <= consumed ? index : index + 1 };
    }
    consumed += length;
  }
  return { node: rowElement, offset: children.length };
}

export function createSelectionLayer(): SelectionLayer {
  const element = document.createElement('div');
  element.className = 'terminal-selection-layer';
  // Never announced. The terminal e2e suite reads content through
  // `getByRole('log', { name: 'Terminal output' })`, and the accessibility
  // mirror is a sibling in the same container — a second full copy of the
  // viewport here would both duplicate every announcement and make those
  // role queries ambiguous.
  element.setAttribute('aria-hidden', 'true');
  element.style.cssText = `${LAYER_STYLE};display:none`;

  const rowElements: HTMLDivElement[] = [];
  let rowTexts: string[] = [];
  let wrapBits: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let visible = false;

  let metrics: SelectionLayerMetrics = {
    charWidth: 0,
    charHeight: 0,
    cols: 0,
    rows: 0,
    fontSize: 0,
  };

  // One context for the layer's lifetime. `measureText` is the only way to learn
  // what the browser will actually do with a codepoint, including whichever
  // fallback face it picks for one the primary font lacks.
  const measureCanvas = document.createElement('canvas');
  const measureContext = measureCanvas.getContext('2d');
  const advanceCache = new Map<number, number>();
  let narrowAdvance = 0;
  let fontCss = '';

  function advanceOf(codepoint: number): number {
    const cached = advanceCache.get(codepoint);
    if (cached !== undefined) return cached;
    const measured = measureContext?.measureText(String.fromCodePoint(codepoint)).width ?? 0;
    advanceCache.set(codepoint, measured);
    return measured;
  }

  function recalibrate(): void {
    const nextFontCss = `${metrics.fontSize}px monospace`;
    if (nextFontCss === fontCss) return;
    fontCss = nextFontCss;
    advanceCache.clear();
    if (measureContext !== null) measureContext.font = fontCss;
    // 'M' is present in every face and never falls back, so it is the honest
    // reference for the narrow advance the rest is corrected against.
    narrowAdvance = measureContext?.measureText('M').width ?? 0;
  }

  function cellsFor(codepoint: number): number {
    if (narrowAdvance <= 0) return 1;
    return advanceOf(codepoint) > narrowAdvance * WIDE_ADVANCE_RATIO ? 2 : 1;
  }

  function paintRow(rowElement: HTMLDivElement, text: string): void {
    let firstWide = -1;
    for (let index = 0; index < text.length; ) {
      const codepoint = text.codePointAt(index) ?? 0x20;
      if (cellsFor(codepoint) === 2) {
        firstWide = index;
        break;
      }
      index += codepoint > 0xffff ? 2 : 1;
    }

    if (firstWide < 0) {
      // Overwhelmingly the common row: one text node, no spans, and the row's
      // own letter-spacing already makes every advance exactly `charWidth`.
      const only = rowElement.firstChild;
      if (only !== null && rowElement.childNodes.length === 1 && only.nodeType === Node.TEXT_NODE) {
        if (only.nodeValue !== text) only.nodeValue = text;
      } else {
        rowElement.textContent = text;
      }
      return;
    }

    // A wide character advances by its own width, not by two narrow ones, so
    // the row's uniform letter-spacing leaves it short. Correcting with more
    // letter-spacing does not work: `measureText` and the layout engine can
    // resolve the fallback face for a CJK codepoint differently, and measuring
    // the correction against the wrong face drifted a mixed row by ~0.95px.
    // A fixed-width inline-block advances by exactly that width whichever glyph
    // the DOM actually picked, which measured 0.13px worst case instead.
    const fragment = document.createDocumentFragment();
    let runStart = 0;
    const flushRun = (end: number): void => {
      if (end > runStart) fragment.appendChild(document.createTextNode(text.slice(runStart, end)));
    };
    for (let index = 0; index < text.length; ) {
      const codepoint = text.codePointAt(index) ?? 0x20;
      const width = codepoint > 0xffff ? 2 : 1;
      if (cellsFor(codepoint) === 2) {
        flushRun(index);
        const span = document.createElement('span');
        span.textContent = text.slice(index, index + width);
        span.style.display = 'inline-block';
        span.style.width = `${2 * metrics.charWidth}px`;
        span.style.letterSpacing = '0';
        span.style.overflow = 'hidden';
        fragment.appendChild(span);
        runStart = index + width;
      }
      index += width;
    }
    flushRun(text.length);
    rowElement.replaceChildren(fragment);
  }

  // Geometry is re-derived on every refresh but almost never changes, and each
  // style write invalidates layout for every row. Only a real change may reach
  // the DOM.
  let appliedGeometryKey = '';
  let appliedRowCount = 0;

  function applyGeometry(): void {
    const key = `${metrics.cols}x${metrics.rows}:${metrics.charWidth}:${metrics.charHeight}:${fontCss}:${narrowAdvance}`;
    if (key === appliedGeometryKey && rowElements.length === appliedRowCount) return;
    const rowsChanged = key !== appliedGeometryKey;
    appliedGeometryKey = key;
    appliedRowCount = rowElements.length;
    if (rowsChanged) {
      element.style.width = `${metrics.cols * metrics.charWidth}px`;
      element.style.height = `${metrics.rows * metrics.charHeight}px`;
      element.style.font = fontCss;
      element.style.lineHeight = `${metrics.charHeight}px`;
      element.style.letterSpacing = `${metrics.charWidth - narrowAdvance}px`;
    }
    for (let row = 0; row < rowElements.length; row++) {
      const rowElement = rowElements[row];
      if (rowElement === undefined) continue;
      rowElement.style.top = `${row * metrics.charHeight}px`;
      rowElement.style.height = `${metrics.charHeight}px`;
    }
  }

  function setMetrics(next: SelectionLayerMetrics): void {
    metrics = next;
    recalibrate();
    if (visible) {
      applyGeometry();
      for (let row = 0; row < rowElements.length; row++) {
        const rowElement = rowElements[row];
        if (rowElement !== undefined) paintRow(rowElement, rowTexts[row] ?? '');
      }
    }
  }

  function show(text: string, nextWrapBits: Uint8Array): void {
    rowTexts = text.split('\n');
    wrapBits = nextWrapBits;
    recalibrate();

    while (rowElements.length < rowTexts.length) {
      const rowElement = document.createElement('div');
      rowElement.style.cssText = ROW_STYLE;
      rowElement.dataset.row = String(rowElements.length);
      rowElements.push(rowElement);
      element.appendChild(rowElement);
    }
    while (rowElements.length > rowTexts.length) {
      rowElements.pop()?.remove();
    }

    element.style.display = 'block';
    visible = true;
    applyGeometry();
    for (let row = 0; row < rowElements.length; row++) {
      const rowElement = rowElements[row];
      if (rowElement !== undefined) paintRow(rowElement, rowTexts[row] ?? '');
    }
  }

  /**
   * Collapse the document selection at a grid position, which the browser then
   * takes as the base of the drag that started there.
   *
   * Merkur's selection gesture is Shift-drag, and Shift+mousedown is also the
   * browser's own "extend the current selection" gesture, so the drag would
   * otherwise anchor at whatever base the browser was already holding: the
   * caret left by an earlier click, or — because the focused editing surface is
   * a later sibling of this layer in the same container — a position that reads
   * on screen as the end of the viewport. Everything between that base and the
   * pointer then sweeps into the selection, which is the whole bug. Chromium
   * refuses to extend out of the focused editing surface at all, so the same
   * drag selects nothing there instead.
   */
  function anchorSelectionAt(row: number, cell: number): void {
    if (!visible) return;
    const rowIndex = Math.min(Math.max(row, 0), rowElements.length - 1);
    const rowElement = rowElements[rowIndex];
    const selection = document.getSelection();
    if (rowElement === undefined || selection === null) return;
    const position = caretPositionIn(
      rowElement,
      rowCharIndexAt(rowTexts[rowIndex] ?? '', cell, cellsFor),
    );
    selection.collapse(position.node, position.offset);
  }

  function holdsSelection(): boolean {
    const selection = document.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return false;
    return selection.getRangeAt(0).intersectsNode(element);
  }

  function hide(): void {
    if (!visible) return;
    visible = false;
    if (holdsSelection()) document.getSelection()?.removeAllRanges();
    element.style.display = 'none';
  }

  function rowElementOf(node: Node): HTMLElement | null {
    const start = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!(start instanceof HTMLElement)) return null;
    const rowElement = start.closest('[data-row]');
    return rowElement instanceof HTMLElement && element.contains(rowElement) ? rowElement : null;
  }

  /**
   * Character offset of a range boundary within its row, counted through any
   * wide-character spans. A boundary outside the layer — Select All reaches the
   * document, not this element — clamps to the fallback edge rather than
   * abandoning the copy.
   */
  function boundaryOf(
    node: Node,
    offset: number,
    fallbackRow: number,
    fallbackOffset: number,
  ): { readonly row: number; readonly offset: number } {
    // A boundary can land on the layer itself rather than inside a row — a
    // selection that ends exactly on a row edge does this — and there the offset
    // is a child index, which names the row directly.
    if (node === element) {
      const row = Math.min(Math.max(offset, 0), Math.max(0, rowTexts.length - 1));
      return { row, offset: fallbackOffset === 0 ? 0 : (rowTexts[row] ?? '').length };
    }
    const rowElement = rowElementOf(node);
    if (rowElement === null) return { row: fallbackRow, offset: fallbackOffset };
    const row = Number(rowElement.dataset.row ?? '0');
    const probe = document.createRange();
    probe.selectNodeContents(rowElement);
    try {
      probe.setEnd(node, offset);
    } catch {
      return { row, offset: 0 };
    }
    return { row, offset: probe.toString().length };
  }

  function selectedText(): string | null {
    // A hidden layer is still in the DOM, and `intersectsNode` is tree-based
    // rather than layout-based, so Select All would otherwise let an unmounted
    // layer hijack an unrelated copy elsewhere in the app.
    if (!visible) return null;
    const selection = document.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!range.intersectsNode(element)) return null;
    const lastRow = Math.max(0, rowTexts.length - 1);
    const start = boundaryOf(range.startContainer, range.startOffset, 0, 0);
    const end = boundaryOf(
      range.endContainer,
      range.endOffset,
      lastRow,
      (rowTexts[lastRow] ?? '').length,
    );
    return assembleSelectionText(rowTexts, wrapBits, start.row, start.offset, end.row, end.offset);
  }

  // The single place text reaches the clipboard. Native Cmd+C, the browser's
  // Edit menu, right-click Copy, the iOS callout and `execCommand('copy')` all
  // arrive here, so terminal copy semantics are applied once regardless of
  // which of them fired — and never as DOM block serialization, which would put
  // a newline between every positioned row and undo the wrap join.
  //
  // Bound to the document rather than the layer: the clipboard event targets the
  // selection's common ancestor, so a range that starts above this element —
  // Select All is the ordinary way to produce one — would never reach a listener
  // on the layer itself. `selectedText` returns null for anything that does not
  // intersect a mounted layer, so copies elsewhere in the app are untouched.
  const onCopy = (event: ClipboardEvent): void => {
    const text = selectedText();
    if (text === null) return;
    event.clipboardData?.setData('text/plain', text);
    event.preventDefault();
  };
  document.addEventListener('copy', onCopy);

  return {
    element,
    show,
    hide,
    isVisible: () => visible,
    anchorSelectionAt,
    holdsSelection,
    setMetrics,
    destroy(): void {
      document.removeEventListener('copy', onCopy);
      hide();
      element.remove();
    },
  };
}
