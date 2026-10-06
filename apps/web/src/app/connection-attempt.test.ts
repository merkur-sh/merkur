import { describe, expect, test } from 'bun:test';

import { createConnectionAttemptOwner } from './connection-attempt';

describe('connection attempt ownership', () => {
  test('ignores a double click for the same device before async work settles', () => {
    const owner = createConnectionAttemptOwner(() => 10);
    const first = owner.begin('device-a');

    expect(first).not.toBeNull();
    expect(owner.begin('device-a')).toBeNull();
    expect(first?.isCurrent()).toBe(true);
  });

  test('retains the physical click timestamp across synchronous teardown work', () => {
    const owner = createConnectionAttemptOwner(() => 125);
    const attempt = owner.begin('device-a', 100);

    expect(attempt?.startedAtMs).toBe(100);
    expect(owner.hasActive()).toBe(true);
    owner.invalidate();
    expect(owner.hasActive()).toBe(false);
  });

  test('selecting device B synchronously invalidates device A', () => {
    const owner = createConnectionAttemptOwner();
    const first = owner.begin('device-a');
    const second = owner.begin('device-b');

    expect(first?.signal.aborted).toBe(true);
    expect(first?.isCurrent()).toBe(false);
    expect(second?.isCurrent()).toBe(true);
  });

  test('logout, back, or teardown invalidates an in-flight continuation', () => {
    const owner = createConnectionAttemptOwner();
    const attempt = owner.begin('device-a');

    owner.invalidate(new Error('teardown'));

    expect(attempt?.signal.aborted).toBe(true);
    expect(attempt?.isCurrent()).toBe(false);
  });

  test('a late resolve cannot claim ownership after a successor starts', async () => {
    const owner = createConnectionAttemptOwner();
    const first = owner.begin('device-a');
    let resolveFirst!: () => void;
    const firstWork = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const published: string[] = [];
    const continuation = firstWork.then(() => {
      if (first?.isCurrent()) published.push('device-a');
    });

    const second = owner.begin('device-b');
    resolveFirst();
    await continuation;

    expect(published).toEqual([]);
    expect(second?.isCurrent()).toBe(true);
  });

  test('a late reject cannot complete or clear a successor', async () => {
    const owner = createConnectionAttemptOwner();
    const first = owner.begin('device-a');
    if (first === null) throw new Error('first attempt was not created');
    let rejectFirst!: (error: Error) => void;
    const firstWork = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const continuation = firstWork.catch(() => owner.complete(first));

    const second = owner.begin('device-b');
    if (second === null) throw new Error('second attempt was not created');
    rejectFirst(new Error('late failure'));

    expect(await continuation).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(owner.complete(second)).toBe(true);
  });
});
