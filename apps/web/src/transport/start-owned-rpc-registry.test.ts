import { describe, expect, test } from 'bun:test';
import { createStartOwnedRpcRegistry } from './start-owned-rpc-registry';

describe('start-owned RPC registry', () => {
  test('a late A reply cannot settle B after B synchronously takes ownership', async () => {
    const registry = createStartOwnedRpcRegistry<string>();
    let requestA = 0;
    let requestB = 0;

    registry.beginOwner(10);
    const a = registry
      .request((requestId) => {
        requestA = requestId;
      })
      .catch((error: unknown) => String(error));

    registry.beginOwner(11);
    const b = registry.request((requestId) => {
      requestB = requestId;
    });
    let bSettled = false;
    void b.finally(() => {
      bSettled = true;
    });

    expect(await a).toBe('Error: Session RPC owner was superseded');
    expect(registry.resolve(10, requestA, 'stale-a')).toBe(false);
    await Promise.resolve();
    expect(bSettled).toBe(false);
    expect(registry.resolve(11, requestB, 'current-b')).toBe(true);
    expect(await b).toBe('current-b');
  });

  test('safe wrap skips request ids that are still pending', async () => {
    const registry = createStartOwnedRpcRegistry<string>(3);
    const ids: number[] = [];
    registry.beginOwner(1);
    const first = registry.request((requestId) => ids.push(requestId));
    const second = registry.request((requestId) => ids.push(requestId));
    expect(registry.resolve(1, ids[0] ?? 0, 'first')).toBe(true);
    expect(await first).toBe('first');

    const third = registry.request((requestId) => ids.push(requestId));
    const wrapped = registry.request((requestId) => ids.push(requestId));
    expect(ids).toEqual([1, 2, 3, 1]);

    expect(registry.resolve(1, 2, 'second')).toBe(true);
    expect(registry.resolve(1, 3, 'third')).toBe(true);
    expect(registry.resolve(1, 1, 'wrapped')).toBe(true);
    expect(await Promise.all([second, third, wrapped])).toEqual(['second', 'third', 'wrapped']);
  });

  test('a stale owner cannot settle a wrapped request id borrowed by its replacement', async () => {
    const registry = createStartOwnedRpcRegistry<string>(1);
    let oldRequestId = 0;
    registry.beginOwner(41);
    const old = registry
      .request((requestId) => {
        oldRequestId = requestId;
      })
      .catch((error: unknown) => String(error));

    registry.beginOwner(42);
    let replacementRequestId = 0;
    const replacement = registry.request((requestId) => {
      replacementRequestId = requestId;
    });

    expect(await old).toBe('Error: Session RPC owner was superseded');
    expect(replacementRequestId).toBe(oldRequestId);
    expect(registry.resolve(41, oldRequestId, 'stale')).toBe(false);
    expect(registry.resolve(42, replacementRequestId, 'current')).toBe(true);
    expect(await replacement).toBe('current');
  });
});
