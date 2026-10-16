import {
  DISPLAY_FEC_HEADER_BYTES,
  DISPLAY_FEC_MAX_DATA_SHARDS,
  DISPLAY_FEC_MAX_RECOVERY_SHARDS,
  DISPLAY_FEC_REPAIR_LENGTH_BYTES,
  MESSAGE_TYPE_DISPLAY_FEC_REPAIR,
  readDisplayWireIdentity,
  type SynchronousByteSource,
  type TransportKind,
} from '@merkur/shared';
import { browserDisplayIngressRoute } from './browser-display-io';
import { emitBrowserDisplayIo } from './perf-event-codec';
import type { PerfRingWriter } from './perf-ring';

/**
 * Emit one callback-owned transport-side display I/O record.
 *
 * The source is inspected synchronously and never retained. Provider and lane
 * are positional scalars captured by the same callback that owns the plaintext;
 * no mutable path state or timestamp correlation participates in attribution.
 */
export function emitTransportBrowserDisplayIo(
  writer: PerfRingWriter,
  atMs: number,
  payload: SynchronousByteSource,
  via: TransportKind,
  allowLarge: boolean,
  admitted: boolean,
  explicitCopyCount: number,
  explicitCopiedBytes: number,
  explicitAllocationRequestCount: number,
  explicitAllocationRequestedBytes: number,
  explicitObjectAllocationRequestCount: number,
): boolean {
  const ingressRoute = browserDisplayIngressRoute(via, allowLarge);
  if (
    payload.byteLength >= DISPLAY_FEC_HEADER_BYTES &&
    payload.getUint8(0) === MESSAGE_TYPE_DISPLAY_FEC_REPAIR
  ) {
    const bodyLength = payload.getUint16BE(2);
    const batchStartSeq = payload.getUint32BE(4);
    const dataShardCount = payload.getUint8(8);
    const recoveryShardCount = payload.getUint8(9);
    const shardSize = payload.getUint16BE(10);
    const generation = payload.getUint32BE(12);
    if (
      payload.getUint8(1) !== 0 ||
      payload.byteLength !== DISPLAY_FEC_HEADER_BYTES + bodyLength ||
      dataShardCount < 2 ||
      dataShardCount > DISPLAY_FEC_MAX_DATA_SHARDS ||
      recoveryShardCount === 0 ||
      recoveryShardCount > DISPLAY_FEC_MAX_RECOVERY_SHARDS ||
      shardSize === 0 ||
      bodyLength !== recoveryShardCount * (DISPLAY_FEC_REPAIR_LENGTH_BYTES + shardSize) ||
      batchStartSeq === 0 ||
      generation === 0
    ) {
      return false;
    }
    return emitBrowserDisplayIo(
      writer,
      atMs,
      'transport_fec_ingress',
      ingressRoute,
      batchStartSeq,
      generation,
      0,
      0,
      1,
      payload.byteLength,
      admitted,
      explicitCopyCount,
      explicitCopiedBytes,
      explicitAllocationRequestCount,
      explicitAllocationRequestedBytes,
      explicitObjectAllocationRequestCount,
      false,
    );
  }

  const identity = readDisplayWireIdentity(payload);
  if (identity === null) return false;
  const { generation, seq, frameId, chunkIndex, chunkCount } = identity;
  if (generation === 0 || frameId === 0 || chunkCount === 0 || chunkIndex >= chunkCount) {
    return false;
  }
  return emitBrowserDisplayIo(
    writer,
    atMs,
    'transport_ingress',
    ingressRoute,
    seq,
    generation,
    frameId,
    chunkIndex,
    chunkCount,
    payload.byteLength,
    admitted,
    explicitCopyCount,
    explicitCopiedBytes,
    explicitAllocationRequestCount,
    explicitAllocationRequestedBytes,
    explicitObjectAllocationRequestCount,
    false,
  );
}
