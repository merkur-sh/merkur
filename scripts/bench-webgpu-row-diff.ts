import { chromium } from '@playwright/test';

// TypeScript's DOM library does not yet declare WebGPU. Keep the benchmark's
// narrow surface local instead of adding a runtime dependency solely for
// ambient experimental types.
interface BenchmarkGpuBuffer {
  destroy(): void;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
}

interface BenchmarkGpuComputePass {
  setPipeline(pipeline: BenchmarkGpuPipeline): void;
  setBindGroup(index: number, bindGroup: BenchmarkGpuBindGroup): void;
  dispatchWorkgroups(count: number): void;
  end(): void;
}

interface BenchmarkGpuCommandEncoder {
  beginComputePass(): BenchmarkGpuComputePass;
  copyBufferToBuffer(
    source: BenchmarkGpuBuffer,
    sourceOffset: number,
    destination: BenchmarkGpuBuffer,
    destinationOffset: number,
    size: number,
  ): void;
  finish(): object;
}

interface BenchmarkGpuPipeline {
  getBindGroupLayout(index: number): object;
}

type BenchmarkGpuBindGroup = object;

interface BenchmarkGpuDevice {
  readonly queue: {
    writeBuffer(buffer: BenchmarkGpuBuffer, offset: number, data: ArrayBuffer | Uint32Array): void;
    submit(commands: readonly object[]): void;
  };
  createShaderModule(descriptor: object): object;
  createComputePipeline(descriptor: object): BenchmarkGpuPipeline;
  createBuffer(descriptor: object): BenchmarkGpuBuffer;
  createBindGroup(descriptor: object): BenchmarkGpuBindGroup;
  createCommandEncoder(): BenchmarkGpuCommandEncoder;
}

interface BenchmarkGpu {
  requestAdapter(options: object): Promise<{
    requestDevice(): Promise<BenchmarkGpuDevice>;
  } | null>;
}

const ROW_COUNTS = [24, 40, 60, 256] as const;
const GPU_SAMPLES = 40;
const GPU_WARMUPS = 20;
const GPU_ITERATIONS = 50;
const CPU_SAMPLES = 80;
const CPU_ITERATIONS = 20_000;
const STATE_WORDS_PER_ROW = 10;
const WORKGROUP_SIZE = 64;

interface Summary {
  readonly p50: number;
  readonly p95: number;
  readonly min: number;
}

interface ScenarioResult {
  readonly cpuNs: Summary;
  readonly gpuResidentUs: Summary;
  readonly gpuUploadUs: Summary;
  readonly checksum: number;
}

interface BenchmarkResult {
  readonly renderer: string;
  readonly userAgent: string;
  readonly scenarios: Record<string, ScenarioResult>;
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch() {
    return new Response('<!doctype html><canvas id="gpu-probe"></canvas>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
});

const browser = await chromium.launch({ headless: true, args: ['--enable-gpu'] });
let result: BenchmarkResult;
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load' });
  result = await page.evaluate(
    async ({
      rowCounts,
      gpuSamples,
      gpuWarmups,
      gpuIterations,
      cpuSamples,
      cpuIterations,
      wordsPerRow,
      workgroupSize,
    }) => {
      const gpu = (navigator as Navigator & { gpu?: BenchmarkGpu }).gpu;
      if (gpu === undefined) throw new Error('WebGPU is unavailable');
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter === null) throw new Error('WebGPU returned no adapter');
      const device = await adapter.requestDevice();
      const webGpuGlobals = globalThis as typeof globalThis & {
        GPUBufferUsage: {
          readonly STORAGE: number;
          readonly COPY_DST: number;
          readonly COPY_SRC: number;
          readonly MAP_READ: number;
          readonly UNIFORM: number;
        };
        GPUMapMode: { readonly READ: number };
      };
      const gpuBufferUsage = webGpuGlobals.GPUBufferUsage;
      const gpuMapMode = webGpuGlobals.GPUMapMode;

      const canvas = document.querySelector<HTMLCanvasElement>('#gpu-probe');
      const gl = canvas?.getContext('webgl2');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer =
        gl !== null && gl !== undefined && debug !== null && debug !== undefined
          ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
          : 'unknown';

      const shader = device.createShaderModule({
        code: `
          struct RowState {
            current_lo: u32,
            current_hi: u32,
            acked_lo: u32,
            acked_hi: u32,
            sent_lo: u32,
            sent_hi: u32,
            latest_seq: u32,
            flags: u32,
            resend_after_ms: f32,
            padding: u32,
          }

          struct Params {
            last_display_seq_sent: u32,
            now_ms: f32,
            row_count: u32,
            padding: u32,
          }

          @group(0) @binding(0) var<storage, read> rows: array<RowState>;
          @group(0) @binding(1) var<storage, read_write> selected: array<u32>;
          @group(0) @binding(2) var<uniform> params: Params;

          @compute @workgroup_size(${workgroupSize})
          fn main(@builtin(global_invocation_id) id: vec3<u32>) {
            let row = id.x;
            if (row >= params.row_count) { return; }
            let state = rows[row];
            let current_eq_acked = state.current_lo == state.acked_lo && state.current_hi == state.acked_hi;
            let sent_eq_acked = state.sent_lo == state.acked_lo && state.sent_hi == state.acked_hi;
            let sent_eq_current = state.sent_lo == state.current_lo && state.sent_hi == state.current_hi;
            let current_confirmed = (state.flags & 1u) != 0u;
            let acked_exact = (state.flags & 2u) != 0u;
            let has_reliable_attempt = (state.flags & 4u) != 0u;

            var is_selected = false;
            if (!(current_confirmed && acked_exact && current_eq_acked && sent_eq_acked)) {
              if (!sent_eq_current || state.latest_seq == 0u) {
                is_selected = true;
              } else if (!has_reliable_attempt) {
                let later_sequences = params.last_display_seq_sent - state.latest_seq;
                is_selected = later_sequences < 3u && params.now_ms >= state.resend_after_ms;
              }
            }
            selected[row] = select(0u, 1u, is_selected);
          }
        `,
      });
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: shader, entryPoint: 'main' },
      });

      function summarize(values: readonly number[]): Summary {
        const sorted = [...values].sort((a, b) => a - b);
        const at = (quantile: number): number =>
          sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? Number.NaN;
        return { p50: at(0.5), p95: at(0.95), min: sorted[0] ?? Number.NaN };
      }

      function makeState(rowCount: number): Uint32Array {
        const words = new Uint32Array(rowCount * wordsPerRow);
        const floats = new Float32Array(words.buffer);
        for (let row = 0; row < rowCount; row += 1) {
          const base = row * wordsPerRow;
          const hash = (row * 2_654_435_761) >>> 0;
          words[base] = hash;
          words[base + 1] = (hash ^ 0x9e3779b9) >>> 0;
          words[base + 2] = row % 7 === 0 ? (hash ^ 1) >>> 0 : hash;
          words[base + 3] = (hash ^ 0x9e3779b9) >>> 0;
          words[base + 4] = row % 11 === 0 ? (hash ^ 2) >>> 0 : hash;
          words[base + 5] = (hash ^ 0x9e3779b9) >>> 0;
          words[base + 6] = 100 - (row % 4);
          words[base + 7] = row % 13 === 0 ? 2 : 3;
          floats[base + 8] = row % 5 === 0 ? 900 : 1_100;
        }
        return words;
      }

      function cpuClassify(state: Uint32Array, rowCount: number, output: Uint32Array): number {
        const floats = new Float32Array(state.buffer, state.byteOffset, state.length);
        let selectedCount = 0;
        for (let row = 0; row < rowCount; row += 1) {
          const base = row * wordsPerRow;
          const currentEqAcked =
            state[base] === state[base + 2] && state[base + 1] === state[base + 3];
          const sentEqAcked =
            state[base + 4] === state[base + 2] && state[base + 5] === state[base + 3];
          const sentEqCurrent =
            state[base + 4] === state[base] && state[base + 5] === state[base + 1];
          const flags = state[base + 7] ?? 0;
          const currentConfirmed = (flags & 1) !== 0;
          const ackedExact = (flags & 2) !== 0;
          const hasReliableAttempt = (flags & 4) !== 0;
          const latestSeq = state[base + 6] ?? 0;
          let selected = false;
          if (!(currentConfirmed && ackedExact && currentEqAcked && sentEqAcked)) {
            if (!sentEqCurrent || latestSeq === 0) selected = true;
            else if (!hasReliableAttempt) {
              selected = (100 - latestSeq) >>> 0 < 3 && 1_000 >= (floats[base + 8] ?? 0);
            }
          }
          output[row] = selected ? 1 : 0;
          selectedCount += output[row] ?? 0;
        }
        return selectedCount;
      }

      const scenarios: Record<string, ScenarioResult> = {};
      let checksum = 0;
      for (const rowCount of rowCounts) {
        const state = makeState(rowCount);
        const expected = new Uint32Array(rowCount);
        const expectedCount = cpuClassify(state, rowCount, expected);

        const stateBuffer = device.createBuffer({
          size: state.byteLength,
          usage: gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_DST,
        });
        const outputBytes = rowCount * Uint32Array.BYTES_PER_ELEMENT;
        const outputBuffer = device.createBuffer({
          size: outputBytes,
          usage: gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_SRC,
        });
        const readback = device.createBuffer({
          size: outputBytes,
          usage: gpuBufferUsage.COPY_DST | gpuBufferUsage.MAP_READ,
        });
        const params = new ArrayBuffer(16);
        const paramsU32 = new Uint32Array(params);
        const paramsF32 = new Float32Array(params);
        paramsU32[0] = 100;
        paramsF32[1] = 1_000;
        paramsU32[2] = rowCount;
        const paramsBuffer = device.createBuffer({
          size: params.byteLength,
          usage: gpuBufferUsage.UNIFORM | gpuBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(stateBuffer, 0, state);
        device.queue.writeBuffer(paramsBuffer, 0, params);
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: stateBuffer } },
            { binding: 1, resource: { buffer: outputBuffer } },
            { binding: 2, resource: { buffer: paramsBuffer } },
          ],
        });

        async function gpuClassifyBatch(upload: boolean, iterations: number): Promise<number> {
          const started = performance.now();
          for (let iteration = 0; iteration < iterations; iteration += 1) {
            if (upload) device.queue.writeBuffer(stateBuffer, 0, state);
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(Math.ceil(rowCount / workgroupSize));
            pass.end();
            encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, outputBytes);
            device.queue.submit([encoder.finish()]);
            await readback.mapAsync(gpuMapMode.READ);
            const actual = new Uint32Array(readback.getMappedRange());
            let actualCount = 0;
            for (let row = 0; row < rowCount; row += 1) {
              const value = actual[row] ?? 0;
              if (value !== expected[row]) throw new Error(`GPU mismatch at row ${row}`);
              actualCount += value;
            }
            readback.unmap();
            if (actualCount !== expectedCount) throw new Error('GPU selected-count mismatch');
            checksum = (checksum + actualCount) >>> 0;
          }
          return ((performance.now() - started) * 1_000) / iterations;
        }

        const cpuDurations: number[] = [];
        const cpuOutput = new Uint32Array(rowCount);
        for (let sample = 0; sample < cpuSamples; sample += 1) {
          const started = performance.now();
          let batchCount = 0;
          for (let iteration = 0; iteration < cpuIterations; iteration += 1) {
            batchCount += cpuClassify(state, rowCount, cpuOutput);
          }
          cpuDurations.push(((performance.now() - started) * 1_000_000) / cpuIterations);
          checksum = (checksum + batchCount) >>> 0;
        }

        for (let warmup = 0; warmup < gpuWarmups; warmup += 1) {
          await gpuClassifyBatch(false, 1);
          await gpuClassifyBatch(true, 1);
        }
        const residentDurations: number[] = [];
        const uploadDurations: number[] = [];
        for (let sample = 0; sample < gpuSamples; sample += 1) {
          residentDurations.push(await gpuClassifyBatch(false, gpuIterations));
          uploadDurations.push(await gpuClassifyBatch(true, gpuIterations));
        }

        scenarios[String(rowCount)] = {
          cpuNs: summarize(cpuDurations),
          gpuResidentUs: summarize(residentDurations),
          gpuUploadUs: summarize(uploadDurations),
          checksum,
        };
        stateBuffer.destroy();
        outputBuffer.destroy();
        readback.destroy();
        paramsBuffer.destroy();
      }
      device.destroy();
      return { renderer, userAgent: navigator.userAgent, scenarios };
    },
    {
      rowCounts: ROW_COUNTS,
      gpuSamples: GPU_SAMPLES,
      gpuWarmups: GPU_WARMUPS,
      gpuIterations: GPU_ITERATIONS,
      cpuSamples: CPU_SAMPLES,
      cpuIterations: CPU_ITERATIONS,
      wordsPerRow: STATE_WORDS_PER_ROW,
      workgroupSize: WORKGROUP_SIZE,
    },
  );
} finally {
  await browser.close();
  server.stop(true);
}

process.stdout.write(`${result.renderer}\n${result.userAgent}\n`);
for (const rowCount of ROW_COUNTS) {
  const scenario = result.scenarios[String(rowCount)];
  if (scenario === undefined) throw new Error(`missing ${rowCount}-row result`);
  process.stdout.write(
    `${rowCount} rows: CPU p50=${scenario.cpuNs.p50.toFixed(1)}ns p95=${scenario.cpuNs.p95.toFixed(1)}ns; ` +
      `GPU resident p50=${scenario.gpuResidentUs.p50.toFixed(1)}us p95=${scenario.gpuResidentUs.p95.toFixed(1)}us; ` +
      `GPU upload p50=${scenario.gpuUploadUs.p50.toFixed(1)}us p95=${scenario.gpuUploadUs.p95.toFixed(1)}us\n`,
  );
}
process.stdout.write(`webgpu row diff raw: ${JSON.stringify(result)}\n`);
