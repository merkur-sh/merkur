import type { TransportHintParams } from '../transport-worker-protocol';

export type TransportHintEmitter = (
  hint: TransportHintParams,
  receiveQueueDatagrams: number,
  presentationPeriodUs: number,
) => void;

/**
 * Owns transport-hint delivery deduplication after worker-local fields have
 * been sampled. Main deliberately forwards equal network observations: only
 * this realm can see receive depth and terminal presentation cadence, so
 * deduplication any earlier can suppress a materially changed wire hint.
 *
 * State is scalar and capacity-stable. A calibration edge that does not change
 * the quantized period performs comparisons only; an emitted hint allocates no
 * intermediate key string or snapshot object.
 */
export interface TransportHintPublisher {
  noteNetworkHint(
    hint: TransportHintParams,
    receiveQueueDatagrams: number,
    presentationPeriodUs: number,
  ): boolean;
  notePresentationPeriod(receiveQueueDatagrams: number, presentationPeriodUs: number): boolean;
  resetDelivery(): void;
}

export function createTransportHintPublisher(emit: TransportHintEmitter): TransportHintPublisher {
  let latest: TransportHintParams | null = null;
  let delivered = false;
  let lastProfile = 0;
  let lastChunkBytes = 0;
  let lastSnapshotBytes = 0;
  let lastReceiveQueueDatagrams = 0;
  let lastPresentationPeriodUs = 0;

  function emitIfChanged(receiveQueueDatagrams: number, presentationPeriodUs: number): boolean {
    const hint = latest;
    if (hint === null) return false;
    if (
      delivered &&
      lastProfile === hint.profile &&
      lastChunkBytes === hint.chunkBytes &&
      lastSnapshotBytes === hint.snapshotBytes &&
      lastReceiveQueueDatagrams === receiveQueueDatagrams &&
      lastPresentationPeriodUs === presentationPeriodUs
    ) {
      return false;
    }

    delivered = true;
    lastProfile = hint.profile;
    lastChunkBytes = hint.chunkBytes;
    lastSnapshotBytes = hint.snapshotBytes;
    lastReceiveQueueDatagrams = receiveQueueDatagrams;
    lastPresentationPeriodUs = presentationPeriodUs;
    emit(hint, receiveQueueDatagrams, presentationPeriodUs);
    return true;
  }

  return {
    noteNetworkHint(hint, receiveQueueDatagrams, presentationPeriodUs): boolean {
      latest = hint;
      return emitIfChanged(receiveQueueDatagrams, presentationPeriodUs);
    },

    notePresentationPeriod(receiveQueueDatagrams, presentationPeriodUs): boolean {
      return emitIfChanged(receiveQueueDatagrams, presentationPeriodUs);
    },

    resetDelivery(): void {
      delivered = false;
    },
  };
}
