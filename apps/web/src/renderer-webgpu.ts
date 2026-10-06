import { nextPowerOfTwo } from '@merkur/shared';
import { GraphicsCompositor } from './graphics/compositor';
import type { ImageScene } from './graphics/scene';
import { SRGB_DECODE_WGSL, srgbToLinear } from './terminal/color-space';
import { MAX_IN_FLIGHT_RENDER_FRAMES } from './terminal/render-mailbox';
import { DEFAULT_TERMINAL_THEME } from './terminal/themes';
import type {
  GeometryBufferRange,
  GeometryVersions,
  GpuRenderer,
  TerminalPreviewGeometry,
} from './terminal-renderer';

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
};
declare const GPUTextureUsage: { readonly TEXTURE_BINDING: number; readonly COPY_DST: number };
declare const GPUShaderStage: { readonly VERTEX: number; readonly FRAGMENT: number };

// The WASM geometry ABI stays unchanged: background/decorations are seven
// floats, glyphs fourteen, and cursors eight. No full-grid JS extraction or copy.
const SHADER = `
${SRGB_DECODE_WGSL}
@group(0) @binding(0) var<uniform> viewport: vec2f;
@group(0) @binding(1) var atlas_sampler: sampler;
@group(0) @binding(2) var atlas: texture_2d<f32>;
fn corner(i: u32) -> vec2f {
  let corners = array<vec2f, 4>(vec2f(0,0), vec2f(1,0), vec2f(0,1), vec2f(1,1));
  return corners[i];
}
fn position(p: vec2f) -> vec4f {
  return vec4f(p.x / viewport.x * 2.0 - 1.0, 1.0 - p.y / viewport.y * 2.0, 0, 1);
}
struct SolidOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
};
@vertex fn solid(@builtin(vertex_index) i: u32, @location(0) rect: vec4f,
  @location(1) color: vec3f) -> SolidOutput {
  return SolidOutput(position(rect.xy + corner(i) * rect.zw), srgb_to_linear(color));
}
@vertex fn encoded_solid(@builtin(vertex_index) i: u32, @location(0) rect: vec4f,
  @location(1) color: vec3f) -> SolidOutput {
  return SolidOutput(position(rect.xy + corner(i) * rect.zw), color);
}
@fragment fn encoded_solid_fragment(v: SolidOutput) -> @location(0) vec4f {
  return vec4f(v.color, 1);
}
@fragment fn solid_fragment(v: SolidOutput) -> @location(0) vec4f {
  return vec4f(v.color, 1);
}
struct GlyphOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
  @location(2) alpha: f32,
};
@vertex fn glyph(@builtin(vertex_index) i: u32, @location(0) cell: vec2f,
  @location(1) offset: vec2f, @location(2) size: vec2f, @location(3) uv: vec4f,
  @location(4) color: vec3f, @location(5) alpha: f32) -> GlyphOutput {
  let c = corner(i);
  return GlyphOutput(position(cell + offset + c * size), mix(uv.xy, uv.zw, c), srgb_to_linear(color), alpha);
}
@fragment fn glyph_fragment(v: GlyphOutput) -> @location(0) vec4f {
  let coverage = textureSample(atlas, atlas_sampler, v.uv).r;
  return vec4f(v.color, coverage * v.alpha);
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

const SOLID_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 28,
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x4' },
    { shaderLocation: 1, offset: 16, format: 'float32x3' },
  ],
};
const GLYPH_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 56,
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' },
    { shaderLocation: 1, offset: 8, format: 'float32x2' },
    { shaderLocation: 2, offset: 16, format: 'float32x2' },
    { shaderLocation: 3, offset: 24, format: 'float32x4' },
    { shaderLocation: 4, offset: 40, format: 'float32x3' },
    { shaderLocation: 5, offset: 52, format: 'float32' },
  ],
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
  private readonly viewportData = new Float32Array(4);
  private viewportDirty = true;
  private solidPipeline: GPURenderPipeline | null = null;
  private encodedSolidPipeline: GPURenderPipeline | null = null;
  private glyphPipeline: GPURenderPipeline | null = null;
  private cursorPipeline: GPURenderPipeline | null = null;
  private readonly background: GeometryStorage = {
    buffer: null,
    stride: 28,
    capacity: 0,
    version: -1,
  };
  private readonly glyphs: GeometryStorage = { buffer: null, stride: 56, capacity: 0, version: -1 };
  private readonly decorations: GeometryStorage = {
    buffer: null,
    stride: 28,
    capacity: 0,
    version: -1,
  };
  private readonly cursor: GeometryStorage = { buffer: null, stride: 32, capacity: 0, version: -1 };
  private readonly previewBackground: GeometryStorage = {
    buffer: null,
    stride: 28,
    capacity: 0,
    version: -1,
  };
  private readonly previewGlyphs: GeometryStorage = {
    buffer: null,
    stride: 56,
    capacity: 0,
    version: -1,
  };
  private readonly previewCursor: GeometryStorage = {
    buffer: null,
    stride: 32,
    capacity: 0,
    version: -1,
  };
  private readonly previewRange = { ptr: 0, count: 0 };
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
    bg: GeometryBufferRange,
    glyph: GeometryBufferRange,
    deco: GeometryBufferRange,
    cursor: GeometryBufferRange,
    viewport: [number, number],
    versions?: GeometryVersions,
    preview?: TerminalPreviewGeometry,
  ): number {
    if (this.failed) throw new Error('WebGPU renderer failed');
    if (!this.ready || this.device === null || this.context === null) return 0;
    if (!this.canSubmitFrame()) throw new Error('renderer submission exceeds admission budget');
    if ((glyph.count > 0 || (preview?.glyphCount ?? 0) > 0) && !this.atlasReady)
      throw new Error('glyph atlas must be uploaded before rendering');
    const device = this.device;
    const [width, height] = viewport;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      throw new RangeError('invalid terminal viewport');
    // All writes, encoding, and submit stay in this synchronous ownership turn.
    // Reusing these buffers after the preceding submit is queue-ordered and
    // does not require waiting for its completion promise.
    this.uploadGeometry(
      this.background,
      memory,
      bg,
      versions?.bg,
      versions?.bgDirtyOffset,
      versions?.bgDirtyCount,
    );
    this.uploadGeometry(
      this.glyphs,
      memory,
      glyph,
      versions?.glyph,
      versions?.glyphDirtyOffset,
      versions?.glyphDirtyCount,
    );
    this.uploadGeometry(
      this.decorations,
      memory,
      deco,
      versions?.deco,
      versions?.decoDirtyOffset,
      versions?.decoDirtyCount,
    );
    this.uploadGeometry(
      this.cursor,
      memory,
      cursor,
      versions?.cursor,
      versions?.cursorDirtyOffset,
      versions?.cursorDirtyCount,
    );
    if (preview !== undefined) {
      if (preview.bgCount > 1 || preview.glyphCount > 10 || preview.cursorCount > 1)
        throw new RangeError('terminal preview exceeds bounded capacity');
      this.uploadPreview(this.previewBackground, preview.bg, preview.bgCount, preview.version);
      this.uploadPreview(this.previewGlyphs, preview.glyph, preview.glyphCount, preview.version);
      this.uploadPreview(this.previewCursor, preview.cursor, preview.cursorCount, preview.version);
    }
    if (
      this.uniform === null ||
      this.solidPipeline === null ||
      this.encodedSolidPipeline === null ||
      this.glyphPipeline === null ||
      this.cursorPipeline === null ||
      this.bindGroup === null ||
      this.attachment === null ||
      this.passDescriptor === null
    )
      throw new Error('WebGPU scene resources unavailable');
    if (this.viewportDirty || this.viewportData[0] !== width || this.viewportData[1] !== height) {
      this.viewportData[0] = width;
      this.viewportData[1] = height;
      device.queue.writeBuffer(this.uniform, 0, this.viewportData, 0, 2);
      this.pendingUploadBytes += 8;
      this.viewportDirty = false;
    }
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
    this.attachment.view = imagesBelowText && encodedView !== null ? encodedView : linearView;
    this.attachment.loadOp = 'clear';
    this.attachment.clearValue = imagesBelowText ? this.encodedClearValue : this.clearValue;
    let pass = encoder.beginRenderPass(this.passDescriptor);
    if (imagesBelowText) this.graphics?.draw(pass, 0);
    pass.setBindGroup(0, this.bindGroup);
    this.draw(
      pass,
      imagesBelowText ? this.encodedSolidPipeline : this.solidPipeline,
      this.background,
      bg.count,
    );
    if (imagesBelowText) {
      this.graphics?.draw(pass, 1);
      pass.end();
      this.attachment.view = linearView;
      this.attachment.loadOp = 'load';
      pass = encoder.beginRenderPass(this.passDescriptor);
      pass.setBindGroup(0, this.bindGroup);
    }
    this.draw(pass, this.glyphPipeline, this.glyphs, glyph.count);
    this.draw(pass, this.solidPipeline, this.decorations, deco.count);
    if (imagesAboveText && encodedView !== null) {
      pass.end();
      this.attachment.view = encodedView;
      this.attachment.loadOp = 'load';
      pass = encoder.beginRenderPass(this.passDescriptor);
      this.graphics?.draw(pass, 2);
      if (
        cursor.count > 0 ||
        (preview !== undefined &&
          (preview.bgCount > 0 || preview.glyphCount > 0 || preview.cursorCount > 0))
      ) {
        pass.end();
        this.attachment.view = linearView;
        pass = encoder.beginRenderPass(this.passDescriptor);
        pass.setBindGroup(0, this.bindGroup);
      }
    }
    this.draw(pass, this.cursorPipeline, this.cursor, cursor.count);
    if (preview !== undefined) {
      this.draw(pass, this.solidPipeline, this.previewBackground, preview.bgCount);
      this.draw(pass, this.glyphPipeline, this.previewGlyphs, preview.glyphCount);
      this.draw(pass, this.cursorPipeline, this.previewCursor, preview.cursorCount);
    }
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
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.viewportDirty = true;
      this.sampler = device.createSampler({
        // Glyphs are rasterized at the physical display size, with integer
        // placement. Preserve their coverage rather than resampling the mask.
        minFilter: 'nearest',
        magFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });
      this.bindLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        ],
      });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bindLayout] });
      const module = device.createShaderModule({ code: SHADER });
      const pipelines = await Promise.all([
        this.createPipeline(device, layout, module, format, 'solid', SOLID_LAYOUT),
        this.createPipeline(device, layout, module, 'rgba8unorm', 'encoded_solid', SOLID_LAYOUT),
        this.createPipeline(device, layout, module, format, 'glyph', GLYPH_LAYOUT, COVERAGE_BLEND),
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
      [this.solidPipeline, this.encodedSolidPipeline, this.glyphPipeline, this.cursorPipeline] =
        pipelines;
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
      this.background,
      this.glyphs,
      this.decorations,
      this.cursor,
      this.previewBackground,
      this.previewGlyphs,
      this.previewCursor,
    ]) {
      geometry.buffer?.destroy();
      geometry.buffer = null;
      geometry.capacity = 0;
      geometry.version = -1;
    }
    this.uniform?.destroy();
    this.uniform = null;
    this.atlas?.destroy();
    this.atlas = null;
    this.atlasReady = false;
    this.bindGroup = null;
    this.bindLayout = null;
    this.sampler = null;
    this.solidPipeline = null;
    this.encodedSolidPipeline = null;
    this.glyphPipeline = null;
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
    this.bindGroup = device.createBindGroup({
      layout: this.bindLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.atlas.createView() },
      ],
    });
    this.atlasReady = false;
    // Prior uses have already been submitted; destruction does not invalidate
    // work submitted before destroy. No encoded-but-unsubmitted scene survives.
    previous?.destroy();
  }

  private uploadGeometry(
    storage: GeometryStorage,
    memory: ArrayBuffer,
    range: GeometryBufferRange,
    version: number | undefined,
    dirtyOffset: number | undefined,
    dirtyCount: number | undefined,
  ): void {
    const device = this.device;
    if (device === null) throw new Error('WebGPU device unavailable');
    const { ptr, count } = range;
    const bytes = count * storage.stride;
    if (
      !Number.isSafeInteger(ptr) ||
      !Number.isSafeInteger(count) ||
      ptr < 0 ||
      count < 0 ||
      ptr % 4 !== 0 ||
      ptr + bytes > memory.byteLength ||
      bytes > device.limits.maxBufferSize
    )
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
    if (version !== undefined && version === storage.version) return;
    const full = version === undefined || storage.version < 0;
    const offset = full ? 0 : (dirtyOffset ?? 0);
    const length = full ? count : (dirtyCount ?? count);
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
    storage.version = version ?? -1;
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
    data: Float32Array<ArrayBuffer>,
    count: number,
    version: number,
  ): void {
    if (count * storage.stride > data.byteLength)
      throw new RangeError('invalid terminal preview geometry');
    this.previewRange.ptr = data.byteOffset;
    this.previewRange.count = count;
    this.uploadGeometry(storage, data.buffer, this.previewRange, version, 0, count);
  }
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
