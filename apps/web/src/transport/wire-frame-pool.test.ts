import { describe, expect, test } from 'bun:test';
import { copySealedBytes, createWireFramePool } from './wire-frame-pool';

/** A lent view wider than the frame, the shape the Noise session hands out. */
function lentView(bytes: readonly number[], capacity = 64): Uint8Array {
  const view = new Uint8Array(capacity).fill(0xee);
  view.set(bytes);
  return view;
}

describe('wire frame pool', () => {
  test('queued records survive WASM growth before the writer consumes them', async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    // Independent slots do not provide independent backing-store lifetimes:
    // growth detaches ALL outstanding non-shared linear-memory views.
    const slots = [new Uint8Array(memory.buffer, 0, 64), new Uint8Array(memory.buffer, 64, 64)];
    slots[0]?.fill(7);
    slots[1]?.fill(9);
    const pool = createWireFramePool();
    const first = slots[0];
    const second = slots[1];
    if (first === undefined || second === undefined) throw new Error('missing slot');
    const records = [pool.acquire(first, 64), pool.acquire(second, 64)];
    const observed: number[][] = [];
    const stream = new WritableStream<Uint8Array>({
      write(chunk) {
        observed.push(Array.from(chunk));
      },
    });
    const writer = stream.getWriter();
    const writes = records.map((record) => writer.write(record.bytes));
    // A larger receive, successor handshake, or another session can grow this
    // same module's memory while the asynchronous stream still holds chunks.
    memory.grow(1);
    expect(first.byteLength).toBe(0);
    expect(second.byteLength).toBe(0);
    await Promise.all(writes);
    expect(observed).toEqual([
      [0, 0, 0, 64, ...Array<number>(64).fill(7)],
      [0, 0, 0, 64, ...Array<number>(64).fill(9)],
    ]);
    for (const record of records) pool.release(record);
    await writer.close();
  });

  test('a frame is [u32 BE length][sealed[0..length)] copied out of the lent view', () => {
    const pool = createWireFramePool();
    const sealed = lentView([0xde, 0xad, 0xbe, 0xef, 0x11]);
    const frame = pool.acquire(sealed, 5);
    sealed.fill(0);

    expect(Array.from(frame.bytes)).toEqual([0, 0, 0, 5, 0xde, 0xad, 0xbe, 0xef, 0x11]);
    expect(frame.bytes.byteLength).toBe(9);
  });

  test('a released frame returns to the pool and the next same-sized frame reuses it', () => {
    const pool = createWireFramePool();
    const first = pool.acquire(lentView([1, 2, 3]), 3);
    const firstView = first.bytes;
    pool.release(first);
    expect(pool.availableCount()).toBe(1);

    const second = pool.acquire(lentView([4, 5, 6]), 3);
    expect(second).toBe(first);
    // Same length: the exact-length view is the cached one, not a new mint.
    expect(second.bytes).toBe(firstView);
    expect(Array.from(second.bytes)).toEqual([0, 0, 0, 3, 4, 5, 6]);
    expect(pool.availableCount()).toBe(0);

    // A different length on the same storage re-mints the view once.
    pool.release(second);
    const third = pool.acquire(lentView([7]), 1);
    expect(third).toBe(first);
    expect(third.bytes).not.toBe(firstView);
    expect(Array.from(third.bytes)).toEqual([0, 0, 0, 1, 7]);
  });

  test('storage is reused only between the requested size and twice it', () => {
    const pool = createWireFramePool();
    const big = pool.acquire(new Uint8Array(1024), 1024);
    pool.release(big);
    // A keystroke record must not squat in a paste's kilobyte.
    const small = pool.acquire(lentView([1]), 1);
    expect(small).not.toBe(big);
    pool.release(small);
    expect(pool.availableCount()).toBe(2);
    // A record of comparable size takes the big storage back.
    const comparable = pool.acquire(new Uint8Array(700), 700);
    expect(comparable).toBe(big);
    expect(comparable.bytes.byteLength).toBe(704);
  });

  test('prefers the newest compatible storage', () => {
    const pool = createWireFramePool();
    const older = pool.acquire(lentView([1]), 1);
    const newer = pool.acquire(lentView([2]), 1);
    pool.release(older);
    pool.release(newer);
    expect(pool.acquire(lentView([3]), 1)).toBe(newer);
  });

  test('ignores a double release and bounds the free list', () => {
    const pool = createWireFramePool(1);
    const a = pool.acquire(lentView([1]), 1);
    const b = pool.acquire(lentView([2]), 1);
    pool.release(a);
    pool.release(a);
    pool.release(b);
    expect(pool.availableCount()).toBe(1);
    expect(() => pool.release({ bytes: new Uint8Array(4) })).not.toThrow();
  });

  test('rejects a length outside the lent view', () => {
    const pool = createWireFramePool();
    expect(() => pool.acquire(new Uint8Array(4), 5)).toThrow(RangeError);
    expect(() => pool.acquire(new Uint8Array(4), -1)).toThrow(RangeError);
  });

  test('copySealedBytes covers the exact, short-prefix and long-prefix cases', () => {
    const destination = new Uint8Array(4096).fill(0xff);
    const exact = Uint8Array.of(1, 2, 3);
    copySealedBytes(exact, 3, destination, 1);
    expect(Array.from(destination.subarray(0, 5))).toEqual([0xff, 1, 2, 3, 0xff]);

    const shortPrefix = lentView([9, 8, 7, 6]);
    copySealedBytes(shortPrefix, 2, destination, 10);
    expect(Array.from(destination.subarray(9, 13))).toEqual([0xff, 9, 8, 0xff]);

    const longPrefix = new Uint8Array(2048);
    for (let index = 0; index < longPrefix.length; index += 1) longPrefix[index] = index & 0xff;
    copySealedBytes(longPrefix, 1000, destination, 100);
    expect(Array.from(destination.subarray(100, 1100))).toEqual(
      Array.from(longPrefix.subarray(0, 1000)),
    );
    expect(destination[1100]).toBe(0xff);
  });
});
