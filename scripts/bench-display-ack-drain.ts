/** Rust viewer ACK aggregation, the viewer-output ring and authenticated Session sealing. */

import { fullGC, heapStats } from 'bun:jsc';
import { createViewerOutputPublisher } from '../apps/web/src/terminal/viewer-output-publisher';
import {
  createViewerOutputRingReader,
  createViewerOutputRingWriter,
  VIEWER_OUTPUT_RING_SIZE,
} from '../apps/web/src/terminal/viewer-output-ring';
import { DISPLAY_SEQUENCE_OFFSET, writeU32BE } from '../packages/shared/src';
import { createClientSessionFixture } from './perf/client-session-fixture';
import { createViewerDriver } from './perf/client-viewer-driver';
import { emitPerfMetric, summarizeSamples } from './perf/harness';
import { ingressFixture } from './term-wasm-ingress-fixture';

function liveCells(): number {
  return Object.values(heapStats().objectTypeCounts).reduce((sum, value) => sum + value, 0);
}

export async function createDisplayAckBenchmarkDriver(batchSize: number) {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0)
    throw new Error('batchSize must be a positive safe integer');
  const peer = await createClientSessionFixture();
  const driver = createViewerDriver();
  const frame = ingressFixture(120, 40, 1, 1, false);
  // The workers' own path: the terminal side publishes to the ring, and the
  // transport side copies each entry into the session's reserved ingress.
  const ring = new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE);
  const publisher = createViewerOutputPublisher(createViewerOutputRingWriter(ring), () =>
    peer.now(),
  );
  const outputs = createViewerOutputRingReader(ring);
  const frameFenceToken = 1;
  let heap = new Uint8Array(peer.memory.buffer);
  let sequence = 0;

  function applyFrame(): void {
    writeU32BE(frame, DISPLAY_SEQUENCE_OFFSET, ++sequence);
    driver.receive(frame, 3, peer.now());
  }

  /** Carry what the viewer owes to the session, as the two workers do. The ACKs taken. */
  function crossOutputs(): number {
    publisher.drain(driver.viewer, driver.memory, peer.lineage(), frameFenceToken);
    let acks = 0;
    for (let length = outputs.nextLength(); length >= 0; length = outputs.nextLength()) {
      if (outputs.lineage() !== peer.lineage() || outputs.frameFenceToken() !== frameFenceToken)
        throw new Error('viewer output lost the stamp it was published under');
      const pointer = peer.session.reserve_ingress(length);
      if (pointer === 0) throw new Error('viewer output exceeds Session ingress');
      if (heap.buffer !== peer.memory.buffer) heap = new Uint8Array(peer.memory.buffer);
      outputs.copyPayload(heap, pointer);
      const kind = outputs.kind();
      if (!peer.session.ingest_viewer_output(peer.now(), peer.lineage(), kind, length))
        throw new Error('authenticated lineage rejected viewer output');
      if (kind === 1) acks++;
      outputs.consume();
    }
    if (outputs.takeRefusal()) throw new Error('viewer output ring refused an ACK batch');
    return acks;
  }

  /** Live `bun:jsc` cells left by `count` presented frames, each followed by `output`. */
  function cellsAcross(count: number, output: () => void): number {
    fullGC();
    const cells = liveCells();
    for (let index = 0; index < count; index++) {
      applyFrame();
      driver.viewer.present_now(peer.now());
      output();
    }
    return liveCells() - cells;
  }

  return {
    async runBatch() {
      const started = performance.now();
      for (let index = 0; index < batchSize; index++) applyFrame();
      driver.viewer.present_now(peer.now());
      const emitted = crossOutputs();
      const outgoing = [];
      for (;;) {
        const action = peer.pollIo();
        if (action === null) break;
        outgoing.push(action);
      }
      const elapsedMs = performance.now() - started;
      for (const action of outgoing) await peer.transmit(action);
      if (driver.viewer.applied_sequence() !== sequence || emitted === 0)
        throw new Error('ACK batch did not advance authority');
      return {
        elapsedMs,
        drained: batchSize,
        emitted,
        lastSequence: sequence,
        encryptedRecords: outgoing.length,
      };
    },
    /**
     * JavaScript objects one ACK mints between the viewer's poll and the
     * session's ingress, both workers' share counted in this one heap: `count`
     * presented frames whose outputs cross the ring, net of the same frames
     * with their outputs polled and left unread.
     */
    measureOutputObjects(count: number): { acks: number; objectsPerAck: number } {
      if (!Number.isSafeInteger(count) || count <= 0)
        throw new Error('count must be a positive safe integer');
      let acks = 0;
      const unread = cellsAcross(count, () => {
        while (driver.viewer.poll_output(peer.now()) !== 0) {
          // Left unread.
        }
      });
      const crossed = cellsAcross(count, () => {
        acks += crossOutputs();
      });
      // What the session sealed in answer is not this path's to transmit.
      while (peer.session.poll_action(true) !== 0) {
        // Discarded.
      }
      if (acks === 0) throw new Error('no ACK crossed the ring');
      return { acks, objectsPerAck: (crossed - unread) / acks };
    },
    async close() {
      driver.close();
      await peer.close();
    },
  };
}
if (import.meta.main) {
  const samples = Number(process.env.BENCH_SAMPLES ?? 1000),
    batch = Number(process.env.BENCH_BATCH_SIZE ?? 64);
  if (!Number.isSafeInteger(samples) || samples <= 0) throw new Error('invalid BENCH_SAMPLES');
  const driver = await createDisplayAckBenchmarkDriver(batch);
  const times: number[] = [];
  try {
    for (let sample = 0; sample < samples + 100; sample++) {
      const value = await driver.runBatch();
      if (sample >= 100) times.push(value.elapsedMs);
    }
    const stats = summarizeSamples(times);
    const objects = driver.measureOutputObjects(samples);
    process.stdout.write(
      `${JSON.stringify({ benchmark: 'display-ack-drain', samples, batch, scope: 'Rust viewer ACK projection, the viewer-output ring and authenticated Rust session sealing; excludes daemon roundtrip', objectsPerAck: objects.objectsPerAck, ...stats })}\n`,
    );
    emitPerfMetric({
      name: 'display-ack-drain-batch-latency',
      value: stats.median,
      unit: 'ms/batch',
      direction: 'lower',
      sampleSize: samples,
    });
    emitPerfMetric({
      name: 'display-ack-drain-objects',
      value: objects.objectsPerAck,
      unit: 'objects/ack',
      direction: 'lower',
      sampleSize: objects.acks,
    });
  } finally {
    await driver.close();
  }
}
