import { expect, test } from 'bun:test';
import { type AtlasRegion, GraphicsAtlas } from './atlas';

test('thousands of tiny guttered tiles occupy one layer and coalesce exactly after retirement', () => {
  const atlas = new GraphicsAtlas(258, 1);
  const regions: AtlasRegion[] = [];
  const occupied = new Uint8Array(258 * 258);
  for (let i = 0; i < 4096; i++) {
    const region = atlas.allocate(3, 3);
    if (region === null) throw new Error('unexpected atlas exhaustion');
    expect(region.layer).toBe(0);
    for (let y = region.y; y < region.y + 3; y++) {
      for (let x = region.x; x < region.x + 3; x++) {
        expect(occupied[y * 258 + x]).toBe(0);
        occupied[y * 258 + x] = 1;
      }
    }
    regions.push(region);
  }
  expect(atlas.allocate(258, 258)).toBeNull();
  // Retire in a different order from allocation to exercise both sibling sides.
  for (let i = 0; i < regions.length; i += 2) regions[i]?.release();
  for (let i = 1; i < regions.length; i += 2) regions[i]?.release();
  const whole = atlas.allocate(258, 258);
  expect(whole).toMatchObject({ x: 0, y: 0, layer: 0 });
  expect(atlas.allocate(1, 1)).toBeNull();
  whole?.release();
  expect(() => whole?.release()).toThrow('released twice');
});

test('full layers retain exact admission until released', () => {
  const atlas = new GraphicsAtlas(258, 2);
  const first = atlas.allocate(258, 258);
  const second = atlas.allocate(258, 258);
  expect(first?.layer).toBe(0);
  expect(second?.layer).toBe(1);
  expect(atlas.allocate(3, 3)).toBeNull();
  first?.release();
  expect(atlas.allocate(129, 258)).toMatchObject({ x: 0, y: 0, layer: 0 });
  expect(atlas.allocate(129, 258)).toMatchObject({ x: 129, y: 0, layer: 0 });
  expect(atlas.allocate(1, 1)).toBeNull();
});
