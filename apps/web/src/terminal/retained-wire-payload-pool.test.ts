import { describe, expect, test } from 'bun:test';

import { createRetainedWirePayloadPool } from './retained-wire-payload-pool';

describe('retained wire payload pool', () => {
  test('owns source bytes and reuses compatible storage', () => {
    const pool = createRetainedWirePayloadPool();
    const source = Uint8Array.from([1, 2, 3, 4]);
    const first = pool.acquire(source);
    expect(first.allocationRequestedBytes).toBe(4);
    expect(first.objectAllocationRequestCount).toBe(2);
    source.fill(9);
    expect(first.bytes).toEqual(Uint8Array.from([1, 2, 3, 4]));

    first.release();
    expect(pool.availableCount()).toBe(1);
    const second = pool.acquire(Uint8Array.from([5, 6]));
    expect(second).toBe(first);
    expect(second.bytes).toEqual(Uint8Array.from([5, 6]));
    expect(second.storageBytes).toBe(4);
    expect(second.allocationRequestedBytes).toBe(0);
    expect(second.objectAllocationRequestCount).toBe(1);

    second.release();
    const sameSize = pool.acquire(Uint8Array.from([7, 8]));
    expect(sameSize).toBe(first);
    expect(sameSize.objectAllocationRequestCount).toBe(0);
  });

  test('retains until the last reference and ignores duplicate release', () => {
    const pool = createRetainedWirePayloadPool();
    const payload = pool.acquire(Uint8Array.of(7));
    payload.retain();
    payload.releaseCallback();
    expect(pool.availableCount()).toBe(0);
    payload.release();
    expect(pool.availableCount()).toBe(1);
    payload.release();
    expect(pool.availableCount()).toBe(1);
  });

  test('rejects incompatible storage and bounds available entries', () => {
    const pool = createRetainedWirePayloadPool(1);
    const small = pool.acquire(new Uint8Array(4));
    const large = pool.acquire(new Uint8Array(32));
    small.release();
    large.release();
    expect(pool.availableCount()).toBe(1);

    const replacement = pool.acquire(new Uint8Array(32));
    expect(replacement).not.toBe(small);
    expect(replacement.storageBytes).toBe(32);
  });

  test('prefers the newest compatible storage and removes a middle hit in order', () => {
    const pool = createRetainedWirePayloadPool();
    const oldestCompatible = pool.acquire(new Uint8Array(64));
    const middleCompatible = pool.acquire(new Uint8Array(128));
    const newestIncompatible = pool.acquire(new Uint8Array(512));
    oldestCompatible.release();
    middleCompatible.release();
    newestIncompatible.release();

    const selected = pool.acquire(new Uint8Array(64));
    expect(selected).toBe(middleCompatible);
    expect(pool.availableCount()).toBe(2);
    const newest = pool.acquire(new Uint8Array(512));
    expect(newest).toBe(newestIncompatible);
    const oldest = pool.acquire(new Uint8Array(64));
    expect(oldest).toBe(oldestCompatible);
  });

  test('rejects invalid capacities', () => {
    expect(() => createRetainedWirePayloadPool(-1)).toThrow();
    expect(() => createRetainedWirePayloadPool(1.5)).toThrow();
  });
});
