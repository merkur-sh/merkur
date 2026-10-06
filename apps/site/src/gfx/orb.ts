/**
 * Every orb on the page, from one render.
 *
 * The mark is the same object wherever it appears, at the same moment of the
 * same noise field, so it is drawn once a frame at the largest size on the
 * page and copied down into each orb that is on screen. One raymarch a frame,
 * whatever the number of marks, and no canvas is ever resized.
 */
import {
  createOrbSurface,
  ORB_FRAME_MS,
  ORB_REST_TIME,
  type OrbSurface,
} from '@merkur/quicksilver/orb';

import type { Renderer } from './worker';

/** The largest orb the page sets, in device pixels: 120 CSS pixels at 2x. */
const SOURCE_PIXELS = 240;

export interface OrbRenderer extends Renderer {
  add(canvas: OffscreenCanvas): { setVisible(on: boolean): void };
}

export function createOrbRenderer(drawn: (canvas: OffscreenCanvas) => void): OrbRenderer {
  const source = new OffscreenCanvas(SOURCE_PIXELS, SOURCE_PIXELS);
  let surface: OrbSurface | null = null;
  const targets = new Map<OffscreenCanvas, OffscreenCanvasRenderingContext2D>();
  const visible = new Set<OffscreenCanvas>();
  const announced = new Set<OffscreenCanvas>();
  const started = performance.now();

  const copy = (canvas: OffscreenCanvas): void => {
    const context = targets.get(canvas);
    if (context === undefined) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (!announced.has(canvas)) {
      announced.add(canvas);
      drawn(canvas);
    }
  };

  return {
    minFrameMs: ORB_FRAME_MS,
    wantsFrames: () => visible.size > 0,
    draw(now) {
      if (surface === null) return;
      surface.draw(ORB_REST_TIME + (now - started) / 1000);
      for (const canvas of visible) copy(canvas);
    },
    add(canvas) {
      if (surface === null) {
        const made = createOrbSurface(source, SOURCE_PIXELS / 2, 2);
        if (!made.ok) throw new Error(`site: the orb cannot draw: ${made.failure.reason}`);
        surface = made.surface;
      }
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('site: an orb canvas has no 2D context');
      context.imageSmoothingQuality = 'high';
      targets.set(canvas, context);
      return {
        setVisible(on) {
          if (on) visible.add(canvas);
          else visible.delete(canvas);
        },
      };
    },
  };
}
