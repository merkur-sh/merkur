/**
 * Exact accounting for Merkur-owned browser display I/O.
 *
 * These counters describe operations the source code actually executes:
 * byte-copy calls, byte-backed allocation requests, and object/view allocation
 * sites. They intentionally do not estimate allocator metadata, engine object
 * sizes, WebTransport receive storage, crypto/WASM allocator reuse, structured
 * clone internals, or GPU-driver allocations. Those quantities are not exposed
 * by browser APIs and must remain explicitly unmeasured rather than fabricated.
 */

import type { TransportKind } from '@merkur/shared';

export const BROWSER_DISPLAY_IO_SCOPE =
  'instrumented_merkur_js_transport_ring_terminal_boundary_and_fec_operations; excludes_snapshot_persistence_collection_growth_term_wasm_internal_decode_apply_geometry_renderer_browser_engine_webtransport_crypto_allocator_and_gpu_bytes';

/** Exact carrier and lane that owned an inbound display plaintext callback. */
export type BrowserDisplayIngressRoute =
  | 'direct-datagram'
  | 'direct-reliable'
  | 'relay-datagram'
  | 'relay-reliable';

/**
 * Translate the two callback-owned scalars into the closed telemetry label.
 * This is called only while profiling and allocates no per-frame object.
 */
export function browserDisplayIngressRoute(
  via: TransportKind,
  allowLarge: boolean,
): BrowserDisplayIngressRoute {
  switch (via) {
    case 'webtransport':
      return allowLarge ? 'direct-reliable' : 'direct-datagram';
    case 'edgeWebTransport':
      return allowLarge ? 'relay-reliable' : 'relay-datagram';
  }
}

export interface MutableBrowserDisplayIoAccounting {
  explicitCopyCount: number;
  explicitCopiedBytes: number;
  explicitAllocationRequestCount: number;
  explicitAllocationRequestedBytes: number;
  explicitObjectAllocationRequestCount: number;
}

export function resetBrowserDisplayIoAccounting(target: MutableBrowserDisplayIoAccounting): void {
  target.explicitCopyCount = 0;
  target.explicitCopiedBytes = 0;
  target.explicitAllocationRequestCount = 0;
  target.explicitAllocationRequestedBytes = 0;
  target.explicitObjectAllocationRequestCount = 0;
}

export function noteBrowserDisplayCopy(
  target: MutableBrowserDisplayIoAccounting,
  byteLength: number,
): void {
  target.explicitCopyCount += 1;
  target.explicitCopiedBytes += byteLength;
}

export function noteBrowserDisplayAllocationRequest(
  target: MutableBrowserDisplayIoAccounting,
  requestedBytes: number,
): void {
  target.explicitAllocationRequestCount += 1;
  target.explicitAllocationRequestedBytes += requestedBytes;
}

export function noteBrowserDisplayObjectAllocationRequest(
  target: MutableBrowserDisplayIoAccounting,
  count = 1,
): void {
  target.explicitObjectAllocationRequestCount += count;
}

export function browserDisplayCopiedBytesPerPayloadByte(
  copiedBytes: number,
  payloadBytes: number,
): number | null {
  if (!Number.isFinite(copiedBytes) || copiedBytes < 0) return null;
  if (!Number.isFinite(payloadBytes) || payloadBytes <= 0) return null;
  return copiedBytes / payloadBytes;
}
