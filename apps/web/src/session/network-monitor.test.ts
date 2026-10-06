import { describe, expect, test } from 'bun:test';
import {
  type ConnectionEventTarget,
  createNetworkMonitor,
  type NetworkChangeEvent,
} from './network-monitor';

class FakeEventTarget implements ConnectionEventTarget {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    let listeners = this.listeners.get(type);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

describe('network monitor', () => {
  test('passes every connectivity edge through and none after destroy', () => {
    const windowTarget = new FakeEventTarget();
    const events: NetworkChangeEvent['kind'][] = [];
    const monitor = createNetworkMonitor((event) => events.push(event.kind), { windowTarget });

    // Nothing is deduplicated: the browser fires an edge only when its
    // connectivity flips, so there is no burst to swallow.
    windowTarget.fire('offline');
    windowTarget.fire('online');
    windowTarget.fire('online');
    expect(events).toEqual(['offline', 'online', 'online']);

    monitor.destroy();
    windowTarget.fire('offline');
    windowTarget.fire('online');
    expect(events).toEqual(['offline', 'online', 'online']);
  });
});
