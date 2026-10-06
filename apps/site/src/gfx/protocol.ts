/**
 * What the page and its render worker say to each other.
 *
 * The page owns layout, visibility and the pointer; the worker owns every
 * WebGL context and every frame. A surface is one canvas the page handed
 * over; the worker draws it only while the page says it is on screen.
 */
export type SurfaceInit =
  | { readonly kind: 'orb' }
  | { readonly kind: 'boxes' }
  | {
      readonly kind: 'mark';
      /** The mark's mask: alpha in red, its blurred height in green. */
      readonly mask: ImageBitmap;
      /** A phase offset, so two marks side by side do not shimmer in step. */
      readonly seed: number;
    }
  | {
      readonly kind: 'retrograde';
      /** Where the orb's line lies in the canvas. */
      readonly sky: RetrogradeSky;
    }
  | {
      readonly kind: 'planet';
      /** The glyphs the planet is drawn in, one cell each, left to right. */
      readonly atlas: ImageBitmap;
      /** One glyph's cell, in CSS pixels. */
      readonly cellWidth: number;
      readonly cellHeight: number;
      /** CSS size of the canvas and the device pixels per CSS pixel it is drawn at. */
      readonly width: number;
      readonly height: number;
      readonly scale: number;
    };

export type ToWorker =
  | {
      readonly type: 'add';
      readonly id: number;
      readonly canvas: OffscreenCanvas;
      readonly init: SurfaceInit;
    }
  | { readonly type: 'visible'; readonly id: number; readonly on: boolean }
  /** The pointer over a surface, from -0.5 to 0.5 on each axis; `null` when it leaves. */
  | { readonly type: 'pointer'; readonly id: number; readonly at: readonly [number, number] | null }
  /** A drag on a surface: movement since the last message, in CSS pixels. */
  | {
      readonly type: 'drag';
      readonly id: number;
      readonly phase: 'start' | 'move' | 'end';
      readonly dx: number;
      readonly dy: number;
    }
  /** How far the page has scrolled a surface through the window: an extra turn, in radians. */
  | { readonly type: 'turn'; readonly id: number; readonly by: number }
  /**
   * A surface's box changed: its canvas's new size in device pixels, and for
   * the planet its grid and glyphs measured again for that box.
   */
  | {
      readonly type: 'fit';
      readonly id: number;
      readonly width: number;
      readonly height: number;
      readonly planet: PlanetInit | null;
    }
  /** The layout gave the orb's line a new place, and its canvas a new size in device pixels. */
  | {
      readonly type: 'lay';
      readonly id: number;
      readonly width: number;
      readonly height: number;
      readonly sky: RetrogradeSky;
    };

export type PlanetInit = Extract<SurfaceInit, { kind: 'planet' }>;

/**
 * The orb's line across the page for an address with nothing at it
 * (`retrograde-orbit.ts`), placed in its canvas. In CSS pixels from the
 * canvas's top left corner, but for `scale`.
 */
export interface RetrogradeSky {
  /** Device pixels per CSS pixel the canvas is drawn at. */
  readonly scale: number;
  /** Where the line starts, left of the canvas, and how far it runs to the far edge. */
  readonly left: number;
  readonly run: number;
  /** The level the line keeps, and how far above it the loop rises. */
  readonly level: number;
  readonly rise: number;
  /** The orb's width. */
  readonly orb: number;
}

export type FromWorker =
  /** The worker has drawn a surface's first frame; the page may show the canvas. */
  | { readonly type: 'drawn'; readonly id: number }
  /** The orb on its line started going backwards, or set out again from the line's start. */
  | { readonly type: 'backwards'; readonly id: number; readonly on: boolean };
