import { type Browser, chromium } from '@playwright/test';
import { declaredBrowserExecutable } from './browser-runtime';
import { emitPerfMetric, summarizeSamples } from './harness';

export function rendererBenchmarkCount(name: string, fallback: number, minimum = 1): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > 1000)
    throw new Error(`${name} must be an integer in ${minimum}..1000`);
  return value;
}

/** Actual production renderer component gate, not transport or paint latency.
 * Timed draws wait for their own completion outside the submit-CPU interval.
 * This intentionally measures isolated API cost, not open-loop interaction.
 */
export async function runWebGpuRendererBenchmark(mode: 'init' | 'render'): Promise<void> {
  const softwareGpu = process.env.BENCH_GPU === 'swiftshader';
  if (process.env.BENCH_GPU !== undefined && !softwareGpu)
    throw new Error('BENCH_GPU must be swiftshader or unset for hardware');
  const samples = rendererBenchmarkCount('BENCH_SAMPLES', 20);
  const warmups = rendererBenchmarkCount('BENCH_WARMUPS', 5, 0);
  const repetitions = rendererBenchmarkCount(
    mode === 'init' ? 'BENCH_INITS_PER_SAMPLE' : 'BENCH_FRAMES_PER_SAMPLE',
    mode === 'init' ? 1 : 10,
  );
  const build = await Bun.build({
    entrypoints: ['apps/web/src/renderer-webgpu.ts'],
    target: 'browser',
    format: 'esm',
  });
  if (!build.success || build.outputs.length !== 1) throw new Error(String(build.logs));
  const source = await build.outputs[0]?.text();
  if (source === undefined) throw new Error('missing production WebGPU bundle');
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === '/renderer.js'
        ? new Response(source, { headers: { 'content-type': 'text/javascript' } })
        : new Response(
            '<!doctype html><body><script type="module">import {WebGpuRenderer} from "/renderer.js";globalThis.__Renderer=WebGpuRenderer;</script>',
            { headers: { 'content-type': 'text/html' } },
          );
    },
  });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      channel: 'chromium',
      executablePath: declaredBrowserExecutable('chromium'),
      headless: process.env.BENCH_HEADED !== '1',
      args: softwareGpu
        ? [
            '--enable-gpu',
            '--enable-unsafe-webgpu',
            '--enable-unsafe-swiftshader',
            ...(process.platform === 'linux'
              ? [
                  '--enable-features=Vulkan',
                  '--use-angle=vulkan',
                  '--use-vulkan=swiftshader',
                  '--disable-vulkan-surface',
                ]
              : []),
            '--use-webgpu-adapter=swiftshader',
          ]
        : ['--enable-gpu'],
    });
    const page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error')
        process.stderr.write(`[browser-${message.type()}] ${message.text()}\n`);
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => '__Renderer' in globalThis);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      page
        .evaluate(
          async ({ mode, samples, warmups, repetitions, softwareGpu }) => {
            type Constructor = typeof import('../../apps/web/src/renderer-webgpu').WebGpuRenderer;
            const Renderer = (globalThis as typeof globalThis & { __Renderer?: Constructor })
              .__Renderer;
            if (Renderer === undefined) throw new Error('renderer not loaded');
            const adapter = await navigator.gpu?.requestAdapter();
            if (adapter === null || adapter === undefined)
              throw new Error('WebGPU adapter unavailable');
            const identity = {
              vendor: adapter.info.vendor,
              architecture: adapter.info.architecture,
              device: adapter.info.device,
              description: adapter.info.description,
            };
            const isSoftware =
              /swiftshader|llvmpipe|software/iu.test(Object.values(identity).join(' ')) ||
              ('isFallbackAdapter' in adapter && adapter.isFallbackAdapter === true);
            if (softwareGpu && !/swiftshader/iu.test(Object.values(identity).join(' ')))
              throw new Error('SwiftShader adapter required for correctness tests');
            if (!softwareGpu && isSoftware) throw new Error('hardware GPU required');
            const probe = await adapter.requestDevice();
            const devicePrototype: object = Object.getPrototypeOf(probe);
            const queuePrototype: object = Object.getPrototypeOf(probe.queue);
            probe.destroy();
            const fixture = new Float32Array(30 * 7 + 3000 * 14 + 7 + 8);
            const bg = { ptr: 0, count: 30 };
            const glyph = { ptr: 30 * 7 * 4, count: 3000 };
            const deco = { ptr: (30 * 7 + 3000 * 14) * 4, count: 1 };
            const cursor = { ptr: deco.ptr + 28, count: 1 };
            const empty = { ptr: 0, count: 0 };
            for (let row = 0; row < 30; row += 1)
              fixture.set([0, row * 32, 1600, 32, 0.04, 0.06, 0.08], row * 7);
            for (let index = 0; index < 3000; index += 1)
              fixture.set(
                [
                  (index % 100) * 16,
                  Math.floor(index / 100) * 32,
                  6,
                  2,
                  8,
                  24,
                  0,
                  0,
                  1,
                  1,
                  0.85,
                  0.75,
                  0.65,
                  1,
                ],
                30 * 7 + index * 14,
              );
            fixture.set([0, 30, 1600, 2, 0.7, 0.5, 0.2], deco.ptr / 4);
            fixture.set([48, 0, 16, 32, 0.8, 0.7, 0.6, 0], cursor.ptr / 4);
            const atlas = new Uint8Array(64);
            for (let i = 0; i < atlas.length; i += 1)
              atlas[i] = i % 8 === 1 || Math.floor(i / 8) === 1 ? 255 : 0;
            atlas[32] = 128; // Preserve an antialiased coverage texel through the real GPU path.
            const counters = {
              buffers: 0,
              bufferBytes: 0,
              pipelines: 0,
              shaders: 0,
              textures: 0,
              uploads: 0,
              uploadBytes: 0,
              submissions: 0,
            };
            const originals: { prototype: object; name: string; descriptor: PropertyDescriptor }[] =
              [];
            const countCalls = (
              prototype: object,
              name: string,
              count: (args: unknown[]) => void,
            ) => {
              const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
              const method: unknown = Reflect.get(prototype, name);
              if (descriptor === undefined || typeof method !== 'function')
                throw new Error(`missing GPU method ${name}`);
              originals.push({ prototype, name, descriptor });
              Object.defineProperty(prototype, name, {
                ...descriptor,
                value(this: object, ...args: unknown[]) {
                  count(args);
                  return Reflect.apply(method, this, args);
                },
              });
            };
            const installCounters = () => {
              countCalls(devicePrototype, 'createBuffer', ([descriptor]) => {
                counters.buffers += 1;
                if (
                  typeof descriptor === 'object' &&
                  descriptor !== null &&
                  'size' in descriptor &&
                  typeof descriptor.size === 'number'
                )
                  counters.bufferBytes += descriptor.size;
              });
              countCalls(devicePrototype, 'createRenderPipelineAsync', () => {
                counters.pipelines += 1;
              });
              countCalls(devicePrototype, 'createShaderModule', () => {
                counters.shaders += 1;
              });
              countCalls(devicePrototype, 'createTexture', () => {
                counters.textures += 1;
              });
              countCalls(queuePrototype, 'submit', () => {
                counters.submissions += 1;
              });
              countCalls(queuePrototype, 'writeBuffer', (args) => {
                const data = args[2];
                const size = args[4];
                if (typeof size !== 'number') throw new Error('unbounded GPU write');
                const elementBytes =
                  ArrayBuffer.isView(data) &&
                  'BYTES_PER_ELEMENT' in data &&
                  typeof data.BYTES_PER_ELEMENT === 'number'
                    ? data.BYTES_PER_ELEMENT
                    : 1;
                counters.uploads += 1;
                counters.uploadBytes += size * elementBytes;
              });
            };
            const restoreCounters = () => {
              for (const { prototype, name, descriptor } of originals)
                Object.defineProperty(prototype, name, descriptor);
              originals.length = 0;
            };
            const results: {
              name: string;
              durations: number[];
              completionDurations: number[];
              counts: typeof counters;
              rgbaHash: string;
            }[] = [];
            for (const scenario of mode === 'init'
              ? ['init']
              : ['glyph-cursor', 'all-pass', 'same-version']) {
              const host = document.createElement('canvas');
              host.width = 1600;
              host.height = 960;
              document.body.append(host);
              const canvas = host.transferControlToOffscreen();
              let resolveCompletion: ((id: number) => void) | undefined;
              let rejectCompletion: ((error: Error) => void) | undefined;
              let error: Error | null = null;
              const renderer = new Renderer(
                undefined,
                undefined,
                (id) => resolveCompletion?.(id),
                (e) => {
                  error = e;
                  rejectCompletion?.(e);
                },
              );
              const v = {
                bg: 0,
                glyph: 0,
                deco: 0,
                cursor: 0,
                bgDirtyOffset: 0,
                bgDirtyCount: 30,
                glyphDirtyOffset: 0,
                glyphDirtyCount: 3000,
                decoDirtyOffset: 0,
                decoDirtyCount: 1,
                cursorDirtyOffset: 0,
                cursorDirtyCount: 1,
              };
              const durations: number[] = [];
              const completionDurations: number[] = [];
              const initialize = async () => {
                const instance = new Renderer();
                try {
                  const started = performance.now();
                  await instance.init(new OffscreenCanvas(800, 600), 2048, 2048);
                  return performance.now() - started;
                } finally {
                  instance.destroy();
                }
              };
              const render = async () => {
                if (error !== null) throw error;
                if (scenario !== 'same-version') {
                  v.bg += 1;
                  v.glyph += 1;
                  v.deco += 1;
                  v.cursor += 1;
                }
                const completion = new Promise<number>((accept, reject) => {
                  resolveCompletion = accept;
                  rejectCompletion = reject;
                });
                const started = performance.now();
                const id = renderer.render(
                  fixture.buffer,
                  scenario === 'glyph-cursor' ? empty : bg,
                  glyph,
                  scenario === 'glyph-cursor' ? empty : deco,
                  cursor,
                  [1600, 960],
                  v,
                );
                const ended = performance.now();
                if (id === 0 || (await completion) !== id)
                  throw new Error('missing exact GPU completion');
                return { cpu: ended - started, completion: performance.now() - ended };
              };
              try {
                if (mode === 'render') {
                  fixture[cursor.ptr / 4 + 7] =
                    scenario === 'glyph-cursor' ? 0 : scenario === 'all-pass' ? 1 : 2;
                  await renderer.init(canvas, 8, 8, [10, 15, 20]);
                  renderer.uploadAtlas(atlas, [0, 0, 8, 8], [8, 8]);
                  await render();
                }
                for (let n = 0; n < warmups * repetitions; n += 1) {
                  if (mode === 'init') await initialize();
                  else await render();
                }
                for (let sample = 0; sample < samples; sample += 1) {
                  let cpu = 0;
                  let completion = 0;
                  for (let n = 0; n < repetitions; n += 1) {
                    if (mode === 'init') cpu += await initialize();
                    else {
                      const value = await render();
                      cpu += value.cpu;
                      completion += value.completion;
                    }
                  }
                  durations.push(cpu / repetitions);
                  completionDurations.push(completion / repetitions);
                }
                for (const key of Object.keys(counters) as (keyof typeof counters)[])
                  counters[key] = 0;
                installCounters();
                try {
                  if (mode === 'init') await initialize();
                  else await render();
                } finally {
                  restoreCounters();
                }
                let rgbaHash = '';
                if (mode === 'render') {
                  // Untimed readback only. This checks actual nonempty rendered
                  // pixels, not latency or compositor visibility of measured frames.
                  await new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                  );
                  const readback = new OffscreenCanvas(1600, 960);
                  const context = readback.getContext('2d');
                  if (context === null) throw new Error('readback context unavailable');
                  context.drawImage(host, 0, 0);
                  const pixels = context.getImageData(0, 0, 1600, 960).data;
                  let distinct = false;
                  for (let i = 4; i < pixels.length; i += 4)
                    if (
                      pixels[i] !== pixels[0] ||
                      pixels[i + 1] !== pixels[1] ||
                      pixels[i + 2] !== pixels[2]
                    ) {
                      distinct = true;
                      break;
                    }
                  if (!distinct) throw new Error('renderer pixel oracle is blank');
                  const assertPixel = (x: number, y: number, expected: readonly number[]) => {
                    const offset = (y * 1600 + x) * 4;
                    for (let channel = 0; channel < 3; channel += 1) {
                      const actual = pixels[offset + channel];
                      const wanted = expected[channel];
                      if (
                        actual === undefined ||
                        wanted === undefined ||
                        Math.abs(actual - wanted) > 1
                      )
                        throw new Error(
                          `${scenario} pixel ${x},${y} channel ${channel}: ${actual} != ${wanted}`,
                        );
                    }
                    if (pixels[offset + 3] !== 255)
                      throw new Error('terminal must compose opaquely');
                  };
                  assertPixel(1, 16, [10, 15, 20]);
                  assertPixel(7, 16, [217, 191, 166]);
                  assertPixel(6, 16, [159, 141, 122]);
                  if (scenario !== 'glyph-cursor') assertPixel(2, 30, [179, 128, 51]);
                  if (scenario === 'glyph-cursor') assertPixel(49, 16, [188, 184, 180]);
                  else if (scenario === 'all-pass') {
                    assertPixel(48, 16, [245, 240, 235]);
                    assertPixel(52, 16, [10, 15, 20]);
                  } else {
                    assertPixel(49, 30, [245, 240, 235]);
                    assertPixel(49, 16, [10, 15, 20]);
                  }
                  rgbaHash = Array.from(
                    new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)),
                    (value) => value.toString(16).padStart(2, '0'),
                  ).join('');
                }
                results.push({
                  name: scenario,
                  durations,
                  completionDurations,
                  counts: { ...counters },
                  rgbaHash,
                });
              } finally {
                restoreCounters();
                renderer.destroy();
                host.remove();
              }
            }
            return { identity, results };
          },
          { mode, samples, warmups, repetitions, softwareGpu },
        )
        .finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('WebGPU component benchmark exceeded 120 seconds')),
          120_000,
        );
      }),
    ]);
    process.stdout.write(
      `${JSON.stringify({ mode, identity: result.identity, boundary: 'Isolated submit CPU and observed queue completion, not paint; per-sample means; API bytes are not implementation copies.' })}\n`,
    );
    for (const row of result.results) {
      const summary = summarizeSamples(row.durations);
      for (const [label, value, percentile] of [
        ['p50', summary.median, 0.5],
        ['p95', summary.p95, 0.95],
        ['p99', summary.p99, 0.99],
      ] as const)
        emitPerfMetric({
          name: `webgpu-${mode}-${row.name}-cpu-${label}`,
          value,
          percentile,
          sampleSize: samples,
          unit: mode === 'init' ? 'ms/init' : 'ms/frame',
          direction: 'lower',
        });
      for (const [name, value] of Object.entries(row.counts))
        emitPerfMetric({
          name: `webgpu-${mode}-${row.name}-api-${name}`,
          value,
          sampleSize: 1,
          unit: name.endsWith('Bytes') ? 'bytes/operation' : 'calls/operation',
          direction: 'lower',
        });
      process.stdout.write(
        `${JSON.stringify({ scenario: row.name, cpu: summary, completion: summarizeSamples(row.completionDurations), counts: row.counts, rgba: row.rgbaHash })}\n`,
      );
    }
  } finally {
    await browser?.close();
    server.stop(true);
  }
}
