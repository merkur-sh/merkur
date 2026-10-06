import { describe, expect, test } from 'bun:test';
import type { Device } from '@merkur/shared';

import { reconcileDeviceSnapshot } from './device-snapshot-reconciliation';

const alpha: Device = {
  id: 'alpha',
  userId: 'user-1',
  name: 'Alpha',
  platform: 'linux',
  lastSeen: 1,
  status: 'online',
  version: '1.0.0',
  identitySealBackend: 'software',
};

const beta: Device = {
  ...alpha,
  id: 'beta',
  name: 'Beta',
};

describe('reconcileDeviceSnapshot', () => {
  test('reuses the array and rows when a live snapshot is unchanged', () => {
    const current = [alpha, beta];
    const next = current.map((device) => ({ ...device }));

    const reconciled = reconcileDeviceSnapshot(current, next);

    expect(reconciled).toBe(current);
    expect(reconciled[0]).toBe(alpha);
    expect(reconciled[1]).toBe(beta);
  });

  test('only replaces changed rows and follows the incoming order', () => {
    const changedBeta = { ...beta, status: 'offline' as const, lastSeen: 2 };
    const current = [alpha, beta];

    const reconciled = reconcileDeviceSnapshot(current, [changedBeta, { ...alpha }]);

    expect(reconciled).not.toBe(current);
    expect(reconciled[0]).toBe(changedBeta);
    expect(reconciled[1]).toBe(alpha);
  });

  test('replaces the row identity when a device degrades or recovers', () => {
    // `<For>` re-keys on object identity, so a degraded transition that reused
    // the row would leave the amber dot and subtitle un-rendered.
    const degradedAlpha = { ...alpha, status: 'degraded' as const };
    const reconciled = reconcileDeviceSnapshot([alpha, beta], [degradedAlpha, { ...beta }]);

    expect(reconciled[0]).toBe(degradedAlpha);
    expect(reconciled[1]).toBe(beta);

    const recovered = reconcileDeviceSnapshot(reconciled, [{ ...alpha }, { ...beta }]);
    expect(recovered[0]).not.toBe(degradedAlpha);
    expect(recovered[0]?.status).toBe('online');
  });

  test('drops removed rows and retains unchanged survivors', () => {
    const reconciled = reconcileDeviceSnapshot([alpha, beta], [{ ...beta }]);

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toBe(beta);
  });
});
