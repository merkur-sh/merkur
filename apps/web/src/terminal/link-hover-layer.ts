// Underline and target label for the link under a modifier-held pointer.
//
// The label shows the URL that will open, not the text on screen: an OSC 8 link
// is free to say one thing and point at another, and the moment of hover is the
// only place a person can see the difference before clicking. Pointer events
// pass straight through, so the layer never changes which gesture the grid gets.

import type { LinkHit } from './link-detection';

export interface LinkHoverLayer {
  readonly element: HTMLDivElement;
  /** `cols` bounds the label, which never extends past the grid's right edge. */
  show(hit: LinkHit, cols: number, charWidth: number, charHeight: number, color: string): void;
  hide(): void;
  isVisible(): boolean;
}

const LAYER_STYLE = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none';
const UNDERLINE_STYLE = 'position:absolute;height:1px';
const LABEL_STYLE =
  'position:absolute;overflow:hidden;text-overflow:ellipsis;' +
  'white-space:nowrap;padding:2px 6px;border-radius:4px;font:12px/16px ui-monospace,monospace;' +
  'background:rgba(0,0,0,0.85);color:#fff';
const LABEL_HEIGHT_PX = 20;

export function createLinkHoverLayer(): LinkHoverLayer {
  const element = document.createElement('div');
  element.style.cssText = LAYER_STYLE;
  element.setAttribute('aria-hidden', 'true');
  element.dataset.terminalLinkHover = '';
  const label = document.createElement('div');
  label.style.cssText = LABEL_STYLE;
  label.dataset.terminalLinkTarget = '';
  let visible = false;
  let shownHit: LinkHit | null = null;
  let shownKey = '';
  let shownCols = 0;
  let shownCharWidth = 0;
  let shownCharHeight = 0;
  let shownColor = '';

  function hide(): void {
    if (!visible) return;
    visible = false;
    shownHit = null;
    shownKey = '';
    element.replaceChildren();
  }

  function show(
    hit: LinkHit,
    cols: number,
    charWidth: number,
    charHeight: number,
    color: string,
  ): void {
    const first = hit.spans[0];
    if (first === undefined || charWidth <= 0 || charHeight <= 0) {
      hide();
      return;
    }
    // Pointer motion inside one cell repeats the same hit object, and a frame
    // applied under a resting pointer resolves an equal one; rebuild only when
    // the link or the geometry it was drawn at changed.
    const sameGeometry =
      cols === shownCols &&
      charWidth === shownCharWidth &&
      charHeight === shownCharHeight &&
      color === shownColor;
    if (visible && hit === shownHit && sameGeometry) return;
    const key = `${hit.url}\n${hit.spans
      .map((span) => `${span.row},${span.left},${span.right}`)
      .join(';')}`;
    if (visible && key === shownKey && sameGeometry) {
      shownHit = hit;
      return;
    }
    const children: HTMLElement[] = [];
    for (const span of hit.spans) {
      const underline = document.createElement('div');
      underline.style.cssText = UNDERLINE_STYLE;
      underline.style.left = `${span.left * charWidth}px`;
      underline.style.top = `${(span.row + 1) * charHeight - 1}px`;
      underline.style.width = `${(span.right - span.left + 1) * charWidth}px`;
      underline.style.background = color;
      children.push(underline);
    }
    label.textContent = hit.url;
    const gridWidth = cols * charWidth;
    const left = first.left * charWidth;
    label.style.left = `${left}px`;
    label.style.maxWidth = `min(60ch, ${gridWidth}px)`;
    // Slide left by however much the label would overhang the grid, without a
    // layout read: a translate percentage is the label's own width.
    label.style.transform = `translateX(clamp(${-left}px, calc(${gridWidth - left}px - 100%), 0px))`;
    // Above the link when there is room, below it on the top row.
    label.style.top =
      first.row === 0
        ? `${(hit.spans.length + first.row) * charHeight + 2}px`
        : `${first.row * charHeight - LABEL_HEIGHT_PX}px`;
    children.push(label);
    element.replaceChildren(...children);
    visible = true;
    shownHit = hit;
    shownKey = key;
    shownCols = cols;
    shownCharWidth = charWidth;
    shownCharHeight = charHeight;
    shownColor = color;
  }

  return {
    element,
    show,
    hide,
    isVisible: () => visible,
  };
}
