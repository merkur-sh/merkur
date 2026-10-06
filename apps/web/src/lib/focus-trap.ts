/**
 * Tab containment for modal surfaces.
 *
 * The index arithmetic is separated from the DOM so it can be tested without a
 * document: `nextTrapIndex` is pure, and `trapTabKey` is the thin adapter that
 * reads focusable elements and moves focus.
 */

/**
 * Interactive descendants, in tab order. `:not([disabled])` matters because a
 * disabled control is skipped by the browser, so treating it as an edge would
 * wrap one element early while a dialog is submitting.
 */
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function focusableWithin(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Where Tab should move, or `null` to let the browser do it.
 *
 * Only the edges are redirected: interior moves are the browser's job and
 * hijacking them would break sequential navigation inside composite widgets.
 * A `currentIndex` of -1 means focus has escaped the surface entirely — the
 * background is not inert, so this pulls it back rather than letting Tab walk
 * into the screen behind the dialog.
 */
export function nextTrapIndex(
  count: number,
  currentIndex: number,
  shiftKey: boolean,
): number | null {
  if (count === 0) return null;
  if (currentIndex < 0) return shiftKey ? count - 1 : 0;
  if (shiftKey && currentIndex === 0) return count - 1;
  if (!shiftKey && currentIndex === count - 1) return 0;
  return null;
}

/**
 * Keeps Tab inside `root`. Call from a keydown handler; it ignores every key
 * except Tab and only calls `preventDefault` when it actually moves focus.
 */
export function trapTabKey(event: KeyboardEvent, root: ParentNode): void {
  if (event.key !== 'Tab') return;

  const focusable = focusableWithin(root);
  const active = document.activeElement;
  const currentIndex = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
  const nextIndex = nextTrapIndex(focusable.length, currentIndex, event.shiftKey);
  if (nextIndex === null) return;

  event.preventDefault();
  focusable[nextIndex]?.focus();
}
