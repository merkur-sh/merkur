import { afterEach, describe, expect, test } from 'bun:test';
import { WebGpuRenderer } from './renderer-webgpu';
import { srgbToLinear } from './terminal/color-space';
import { MAX_IN_FLIGHT_RENDER_FRAMES } from './terminal/render-mailbox';
import type { GeometryVersions, TerminalPreviewGeometry } from './terminal-renderer';

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('uninitialized promise');
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error('uninitialized promise');
  };
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeDevice() {
  const lost = deferred<{ reason: string; message: string }>();
  const completions: ReturnType<typeof deferred<void>>[] = [];
  const events: string[] = [];
  const writes: {
    buffer: object;
    offset: number;
    data: ArrayBuffer | ArrayBufferView;
    dataOffset: number;
    size: number;
  }[] = [];
  const textures: {
    descriptor: GPUTextureDescriptor;
    destroyed: number;
    createView(): object;
    destroy(): void;
  }[] = [];
  const textureWrites: {
    destination: GPUTexelCopyTextureInfo;
    data: Uint8Array;
    layout: GPUTexelCopyBufferLayout;
    size: GPUExtent3D;
  }[] = [];
  const buffers: { size: number; destroyed: number; destroy(): void }[] = [];
  const pipelines: GPURenderPipelineDescriptor[] = [];
  const pipelinePrimitives = new WeakMap<object, GPUPrimitiveTopology>();
  const passes: {
    descriptor: GPURenderPassDescriptor;
    attachment: GPURenderPassColorAttachment | undefined;
    draws: number[];
    pipelines: object[];
  }[] = [];
  const shaderCodes: string[] = [];
  let errorListener: ((event: { error: Error }) => void) | undefined;
  let pipelineGate: Promise<object> | null = null;
  const externalCopies: GPUCopyExternalImageDestInfo[] = [];
  const queue = {
    copyExternalImageToTexture(
      _source: GPUCopyExternalImageSourceInfo,
      destination: GPUCopyExternalImageDestInfo,
    ) {
      externalCopies.push(destination);
    },
    writeBuffer(
      buffer: object,
      offset: number,
      data: ArrayBuffer | ArrayBufferView,
      dataOffset = 0,
      size = 0,
    ) {
      events.push('writeBuffer');
      writes.push({ buffer, offset, data, dataOffset, size });
    },
    writeTexture(
      destination: GPUTexelCopyTextureInfo,
      data: Uint8Array,
      layout: GPUTexelCopyBufferLayout,
      size: GPUExtent3D,
    ) {
      events.push('writeTexture');
      textureWrites.push({ destination, data, layout, size });
    },
    submit(commands: object[]) {
      expect(commands).toHaveLength(1);
      events.push('submit');
    },
    onSubmittedWorkDone() {
      const d = deferred<void>();
      completions.push(d);
      events.push('completion');
      return d.promise;
    },
  };
  const device = {
    queue,
    lost: lost.promise,
    limits: { maxBufferSize: 1 << 26, maxTextureDimension2D: 8192 },
    destroyed: 0,
    destroy() {
      this.destroyed += 1;
    },
    addEventListener(_name: string, listener: (event: { error: Error }) => void) {
      errorListener = listener;
    },
    createBuffer(descriptor: GPUBufferDescriptor) {
      const result = {
        size: descriptor.size,
        destroyed: 0,
        destroy() {
          this.destroyed += 1;
        },
      };
      buffers.push(result);
      return result;
    },
    createTexture(descriptor: GPUTextureDescriptor) {
      const result = {
        descriptor,
        destroyed: 0,
        createView() {
          return {};
        },
        destroy() {
          this.destroyed += 1;
        },
      };
      textures.push(result);
      return result;
    },
    createSampler() {
      return {};
    },
    createBindGroupLayout() {
      return {};
    },
    createPipelineLayout() {
      return {};
    },
    createBindGroup() {
      return {};
    },
    createShaderModule(descriptor: GPUShaderModuleDescriptor) {
      shaderCodes.push(descriptor.code);
      return {};
    },
    createRenderPipelineAsync(descriptor: GPURenderPipelineDescriptor) {
      pipelines.push(descriptor);
      const pipeline = {};
      pipelinePrimitives.set(pipeline, descriptor.primitive?.topology ?? 'triangle-list');
      return pipelineGate === null ? Promise.resolve(pipeline) : pipelineGate.then(() => pipeline);
    },
    createCommandEncoder() {
      events.push('encode');
      return {
        beginRenderPass(descriptor: GPURenderPassDescriptor) {
          const attachment = Array.from(descriptor.colorAttachments)[0];
          const pass = {
            descriptor,
            attachment: attachment == null ? undefined : { ...attachment },
            draws: [] as number[],
            pipelines: [] as object[],
          };
          passes.push(pass);
          let primitive: GPUPrimitiveTopology | undefined;
          return {
            setBindGroup() {},
            setPipeline(pipeline: object) {
              pass.pipelines.push(pipeline);
              primitive = pipelinePrimitives.get(pipeline);
            },
            setVertexBuffer() {},
            draw(vertices: number, instances: number) {
              expect(primitive).toBeDefined();
              expect(vertices).toBe(primitive === 'triangle-strip' ? 4 : 6);
              pass.draws.push(instances);
            },
            end() {
              events.push('passEnd');
            },
          };
        },
        finish() {
          events.push('finish');
          return {};
        },
      };
    },
  };
  return {
    device,
    lost,
    completions,
    events,
    writes,
    textures,
    textureWrites,
    externalCopies,
    buffers,
    pipelines,
    passes,
    shaderCodes,
    emitError: (error: Error) => errorListener?.({ error }),
    delayPipelines: (promise: Promise<object>) => {
      pipelineGate = promise;
    },
  };
}

const descriptors = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
  if (!descriptors.has(name))
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
const renderers: WebGpuRenderer[] = [];
afterEach(() => {
  for (const renderer of renderers) renderer.destroy();
  renderers.length = 0;
  for (const [name, descriptor] of descriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  descriptors.clear();
});

function harness(devices = [fakeDevice()]) {
  let nextDevice = 0;
  install('navigator', {
    gpu: {
      async requestAdapter() {
        return {
          requestDevice: async () => {
            const next = devices[nextDevice++];
            if (next === undefined) throw new Error('no replacement device');
            return next.device;
          },
        };
      },
    },
  });
  install('GPUBufferUsage', { COPY_DST: 8, VERTEX: 32, UNIFORM: 64, STORAGE: 128 });
  install('GPUTextureUsage', { COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 });
  install('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2 });
  const configurations: GPUCanvasConfiguration[] = [];
  const context = {
    unconfigured: 0,
    configure(c: GPUCanvasConfiguration) {
      configurations.push(c);
    },
    getCurrentTexture() {
      return {
        createView(descriptor: GPUTextureViewDescriptor = {}) {
          return { format: descriptor.format ?? 'rgba8unorm' };
        },
      };
    },
    unconfigure() {
      this.unconfigured += 1;
    },
  };
  const canvas = Object.assign(new EventTarget(), { width: 1600, height: 960 });
  Object.defineProperty(canvas, 'getContext', {
    value(kind: string) {
      expect(kind).toBe('webgpu');
      return context;
    },
  });
  const completed: number[] = [];
  const errors: Error[] = [];
  const lifecycle: string[] = [];
  const renderer = new WebGpuRenderer(
    () => lifecycle.push('restored'),
    () => lifecycle.push('lost'),
    (id) => completed.push(id),
    (error) => errors.push(error),
  );
  renderers.push(renderer);
  return {
    renderer,
    canvas: canvas as OffscreenCanvas,
    context,
    configurations,
    completed,
    errors,
    lifecycle,
  };
}

const memory = new ArrayBuffer(16384);
const bg = { ptr: 0, count: 2 };
const glyph = { ptr: 1024, count: 2 };
const deco = { ptr: 4096, count: 2 };
const cursor = { ptr: 8192, count: 1 };
const empty = { ptr: 0, count: 0 };
function versions(): GeometryVersions {
  return {
    bg: 1,
    glyph: 1,
    deco: 1,
    cursor: 1,
    bgDirtyOffset: 0,
    bgDirtyCount: 2,
    glyphDirtyOffset: 0,
    glyphDirtyCount: 2,
    decoDirtyOffset: 0,
    decoDirtyCount: 2,
    cursorDirtyOffset: 0,
    cursorDirtyCount: 1,
  };
}
async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}
function draw(renderer: WebGpuRenderer, v = versions(), preview?: TerminalPreviewGeometry) {
  return renderer.render(memory, bg, glyph, deco, cursor, [1600, 960], v, preview);
}
async function ready(h: ReturnType<typeof harness>) {
  await h.renderer.init(h.canvas, 8, 8);
  h.renderer.uploadAtlas(new Uint8Array(64), [0, 0, 8, 8], [8, 8]);
}

describe('WebGPU terminal renderer', () => {
  test('one text pass preserves geometry layouts, linear-light blending and cursor shapes', async () => {
    const fake = fakeDevice();
    const h = harness([fake]);
    await ready(h);
    // Never the preferred format: Firefox's bgra8unorm swap chain presents
    // unsynchronised from a worker (PERF.md, 2026-09-08).
    expect(h.configurations[0]).toMatchObject({
      format: 'rgba8unorm',
      viewFormats: ['rgba8unorm-srgb'],
      colorSpace: 'srgb',
      alphaMode: 'opaque',
    });
    expect(fake.pipelines.map((p) => p.vertex.entryPoint)).toEqual([
      'solid',
      'encoded_solid',
      'glyph',
      'cursor',
    ]);
    expect(fake.pipelines.every((p) => p.primitive?.topology === 'triangle-strip')).toBe(true);
    expect(fake.shaderCodes[0]).toContain('coverage * v.alpha');
    expect(fake.pipelines.map((p) => p.fragment?.targets[0]?.format)).toEqual([
      'rgba8unorm-srgb',
      'rgba8unorm',
      'rgba8unorm-srgb',
      'rgba8unorm-srgb',
    ]);
    expect(fake.shaderCodes[0]).toContain('v.local.x <= 0.14');
    expect(fake.shaderCodes[0]).toContain('v.local.y >= 0.9');
    expect(fake.shaderCodes[0]).toContain('var inside = 0.55');
    expect(draw(h.renderer)).toBe(1);
    // Two: the geometry-free present `init` submits so the canvas holds the
    // terminal background rather than an unpresented opaque surface, then the
    // frame. The first draws nothing and uploads nothing.
    expect(fake.passes).toHaveLength(2);
    expect(fake.passes[0]?.draws).toEqual([]);
    expect(fake.passes[1]?.draws).toEqual([2, 2, 2, 1]);
    expect(fake.events.slice(-5)).toEqual(['encode', 'passEnd', 'finish', 'submit', 'completion']);
    expect(fake.writes.map((w) => w.size)).toEqual([56, 112, 56, 32, 2]);
    expect(fake.writes.slice(0, 4).every((w) => w.data === memory)).toBe(true);
  });

  test('configuring the canvas presents the terminal background before the pipeline compile', async () => {
    const fake = fakeDevice();
    const h = harness([fake]);
    const gate = deferred<object>();
    fake.delayPipelines(gate.promise);
    const initialized = h.renderer.init(h.canvas, 8, 8, [10, 20, 30]);
    await flush();

    // The point of the present is *where* it is. WebKit composites an
    // `alphaMode: 'opaque'` canvas as black from `configure` until its first
    // submitted frame, and `createRenderPipelineAsync` is awaited between the
    // two — so a cold shader cache held the surface at full black for the
    // length of the compile. The background must already be on screen while
    // the pipelines are still pending.
    expect(fake.pipelines).toHaveLength(4);
    expect(fake.events).toEqual(['encode', 'passEnd', 'finish', 'submit']);

    gate.resolve({});
    await initialized;
    expect(fake.passes).toHaveLength(1);
    expect(fake.passes[0]?.draws).toEqual([]);
    const attachments = fake.passes[0]?.descriptor
      .colorAttachments as GPURenderPassColorAttachment[];
    expect(attachments[0]?.loadOp).toBe('clear');
    expect(attachments[0]?.clearValue).toEqual({
      r: srgbToLinear(10 / 255),
      g: srgbToLinear(20 / 255),
      b: srgbToLinear(30 / 255),
      a: 1,
    });
    // No geometry, so no cursor the browser has no authority for; no uploads,
    // so nothing to bound; no completion, so no render identity to retire.
    expect(fake.writes).toHaveLength(0);
    expect(fake.events).toEqual(['encode', 'passEnd', 'finish', 'submit']);
    expect(h.renderer.frameInFlight()).toBe(false);
    expect(h.renderer.canSubmitFrame()).toBe(true);
  });

  test('bounded exact independent owners, out-of-order callbacks, no polling or await-before-submit', async () => {
    const fake = fakeDevice();
    const h = harness([fake]);
    await ready(h);
    for (let id = 1; id <= MAX_IN_FLIGHT_RENDER_FRAMES; id++) expect(draw(h.renderer)).toBe(id);
    expect(h.renderer.canSubmitFrame()).toBe(false);
    expect(() => draw(h.renderer)).toThrow('admission budget');
    fake.completions[1]?.resolve();
    await flush();
    expect(h.completed).toEqual([2]);
    expect(h.renderer.canSubmitFrame()).toBe(true);
    expect(draw(h.renderer)).toBe(MAX_IN_FLIGHT_RENDER_FRAMES + 1);
    fake.completions[0]?.resolve();
    await flush();
    expect(h.completed).toEqual([2, 1]);
    for (let index = 2; index < fake.completions.length; index++)
      fake.completions[index]?.resolve();
    await flush();
    expect(h.completed).toEqual([
      2,
      1,
      ...Array.from({ length: MAX_IN_FLIGHT_RENDER_FRAMES - 1 }, (_, i) => i + 3),
    ]);
    expect(h.renderer.frameInFlight()).toBe(false);
    expect(fake.writes).toHaveLength(5);
    // Index 0 is `init`'s one-off background present, which owns its own
    // descriptor because it runs before the scene resources exist. Every
    // rendered frame after it reuses the single retained descriptor.
    expect(fake.passes[1]?.descriptor).toBe(fake.passes[2]?.descriptor);
  });

  test('upload watermark stops sparse-count bypass and releases only the matching owner', async () => {
    const fake = fakeDevice();
    const h = harness([fake]);
    await ready(h);
    const large = new ArrayBuffer(18 * 1024 * 1024);
    const range = { ptr: 0, count: Math.floor(large.byteLength / 28) };
    h.renderer.render(large, range, empty, empty, empty, [1600, 960]);
    expect(h.renderer.canSubmitFrame()).toBe(false);
    expect(() => draw(h.renderer)).toThrow('admission budget');
    expect(() => h.renderer.uploadAtlas(new Uint8Array(64), [0, 0, 8, 8], [8, 8])).toThrow(
      'admission budget',
    );
    fake.completions[0]?.resolve();
    await flush();
    expect(h.renderer.canSubmitFrame()).toBe(true);
    draw(h.renderer);
  });

  test('replaced atlas allocations have an independent retired-byte bound', async () => {
    const fake = fakeDevice();
    const h = harness([fake]);
    await ready(h);
    const atlas = new Uint8Array(8192 * 4096);
    h.renderer.uploadAtlas(atlas, [0, 0, 8192, 4096], [8192, 4096]);
    draw(h.renderer);
    fake.completions[0]?.resolve();
    await flush();
    h.renderer.uploadAtlas(new Uint8Array(64), [0, 0, 8, 8], [8, 8]);
    draw(h.renderer);
    expect(h.renderer.canSubmitFrame()).toBe(false);
    fake.completions[1]?.resolve();
    await flush();
    expect(h.renderer.canSubmitFrame()).toBe(true);
  });

  test('dirty writes use bytes and original memory offsets; growing storage forces full upload', async () => {
    const fake = fakeDevice();
    const h = harness([fake]);
    await ready(h);
    draw(h.renderer);
    fake.completions[0]?.resolve();
    await flush();
    const v = versions();
    v.glyph = 2;
    v.glyphDirtyOffset = 1;
    v.glyphDirtyCount = 1;
    draw(h.renderer, v);
    expect(fake.writes.at(-1)).toMatchObject({ offset: 56, dataOffset: 1080, size: 56 });
    fake.completions[1]?.resolve();
    await flush();
    const oldBuffer = fake.buffers[2];
    h.renderer.render(memory, bg, { ptr: 1024, count: 16 }, deco, cursor, [1600, 960], v);
    expect(oldBuffer?.destroyed).toBe(1);
    expect(fake.writes.at(-1)).toMatchObject({ offset: 0, dataOffset: 1024, size: 896 });
  });

  test('atlas dirty windows avoid repacking; replacement uploads full contents and retires prior texture', async () => {
    const fake = fakeDevice();
    const h = harness([fake]);
    await ready(h);
    const pixels = new Uint8Array(64);
    h.renderer.uploadAtlas(pixels, [2, 3, 2, 3], [8, 8]);
    expect(fake.textureWrites[1]).toMatchObject({
      destination: { origin: { x: 2, y: 3 } },
      layout: { offset: 26, bytesPerRow: 8 },
      size: { width: 2, height: 3 },
    });
    expect(fake.textureWrites[1]?.data).toBe(pixels);
    h.renderer.uploadAtlas(new Uint8Array(128), [0, 0, 0, 0], [16, 8]);
    expect(fake.textures[0]?.destroyed).toBe(1);
    expect(fake.textureWrites[2]).toMatchObject({
      layout: { offset: 0, bytesPerRow: 16 },
      size: { width: 16, height: 8 },
    });
    expect(() => h.renderer.uploadAtlas(pixels, [7, 0, 2, 1], [8, 8])).toThrow('dirty rectangle');
  });

  test('resize and theme keep resources stable, viewport upload changes only when needed', async () => {
    const fake = fakeDevice();
    const h = harness([fake]);
    await ready(h);
    draw(h.renderer);
    fake.completions[0]?.resolve();
    await flush();
    const bufferCount = fake.buffers.length;
    h.renderer.resize(1200, 800);
    h.renderer.setClearColor([51, 102, 153]);
    h.renderer.render(memory, bg, glyph, deco, cursor, [1200, 800], versions());
    expect(h.canvas.width).toBe(1200);
    expect(h.canvas.height).toBe(800);
    expect(fake.buffers.length).toBe(bufferCount);
    expect(fake.writes.at(-1)?.size).toBe(2);
    expect(Array.from(fake.passes[1]?.descriptor.colorAttachments ?? [])[0]?.clearValue).toEqual({
      r: srgbToLinear(0.2),
      g: srgbToLinear(0.4),
      b: srgbToLinear(0.6),
      a: 1,
    });
  });

  test('same-pass bounded pointer preview has separate buffers and one completion identity', async () => {
    const fake = fakeDevice();
    const h = harness([fake]);
    await ready(h);
    const preview: TerminalPreviewGeometry = {
      version: 1,
      bg: new Float32Array(7),
      bgCount: 1,
      glyph: new Float32Array(140),
      glyphCount: 10,
      cursor: new Float32Array(8),
      cursorCount: 1,
    };
    expect(draw(h.renderer, versions(), preview)).toBe(1);
    expect(fake.passes.at(-1)?.draws).toEqual([2, 2, 2, 1, 1, 10, 1]);
    expect(fake.completions).toHaveLength(1);
    expect(() => draw(h.renderer, versions(), { ...preview, glyphCount: 11 })).toThrow(
      'bounded capacity',
    );
    fake.completions[0]?.resolve();
    await flush();
    const writes = fake.writes.length;
    draw(h.renderer, versions(), {
      ...preview,
      version: 2,
      bgCount: 0,
      glyphCount: 0,
      cursorCount: 0,
    });
    expect(fake.passes.at(-1)?.draws).toEqual([2, 2, 2, 1]);
    expect(fake.writes.length).toBe(writes);
  });

  test('loss invalidates old callbacks and rebuilds same backend; full atlas and geometry required', async () => {
    const first = fakeDevice();
    const second = fakeDevice();
    const h = harness([first, second]);
    await ready(h);
    draw(h.renderer);
    first.lost.resolve({ reason: 'unknown', message: 'test loss' });
    await flush();
    expect(h.lifecycle).toEqual(['lost', 'restored']);
    expect(h.renderer.frameInFlight()).toBe(false);
    first.completions[0]?.resolve();
    await flush();
    expect(h.completed).toEqual([]);
    expect(() => draw(h.renderer)).toThrow('atlas must be uploaded');
    h.renderer.uploadAtlas(new Uint8Array(64), [2, 2, 1, 1], [8, 8]);
    expect(second.textureWrites[0]?.size).toEqual({ width: 8, height: 8 });
    expect(draw(h.renderer)).toBe(2);
    expect(second.writes).toHaveLength(5);
    second.completions[0]?.resolve();
    await flush();
    expect(h.completed).toEqual([2]);
  });

  test('destroy is idempotent and suppresses stale callbacks', async () => {
    const fake = fakeDevice();
    const h = harness([fake]);
    await ready(h);
    draw(h.renderer);
    h.renderer.destroy();
    h.renderer.destroy();
    fake.completions[0]?.resolve();
    await flush();
    expect(h.completed).toEqual([]);
    expect(h.renderer.canSubmitFrame()).toBe(false);
    expect(fake.device.destroyed).toBe(1);
    expect(h.context.unconfigured).toBe(1);
    expect(fake.buffers.every((b) => b.destroyed === 1)).toBe(true);
  });

  test('asynchronous initialization cancellation never resurrects resources', async () => {
    const fake = fakeDevice();
    const gate = deferred<object>();
    fake.delayPipelines(gate.promise);
    const h = harness([fake]);
    const initializing = h.renderer.init(h.canvas, 8, 8);
    await flush();
    h.renderer.destroy();
    gate.resolve({});
    await expect(initializing).rejects.toThrow('cancelled');
    expect(fake.textures).toHaveLength(0);
    expect(fake.device.destroyed).toBe(1);
    expect(h.renderer.canSubmitFrame()).toBe(false);
  });

  test('validation errors fail closed without invented completion', async () => {
    const fake = fakeDevice();
    const h = harness([fake]);
    await ready(h);
    draw(h.renderer);
    fake.emitError(new Error('validation failed'));
    await flush();
    expect(h.errors.map((e) => e.message)).toEqual(['validation failed']);
    expect(h.lifecycle).toEqual(['lost']);
    expect(h.completed).toEqual([]);
    fake.emitError(new Error('duplicate'));
    expect(h.errors).toHaveLength(1);
    expect(() => draw(h.renderer)).toThrow('renderer failed');
  });

  test('queue rejection before device.lost restores once and stale loss cannot retire successor', async () => {
    const first = fakeDevice();
    const second = fakeDevice();
    const h = harness([first, second]);
    await ready(h);
    draw(h.renderer);
    first.completions[0]?.reject(new Error('queue rejected before loss notification'));
    await flush();
    expect(h.lifecycle).toEqual(['lost', 'restored']);
    expect(h.completed).toEqual([]);
    expect(h.errors).toEqual([]);
    first.lost.resolve({ reason: 'unknown', message: 'late notification' });
    await flush();
    expect(h.lifecycle).toEqual(['lost', 'restored']);
    h.renderer.uploadAtlas(new Uint8Array(64), [0, 0, 8, 8], [8, 8]);
    expect(draw(h.renderer)).toBe(2);
    second.completions[0]?.resolve();
    await flush();
    expect(h.completed).toEqual([2]);
  });

  test('a second device failure before a successful recovery completion is fatal', async () => {
    const first = fakeDevice();
    const second = fakeDevice();
    const h = harness([first, second]);
    await ready(h);
    draw(h.renderer);
    first.completions[0]?.reject(new Error('lost'));
    await flush();
    second.lost.resolve({ reason: 'unknown', message: 'replacement lost' });
    await flush();
    expect(h.errors.map((error) => error.message)).toEqual([
      'WebGPU device failed before recovery completed',
    ]);
    expect(h.completed).toEqual([]);
    expect(h.renderer.canSubmitFrame()).toBe(false);
  });

  test('unsupported GPU rejects initialization explicitly; blank scenes need no atlas', async () => {
    const h = harness();
    install('navigator', {});
    await expect(h.renderer.init(h.canvas, 8, 8)).rejects.toThrow('WebGPU is required');
    const second = harness();
    await second.renderer.init(second.canvas, 8, 8);
    expect(second.renderer.render(memory, empty, empty, empty, empty, [1600, 960])).toBe(1);
  });
});

test('image copies share submission completion and retain backing pages across scene resets', async () => {
  const fake = fakeDevice();
  const h = harness([fake]);
  await ready(h);
  const uploaded: string[] = [];
  const tile = {
    key: 'image',
    level: 0,
    asset: 'tile' as const,
    authority: new Uint8Array(32),
    frame: 0,
    source: new Uint8Array(32),
    x: 0,
    y: 0,
    width: 3,
    height: 3,
  };
  const quads = [0, 1, 2].map((layer) => ({
    key: tile.key,
    layer,
    left: 0,
    top: 0,
    right: 16,
    bottom: 16,
    u: 1 / 258,
    v: 1 / 258,
    uw: 1 / 258,
    vh: 1 / 258,
  }));
  h.renderer.setGraphicsScene(
    { tiles: [tile], quads },
    () => {},
    (key) => uploaded.push(key),
  );
  await flush();
  let closed = 0;
  const bitmap = {
    width: 3,
    height: 3,
    close() {
      closed++;
    },
  } as ImageBitmap;
  expect(h.renderer.offerGraphicsTile(tile.key, bitmap)).toBe(true);
  draw(h.renderer);
  expect(closed).toBe(1);
  expect(fake.externalCopies).toHaveLength(1);
  expect(fake.externalCopies[0]?.premultipliedAlpha).toBe(true);
  expect(fake.passes.slice(-4).map((pass) => pass.draws)).toEqual([[1, 2, 1], [2, 2], [1], [1]]);
  expect(fake.passes.slice(-4).map((pass) => pass.attachment?.view as unknown)).toEqual([
    { format: 'rgba8unorm' },
    { format: 'rgba8unorm-srgb' },
    { format: 'rgba8unorm' },
    { format: 'rgba8unorm-srgb' },
  ]);
  expect(fake.passes.slice(-4).map((pass) => pass.attachment?.loadOp)).toEqual([
    'clear',
    'load',
    'load',
    'load',
  ]);
  expect(fake.completions).toHaveLength(1);
  expect(uploaded).toEqual([]);
  h.renderer.clearGraphics();
  draw(h.renderer);
  // Returning to text-only presentation must remove every image pipeline bind,
  // not merely draw zero image instances while retaining per-frame image work.
  expect(fake.passes.at(-1)?.pipelines).toHaveLength(4);
  fake.completions[0]?.resolve();
  await flush();
  expect(uploaded).toEqual(['image']);
  fake.completions[1]?.resolve();
  await flush();
  // The page remains bounded and reusable across authenticated scene resets.
  h.renderer.setGraphicsScene(
    { tiles: [tile], quads },
    () => {},
    () => {},
  );
  expect(h.renderer.offerGraphicsTile(tile.key, bitmap)).toBe(true);
  const priorPasses = fake.passes.length;
  h.renderer.render(memory, bg, glyph, deco, empty, [1600, 960], versions());
  expect(fake.passes.slice(priorPasses).map((pass) => pass.draws)).toEqual([
    [1, 2, 1],
    [2, 2],
    [1],
  ]);
  expect(
    fake.textures.filter(
      (texture) => Array.isArray(texture.descriptor.size) && texture.descriptor.size[2] === 16,
    ),
  ).toHaveLength(1);
});

test('late packed tiles update only one mapping without reuploading scene geometry', async () => {
  const fake = fakeDevice();
  const h = harness([fake]);
  await ready(h);
  const tiles = ['first', 'second'].map((key) => ({
    key,
    asset: 'tile' as const,
    authority: new Uint8Array(32),
    frame: 0,
    source: new Uint8Array(32),
    level: 0,
    x: 0,
    y: 0,
    width: 3,
    height: 3,
  }));
  const quads = tiles.map((tile, i) => ({
    key: tile.key,
    layer: 2,
    left: i * 16,
    top: 0,
    right: i * 16 + 16,
    bottom: 16,
    u: 1 / 258,
    v: 1 / 258,
    uw: 1 / 258,
    vh: 1 / 258,
  }));
  h.renderer.setGraphicsScene(
    { tiles, quads },
    () => {},
    () => {},
  );
  await flush();
  const bitmap = { width: 3, height: 3, close() {} } as ImageBitmap;
  h.renderer.offerGraphicsTile('first', bitmap);
  draw(h.renderer);
  fake.completions[0]?.resolve();
  await flush();
  fake.writes.length = 0;
  h.renderer.offerGraphicsTile('second', bitmap);
  draw(h.renderer);
  expect(fake.writes.map((write) => [write.offset, write.size])).toEqual([[16, 16]]);
  expect(fake.externalCopies[0]?.origin).toEqual([0, 0, 0]);
  expect(fake.externalCopies[1]?.origin).toEqual([0, 3, 0]);
  expect(fake.passes.slice(-3).map((pass) => pass.draws)).toEqual([[2, 2, 2], [2], [1]]);
});

test('whole-scene atlas admission rolls back over-budget reservations before fetching', async () => {
  const fake = fakeDevice();
  const h = harness([fake]);
  await ready(h);
  const demand = (key: string, size: number) => ({
    key,
    asset: 'tile' as const,
    authority: new Uint8Array(32),
    frame: 0,
    source: new Uint8Array(32),
    level: 0,
    x: 0,
    y: 0,
    width: size,
    height: size,
  });
  expect(
    h.renderer.setGraphicsScene(
      {
        tiles: Array.from({ length: 241 }, (_, i) => demand(`large${i}`, 258)),
        quads: [],
      },
      () => {},
      () => {},
    ),
  ).toBe(false);
  const small = Array.from({ length: 4096 }, (_, i) => demand(`small${i}`, 3));
  expect(
    h.renderer.setGraphicsScene(
      { tiles: small, quads: [] },
      () => {},
      () => {},
    ),
  ).toBe(true);
  await flush();
  const bitmap = { width: 3, height: 3, close() {} } as ImageBitmap;
  h.renderer.offerGraphicsTile('small1', bitmap);
  draw(h.renderer);
  fake.completions[0]?.resolve();
  await flush();
  h.renderer.offerGraphicsTile('small0', bitmap);
  draw(h.renderer);
  // Reservation order, rather than network arrival order, determines placement.
  expect(fake.externalCopies.map((copy) => copy.origin)).toEqual([
    [0, 3, 0],
    [0, 0, 0],
  ]);
  expect(
    fake.textures.filter(
      (texture) => Array.isArray(texture.descriptor.size) && texture.descriptor.size[2] === 16,
    ),
  ).toHaveLength(15);
});

test('animation tiles commit atomically, retain complete frames and only rewrite mapping words', async () => {
  const fake = fakeDevice();
  const h = harness([fake]);
  await ready(h);
  const bitmap = { width: 3, height: 3, close() {} } as ImageBitmap;
  const quads = [0, 1].map((x) => ({
    key: `slot${x}`,
    layer: 2,
    left: x * 16,
    top: 0,
    right: x * 16 + 16,
    bottom: 16,
    u: 1 / 258,
    v: 1 / 258,
    uw: 1 / 258,
    vh: 1 / 258,
  }));
  const scene = (frame: number) => ({
    quads,
    tiles: [0, 1].map((x) => ({
      asset: 'tile' as const,
      authority: new Uint8Array(32),
      frame,
      source: new Uint8Array(32),
      key: `${frame}:${x}`,
      level: 0,
      x,
      y: 0,
      width: 3,
      height: 3,
    })),
    animations: [
      {
        key: 'animation',
        reserve: true,
        bindings: new Map([
          ['slot0', `${frame}:0`],
          ['slot1', `${frame}:1`],
        ]),
      },
    ],
  });
  const install = (frame: number) =>
    h.renderer.setGraphicsScene(
      scene(frame),
      () => {},
      () => {},
    );
  const flushFrame = async () => {
    draw(h.renderer);
    fake.completions.at(-1)?.resolve();
    await flush();
  };
  expect(install(0)).toBe(true);
  await flush();
  h.renderer.offerGraphicsTile('0:0', bitmap);
  await flushFrame();
  expect(fake.passes.at(-1)?.draws).toEqual([2, 2, 2, 1]);
  fake.writes.length = 0;
  h.renderer.offerGraphicsTile('0:1', bitmap);
  await flushFrame();
  expect(fake.writes.map((write) => write.size)).toEqual([16, 16]);
  expect(fake.passes.at(-2)?.draws.at(-1)).toBe(2);
  fake.writes.length = 0;
  expect(install(1)).toBe(true);
  h.renderer.offerGraphicsTile('1:0', bitmap);
  await flushFrame();
  expect(fake.writes).toHaveLength(0);
  expect(fake.passes.at(-2)?.draws.at(-1)).toBe(2);
  expect(h.renderer.hasGraphicsTile('0:0')).toBe(true);
  h.renderer.offerGraphicsTile('1:1', bitmap);
  await flushFrame();
  expect(fake.writes.map((write) => write.size)).toEqual([16, 16]);
  fake.writes.length = 0;
  const copies = fake.externalCopies.length;
  expect(install(0)).toBe(true);
  await flushFrame();
  expect(fake.externalCopies.length).toBe(copies);
  expect(fake.writes.map((write) => write.size)).toEqual([16, 16]);
  h.renderer.clearGraphics();
  expect(h.renderer.hasGraphicsTile('0:0')).toBe(false);
});

test('running animation admission proves a full successor fits before publishing geometry', async () => {
  const fake = fakeDevice();
  const h = harness([fake]);
  await ready(h);
  const quads = Array.from({ length: 120 }, (_, x) => ({
    key: `slot:${x}`,
    layer: 2,
    left: x * 256,
    top: 0,
    right: x * 256 + 256,
    bottom: 256,
    u: 1 / 258,
    v: 1 / 258,
    uw: 256 / 258,
    vh: 256 / 258,
  }));
  const scene = (count: number, frame: number, reserve: boolean) => ({
    quads,
    tiles: Array.from({ length: count }, (_, x) => ({
      asset: 'tile' as const,
      authority: new Uint8Array(32),
      source: new Uint8Array(32),
      key: `${frame}:${x}`,
      frame,
      level: 0,
      x,
      y: 0,
      width: 258,
      height: 258,
    })),
    animations: [
      {
        key: 'moving',
        reserve,
        bindings: new Map(Array.from({ length: count }, (_, x) => [`slot:${x}`, `${frame}:${x}`])),
      },
    ],
  });
  const install = (next: ReturnType<typeof scene>) =>
    h.renderer.setGraphicsScene(
      next,
      () => {},
      () => {},
    );
  // 15 pages * 16 layers = 240 full tiles: 121 + 121 cannot be admitted.
  expect(install(scene(121, 0, true))).toBe(false);
  expect(install(scene(120, 0, true))).toBe(true);
  await flush();
  const bitmap = { width: 258, height: 258, close() {} } as ImageBitmap;
  for (let x = 0; x < 120; x++) {
    h.renderer.offerGraphicsTile(`0:${x}`, bitmap);
    draw(h.renderer);
    fake.completions.at(-1)?.resolve();
    await flush();
  }
  expect(install(scene(120, 1, true))).toBe(true);
  expect(h.renderer.hasGraphicsTile('0:0')).toBe(true);
  expect(h.renderer.hasGraphicsTile('0:119')).toBe(true);
  h.renderer.clearGraphics();
  // Stopped timelines need no speculative second frame.
  expect(install(scene(121, 0, false))).toBe(true);
});
