import { nextPowerOfTwo } from '@merkur/shared';
import { GraphicsCompositor } from './graphics/compositor';
import type { ImageScene } from './graphics/scene';
import {
  BUILTIN_MOSAIC,
  CELL_ALPHA_DIM,
  CELL_BACKGROUND,
  CELL_BUILTIN,
  CELL_COLUMN_SHIFT,
  CELL_GLYPH_MASK,
  CELL_PREEDIT,
  CELL_ROW_SHIFT,
  CELL_STRIKEOUT,
  CELL_UNDERLINE,
  CELL_WIDE,
  CELL_WORDS,
  GLYPH_TABLE_WORDS,
} from './terminal/cell-records';
import { SRGB_DECODE_WGSL, srgbToLinear } from './terminal/color-space';
import type {
  GeometryBuffer,
  GeometryRenderState,
  GlyphTableRange,
} from './terminal/geometry-render-state';
import { MAX_IN_FLIGHT_RENDER_FRAMES } from './terminal/render-mailbox';
import { DEFAULT_TERMINAL_THEME } from './terminal/themes';
import type { GpuRenderer, TerminalPreviewGeometry } from './terminal-renderer';

// Admission stops at these watermarks before preparing another transaction.
// One already admitted transaction may cross them; it is validated against the
// device limits and must be submitted to make its uploads/retirements drainable.
const MAX_UNCONFIRMED_UPLOAD_BYTES = 16 * 1024 * 1024;
const MAX_UNCONFIRMED_RETIRED_BYTES = 32 * 1024 * 1024;

// Installed DOM types include WebGPU interfaces but omit these WebIDL namespace
// values. They are browser globals, not alternate implementations of the API.
declare const GPUBufferUsage: {
  readonly UNIFORM: number;
  readonly COPY_DST: number;
  readonly VERTEX: number;
  readonly STORAGE: number;
};
declare const GPUTextureUsage: { readonly TEXTURE_BINDING: number; readonly COPY_DST: number };
declare const GPUShaderStage: { readonly VERTEX: number; readonly FRAGMENT: number };

// A touch preview draws its cells and the cursor cell after them.
const MAX_PREVIEW_CELLS = 11;
const CELL_BYTES = CELL_WORDS * 4;
const GLYPH_ENTRY_BYTES = GLYPH_TABLE_WORDS * 4;
const MIN_GLYPH_TABLE_BYTES = 4096;
// viewport, cell size, baseline, then the preedit highlight at its vec3 alignment.
const UNIFORM_FLOATS = 12;

// Every text pass draws one instance per cell record (`terminal/cell-records`),
// the grid's records first and then the overlay's. A record positions itself
// from its column and row; one that draws nothing in a pass collapses to a
// point outside the viewport. Glyph rectangles and bearings come from the
// glyph table, in atlas pixels, so atlas growth rewrites no record. Cursors
// keep their eight-float instance.
const SHADER = `
${SRGB_DECODE_WGSL}
struct View {
  viewport: vec2f,
  cell: vec2f,
  baseline: f32,
  highlight: vec3f,
};
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var atlas_sampler: sampler;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> glyphs: array<u32>;
const GLYPH_MASK = ${CELL_GLYPH_MASK}u;
const COLUMN_SHIFT = ${CELL_COLUMN_SHIFT}u;
const ROW_SHIFT = ${CELL_ROW_SHIFT}u;
const WIDE = ${CELL_WIDE}u;
const UNDERLINE = ${CELL_UNDERLINE}u;
const STRIKEOUT = ${CELL_STRIKEOUT}u;
const BUILTIN = ${CELL_BUILTIN}u;
const BACKGROUND = ${CELL_BACKGROUND}u;
const PREEDIT = ${CELL_PREEDIT}u;
const ALPHA_SHIFT = ${Math.log2(CELL_ALPHA_DIM)}u;
const MOSAIC = ${BUILTIN_MOSAIC}u;
const OUTSIDE = vec4f(2, 2, 0, 1);
fn corner(i: u32) -> vec2f {
  let corners = array<vec2f, 4>(vec2f(0,0), vec2f(1,0), vec2f(0,1), vec2f(1,1));
  return corners[i];
}
fn position(p: vec2f) -> vec4f {
  return vec4f(p.x / view.viewport.x * 2.0 - 1.0, 1.0 - p.y / view.viewport.y * 2.0, 0, 1);
}
fn origin(record: vec3u) -> vec2f {
  return vec2f(f32((record.x >> COLUMN_SHIFT) & 0x1ffu), f32(record.z >> ROW_SHIFT)) * view.cell;
}
fn rgb(word: u32) -> vec3f {
  return unpack4x8unorm(word).rgb;
}
fn background(record: vec3u) -> vec3f {
  return select(rgb(record.z), view.highlight, (record.y & PREEDIT) != 0u);
}
struct SolidOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
};
@vertex fn cell_background(@builtin(vertex_index) i: u32, @location(0) record: vec3u) -> SolidOutput {
  if ((record.y & BACKGROUND) == 0u) { return SolidOutput(OUTSIDE, vec3f(0)); }
  return SolidOutput(position(origin(record) + corner(i) * view.cell), srgb_to_linear(background(record)));
}
@vertex fn encoded_cell_background(@builtin(vertex_index) i: u32, @location(0) record: vec3u) -> SolidOutput {
  if ((record.y & BACKGROUND) == 0u) { return SolidOutput(OUTSIDE, vec3f(0)); }
  return SolidOutput(position(origin(record) + corner(i) * view.cell), background(record));
}
@fragment fn encoded_cell_background_fragment(v: SolidOutput) -> @location(0) vec4f {
  return vec4f(v.color, 1);
}
@fragment fn cell_background_fragment(v: SolidOutput) -> @location(0) vec4f {
  return vec4f(v.color, 1);
}
struct GlyphOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
  @location(2) alpha: f32,
};
@vertex fn cell_glyph(@builtin(vertex_index) i: u32, @location(0) record: vec3u) -> GlyphOutput {
  let id = record.x & GLYPH_MASK;
  if (id == 0u || (record.y & BUILTIN) != 0u) { return GlyphOutput(OUTSIDE, vec2f(0), vec3f(0), 0); }
  let entry = (id - 1u) * 3u;
  let at = glyphs[entry];
  let extent = glyphs[entry + 1u];
  let bearing = bitcast<i32>(glyphs[entry + 2u]);
  let size = vec2f(f32(extent & 0xffffu), f32(extent >> 16u));
  let offset = vec2f(f32(extractBits(bearing, 0u, 16u)), view.baseline + f32(extractBits(bearing, 16u, 16u)));
  let c = corner(i);
  let alphas = array<f32, 4>(1.0, 0.72, 0.55, 1.0);
  return GlyphOutput(
    position(origin(record) + offset + c * size),
    (vec2f(f32(at & 0xffffu), f32(at >> 16u)) + c * size) / vec2f(textureDimensions(atlas)),
    srgb_to_linear(rgb(record.y)),
    alphas[(record.y >> ALPHA_SHIFT) & 3u],
  );
}
@fragment fn cell_glyph_fragment(v: GlyphOutput) -> @location(0) vec4f {
  let coverage = textureSample(atlas, atlas_sampler, v.uv).r;
  return vec4f(v.color, coverage * v.alpha);
}
struct DecorationOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) @interpolate(flat) origin: vec2f,
  @location(2) @interpolate(flat) record: vec2u,
  @location(3) @interpolate(flat) width: f32,
};
@vertex fn cell_decoration(@builtin(vertex_index) i: u32, @location(0) record: vec3u) -> DecorationOutput {
  if ((record.x & (UNDERLINE | STRIKEOUT)) == 0u && (record.y & (BUILTIN | PREEDIT)) == 0u) {
    return DecorationOutput(OUTSIDE, vec3f(0), vec2f(0), vec2u(0), 0);
  }
  let width = view.cell.x * select(1.0, 2.0, (record.x & WIDE) != 0u);
  let at = origin(record);
  return DecorationOutput(
    position(at + corner(i) * vec2f(width, view.cell.y)),
    srgb_to_linear(rgb(record.y)),
    at,
    record.xy,
    width,
  );
}
fn inside(p: vec2f, low: vec2f, high: vec2f) -> bool {
  return all(p >= low) && all(p < high);
}
// Lines, the preedit underline and builtin block shapes, tested at the pixel
// centre so every edge falls exactly where the rectangle rasterizer put it.
fn decorates(record: vec2u, p: vec2f, width: f32) -> bool {
  let height = view.cell.y;
  if ((record.x & UNDERLINE) != 0u && inside(p, vec2f(0, height - 1.0), vec2f(width, height))) { return true; }
  if ((record.x & STRIKEOUT) != 0u &&
      inside(p, vec2f(0, height * 0.5), vec2f(width, height * 0.5 + 1.0))) { return true; }
  if ((record.y & PREEDIT) != 0u && inside(p, vec2f(0, height - 2.0), vec2f(width, height))) { return true; }
  if ((record.y & BUILTIN) == 0u) { return false; }
  let shape = record.x & GLYPH_MASK;
  let cell = vec2f(width, height);
  if ((shape & MOSAIC) == 0u) {
    let low = vec2f(f32(shape & 15u), f32((shape >> 4u) & 15u)) * 0.125 * cell;
    return inside(p, low, low + vec2f(f32((shape >> 8u) & 15u), f32((shape >> 12u) & 15u)) * 0.125 * cell);
  }
  let rows = (shape >> 8u) & 15u;
  let part = vec2f(0.5, 1.0 / f32(rows));
  for (var bit = 0u; bit < rows * 2u; bit++) {
    let low = vec2f(f32(bit % 2u), f32(bit / 2u)) * part * cell;
    if ((shape & (1u << bit)) != 0u && inside(p, low, low + part * cell)) { return true; }
  }
  return false;
}
@fragment fn cell_decoration_fragment(v: DecorationOutput) -> @location(0) vec4f {
  if (!decorates(v.record, v.position.xy - v.origin, v.width)) { discard; }
  return vec4f(v.color, 1);
}
struct CursorOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) shape: f32,
  @location(2) local: vec2f,
};
@vertex fn cursor(@builtin(vertex_index) i: u32, @location(0) rect: vec4f,
  @location(1) color: vec3f, @location(2) shape: f32) -> CursorOutput {
  let c = corner(i);
  return CursorOutput(position(rect.xy + c * rect.zw), srgb_to_linear(mix(color, vec3f(1), 0.8)), shape, c);
}
@fragment fn cursor_fragment(v: CursorOutput) -> @location(0) vec4f {
  var inside = 0.55;
  if (v.shape >= 0.5 && v.shape < 1.5) {
    inside = select(0.0, 1.0, v.local.x <= 0.14);
  } else if (v.shape >= 1.5) {
    inside = select(0.0, 1.0, v.local.y >= 0.9);
  }
  return vec4f(v.color, inside);
}`;

const CELL_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: CELL_BYTES,
  stepMode: 'instance',
  attributes: [{ shaderLocation: 0, offset: 0, format: 'uint32x3' }],
};
const CURSOR_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 32,
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x4' },
    { shaderLocation: 1, offset: 16, format: 'float32x3' },
    { shaderLocation: 2, offset: 28, format: 'float32' },
  ],
};
const COVERAGE_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

interface GeometryStorage {
  buffer: GPUBuffer | null;
  readonly stride: number;
  capacity: number;
  version: number;
}

function storage(stride: number): GeometryStorage {
  return { buffer: null, stride, capacity: 0, version: -1 };
}

/**
 * One owner, one queue, one full-scene render pass. Received rows do not upload
 * themselves: the presentation owner calls render only with eligible geometry.
 * Queue completion releases an exact credit; it is NOT a browser-paint signal.
 */
export class WebGpuRenderer implements GpuRenderer {
  private graphics: GraphicsCompositor | null = null;
  private graphicsStorage: GraphicsCompositor | null = null;
  private graphicsUploaded: ((key: string) => void) | null = null;

  setGraphicsScene(scene: ImageScene, wake: () => void, uploaded: (key: string) => void): boolean {
    if (this.device === null || this.uniform === null) return scene.tiles.length === 0;
    if (this.graphicsStorage === null && scene.tiles.length > 0)
      this.graphicsStorage = new GraphicsCompositor(this.device, this.uniform, wake, (error) =>
        this.fail(toError(error)),
      );
    this.graphicsUploaded = uploaded;
    const admitted = this.graphicsStorage?.setScene(scene) ?? true;
    if (admitted) this.graphics = scene.tiles.length === 0 ? null : this.graphicsStorage;
    return admitted;
  }

  offerGraphicsTile(key: string, bitmap: ImageBitmap): boolean {
    if (this.graphics === null) {
      bitmap.close();
      return false;
    }
    return this.graphics.offer(key, bitmap);
  }

  graphicsTileCapacity(): boolean {
    return this.graphicsStorage?.hasOfferCapacity() ?? true;
  }

  hasGraphicsTile(key: string): boolean {
    return this.graphicsStorage?.hasTile(key) ?? false;
  }

  clearGraphics(): void {
    this.graphicsStorage?.clear();
    this.graphics = null;
    this.graphicsUploaded = null;
  }
  constructor(
    private readonly contextRestoredCallback?: () => void,
    private readonly contextLostCallback?: () => void,
    private readonly frameCompleteCallback?: (id: number) => void,
    private readonly errorCallback?: (error: Error) => void,
  ) {}

  private canvas: OffscreenCanvas | null = null;
  private context: GPUCanvasContext | null = null;
  private device: GPUDevice | null = null;
  private ready = false;
  private destroyed = false;
  private initializing = false;
  private recovering = false;
  private failed = false;
  private generation = 0;
  private nextFrameId = 1;
  private frameCount = 0;
  private readonly frameIds = new Uint32Array(MAX_IN_FLIGHT_RENDER_FRAMES);
  private readonly frameUploadBytes = new Float64Array(MAX_IN_FLIGHT_RENDER_FRAMES);
  private readonly frameRetiredBytes = new Float64Array(MAX_IN_FLIGHT_RENDER_FRAMES);
  private unconfirmedUploadBytes = 0;
  private unconfirmedRetiredBytes = 0;
  private pendingUploadBytes = 0;
  private pendingRetiredBytes = 0;
  private atlasAllocationBytes = 0;
  private atlasWidth = 0;
  private atlasHeight = 0;
  private atlas: GPUTexture | null = null;
  private atlasReady = false;
  private sampler: GPUSampler | null = null;
  private bindLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniform: GPUBuffer | null = null;
  private readonly uniformData = new Float32Array(UNIFORM_FLOATS);
  private uniformDirty = true;
  private backgroundPipeline: GPURenderPipeline | null = null;
  private encodedBackgroundPipeline: GPURenderPipeline | null = null;
  private glyphPipeline: GPURenderPipeline | null = null;
  private decorationPipeline: GPURenderPipeline | null = null;
  private cursorPipeline: GPURenderPipeline | null = null;
  private readonly cells: GeometryStorage = storage(CELL_BYTES);
  private readonly overlay: GeometryStorage = storage(CELL_BYTES);
  private readonly cursor: GeometryStorage = storage(32);
  private readonly previewCells: GeometryStorage = storage(CELL_BYTES);
  private readonly previewCursor: GeometryStorage = storage(32);
  // Append-only within an epoch: only entries past `count` upload.
  private glyphTable: GPUBuffer | null = null;
  private glyphTableCapacity = 0;
  private glyphTableEpoch = -1;
  private glyphTableCount = 0;
  private readonly previewRange: GeometryBuffer = {
    ptr: 0,
    count: 0,
    version: 0,
    dirtyOffset: 0,
    dirtyCount: 0,
  };
  private readonly clearValue: GPUColorDict = { r: 0, g: 0, b: 0, a: 1 };
  private attachment: GPURenderPassColorAttachment | null = null;
  private readonly encodedClearValue: GPUColorDict = { r: 0, g: 0, b: 0, a: 1 };
  private passDescriptor: GPURenderPassDescriptor | null = null;
  private readonly submission: GPUCommandBuffer[] = [];

  async init(
    canvas: OffscreenCanvas,
    atlasW: number,
    atlasH: number,
    clearColor: readonly [number, number, number] = DEFAULT_TERMINAL_THEME.background,
  ): Promise<void> {
    if (this.canvas !== null || this.destroyed) throw new Error('renderer already initialized');
    assertAtlasDimensions(atlasW, atlasH);
    this.canvas = canvas;
    this.atlasWidth = atlasW;
    this.atlasHeight = atlasH;
    this.setClearColor(clearColor);
    try {
      await this.initializeDevice();
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  setClearColor(color: readonly [number, number, number]): void {
    this.encodedClearValue.r = color[0] / 255;
    this.clearValue.r = srgbToLinear(color[0] / 255);
    this.encodedClearValue.g = color[1] / 255;
    this.clearValue.g = srgbToLinear(color[1] / 255);
    this.encodedClearValue.b = color[2] / 255;
    this.clearValue.b = srgbToLinear(color[2] / 255);
  }

  uploadAtlas(
    pixels: Uint8Array,
    dirtyRect: [number, number, number, number],
    atlasDimensions: readonly [number, number],
  ): void {
    const [width, height] = atlasDimensions;
    assertAtlasDimensions(width, height, pixels.byteLength);
    const [x, y, w, h] = dirtyRect;
    if (
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      !Number.isSafeInteger(w) ||
      !Number.isSafeInteger(h) ||
      x < 0 ||
      y < 0 ||
      w < 0 ||
      h < 0 ||
      x + w > width ||
      y + h > height
    )
      throw new RangeError('invalid glyph atlas dirty rectangle');
    // The owner must upload the current full atlas after restoration. Never
    // retain a WASM view across memory growth or copy the full atlas per update.
    if (!this.ready || this.device === null) return;
    if (!this.canSubmitFrame()) throw new Error('atlas upload exceeds renderer admission budget');
    if (
      this.pendingUploadBytes >= MAX_UNCONFIRMED_UPLOAD_BYTES ||
      this.pendingRetiredBytes >= MAX_UNCONFIRMED_RETIRED_BYTES
    )
      throw new Error('unsubmitted atlas updates exceed renderer admission budget');
    const resized = width !== this.atlasWidth || height !== this.atlasHeight;
    if (resized) {
      this.atlasWidth = width;
      this.atlasHeight = height;
      this.replaceAtlas();
    }
    const texture = this.atlas;
    if (texture === null) throw new Error('glyph atlas unavailable');
    const full = !this.atlasReady || resized;
    if (!full && (w === 0 || h === 0)) return;
    // writeTexture accepts unaligned row pitches; the 256-byte restriction is
    // for buffer-to-texture command copies, not this queue operation.
    this.device.queue.writeTexture(
      { texture, origin: { x: full ? 0 : x, y: full ? 0 : y } },
      pixels,
      { offset: full ? 0 : y * width + x, bytesPerRow: width },
      { width: full ? width : w, height: full ? height : h },
    );
    // Account the addressed source span, including row pitch, not just texels.
    const uploadBytes = full ? width * height : h === 0 ? 0 : (h - 1) * width + w;
    this.pendingUploadBytes += uploadBytes;
    this.atlasReady = true;
  }

  render(
    memory: ArrayBuffer,
    geometry: GeometryRenderState,
    preview?: TerminalPreviewGeometry,
  ): number {
    if (this.failed) throw new Error('WebGPU renderer failed');
    if (!this.ready || this.device === null || this.context === null) return 0;
    if (!this.canSubmitFrame()) throw new Error('renderer submission exceeds admission budget');
    if (geometry.glyphs.count > 0 && !this.atlasReady)
      throw new Error('glyph atlas must be uploaded before rendering');
    const device = this.device;
    const [width, height] = geometry.viewport;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      throw new RangeError('invalid terminal viewport');
    // All writes, encoding, and submit stay in this synchronous ownership turn.
    // Reusing these buffers after the preceding submit is queue-ordered and
    // does not require waiting for its completion promise.
    this.uploadGlyphTable(memory, geometry.glyphs);
    this.uploadGeometry(this.cells, memory, geometry.cells);
    this.uploadGeometry(this.overlay, memory, geometry.overlay);
    this.uploadGeometry(this.cursor, memory, geometry.cursor);
    if (preview !== undefined) {
      if (preview.cellCount > MAX_PREVIEW_CELLS || preview.cursorCount > 1)
        throw new RangeError('terminal preview exceeds bounded capacity');
      this.uploadPreview(this.previewCells, preview.cells, preview.cellCount, preview.version);
      this.uploadPreview(this.previewCursor, preview.cursor, preview.cursorCount, preview.version);
    }
    if (
      this.uniform === null ||
      this.backgroundPipeline === null ||
      this.encodedBackgroundPipeline === null ||
      this.glyphPipeline === null ||
      this.decorationPipeline === null ||
      this.cursorPipeline === null ||
      this.bindGroup === null ||
      this.attachment === null ||
      this.passDescriptor === null
    )
      throw new Error('WebGPU scene resources unavailable');
    this.updateUniform(width, height, geometry.params);
    const encoder = device.createCommandEncoder();
    const graphicsWork = this.graphics?.prepare();
    if (graphicsWork !== undefined) {
      this.pendingUploadBytes += graphicsWork.bytes;
      this.pendingRetiredBytes += graphicsWork.retiredBytes;
    }
    const surface = this.context.getCurrentTexture();
    const linearView = surface.createView({ format: 'rgba8unorm-srgb' });
    const graphicsLayers = this.graphics?.drawableLayers() ?? 0;
    const imagesBelowText = (graphicsLayers & 3) !== 0;
    const imagesAboveText = (graphicsLayers & 4) !== 0;
    const encodedView = graphicsLayers === 0 ? null : surface.createView();
    const cells = geometry.cells.count;
    const overlay = geometry.overlay.count;
    this.attachment.view = imagesBelowText && encodedView !== null ? encodedView : linearView;
    this.attachment.loadOp = 'clear';
    this.attachment.clearValue = imagesBelowText ? this.encodedClearValue : this.clearValue;
    let pass = encoder.beginRenderPass(this.passDescriptor);
    if (imagesBelowText) this.graphics?.draw(pass, 0);
    pass.setBindGroup(0, this.bindGroup);
    const backgrounds = imagesBelowText ? this.encodedBackgroundPipeline : this.backgroundPipeline;
    this.draw(pass, backgrounds, this.cells, cells);
    this.draw(pass, backgrounds, this.overlay, overlay);
    if (imagesBelowText) {
      this.graphics?.draw(pass, 1);
      pass.end();
      this.attachment.view = linearView;
      this.attachment.loadOp = 'load';
      pass = encoder.beginRenderPass(this.passDescriptor);
      pass.setBindGroup(0, this.bindGroup);
    }
    this.draw(pass, this.glyphPipeline, this.cells, cells);
    this.draw(pass, this.glyphPipeline, this.overlay, overlay);
    this.draw(pass, this.decorationPipeline, this.cells, cells);
    this.draw(pass, this.decorationPipeline, this.overlay, overlay);
    if (imagesAboveText && encodedView !== null) {
      pass.end();
      this.attachment.view = encodedView;
      this.attachment.loadOp = 'load';
      pass = encoder.beginRenderPass(this.passDescriptor);
      this.graphics?.draw(pass, 2);
      if (
        geometry.cursor.count > 0 ||
        (preview !== undefined && (preview.cellCount > 0 || preview.cursorCount > 0))
      ) {
        pass.end();
        this.attachment.view = linearView;
        pass = encoder.beginRenderPass(this.passDescriptor);
        pass.setBindGroup(0, this.bindGroup);
      }
    }
    this.draw(pass, this.cursorPipeline, this.cursor, geometry.cursor.count);
    if (preview !== undefined && preview.cellCount > 0) {
      this.draw(pass, this.backgroundPipeline, this.previewCells, preview.cellCount);
      // A preview glyph never draws outside the cells it previews.
      const [x = 0, y = 0, clipWidth = 0, clipHeight = 0] = preview.clip;
      const left = Math.min(x, surface.width);
      const top = Math.min(y, surface.height);
      pass.setScissorRect(
        left,
        top,
        Math.min(clipWidth, surface.width - left),
        Math.min(clipHeight, surface.height - top),
      );
      this.draw(pass, this.glyphPipeline, this.previewCells, preview.cellCount);
      pass.setScissorRect(0, 0, surface.width, surface.height);
    }
    if (preview !== undefined)
      this.draw(pass, this.cursorPipeline, this.previewCursor, preview.cursorCount);
    pass.end();
    this.submission[0] = encoder.finish();
    device.queue.submit(this.submission);
    const graphicsComplete = this.graphics?.submitted();
    const graphicsUploaded = this.graphicsUploaded;
    this.submission.length = 0;
    const id = this.nextFrameId;
    this.nextFrameId = (id + 1) >>> 0 || 1;
    const slot = this.frameIds.indexOf(0);
    if (slot < 0) throw new Error('missing GPU submission credit');
    this.frameIds[slot] = id;
    this.frameUploadBytes[slot] = this.pendingUploadBytes;
    this.frameRetiredBytes[slot] = this.pendingRetiredBytes;
    this.unconfirmedUploadBytes += this.pendingUploadBytes;
    this.unconfirmedRetiredBytes += this.pendingRetiredBytes;
    this.pendingUploadBytes = 0;
    this.pendingRetiredBytes = 0;
    this.frameCount += 1;
    const generation = this.generation;
    try {
      void device.queue.onSubmittedWorkDone().then(
        () => {
          if (!this.ready || generation !== this.generation || this.device !== device) return;
          if (this.frameIds[slot] !== id) {
            this.fail(new Error('GPU completion owner mismatch'));
            return;
          }
          this.frameIds[slot] = 0;
          this.unconfirmedUploadBytes -= this.frameUploadBytes[slot] ?? 0;
          this.unconfirmedRetiredBytes -= this.frameRetiredBytes[slot] ?? 0;
          this.frameUploadBytes[slot] = 0;
          this.frameRetiredBytes[slot] = 0;
          this.frameCount -= 1;
          this.recovering = false;
          graphicsComplete?.();
          if (graphicsWork?.uploaded !== null && graphicsWork?.uploaded !== undefined)
            graphicsUploaded?.(graphicsWork.uploaded);
          this.frameCompleteCallback?.(id);
        },
        () => {
          if (generation === this.generation && this.device === device)
            this.deviceLost(device, generation);
        },
      );
    } catch (error) {
      this.fail(toError(error));
      throw error;
    }
    return id;
  }

  frameInFlight(): boolean {
    return this.frameCount > 0;
  }
  canSubmitFrame(): boolean {
    return (
      this.ready &&
      !this.failed &&
      this.frameCount < MAX_IN_FLIGHT_RENDER_FRAMES &&
      this.unconfirmedUploadBytes < MAX_UNCONFIRMED_UPLOAD_BYTES &&
      this.unconfirmedRetiredBytes < MAX_UNCONFIRMED_RETIRED_BYTES
    );
  }

  resize(width: number, height: number): void {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
      throw new RangeError('invalid canvas dimensions');
    if (this.canvas === null) return;
    if (
      this.device !== null &&
      (width > this.device.limits.maxTextureDimension2D ||
        height > this.device.limits.maxTextureDimension2D)
    )
      throw new RangeError('canvas exceeds WebGPU device limits');
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ready = false;
    this.generation += 1;
    this.releaseResources();
    this.context?.unconfigure();
    this.context = null;
    this.canvas = null;
  }

  private async initializeDevice(): Promise<void> {
    const gpu = navigator.gpu;
    if (gpu === undefined) throw new Error('WebGPU is required for terminal rendering');
    const generation = ++this.generation;
    this.initializing = true;
    try {
      const adapter = await gpu.requestAdapter();
      this.assertInitialization(generation);
      if (adapter === null) throw new Error('WebGPU adapter unavailable');
      const device = await adapter.requestDevice();
      if (this.destroyed || generation !== this.generation) {
        device.destroy();
        throw new Error('WebGPU initialization cancelled');
      }
      this.device = device;
      void device.lost.then(() => this.deviceLost(device, generation));
      device.addEventListener('uncapturederror', (event: GPUUncapturedErrorEvent) => {
        if (this.device === device && generation === this.generation)
          this.fail(toError(event.error));
      });
      const canvas = this.canvas;
      if (canvas === null) throw new Error('WebGPU canvas unavailable');
      const context = canvas.getContext('webgpu');
      if (context === null || !('configure' in context) || !('getCurrentTexture' in context))
        throw new Error('WebGPU canvas context unavailable');
      const gpuContext = context as GPUCanvasContext;
      this.context = gpuContext;
      // `rgba8unorm`, deliberately not `getPreferredCanvasFormat()`. Firefox's
      // shared-texture swap chain (`wgpu_client_use_shared_texture_in_swapChain`)
      // accepts only `bgra8unorm` and pushes to the compositor without waiting
      // for the GPU write, so from a worker the preferred format shows a frame
      // four to seven submissions old for one refresh. Any other format takes
      // its readback presenter, which completes the copy before it presents.
      // Measured in PERF.md (2026-09-08): in order on every submit pattern,
      // presentation latency unchanged in Firefox and within noise in Chromium.
      // Text blends linear coverage against the actual destination in hardware.
      // Images retain their encoded-color blend through the same texture's unorm view.
      const format: GPUTextureFormat = 'rgba8unorm-srgb';
      gpuContext.configure({
        device,
        format: 'rgba8unorm',
        viewFormats: [format],
        colorSpace: 'srgb',
        alphaMode: 'opaque',
      });
      this.resize(canvas.width, canvas.height);
      // Configuring the canvas is what makes it visible, and `alphaMode:
      // 'opaque'` means a surface with no submitted frame composites as black
      // rather than as nothing. WebKit does exactly that — measured, three runs
      // (`PERF.md`, 2026-09-08) — so between this line and the first submitted
      // frame the panel wears a black rectangle. Nothing else submits until the
      // daemon's first display frame, so that gap is the whole of a connect.
      //
      // This present must stay on this side of the pipeline compile below.
      // `createRenderPipelineAsync` is awaited, takes as long as a cold shader
      // cache takes, and is the reason the flash came and went: with a warm
      // cache there was nothing to see, and with a cold one the surface sat at
      // full black for the length of the compile.
      //
      // Geometry-free by construction, so the blank grid's cursor — invented
      // state with no authority behind it — never reaches the screen either,
      // and deliberately outside the frame-credit accounting: it uploads
      // nothing, so it bounds nothing, and owns no render identity for a
      // completion to retire.
      this.presentClearedSurface(device, gpuContext);
      this.uniform = device.createBuffer({
        size: UNIFORM_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.uniformDirty = true;
      this.glyphTable = device.createBuffer({
        size: MIN_GLYPH_TABLE_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.glyphTableCapacity = MIN_GLYPH_TABLE_BYTES;
      this.glyphTableEpoch = -1;
      this.glyphTableCount = 0;
      this.sampler = device.createSampler({
        // Glyphs are rasterized at the physical display size, with integer
        // placement. Preserve their coverage rather than resampling the mask.
        minFilter: 'nearest',
        magFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });
      const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
      this.bindLayout = device.createBindGroupLayout({
        entries: [
          // The decoration fragment reads the cell height; the glyph vertex
          // stage reads the atlas size and the glyph table.
          { binding: 0, visibility: both, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: both, texture: { sampleType: 'float' } },
          { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        ],
      });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bindLayout] });
      const module = device.createShaderModule({ code: SHADER });
      const pipelines = await Promise.all([
        this.createPipeline(device, layout, module, format, 'cell_background', CELL_LAYOUT),
        this.createPipeline(
          device,
          layout,
          module,
          'rgba8unorm',
          'encoded_cell_background',
          CELL_LAYOUT,
        ),
        this.createPipeline(
          device,
          layout,
          module,
          format,
          'cell_glyph',
          CELL_LAYOUT,
          COVERAGE_BLEND,
        ),
        this.createPipeline(device, layout, module, format, 'cell_decoration', CELL_LAYOUT),
        this.createPipeline(
          device,
          layout,
          module,
          format,
          'cursor',
          CURSOR_LAYOUT,
          COVERAGE_BLEND,
        ),
      ]);
      this.assertInitialization(generation);
      [
        this.backgroundPipeline,
        this.encodedBackgroundPipeline,
        this.glyphPipeline,
        this.decorationPipeline,
        this.cursorPipeline,
      ] = pipelines;
      this.replaceAtlas();
      if (this.atlas === null) throw new Error('WebGPU atlas unavailable');
      this.attachment = {
        view: this.atlas.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: this.clearValue,
      };
      this.passDescriptor = { colorAttachments: [this.attachment] };
      this.ready = true;
    } finally {
      this.initializing = false;
    }
  }

  /**
   * Fill a freshly configured surface with the terminal background.
   *
   * Runs before any of this renderer's scene resources exist, so it builds its
   * own attachment rather than reusing `passDescriptor`: the point is to submit
   * in the same synchronous turn as `configure`, and everything else is behind
   * an await.
   */
  private presentClearedSurface(device: GPUDevice, context: GPUCanvasContext): void {
    const encoder = device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView({ format: 'rgba8unorm-srgb' }),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: this.clearValue,
          },
        ],
      })
      .end();
    this.submission[0] = encoder.finish();
    device.queue.submit(this.submission);
    this.submission.length = 0;
  }

  private createPipeline(
    device: GPUDevice,
    layout: GPUPipelineLayout,
    module: GPUShaderModule,
    format: GPUTextureFormat,
    entry: string,
    buffer: GPUVertexBufferLayout,
    blend?: GPUBlendState,
  ): Promise<GPURenderPipeline> {
    return device.createRenderPipelineAsync({
      layout,
      vertex: { module, entryPoint: entry, buffers: [buffer] },
      fragment: { module, entryPoint: `${entry}_fragment`, targets: [{ format, blend }] },
      primitive: { topology: 'triangle-strip' },
    });
  }

  private assertInitialization(generation: number): void {
    if (this.destroyed || this.failed || generation !== this.generation)
      throw new Error('WebGPU initialization cancelled');
  }

  private deviceLost(device: GPUDevice, generation: number): void {
    if (this.destroyed || this.failed || this.device !== device || this.generation !== generation)
      return;
    if (this.initializing || this.recovering) {
      this.fail(new Error('WebGPU device failed before recovery completed'));
      return;
    }
    this.ready = false;
    this.recovering = true;
    this.generation += 1;
    this.releaseResources();
    this.contextLostCallback?.();
    if (this.destroyed || this.failed) return;
    // One recovery attempt, never a retry loop or another rendering backend.
    void this.initializeDevice().then(
      () => {
        if (this.ready && !this.destroyed) this.contextRestoredCallback?.();
      },
      (error: unknown) => {
        if (!this.destroyed) this.fail(toError(error));
      },
    );
  }

  private fail(error: Error): void {
    if (this.failed || this.destroyed) return;
    this.failed = true;
    this.ready = false;
    this.generation += 1;
    this.releaseResources();
    this.contextLostCallback?.();
    if (this.errorCallback !== undefined) this.errorCallback(error);
    else
      queueMicrotask(() => {
        throw error;
      });
  }

  private releaseResources(): void {
    this.graphicsStorage?.destroy();
    this.graphicsStorage = null;
    this.graphics = null;
    this.graphicsUploaded = null;
    this.frameIds.fill(0);
    this.frameUploadBytes.fill(0);
    this.frameRetiredBytes.fill(0);
    this.unconfirmedUploadBytes = 0;
    this.unconfirmedRetiredBytes = 0;
    this.pendingUploadBytes = 0;
    this.pendingRetiredBytes = 0;
    this.atlasAllocationBytes = 0;
    this.frameCount = 0;
    this.submission.length = 0;
    for (const geometry of [
      this.cells,
      this.overlay,
      this.cursor,
      this.previewCells,
      this.previewCursor,
    ]) {
      geometry.buffer?.destroy();
      geometry.buffer = null;
      geometry.capacity = 0;
      geometry.version = -1;
    }
    this.glyphTable?.destroy();
    this.glyphTable = null;
    this.glyphTableCapacity = 0;
    this.glyphTableEpoch = -1;
    this.glyphTableCount = 0;
    this.uniform?.destroy();
    this.uniform = null;
    this.atlas?.destroy();
    this.atlas = null;
    this.atlasReady = false;
    this.bindGroup = null;
    this.bindLayout = null;
    this.sampler = null;
    this.backgroundPipeline = null;
    this.encodedBackgroundPipeline = null;
    this.glyphPipeline = null;
    this.decorationPipeline = null;
    this.cursorPipeline = null;
    this.attachment = null;
    this.passDescriptor = null;
    const device = this.device;
    this.device = null;
    device?.destroy();
  }

  private replaceAtlas(): void {
    const device = this.device;
    if (
      device === null ||
      this.uniform === null ||
      this.sampler === null ||
      this.bindLayout === null
    )
      throw new Error('WebGPU atlas resources unavailable');
    if (
      this.atlasWidth > device.limits.maxTextureDimension2D ||
      this.atlasHeight > device.limits.maxTextureDimension2D
    )
      throw new RangeError('glyph atlas exceeds WebGPU device limits');
    const previous = this.atlas;
    this.pendingRetiredBytes += this.atlasAllocationBytes;
    this.atlasAllocationBytes = this.atlasWidth * this.atlasHeight;
    this.atlas = device.createTexture({
      size: { width: this.atlasWidth, height: this.atlasHeight },
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.bindResources();
    this.atlasReady = false;
    // Prior uses have already been submitted; destruction does not invalidate
    // work submitted before destroy. No encoded-but-unsubmitted scene survives.
    previous?.destroy();
  }

  /** One bind group names the uniform, sampler, atlas and glyph table. */
  private bindResources(): void {
    const device = this.device;
    if (
      device === null ||
      this.uniform === null ||
      this.sampler === null ||
      this.bindLayout === null ||
      this.atlas === null ||
      this.glyphTable === null
    )
      throw new Error('WebGPU bind resources unavailable');
    this.bindGroup = device.createBindGroup({
      layout: this.bindLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.atlas.createView() },
        { binding: 3, resource: { buffer: this.glyphTable } },
      ],
    });
  }

  private updateUniform(width: number, height: number, params: Float32Array): void {
    const data = this.uniformData;
    // viewport, cell width and height, baseline; the highlight starts at its
    // vec3 alignment, the ninth float.
    if (
      !this.uniformDirty &&
      data[0] === width &&
      data[1] === height &&
      data[2] === params[0] &&
      data[3] === params[1] &&
      data[4] === params[2] &&
      data[8] === params[3] &&
      data[9] === params[4] &&
      data[10] === params[5]
    )
      return;
    if (this.uniform === null || this.device === null)
      throw new Error('WebGPU uniform unavailable');
    data[0] = width;
    data[1] = height;
    data.set(params.subarray(0, 3), 2);
    data.set(params.subarray(3, 6), 8);
    this.device.queue.writeBuffer(this.uniform, 0, data, 0, UNIFORM_FLOATS);
    this.pendingUploadBytes += data.byteLength;
    this.uniformDirty = false;
  }

  /** Upload the glyph table entries added since the last upload of its epoch. */
  private uploadGlyphTable(memory: ArrayBuffer, table: GlyphTableRange): void {
    const device = this.device;
    if (device === null || this.glyphTable === null) throw new Error('WebGPU device unavailable');
    const { ptr, count, epoch } = table;
    const bytes = count * GLYPH_ENTRY_BYTES;
    if (!validRange(ptr, count, bytes, memory, device))
      throw new RangeError('invalid glyph table range');
    let from =
      epoch === this.glyphTableEpoch && count >= this.glyphTableCount ? this.glyphTableCount : 0;
    if (bytes > this.glyphTableCapacity) {
      const capacity = Math.min(nextPowerOfTwo(bytes), device.limits.maxBufferSize);
      const buffer = device.createBuffer({
        size: capacity,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.pendingRetiredBytes += this.glyphTableCapacity;
      this.glyphTable.destroy();
      this.glyphTable = buffer;
      this.glyphTableCapacity = capacity;
      this.bindResources();
      from = 0;
    }
    if (count > from) {
      device.queue.writeBuffer(
        this.glyphTable,
        from * GLYPH_ENTRY_BYTES,
        memory,
        ptr + from * GLYPH_ENTRY_BYTES,
        (count - from) * GLYPH_ENTRY_BYTES,
      );
      this.pendingUploadBytes += (count - from) * GLYPH_ENTRY_BYTES;
    }
    this.glyphTableEpoch = epoch;
    this.glyphTableCount = count;
  }

  private uploadGeometry(
    storage: GeometryStorage,
    memory: ArrayBuffer,
    range: GeometryBuffer,
  ): void {
    const device = this.device;
    if (device === null) throw new Error('WebGPU device unavailable');
    const { ptr, count, version, dirtyOffset, dirtyCount } = range;
    const bytes = count * storage.stride;
    if (!validRange(ptr, count, bytes, memory, device))
      throw new RangeError('invalid terminal geometry range');
    if (count === 0) return;
    if (bytes > storage.capacity) {
      const capacity = Math.min(nextPowerOfTwo(bytes), device.limits.maxBufferSize);
      const buffer = device.createBuffer({
        size: capacity,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.pendingRetiredBytes += storage.capacity;
      storage.buffer?.destroy();
      storage.buffer = buffer;
      storage.capacity = capacity;
      storage.version = -1;
    }
    if (version === storage.version) return;
    const full = storage.version < 0;
    const offset = full ? 0 : dirtyOffset;
    const length = full ? count : dirtyCount;
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > count
    )
      throw new RangeError('invalid terminal dirty geometry range');
    if (storage.buffer === null) throw new Error('terminal geometry buffer unavailable');
    if (length > 0) {
      device.queue.writeBuffer(
        storage.buffer,
        offset * storage.stride,
        memory,
        ptr + offset * storage.stride,
        length * storage.stride,
      );
      this.pendingUploadBytes += length * storage.stride;
    }
    storage.version = version;
  }

  private draw(
    pass: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    storage: GeometryStorage,
    count: number,
  ): void {
    if (count === 0) return;
    if (storage.buffer === null) throw new Error('terminal geometry buffer unavailable');
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, storage.buffer);
    pass.draw(4, count);
  }

  private uploadPreview(
    storage: GeometryStorage,
    data: Uint32Array<ArrayBuffer> | Float32Array<ArrayBuffer>,
    count: number,
    version: number,
  ): void {
    if (count * storage.stride > data.byteLength)
      throw new RangeError('invalid terminal preview geometry');
    const range = this.previewRange;
    range.ptr = data.byteOffset;
    range.count = count;
    range.version = version;
    range.dirtyCount = count;
    this.uploadGeometry(storage, data.buffer, range);
  }
}

/** A word-aligned `count`-record span of WASM memory one GPU buffer can hold. */
function validRange(
  ptr: number,
  count: number,
  bytes: number,
  memory: ArrayBuffer,
  device: GPUDevice,
): boolean {
  return (
    Number.isSafeInteger(ptr) &&
    Number.isSafeInteger(count) &&
    ptr >= 0 &&
    count >= 0 &&
    ptr % 4 === 0 &&
    ptr + bytes <= memory.byteLength &&
    bytes <= device.limits.maxBufferSize
  );
}

function assertAtlasDimensions(width: number, height: number, bytes = width * height): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height !== bytes
  )
    throw new RangeError('invalid glyph atlas dimensions');
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
