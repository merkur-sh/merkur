import { describe, expect, test } from 'bun:test';
import { CURSOR_INFO_LENGTH, createCursorInfoReader } from './wasm-render-readers';

describe('Wasm render readers', () => {
  test('reuses cursor view and rebinds after memory growth or pointer movement', () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    let ptr = 128;
    let ptrCalls = 0;
    let lenCalls = 0;
    const read = createCursorInfoReader(memory, {
      cursor_info_ptr: () => {
        ptrCalls += 1;
        return ptr;
      },
      cursor_info_len: () => {
        lenCalls += 1;
        return CURSOR_INFO_LENGTH;
      },
    });
    new Uint16Array(memory.buffer, ptr, CURSOR_INFO_LENGTH).fill(7);

    const first = read();
    expect(read()).toBe(first);
    expect(Array.from(first)).toEqual(Array(CURSOR_INFO_LENGTH).fill(7));
    expect({ ptrCalls, lenCalls }).toEqual({ ptrCalls: 2, lenCalls: 1 });

    memory.grow(1);
    const grown = read();
    expect(grown).not.toBe(first);
    expect(Array.from(grown)).toEqual(Array(CURSOR_INFO_LENGTH).fill(7));

    ptr = 256;
    new Uint16Array(memory.buffer, ptr, CURSOR_INFO_LENGTH).fill(9);
    const moved = read();
    expect(moved).not.toBe(grown);
    expect(Array.from(moved)).toEqual(Array(CURSOR_INFO_LENGTH).fill(9));
    expect({ ptrCalls, lenCalls }).toEqual({ ptrCalls: 4, lenCalls: 1 });
  });

  test('rejects a cursor ABI mismatch before the hot path', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    expect(() =>
      createCursorInfoReader(memory, {
        cursor_info_ptr: () => 0,
        cursor_info_len: () => CURSOR_INFO_LENGTH - 1,
      }),
    ).toThrow('invalid terminal cursor info length');
  });
});
