import { expect, test } from 'bun:test';
import { createClientViewerSceneReader } from './client-viewer-scene';

function packedScene(): Uint8Array {
  const values: number[] = [];
  const word = (value: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    values.push(...bytes);
  };
  const number = (value: number) => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    values.push(...bytes);
  };
  const string = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    word(bytes.length);
    values.push(...bytes);
  };
  word(1);
  word(1);
  word(1);
  values.push(2, 0, 0, 0);
  for (const value of [1, 2, 3, 4, 0.1, 0.2, 0.3, 0.4]) number(value);
  string('binding');
  values.push(0, 1, 0, 0);
  for (const value of [5, 6, 7, 258, 130]) word(value);
  values.push(...new Uint8Array(32).fill(11), ...new Uint8Array(32).fill(22));
  string('tile');
  string('animation');
  word(1);
  values.push(1, 0, 0, 0);
  string('binding');
  string('tile');
  return Uint8Array.from(values);
}

test('packed scenes own all retained values across ingress reuse and WASM growth', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = packedScene();
  new Uint8Array(memory.buffer, 32, bytes.length).set(bytes);
  const read = createClientViewerSceneReader(memory);
  const first = read(32, bytes.length, 1);
  expect(first.quads[0]).toMatchObject({ key: 'binding', layer: 2, left: 1, top: 2 });
  expect(first.tiles[0]).toMatchObject({ key: 'tile', level: 1, frame: 5, width: 258 });
  expect(first.animations?.[0]?.bindings.get('binding')).toBe('tile');
  new Uint8Array(memory.buffer, 32, bytes.length).fill(0);
  memory.grow(1);
  new Uint8Array(memory.buffer, 32, bytes.length).set(bytes);
  const next = read(32, bytes.length, 1);
  expect(next.quads).toBe(first.quads);
  expect(next.tiles).not.toBe(first.tiles);
  expect(first.tiles[0]?.authority).toEqual(new Uint8Array(32).fill(11));
  expect(first.tiles[0]?.source).toEqual(new Uint8Array(32).fill(22));
  expect(read(32, bytes.length, 2).quads).not.toBe(first.quads);
});
