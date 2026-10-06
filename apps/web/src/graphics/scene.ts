/** Renderer resource descriptors copied from the core's selected scene. */
export interface TileDemand {
  readonly asset: 'tile';
  readonly authority: Uint8Array;
  readonly frame: number;
  readonly key: string;
  readonly source: Uint8Array;
  readonly level: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Destination edges, not an origin and extent: each boundary two quads share is
 * computed once, so both round to the same f32 and nothing covers a pixel
 * twice or leaves one uncovered at a row or tile seam. */
export interface ImageQuad {
  key: string;
  layer: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  u: number;
  v: number;
  uw: number;
  vh: number;
}

export interface ImageAnimation {
  readonly key: string;
  readonly reserve: boolean;
  readonly bindings: ReadonlyMap<string, string>;
}
export interface ImageScene {
  readonly animations?: readonly ImageAnimation[];
  readonly tiles: readonly TileDemand[];
  readonly quads: readonly ImageQuad[];
}
