/**
 * Draws a figure over its still. Its own module, fetched with the first
 * figure, so Solid is imported by name and only what the figures use of it is
 * shipped.
 */
import { render } from '@solidjs/web';
import type { Component } from 'solid-js';

export function mount(Island: Component, root: HTMLElement): void {
  // Solid listens for a figure's events on the element it rendered into, so the
  // figure is drawn in place. The still goes and the figure arrives in one
  // task, before the browser paints again.
  root.replaceChildren();
  render(() => Island({}), root);
  root.inert = false;
}
