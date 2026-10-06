import { expect, test } from 'bun:test';
import {
  createTerminalFixture,
  FIXTURE_BG_FLOATS,
  FIXTURE_GLYPHS,
  fixtureGeometryUploadBytes,
  TerminalSubmissionWindow,
  terminalFixtureExpectedPixels,
  updateTerminalFixture,
  WebGpuFixtureRenderer,
} from './webgpu-terminal-renderer';

test('fixture matches the full-sized immutable experiment and reuses storage', () => {
  const fixture = createTerminalFixture();
  const storage = fixture.storage;
  const buffer = storage.buffer;
  expect(storage.length).toBe(30 * 7 + 3000 * 14);
  expect(fixture.atlas.length).toBe(64);
  const untouched = storage.slice(7, FIXTURE_BG_FLOATS);
  const untouchedGlyphs = storage.slice(FIXTURE_BG_FLOATS + 14);
  updateTerminalFixture(fixture, 'typing', 51);
  expect(fixture.storage).toBe(storage);
  expect(fixture.storage.buffer).toBe(buffer);
  expect(storage.slice(7, FIXTURE_BG_FLOATS)).toEqual(untouched);
  expect(storage.slice(FIXTURE_BG_FLOATS + 14)).toEqual(untouchedGlyphs);
  expect(fixture.versions.bgDirtyCount).toBe(1);
  expect(fixture.versions.glyphDirtyCount).toBe(1);
  updateTerminalFixture(fixture, 'redraw', 52);
  expect(fixture.versions.bgDirtyCount).toBe(30);
  expect(fixture.versions.glyphDirtyCount).toBe(FIXTURE_GLYPHS);
  expect(fixtureGeometryUploadBytes(true, 'typing')).toBe(168_840);
  expect(fixtureGeometryUploadBytes(false, 'typing')).toBe(84);
  expect(fixtureGeometryUploadBytes(false, 'redraw')).toBe(168_840);
});

test('shutdown during either asynchronous pipeline creation creates no later resources', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    for (const stopAtPipeline of [1, 2]) {
      const reachedPipeline = Promise.withResolvers<void>();
      const pipeline = Promise.withResolvers<object>();
      const lost = Promise.withResolvers<{ message: string }>();
      let pipelineCalls = 0;
      let bindGroupCalls = 0;
      let viewCalls = 0;
      let completedCalls = 0;
      let resourceDestroys = 0;
      let deviceDestroys = 0;
      let unconfigures = 0;
      const resource = () => ({
        destroy: () => {
          resourceDestroys += 1;
        },
      });
      const device = {
        lost: lost.promise,
        addEventListener: () => {},
        queue: {
          writeBuffer: () => {},
          writeTexture: () => {},
          onSubmittedWorkDone: () => {
            completedCalls += 1;
            return Promise.resolve();
          },
        },
        createBuffer: resource,
        createTexture: () => ({
          ...resource(),
          createView: () => {
            viewCalls += 1;
            return {};
          },
        }),
        createSampler: () => ({}),
        createShaderModule: () => ({}),
        createBindGroupLayout: () => ({}),
        createPipelineLayout: () => ({}),
        createRenderPipelineAsync: () => {
          pipelineCalls += 1;
          if (pipelineCalls !== stopAtPipeline) return Promise.resolve({});
          reachedPipeline.resolve();
          return pipeline.promise;
        },
        createBindGroup: () => {
          bindGroupCalls += 1;
          return {};
        },
        destroy: () => {
          deviceDestroys += 1;
        },
      };
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
          gpu: {
            requestAdapter: async () => ({
              info: { vendor: 'test', architecture: '', device: '', description: '' },
              requestDevice: async () => device,
            }),
            getPreferredCanvasFormat: () => 'bgra8unorm',
          },
        },
      });
      const renderer = new WebGpuFixtureRenderer();
      const initialized = renderer.init(
        {
          getContext: () => ({
            configure: () => {},
            unconfigure: () => {
              unconfigures += 1;
            },
            getCurrentTexture: () => ({}),
            getConfiguration: () => ({}),
          }),
        },
        createTerminalFixture(),
        () => {},
      );
      await reachedPipeline.promise;
      renderer.destroy();
      renderer.destroy();
      pipeline.resolve({});
      await expect(initialized).rejects.toThrow('initialization was stopped');
      expect(pipelineCalls).toBe(stopAtPipeline);
      expect(bindGroupCalls).toBe(0);
      expect(viewCalls).toBe(0);
      expect(completedCalls).toBe(0);
      expect(resourceDestroys).toBe(4);
      expect(deviceDestroys).toBe(1);
      expect(unconfigures).toBe(1);
    }
  } finally {
    if (previousNavigator === undefined) Reflect.deleteProperty(globalThis, 'navigator');
    else Object.defineProperty(globalThis, 'navigator', previousNavigator);
  }
});

test('skipping intermediate absolute offers does not change final geometry or oracle', () => {
  for (const workload of ['typing', 'redraw'] as const) {
    const every = createTerminalFixture();
    const latest = createTerminalFixture();
    for (let ordinal = 1; ordinal <= 217; ordinal += 1)
      updateTerminalFixture(every, workload, ordinal);
    updateTerminalFixture(latest, workload, 217);
    expect(latest.storage).toEqual(every.storage);
    expect(terminalFixtureExpectedPixels(latest)).toEqual(terminalFixtureExpectedPixels(every));
  }
});

test('pixel oracle covers all row bands and opaque, transparent and gamma-blended glyphs', () => {
  const fixture = createTerminalFixture();
  updateTerminalFixture(fixture, 'typing', 70);
  const pixels = terminalFixtureExpectedPixels(fixture);
  expect(pixels).toHaveLength(120);
  expect(pixels[0]).toEqual({ x: 2, y: 16, rgba: [100, 30, 60, 255] });
  expect(pixels[1]).toEqual({ x: 7, y: 16, rgba: [170, 100, 217, 255] });
  expect(pixels[2]?.rgba).toEqual(pixels[0]?.rgba);
  expect(pixels[3]?.rgba).not.toEqual(pixels[0]?.rgba);
  expect(pixels[3]?.rgba).not.toEqual(pixels[1]?.rgba);
  expect(pixels[4]).toEqual({ x: 2, y: 48, rgba: [30, 37, 60, 255] });
  expect(pixels[5]).toEqual({ x: 7, y: 48, rgba: [204, 204, 217, 255] });
});

test('two exact completions bound outstanding work and retain only the newest pending offer', () => {
  const window = new TerminalSubmissionWindow();
  window.offer(1);
  expect(window.take()).toBe(1);
  window.offer(2);
  expect(window.take()).toBe(2);
  for (let ordinal = 3; ordinal <= 10_000; ordinal += 1) window.offer(ordinal);
  expect(window.pendingOrdinal()).toBe(10_000);
  expect(window.canSubmit()).toBe(false);
  expect(() => window.take()).toThrow();
  // Exact ownership, not cumulative or FIFO completion assumptions.
  window.complete(2);
  expect(window.take()).toBe(10_000);
  window.complete(1);
  window.complete(10_000);
  expect(window.maxOutstanding).toBe(2);
  expect(window.outstanding()).toBe(0);
  expect(window.pendingOrdinal()).toBe(0);
  expect(window.completedCount).toBe(window.submittedCount);
  expect(window.offeredCount).toBe(window.submittedCount + window.coalescedCount);
  expect(() => window.complete(10_000)).toThrow();
  expect(() => window.complete(0)).toThrow();
  expect(() => window.offer(10_002)).toThrow();
  expect(() => window.offer(1)).toThrow();
});
