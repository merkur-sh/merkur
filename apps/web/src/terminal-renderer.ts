import type { ImageScene } from './graphics/scene';
import { WebGpuRenderer } from './renderer-webgpu';

export interface GpuRenderer {
  setGraphicsScene(scene: ImageScene, wake: () => void, uploaded: (key: string) => void): boolean;
  offerGraphicsTile(key: string, bitmap: ImageBitmap): boolean;
  graphicsTileCapacity(): boolean;
  hasGraphicsTile(key: string): boolean;
  clearGraphics(): void;
  init(canvas: OffscreenCanvas, atlasW: number, atlasH: number): Promise<void>;
  uploadAtlas(
    pixels: Uint8Array,
    dirtyRect: [number, number, number, number],
    atlasDimensions: readonly [width: number, height: number],
  ): void;
  render(
    memory: ArrayBuffer,
    bg: GeometryBufferRange,
    glyph: GeometryBufferRange,
    deco: GeometryBufferRange,
    cursor: GeometryBufferRange,
    viewport: [number, number],
    versions?: GeometryVersions,
    preview?: TerminalPreviewGeometry,
  ): number;
  resize(physW: number, physH: number): void;
  setClearColor(color: readonly [number, number, number]): void;
  /** True while any submitted frame's completion gate remains pending. */
  frameInFlight(): boolean;
  /** Whether count, upload and retired-resource admission budgets permit work. */
  canSubmitFrame(): boolean;
  destroy(): void;
}

export interface GeometryBufferRange {
  readonly ptr: number;
  readonly count: number;
}

/** Bounded worker-owned UNSENT pointer feedback; never mutates terminal input. */
export interface TerminalPreviewGeometry {
  readonly version: number;
  readonly bg: Float32Array<ArrayBuffer>;
  readonly bgCount: number;
  readonly glyph: Float32Array<ArrayBuffer>;
  readonly glyphCount: number;
  readonly cursor: Float32Array<ArrayBuffer>;
  readonly cursorCount: number;
}

export interface GeometryVersions {
  bg: number;
  glyph: number;
  deco: number;
  cursor: number;
  bgDirtyOffset: number;
  bgDirtyCount: number;
  glyphDirtyOffset: number;
  glyphDirtyCount: number;
  decoDirtyOffset: number;
  decoDirtyCount: number;
  cursorDirtyOffset: number;
  cursorDirtyCount: number;
}

export async function selectRenderer(
  canvas: OffscreenCanvas,
  atlasW: number,
  atlasH: number,
  clearColor?: readonly [number, number, number],
  onContextRestored?: () => void,
  onContextLost?: () => void,
  onFrameComplete?: (id: number) => void,
  onError?: (error: Error) => void,
): Promise<GpuRenderer> {
  const renderer = new WebGpuRenderer(onContextRestored, onContextLost, onFrameComplete, onError);
  await renderer.init(canvas, atlasW, atlasH, clearColor);
  return renderer;
}
