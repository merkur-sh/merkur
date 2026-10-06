import { describe, expect, test } from 'bun:test';
import {
  createGeometryRenderState,
  GEOMETRY_STATE_LENGTH,
  updateGeometryRenderState,
} from './geometry-render-state';

describe('packed geometry render state', () => {
  test('maps every slot and reuses every render argument object', () => {
    const target = createGeometryRenderState();
    const identities = {
      bg: target.bg,
      glyph: target.glyph,
      deco: target.deco,
      cursor: target.cursor,
      viewport: target.viewport,
      versions: target.versions,
    };
    const packed = Uint32Array.from({ length: GEOMETRY_STATE_LENGTH }, (_, index) => 100 + index);

    updateGeometryRenderState(target, packed, 1920, 1080);

    expect(target.bg).toEqual({ ptr: 100, count: 101 });
    expect(target.glyph).toEqual({ ptr: 105, count: 106 });
    expect(target.deco).toEqual({ ptr: 110, count: 111 });
    expect(target.cursor).toEqual({ ptr: 115, count: 116 });
    expect(target.viewport).toEqual([1920, 1080]);
    expect(target.versions).toEqual({
      bg: 102,
      glyph: 107,
      deco: 112,
      cursor: 117,
      bgDirtyOffset: 103,
      bgDirtyCount: 104,
      glyphDirtyOffset: 108,
      glyphDirtyCount: 109,
      decoDirtyOffset: 113,
      decoDirtyCount: 114,
      cursorDirtyOffset: 118,
      cursorDirtyCount: 119,
    });

    packed.fill(7);
    updateGeometryRenderState(target, packed, 800, 600);
    expect(target.bg).toBe(identities.bg);
    expect(target.glyph).toBe(identities.glyph);
    expect(target.deco).toBe(identities.deco);
    expect(target.cursor).toBe(identities.cursor);
    expect(target.viewport).toBe(identities.viewport);
    expect(target.versions).toBe(identities.versions);
    expect(target.viewport).toEqual([800, 600]);
  });
});
