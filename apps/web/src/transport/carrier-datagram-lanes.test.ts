import { expect, test } from 'bun:test';
import { createCarrierDatagramLanes } from './carrier-datagram-lanes';

interface Write {
  readonly payload: Uint8Array;
  readonly bytes: number[];
  resolve(): void;
  reject(): void;
}

function carrier() {
  const writes: Write[] = [];
  return {
    writes,
    datagram(payload: Uint8Array): Promise<void> {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      writes.push({ payload, bytes: [...payload], resolve, reject: () => reject(new Error('x')) });
      return promise;
    },
  };
}

function lanes() {
  const settled: Array<[bigint, boolean, number, number, number]> = [];
  const owner = createCarrierDatagramLanes<ReturnType<typeof carrier>>(
    (conn, _carrier, sent, inputTop, channel, byteLength) => {
      settled.push([conn, sent, inputTop, channel, byteLength]);
    },
  );
  return { owner, settled };
}

test('a carrier takes one write at a time, in offer order', async () => {
  const { owner, settled } = lanes();
  const direct = carrier();
  owner.offer(1n, direct, Uint8Array.of(7, 1), 4);
  owner.offer(1n, direct, Uint8Array.of(8, 2, 3), 0);
  expect(direct.writes.map((write) => write.bytes)).toEqual([[7, 1]]);

  direct.writes[0]?.resolve();
  await Promise.resolve();
  expect(settled).toEqual([[1n, true, 4, 7, 2]]);
  expect(direct.writes.map((write) => write.bytes)).toEqual([
    [7, 1],
    [8, 2, 3],
  ]);
  // A settled datagram is erased; the one being written is not.
  expect([...(direct.writes[0]?.payload ?? [])]).toEqual([0, 0]);
  expect([...(direct.writes[1]?.payload ?? [])]).toEqual([8, 2, 3]);
});

test('a write a dead carrier never settles holds only that carrier', async () => {
  const { owner, settled } = lanes();
  const dead = carrier();
  const live = carrier();
  owner.offer(1n, dead, Uint8Array.of(7), 1);
  owner.offer(1n, dead, Uint8Array.of(7), 2);
  owner.offer(2n, live, Uint8Array.of(9), 3);
  expect(dead.writes).toHaveLength(1);
  expect(live.writes).toHaveLength(1);

  live.writes[0]?.resolve();
  await Promise.resolve();
  expect(settled).toEqual([[2n, true, 3, 9, 1]]);
});

test('a refused write is reported and the lane goes on', async () => {
  const { owner, settled } = lanes();
  const direct = carrier();
  owner.offer(1n, direct, Uint8Array.of(7), 5);
  owner.offer(1n, direct, Uint8Array.of(8), 6);
  direct.writes[0]?.reject();
  await Promise.resolve();
  expect(settled).toEqual([[1n, false, 5, 7, 1]]);
  expect(direct.writes).toHaveLength(2);
});

test('a retired lane drops its queue and settles nothing', async () => {
  const { owner, settled } = lanes();
  const direct = carrier();
  const queued = Uint8Array.of(8, 8);
  owner.offer(1n, direct, Uint8Array.of(7), 1);
  owner.offer(1n, direct, queued, 2);
  owner.retire(1n);
  expect([...queued]).toEqual([0, 0]);

  direct.writes[0]?.resolve();
  await Promise.resolve();
  expect(settled).toEqual([]);
  expect(direct.writes).toHaveLength(1);
  expect([...(direct.writes[0]?.payload ?? [])]).toEqual([0]);

  // The same id offered again is a new lane.
  owner.offer(1n, direct, Uint8Array.of(9), 3);
  expect(direct.writes).toHaveLength(2);
});

test('a lane retired by its own refusal sends nothing more', async () => {
  const direct = carrier();
  const owner = createCarrierDatagramLanes<ReturnType<typeof carrier>>((conn, _carrier, sent) => {
    if (!sent) owner.retire(conn);
  });
  owner.offer(1n, direct, Uint8Array.of(7), 0);
  owner.offer(1n, direct, Uint8Array.of(8), 0);
  direct.writes[0]?.reject();
  await Promise.resolve();
  expect(direct.writes).toHaveLength(1);
});

test('clear retires every lane', async () => {
  const { owner, settled } = lanes();
  const first = carrier();
  const second = carrier();
  owner.offer(1n, first, Uint8Array.of(7), 0);
  owner.offer(2n, second, Uint8Array.of(7), 0);
  owner.clear();
  first.writes[0]?.resolve();
  second.writes[0]?.resolve();
  await Promise.resolve();
  expect(settled).toEqual([]);
});
