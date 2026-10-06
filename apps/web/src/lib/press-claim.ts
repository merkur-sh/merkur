/**
 * Takes the click that ends a press, wherever that click lands.
 *
 * For a surface that leaves on a press — a scrim or backdrop dismissed on
 * pointerdown, or anything pressed while it is animating away. A click is
 * hit-tested where the press *ends*: after pointerup, and on iOS a task after
 * that. A press still held when the surface finished leaving delivered its
 * click to whatever the surface had covered, which is how a tap on a dialog's
 * backdrop opened the row behind it. UIKit binds a touch to the view it began
 * on; this binds the click to its press the same way.
 *
 * A press's click arrives before the next press begins, and a click made from
 * the keyboard follows its own keydown, so either one ends the claim: no click
 * after them can be this press's. An untrusted click is never taken —
 * `element.click()` from code is not a press at all.
 */
export function claimPress(): void {
  function release(): void {
    window.removeEventListener('click', take, true);
    window.removeEventListener('pointerdown', release, true);
    window.removeEventListener('keydown', release, true);
  }
  function take(event: MouseEvent): void {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopPropagation();
    release();
  }
  window.addEventListener('click', take, true);
  window.addEventListener('pointerdown', release, true);
  window.addEventListener('keydown', release, true);
}
