import type { ImageScene } from './graphics/scene';
import { WebGpuRenderer } from './renderer-webgpu';
import type { GeometryRenderState } from './terminal/geometry-render-state';

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
    geometry: GeometryRenderState,
    preview?: TerminalPreviewGeometry,
  ): number;
  resize(physW: number, physH: number): void;
  setClearColor(color: readonly [number, number, number]): void;
  /** True while any submitted frame's completion gate remains pending. */
  frameInFlight(): boolean;
  /** Whether count, upload and retired-resource admission budgets permit work. */
  canSubmitFrame(): boolean;
  /** Have the implementation deliver completions the GPU has already reached. */
  requestCompletion(): void;
  destroy(): void;
}

/** Bounded worker-owned UNSENT pointer feedback; never mutates terminal input. */
export interface TerminalPreviewGeometry {
  readonly version: number;
  /** Cell records (`CELL_WORDS` each): the preview cells, then the cursor cell. */
  readonly cells: Uint32Array<ArrayBuffer>;
  readonly cellCount: number;
  /** The glyphs' clip in physical pixels: x, y, width, height. */
  readonly clip: Uint32Array<ArrayBuffer>;
  readonly cursor: Float32Array<ArrayBuffer>;
  readonly cursorCount: number;
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
