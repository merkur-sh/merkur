import { describe, expect, test } from 'bun:test';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';

// `api.ts` reads `location.origin` while it is being evaluated, and the atoms
// import it for the credential rotation the loop performs. Install the global
// before the module under test is loaded, then import it dynamically.
if (typeof globalThis.location === 'undefined') {
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'http://localhost' },
    configurable: true,
    writable: true,
  });
}

const {
  deviceEventsDeliveredAtom,
  deviceEventsTokenAtom,
  deviceListStatusAtom,
  deviceUserIdAtom,
  hasDeviceSnapshotAtom,
  publishDeviceEventsError,
  startDeviceEvents,
  stopDeviceEvents,
} = await import('./device-events-atoms');

/**
 * What a reload leaves behind before it has a credential: the cache hydrated
 * the list and the account it belongs to at module load, and nothing has been
 * started yet. Written here rather than through the cache so the test does not
 * depend on `localStorage` surviving a module registry.
 */
function hydrateFromCache(registry: AtomRegistry.AtomRegistry): void {
  registry.set(hasDeviceSnapshotAtom, true);
  registry.set(deviceUserIdAtom, 'user-1');
}

describe('deviceListStatusAtom', () => {
  test('a hydrated list with no lifetime yet is refreshing, never offline', () => {
    const registry = AtomRegistry.make();
    hydrateFromCache(registry);

    // The credential arrives over the network a moment later. Reporting a
    // pause across that window announces a fault to describe a startup.
    expect(registry.get(deviceListStatusAtom)).toBe('refreshing');
  });

  test('a cold start with nothing hydrated is loading', () => {
    const registry = AtomRegistry.make();

    expect(registry.get(deviceListStatusAtom)).toBe('initial-loading');
  });

  test('a lifetime that was torn down leaves the account offline', async () => {
    const registry = AtomRegistry.make();
    hydrateFromCache(registry);
    const started = startDeviceEvents(registry, 'token-1', 'user-1').catch(() => undefined);

    stopDeviceEvents(registry);
    await started;

    expect(registry.get(deviceListStatusAtom)).toBe('offline');
  });

  test('a delivered opening frame is live', () => {
    const registry = AtomRegistry.make();
    hydrateFromCache(registry);
    registry.set(deviceEventsTokenAtom, 'token-1');
    registry.set(deviceEventsDeliveredAtom, true);

    expect(registry.get(deviceListStatusAtom)).toBe('live');
  });

  test('a published fault outranks a running stream', () => {
    const registry = AtomRegistry.make();
    hydrateFromCache(registry);
    registry.set(deviceEventsTokenAtom, 'token-1');
    registry.set(deviceEventsDeliveredAtom, true);
    publishDeviceEventsError(registry, 'Unable to start live machine updates.');

    expect(registry.get(deviceListStatusAtom)).toBe('offline');
  });
});
