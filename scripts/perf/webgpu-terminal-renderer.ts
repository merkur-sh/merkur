// Frozen encoded-color baseline for the archived renderer experiment.
// Production text uses hardware sRGB blending.
const GLYPH_GAMMA_DARK_FOREGROUND = 1.45;
const GLYPH_GAMMA_LIGHT_FOREGROUND = 0.69;

import type { GeometryVersions } from '../../apps/web/src/terminal-renderer';

export const FIXTURE_COLUMNS = 100;
export const FIXTURE_ROWS = 30;
export const FIXTURE_GLYPHS = FIXTURE_COLUMNS * FIXTURE_ROWS;
export const FIXTURE_BG_FLOATS = FIXTURE_ROWS * 7;
export type TerminalFixtureWorkload = 'typing' | 'redraw';

export function createTerminalFixture() {
  const storage = new Float32Array(FIXTURE_BG_FLOATS + FIXTURE_GLYPHS * 14);
  const atlas = new Uint8Array(64);
  for (let y = 0; y < 8; y += 1)
    for (let x = 0; x < 8; x += 1) atlas[y * 8 + x] = x === 1 || y === 1 || y === 6 ? 255 : 0;
  for (let row = 0; row < FIXTURE_ROWS; row += 1)
    storage.set(
      [0, row * 32, 1600, 32, 30 / 255, (((row * 7) % 200) + 30) / 255, 60 / 255],
      row * 7,
    );
  for (let index = 0; index < FIXTURE_GLYPHS; index += 1)
    storage.set(
      [
        (index % FIXTURE_COLUMNS) * 16 + 6,
        Math.floor(index / FIXTURE_COLUMNS) * 32 + 2,
        0,
        0,
        8,
        24,
        0,
        0,
        1,
        1,
        0.8,
        0.8,
        0.85,
        1,
      ],
      FIXTURE_BG_FLOATS + index * 14,
    );
  const versions: GeometryVersions = {
    bg: 0,
    glyph: 0,
    deco: 0,
    cursor: 0,
    bgDirtyOffset: 0,
    bgDirtyCount: FIXTURE_ROWS,
    glyphDirtyOffset: 0,
    glyphDirtyCount: FIXTURE_GLYPHS,
    decoDirtyOffset: 0,
    decoDirtyCount: 0,
    cursorDirtyOffset: 0,
    cursorDirtyCount: 0,
  };
  return { storage, atlas, versions };
}
export type TerminalFixture = ReturnType<typeof createTerminalFixture>;

/** Absolute replacement makes pending-ordinal coalescing semantically lossless. */
export function updateTerminalFixture(
  fixture: TerminalFixture,
  workload: TerminalFixtureWorkload,
  ordinal: number,
): void {
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) throw new Error('invalid fixture ordinal');
  const rows = workload === 'typing' ? 1 : FIXTURE_ROWS;
  const glyphs = workload === 'typing' ? 1 : FIXTURE_GLYPHS;
  for (let row = 0; row < rows; row += 1)
    fixture.storage[row * 7 + 4] = ((ordinal % 200) + 30) / 255;
  for (let index = 0; index < glyphs; index += 1) {
    const offset = FIXTURE_BG_FLOATS + index * 14;
    fixture.storage[offset + 10] = ((ordinal % 100) + 100) / 255;
    fixture.storage[offset + 11] = ((index % 100) + 100) / 255;
  }
  fixture.versions.bg = ordinal;
  fixture.versions.glyph = ordinal;
  fixture.versions.bgDirtyCount = rows;
  fixture.versions.glyphDirtyCount = glyphs;
}

export function fixtureGeometryUploadBytes(
  first: boolean,
  workload: TerminalFixtureWorkload,
): number {
  return first || workload === 'redraw'
    ? (FIXTURE_BG_FLOATS + FIXTURE_GLYPHS * 14) * 4
    : (7 + 14) * 4;
}

/** Untimed oracle covers background, opaque glyph, transparent glyph and gamma blend. */
export function terminalFixtureExpectedPixels(fixture: TerminalFixture) {
  const result: { x: number; y: number; rgba: number[] }[] = [];
  for (let row = 0; row < FIXTURE_ROWS; row += 1) {
    const bg = [4, 5, 6].map((offset) => fixture.storage[row * 7 + offset] ?? 0);
    const fg = [10, 11, 12].map(
      (offset) => fixture.storage[FIXTURE_BG_FLOATS + row * FIXTURE_COLUMNS * 14 + offset] ?? 0,
    );
    const luma = (fg[0] ?? 0) * 0.2126 + (fg[1] ?? 0) * 0.7152 + (fg[2] ?? 0) * 0.0722;
    const gamma =
      GLYPH_GAMMA_DARK_FOREGROUND +
      (GLYPH_GAMMA_LIGHT_FOREGROUND - GLYPH_GAMMA_DARK_FOREGROUND) * luma;
    for (const [x, y, coverage] of [
      [2, 16, 0],
      [7, 16, 1],
      [6, 16, 0],
      [6, 7, 2 / 3],
    ]) {
      if (x === undefined || y === undefined || coverage === undefined)
        throw new Error('invalid oracle point');
      const alpha = coverage ** gamma;
      result.push({
        x,
        y: row * 32 + y,
        rgba: [
          ...bg.map((value, index) =>
            Math.round(((fg[index] ?? 0) * alpha + value * (1 - alpha)) * 255),
          ),
          255,
        ],
      });
    }
  }
  return result;
}

/** Pure exact-owner credit accounting, common to both browser API arms. */
export class TerminalSubmissionWindow {
  private readonly owners = new Uint32Array(2);
  private pending = 0;
  private newest = 0;
  offeredCount = 0;
  submittedCount = 0;
  completedCount = 0;
  coalescedCount = 0;
  maxOutstanding = 0;

  offer(ordinal: number): void {
    if (!Number.isSafeInteger(ordinal) || ordinal !== this.newest + 1 || ordinal > 0xffff_ffff)
      throw new Error('nonsequential offer');
    this.newest = ordinal;
    this.offeredCount += 1;
    if (this.pending !== 0) this.coalescedCount += 1;
    this.pending = ordinal;
  }
  pendingOrdinal(): number {
    return this.pending;
  }
  outstanding(): number {
    return Number(this.owners[0] !== 0) + Number(this.owners[1] !== 0);
  }
  canSubmit(): boolean {
    return this.pending !== 0 && this.outstanding() < 2;
  }
  take(): number {
    if (!this.canSubmit()) throw new Error('submission without available credit');
    const ordinal = this.pending;
    this.pending = 0;
    this.owners[this.owners[0] === 0 ? 0 : 1] = ordinal;
    this.submittedCount += 1;
    this.maxOutstanding = Math.max(this.maxOutstanding, this.outstanding());
    return ordinal;
  }
  complete(ordinal: number): void {
    const slot = this.owners[0] === ordinal ? 0 : this.owners[1] === ordinal ? 1 : -1;
    if (ordinal <= 0 || slot < 0) throw new Error('completion has no exact outstanding owner');
    this.owners[slot] = 0;
    this.completedCount += 1;
  }
}

const SHADER = `
@group(0) @binding(0) var<uniform> viewport: vec2f;
@group(0) @binding(1) var atlas_sampler: sampler;
@group(0) @binding(2) var atlas: texture_2d<f32>;
const corners = array<vec2f, 6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
struct Varying { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) fg: vec3f, @location(2) alpha: f32 }
fn position(pixel: vec2f) -> vec4f { let clip = pixel / viewport * 2.0 - 1.0; return vec4f(clip.x, -clip.y, 0, 1); }
@vertex fn background(@builtin(vertex_index) vertex: u32, @location(0) rect: vec4f, @location(1) color: vec3f) -> Varying {
  var o: Varying; o.pos = position(rect.xy + corners[vertex] * rect.zw); o.uv = vec2f(0); o.fg = color; o.alpha = 1; return o;
}
@vertex fn glyph(@builtin(vertex_index) vertex: u32, @location(0) cell: vec2f, @location(1) off: vec2f,
  @location(2) size: vec2f, @location(3) uv: vec4f, @location(4) color: vec3f, @location(5) alpha: f32) -> Varying {
  var o: Varying; let corner = corners[vertex]; o.pos = position(cell + off + corner * size);
  o.uv = uv.xy + corner * (uv.zw - uv.xy); o.fg = color; o.alpha = alpha; return o;
}
@fragment fn solid_fragment(i: Varying) -> @location(0) vec4f { return vec4f(i.fg, 1); }
@fragment fn glyph_fragment(i: Varying) -> @location(0) vec4f {
  let coverage = textureSample(atlas, atlas_sampler, i.uv).r;
  let luma = dot(i.fg, vec3f(0.2126, 0.7152, 0.0722));
  let corrected = pow(coverage, mix(${GLYPH_GAMMA_DARK_FOREGROUND.toFixed(2)}, ${GLYPH_GAMMA_LIGHT_FOREGROUND.toFixed(2)}, luma));
  return vec4f(i.fg, corrected * i.alpha);
}`;

export class WebGpuFixtureRenderer {
  identity = '';
  apiUploadBytes = 0;
  createdGpuObjects = 0;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private bg: GPUBuffer | null = null;
  private glyph: GPUBuffer | null = null;
  private viewport: GPUBuffer | null = null;
  private atlas: GPUTexture | null = null;
  private bgPipeline: GPURenderPipeline | null = null;
  private glyphPipeline: GPURenderPipeline | null = null;
  private group: GPUBindGroup | null = null;
  private first = true;
  private stopped = false;

  async init(
    canvas: { getContext(kind: 'webgpu'): unknown },
    fixture: TerminalFixture,
    fail: (error: unknown) => void,
  ): Promise<void> {
    const gpu = navigator.gpu;
    if (gpu === undefined) throw new Error('WebGPU is unavailable; no fallback');
    const adapter = await gpu.requestAdapter();
    if (this.stopped) throw new Error('WebGPU initialization was stopped');
    if (adapter === null) throw new Error('WebGPU adapter unavailable');
    this.identity = JSON.stringify({
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
      description: adapter.info.description,
    });
    if (/swiftshader|llvmpipe|software/iu.test(this.identity))
      throw new Error('hardware WebGPU required');
    const device = await adapter.requestDevice();
    if (this.stopped) {
      device.destroy();
      throw new Error('WebGPU initialization was stopped');
    }
    this.device = device;
    this.createdGpuObjects += 1;
    void device.lost.then((info) => {
      if (!this.stopped) fail(new Error(`WebGPU device lost: ${info.message}`));
    });
    device.addEventListener('uncapturederror', (event) =>
      fail(new Error(`WebGPU error: ${event.error?.message ?? 'unknown'}`)),
    );
    // The installed DOM overload's generic return omits GPUCanvasContext even
    // though the WebGPU interfaces are present. Narrow the actual API surface.
    const raw: unknown = canvas.getContext('webgpu');
    if (
      raw === null ||
      typeof raw !== 'object' ||
      !('configure' in raw) ||
      typeof raw.configure !== 'function' ||
      !('getCurrentTexture' in raw) ||
      typeof raw.getCurrentTexture !== 'function' ||
      !('unconfigure' in raw) ||
      typeof raw.unconfigure !== 'function' ||
      !('getConfiguration' in raw) ||
      typeof raw.getConfiguration !== 'function'
    ) {
      throw new Error('WebGPU canvas context unavailable');
    }
    const context = raw as GPUCanvasContext;
    this.context = context;
    const format = gpu.getPreferredCanvasFormat();
    if (format !== 'bgra8unorm' && format !== 'rgba8unorm')
      throw new Error(`unexpected canvas format ${format}`);
    // Non-sRGB view intentionally blends encoded components exactly like the
    // pinned WebGL default framebuffer; no accidental linear-space correction.
    context.configure({ device, format, alphaMode: 'opaque', colorSpace: 'srgb' });
    this.bg = device.createBuffer({ size: FIXTURE_BG_FLOATS * 4, usage: 0x20 | 0x08 });
    this.glyph = device.createBuffer({ size: FIXTURE_GLYPHS * 14 * 4, usage: 0x20 | 0x08 });
    this.viewport = device.createBuffer({ size: 16, usage: 0x40 | 0x08 });
    this.atlas = device.createTexture({ size: [8, 8], format: 'r8unorm', usage: 0x04 | 0x02 });
    this.createdGpuObjects += 4;
    const viewport = new Float32Array([1600, 960, 0, 0]);
    device.queue.writeBuffer(this.viewport, 0, viewport.buffer, 0, 16);
    device.queue.writeTexture(
      { texture: this.atlas },
      fixture.atlas,
      { bytesPerRow: 8 },
      { width: 8, height: 8 },
    );
    this.apiUploadBytes += 16 + 64;
    const sampler = device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const module = device.createShaderModule({ code: SHADER });
    const bindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 1, buffer: { type: 'uniform' } },
        { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
        { binding: 2, visibility: 2, texture: { sampleType: 'float' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
    this.createdGpuObjects += 4;
    this.bgPipeline = await device.createRenderPipelineAsync({
      layout,
      vertex: {
        module,
        entryPoint: 'background',
        buffers: [
          {
            arrayStride: 28,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x4' },
              { shaderLocation: 1, offset: 16, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'solid_fragment', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    if (this.stopped) throw new Error('WebGPU initialization was stopped');
    this.glyphPipeline = await device.createRenderPipelineAsync({
      layout,
      vertex: {
        module,
        entryPoint: 'glyph',
        buffers: [
          {
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
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'glyph_fragment',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    if (this.stopped) throw new Error('WebGPU initialization was stopped');
    const view = this.atlas.createView();
    this.group = device.createBindGroup({
      layout: bindLayout,
      entries: [
        { binding: 0, resource: { buffer: this.viewport } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: view },
      ],
    });
    this.createdGpuObjects += 4;
    await device.queue.onSubmittedWorkDone();
    if (this.stopped) throw new Error('WebGPU initialization was stopped');
  }

  render(fixture: TerminalFixture, workload: TerminalFixtureWorkload): void {
    const device = this.device;
    const context = this.context;
    const bg = this.bg;
    const glyph = this.glyph;
    const bgPipeline = this.bgPipeline;
    const glyphPipeline = this.glyphPipeline;
    const group = this.group;
    if (
      device === null ||
      context === null ||
      bg === null ||
      glyph === null ||
      bgPipeline === null ||
      glyphPipeline === null ||
      group === null ||
      this.stopped
    )
      throw new Error('WebGPU renderer not ready');
    const bgBytes = (this.first || workload === 'redraw' ? FIXTURE_ROWS : 1) * 28;
    const glyphBytes = (this.first || workload === 'redraw' ? FIXTURE_GLYPHS : 1) * 56;
    device.queue.writeBuffer(bg, 0, fixture.storage.buffer, 0, bgBytes);
    device.queue.writeBuffer(glyph, 0, fixture.storage.buffer, FIXTURE_BG_FLOATS * 4, glyphBytes);
    this.apiUploadBytes += bgBytes + glyphBytes;
    this.first = false;
    const encoder = device.createCommandEncoder();
    const view = context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
      ],
    });
    pass.setBindGroup(0, group);
    pass.setPipeline(bgPipeline);
    pass.setVertexBuffer(0, bg);
    pass.draw(6, FIXTURE_ROWS);
    pass.setPipeline(glyphPipeline);
    pass.setVertexBuffer(0, glyph);
    pass.draw(6, FIXTURE_GLYPHS);
    pass.end();
    const commands = encoder.finish();
    device.queue.submit([commands]);
    // API objects: command encoder, canvas view, render pass, command buffer.
    // getCurrentTexture can return an existing wrapper: do not count it as new.
    this.createdGpuObjects += 4;
  }
  onSubmittedWorkDone(): Promise<void> {
    if (this.device === null || this.stopped)
      return Promise.reject(new Error('WebGPU renderer not ready'));
    return this.device.queue.onSubmittedWorkDone();
  }
  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.bg?.destroy();
    this.glyph?.destroy();
    this.viewport?.destroy();
    this.atlas?.destroy();
    this.context?.unconfigure();
    this.device?.destroy();
  }
}
