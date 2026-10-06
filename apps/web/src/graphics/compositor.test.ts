import { afterEach, expect, test } from 'bun:test';
import { GraphicsCompositor } from './compositor';
import type { ImageScene, TileDemand } from './scene';

// The compositor's geometry and blending are exercised through a recording
// device: it keeps buffer bytes, page texels, copies and the pipeline it was
// given. `render` then evaluates exactly what the WGSL and fixed-function
// stages would: select the edges, interpolate texture coordinates, sample with
// a clamp-to-edge linear filter, and blend with the recorded factors.

/** Straight-alpha RGBA in [0, 1]: the terminal worker decodes tiles with
 * `premultiplyAlpha: 'none'`, so this is what reaches `offer`. */
interface FakeBitmap {
  readonly width: number;
  readonly height: number;
  readonly rgba: Float64Array;
  closed: number;
  close(): void;
}

interface FakePage {
  readonly width: number;
  readonly height: number;
  /** RGBA per texel, per layer, as the copy stored it. */
  readonly texels: Float64Array;
}

interface FakeBinding {
  readonly page: FakePage;
  readonly mappings: object;
}

interface FakeDraw {
  readonly binding: FakeBinding;
  readonly vertices: object;
  readonly first: number;
  readonly count: number;
}

const descriptors = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown): void {
  if (!descriptors.has(name))
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
afterEach(() => {
  for (const [name, descriptor] of descriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  descriptors.clear();
});

function fakeGpu() {
  const memory = new Map<object, Uint8Array>();
  const copies: GPUCopyExternalImageDestInfo[] = [];
  const pipelines: GPURenderPipelineDescriptor[] = [];
  const samplers: (GPUSamplerDescriptor | undefined)[] = [];
  const shaders: string[] = [];
  const bytes = (buffer: object): Uint8Array => {
    const stored = memory.get(buffer);
    if (stored === undefined) throw new Error('unknown buffer');
    return stored;
  };
  const device = {
    createBuffer(descriptor: GPUBufferDescriptor) {
      const buffer = { destroy() {} };
      memory.set(buffer, new Uint8Array(descriptor.size));
      return buffer;
    },
    createSampler(descriptor?: GPUSamplerDescriptor) {
      samplers.push(descriptor);
      return {};
    },
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createShaderModule(descriptor: GPUShaderModuleDescriptor) {
      shaders.push(descriptor.code);
      return {};
    },
    createRenderPipelineAsync(descriptor: GPURenderPipelineDescriptor) {
      pipelines.push(descriptor);
      return Promise.resolve({});
    },
    createTexture(descriptor: GPUTextureDescriptor) {
      const [width = 0, height = 0, layers = 1] = descriptor.size as number[];
      const page = {
        width,
        height,
        texels: new Float64Array(width * height * layers * 4),
        createView: () => page,
        destroy() {},
      };
      return page;
    },
    createBindGroup(descriptor: GPUBindGroupDescriptor): FakeBinding {
      // Binding 2 is the page's array view, binding 3 the mapping buffer.
      const [, , view, mappings] = Array.from(descriptor.entries);
      if (view === undefined || mappings === undefined) throw new Error('incomplete bind group');
      return {
        page: view.resource as unknown as FakePage,
        mappings: (mappings.resource as GPUBufferBinding).buffer,
      };
    },
    queue: {
      writeBuffer(
        buffer: object,
        offset: number,
        data: ArrayBuffer,
        dataOffset = 0,
        size = data.byteLength - dataOffset,
      ) {
        bytes(buffer).set(new Uint8Array(data, dataOffset, size), offset);
      },
      copyExternalImageToTexture(
        source: GPUCopyExternalImageSourceInfo,
        destination: GPUCopyExternalImageDestInfo,
        size: number[],
      ) {
        copies.push(destination);
        const bitmap = source.source as unknown as FakeBitmap;
        const page = destination.texture as unknown as FakePage;
        const [x = 0, y = 0, layer = 0] = destination.origin as number[];
        const [width = 0, height = 0] = size;
        for (let row = 0; row < height; row++)
          for (let column = 0; column < width; column++) {
            const from = (row * bitmap.width + column) * 4;
            const to = ((layer * page.height + y + row) * page.width + x + column) * 4;
            const alpha = bitmap.rgba[from + 3] ?? 0;
            const scale = destination.premultipliedAlpha === true ? alpha : 1;
            for (let channel = 0; channel < 3; channel++)
              page.texels[to + channel] = (bitmap.rgba[from + channel] ?? 0) * scale;
            page.texels[to + 3] = alpha;
          }
      },
    },
  };
  return { device, copies, pipelines, samplers, shaders, bytes };
}
type FakeGpu = ReturnType<typeof fakeGpu>;

async function harness() {
  install('GPUBufferUsage', { COPY_DST: 8, VERTEX: 32, UNIFORM: 64, STORAGE: 128 });
  install('GPUTextureUsage', { COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 });
  install('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2 });
  const gpu = fakeGpu();
  let wakes = 0;
  const compositor = new GraphicsCompositor(
    gpu.device as unknown as GPUDevice,
    {} as GPUBuffer,
    () => {
      wakes++;
    },
    (error) => {
      throw error;
    },
  );
  // The pipeline resolves on a microtask and wakes the owner once.
  await Promise.resolve();
  await Promise.resolve();
  return { gpu, compositor, wakes: () => wakes };
}

interface Placement {
  readonly row: number;
  readonly width: number;
  readonly height: number;
  /** Destination in cells; `top` and `bottom` relative to `row`. */
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  /** Source crop in source pixels. */
  readonly sourceLeft: number;
  readonly sourceRight: number;
  readonly sourceTop: number;
  readonly sourceBottom: number;
}

/** Explicit renderer fixtures. Projection and LOD selection are verified in Rust;
 * these describe GPU geometry without a second browser protocol parser. */
function sceneFixture(
  rows: readonly Placement[],
  cellWidth: number,
  cellHeight: number,
  level = 0,
): ImageScene {
  const tiles = new Map<string, TileDemand>();
  const quads: ImageScene['quads'][number][] = [];
  const fixed = (value: number) => Math.round(value * 2 ** 32) / 2 ** 32;
  const scale = 2 ** level;
  for (const row of rows) {
    const width = Math.ceil(row.width / scale),
      height = Math.ceil(row.height / scale);
    const sl = fixed(row.sourceLeft) / scale,
      sr = fixed(row.sourceRight) / scale;
    const st = fixed(row.sourceTop) / scale,
      sb = fixed(row.sourceBottom) / scale;
    const left = fixed(row.left) * cellWidth,
      right = fixed(row.right) * cellWidth;
    const top = (row.row + fixed(row.top)) * cellHeight;
    const bottom = (row.row + fixed(row.bottom)) * cellHeight;
    for (let y = Math.floor(st / 256); y <= Math.floor((Math.ceil(sb) - 1) / 256); y++)
      for (let x = Math.floor(sl / 256); x <= Math.floor((Math.ceil(sr) - 1) / 256); x++) {
        const key = `fixture:${level}:${x}:${y}`;
        if (!tiles.has(key))
          tiles.set(key, {
            key,
            asset: 'tile',
            authority: new Uint8Array(32).fill(7),
            frame: 0,
            source: new Uint8Array(32).fill(7),
            level,
            x,
            y,
            width: Math.min(256, width - x * 256) + 2,
            height: Math.min(256, height - y * 256) + 2,
          });
        const a = Math.max(sl, x * 256),
          b = Math.min(sr, (x + 1) * 256);
        const c = Math.max(st, y * 256),
          d = Math.min(sb, (y + 1) * 256);
        quads.push({
          key,
          layer: 2,
          left: a === sl ? left : left + ((right - left) * (a - sl)) / (sr - sl),
          right: b === sr ? right : left + ((right - left) * (b - sl)) / (sr - sl),
          top: c === st ? top : top + ((bottom - top) * (c - st)) / (sb - st),
          bottom: d === sb ? bottom : top + ((bottom - top) * (d - st)) / (sb - st),
          u: (a - x * 256 + 1) / 258,
          v: (c - y * 256 + 1) / 258,
          uw: (b - a) / 258,
          vh: (d - c) / 258,
        });
      }
  }
  return { tiles: [...tiles.values()], quads };
}

/** Deterministic opaque pixels, so a seam test isolates sampling from alpha. */
function sourceImage(width: number, height: number, seed: number): Float64Array {
  let state = seed;
  const rgba = new Float64Array(width * height * 4);
  for (let index = 0; index < rgba.length; index++) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    rgba[index] = index % 4 === 3 ? 1 : (state >>> 8) / 0x100_0000;
  }
  return rgba;
}

function bitmap(width: number, height: number, rgba = new Float64Array(width * height * 4)) {
  const result: FakeBitmap = {
    width,
    height,
    rgba,
    closed: 0,
    close() {
      result.closed++;
    },
  };
  return result;
}

/** A level-zero tile as the image worker's pyramid encodes it: the interior
 * and a one-texel gutter on every side that holds the neighbouring source
 * texel, clamped only at the image edge. `empty` gutters are the control. */
function tile(
  source: Float64Array,
  width: number,
  height: number,
  demand: TileDemand,
  gutters: 'neighbour' | 'empty',
): FakeBitmap {
  const result = bitmap(demand.width, demand.height);
  for (let row = 0; row < demand.height; row++)
    for (let column = 0; column < demand.width; column++) {
      const gutter =
        row === 0 || column === 0 || row === demand.height - 1 || column === demand.width - 1;
      if (gutter && gutters === 'empty') continue;
      const x = Math.min(width - 1, Math.max(0, demand.x * 256 + column - 1));
      const y = Math.min(height - 1, Math.max(0, demand.y * 256 + row - 1));
      result.rgba.set(
        source.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
        (row * demand.width + column) * 4,
      );
    }
  return result;
}

/** Offer every demanded tile and let each prepare upload one, as successive
 * frames do. */
function upload(
  compositor: GraphicsCompositor,
  scene: ImageScene,
  make: (demand: TileDemand) => FakeBitmap,
): void {
  for (const demand of scene.tiles)
    expect(compositor.offer(demand.key, make(demand) as unknown as ImageBitmap)).toBe(true);
  for (const demand of scene.tiles) {
    compositor.prepare();
    expect(compositor.hasTile(demand.key)).toBe(true);
  }
}

function record(compositor: GraphicsCompositor): FakeDraw[] {
  const draws: FakeDraw[] = [];
  let binding: FakeBinding | null = null;
  let vertices: object | null = null;
  const pass = {
    setPipeline() {},
    setVertexBuffer(_slot: number, buffer: object) {
      vertices = buffer;
    },
    setBindGroup(_index: number, group: FakeBinding) {
      binding = group;
    },
    draw(vertexCount: number, instanceCount: number, _firstVertex: number, firstInstance: number) {
      expect(vertexCount).toBe(6);
      if (binding === null || vertices === null) throw new Error('draw before bind');
      draws.push({ binding, vertices, first: firstInstance, count: instanceCount });
    },
  };
  for (let layer = 0; layer < 3; layer++)
    compositor.draw(pass as unknown as GPURenderPassEncoder, layer);
  return draws;
}

interface Instance {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly u: number;
  readonly v: number;
  readonly uw: number;
  readonly vh: number;
  readonly page: FakePage;
  readonly layer: number;
}

/** Decode drawn instances exactly as the vertex stage reads them. */
function instances(gpu: FakeGpu, draws: readonly FakeDraw[]): Instance[] {
  // The model below mirrors this vertex expression; it must not drift.
  expect(gpu.shaders[0]).toContain('let p = select(rect.xy, rect.zw, c > vec2f(0.5));');
  expect(gpu.shaders[0]).toContain('out.uv = uv.xy + c * uv.zw + mapping.offset;');
  const result: Instance[] = [];
  for (const draw of draws) {
    const vertices = new Float32Array(gpu.bytes(draw.vertices).buffer);
    const mappings = gpu.bytes(draw.binding.mappings).buffer;
    const offsets = new Float32Array(mappings);
    const layers = new Uint32Array(mappings);
    for (let instance = draw.first; instance < draw.first + draw.count; instance++) {
      const word = (index: number) => vertices[instance * 9 + index] ?? Number.NaN;
      const mapping = word(8) * 4;
      result.push({
        left: word(0),
        top: word(1),
        right: word(2),
        bottom: word(3),
        u: word(4) + (offsets[mapping] ?? Number.NaN),
        v: word(5) + (offsets[mapping + 1] ?? Number.NaN),
        uw: word(6),
        vh: word(7),
        page: draw.binding.page,
        layer: layers[mapping + 2] ?? 0,
      });
    }
  }
  return result;
}

/** Clamp-to-edge bilinear filtering of RGBA at texel-space `x`, `y`. */
function bilinear(
  texel: (x: number, y: number, channel: number) => number,
  width: number,
  height: number,
  x: number,
  y: number,
): number[] {
  const clampX = (value: number) => Math.min(width - 1, Math.max(0, value));
  const clampY = (value: number) => Math.min(height - 1, Math.max(0, value));
  const x0 = Math.floor(x - 0.5);
  const y0 = Math.floor(y - 0.5);
  const fx = x - 0.5 - x0;
  const fy = y - 0.5 - y0;
  return [0, 1, 2, 3].map(
    (channel) =>
      (texel(clampX(x0), clampY(y0), channel) * (1 - fx) +
        texel(clampX(x0 + 1), clampY(y0), channel) * fx) *
        (1 - fy) +
      (texel(clampX(x0), clampY(y0 + 1), channel) * (1 - fx) +
        texel(clampX(x0 + 1), clampY(y0 + 1), channel) * fx) *
        fy,
  );
}

function factor(name: GPUBlendFactor | undefined, sourceAlpha: number): number {
  switch (name) {
    case 'one':
      return 1;
    case 'zero':
      return 0;
    case 'src-alpha':
      return sourceAlpha;
    case 'one-minus-src-alpha':
      return 1 - sourceAlpha;
    default:
      throw new Error(`unmodelled blend factor ${name}`);
  }
}

/** Rasterize and blend every instance over a premultiplied `background`,
 * counting how many quads cover each pixel centre. */
function render(
  gpu: FakeGpu,
  drawn: readonly Instance[],
  width: number,
  height: number,
  background: readonly number[],
) {
  const blend = gpu.pipelines[0]?.fragment?.targets[0]?.blend;
  if (blend === undefined) throw new Error('the image pipeline has no blend state');
  expect([blend.color.operation, blend.alpha.operation]).toEqual(['add', 'add']);
  const color = new Float64Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) color.set(background, pixel * 4);
  const coverage = new Uint8Array(width * height);
  for (const quad of drawn) {
    for (let y = Math.max(0, Math.floor(quad.top)); y < Math.min(height, quad.bottom); y++)
      for (let x = Math.max(0, Math.floor(quad.left)); x < Math.min(width, quad.right); x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        if (cx < quad.left || cx >= quad.right || cy < quad.top || cy >= quad.bottom) continue;
        const u = quad.u + ((cx - quad.left) / (quad.right - quad.left)) * quad.uw;
        const v = quad.v + ((cy - quad.top) / (quad.bottom - quad.top)) * quad.vh;
        const page = quad.page;
        const layer = quad.layer * page.width * page.height;
        const source = bilinear(
          (tx, ty, channel) => page.texels[(layer + ty * page.width + tx) * 4 + channel] ?? 0,
          page.width,
          page.height,
          u * page.width,
          v * page.height,
        );
        const alpha = source[3] ?? 0;
        const at = (y * width + x) * 4;
        for (let channel = 0; channel < 4; channel++) {
          const factors = channel === 3 ? blend.alpha : blend.color;
          color[at + channel] =
            (source[channel] ?? 0) * factor(factors.srcFactor, alpha) +
            (color[at + channel] ?? 0) * factor(factors.dstFactor, alpha);
        }
        coverage[y * width + x] = (coverage[y * width + x] ?? 0) + 1;
      }
  }
  return { color, coverage };
}

/** Straight-alpha source pixels premultiplied and filtered in source space,
 * then composited over `background` with Porter-Duff source-over. */
function reference(
  source: Float64Array,
  width: number,
  height: number,
  x: number,
  y: number,
  background: readonly number[],
): number[] {
  const sample = bilinear(
    (tx, ty, channel) => {
      const at = (ty * width + tx) * 4;
      const alpha = source[at + 3] ?? 0;
      return channel === 3 ? alpha : (source[at + channel] ?? 0) * alpha;
    },
    width,
    height,
    x,
    y,
  );
  const alpha = sample[3] ?? 0;
  return sample.map((value, channel) => value + (background[channel] ?? 0) * (1 - alpha));
}

test('a crop across a tile corner samples the source continuously through gutters', async () => {
  const width = 300;
  const height = 280;
  const source = sourceImage(width, height, 7);
  // 12.5 by 8 source pixels magnified onto five 7.5 by 15.25 pixel cells,
  // crossing the tile boundaries at x = 256 and y = 256.
  const placements: Placement[] = [
    {
      row: 0,
      width,
      height,
      left: 0,
      right: 5,
      top: 0,
      bottom: 1,
      sourceLeft: 250.25,
      sourceRight: 262.75,
      sourceTop: 250.5,
      sourceBottom: 258.5,
    },
  ];
  const background = [0, 0, 0, 0];
  const error = async (gutters: 'neighbour' | 'empty') => {
    const { gpu, compositor } = await harness();
    const scene = sceneFixture(placements, 7.5, 15.25);
    expect(compositor.setScene(scene)).toBe(true);
    expect(scene.tiles.map((demand) => [demand.level, demand.x, demand.y]).sort()).toEqual([
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
      [0, 1, 1],
    ]);
    upload(compositor, scene, (demand) => tile(source, width, height, demand, gutters));
    const frame = render(gpu, instances(gpu, record(compositor)), 38, 16, background);
    let worst = 0;
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 38; x++) {
        const inside = x + 0.5 < 37.5 && y + 0.5 < 15.25;
        expect(frame.coverage[y * 38 + x]).toBe(inside ? 1 : 0);
        if (!inside) continue;
        const expected = reference(
          source,
          width,
          height,
          250.25 + ((x + 0.5) / 37.5) * 12.5,
          250.5 + ((y + 0.5) / 15.25) * 8,
          background,
        );
        for (let channel = 0; channel < 4; channel++)
          worst = Math.max(
            worst,
            Math.abs((frame.color[(y * 38 + x) * 4 + channel] ?? 0) - (expected[channel] ?? 0)),
          );
      }
    return worst;
  };
  // Every pixel is the source's own bilinear sample: no seam at either edge.
  expect(await error('neighbour')).toBeLessThan(1e-4);
  // Control: without the neighbour texels the same geometry shows both seams.
  expect(await error('empty')).toBeGreaterThan(0.05);
});

test('16.16 fractional cell metrics tile a placement exactly: neighbours share f32 edges', async () => {
  for (const [css, ratio] of [
    [7.3, 1],
    [8.4, 1.25],
    [9.6, 2.625],
    [15.61, 1.5],
    [17.345, 3],
  ] as const) {
    const { gpu, compositor } = await harness();
    // A browser sends 16.16 logical metrics; the renderer draws device pixels.
    const cellWidth = Math.fround((Math.round(css * 65536) / 65536) * ratio);
    const cellHeight = Math.fround((Math.round(css * 2 * 65536) / 65536) * ratio);
    // Forty rows starting 0.3 into the first and ending 0.6 into the last,
    // cropping across three tile columns and four tile rows.
    const [top, bottom] = [0.3, 39.6];
    const [sourceTop, sourceBottom] = [20.75, 980.5];
    const rows: Placement[] = [];
    for (let row = 0; row < 40; row++) {
      const from = Math.max(row, top);
      const to = Math.min(row + 1, bottom);
      const at = (edge: number) =>
        sourceTop + ((edge - top) / (bottom - top)) * (sourceBottom - sourceTop);
      rows.push({
        row,
        width: 700,
        height: 1000,
        left: 0,
        right: 70,
        top: from - row,
        bottom: to - row,
        sourceLeft: 10.5,
        sourceRight: 650.25,
        sourceTop: at(from),
        sourceBottom: at(to),
      });
    }
    const scene = sceneFixture(rows, cellWidth, cellHeight);
    expect(compositor.setScene(scene)).toBe(true);
    // Only resident tiles draw; their pixels are irrelevant to coverage.
    upload(compositor, scene, (demand) => bitmap(demand.width, demand.height));
    // Shared boundaries are one value in the scene and one f32 as drawn.
    const outer = exactGrid(scene.quads);
    const drawn = exactGrid(instances(gpu, record(compositor)));
    // The outer edges are the fragment's own, rounded once.
    expect(drawn).toEqual(outer.map(Math.fround));
  }
});

/** Require `quads` to tile a grid exactly, three tile columns by forty rows
 * cut again by three tile rows, with every quad one cell of it and every cell
 * one quad. A seam computed apart on its two sides adds an edge value.
 * Returns the outer edges. */
function exactGrid(
  quads: readonly { left: number; top: number; right: number; bottom: number }[],
): number[] {
  const xs = [...new Set(quads.flatMap((quad) => [quad.left, quad.right]))].sort((a, b) => a - b);
  const ys = [...new Set(quads.flatMap((quad) => [quad.top, quad.bottom]))].sort((a, b) => a - b);
  expect([xs.length, ys.length]).toEqual([4, 44]);
  expect(quads).toHaveLength((xs.length - 1) * (ys.length - 1));
  const cells = new Set<string>();
  for (const quad of quads) {
    const column = xs.indexOf(quad.left);
    const line = ys.indexOf(quad.top);
    expect([xs[column + 1], ys[line + 1]]).toEqual([quad.right, quad.bottom]);
    cells.add(`${column}:${line}`);
  }
  expect(cells.size).toBe(quads.length);
  return [xs[0], xs.at(-1), ys[0], ys.at(-1)].map((edge) => edge ?? Number.NaN);
}

test('straight-alpha tiles premultiply on upload and composite without hidden colour', async () => {
  const { gpu, compositor } = await harness();
  // Opaque red, transparent texel hiding pure green, half-transparent blue,
  // opaque white: a straight-alpha filter would bleed the green into red.
  const pixels = [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0.5, 1, 1, 1, 1];
  const source = Float64Array.from(pixels);
  const scene = sceneFixture(
    [
      {
        row: 0,
        width: 4,
        height: 1,
        left: 0,
        right: 4,
        top: 0,
        bottom: 1,
        sourceLeft: 0,
        sourceRight: 4,
        sourceTop: 0,
        sourceBottom: 1,
      },
    ],
    8,
    8,
  );
  expect(compositor.setScene(scene)).toBe(true);
  upload(compositor, scene, (demand) => tile(source, 4, 1, demand, 'neighbour'));
  expect(gpu.copies.map((copy) => [copy.premultipliedAlpha, copy.colorSpace])).toEqual([
    [true, 'srgb'],
  ]);
  const blend = gpu.pipelines[0]?.fragment?.targets[0]?.blend;
  const over: GPUBlendComponent = {
    srcFactor: 'one',
    dstFactor: 'one-minus-src-alpha',
    operation: 'add',
  };
  expect(blend).toEqual({ color: over, alpha: over });
  expect(gpu.samplers[0]).toMatchObject({ minFilter: 'linear', magFilter: 'linear' });

  const gray = [0.5, 0.5, 0.5, 1];
  const frame = render(gpu, instances(gpu, record(compositor)), 32, 8, gray);
  let worst = 0;
  let bleed = 0;
  for (let x = 0; x < 32; x++) {
    const expected = reference(source, 4, 1, ((x + 0.5) / 32) * 4, 0.5, gray);
    // What filtering the straight values first would have shown.
    const straight = bilinear(
      (tx, _ty, channel) => pixels[tx * 4 + channel] ?? 0,
      4,
      1,
      ((x + 0.5) / 32) * 4,
      0.5,
    );
    const straightAlpha = straight[3] ?? 0;
    bleed = Math.max(
      bleed,
      Math.abs((straight[1] ?? 0) * straightAlpha + 0.5 * (1 - straightAlpha) - (expected[1] ?? 0)),
    );
    for (let channel = 0; channel < 4; channel++)
      worst = Math.max(
        worst,
        Math.abs((frame.color[(4 * 32 + x) * 4 + channel] ?? 0) - (expected[channel] ?? 0)),
      );
  }
  expect(worst).toBeLessThan(1e-6);
  // Control: the fixture is one a straight-alpha pipeline visibly gets wrong.
  expect(bleed).toBeGreaterThan(0.05);
});

test('failed atlas admission rolls back before a smaller whole scene is admitted', async () => {
  const { compositor } = await harness();
  const placements: Placement[] = [
    {
      row: 0,
      width: 8192,
      height: 2048,
      left: 0,
      right: 1024,
      top: 0,
      bottom: 1,
      sourceLeft: 0,
      sourceRight: 8192,
      sourceTop: 0,
      sourceBottom: 2048,
    },
  ];
  expect(compositor.setScene(sceneFixture(placements, 8, 16, 0))).toBe(false);
  const scene = sceneFixture(placements, 8, 16, 1);
  expect(compositor.setScene(scene)).toBe(true);
  expect(scene.tiles).toHaveLength(64);
  expect(scene.tiles.every((demand) => demand.level === 1)).toBe(true);
  expect(Math.min(...scene.quads.map((quad) => quad.left))).toBe(0);
  expect(Math.max(...scene.quads.map((quad) => quad.right))).toBe(8192);
});

test('a replaced compositor closes late tiles and its completion wakes nothing', async () => {
  const { compositor, wakes } = await harness();
  const demand = (key: string): TileDemand => ({
    key,
    asset: 'tile',
    authority: new Uint8Array(32),
    frame: 0,
    source: new Uint8Array(32),
    level: 0,
    x: 0,
    y: 0,
    width: 3,
    height: 3,
  });
  expect(compositor.setScene({ tiles: [demand('first'), demand('second')], quads: [] })).toBe(true);
  const first = bitmap(3, 3);
  const second = bitmap(3, 3);
  expect(compositor.offer('first', first as unknown as ImageBitmap)).toBe(true);
  expect(compositor.offer('second', second as unknown as ImageBitmap)).toBe(true);
  expect(compositor.prepare().uploaded).toBe('first');
  expect(first.closed).toBe(1);
  // While alive, the submission's completion wakes the owner for the queue.
  const alive = compositor.submitted();
  const before = wakes();
  alive?.();
  expect(wakes()).toBe(before + 1);
  expect(compositor.prepare().uploaded).toBe('second');
  const completion = compositor.submitted();
  compositor.destroy();
  const late = bitmap(3, 3);
  expect(compositor.offer('first', late as unknown as ImageBitmap)).toBe(false);
  expect(late.closed).toBe(1);
  completion?.();
  expect(wakes()).toBe(before + 1);
});
