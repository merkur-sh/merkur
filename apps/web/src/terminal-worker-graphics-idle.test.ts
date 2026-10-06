import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  createGeometryRenderState,
  GEOMETRY_STATE_GRAPHICS_REVISION,
  GEOMETRY_STATE_LENGTH,
  updateGeometryRenderState,
} from './terminal/geometry-render-state';

const source = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');
const start = source.indexOf('function renderFrame(');
const end = source.indexOf('\n}', start);
if (start < 0 || end < start) throw new Error('missing production renderFrame');
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  `${source.slice(start, end + 2)}\nglobalThis.renderFrame = renderFrame;`,
);

test('render submission reads committed geometry without rebuilding graphics or issuing demands', () => {
  let graphicsReads = 0,
    sceneUpdates = 0,
    renders = 0;
  const packed = new Uint32Array(GEOMETRY_STATE_LENGTH);
  const context = {
    wasmTerminal: {
      memory: { buffer: new ArrayBuffer(0) },
      geometryState: () => packed,
      cellMetrics: () => {
        graphicsReads++;
        return [8, 16];
      },
      graphicsFragments: () => {
        graphicsReads++;
        return new Uint8Array(0);
      },
    },
    renderer: {
      setGraphicsScene: () => {
        sceneUpdates++;
        return true;
      },
      render: () => ++renders,
    },
    geometryRenderState: createGeometryRenderState(),
    updateGeometryRenderState,
    committedPhysW: 800,
    committedPhysH: 600,
    provisionalPreview: { geometry: null },
    renderFrame: (): number => 0,
  };
  runInNewContext(program, context);
  for (let index = 0; index < 100; index++) context.renderFrame();
  packed[GEOMETRY_STATE_GRAPHICS_REVISION] = 2;
  for (let index = 0; index < 100; index++) context.renderFrame();
  expect(graphicsReads).toBe(0);
  expect(sceneUpdates).toBe(0);
  expect(renders).toBe(200);
});
