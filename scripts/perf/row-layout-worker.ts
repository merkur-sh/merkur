// Frozen encoded-color baseline for the archived renderer experiment.
// Production text uses hardware sRGB blending.
const GLYPH_GAMMA_DARK_FOREGROUND = 1.45;
const GLYPH_GAMMA_LIGHT_FOREGROUND = 0.69;

import { rowLayoutFootprint } from './row-layout-plan';

export interface RowLayoutRequest {
  readonly canvas: OffscreenCanvas;
  readonly cols: number;
  readonly rows: number;
  readonly arm: 'flat' | 'slabs';
  readonly workload: 'top-cardinality' | 'scattered' | 'redraw' | 'skewed-cardinality';
  readonly samples: number;
}

/** Storage-policy experiment only. Both arms use the exact same shader and
 * callback observer. No compositor, network, font initialization, or input claim.
 */
async function measure(request: RowLayoutRequest) {
  const { canvas, cols, rows, arm, workload, samples } = request;
  rowLayoutFootprint(cols, rows, cols * rows);
  const gpu = navigator.gpu;
  if (gpu === undefined) throw new Error('WebGPU unavailable');
  const adapter = await gpu.requestAdapter();
  if (adapter === null) throw new Error('WebGPU adapter unavailable');
  const identity = {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
  };
  if (/software|swiftshader|llvmpipe/iu.test(Object.values(identity).join(' ')))
    throw new Error('hardware GPU required');
  const device = await adapter.requestDevice();
  let failure: Error | null = null;
  let stopped = false;
  void device.lost.then(() => {
    if (!stopped) failure = new Error('device lost');
  });
  device.addEventListener('uncapturederror', (event: GPUUncapturedErrorEvent) => {
    failure = new Error(event.error.message);
  });
  const contextValue = canvas.getContext('webgpu');
  if (contextValue === null || !('configure' in contextValue))
    throw new Error('WebGPU canvas unavailable');
  const context = contextValue as GPUCanvasContext;
  const format = gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque', colorSpace: 'srgb' });
  // WASM emits at most one atlas glyph per terminal cell (combining sequences
  // are rasterized together). Exact column stride avoids rounded vacant slots.
  const stride = cols;
  const allocatedGlyphs = arm === 'slabs' ? rows * stride : rows * cols;
  const geometry = device.createBuffer({ size: allocatedGlyphs * 56, usage: 0x20 | 0x08 });
  const uniform = device.createBuffer({ size: 16, usage: 0x40 | 0x08 });
  const rowCounts = device.createBuffer({ size: rows * 4, usage: 0x80 | 0x08 });
  const texture = device.createTexture({ size: [8, 8], format: 'r8unorm', usage: 0x04 | 0x02 });
  const atlas = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) atlas[i] = i % 8 === 1 || Math.floor(i / 8) === 1 ? 255 : 0;
  device.queue.writeTexture({ texture }, atlas, { bytesPerRow: 8 }, { width: 8, height: 8 });
  const params = new ArrayBuffer(16);
  new Float32Array(params).set([cols * 8, rows * 16]);
  new Uint32Array(params).set([stride, arm === 'slabs' ? 1 : 0], 2);
  device.queue.writeBuffer(uniform, 0, params);
  const module = device.createShaderModule({
    code: `
struct Params { viewport: vec2f, stride: u32, slabs: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> counts: array<u32>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var atlas: texture_2d<f32>;
struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) fg: vec3f, @location(2) alpha: f32 };
@vertex fn vertex(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32,
 @location(0) cell: vec2f, @location(1) offset: vec2f, @location(2) size: vec2f,
 @location(3) uv: vec4f, @location(4) fg: vec3f, @location(5) alpha: f32) -> Out {
 let corners = array<vec2f, 6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
 if (params.slabs == 1u && ii % params.stride >= counts[ii / params.stride]) {
   return Out(vec4f(2,2,0,1), vec2f(0), vec3f(0), 0);
 }
 let c = corners[vi]; let p = cell + offset + c * size;
 return Out(vec4f(p.x / params.viewport.x * 2 - 1, 1 - p.y / params.viewport.y * 2, 0, 1), mix(uv.xy,uv.zw,c), fg, alpha);
}
@fragment fn fragment(v: Out) -> @location(0) vec4f {
 let cov = textureSample(atlas,smp,v.uv).r;
 let gamma = mix(${GLYPH_GAMMA_DARK_FOREGROUND},${GLYPH_GAMMA_LIGHT_FOREGROUND},dot(v.fg,vec3f(0.2126,0.7152,0.0722)));
 return vec4f(v.fg,pow(cov,gamma)*v.alpha);
}`,
  });
  const pipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vertex',
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
      entryPoint: 'fragment',
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
  });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: rowCounts } },
      { binding: 2, resource: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }) },
      { binding: 3, resource: texture.createView() },
    ],
  });
  const data = Array.from({ length: rows }, (_, row) => {
    const values = new Float32Array(cols * 14);
    for (let col = 0; col < cols; col += 1)
      values.set([col * 8, row * 16, 1, 1, 6, 14, 0, 0, 1, 1, 0.85, 0.75, 0.65, 1], col * 14);
    return values;
  });
  const counts = new Uint32Array(rows).fill(workload === 'skewed-cardinality' ? 1 : cols);
  counts[0] = cols;
  const flat = new Float32Array(rows * cols * 14);
  const offsets = new Uint32Array(rows);
  const changed = new Uint8Array(rows);
  const results: {
    cpuMs: number;
    completionMs: number;
    uploadBytes: number;
    cpuCopyBytes: number;
    uploadCalls: number;
    instances: number;
  }[] = [];
  const attachment: GPURenderPassColorAttachment = {
    view: texture.createView(),
    loadOp: 'clear',
    storeOp: 'store',
    clearValue: [0.04, 0.06, 0.08, 1],
  };
  const descriptor: GPURenderPassDescriptor = { colorAttachments: [attachment] };
  try {
    for (let ordinal = -5; ordinal < samples; ordinal += 1) {
      if (failure !== null) throw failure;
      changed.fill(0);
      const first = ordinal === -5;
      const cardinality = workload === 'top-cardinality' || workload === 'skewed-cardinality';
      if (first || workload === 'redraw') changed.fill(1);
      else if (cardinality) changed[0] = 1;
      else {
        changed[0] = 1;
        changed[Math.floor(rows / 2)] = 1;
        changed[rows - 1] = 1;
      }
      if (cardinality) counts[0] = cols - ((ordinal + 6) & 1);
      for (let row = 0; row < rows; row += 1)
        if (changed[row]) {
          const values = data[row];
          if (values === undefined) throw new Error('missing row');
          for (let col = 0; col < (counts[row] ?? 0); col += 1)
            values[col * 14 + 10] = (ordinal & 1) === 0 ? 0.85 : 0.65;
        }
      let uploadBytes = 0;
      let cpuCopyBytes = 0;
      let uploadCalls = 0;
      let live = 0;
      const start = performance.now();
      for (let row = 0; row < rows; row += 1) {
        offsets[row] = live;
        live += counts[row] ?? 0;
      }
      if (arm === 'flat') {
        if (first || cardinality || workload === 'redraw') {
          for (let row = 0; row < rows; row += 1) {
            const values = data[row];
            if (values === undefined) throw new Error('missing row');
            const length = (counts[row] ?? 0) * 14;
            flat.set(values.subarray(0, length), (offsets[row] ?? 0) * 14);
            cpuCopyBytes += length * 4;
          }
          device.queue.writeBuffer(geometry, 0, flat.buffer, 0, live * 56);
          uploadBytes += live * 56;
          uploadCalls += 1;
        } else {
          // Existing flattened geometry uploads the contiguous dirty envelope,
          // including untouched middle rows when distant rows change.
          let firstChanged = rows;
          let lastChanged = 0;
          for (let row = 0; row < rows; row += 1)
            if (changed[row]) {
              const values = data[row];
              if (values === undefined) throw new Error('missing row');
              flat.set(values, (offsets[row] ?? 0) * 14);
              cpuCopyBytes += values.byteLength;
              firstChanged = Math.min(firstChanged, row);
              lastChanged = row;
            }
          const offset = (offsets[firstChanged] ?? 0) * 56;
          const length = ((offsets[lastChanged] ?? 0) + (counts[lastChanged] ?? 0)) * 56 - offset;
          device.queue.writeBuffer(geometry, offset, flat.buffer, offset, length);
          uploadBytes += length;
          uploadCalls += 1;
        }
      } else {
        for (let row = 0; row < rows; row += 1)
          if (changed[row]) {
            const values = data[row];
            if (values === undefined) throw new Error('missing row');
            const length = (counts[row] ?? 0) * 56;
            device.queue.writeBuffer(geometry, row * stride * 56, values.buffer, 0, length);
            uploadBytes += length;
            uploadCalls += 1;
          }
      }
      device.queue.writeBuffer(rowCounts, 0, counts);
      uploadBytes += counts.byteLength;
      uploadCalls += 1;
      const encoder = device.createCommandEncoder();
      attachment.view = context.getCurrentTexture().createView();
      const pass = encoder.beginRenderPass(descriptor);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.setVertexBuffer(0, geometry);
      const instances = arm === 'slabs' ? rows * stride : live;
      pass.draw(6, instances);
      pass.end();
      device.queue.submit([encoder.finish()]);
      const ended = performance.now();
      await device.queue.onSubmittedWorkDone();
      if (failure !== null) throw failure;
      if (ordinal >= 0)
        results.push({
          cpuMs: ended - start,
          completionMs: performance.now() - ended,
          uploadBytes,
          cpuCopyBytes,
          uploadCalls,
          instances,
        });
    }
    // WebGPU canvas textures auto-expire at the rendering boundary. Submit the
    // final retained scene again and snapshot in the SAME task, outside timing,
    // so readback cannot sample a replaced/cleared canvas texture.
    const finalEncoder = device.createCommandEncoder();
    attachment.view = context.getCurrentTexture().createView();
    const finalPass = finalEncoder.beginRenderPass(descriptor);
    finalPass.setPipeline(pipeline);
    finalPass.setBindGroup(0, group);
    finalPass.setVertexBuffer(0, geometry);
    finalPass.draw(
      6,
      arm === 'slabs' ? rows * stride : counts.reduce((sum, count) => sum + count, 0),
    );
    finalPass.end();
    device.queue.submit([finalEncoder.finish()]);
    const readback = new OffscreenCanvas(canvas.width, canvas.height);
    const read = readback.getContext('2d');
    if (read === null) throw new Error('missing readback');
    read.drawImage(canvas, 0, 0);
    const pixels = read.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonblank = false;
    for (let index = 0; index < pixels.length; index += 4)
      if ((pixels[index] ?? 0) > 100 && pixels[index + 3] === 255) {
        nonblank = true;
        break;
      }
    if (!nonblank) throw new Error('final row-layout image is blank');
    return {
      results,
      identity,
      retainedGeometryBytes: allocatedGlyphs * 56,
      pixels: pixels.buffer,
    };
  } finally {
    stopped = true;
    geometry.destroy();
    uniform.destroy();
    rowCounts.destroy();
    texture.destroy();
    context.unconfigure();
    device.destroy();
  }
}

declare const self: DedicatedWorkerGlobalScope;
self.onmessage = (event: MessageEvent<RowLayoutRequest>) => {
  void measure(event.data).then(
    (result) => self.postMessage({ ok: true, ...result }, [result.pixels]),
    (error: unknown) => self.postMessage({ ok: false, error: String(error) }),
  );
};
