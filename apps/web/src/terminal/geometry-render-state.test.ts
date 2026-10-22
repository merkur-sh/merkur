import { describe, expect, test } from 'bun:test';
import {
  createGeometryRenderState,
  GEOMETRY_STATE_LENGTH,
  GEOMETRY_STATE_PARAMS_OFFSET,
  updateGeometryRenderState,
} from './geometry-render-state';

describe('packed geometry render state', () => {
  test('maps every slot and reuses every render argument object', () => {
    const target = createGeometryRenderState();
    const identities = {
      cells: target.cells,
      overlay: target.overlay,
      cursor: target.cursor,
      glyphs: target.glyphs,
      params: target.params,
      viewport: target.viewport,
    };
    const packed = Uint32Array.from({ length: GEOMETRY_STATE_LENGTH }, (_, index) => 100 + index);
    const params = new Float32Array([9, 18, 14, 0.25, 0.5, 0.75]);
    packed.set(new Uint32Array(params.buffer), GEOMETRY_STATE_PARAMS_OFFSET);

    updateGeometryRenderState(target, packed, 1920, 1080);

    expect(target.cells).toEqual({
      ptr: 100,
      count: 101,
      version: 102,
      dirtyOffset: 103,
      dirtyCount: 104,
    });
    expect(target.overlay).toEqual({
      ptr: 105,
      count: 106,
      version: 107,
      dirtyOffset: 108,
      dirtyCount: 109,
    });
    expect(target.cursor).toEqual({
      ptr: 110,
      count: 111,
      version: 112,
      dirtyOffset: 113,
      dirtyCount: 114,
    });
    expect(target.glyphs).toEqual({ ptr: 115, count: 116, epoch: 117 });
    expect(Array.from(target.params)).toEqual(Array.from(params));
    expect(target.viewport).toEqual([1920, 1080]);

    packed.fill(7);
    updateGeometryRenderState(target, packed, 800, 600);
    expect(target.cells).toBe(identities.cells);
    expect(target.overlay).toBe(identities.overlay);
    expect(target.cursor).toBe(identities.cursor);
    expect(target.glyphs).toBe(identities.glyphs);
    expect(target.params).toBe(identities.params);
    expect(target.viewport).toBe(identities.viewport);
    expect(target.viewport).toEqual([800, 600]);
  });
});
