// Measurement facts decoded by Rust Session; no wire parser or authority here.
import type {
  PerfEgressMessage,
  PerfGridConvergenceResponseMessage,
  PerfTimingMessage,
} from '@merkur/protocol';
import type { TransportToTerminalPeer } from '../terminal/worker-peer-control';
import {
  emitDaemonTiming,
  emitDaemonTimingStatus,
  emitEdgeForwardResidence,
  emitEgressModel,
  emitTransportEgress,
} from './perf-event-codec';
import type { PerfRingWriter } from './perf-ring';

export type ClientSessionObservation =
  | PerfTimingMessage
  | PerfEgressMessage
  | (Omit<PerfGridConvergenceResponseMessage, 'rowHashes'> & {
      readonly rowHashes: readonly number[];
    });

export function recordClientSessionObservation(
  writer: PerfRingWriter,
  message: ClientSessionObservation,
  atMs: number,
  observationEpoch: number,
  peer: MessagePort,
): void {
  if (message.observationEpoch !== observationEpoch) return;
  if (message.kind === 'perf_timing') {
    emitDaemonTimingStatus(
      writer,
      atMs,
      message.batchSeq,
      message.inputAttributedTotal,
      message.inputDroppedTotal,
      message.inputSkippedTotal,
      message.pendingInputs,
      message.displayAttributedTotal,
      message.displayDroppedTotal,
      message.observationEpoch,
      message.records.length,
    );
    for (const record of message.records) {
      emitDaemonTiming(
        writer,
        atMs,
        record.inputSeq,
        record.recvToPtyUs,
        record.ptyToReadUs,
        record.gridApplyUs,
        record.displayCoalesceUs,
        record.selectCaptureUs,
        record.prepareQueueUs,
        record.encodeUs,
        record.compressionUs,
        record.completionQueueUs,
        record.transportSubmitUs,
        record.writeCompletionUs,
        record.ackTransmitUs,
        record.ownerCpuUs,
        record.ownerOffCpuUs,
        record.ownerQuinnWaitUs,
        record.ownerRegistryWaitUs,
        record.flushLockWaitUs,
        message.batchSeq,
        message.observationEpoch,
      );
    }

    return;
  }
  if (message.kind === 'perf_egress') {
    emitTransportEgress(
      writer,
      atMs,
      message.observationEpoch,
      'daemon',
      message.daemonGroup,
      message.daemonInteractive,
      message.daemonBulk,
    );
    emitTransportEgress(
      writer,
      atMs,
      message.observationEpoch,
      'edge',
      message.edgeAttachment,
      message.edgeInteractive,
      message.edgeBulk,
    );
    emitEdgeForwardResidence(
      writer,
      atMs,
      message.observationEpoch,
      message.edgeAttachment,
      message.edgeForwardResidence,
    );
    emitEgressModel(writer, atMs, message.observationEpoch, 'daemon', message.daemonModel);
    emitEgressModel(writer, atMs, message.observationEpoch, 'edge', message.edgeModel);

    return;
  }
  const rowHashes = Uint32Array.from(message.rowHashes);
  peer.postMessage(
    {
      kind: 'perf_grid_convergence_response',
      observationEpoch: message.observationEpoch,
      probeId: message.probeId,
      generation: message.generation,
      lastAdmittedDisplaySeq: message.lastAdmittedDisplaySeq,
      cols: message.cols,
      rows: message.rows,
      rowHashes: rowHashes.buffer,
    } satisfies TransportToTerminalPeer,
    [rowHashes.buffer],
  );
}
