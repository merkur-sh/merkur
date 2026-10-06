import { describe, expect, test } from 'bun:test';
import { createProfilingViewportReadOwner } from './profiling-viewport-read';

function controlledTimeouts(): {
  readonly arm: (expire: () => void) => () => void;
  expire(index: number): void;
} {
  const deadlines: Array<{ cancelled: boolean; expire: () => void }> = [];
  return {
    arm(expire) {
      const deadline = { cancelled: false, expire };
      deadlines.push(deadline);
      return () => {
        deadline.cancelled = true;
      };
    },
    expire(index) {
      const deadline = deadlines[index];
      if (deadline === undefined) throw new Error(`missing deadline ${index}`);
      if (!deadline.cancelled) deadline.expire();
    },
  };
}

describe('profiling viewport read owner', () => {
  test('a late timed-out FIFO reply cannot settle the next request', async () => {
    const callbacks: Array<(text: string) => void> = [];
    const timeouts = controlledTimeouts();
    const owner = createProfilingViewportReadOwner(
      (complete) => {
        callbacks.push(complete);
        return true;
      },
      2_000,
      timeouts.arm,
    );

    const first = owner.read();
    timeouts.expire(0);
    await expect(first).rejects.toThrow('timed out');

    let secondSettlement = 'pending';
    const second = owner.read().then((text) => {
      secondSettlement = text;
      return text;
    });
    expect(callbacks).toHaveLength(2);
    callbacks[0]?.('stale first viewport');
    await Promise.resolve();
    expect(secondSettlement).toBe('pending');
    callbacks[1]?.('fresh second viewport');
    await expect(second).resolves.toBe('fresh second viewport');
  });

  test('coalesces concurrent reads and rejects pending and future reads on close', async () => {
    const callbacks: Array<(text: string) => void> = [];
    const timeouts = controlledTimeouts();
    const owner = createProfilingViewportReadOwner(
      (complete) => {
        callbacks.push(complete);
        return true;
      },
      2_000,
      timeouts.arm,
    );

    const first = owner.read();
    expect(owner.read()).toBe(first);
    expect(callbacks).toHaveLength(1);
    owner.close(new Error('closed'));
    await expect(first).rejects.toThrow('closed');
    await expect(owner.read()).rejects.toThrow('closed');
    callbacks[0]?.('late');
    await expect(owner.read()).rejects.toThrow('closed');
  });

  test('fails closed when the worker rejects the request', async () => {
    const owner = createProfilingViewportReadOwner(() => false, 2_000, controlledTimeouts().arm);
    await expect(owner.read()).rejects.toThrow('rejected');
  });
});
