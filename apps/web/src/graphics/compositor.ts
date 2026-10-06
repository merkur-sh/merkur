import { type AtlasRegion, GraphicsAtlas } from './atlas';
import type { ImageScene } from './scene';

declare const GPUBufferUsage: {
  readonly VERTEX: number;
  readonly COPY_DST: number;
  readonly STORAGE: number;
};
declare const GPUTextureUsage: {
  readonly TEXTURE_BINDING: number;
  readonly COPY_DST: number;
  readonly RENDER_ATTACHMENT: number;
};
declare const GPUShaderStage: { readonly VERTEX: number; readonly FRAGMENT: number };

const SIDE = 258;
const LAYERS = 16;
const PAGE_BYTES = SIDE * SIDE * LAYERS * 4;
const MAX_PAGES = Math.floor((64 * 1024 * 1024) / PAGE_BYTES);
const SHADER = `
@group(0) @binding(0) var<uniform> viewport: vec2f;
@group(0) @binding(1) var image_sampler: sampler;
@group(0) @binding(2) var images: texture_2d_array<f32>;
struct Mapping { offset: vec2f, layer: u32, padding: u32 };
@group(0) @binding(3) var<storage, read> mappings: array<Mapping>;
struct Out {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) layer: u32,
};
@vertex fn vertex(@builtin(vertex_index) i: u32,
  @location(0) rect: vec4f, @location(1) uv: vec4f, @location(2) layer: f32) -> Out {
  let corners = array<vec2f, 6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  let c = corners[i];
  let p = select(rect.xy, rect.zw, c > vec2f(0.5));
  var out: Out;
  out.position = vec4f(p / viewport * vec2f(2,-2) + vec2f(-1,1), 0, 1);
  let mapping = mappings[u32(layer)];
  out.uv = uv.xy + c * uv.zw + mapping.offset;
  out.layer = mapping.layer;
  return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  return textureSample(images, image_sampler, in.uv, in.layer);
}`;

interface Page {
  texture: GPUTexture;
  bind: GPUBindGroup;
  atlas: GraphicsAtlas;
}
interface Tile {
  page: Page;
  region: AtlasRegion;
  resident: boolean;
}
interface Run {
  key: string;
  layer: number;
  first: number;
  count: number;
}

/** A lazy image pass inside the terminal's existing command submission. All
 * demanded regions are reserved before any fetch, so arrival order cannot cause
 * fragmentation or leave a decoded tile waiting forever for texture space. */
export class GraphicsCompositor {
  private readonly pages: Page[] = [];
  private readonly tiles = new Map<string, Tile>();
  private readonly queued = new Map<string, ImageBitmap>();
  private readonly runs: Run[] = [];
  private readonly indices = new Map<string, number>();
  private readonly mappings = new Uint32Array(4096 * 4);
  private readonly mappingFloats = new Float32Array(this.mappings.buffer);
  private readonly mappingBuffer: GPUBuffer;
  private wanted = new Set<string>();
  private readonly bindings = new Map<string, string>();
  private readonly mappingChanges = new Set<string>();
  private scene: ImageScene = { tiles: [], quads: [] };
  private buffer: GPUBuffer | null = null;
  private capacity = 0;
  private vertices = new Float32Array(0);
  private dirty = true;
  private drawableLayerMask = 0;
  private progressed = false;
  private disposed = false;
  private pipeline: GPURenderPipeline | null = null;
  private layout: GPUBindGroupLayout;
  private sampler: GPUSampler;

  constructor(
    private device: GPUDevice,
    private uniform: GPUBuffer,
    private wake: () => void,
    private fail: (error: unknown) => void,
  ) {
    this.mappingBuffer = device.createBuffer({
      size: this.mappings.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const module = device.createShaderModule({ code: SHADER });
    void device
      .createRenderPipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: 36,
              stepMode: 'instance',
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x4' },
                { shaderLocation: 1, offset: 16, format: 'float32x4' },
                { shaderLocation: 2, offset: 32, format: 'float32' },
              ],
            },
          ],
        },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: 'rgba8unorm',
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
      })
      .then(
        (pipeline) => {
          if (this.disposed) return;
          this.pipeline = pipeline;
          this.wake();
        },
        (error: unknown) => {
          if (!this.disposed) this.fail(error);
        },
      );
  }

  setScene(scene: ImageScene): boolean {
    const wanted = new Set(scene.tiles.map((tile) => tile.key));
    // A visible animation's previous complete frame stays pinned until the
    // successor is wholly resident. Cached frames are evicted only for actual
    // atlas admission, in last-use order, never by a clock or age threshold.
    const protectedKeys = new Set(wanted);
    for (const group of scene.animations ?? [])
      for (const key of group.bindings.keys()) {
        const old = this.bindings.get(key);
        if (old !== undefined) protectedKeys.add(old);
      }
    const added: string[] = [];
    for (const demand of scene.tiles) {
      const existing = this.tiles.get(demand.key);
      if (existing !== undefined) {
        this.tiles.delete(demand.key);
        this.tiles.set(demand.key, existing);
        continue;
      }
      let tile = this.tiles.size < 4096 ? this.allocate(demand.width, demand.height) : null;
      while (tile === null) {
        let evicted = false;
        for (const [key, cached] of this.tiles) {
          if (protectedKeys.has(key)) continue;
          this.queued.get(key)?.close();
          this.queued.delete(key);
          cached.region.release();
          this.tiles.delete(key);
          evicted = true;
          break;
        }
        if (!evicted) break;
        tile = this.allocate(demand.width, demand.height);
      }
      if (tile === null) {
        for (const key of added) {
          this.tiles.get(key)?.region.release();
          this.tiles.delete(key);
        }
        return false;
      }
      this.tiles.set(demand.key, tile);
      added.push(demand.key);
    }
    if (scene.quads !== this.scene.quads && !this.reserveSuccessor(scene, protectedKeys)) {
      for (const key of added) {
        this.tiles.get(key)?.region.release();
        this.tiles.delete(key);
      }
      return false;
    }
    this.wanted = wanted;
    for (const [key, bitmap] of this.queued)
      if (!wanted.has(key)) {
        bitmap.close();
        this.queued.delete(key);
      }
    if (scene.quads !== this.scene.quads) {
      this.indices.clear();
      for (const quad of scene.quads)
        if (!this.indices.has(quad.key)) this.indices.set(quad.key, this.indices.size);
      this.dirty = true;
    }
    this.scene = scene;
    for (const key of this.bindings.keys()) if (!this.indices.has(key)) this.bindings.delete(key);
    for (const key of this.indices.keys()) if (wanted.has(key)) this.bindings.set(key, key);
    this.commitFrames();
    return true;
  }

  /** Prove double-frame capacity once per geometry, before selecting its LOD.
   * Immutable frames have identical canvas/tile shapes. Temporary exact atlas
   * allocations prove that arbitrary successor pixels fit alongside current
   * pixels; ordinary frame changes do no reservation work. */
  private reserveSuccessor(scene: ImageScene, protectedKeys: ReadonlySet<string>): boolean {
    if (!(scene.animations ?? []).some((group) => group.reserve)) return true;
    const current = new Map(scene.tiles.map((tile) => [tile.key, tile]));
    const seen = new Set(
      scene.quads.filter((quad) => current.has(quad.key)).map((quad) => quad.key),
    );
    const shapes: { width: number; height: number }[] = [];
    for (const group of scene.animations ?? []) {
      if (!group.reserve) continue;
      for (const key of group.bindings.values()) {
        const tile = current.get(key);
        if (tile === undefined) return false;
        // Shared current pixels can diverge independently in later frames. A
        // static consumer also pins its copy beyond the animation's transition.
        shapes.push(tile);
        if (seen.has(key)) shapes.push(tile);
        seen.add(key);
      }
    }
    shapes.sort((a, b) => b.height - a.height || b.width - a.width);
    const reservations: AtlasRegion[] = [];
    try {
      for (const shape of shapes) {
        let tile =
          this.tiles.size + reservations.length < 4096
            ? this.allocate(shape.width, shape.height)
            : null;
        while (tile === null) {
          let evicted = false;
          for (const [key, cached] of this.tiles) {
            if (protectedKeys.has(key)) continue;
            this.queued.get(key)?.close();
            this.queued.delete(key);
            cached.region.release();
            this.tiles.delete(key);
            evicted = true;
            break;
          }
          if (!evicted) return false;
          if (this.tiles.size + reservations.length < 4096)
            tile = this.allocate(shape.width, shape.height);
        }
        reservations.push(tile.region);
      }
      return true;
    } finally {
      for (const region of reservations) region.release();
    }
  }

  hasTile(key: string): boolean {
    return this.tiles.get(key)?.resident === true;
  }

  clear(): void {
    this.setScene({ tiles: [], quads: [] });
    for (const tile of this.tiles.values()) tile.region.release();
    this.tiles.clear();
    this.bindings.clear();
    this.mappingChanges.clear();
  }

  private commitFrames(): void {
    for (const group of this.scene.animations ?? []) {
      let ready = true;
      for (const key of group.bindings.values())
        if (!this.hasTile(key)) {
          ready = false;
          break;
        }
      if (!ready) continue;
      for (const [binding, key] of group.bindings) {
        if (this.bindings.get(binding) === key) continue;
        this.bindings.set(binding, key);
        this.mappingChanges.add(binding);
      }
    }
  }

  hasOfferCapacity(): boolean {
    return this.queued.size < 32;
  }

  offer(key: string, bitmap: ImageBitmap): boolean {
    if (
      this.disposed ||
      !this.wanted.has(key) ||
      this.tiles.get(key)?.resident ||
      this.queued.has(key)
    ) {
      bitmap.close();
      return false;
    }
    if (this.queued.size >= 32) {
      bitmap.close();
      return false;
    }
    this.queued.set(key, bitmap);
    return true;
  }

  private allocate(width: number, height: number): Tile | null {
    for (const page of this.pages) {
      const region = page.atlas.allocate(width, height);
      if (region !== null) return { page, region, resident: false };
    }
    if (this.pages.length >= MAX_PAGES) return null;
    const texture = this.device.createTexture({
      size: [SIDE, SIDE, LAYERS],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const page: Page = {
      texture,
      atlas: new GraphicsAtlas(SIDE, LAYERS),
      bind: this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: texture.createView({ dimension: '2d-array' }) },
          { binding: 3, resource: { buffer: this.mappingBuffer } },
        ],
      }),
    };
    this.pages.push(page);
    const region = page.atlas.allocate(width, height);
    return region === null ? null : { page, region, resident: false };
  }

  private mapTile(index: number, tile: Tile): void {
    this.mappingFloats[index * 4] = tile.region.x / SIDE;
    this.mappingFloats[index * 4 + 1] = tile.region.y / SIDE;
    this.mappings[index * 4 + 2] = tile.region.layer;
  }

  /** Interactive geometry is uploaded first by the caller. Each opportunity
   * admits one indivisible tile copy; the next frame is woken by GPU completion. */
  prepare(): { uploaded: string | null; bytes: number; retiredBytes: number } {
    let uploaded: string | null = null;
    let bytes = 0;
    let retiredBytes = 0;
    if (this.pipeline === null || this.disposed) return { uploaded, bytes, retiredBytes };
    const head = this.queued.entries().next().value;
    if (head !== undefined) {
      const [key, bitmap] = head;
      const tile = this.tiles.get(key);
      if (tile !== undefined) {
        this.device.queue.copyExternalImageToTexture(
          { source: bitmap },
          {
            texture: tile.page.texture,
            origin: [tile.region.x, tile.region.y, tile.region.layer],
            premultipliedAlpha: true,
            colorSpace: 'srgb',
          },
          [bitmap.width, bitmap.height],
        );
        bytes += bitmap.width * bitmap.height * 4;
        bitmap.close();
        this.queued.delete(key);
        tile.resident = true;
        uploaded = key;
        this.progressed = true;
        if (this.indices.has(key)) this.mappingChanges.add(key);
        this.commitFrames();
      }
    }
    const layersChanged = this.dirty || uploaded !== null || this.mappingChanges.size > 0;
    if (this.dirty) {
      const count = this.scene.quads.length;
      if (this.vertices.length < count * 9) this.vertices = new Float32Array(count * 9);
      this.runs.length = 0;
      this.mappings.fill(0);
      for (const [binding, key] of this.bindings) {
        const tile = this.tiles.get(key);
        const index = this.indices.get(binding);
        if (tile !== undefined && index !== undefined) this.mapTile(index, tile);
      }
      if (this.indices.size > 0) {
        const mappingBytes = this.indices.size * 16;
        this.device.queue.writeBuffer(this.mappingBuffer, 0, this.mappings.buffer, 0, mappingBytes);
        bytes += mappingBytes;
      }
      let instances = 0;
      for (let layer = 0; layer < 3; layer++)
        for (const quad of this.scene.quads) {
          if (quad.layer !== layer) continue;
          const index = this.indices.get(quad.key);
          if (index === undefined) continue;
          // Edges, selected rather than summed in the vertex stage, so a seam
          // two quads share rasterizes from one f32 value.
          const offset = instances * 9;
          this.vertices[offset] = quad.left;
          this.vertices[offset + 1] = quad.top;
          this.vertices[offset + 2] = quad.right;
          this.vertices[offset + 3] = quad.bottom;
          this.vertices[offset + 4] = quad.u;
          this.vertices[offset + 5] = quad.v;
          this.vertices[offset + 6] = quad.uw;
          this.vertices[offset + 7] = quad.vh;
          this.vertices[offset + 8] = index;
          const last = this.runs.at(-1);
          if (last !== undefined && last.key === quad.key && last.layer === layer) last.count++;
          else this.runs.push({ key: quad.key, layer, first: instances, count: 1 });
          instances++;
        }
      const required = instances * 36;
      if (required > this.capacity) {
        retiredBytes = this.capacity;
        this.buffer?.destroy();
        this.capacity = required;
        this.buffer = this.device.createBuffer({
          size: required,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
      }
      if (required > 0 && this.buffer !== null) {
        this.device.queue.writeBuffer(this.buffer, 0, this.vertices.buffer, 0, required);
        bytes += required;
      }
      this.dirty = false;
    } else {
      // A frame transition changes only texture indirection; placement vertices
      // and draw runs remain resident. All writes precede the same submission.
      for (const binding of this.mappingChanges) {
        const index = this.indices.get(binding);
        const key = this.bindings.get(binding);
        const tile = key === undefined ? undefined : this.tiles.get(key);
        if (index === undefined || tile === undefined) continue;
        this.mapTile(index, tile);
        this.device.queue.writeBuffer(
          this.mappingBuffer,
          index * 16,
          this.mappings.buffer,
          index * 16,
          16,
        );
        bytes += 16;
      }
    }
    if (layersChanged) {
      this.drawableLayerMask = 0;
      for (const run of this.runs) {
        if (run.count > 0 && this.tiles.get(this.bindings.get(run.key) ?? run.key)?.resident)
          this.drawableLayerMask |= 1 << run.layer;
      }
    }
    this.mappingChanges.clear();
    return { uploaded, bytes, retiredBytes };
  }

  /** Only resident, drawable image layers require encoded-color render passes. */
  drawableLayers(): number {
    if (this.pipeline === null || this.buffer === null) return 0;
    return this.drawableLayerMask;
  }

  draw(pass: GPURenderPassEncoder, layer: number): void {
    if (this.pipeline === null || this.buffer === null) return;
    pass.setPipeline(this.pipeline);
    pass.setVertexBuffer(0, this.buffer);
    let page: Page | null = null;
    let first = 0;
    let count = 0;
    for (const run of this.runs) {
      if (run.layer !== layer) continue;
      const tile = this.tiles.get(this.bindings.get(run.key) ?? run.key);
      const nextPage = tile?.resident ? tile.page : null;
      if (nextPage !== page || first + count !== run.first) {
        if (count > 0) pass.draw(6, count, 0, first);
        count = 0;
        first = run.first;
        page = nextPage;
        if (page !== null) pass.setBindGroup(0, page.bind);
      }
      if (tile?.resident) count += run.count;
    }
    if (count > 0) pass.draw(6, count, 0, first);
  }

  submitted(): (() => void) | null {
    if (!this.progressed) return null;
    this.progressed = false;
    // Share the terminal's existing submission completion. No additional queue
    // fence or image-only submission competes with interactive rendering.
    return () => {
      if (this.disposed) return;
      if (this.queued.size > 0) this.wake();
    };
  }

  destroy(): void {
    this.disposed = true;
    for (const bitmap of this.queued.values()) bitmap.close();
    this.queued.clear();
    this.buffer?.destroy();
    this.mappingBuffer.destroy();
    for (const page of this.pages) page.texture.destroy();
    this.pages.length = 0;
    this.tiles.clear();
  }
}
