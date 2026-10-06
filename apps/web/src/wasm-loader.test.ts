import { describe, expect, test } from 'bun:test';
import { GEOMETRY_STATE_LENGTH } from './terminal/geometry-render-state';
import { createGeometryStateReader, createPredictionEffectReader } from './wasm-loader';

test('prediction effect views reuse unchanged geometry and rebind exact membership after growth', () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  let pointer = 64;
  let length = 2;
  new Uint32Array(memory.buffer, pointer, length).set([7, 9]);
  const read = createPredictionEffectReader(
    memory,
    () => pointer,
    () => length,
  );
  const first = read();
  expect([...first]).toEqual([7, 9]);
  for (let frame = 0; frame < 1_000; frame += 1) expect(read()).toBe(first);
  first[0] = 11;
  expect(read()[0]).toBe(11);
  length = 1;
  const shortened = read();
  expect(shortened).not.toBe(first);
  expect([...shortened]).toEqual([11]);
  pointer = 128;
  new Uint32Array(memory.buffer, pointer, length).set([13]);
  const moved = read();
  expect([...moved]).toEqual([13]);
  memory.grow(1);
  const grown = read();
  expect(grown).not.toBe(moved);
  expect([...grown]).toEqual([13]);
  length = 0;
  const empty = read();
  expect(empty.length).toBe(0);
  expect(read()).toBe(empty);
});

describe('geometry state reader', () => {
  test('reuses its view and rebinds once after WebAssembly memory growth', () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    const ptr = 128;
    let ptrCalls = 0;
    let lenCalls = 0;
    const read = createGeometryStateReader(memory, {
      geometry_state_ptr: () => {
        ptrCalls += 1;
        return ptr;
      },
      geometry_state_len: () => {
        lenCalls += 1;
        return GEOMETRY_STATE_LENGTH;
      },
    });
    const expected = Uint32Array.from(
      { length: GEOMETRY_STATE_LENGTH },
      (_, index) => 1_000 + index,
    );
    new Uint32Array(memory.buffer, ptr, GEOMETRY_STATE_LENGTH).set(expected);

    const first = read();
    expect(read()).toBe(first);
    expect(Array.from(first)).toEqual(Array.from(expected));
    expect({ ptrCalls, lenCalls }).toEqual({ ptrCalls: 1, lenCalls: 1 });

    const oldBuffer = memory.buffer;
    memory.grow(1);
    expect(memory.buffer).not.toBe(oldBuffer);
    const rebound = read();
    expect(rebound).not.toBe(first);
    expect(read()).toBe(rebound);
    expect(Array.from(rebound)).toEqual(Array.from(expected));
    expect({ ptrCalls, lenCalls }).toEqual({ ptrCalls: 1, lenCalls: 1 });
  });

  test('rejects an ABI length mismatch at handle construction', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    expect(() =>
      createGeometryStateReader(memory, {
        geometry_state_ptr: () => 0,
        geometry_state_len: () => GEOMETRY_STATE_LENGTH - 1,
      }),
    ).toThrow('invalid terminal geometry state length');
  });
});
