import { describe, expect, test } from 'bun:test';

import {
  browserDisplayCopiedBytesPerPayloadByte,
  browserDisplayIngressRoute,
  type MutableBrowserDisplayIoAccounting,
  noteBrowserDisplayAllocationRequest,
  noteBrowserDisplayCopy,
  noteBrowserDisplayObjectAllocationRequest,
  resetBrowserDisplayIoAccounting,
} from './browser-display-io';

function counters(): MutableBrowserDisplayIoAccounting {
  return {
    explicitCopyCount: 0,
    explicitCopiedBytes: 0,
    explicitAllocationRequestCount: 0,
    explicitAllocationRequestedBytes: 0,
    explicitObjectAllocationRequestCount: 0,
  };
}

describe('browser display I/O accounting', () => {
  test('derives the exact ingress route from callback-owned provider and lane scalars', () => {
    expect(browserDisplayIngressRoute('webtransport', false)).toBe('direct-datagram');
    expect(browserDisplayIngressRoute('webtransport', true)).toBe('direct-reliable');
    expect(browserDisplayIngressRoute('edgeWebTransport', false)).toBe('relay-datagram');
    expect(browserDisplayIngressRoute('edgeWebTransport', true)).toBe('relay-reliable');
  });

  test('counts only explicit executed operations and resets in place', () => {
    const state = counters();
    noteBrowserDisplayCopy(state, 1_200);
    noteBrowserDisplayCopy(state, 800);
    noteBrowserDisplayAllocationRequest(state, 1_200);
    noteBrowserDisplayObjectAllocationRequest(state, 2);
    expect(state).toEqual({
      explicitCopyCount: 2,
      explicitCopiedBytes: 2_000,
      explicitAllocationRequestCount: 1,
      explicitAllocationRequestedBytes: 1_200,
      explicitObjectAllocationRequestCount: 2,
    });
    resetBrowserDisplayIoAccounting(state);
    expect(state).toEqual(counters());
  });

  test('copy amplification is an exact payload ratio and invalid input is unavailable', () => {
    expect(browserDisplayCopiedBytesPerPayloadByte(3_000, 1_000)).toBe(3);
    expect(browserDisplayCopiedBytesPerPayloadByte(0, 1_000)).toBe(0);
    expect(browserDisplayCopiedBytesPerPayloadByte(10, 0)).toBeNull();
    expect(browserDisplayCopiedBytesPerPayloadByte(Number.NaN, 10)).toBeNull();
  });
});
